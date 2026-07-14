import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import type { BotSettings } from "@/lib/bot-settings";
import { getBotSettings } from "@/lib/bot-settings-store";
import { config } from "@/lib/config";
import { NobitexClient } from "@/lib/exchanges/nobitex";
import type { OrderBook } from "@/lib/exchanges/types";
import {
  acquireExecutionLease,
  emergencyStopRiskControl,
  evaluateRiskState,
  getRiskState,
  recordRealizedPnl,
  renewExecutionLease,
  releaseExecutionLease
} from "@/lib/risk/store";
import type { ExecutionLease, RiskEvaluation, RiskState } from "@/lib/risk/types";
import {
  acquireStrategyExecutionRecordLock,
  releaseStrategyExecutionRecordLock,
  type StrategyExecutionRecordLock
} from "@/lib/strategy-execution-lock";
import {
  CrossQuoteExecutionError,
  createCrossQuoteExecutionPlan,
  executeClosedCrossQuote,
  type CrossQuoteExecutionClient,
  type CrossQuoteExecutionHooks,
  type CrossQuoteExecutionPlan,
  type CrossQuoteExecutionResult
} from "@/lib/strategies/cross-quote-executor";
import { scanConfiguredStrategies } from "@/lib/strategies/service";
import type { StrategyLabScanResult, StrategySignal } from "@/lib/strategies/types";
import {
  addStrategyExecutionOrder,
  completeStrategyExecution,
  createStrategyExecution,
  failStrategyExecution,
  StrategyExecutionConflictError,
  transitionStrategyExecution,
  type StrategyExecutionState
} from "@/lib/strategy-execution-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const inputSchema = z.object({
  signalId: z.string().trim().min(1).max(100).regex(/^cross:[A-Z0-9_-]+:to-(?:usdt|irt)$/i)
}).strict();

export type CrossQuoteRouteDependencies = {
  runtimeAvailable?(): boolean;
  getSettings(): Promise<BotSettings>;
  createClient(): CrossQuoteExecutionClient;
  scanStrategies(books: OrderBook[], settings: BotSettings, client: CrossQuoteExecutionClient): Promise<StrategyLabScanResult>;
  createPlan(signal: StrategySignal, settings: BotSettings): CrossQuoteExecutionPlan;
  acquireLease: typeof acquireExecutionLease;
  renewLease: typeof renewExecutionLease;
  releaseLease: typeof releaseExecutionLease;
  getRiskState: typeof getRiskState;
  evaluateRisk(state: RiskState): RiskEvaluation;
  emergencyStop: typeof emergencyStopRiskControl;
  recordPnl?: typeof recordRealizedPnl;
  acquireRecordLock?: typeof acquireStrategyExecutionRecordLock;
  releaseRecordLock?: typeof releaseStrategyExecutionRecordLock;
  createExecution: typeof createStrategyExecution;
  transitionExecution: typeof transitionStrategyExecution;
  addOrder: typeof addStrategyExecutionOrder;
  completeExecution: typeof completeStrategyExecution;
  failExecution: typeof failStrategyExecution;
  execute(plan: CrossQuoteExecutionPlan, client: CrossQuoteExecutionClient, hooks: CrossQuoteExecutionHooks): Promise<CrossQuoteExecutionResult>;
};

const defaultDependencies: CrossQuoteRouteDependencies = {
  runtimeAvailable: () => true,
  getSettings: getBotSettings,
  createClient: () => new NobitexClient(),
  scanStrategies: (books, settings, client) => scanConfiguredStrategies(books, settings, client as NobitexClient),
  createPlan: (signal, settings) => createCrossQuoteExecutionPlan(signal, {
    capitalToman: settings.strategyLab.crossQuote.capitalToman,
    tomanTakerFeeBps: settings.tomanTakerFeeBps,
    usdtTakerFeeBps: settings.usdtTakerFeeBps,
    slippageBps: settings.slippageBufferBps,
    minEdgeBps: settings.strategyLab.crossQuote.minEdgeBps,
    liveSafetyBufferBps: settings.liveSafetyBufferBps,
    maxSpreadBps: settings.strategyLab.crossQuote.maxSpreadBps,
    maxPriceImpactBps: settings.maxPriceImpactBps,
    depthUsagePercent: settings.strategyLab.crossQuote.depthUsagePercent,
    maxAgeMs: settings.orderbookMaxAgeMs,
    orderTimeoutMs: settings.orderTimeoutMs,
    orderReserveBps: settings.slippageBufferBps
  }),
  acquireLease: acquireExecutionLease,
  renewLease: renewExecutionLease,
  releaseLease: releaseExecutionLease,
  getRiskState,
  evaluateRisk: evaluateRiskState,
  emergencyStop: emergencyStopRiskControl,
  recordPnl: recordRealizedPnl,
  acquireRecordLock: acquireStrategyExecutionRecordLock,
  releaseRecordLock: releaseStrategyExecutionRecordLock,
  createExecution: createStrategyExecution,
  transitionExecution: transitionStrategyExecution,
  addOrder: addStrategyExecutionOrder,
  completeExecution: completeStrategyExecution,
  failExecution: failStrategyExecution,
  execute: (plan, client, hooks) => executeClosedCrossQuote(plan, client, hooks, { baseUrl: config.NOBITEX_API_BASE })
};

export async function POST(request: Request) {
  return handleCrossQuoteExecute(request, defaultDependencies);
}

/** Exported for deterministic route tests; production always calls POST with the closed default dependency set above. */
export async function handleCrossQuoteExecute(request: Request, dependencies: CrossQuoteRouteDependencies) {
  if (!isDashboardStrategyRequest(request)) {
    return NextResponse.json({ error: "Cross-Quote execution is accepted only from this dashboard" }, { status: 403 });
  }

  let input: z.infer<typeof inputSchema>;
  try {
    input = inputSchema.parse(await request.json());
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Request body accepts only signalId", issues: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }
  if (dependencies.runtimeAvailable?.() === false) {
    return NextResponse.json({
      error: "Cross-Quote Live requires durable restart recovery and closed Toman PnL accounting",
      code: "EXECUTION_UNAVAILABLE"
    }, { status: 423 });
  }

  let lease: ExecutionLease | undefined;
  let recordLock: StrategyExecutionRecordLock | undefined;
  let executionId: number | undefined;
  let executionState: StrategyExecutionState | undefined;
  try {
    // Never accept prices, settings, routes or expected profit from the browser.
    const settings = await dependencies.getSettings();
    const client = dependencies.createClient();
    const books = await client.getAllOrderBooks();
    const strategyScan = await dependencies.scanStrategies(books, settings, client);
    const signal = strategyScan.signals.find(candidate =>
      candidate.id === input.signalId
      && candidate.kind === "cross-quote"
      && candidate.status === "actionable"
    );
    if (!signal) {
      return NextResponse.json({
        status: "rejected",
        reason: "The requested Cross-Quote signal is no longer actionable after a fresh server-side scan"
      }, { status: 409 });
    }
    const plan = dependencies.createPlan(signal, settings);

    const acquisition = await dependencies.acquireLease({
      strategy: "crossQuote",
      owner: `cross-quote:execution:${input.signalId}:${randomUUID()}`,
      ttlMs: 300_000
    });
    if (!acquisition.acquired) {
      if (acquisition.reason === "risk-blocked") {
        return NextResponse.json({
          error: "Cross-Quote Live is locked by server-side Risk Control",
          code: "RISK_BLOCKED",
          blockers: acquisition.blockers
        }, { status: 423 });
      }
      return NextResponse.json({ status: "busy", blockers: acquisition.blockers }, { status: 409 });
    }
    lease = acquisition.lease;

    const record = await dependencies.createExecution({
      strategy: "crossQuote",
      signalId: signal.id,
      symbols: [...plan.route],
      direction: plan.direction,
      requestedCapitalToman: plan.capitalToman.toNumber(),
      plannedProfitToman: signal.estimatedNetProfitToman.toNumber(),
      metadata: {
        planId: plan.id,
        signalScannedAt: signal.scannedAt,
        signalEdgeBps: signal.expectedEdgeBps.toString(),
        requiredEdgeBps: plan.config.minEdgeBps.plus(plan.config.liveSafetyBufferBps).toString(),
        accounting: "closed-irt-cycle",
        environment: "mainnet"
      }
    });
    executionId = record.id;
    executionState = "DETECTED";
    if (dependencies.acquireRecordLock) {
      const recordLockResult = await dependencies.acquireRecordLock({
        executionId,
        owner: `cross-quote:execution:${executionId}`,
        ttlMs: 600_000
      });
      if (!recordLockResult.acquired) {
        await dependencies.failExecution(executionId, "Cross-Quote execution record is already owned").catch(() => undefined);
        return NextResponse.json({ status: "busy", code: "POSITION_ALREADY_OWNED" }, { status: 409 });
      }
      recordLock = recordLockResult.lock;
    }

    const transition = async (to: StrategyExecutionState, note: string, metadata?: Record<string, unknown>) => {
      if (executionId === undefined || executionState === to) return;
      await dependencies.transitionExecution(executionId, to, { note, metadata });
      executionState = to;
    };
    await transition("REVALIDATING", "Fresh server-side Cross-Quote revalidation started");

    const legIndex = { leg1: 0, leg2: 1, leg3: 2, recovery: 3 } as const;
    const hooks: CrossQuoteExecutionHooks = {
      onRevalidated: async event => {
        // This is intentionally an order-free audit event. The immutable plan and final fills are persisted separately.
        if (event.phase === "entry-2" && event.edgeBps.lt(plan.config.minEdgeBps.plus(plan.config.liveSafetyBufferBps))) {
          throw new Error("Revalidation hook observed an edge below the immutable plan threshold");
        }
      },
      onBeforeOrder: async ({ stage, quote, request: orderRequest }) => {
        if (!lease || !await dependencies.renewLease(lease, 300_000)) {
          throw new CrossQuoteExecutionError("Cross-Quote execution lease ownership was lost", "ORDER_STATE_UNKNOWN", stage !== "leg1");
        }
        // A stop/disarm between normal legs must prevent more risk from being added. Recovery is
        // deliberately allowed to unwind while stopped, but it still requires the same lease owner.
        if (stage !== "recovery") {
          const riskState = await dependencies.getRiskState();
          const blockers = dependencies.evaluateRisk(riskState).strategies.crossQuote.blockers;
          if (blockers.length > 0) {
            throw new CrossQuoteExecutionError(
              `Cross-Quote Risk Control changed before ${stage}: ${blockers.join(", ")}`,
              "ORDER_FAILED",
              false
            );
          }
        }
        if (stage === "recovery" && executionState !== "RECOVERING") {
          await transition("RECOVERING", "Emergency IRT recovery order is being prepared");
        } else if (executionState === "REVALIDATING") {
          await transition("SUBMITTING", "Cross-Quote Spot orders are being submitted");
        }
        await dependencies.addOrder(executionId!, {
          legIndex: legIndex[stage],
          symbol: quote.edge.book.symbol,
          side: quote.edge.side,
          status: "submitting",
          clientOrderId: orderRequest.clientOrderId,
          requestedAmount: orderRequest.amountBase.toString(),
          inputAsset: quote.edge.from,
          outputAsset: quote.edge.to,
          raw: { event: "before-submit", expectedPrice: orderRequest.expectedPrice.toString(), stage }
        });
      },
      onOrderSubmitted: async ({ stage, order, request: orderRequest }) => {
        await dependencies.addOrder(executionId!, {
          legIndex: legIndex[stage],
          symbol: `${orderRequest.base}${orderRequest.quote}`,
          side: orderRequest.side,
          status: order.status,
          clientOrderId: orderRequest.clientOrderId,
          exchangeOrderId: order.id,
          requestedAmount: orderRequest.amountBase.toString(),
          filledAmount: order.matchedAmount.toString(),
          averagePrice: order.averagePrice.toString(),
          fee: order.fee.toString(),
          inputAsset: orderRequest.side === "BUY" ? orderRequest.quote : orderRequest.base,
          outputAsset: orderRequest.side === "BUY" ? orderRequest.base : orderRequest.quote,
          raw: { event: "submitted", stage, exchange: order.raw }
        });
      },
      onOrderFinalized: async ({ stage, leg }) => {
        await dependencies.addOrder(executionId!, {
          legIndex: legIndex[stage],
          symbol: leg.symbol,
          side: leg.side,
          status: leg.status,
          clientOrderId: leg.clientOrderId,
          exchangeOrderId: leg.orderId,
          requestedAmount: leg.submittedAmountBase.toString(),
          filledAmount: leg.matchedAmountBase.toString(),
          averagePrice: leg.averagePrice.toString(),
          fee: leg.fee.toString(),
          inputAsset: leg.inputAsset,
          outputAsset: leg.outputAsset,
          raw: {
            event: "finalized",
            stage,
            fullFill: leg.fullFill,
            unmatchedAmount: leg.unmatchedAmountBase.toString(),
            actualInput: leg.actualInput.toString(),
            actualOutput: leg.actualOutput.toString(),
            feeAsset: leg.feeAsset
          }
        });
        if (!leg.fullFill && executionState === "SUBMITTING") {
          await transition("PARTIALLY_FILLED", `${stage} ended with a partial fill`, { exchangeOrderId: leg.orderId });
        }
      },
      onRecoveryStarted: async ({ assetAmount, reason }) => {
        if (executionState !== "RECOVERING") {
          await transition("RECOVERING", "Automatic IRT recovery started", { assetAmount: assetAmount.toString(), reason });
        }
      }
    };

    const result = await dependencies.execute(plan, client, hooks);
    const normalLegCount = result.legs.filter(leg => leg.stage !== "recovery").length;
    if (result.finalAsset !== "IRT"
      || !result.actualInputToman
      || result.actualInputToman.lte(0)
      || result.fullySettled !== true
      || (result.status === "completed" && normalLegCount < 3)) {
      throw new CrossQuoteExecutionError(
        "Cross-Quote did not prove a complete IRT-funded, IRT-settled three-leg cycle",
        "RECOVERY_FAILED",
        true
      );
    }
    if (result.status === "recovered" && (executionState as StrategyExecutionState) !== "RECOVERING") {
      await transition("RECOVERING", "Automatic recovery completed", { reason: result.recoveryReason });
    }
    const actualInputToman = result.actualInputToman;
    const actualProfitToman = result.finalOutput.minus(actualInputToman);
    await dependencies.completeExecution(executionId, {
      note: result.status === "recovered" ? "Cross-Quote exposure recovered to IRT" : "Cross-Quote closed IRT cycle completed",
      actualOutputToman: result.finalOutput.toNumber(),
      actualProfitToman: actualProfitToman.toNumber(),
      metadata: {
        resultStatus: result.status,
        finalAsset: result.finalAsset,
        finalOutput: result.finalOutput.toString(),
        residualAssetAmount: result.residualAssetAmount.toString(),
        fullySettled: result.fullySettled,
        actualEdgeBps: result.actualEdgeBps?.toString() ?? null,
        recoveryReason: result.recoveryReason ?? null,
        actualInputToman: actualInputToman.toString(),
        pnlRecorded: Boolean(dependencies.recordPnl)
      }
    });
    executionState = "CLOSED";
    if (dependencies.recordPnl) {
      try {
        await dependencies.recordPnl(actualProfitToman.toNumber(), new Date(), {
          idempotencyKey: `crossQuote:${executionId}:pnl`
        });
      } catch (error) {
        await dependencies.emergencyStop(`cross-quote-risk-accounting-failed:${error instanceof Error ? error.message : "unknown"}`).catch(() => undefined);
        throw error;
      }
    }
    if (actualProfitToman.lt(0)) {
      await dependencies.emergencyStop("cross-quote-realized-loss-circuit-breaker").catch(() => undefined);
    }

    return NextResponse.json({
      status: result.status,
      executionId,
      signalId: signal.id,
      direction: plan.direction,
      finalAsset: result.finalAsset,
      finalOutput: result.finalOutput.toString(),
      residualAssetAmount: result.residualAssetAmount.toString(),
      fullySettled: result.fullySettled,
      actualEdgeBps: result.actualEdgeBps?.toString(),
      recoveryReason: result.recoveryReason,
      legs: result.legs.map(serializeLeg),
      actualInputToman: actualInputToman.toString(),
      profitToman: actualProfitToman.toString(),
      pnlRecorded: Boolean(dependencies.recordPnl)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cross-Quote execution failed";
    const explicitManual = error instanceof CrossQuoteExecutionError && error.manualInterventionRequired;
    const manualIntervention = explicitManual || (!(error instanceof CrossQuoteExecutionError)
      && executionState !== undefined
      && ["SUBMITTING", "PARTIALLY_FILLED", "RECOVERING"].includes(executionState));

    if (executionId !== undefined && executionState !== "CLOSED") {
      if (manualIntervention && executionState !== "RECOVERING") {
        try {
          await dependencies.transitionExecution(executionId, "RECOVERING", {
            note: "Automatic recovery could not establish a confirmed flat state",
            metadata: { error: message }
          });
          executionState = "RECOVERING";
        } catch {
          // failExecution below still records the terminal error when the current state permits it.
        }
      }
      await dependencies.failExecution(executionId, message, {
        metadata: { manualInterventionRequired: manualIntervention }
      }).catch(() => undefined);
    }
    if (manualIntervention) {
      await dependencies.emergencyStop(`cross-quote-manual-intervention:${message}`).catch(() => undefined);
    }

    const status = error instanceof CrossQuoteExecutionError
      ? error.code === "REVALIDATION_FAILED" ? 409
        : error.code === "MAINNET_REQUIRED" ? 423
          : error.code === "INVALID_PLAN" ? 400
            : 502
      : error instanceof StrategyExecutionConflictError ? 409 : 500;
    return NextResponse.json({
      error: message,
      code: error instanceof CrossQuoteExecutionError ? error.code
        : error instanceof StrategyExecutionConflictError ? error.code : "CROSS_QUOTE_EXECUTION_FAILED",
      executionId,
      existingExecutionId: error instanceof StrategyExecutionConflictError ? error.existingExecutionId : undefined,
      manualInterventionRequired: manualIntervention
    }, { status });
  } finally {
    if (lease) await dependencies.releaseLease(lease).catch(() => undefined);
    if (recordLock && dependencies.releaseRecordLock) await dependencies.releaseRecordLock(recordLock).catch(() => undefined);
  }
}

export function isDashboardStrategyRequest(request: Request) {
  if (request.headers.get("x-strategy-action") !== "nobitex-dashboard") return false;
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try { return new URL(origin).host.toLowerCase() === host.toLowerCase(); } catch { return false; }
}

function serializeLeg(leg: CrossQuoteExecutionResult["legs"][number]) {
  return {
    ...leg,
    submittedAmountBase: leg.submittedAmountBase.toString(),
    matchedAmountBase: leg.matchedAmountBase.toString(),
    unmatchedAmountBase: leg.unmatchedAmountBase.toString(),
    actualInput: leg.actualInput.toString(),
    actualOutput: leg.actualOutput.toString(),
    fee: leg.fee.toString(),
    averagePrice: leg.averagePrice.toString()
  };
}
