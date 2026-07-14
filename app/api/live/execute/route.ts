import { NextResponse } from "next/server";
import { z } from "zod";
import { getBotSettings } from "@/lib/bot-settings-store";
import {
  executeLive,
  LiveExecutionRecoveredError,
  LiveManualInterventionError,
  type ExecutionLeg,
  type RecoveryPosition
} from "@/lib/bot/executor";
import { liveCapital, scan } from "@/lib/bot/scanner";
import { appendExecutionEvent, type ExecutionEventType } from "@/lib/execution-ledger";
import { NobitexClient } from "@/lib/exchanges/nobitex";
import {
  completeLiveExecution,
  createLiveExecutionAttempt,
  createLiveExecutionTrigger,
  failLiveExecution,
  markLiveExecutionPrepared,
  updateLiveExecutionOrders
} from "@/lib/opportunity-store";
import {
  acquireExecutionLease,
  emergencyStopRiskControl,
  evaluateRiskState,
  getRiskState,
  recordRealizedPnl,
  releaseExecutionLease,
  renewExecutionLease
} from "@/lib/risk/store";
import type { ExecutionLease } from "@/lib/risk/types";
import { triangleLedgerExecutionId } from "@/lib/runtime/triangle-startup-audit";

export const dynamic = "force-dynamic";

const requestSchema = z.object({
  triggerOpportunityId: z.string().trim().min(1).max(500).optional(),
  triggerRoute: z.array(z.string().trim().min(1).max(20)).length(4).optional(),
  triggerScannedAt: z.number().int().positive().optional()
}).strict().refine(value => Boolean(value.triggerOpportunityId) === Boolean(value.triggerRoute), {
  message: "triggerOpportunityId and triggerRoute must be sent together"
});

export async function POST(request: Request) {
  if (!isDashboardRequest(request)) {
    return NextResponse.json({ error: "درخواست اجرای واقعی فقط از همین برنامه پذیرفته می‌شود." }, { status: 403 });
  }

  let executionId: number | undefined;
  let lease: ExecutionLease | undefined;
  try {
    const body = requestSchema.parse(await request.json());
    // Execution limits are authoritative on the server; the browser cannot
    // loosen safety fields per request.
    const settings = await getBotSettings();
    const acquisition = await acquireExecutionLease({
      strategy: "triangle",
      owner: `triangle:${crypto.randomUUID()}`,
      ttlMs: 300_000
    });
    if (!acquisition.acquired) {
      if (acquisition.reason === "capacity-reached") {
        return NextResponse.json({ status: "busy", blockers: acquisition.blockers });
      }
      return NextResponse.json({
        error: "اجرای واقعی آربیتراژ مثلثی توسط کنترل ریسک سرور متوقف شده است.",
        code: "RISK_BLOCKED",
        blockers: acquisition.blockers
      }, { status: 423 });
    }
    lease = acquisition.lease;

    const triggerOpportunityId = body.triggerOpportunityId;
    const triggerRoute = body.triggerRoute;
    const client = new NobitexClient();
    const capital = await liveCapital(settings, client);
    if (capital.lte(0)) throw new Error("موجودی آزاد تومان برای معامله کافی نیست.");

    if (triggerOpportunityId && triggerRoute) {
      executionId = await createLiveExecutionTrigger({
        routeKey: triggerOpportunityId,
        route: triggerRoute,
        requestedInputToman: capital.toNumber()
      });
      await appendTriangleEvent(executionId, "INTENT", "intent", {
        source: "dashboard-trigger",
        route: triggerRoute,
        requestedInputToman: capital.toString()
      });
    }

    const result = await scan(capital, settings, client);
    const triggerCandidate = triggerOpportunityId
      ? result.opportunities.find(item => item.id === triggerOpportunityId)
      : undefined;
    const triggerRouteMatches = !triggerCandidate || !triggerRoute
      || triggerCandidate.route.length === triggerRoute.length
        && triggerCandidate.route.every((asset, index) => asset === triggerRoute[index]);
    const best = triggerOpportunityId
      ? triggerCandidate?.executable && triggerRouteMatches ? triggerCandidate : undefined
      : result.opportunities
        .filter(item => item.executable)
        .sort((a, b) => b.netProfitToman.comparedTo(a.netProfitToman))[0];

    if (!best) {
      const reason = triggerCandidate?.rejectionReason
        ?? "فرصت در بازبینی نهایی Live ناپدید شد یا عمق کافی نداشت.";
      if (executionId !== undefined) {
        await failLiveExecution(executionId, `بدون ارسال سفارش: ${reason}`);
        await appendTriangleEvent(executionId, "FAILED", "no-order", {
          reason,
          noOrderSubmitted: true
        }).catch(() => undefined);
      }
      return NextResponse.json({
        status: triggerOpportunityId ? "rejected" : "no-opportunity",
        executionId,
        reason,
        capitalToman: capital.toString()
      });
    }

    executionId ??= await createLiveExecutionAttempt(best);
    const currentExecutionId = executionId;
    await appendTriangleEvent(currentExecutionId, "INTENT", "intent", {
      source: triggerOpportunityId ? "dashboard-trigger" : "server-scheduler",
      route: best.route,
      requestedInputToman: best.requestedInputToman.toString(),
      plannedInputToman: best.inputToman.toString(),
      plannedOutputToman: best.outputToman.toString(),
      plannedProfitToman: best.netProfitToman.toString(),
      plannedProfitBps: best.profitBps.toString()
    });

    const execution = await executeLive(best, settings, client, {
      onPrepared: async opportunity => {
        await markLiveExecutionPrepared(currentExecutionId, opportunity);
        await appendTriangleEvent(currentExecutionId, "PREPARED", "prepared", {
          route: opportunity.route,
          inputToman: opportunity.inputToman.toString(),
          outputToman: opportunity.outputToman.toString(),
          profitToman: opportunity.netProfitToman.toString(),
          profitBps: opportunity.profitBps.toString()
        });
      },
      onBeforeOrder: async () => {
        if (!lease || !await renewExecutionLease(lease, 300_000)) {
          throw new Error("مجوز انحصاری اجرا پیش از ارسال سفارش از دست رفت.");
        }
        const risk = evaluateRiskState(await getRiskState()).strategies.triangle;
        if (!risk.canExecute) {
          throw new Error(`کنترل ریسک چرخه را متوقف کرد: ${risk.blockers.join(",")}`);
        }
      },
      onBeforeRecoveryOrder: async () => {
        // Recovery may reduce exposure after an Emergency Stop, but it still
        // requires the same execution lease and process owner.
        if (!lease || !await renewExecutionLease(lease, 300_000)) {
          throw new Error("مجوز بازیابی از دست رفت؛ بررسی دستی دارایی لازم است.");
        }
      },
      // This hook is awaited immediately before the HTTP order request. If the
      // durable write fails, the exchange call is never made.
      onOrderIntent: event => appendTriangleEvent(
        currentExecutionId,
        "SUBMITTING",
        `submit:${event.clientOrderId}`,
        {
          stage: event.stage,
          clientOrderId: event.clientOrderId,
          symbol: event.symbol,
          side: event.side,
          amountBase: event.amountBase.toString(),
          protectedPrice: event.expectedPrice.toString()
        }
      ),
      onLeg: async (leg, completedLegs) => {
        // Exchange-facing evidence is written before the mutable dashboard row.
        await appendLegEvents(currentExecutionId, leg);
        await updateLiveExecutionOrders(currentExecutionId, completedLegs);
      },
      onRecoveryStarted: event => appendTriangleEvent(
        currentExecutionId,
        "RECOVERY_STARTED",
        `recovery-start:${recoveryFingerprint(event.inventory)}`,
        { reason: event.reason, inventory: serializePositions(event.inventory) }
      ),
      onRecoveryCompleted: recovery => appendTriangleEvent(
        currentExecutionId,
        "RECOVERY_COMPLETED",
        `recovery-complete:${recoveryFingerprint(recovery.startedInventory)}`,
        {
          reason: recovery.reason,
          recoveredToman: recovery.recoveredToman.toString(),
          residualValueToman: recovery.residualValueToman.toString(),
          economicRecoveredToman: recovery.economicRecoveredToman.toString(),
          residualInventory: serializePositions(recovery.residualInventory)
        }
      ),
      onManualInterventionRequired: async event => {
        try {
          await appendTriangleEvent(currentExecutionId, "MANUAL_REVIEW", "manual-review", {
            reason: event.reason,
            inventory: serializePositions(event.inventory)
          });
        } finally {
          await emergencyStopRiskControl(event.reason);
        }
      }
    }, { books: result.books, options: result.options });

    await completeLiveExecution(currentExecutionId, execution);
    const warnings: string[] = [];
    try {
      await appendTriangleEvent(currentExecutionId, "COMPLETED", "completed", {
        requestedInputToman: execution.requestedInputToman.toString(),
        inputToman: execution.inputToman.toString(),
        economicOutputToman: execution.outputToman.toString(),
        economicProfitToman: execution.profitToman.toString(),
        realizedOutputToman: execution.realizedOutputToman.toString(),
        realizedProfitToman: execution.realizedProfitToman.toString(),
        residualValueToman: execution.residualValueToman.toString(),
        residualInventory: serializePositions(execution.residualInventory),
        fullySettled: execution.fullySettled
      });
    } catch (auditError) {
      warnings.push(errorMessage(auditError, "ثبت لجر تکمیل معامله ناموفق بود."));
      await emergencyStopRiskControl("triangle-completion-ledger-write-failed").catch(() => undefined);
    }

    try {
      const pnlKey = `triangle:${currentExecutionId}:pnl`;
      await recordRealizedPnl(execution.profitToman.toNumber(), new Date(), { idempotencyKey: pnlKey });
      await appendTriangleEvent(currentExecutionId, "PNL_RECORDED", "pnl", {
        accountingBasis: execution.fullySettled ? "cash-settled" : "economic-with-marked-dust",
        pnlToman: execution.profitToman.toString(),
        realizedPnlToman: execution.realizedProfitToman.toString(),
        residualValueToman: execution.residualValueToman.toString(),
        riskIdempotencyKey: pnlKey
      });
      if (execution.profitToman.lt(0)) {
        await emergencyStopRiskControl("triangle-realized-loss-circuit-breaker");
      }
    } catch (accountingError) {
      warnings.push(errorMessage(accountingError, "ثبت PnL در کنترل ریسک ناموفق بود."));
      await emergencyStopRiskControl("triangle-risk-accounting-failed").catch(() => undefined);
    }

    return NextResponse.json({
      status: "executed",
      executionId: currentExecutionId,
      route: best.route,
      requestedInputToman: execution.requestedInputToman.toString(),
      inputToman: execution.inputToman.toString(),
      outputToman: execution.outputToman.toString(),
      profitToman: execution.profitToman.toString(),
      realizedOutputToman: execution.realizedOutputToman.toString(),
      realizedProfitToman: execution.realizedProfitToman.toString(),
      residualValueToman: execution.residualValueToman.toString(),
      residualInventory: serializePositions(execution.residualInventory),
      fullySettled: execution.fullySettled,
      legs: execution.legs,
      warnings
    });
  } catch (error) {
    let message = errorMessage(error, "خطا در اجرای معامله واقعی");
    let code: string | undefined;
    let recovery: {
      inputToman: string;
      outputToman: string;
      realizedOutputToman: string;
      profitToman: string;
      realizedProfitToman: string;
      residualValueToman: string;
      residualInventory: Array<{ asset: string; amount: string }>;
      fullySettled: boolean;
    } | undefined;

    if (error instanceof LiveExecutionRecoveredError) {
      const economicPnl = error.recovery.economicRecoveredToman.minus(error.recovery.actualInputToman);
      const realizedPnl = error.recovery.recoveredToman.minus(error.recovery.actualInputToman);
      code = error.code;
      recovery = {
        inputToman: error.recovery.actualInputToman.toString(),
        outputToman: error.recovery.economicRecoveredToman.toString(),
        realizedOutputToman: error.recovery.recoveredToman.toString(),
        profitToman: economicPnl.toString(),
        realizedProfitToman: realizedPnl.toString(),
        residualValueToman: error.recovery.residualValueToman.toString(),
        residualInventory: serializePositions(error.recovery.residualInventory),
        fullySettled: error.recovery.residualInventory.length === 0
      };
      message = `${error.message} سود/زیان اقتصادی بازیابی: ${economicPnl.toFixed(0)} تومان`;
      if (executionId !== undefined) {
        const pnlKey = `triangle:${executionId}:pnl`;
        await recordRealizedPnl(economicPnl.toNumber(), new Date(), { idempotencyKey: pnlKey }).catch(() => undefined);
        await appendTriangleEvent(executionId, "PNL_RECORDED", "pnl", {
          accountingBasis: recovery.fullySettled ? "cash-settled-recovery" : "economic-recovery-with-marked-dust",
          pnlToman: recovery.profitToman,
          realizedPnlToman: recovery.realizedProfitToman,
          residualValueToman: recovery.residualValueToman,
          riskIdempotencyKey: pnlKey
        }).catch(() => undefined);
      }
      await emergencyStopRiskControl("triangle-cycle-failed-after-automatic-recovery").catch(() => undefined);
    } else if (error instanceof LiveManualInterventionError) {
      code = error.code;
      await emergencyStopRiskControl(error.message).catch(() => undefined);
    }

    if (executionId !== undefined) {
      await failLiveExecution(executionId, message, recovery ? {
        actualOutputToman: Number(recovery.outputToman),
        actualProfitToman: Number(recovery.profitToman),
        realizedOutputToman: Number(recovery.realizedOutputToman),
        realizedProfitToman: Number(recovery.realizedProfitToman),
        residualValueToman: Number(recovery.residualValueToman),
        residualInventory: recovery.residualInventory,
        fullySettled: recovery.fullySettled
      } : undefined).catch(() => undefined);
      await appendTriangleEvent(executionId, "FAILED", `failed:${code ?? "generic"}`, {
        code: code ?? null,
        reason: message,
        recovery: recovery ?? null
      }).catch(() => undefined);
    }
    return NextResponse.json({ error: message, code, recovery, executionId }, { status: code ? 409 : 400 });
  } finally {
    if (lease) await releaseExecutionLease(lease).catch(() => undefined);
  }
}

async function appendTriangleEvent(
  executionId: number,
  type: ExecutionEventType,
  suffix: string,
  payload: Record<string, unknown>
) {
  return appendExecutionEvent({
    executionId: triangleLedgerExecutionId(executionId),
    engine: "triangle",
    type,
    idempotencyKey: `triangle:${executionId}:${suffix}`.slice(0, 300),
    payload
  });
}

async function appendLegEvents(executionId: number, leg: ExecutionLeg) {
  const orderKey = (leg.clientOrderId || leg.orderId || `${leg.symbol}:${leg.side}`).slice(0, 120);
  if (leg.orderId) {
    await appendTriangleEvent(executionId, "ORDER_ACKNOWLEDGED", `ack:${orderKey}`, {
      stage: leg.stage ?? "cycle",
      clientOrderId: leg.clientOrderId ?? null,
      orderId: leg.orderId,
      symbol: leg.symbol,
      side: leg.side,
      status: leg.status
    });
  }
  const hasFinalAmounts = leg.matchedAmount !== undefined && leg.unmatchedAmount !== undefined;
  const terminalWithoutFill = ["done", "closed", "canceled", "cancelled", "failed", "rejected"]
    .includes(leg.status.trim().toLowerCase());
  if (hasFinalAmounts && (Number(leg.matchedAmount) > 0 || terminalWithoutFill)) {
    const stateKey = `${leg.status}:${leg.matchedAmount}:${leg.unmatchedAmount}`.slice(0, 120);
    await appendTriangleEvent(executionId, "FILL", `fill:${orderKey}:${stateKey}`, {
      ...leg,
      stage: leg.stage ?? "cycle"
    });
  }
}

function serializePositions(positions: RecoveryPosition[]) {
  return positions.map(position => ({ asset: position.asset, amount: position.amount.toString() }));
}

function recoveryFingerprint(positions: RecoveryPosition[]) {
  return serializePositions(positions)
    .map(position => `${position.asset}-${position.amount}`)
    .join("_")
    .slice(0, 100) || "empty";
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function isDashboardRequest(request: Request) {
  if (request.headers.get("x-live-action") !== "nobitex-dashboard") return false;
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
