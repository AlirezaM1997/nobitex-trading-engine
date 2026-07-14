import { NextResponse } from "next/server";
import { z } from "zod";
import { config } from "@/lib/config";
import { listStrategyExecutions } from "@/lib/strategy-execution-store";
import {
  handleSpotPositionRecoveryRequest,
  isDashboardStrategyRequest,
  type SpotPositionRouteKind
} from "@/lib/strategies/spot-position-route";
import { POST as supervisePairs } from "@/app/api/strategies/statistical-pairs/execute/route";
import { emergencyStopRiskControl } from "@/lib/risk/store";
import { acquireStrategyExecutionRecordLock, releaseStrategyExecutionRecordLock } from "@/lib/strategy-execution-lock";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type SupervisorDependencies = {
  isMainnet(): boolean;
  listExecutions: typeof listStrategyExecutions;
  monitorPairs(request: Request): Promise<Response>;
  recoverSpot(request: Request, kind: SpotPositionRouteKind): Promise<Response>;
  acquireRecordLock?: typeof acquireStrategyExecutionRecordLock;
  releaseRecordLock?: typeof releaseStrategyExecutionRecordLock;
  emergencyStop?: typeof emergencyStopRiskControl;
};

type SupervisorRuntime = {
  timer: ReturnType<typeof setInterval>;
  inFlight: boolean;
  lastTickAt: number | null;
};

type SupervisorGlobal = typeof globalThis & { __nobitexStrategySupervisor?: SupervisorRuntime };

const defaultDependencies: SupervisorDependencies = {
  isMainnet: () => {
    try { return new URL(config.NOBITEX_API_BASE).hostname.toLowerCase() === "apiv2.nobitex.ir"; }
    catch { return false; }
  },
  listExecutions: listStrategyExecutions,
  monitorPairs: supervisePairs,
  recoverSpot: (request, kind) => handleSpotPositionRecoveryRequest(request, kind),
  acquireRecordLock: acquireStrategyExecutionRecordLock,
  releaseRecordLock: releaseStrategyExecutionRecordLock,
  emergencyStop: emergencyStopRiskControl
};

export async function POST(request: Request) {
  return handleStrategySupervisor(request, defaultDependencies);
}

/** Starts the risk-reducing monitor inside the long-running Node process. */
export function ensureStrategySupervisorStarted(intervalMs = 5_000) {
  // `next build` also uses NODE_ENV=production. A build worker must never
  // reconcile positions or mutate runtime state, even though order adapters
  // have their own lower-level owner fence.
  if (!shouldStartStrategySupervisor()) return;
  const root = globalThis as SupervisorGlobal;
  if (root.__nobitexStrategySupervisor) return;
  const runtime = { inFlight: false, lastTickAt: null } as SupervisorRuntime;
  const tick = async () => {
    if (runtime.inFlight) return;
    runtime.inFlight = true;
    try {
      await POST(new Request("http://nobitex-internal/api/strategies/supervise", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "nobitex-internal",
          origin: "http://nobitex-internal",
          "x-strategy-action": "nobitex-dashboard"
        },
        body: "{}"
      }));
      runtime.lastTickAt = Date.now();
    } catch {
      // Child recovery/monitor routes persist audit failures and trigger their
      // own Emergency Stop. A later tick retries non-terminal work.
    } finally {
      runtime.inFlight = false;
    }
  };
  runtime.timer = setInterval(() => void tick(), Math.max(1_000, intervalMs));
  runtime.timer.unref?.();
  root.__nobitexStrategySupervisor = runtime;
  void tick();
}

export function shouldStartStrategySupervisor(environment: NodeJS.ProcessEnv = process.env) {
  return environment.NODE_ENV === "production"
    && environment.NEXT_PHASE !== "phase-production-build"
    && environment.NEXT_RUNTIME === "nodejs";
}

/**
 * Supervises durable non-Triangle positions. It can close/recover exposure while
 * Master Live is disarmed, but it never creates a new position.
 */
export async function handleStrategySupervisor(request: Request, dependencies: SupervisorDependencies) {
  if (!isDashboardStrategyRequest(request)) {
    return NextResponse.json({ error: "Position supervision is accepted only from this dashboard" }, { status: 403 });
  }
  try {
    z.object({}).strict().parse(await request.json());
  } catch (error) {
    return NextResponse.json({ error: "Supervisor body must be an empty JSON object" }, { status: error instanceof z.ZodError ? 400 : 400 });
  }
  if (!dependencies.isMainnet()) {
    return NextResponse.json({ status: "inactive", reason: "mainnet-required" });
  }

  const delegated = (body: unknown) => {
    const headers = new Headers(request.headers);
    headers.set("content-type", "application/json");
    return new Request(request.url, { method: "POST", headers, body: JSON.stringify(body) });
  };

  // Pairs owns its lifecycle decisions server-side (fresh OHLC/Z-score, beta
  // drift, stop and max-holding). This tick also reconciles interrupted entries.
  const pairsResponse = await dependencies.monitorPairs(delegated({ action: "monitor" }));
  const pairs = await responsePayload(pairsResponse);

  const history = await dependencies.listExecutions({ limit: 200 });
  const activeStates = new Set(["SUBMITTING", "PARTIALLY_FILLED", "HEDGING", "RECOVERING"]);
  const crossQuoteReviews: Array<Record<string, unknown>> = [];
  if (dependencies.acquireRecordLock && dependencies.releaseRecordLock && dependencies.emergencyStop) {
    for (const record of history.records.filter(item => item.strategy === "crossQuote" && activeStates.has(item.state)).slice(0, 10)) {
      const acquired = await dependencies.acquireRecordLock({
        executionId: record.id,
        owner: `cross-quote:restart-audit:${record.id}`,
        ttlMs: 60_000
      });
      if (!acquired.acquired) {
        crossQuoteReviews.push({ executionId: record.id, status: "owned-by-live-worker" });
        continue;
      }
      try {
        await dependencies.emergencyStop(`cross-quote-restart-review-required:${record.id}`);
        crossQuoteReviews.push({ executionId: record.id, status: "manual-review", emergencyStop: true });
      } finally {
        await dependencies.releaseRecordLock(acquired.lock).catch(() => undefined);
      }
    }
  }
  const activeSpot = history.records
    .filter(record => (record.strategy === "stablecoin" || record.strategy === "gapTrading" || record.strategy === "imbalance")
      && Boolean(record.signalId)
      && activeStates.has(record.state))
    .sort((a, b) => a.updatedAt - b.updatedAt);
  // Probe the oldest active record directly. Its per-record generation lock is
  // the authoritative fence: a healthy worker returns POSITION_ALREADY_OWNED,
  // while a restarted process can safely take over its dead generation.
  if (!activeSpot.length) {
    return NextResponse.json({ status: "checked", pairs, crossQuoteReviews, spotRecoveries: [], activeSpotCount: 0 });
  }

  const spotRecoveries: Array<Record<string, unknown>> = [];
  for (const record of activeSpot.slice(0, 10)) {
    if (!record.signalId) continue;
    const kind: SpotPositionRouteKind = record.strategy === "stablecoin"
      ? "stablecoin"
      : record.strategy === "gapTrading"
        ? "orderbook-gap"
        : "orderbook-imbalance";
    const response = await dependencies.recoverSpot(delegated({ signalId: record.signalId }), kind);
    spotRecoveries.push({ executionId: record.id, kind, ...await responsePayload(response) });
  }
  const recovered = spotRecoveries.some(item => item.status === "recovered" || item.status === "already-flat");
  const failed = spotRecoveries.some(item => Number(item.httpStatus) >= 500);
  return NextResponse.json({
    status: recovered ? "recovery-checked" : "recovery-deferred",
    pairs,
    crossQuoteReviews,
    spotRecoveries,
    activeSpotCount: activeSpot.length
  }, { status: failed ? 502 : 200 });
}

async function responsePayload(response: Response) {
  try { return { httpStatus: response.status, ...await response.json() as Record<string, unknown> }; }
  catch { return { httpStatus: response.status, error: "Supervisor child response was not JSON" }; }
}
