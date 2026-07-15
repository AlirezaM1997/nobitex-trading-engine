import { randomUUID } from "node:crypto";
import { getBotSettings } from "@/lib/bot-settings-store";
import { getRiskControlSnapshot } from "@/lib/risk/store";
import { STRATEGY_RUNTIME_CAPABILITIES } from "@/lib/strategy-runtime-capabilities";
import { NobitexClient } from "@/lib/exchanges/nobitex";
import { scanConfiguredStrategies } from "@/lib/strategies/service";
import type { StrategyKind, StrategySignal } from "@/lib/strategies/types";
import type { RiskStrategy } from "@/lib/risk/types";
import type { AiAgentSettings } from "@/lib/ai-agent/settings";
import {
  recordAiLiveDecision,
  selectAiLiveCandidate,
  type AiLiveSelection
} from "@/lib/ai-agent/live-policy";
import { scanAiMarketBooks } from "@/lib/ai-agent/scanner-service";
import type { IndependentAiMarketCandidate } from "@/lib/ai-agent/market-scanner";
import {
  assertLiveOwnerForOrder,
  getLiveOwnerStatus,
  type PublicLiveOwnerStatus
} from "@/lib/runtime/live-owner";

const MIN_INTERVAL_MS = 1_000;
const FALLBACK_INTERVAL_MS = 5_000;
const MAX_EVENT_COUNT = 20;

export type LiveSchedulerOutcome =
  | "not-production"
  | "master-disarmed"
  | "triangle-disabled"
  | "engines-disabled"
  | "risk-blocked"
  | "owner-not-held"
  | "in-flight"
  | "no-opportunity"
  | "busy"
  | "rejected"
  | "executed"
  | "error";

export type LiveSchedulerEvent = {
  at: number;
  outcome: LiveSchedulerOutcome;
  httpStatus?: number;
  code?: string;
  detail?: string;
  strategy?: RiskStrategy;
};

export type LiveSchedulerStatus = {
  running: boolean;
  productionOnly: true;
  inFlight: boolean;
  startedAt: number | null;
  lastTickAt: number | null;
  lastCompletedAt: number | null;
  nextTickAt: number | null;
  intervalMs: number;
  tickCount: number;
  lastOutcome: LiveSchedulerOutcome | null;
  events: LiveSchedulerEvent[];
};

export type LiveSchedulerRuntime = {
  generation: string;
  running: boolean;
  inFlightToken: string | null;
  timer?: ReturnType<typeof setTimeout>;
  startedAt: number | null;
  lastTickAt: number | null;
  lastCompletedAt: number | null;
  nextTickAt: number | null;
  intervalMs: number;
  tickCount: number;
  events: LiveSchedulerEvent[];
};

export type LiveSchedulerDependencies = {
  isProduction(): boolean;
  now(): number;
  getSettings(): Promise<{ scanIntervalMs: number; aiAgent?: AiAgentSettings }>;
  getRiskSnapshot(): ReturnType<typeof getRiskControlSnapshot>;
  getOwnerStatus(): Promise<PublicLiveOwnerStatus>;
  assertOwner(): Promise<unknown>;
  executeTriangle(request: Request): Promise<Response>;
  discoverAiCandidates?(): Promise<IndependentAiMarketCandidate[]>;
  executeAiCandidate?(candidateId: string): Promise<Response>;
  discoverStrategySignals?(): Promise<StrategySignal[]>;
  executeStrategy?(kind: StrategyKind, signalId: string): Promise<Response>;
  selectAiCandidate?(input: {
    candidates: IndependentAiMarketCandidate[];
    settings: AiAgentSettings;
  }): Promise<{ selection?: AiLiveSelection; blockers: string[] }>;
  recordAiDecision?(input: {
    settings: AiAgentSettings;
    action: string;
    candidate?: IndependentAiMarketCandidate;
    probability?: number;
    detail?: string;
  }): Promise<void>;
};

type SchedulerGlobal = typeof globalThis & {
  __nobitexLiveScheduler?: LiveSchedulerRuntime;
};

const defaultDependencies: LiveSchedulerDependencies = {
  // `next build` also sets NODE_ENV=production. Instrumentation must never
  // schedule entries in the build worker even if an old state file was armed.
  isProduction: () => process.env.NODE_ENV === "production"
    && process.env.NEXT_PHASE !== "phase-production-build",
  now: () => Date.now(),
  getSettings: getBotSettings,
  getRiskSnapshot: getRiskControlSnapshot,
  getOwnerStatus: getLiveOwnerStatus,
  assertOwner: assertLiveOwnerForOrder,
  executeTriangle: async request => {
    // Calling the route handler directly preserves the route's authoritative
    // risk lease, fresh scan, orderbook revalidation and recovery hooks without
    // depending on a browser tab or a public HTTP round trip.
    const { POST } = await import("@/app/api/live/execute/route");
    return POST(request);
  },
  discoverAiCandidates: async () => {
    const settings = await getBotSettings();
    const client = new NobitexClient();
    const books = await client.getAllOrderBooks();
    return scanAiMarketBooks(books, settings, {
      capitalToman: settings.aiAgent.maxLiveCapitalToman
    }).candidates;
  },
  executeAiCandidate: async candidateId => {
    const request = internalAiRequest(candidateId);
    const { POST } = await import("@/app/api/ai-agent/execute/route");
    return POST(request);
  },
  discoverStrategySignals: async () => {
    const settings = await getBotSettings();
    const client = new NobitexClient();
    const books = await client.getAllOrderBooks();
    return (await scanConfiguredStrategies(books, settings, client)).signals;
  },
  executeStrategy: async (kind, signalId) => {
    const request = internalStrategyRequest(kind, signalId);
    const { POST } = await import("@/app/api/strategies/auto-execute/route");
    return POST(request);
  },
  selectAiCandidate: selectAiLiveCandidate,
  recordAiDecision: recordAiLiveDecision
};

export function createLiveSchedulerRuntime(now = Date.now()): LiveSchedulerRuntime {
  return {
    generation: randomUUID(),
    running: false,
    inFlightToken: null,
    startedAt: now,
    lastTickAt: null,
    lastCompletedAt: null,
    nextTickAt: null,
    intervalMs: MIN_INTERVAL_MS,
    tickCount: 0,
    events: []
  };
}

/**
 * Starts one production-only scheduler per Node process. The account-scoped
 * Live Owner remains the cross-process fence, so only its holder may delegate
 * a route that can place orders.
 */
export function ensureLiveSchedulerStarted(dependencies: LiveSchedulerDependencies = defaultDependencies) {
  const root = globalThis as SchedulerGlobal;
  const existing = root.__nobitexLiveScheduler;
  if (existing?.running) return getLiveSchedulerStatus(existing);

  const runtime = existing ?? createLiveSchedulerRuntime(dependencies.now());
  root.__nobitexLiveScheduler = runtime;
  if (!dependencies.isProduction()) {
    runtime.running = false;
    pushEvent(runtime, { at: dependencies.now(), outcome: "not-production", code: "production-runtime-required" });
    return getLiveSchedulerStatus(runtime);
  }

  runtime.generation = randomUUID();
  runtime.running = true;
  runtime.startedAt = dependencies.now();
  void scheduleInitialTick(runtime, dependencies, runtime.generation);
  return getLiveSchedulerStatus(runtime);
}

export function stopLiveScheduler() {
  const runtime = (globalThis as SchedulerGlobal).__nobitexLiveScheduler;
  if (!runtime) return;
  runtime.running = false;
  runtime.generation = randomUUID();
  runtime.nextTickAt = null;
  if (runtime.timer) clearTimeout(runtime.timer);
  runtime.timer = undefined;
}

/** One deterministic scheduler decision; exported so safety gates stay testable. */
export async function runLiveSchedulerTick(
  runtime: LiveSchedulerRuntime,
  dependencies: LiveSchedulerDependencies = defaultDependencies
): Promise<LiveSchedulerEvent> {
  const now = dependencies.now();
  if (runtime.inFlightToken) {
    return pushEvent(runtime, { at: now, outcome: "in-flight", code: "single-flight-fence" });
  }

  const fence = randomUUID();
  runtime.inFlightToken = fence;
  runtime.lastTickAt = now;
  runtime.tickCount += 1;
  try {
    // Settings are loaded on every tick. Besides keeping the interval dynamic,
    // this prevents a stale browser copy from becoming execution authority.
    const settings = await dependencies.getSettings();
    runtime.intervalMs = normalizeInterval(settings.scanIntervalMs);

    if (!dependencies.isProduction()) {
      return pushEvent(runtime, { at: now, outcome: "not-production", code: "production-runtime-required" });
    }

    const snapshot = await dependencies.getRiskSnapshot();
    if (!snapshot.state.masterArmed) {
      return pushEvent(runtime, { at: now, outcome: "master-disarmed" });
    }
    const runnable = automaticStrategies(snapshot);
    if (!runnable.length) {
      const enabled = Object.values(snapshot.state.strategies).some(item => item.enabled);
      return pushEvent(runtime, {
        at: now,
        outcome: enabled ? "risk-blocked" : "engines-disabled",
        code: enabled ? firstStrategyBlocker(snapshot) : undefined
      });
    }

    const triangleRunnable = runnable.includes("triangle");
    const owner = await dependencies.getOwnerStatus();
    if (!owner.heldByThisProcess) {
      return pushEvent(runtime, {
        at: now,
        outcome: "owner-not-held",
        code: owner.locked ? "live-owner-held-by-another-runtime" : "live-owner-not-held"
      });
    }
    // The status is informative; the token/record assertion is the actual fence.
    await dependencies.assertOwner();

    if (triangleRunnable) {
      const response = await dependencies.executeTriangle(internalTriangleRequest());
      const payload = await safePayload(response);
      const outcome = response.ok ? responseOutcome(payload.status) : "rejected";
      if (outcome !== "no-opportunity") {
        return pushEvent(runtime, {
          at: now,
          outcome,
          strategy: "triangle",
          httpStatus: response.status,
          code: safeCode(payload.code),
          detail: safeDetail(payload.reason ?? payload.error)
        });
      }
    }

    const aiRunnable = runnable.includes("aiAgent");
    const aiSettings = settings.aiAgent;
    let aiNoOpportunityCode: string | undefined;
    if (aiRunnable && aiSettings?.enabled && aiSettings.mode === "live") {
      if (!dependencies.discoverAiCandidates || !dependencies.executeAiCandidate || !dependencies.selectAiCandidate) {
        return pushEvent(runtime, {
          at: now,
          outcome: "risk-blocked",
          code: "ai-policy-unavailable"
        });
      }
      const independentCandidates = await dependencies.discoverAiCandidates();
      const ranked = await dependencies.selectAiCandidate({
        candidates: independentCandidates,
        settings: aiSettings
      });
      const aiSelection = ranked.selection;
      if (aiSelection) {
        const response = await dependencies.executeAiCandidate(aiSelection.candidate.id);
        const payload = await safePayload(response);
        const outcome = response.ok ? responseOutcome(payload.status) : "rejected";
        await dependencies.recordAiDecision?.({
          settings: aiSettings,
          action: outcome,
          candidate: aiSelection.candidate,
          probability: aiSelection.probability,
          detail: safeDetail(payload.reason ?? payload.error)
        });
        if (outcome !== "no-opportunity") {
          return pushEvent(runtime, {
            at: now,
            outcome,
            strategy: "aiAgent",
            httpStatus: response.status,
            code: safeCode(payload.code),
            detail: safeDetail(payload.reason ?? payload.error)
          });
        }
      } else {
        aiNoOpportunityCode = ranked.blockers[0] ?? "no-qualified-live-candidate";
      }
    } else if (aiRunnable) {
      aiNoOpportunityCode = !aiSettings?.enabled ? "ai-agent-disabled" : "ai-agent-demo-mode";
    }

    // Gap and Imbalance remain independent engines. Enabling AI Demo must not
    // suppress their own explicitly enabled Live workflows.
    const strategyEngines = new Set<RiskStrategy>(runnable.filter(strategy =>
      strategy === "gapTrading" || strategy === "imbalance"
    ));
    if (!strategyEngines.size || !dependencies.discoverStrategySignals || !dependencies.executeStrategy) {
      return pushEvent(runtime, {
        at: now,
        outcome: "no-opportunity",
        strategy: aiRunnable ? "aiAgent" : triangleRunnable ? "triangle" : undefined,
        code: aiNoOpportunityCode
      });
    }
    const discovered = await dependencies.discoverStrategySignals();
    const candidate = discovered
      .filter(signal => signal.status === "actionable" && strategyEngines.has(signalRiskStrategy(signal.kind)))
      .sort((left, right) => right.estimatedNetProfitToman.comparedTo(left.estimatedNetProfitToman))[0];
    if (!candidate) return pushEvent(runtime, { at: now, outcome: "no-opportunity" });

    const strategy = signalRiskStrategy(candidate.kind);
    const response = await dependencies.executeStrategy(candidate.kind, candidate.id);
    const payload = await safePayload(response);
    return pushEvent(runtime, {
      at: now,
      outcome: response.ok ? responseOutcome(payload.status) : "rejected",
      strategy,
      httpStatus: response.status,
      code: safeCode(payload.code),
      detail: safeDetail(payload.reason ?? payload.error)
    });
  } catch (error) {
    return pushEvent(runtime, {
      at: now,
      outcome: "error",
      code: safeCode(errorCode(error)),
      detail: safeDetail(error instanceof Error ? error.message : "scheduler-tick-failed")
    });
  } finally {
    // A stopped/replaced generation cannot clear a newer tick's fence.
    if (runtime.inFlightToken === fence) runtime.inFlightToken = null;
    runtime.lastCompletedAt = dependencies.now();
  }
}

export function getLiveSchedulerStatus(runtime = (globalThis as SchedulerGlobal).__nobitexLiveScheduler): LiveSchedulerStatus {
  return {
    running: runtime?.running ?? false,
    productionOnly: true,
    inFlight: Boolean(runtime?.inFlightToken),
    startedAt: runtime?.startedAt ?? null,
    lastTickAt: runtime?.lastTickAt ?? null,
    lastCompletedAt: runtime?.lastCompletedAt ?? null,
    nextTickAt: runtime?.nextTickAt ?? null,
    intervalMs: runtime?.intervalMs ?? MIN_INTERVAL_MS,
    tickCount: runtime?.tickCount ?? 0,
    lastOutcome: runtime?.events.at(-1)?.outcome ?? null,
    events: runtime ? [...runtime.events] : []
  };
}

async function scheduleInitialTick(
  runtime: LiveSchedulerRuntime,
  dependencies: LiveSchedulerDependencies,
  generation: string
) {
  try {
    const settings = await dependencies.getSettings();
    runtime.intervalMs = normalizeInterval(settings.scanIntervalMs);
  } catch (error) {
    runtime.intervalMs = FALLBACK_INTERVAL_MS;
    pushEvent(runtime, {
      at: dependencies.now(),
      outcome: "error",
      code: "settings-read-failed",
      detail: safeDetail(error instanceof Error ? error.message : undefined)
    });
  }
  scheduleNextTick(runtime, dependencies, generation);
}

function scheduleNextTick(
  runtime: LiveSchedulerRuntime,
  dependencies: LiveSchedulerDependencies,
  generation: string
) {
  if (!runtime.running || runtime.generation !== generation) return;
  const delay = normalizeInterval(runtime.intervalMs);
  runtime.nextTickAt = dependencies.now() + delay;
  runtime.timer = setTimeout(async () => {
    if (!runtime.running || runtime.generation !== generation) return;
    await runLiveSchedulerTick(runtime, dependencies);
    if (!runtime.running || runtime.generation !== generation) return;
    scheduleNextTick(runtime, dependencies, generation);
  }, delay);
  runtime.timer.unref?.();
}

function internalTriangleRequest() {
  return new Request("http://nobitex-internal/api/live/execute", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "nobitex-internal",
      origin: "http://nobitex-internal",
      "x-live-action": "nobitex-dashboard"
    },
    body: "{}"
  });
}

function internalStrategyRequest(kind: StrategyKind, signalId: string) {
  return new Request("http://nobitex-internal/api/strategies/auto-execute", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "nobitex-internal",
      origin: "http://nobitex-internal",
      "x-strategy-action": "nobitex-dashboard"
    },
    body: JSON.stringify({ kind, signalId })
  });
}

function internalAiRequest(candidateId: string) {
  return new Request("http://nobitex-internal/api/ai-agent/execute", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "nobitex-internal",
      origin: "http://nobitex-internal",
      "x-strategy-action": "nobitex-dashboard"
    },
    body: JSON.stringify({ signalId: candidateId })
  });
}

function signalRiskStrategy(kind: StrategyKind): Exclude<RiskStrategy, "triangle"> {
  if (kind === "orderbook-gap") return "gapTrading";
  return "imbalance";
}

function automaticStrategies(snapshot: Awaited<ReturnType<typeof getRiskControlSnapshot>>) {
  return (Object.keys(STRATEGY_RUNTIME_CAPABILITIES) as RiskStrategy[]).filter(strategy => {
    const state = snapshot.state.strategies[strategy];
    const evaluation = snapshot.evaluation.strategies[strategy];
    const capability = STRATEGY_RUNTIME_CAPABILITIES[strategy];
    return state?.enabled
      && evaluation?.canExecute
      && capability.scope === "mainnet-only"
      && capability.automaticExecution
      && Boolean(capability.executionEndpoint);
  });
}

function firstStrategyBlocker(snapshot: Awaited<ReturnType<typeof getRiskControlSnapshot>>) {
  for (const strategy of Object.keys(STRATEGY_RUNTIME_CAPABILITIES) as RiskStrategy[]) {
    if (!snapshot.state.strategies[strategy]?.enabled) continue;
    const blocker = snapshot.evaluation.strategies[strategy]?.blockers[0];
    if (blocker) return safeCode(blocker);
  }
  return undefined;
}

function normalizeInterval(value: number) {
  return Number.isFinite(value) ? Math.max(MIN_INTERVAL_MS, Math.floor(value)) : FALLBACK_INTERVAL_MS;
}

function responseOutcome(status: unknown): LiveSchedulerOutcome {
  if (["executed", "completed", "recovered", "opened"].includes(String(status))) return "executed";
  if (status === "no-opportunity") return "no-opportunity";
  if (status === "skipped" || status === "not-found") return "no-opportunity";
  if (status === "busy") return "busy";
  if (status === "rejected") return "rejected";
  return "no-opportunity";
}

async function safePayload(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await response.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function errorCode(error: unknown) {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { code?: unknown; blocker?: unknown }).code
    ?? (error as { blocker?: unknown }).blocker;
  return typeof value === "string" ? value : undefined;
}

function safeCode(value: unknown) {
  if (typeof value !== "string") return undefined;
  return value.replace(/[^a-zA-Z0-9_.:-]/g, "-").slice(0, 120) || undefined;
}

function safeDetail(value: unknown) {
  if (typeof value !== "string") return undefined;
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(api[_ -]?key|secret|token)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\b[A-Za-z0-9_-]{36,}={0,2}\b/g, "[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 240) || undefined;
}

function pushEvent(runtime: LiveSchedulerRuntime, event: LiveSchedulerEvent) {
  runtime.events.push(event);
  if (runtime.events.length > MAX_EVENT_COUNT) runtime.events.splice(0, runtime.events.length - MAX_EVENT_COUNT);
  return event;
}
