import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { NextResponse } from "next/server";
import { z } from "zod";
import type { BotSettings } from "@/lib/bot-settings";
import { getBotSettings } from "@/lib/bot-settings-store";
import { config } from "@/lib/config";
import { NobitexClient } from "@/lib/exchanges/nobitex";
import type { NobitexOrder, OrderBook } from "@/lib/exchanges/types";
import {
  acquireStatisticalPairsAssetLock,
  releaseStatisticalPairsAssetLock,
  type StatisticalPairsAssetLock
} from "@/lib/strategies/statistical-pairs-asset-lock";
import {
  acquireExecutionLease,
  acquireRecoveryLease,
  emergencyStopRiskControl,
  evaluateRiskState,
  getRiskState,
  recordRealizedPnl,
  releaseExecutionLease,
  renewExecutionLease
} from "@/lib/risk/store";
import type { ExecutionLease, LeaseAcquisition, RiskEvaluation, RiskState } from "@/lib/risk/types";
import {
  StatisticalPairsExecutionError,
  closeStatisticalPairs,
  createStatisticalPairsExecutionPlan,
  enterStatisticalPairs,
  evaluateStatisticalPairsLifecycle,
  recoverStatisticalPairs,
  type StatisticalPairsCloseResult,
  type StatisticalPairsEntryResult,
  type StatisticalPairsExecutionClient,
  type StatisticalPairsExecutionPlan,
  type StatisticalPairsHooks,
  type StatisticalPairsOpenPosition,
  type StatisticalPairsOrderFill,
  type StatisticalPairsOrderStage,
  type StatisticalPairsRecoveryResult
} from "@/lib/strategies/statistical-pairs-executor";
import {
  calculateStatisticalPairsSnapshot,
  StatisticalPairsMonitorError,
  type StatisticalPairsModelSnapshot
} from "@/lib/strategies/statistical-pairs-monitor";
import {
  deserializeStatisticalPairsPlan,
  deserializeStatisticalPairsPosition,
  serializeStatisticalPairsPlan,
  serializeStatisticalPairsPosition
} from "@/lib/strategies/statistical-pairs-state";
import { scanConfiguredStrategies } from "@/lib/strategies/service";
import type { StrategyLabScanResult, StrategySignal } from "@/lib/strategies/types";
import {
  acquireStrategyExecutionRecordLock,
  releaseStrategyExecutionRecordLock,
  type StrategyExecutionRecordLock
} from "@/lib/strategy-execution-lock";
import {
  addStrategyExecutionOrder,
  completeStrategyExecution,
  createStrategyExecution,
  failStrategyExecution,
  getStrategyExecution,
  listStrategyExecutions,
  StrategyExecutionConflictError,
  transitionStrategyExecution,
  type StrategyExecutionRecord,
  type StrategyExecutionState
} from "@/lib/strategy-execution-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type PairMonitorCacheEntry =
  | { kind: "value"; expiresAt: number; value: StatisticalPairsModelSnapshot }
  | { kind: "error"; expiresAt: number; attempts: number; message: string };
type PairMonitorGlobal = typeof globalThis & { __nobitexPairsMonitorCache?: Map<string, PairMonitorCacheEntry> };

const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("enter"), signalId: z.string().trim().min(1).max(200) }).strict(),
  z.object({
    action: z.literal("close"),
    executionId: z.coerce.number().int().positive(),
    reason: z.enum(["mean-reversion", "stop-loss", "max-holding", "recovery"]).default("recovery")
  }).strict(),
  z.object({ action: z.literal("recover"), executionId: z.coerce.number().int().positive() }).strict(),
  z.object({ action: z.literal("monitor") }).strict()
]);

type PairRequest = z.infer<typeof requestSchema>;
type PairLeaseInput = { strategy: "pairs"; owner: string; ttlMs: number };

export type StatisticalPairsRouteDependencies = {
  apiBase: string;
  getSettings(): Promise<BotSettings>;
  createClient(): StatisticalPairsExecutionClient;
  scanStrategies(books: OrderBook[], settings: BotSettings, client: StatisticalPairsExecutionClient): Promise<StrategyLabScanResult>;
  acquireEntryLease(input: PairLeaseInput): Promise<LeaseAcquisition>;
  acquireRecoveryLease(input: PairLeaseInput): Promise<LeaseAcquisition>;
  renewLease: typeof renewExecutionLease;
  releaseLease: typeof releaseExecutionLease;
  getRiskState: typeof getRiskState;
  evaluateRisk(state: RiskState): RiskEvaluation;
  recordPnl: typeof recordRealizedPnl;
  emergencyStop: typeof emergencyStopRiskControl;
  createExecution: typeof createStrategyExecution;
  transitionExecution: typeof transitionStrategyExecution;
  addOrder: typeof addStrategyExecutionOrder;
  completeExecution: typeof completeStrategyExecution;
  failExecution: typeof failStrategyExecution;
  getExecution: typeof getStrategyExecution;
  listExecutions: typeof listStrategyExecutions;
  acquireRecordLock(executionId: number, owner: string): Promise<StrategyExecutionRecordLock | undefined>;
  releaseRecordLock(lock: StrategyExecutionRecordLock): Promise<boolean>;
  acquireAssetLock(asset: string, executionId: number): Promise<StatisticalPairsAssetLock | undefined>;
  releaseAssetLock(lock: StatisticalPairsAssetLock): Promise<boolean>;
  now(): number;
  enter(
    plan: StatisticalPairsExecutionPlan,
    client: StatisticalPairsExecutionClient,
    hooks: StatisticalPairsHooks
  ): Promise<StatisticalPairsEntryResult>;
  close(
    plan: StatisticalPairsExecutionPlan,
    position: StatisticalPairsOpenPosition,
    reason: StatisticalPairsCloseResult["reason"],
    client: StatisticalPairsExecutionClient,
    hooks: StatisticalPairsHooks
  ): Promise<StatisticalPairsCloseResult>;
  recover(
    plan: StatisticalPairsExecutionPlan,
    input: { marginPositionId?: string | null; confirmedLongAmountBase: Decimal.Value },
    client: StatisticalPairsExecutionClient,
    hooks: StatisticalPairsHooks
  ): Promise<StatisticalPairsRecoveryResult>;
};

const defaultDependencies: StatisticalPairsRouteDependencies = {
  apiBase: config.NOBITEX_API_BASE,
  getSettings: getBotSettings,
  createClient: () => new NobitexClient(),
  scanStrategies: (books, settings, client) => scanConfiguredStrategies(books, settings, client as NobitexClient),
  acquireEntryLease: acquireExecutionLease,
  acquireRecoveryLease,
  renewLease: renewExecutionLease,
  releaseLease: releaseExecutionLease,
  getRiskState,
  evaluateRisk: evaluateRiskState,
  recordPnl: recordRealizedPnl,
  emergencyStop: emergencyStopRiskControl,
  createExecution: createStrategyExecution,
  transitionExecution: transitionStrategyExecution,
  addOrder: addStrategyExecutionOrder,
  completeExecution: completeStrategyExecution,
  failExecution: failStrategyExecution,
  getExecution: getStrategyExecution,
  listExecutions: listStrategyExecutions,
  acquireRecordLock: async (executionId, owner) => {
    const result = await acquireStrategyExecutionRecordLock({ executionId, owner, ttlMs: 600_000 });
    return result.acquired ? result.lock : undefined;
  },
  releaseRecordLock: releaseStrategyExecutionRecordLock,
  acquireAssetLock: acquireStatisticalPairsAssetLock,
  releaseAssetLock: releaseStatisticalPairsAssetLock,
  now: Date.now,
  enter: (plan, client, hooks) => enterStatisticalPairs(plan, client, hooks, { baseUrl: config.NOBITEX_API_BASE }),
  close: (plan, position, reason, client, hooks) => closeStatisticalPairs(plan, position, reason, client, hooks, { baseUrl: config.NOBITEX_API_BASE }),
  recover: (plan, input, client, hooks) => recoverStatisticalPairs(plan, input, client, hooks, { baseUrl: config.NOBITEX_API_BASE })
};

export async function POST(request: Request) {
  return handleStatisticalPairsExecute(request, defaultDependencies);
}

/** Exported for deterministic route tests. Production uses the closed dependency set above. */
export async function handleStatisticalPairsExecute(request: Request, dependencies: StatisticalPairsRouteDependencies) {
  const hostname = safeHostname(dependencies.apiBase);
  if (hostname !== "apiv2.nobitex.ir") {
    return NextResponse.json({
      error: "Statistical Pairs execution requires official Nobitex Mainnet",
      code: "MAINNET_REQUIRED",
      requiredHostname: "apiv2.nobitex.ir"
    }, { status: 423 });
  }
  if (!isDashboardStrategyRequest(request)) {
    return NextResponse.json({ error: "Statistical Pairs execution is accepted only from this dashboard" }, { status: 403 });
  }
  let input: PairRequest;
  try { input = requestSchema.parse(await request.json()); }
  catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Invalid Statistical Pairs action", issues: error.issues }, { status: 400 });
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }
  return input.action === "enter"
    ? handleEntry(input, dependencies)
    : input.action === "monitor"
      ? handleMonitor(dependencies)
      : handleExit(input, dependencies);
}

async function handleEntry(
  input: Extract<PairRequest, { action: "enter" }>,
  dependencies: StatisticalPairsRouteDependencies
) {
  let lease: ExecutionLease | undefined;
  let recordLock: StrategyExecutionRecordLock | undefined;
  let assetLock: StatisticalPairsAssetLock | undefined;
  let executionId: number | undefined;
  let executionState: StrategyExecutionState | undefined;
  try {
    const settings = await dependencies.getSettings();
    const client = dependencies.createClient();
    const books = await client.getAllOrderBooks();
    const scan = await dependencies.scanStrategies(books, settings, client);
    const signal = scan.signals.find(candidate =>
      candidate.id === input.signalId
      && candidate.kind === "statistical-pairs"
      && candidate.status === "actionable"
    );
    if (!signal) {
      return NextResponse.json({ status: "rejected", code: "SIGNAL_NOT_ACTIONABLE", reason: "Fresh server-side Pairs scan no longer permits entry" }, { status: 409 });
    }
    const plan = createPlan(signal, settings);
    const acquisition = await dependencies.acquireEntryLease({
      strategy: "pairs",
      owner: `pairs:entry:${signal.id}:${randomUUID()}`,
      ttlMs: 300_000
    });
    if (!acquisition.acquired) return leaseRejected(acquisition, "entry");
    lease = acquisition.lease;
    const record = await dependencies.createExecution({
      strategy: "pairs",
      signalId: signal.id,
      symbols: [...signal.symbols],
      direction: plan.direction,
      requestedCapitalToman: plan.grossNotionalToman.toNumber(),
      plannedProfitToman: null,
      metadata: {
        pairsPlan: serializeStatisticalPairsPlan(plan),
        environment: "nobitex-mainnet",
        continuousMonitorRequired: true
      }
    });
    executionId = record.id;
    executionState = "DETECTED";
    // The monitor ignores DETECTED/REVALIDATING records. Acquire ownership before
    // the first transition to SUBMITTING so a scan tick can never recover an entry
    // while the same request is still placing it.
    recordLock = await dependencies.acquireRecordLock(executionId, `pairs-entry:${executionId}`);
    if (!recordLock) {
      throw new StatisticalPairsExecutionError("New Pairs execution ownership lock could not be acquired", "ORDER_STATE_UNKNOWN", true);
    }
    assetLock = await dependencies.acquireAssetLock(plan.shortAsset, executionId);
    if (!assetLock) {
      throw new StatisticalPairsExecutionError(
        `Another active Pairs execution already owns short asset ${plan.shortAsset}`,
        "ORDER_FAILED"
      );
    }
    const currentState = () => executionState as StrategyExecutionState | undefined;
    const transition = transitionHelper(dependencies, executionId, currentState, state => { executionState = state; });
    await transition("REVALIDATING", "Fresh Pairs orderbooks, Margin capability and delegation are being revalidated");
    const hooks = executionHooks({ dependencies, client, lease, recordLock, executionId, plan, getState: currentState, setState: state => { executionState = state; } });
    const entry = await dependencies.enter(plan, client, hooks);
    if (entry.status === "recovered") {
      if (currentState() !== "RECOVERING") await transition("RECOVERING", "Entry exposure was automatically flattened", { reason: entry.reason });
      await dependencies.completeExecution(executionId, {
        note: "Pairs entry failed safely and all confirmed exposure was flattened",
        actualOutputToman: null,
        actualProfitToman: null,
        metadata: { resultStatus: "recovered", recoveryReason: entry.reason, pnlRecorded: false }
      });
      executionState = "CLOSED";
      return NextResponse.json({ status: "recovered", executionId, reason: entry.reason, fills: entry.fills.map(serializeFill) });
    }
    const serializedPosition = serializeStatisticalPairsPosition(entry.position);
    if (currentState() !== "HEDGING") {
      await transition("HEDGING", "Both beta-neutral entry legs are confirmed", { openPosition: serializedPosition });
    }
    return NextResponse.json({
      status: "opened",
      executionId,
      signalId: signal.id,
      position: serializedPosition,
      actualHedgeDeviationBps: entry.actualHedgeDeviationBps.toString(),
      fills: entry.fills.map(serializeFill),
      monitoring: { maxHoldingMs: plan.config.maxHoldingMs, exitZScore: plan.config.exitZScore.toString(), stopZScore: plan.config.stopZScore.toString() }
    });
  } catch (error) {
    return executionFailure(error, dependencies, executionId, executionState, "pairs-entry");
  } finally {
    if (lease) await dependencies.releaseLease(lease).catch(() => undefined);
    if (recordLock) await dependencies.releaseRecordLock(recordLock).catch(() => undefined);
    if (assetLock && !["SUBMITTING", "PARTIALLY_FILLED", "HEDGING", "RECOVERING"].includes(executionState ?? "")) {
      await dependencies.releaseAssetLock(assetLock).catch(() => undefined);
    }
  }
}

async function handleExit(
  input: Extract<PairRequest, { action: "close" | "recover" }>,
  dependencies: StatisticalPairsRouteDependencies
) {
  let lease: ExecutionLease | undefined;
  let recordLock: StrategyExecutionRecordLock | undefined;
  let assetLock: StatisticalPairsAssetLock | undefined;
  let record: StrategyExecutionRecord | undefined;
  let executionState: StrategyExecutionState | undefined;
  try {
    record = await dependencies.getExecution(input.executionId);
    executionState = record.state;
    if (record.strategy !== "pairs" || !["SUBMITTING", "PARTIALLY_FILLED", "HEDGING", "RECOVERING"].includes(record.state)) {
      return NextResponse.json({ error: "Execution is not an active recoverable Pairs position", code: "NOT_RECOVERABLE" }, { status: 409 });
    }
    recordLock = await dependencies.acquireRecordLock(record.id, `pairs-${input.action}:${record.id}`);
    if (!recordLock) return NextResponse.json({ status: "busy", code: "EXECUTION_ALREADY_OWNED" }, { status: 409 });
    const plan = deserializeStatisticalPairsPlan(record.metadata.pairsPlan);
    assetLock = await dependencies.acquireAssetLock(plan.shortAsset, record.id);
    if (!assetLock) return NextResponse.json({ error: "Short asset is owned by another active Pairs execution", code: "ASSET_ALREADY_OWNED" }, { status: 409 });
    const acquisition = await dependencies.acquireRecoveryLease({
      strategy: "pairs",
      owner: `pairs:${input.action}:${record.id}:${randomUUID()}`,
      ttlMs: 300_000
    });
    if (!acquisition.acquired) return leaseRejected(acquisition, "recovery");
    lease = acquisition.lease;
    const client = dependencies.createClient();
    if (executionState !== "RECOVERING") {
      await dependencies.transitionExecution(record.id, "RECOVERING", { note: `${input.action} requested for persisted Pairs exposure` });
      executionState = "RECOVERING";
    }
    const hooks = executionHooks({ dependencies, client, lease, recordLock, executionId: record.id, plan, recoveryOnly: true, getState: () => executionState, setState: state => { executionState = state; } });
    let pnl: Decimal | null = null;
    let response: Record<string, unknown>;
    if (input.action === "close") {
      if (!record.metadata.openPosition) {
        return NextResponse.json({ error: "Open Position metadata is incomplete; use action=recover for exchange reconciliation", code: "RECOVERY_REQUIRED" }, { status: 409 });
      }
      const position = deserializeStatisticalPairsPosition(record.metadata.openPosition);
      const closed = await dependencies.close(plan, position, input.reason, client, hooks);
      pnl = closed.estimatedNetPnlToman;
      response = { status: "closed", executionId: record.id, reason: input.reason, pnlToman: pnl.toString(), fills: closed.fills.map(serializeFill) };
    } else {
      const exposure = await reconcilePersistedExposure(record, client);
      const recovered = await dependencies.recover(plan, exposure, client, hooks);
      response = {
        status: "recovered",
        executionId: record.id,
        marginPositionId: recovered.marginPositionId,
        recoveredLongAmountBase: recovered.recoveredLongAmountBase.toString(),
        fills: recovered.fills.map(serializeFill),
        pnlToman: null
      };
    }
    await dependencies.completeExecution(record.id, {
      note: input.action === "close" ? "Persisted Pairs position closed" : "Interrupted Pairs execution reconciled and flattened",
      actualProfitToman: pnl?.toNumber() ?? null,
      metadata: { resultStatus: input.action === "close" ? "closed" : "crash-recovered", pnlRecorded: pnl !== null }
    });
    executionState = "CLOSED";
    if (pnl !== null) {
      await recordPnlOrStop(dependencies, pnl.toNumber(), "pairs-close");
      if (pnl.lt(0)) await dependencies.emergencyStop("pairs-realized-loss-circuit-breaker").catch(() => undefined);
    }
    await dependencies.releaseAssetLock(assetLock);
    assetLock = undefined;
    return NextResponse.json(response);
  } catch (error) {
    return executionFailure(error, dependencies, record?.id, executionState, "pairs-recovery");
  } finally {
    if (lease) await dependencies.releaseLease(lease).catch(() => undefined);
    if (recordLock) await dependencies.releaseRecordLock(recordLock).catch(() => undefined);
  }
}

async function handleMonitor(dependencies: StatisticalPairsRouteDependencies) {
  const states = ["HEDGING", "SUBMITTING", "PARTIALLY_FILLED", "RECOVERING"] as const;
  const records: StrategyExecutionRecord[] = [];
  for (const state of states) {
    const page = await dependencies.listExecutions({ strategy: "pairs", state, limit: 50 });
    records.push(...page.records);
  }
  const unique = [...new Map(records.map(record => [record.id, record])).values()]
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(0, 50);
  if (!unique.length) return NextResponse.json({ status: "idle", checked: 0, results: [] });
  const client = dependencies.createClient();
  const results: Array<Record<string, unknown>> = [];
  for (const record of unique) {
    let recordLock: StrategyExecutionRecordLock | undefined;
    let assetLock: StatisticalPairsAssetLock | undefined;
    let lease: ExecutionLease | undefined;
    let state = record.state;
    try {
      recordLock = await dependencies.acquireRecordLock(record.id, `pairs-monitor:${record.id}`);
      if (!recordLock) {
        results.push({ executionId: record.id, status: "busy" });
        continue;
      }
      const plan = deserializeStatisticalPairsPlan(record.metadata.pairsPlan);
      assetLock = await dependencies.acquireAssetLock(plan.shortAsset, record.id);
      if (!assetLock) {
        results.push({ executionId: record.id, status: "asset-owned-by-another-execution" });
        continue;
      }
      if (record.state === "HEDGING") {
        const open = deserializeStatisticalPairsPosition(record.metadata.openPosition);
        const checkedAt = dependencies.now();
        const margin = await client.getMarginPosition(open.marginPositionId);
        if (margin.base !== plan.shortAsset || margin.quote !== "IRT") {
          throw new StatisticalPairsExecutionError("Monitored Margin Position ownership does not match the persisted plan", "ORDER_STATE_UNKNOWN", true);
        }
        let snapshot: StatisticalPairsModelSnapshot | undefined;
        let lifecycle: ReturnType<typeof evaluateStatisticalPairsLifecycle>;
        if (checkedAt - open.openedAt >= plan.config.maxHoldingMs) {
          lifecycle = { action: "EXIT_MAX_HOLDING", reason: "Maximum holding time was reached" };
        } else if (["closed", "liquidated", "expired"].includes(margin.status.toLowerCase())) {
          lifecycle = { action: "EXIT_STOP", reason: `Margin Position became ${margin.status}; unwind Spot inventory immediately` };
        } else if (margin.status.toLowerCase() !== "open") {
          lifecycle = { action: "EXIT_STOP", reason: `Margin Position is ${margin.status}; reconcile before keeping Spot inventory` };
        } else if (margin.marginRatio.lte(0) || margin.markPrice.lte(0) || margin.liquidationPrice.lte(0)) {
          lifecycle = { action: "EXIT_STOP", reason: "Margin health metrics are missing or non-positive" };
        } else if (margin.marginRatio.lte(plan.config.minMarginRatio)) {
          lifecycle = { action: "EXIT_STOP", reason: "Margin ratio reached the configured safety floor" };
        } else if (liquidationBufferBps(margin).lte(plan.config.minLiquidationBufferBps)) {
          lifecycle = { action: "EXIT_STOP", reason: "Margin mark price is too close to liquidation" };
        } else {
          snapshot = await loadMonitorSnapshot(plan, client, checkedAt);
          assertMonitorCandleFresh(plan, snapshot.latestTimestamp, checkedAt);
          lifecycle = snapshot.betaDriftBps.gte(plan.config.maxBetaDriftBps)
            ? { action: "EXIT_STOP", reason: "Rolling hedge beta drift exceeded the persisted model limit" }
            : evaluateStatisticalPairsLifecycle(plan, snapshot.zScore, open.openedAt, checkedAt);
        }
        if (lifecycle.action === "HOLD") {
          results.push({
            executionId: record.id,
            status: "holding",
            zScore: snapshot?.zScore.toString(),
            beta: snapshot?.beta.toString(),
            betaDriftBps: snapshot?.betaDriftBps.toString(),
            sampleCount: snapshot?.sampleCount,
            marginRatio: margin.marginRatio.toString(),
            liquidationBufferBps: liquidationBufferBps(margin).toString()
          });
          continue;
        }
        const acquisition = await dependencies.acquireRecoveryLease({
          strategy: "pairs", owner: `pairs:monitor-close:${record.id}:${randomUUID()}`, ttlMs: 300_000
        });
        if (!acquisition.acquired) {
          results.push({ executionId: record.id, status: "capacity-blocked", blockers: acquisition.blockers });
          continue;
        }
        lease = acquisition.lease;
        await dependencies.transitionExecution(record.id, "RECOVERING", {
          note: lifecycle.reason,
          metadata: {
            monitorDecision: lifecycle.action,
            monitorZScore: snapshot?.zScore.toString() ?? null,
            monitorBeta: snapshot?.beta.toString() ?? null,
            monitorBetaDriftBps: snapshot?.betaDriftBps.toString() ?? null,
            monitorMarginStatus: margin.status,
            monitorMarginRatio: margin.marginRatio.toString()
          }
        });
        state = "RECOVERING";
        const hooks = executionHooks({
          dependencies, client, lease, recordLock, executionId: record.id, plan, recoveryOnly: true,
          getState: () => state, setState: next => { state = next; }
        });
        const reason: StatisticalPairsCloseResult["reason"] = lifecycle.action === "EXIT_MEAN"
          ? "mean-reversion"
          : lifecycle.action === "EXIT_MAX_HOLDING" ? "max-holding" : "stop-loss";
        const closed = await dependencies.close(plan, open, reason, client, hooks);
        await dependencies.completeExecution(record.id, {
          note: `Server Pairs monitor closed the position: ${lifecycle.reason}`,
          actualOutputToman: closed.spotOutputToman.toNumber(),
          actualProfitToman: closed.estimatedNetPnlToman.toNumber(),
          metadata: { resultStatus: "monitor-closed", monitorDecision: lifecycle.action, pnlRecorded: true }
        });
        state = "CLOSED";
        await recordPnlOrStop(dependencies, closed.estimatedNetPnlToman.toNumber(), "pairs-monitor-close");
        if (closed.estimatedNetPnlToman.lt(0)) await dependencies.emergencyStop("pairs-realized-loss-circuit-breaker").catch(() => undefined);
        await dependencies.releaseAssetLock(assetLock);
        assetLock = undefined;
        results.push({
          executionId: record.id,
          status: "closed",
          reason,
          zScore: snapshot?.zScore.toString() ?? null,
          betaDriftBps: snapshot?.betaDriftBps.toString() ?? null,
          pnlToman: closed.estimatedNetPnlToman.toString()
        });
      } else {
        const plan = deserializeStatisticalPairsPlan(record.metadata.pairsPlan);
        const acquisition = await dependencies.acquireRecoveryLease({
          strategy: "pairs", owner: `pairs:monitor-recover:${record.id}:${randomUUID()}`, ttlMs: 300_000
        });
        if (!acquisition.acquired) {
          results.push({ executionId: record.id, status: "capacity-blocked", blockers: acquisition.blockers });
          continue;
        }
        lease = acquisition.lease;
        if (state !== "RECOVERING") {
          await dependencies.transitionExecution(record.id, "RECOVERING", { note: "Server monitor found an interrupted Pairs execution" });
          state = "RECOVERING";
        }
        const hooks = executionHooks({
          dependencies, client, lease, recordLock, executionId: record.id, plan, recoveryOnly: true,
          getState: () => state, setState: next => { state = next; }
        });
        const exposure = await reconcilePersistedExposure(record, client);
        const recovered = await dependencies.recover(plan, exposure, client, hooks);
        await dependencies.completeExecution(record.id, {
          note: "Server monitor reconciled an interrupted Pairs request and confirmed flat exposure",
          actualProfitToman: null,
          metadata: { resultStatus: "monitor-crash-recovered", pnlRecorded: false }
        });
        state = "CLOSED";
        await dependencies.releaseAssetLock(assetLock);
        assetLock = undefined;
        results.push({
          executionId: record.id,
          status: "recovered",
          marginPositionId: recovered.marginPositionId,
          recoveredLongAmountBase: recovered.recoveredLongAmountBase.toString()
        });
      }
    } catch (error) {
      const manual = error instanceof StatisticalPairsExecutionError && error.manualInterventionRequired;
      const message = error instanceof Error ? error.message : "Pairs monitor failed";
      if (manual) {
        if (state !== "RECOVERING") {
          await dependencies.transitionExecution(record.id, "RECOVERING", {
            note: "Pairs monitor requires manual reconciliation",
            metadata: { manualInterventionRequired: true, monitorFailure: true, error: message }
          }).catch(() => undefined);
          state = "RECOVERING";
        }
        await dependencies.emergencyStop(`pairs-monitor-manual:${record.id}:${message}`).catch(() => undefined);
      } else {
        // Preserve HEDGING so the next tick retries. New entries are stopped until
        // the operator resets Risk Control, but a transient candle outage does not
        // erase ownership of an open Position.
        await dependencies.emergencyStop(`pairs-monitor-unavailable:${record.id}:${message}`).catch(() => undefined);
      }
      results.push({
        executionId: record.id,
        status: manual ? "manual-recovery-required" : "monitor-error-retryable",
        error: message,
        code: error instanceof StatisticalPairsExecutionError || error instanceof StatisticalPairsMonitorError ? error.code : "MONITOR_FAILED"
      });
    } finally {
      if (lease) await dependencies.releaseLease(lease).catch(() => undefined);
      if (recordLock) await dependencies.releaseRecordLock(recordLock).catch(() => undefined);
    }
  }
  return NextResponse.json({
    status: results.some(item => item.status === "manual-recovery-required") ? "attention-required" : "checked",
    checked: results.length,
    results
  });
}

function createPlan(signal: StrategySignal, settings: BotSettings) {
  const pair = settings.strategyLab.pairs;
  return createStatisticalPairsExecutionPlan(signal, {
    grossNotionalToman: pair.notionalToman,
    leverage: pair.leverage,
    takerFeeBps: settings.tomanTakerFeeBps,
    slippageBps: settings.slippageBufferBps,
    maxEntrySpreadBps: pair.maxEntrySpreadBps,
    maxPriceImpactBps: pair.maxPriceImpactBps,
    depthUsagePercent: settings.orderbookDepthUsagePercent,
    hedgeToleranceBps: pair.hedgeToleranceBps,
    maxBetaDriftBps: pair.maxBetaDriftBps,
    minMarginRatio: pair.minMarginRatio,
    minLiquidationBufferBps: pair.minLiquidationBufferBps,
    maxAgeMs: settings.orderbookMaxAgeMs,
    orderTimeoutMs: pair.orderTimeoutMs,
    maxHoldingMinutes: pair.maxHoldingMinutes,
    exitZScore: pair.exitZScore,
    stopZScore: pair.maxZScore,
    resolution: pair.resolution,
    lookback: pair.lookback
  });
}

function executionHooks(input: {
  dependencies: StatisticalPairsRouteDependencies;
  client: StatisticalPairsExecutionClient;
  lease: ExecutionLease;
  recordLock: StrategyExecutionRecordLock;
  executionId: number;
  plan: StatisticalPairsExecutionPlan;
  recoveryOnly?: boolean;
  getState(): StrategyExecutionState | undefined;
  setState(state: StrategyExecutionState): void;
}): StatisticalPairsHooks {
  const legIndex: Record<StatisticalPairsOrderStage, number> = { "margin-short": 0, "spot-long": 1, "margin-close": 2, "spot-close": 3 };
  const transition = transitionHelper(input.dependencies, input.executionId, input.getState, input.setState);
  return {
    onBeforeOrder: async event => {
      if (!await input.dependencies.renewLease(input.lease, 300_000)) {
        throw new StatisticalPairsExecutionError("Pairs lease ownership was lost", "ORDER_STATE_UNKNOWN", true);
      }
      const reducing = event.stage === "margin-close" || event.stage === "spot-close";
      if (input.recoveryOnly && !reducing) {
        throw new StatisticalPairsExecutionError("Recovery lease cannot submit an exposure-increasing order", "INVALID_PLAN", true);
      }
      if (!reducing) {
        const state = await input.dependencies.getRiskState();
        const blockers = input.dependencies.evaluateRisk(state).strategies.pairs.blockers;
        if (blockers.length) throw new StatisticalPairsExecutionError(`Pairs Risk Control changed: ${blockers.join(", ")}`, "ORDER_FAILED");
      }
      if (input.getState() === "REVALIDATING") await transition("SUBMITTING", "Pairs orders are being submitted");
      try {
        await input.dependencies.addOrder(input.executionId, {
          legIndex: legIndex[event.stage], symbol: event.symbol, side: event.side,
          orderType: event.stage.startsWith("margin") ? "MARGIN_MARKET" : "SPOT_MARKET",
          status: "submitting", clientOrderId: event.clientOrderId,
          requestedAmount: event.amountBase.toString(),
          inputAsset: event.side === "BUY" ? "IRT" : event.symbol.replace(/IRT$/, ""),
          outputAsset: event.side === "BUY" ? event.symbol.replace(/IRT$/, "") : "IRT",
          raw: { event: "before-submit", stage: event.stage, expectedPriceToman: event.expectedPrice.toString() }
        });
      } catch (error) {
        if (!reducing) throw error;
        // Audit failure must stop new entries, but must never block a confirmed
        // risk-reducing close that already owns both locks.
        await input.dependencies.emergencyStop(`pairs-recovery-audit-failed:${input.executionId}`).catch(() => undefined);
      }
    },
    onOrderSubmitted: async event => {
      try {
        await input.dependencies.addOrder(input.executionId, {
          legIndex: legIndex[event.stage], symbol: event.symbol, side: event.side,
          orderType: `${event.tradeType}_MARKET`, status: event.order.status,
          clientOrderId: event.clientOrderId,
          exchangeOrderId: event.order.id, requestedAmount: event.requestedAmountBase.toString(),
          filledAmount: event.order.matchedAmount.toString(), averagePrice: event.order.averagePrice.div(10).toString(),
          fee: (event.side === "SELL" ? event.order.fee.div(10) : event.order.fee).toString(),
          raw: { event: "accepted", stage: event.stage, exchange: event.order.raw }
        });
      } catch {
        await input.dependencies.emergencyStop(`pairs-order-id-persistence-failed:${input.executionId}`).catch(() => undefined);
      }
    },
    onOrderRejected: async event => {
      try {
        await input.dependencies.addOrder(input.executionId, {
          legIndex: legIndex[event.stage], symbol: event.symbol, side: event.side,
          orderType: event.stage === "margin-short" ? "MARGIN_MARKET" : "SPOT_MARKET",
          status: "rejected-definitive",
          inputAsset: event.side === "BUY" ? "IRT" : event.symbol.replace(/IRT$/, ""),
          outputAsset: event.side === "BUY" ? event.symbol.replace(/IRT$/, "") : "IRT",
          raw: { event: "definitive-rejection", stage: event.stage, reason: event.reason }
        });
      } catch {
        await input.dependencies.emergencyStop(`pairs-rejection-persistence-failed:${input.executionId}`).catch(() => undefined);
      }
    },
    onOrderFinalized: async ({ fill }) => {
      try {
        await input.dependencies.addOrder(input.executionId, {
          legIndex: legIndex[fill.stage], symbol: fill.symbol, side: fill.side,
          orderType: `${fill.tradeType}_MARKET`, status: fill.status,
          exchangeOrderId: fill.orderId, requestedAmount: fill.requestedAmountBase.toString(),
          filledAmount: fill.matchedAmountBase.toString(), averagePrice: fill.averagePriceToman.toString(),
          fee: fill.fee.toString(), raw: { event: "finalized", stage: fill.stage, fullFill: fill.fullFill, exchange: fill.raw }
        });
      } catch {
        await input.dependencies.emergencyStop(`pairs-fill-persistence-failed:${input.executionId}`).catch(() => undefined);
      }
      if (!fill.fullFill && fill.stage !== "margin-short" && input.getState() === "SUBMITTING") {
        await transition("PARTIALLY_FILLED", `${fill.stage} partially filled`);
      }
    },
    onMarginPositionDiscovered: async ({ position }) => {
      if (input.getState() === "SUBMITTING") {
        await transition("PARTIALLY_FILLED", "Margin short Position is owned; Spot hedge is not confirmed yet", {
          marginPositionId: position.id,
          marginShortAsset: position.base,
          marginLiability: position.liability.toString()
        });
      }
    },
    onPositionOpened: async ({ position }) => {
      if (input.getState() === "SUBMITTING" || input.getState() === "PARTIALLY_FILLED") {
        await transition("HEDGING", "Both Pairs legs and Margin Position are confirmed", { openPosition: serializeStatisticalPairsPosition(position) });
      }
    },
    onRecoveryStarted: async ({ reason }) => {
      if (input.getState() !== "RECOVERING") await transition("RECOVERING", "Automatic Pairs recovery started", { reason });
    }
  };
}

async function reconcilePersistedExposure(record: StrategyExecutionRecord, client: StatisticalPairsExecutionClient) {
  const persistedPosition = record.metadata.openPosition
    ? deserializeStatisticalPairsPosition(record.metadata.openPosition)
    : undefined;
  const marginPositionId = persistedPosition?.marginPositionId
    ?? (typeof record.metadata.marginPositionId === "string" && /^\d+$/.test(record.metadata.marginPositionId)
      ? record.metadata.marginPositionId
      : null);

  const rowsForLeg = (legIndex: number) => record.orders.filter(order => order.legIndex === legIndex);
  const acceptedForLeg = (legIndex: number) => [...new Map(
    rowsForLeg(legIndex)
      .filter(order => order.exchangeOrderId)
      .map(order => [order.exchangeOrderId!, order])
  ).values()];
  const definitiveRejectionsForLeg = (legIndex: number) => rowsForLeg(legIndex)
    .filter(order => order.status === "rejected-definitive").length;
  const unresolvedBeforeCount = (legIndex: number) => Math.max(
    0,
    rowsForLeg(legIndex).filter(order => order.status === "submitting").length
      - acceptedForLeg(legIndex).length
      - definitiveRejectionsForLeg(legIndex)
  );

  const resolveSpotLeg = async (legIndex: 1 | 3) => {
    const accepted = acceptedForLeg(legIndex);
    let unresolved = unresolvedBeforeCount(legIndex);
    if (unresolved <= 0) return { accepted, unresolved: 0 };
    if (!client.getOrderStatusByClientOrderId) return { accepted, unresolved };

    const acceptedClientIds = new Set(
      accepted.map(row => row.clientOrderId).filter((value): value is string => Boolean(value))
    );
    const intents = rowsForLeg(legIndex).filter(row =>
      row.status === "submitting"
      && row.clientOrderId
      && !acceptedClientIds.has(row.clientOrderId)
    );
    for (const intent of intents) {
      if (unresolved <= 0) break;
      let resolved: NobitexOrder;
      try { resolved = await client.getOrderStatusByClientOrderId(intent.clientOrderId!); }
      catch (error) {
        throw new StatisticalPairsExecutionError(
          `Persisted Spot clientOrderId ${intent.clientOrderId} cannot be reconciled`,
          "ORDER_STATE_UNKNOWN",
          true,
          { cause: error }
        );
      }
      if (!resolved.id) {
        throw new StatisticalPairsExecutionError(`Spot clientOrderId ${intent.clientOrderId} returned no exchange order id`, "ORDER_STATE_UNKNOWN", true);
      }
      accepted.push({ ...intent, exchangeOrderId: resolved.id });
      acceptedClientIds.add(intent.clientOrderId!);
      unresolved -= 1;
    }
    return {
      accepted: [...new Map(accepted.map(row => [row.exchangeOrderId!, row])).values()],
      unresolved
    };
  };

  const spotLongLeg = await resolveSpotLeg(1);
  const spotCloseLeg = await resolveSpotLeg(3);

  // A Spot SELL without an exchange id can already have consumed inventory. Any
  // retry would risk a double-sell, so it is always manual. A Spot BUY before-only
  // is safe only when the subsequently persisted openPosition proves its fill.
  if (spotCloseLeg.unresolved > 0 || (spotLongLeg.unresolved > 0 && !persistedPosition)) {
    throw new StatisticalPairsExecutionError(
      "A persisted Spot submit has no exchange order id; net wallet exposure cannot be reconstructed safely",
      "ORDER_STATE_UNKNOWN",
      true
    );
  }

  const shortOrders = acceptedForLeg(0);
  const shortFinals = await Promise.all(shortOrders.map(row => reconcilePersistedOrder(row.exchangeOrderId!, client)));
  const confirmedShortFill = shortFinals.reduce((sum, order) => sum.plus(order.matchedAmount), new Decimal(0));
  if (!marginPositionId && (confirmedShortFill.gt(0) || unresolvedBeforeCount(0) > 0)) {
    throw new StatisticalPairsExecutionError(
      "Margin short exposure exists without a persisted Position id; an asset-wide guess is forbidden",
      "ORDER_STATE_UNKNOWN",
      true
    );
  }
  await Promise.all(acceptedForLeg(2).map(row => reconcilePersistedOrder(row.exchangeOrderId!, client)));
  if (unresolvedBeforeCount(2) > 0) {
    if (!marginPositionId) {
      throw new StatisticalPairsExecutionError("Margin close intent has no Position ownership id", "ORDER_STATE_UNKNOWN", true);
    }
    const position = await client.getMarginPosition(marginPositionId).catch(error => {
      throw new StatisticalPairsExecutionError("Margin close intent cannot be reconciled", "ORDER_STATE_UNKNOWN", true, { cause: error });
    });
    if (!["closed", "liquidated", "expired"].includes(position.status.toLowerCase())) {
      throw new StatisticalPairsExecutionError(
        "Margin close may have been submitted without a persisted order id; duplicate close is forbidden",
        "ORDER_STATE_UNKNOWN",
        true
      );
    }
  }

  const buyFinals = await Promise.all(spotLongLeg.accepted.map(row => reconcilePersistedOrder(row.exchangeOrderId!, client)));
  const sellFinals = await Promise.all(spotCloseLeg.accepted.map(row => reconcilePersistedOrder(row.exchangeOrderId!, client)));
  let confirmedLong = persistedPosition
    ? persistedPosition.longAmountBase
    : buyFinals.reduce((sum, order) => sum.plus(Decimal.max(order.matchedAmount.minus(order.fee), 0)), new Decimal(0));
  const confirmedSold = sellFinals.reduce((sum, order) => sum.plus(order.matchedAmount), new Decimal(0));
  confirmedLong = confirmedLong.minus(confirmedSold);
  if (confirmedLong.lt(0)) {
    throw new StatisticalPairsExecutionError(
      "Persisted Spot SELL fills exceed confirmed BUY inventory; automatic recovery would increase a short exposure",
      "ORDER_STATE_UNKNOWN",
      true
    );
  }
  return { marginPositionId, confirmedLongAmountBase: confirmedLong };
}

async function reconcilePersistedOrder(orderId: string, client: StatisticalPairsExecutionClient): Promise<NobitexOrder> {
  let order = await client.getOrderStatus(orderId).catch(error => {
    throw new StatisticalPairsExecutionError(`Persisted order ${orderId} cannot be reconciled`, "ORDER_STATE_UNKNOWN", true, { cause: error });
  });
  if (!isTerminalOrder(order.status)) {
    await client.cancelOrder(order.id).catch(error => {
      throw new StatisticalPairsExecutionError(`Persisted order ${orderId} cancellation is ambiguous`, "ORDER_STATE_UNKNOWN", true, { cause: error });
    });
    order = await client.getOrderStatus(order.id).catch(error => {
      throw new StatisticalPairsExecutionError(`Persisted order ${orderId} final state is unknown`, "ORDER_STATE_UNKNOWN", true, { cause: error });
    });
    if (!isTerminalOrder(order.status)) {
      throw new StatisticalPairsExecutionError(`Persisted order ${orderId} remained active after cancellation`, "ORDER_STATE_UNKNOWN", true);
    }
  }
  return order;
}

async function executionFailure(
  error: unknown,
  dependencies: StatisticalPairsRouteDependencies,
  executionId: number | undefined,
  state: StrategyExecutionState | undefined,
  prefix: string
) {
  const message = error instanceof Error ? error.message : "Statistical Pairs execution failed";
  const manual = error instanceof StatisticalPairsExecutionError && error.manualInterventionRequired;
  const exposureMayExist = state !== undefined && ["SUBMITTING", "PARTIALLY_FILLED", "HEDGING", "RECOVERING"].includes(state);
  if (executionId !== undefined && state !== "CLOSED" && state !== "FAILED_MANUAL") {
    if (exposureMayExist) {
      if (state !== "RECOVERING") {
        await dependencies.transitionExecution(executionId, "RECOVERING", {
          note: "Execution failed after exposure may have started; recovery ownership is preserved",
          metadata: { manualInterventionRequired: manual, error: message }
        }).catch(() => undefined);
      }
    } else {
      await dependencies.failExecution(executionId, message, { metadata: { manualInterventionRequired: manual } }).catch(() => undefined);
    }
  }
  if (manual || exposureMayExist) await dependencies.emergencyStop(`${prefix}:${message}`).catch(() => undefined);
  const status = error instanceof StatisticalPairsExecutionError
    ? error.code === "MAINNET_REQUIRED" ? 423
      : ["INVALID_PLAN"].includes(error.code) ? 400
        : ["SHORT_UNSUPPORTED", "REVALIDATION_FAILED"].includes(error.code) ? 409
          : 502
    : error instanceof StrategyExecutionConflictError ? 409
      : error instanceof z.ZodError ? 409 : 500;
  return NextResponse.json({
    error: message,
    code: error instanceof StatisticalPairsExecutionError ? error.code
      : error instanceof StrategyExecutionConflictError ? error.code : "STATISTICAL_PAIRS_EXECUTION_FAILED",
    executionId,
    existingExecutionId: error instanceof StrategyExecutionConflictError ? error.existingExecutionId : undefined,
    manualInterventionRequired: manual || exposureMayExist,
    recoveryAvailable: exposureMayExist
  }, { status });
}

function transitionHelper(
  dependencies: StatisticalPairsRouteDependencies,
  executionId: number,
  getState: () => StrategyExecutionState | undefined,
  setState: (state: StrategyExecutionState) => void
) {
  return async (to: StrategyExecutionState, note: string, metadata?: Record<string, unknown>) => {
    if (getState() === to) return;
    await dependencies.transitionExecution(executionId, to, { note, metadata });
    setState(to);
  };
}

async function recordPnlOrStop(
  dependencies: Pick<StatisticalPairsRouteDependencies, "recordPnl" | "emergencyStop">,
  pnlToman: number,
  context: string
) {
  try {
    await dependencies.recordPnl(pnlToman);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown-risk-accounting-error";
    await dependencies.emergencyStop(`${context}-risk-accounting-failed:${message}`).catch(() => undefined);
    throw error;
  }
}

function leaseRejected(acquisition: Extract<LeaseAcquisition, { acquired: false }>, operation: string) {
  return NextResponse.json({
    error: `Statistical Pairs ${operation} lease was not acquired`,
    code: acquisition.reason === "risk-blocked" ? "RISK_BLOCKED" : "CAPACITY_REACHED",
    blockers: acquisition.blockers
  }, { status: acquisition.reason === "risk-blocked" ? 423 : 409 });
}

function serializeFill(fill: StatisticalPairsOrderFill) {
  return {
    ...fill,
    requestedAmountBase: fill.requestedAmountBase.toString(),
    matchedAmountBase: fill.matchedAmountBase.toString(),
    unmatchedAmountBase: fill.unmatchedAmountBase.toString(),
    averagePriceToman: fill.averagePriceToman.toString(),
    totalToman: fill.totalToman.toString(),
    fee: fill.fee.toString()
  };
}

function isDashboardStrategyRequest(request: Request) {
  if (request.headers.get("x-strategy-action") !== "nobitex-dashboard") return false;
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try { return new URL(origin).host.toLowerCase() === host.toLowerCase(); } catch { return false; }
}

function isTerminalOrder(status: string) {
  return ["done", "canceled", "cancelled", "rejected", "failed"].includes(status.toLowerCase());
}

function assertMonitorCandleFresh(plan: StatisticalPairsExecutionPlan, timestamp: number, now: number) {
  const timestampMs = timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp;
  const resolutionMs = plan.config.resolution === "D"
    ? 86_400_000
    : Number(plan.config.resolution) * 60_000;
  if (!Number.isFinite(timestampMs) || timestampMs <= 0 || timestampMs > now + 5 * 60_000 || now - timestampMs > resolutionMs * 3 + 5 * 60_000) {
    throw new StatisticalPairsMonitorError("Latest aligned Pairs candle is stale or timestamp-invalid", "CANDLES_UNAVAILABLE");
  }
}

async function loadMonitorSnapshot(
  plan: StatisticalPairsExecutionPlan,
  client: StatisticalPairsExecutionClient,
  now: number
) {
  if (!client.getCandles) throw new StatisticalPairsMonitorError("Exchange adapter cannot load Pairs candles", "CANDLES_UNAVAILABLE");
  const root = globalThis as PairMonitorGlobal;
  root.__nobitexPairsMonitorCache ??= new Map();
  const cache = root.__nobitexPairsMonitorCache;
  const key = `${plan.id}:${plan.config.resolution}:${plan.config.lookback}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    if (cached.kind === "value") return cached.value;
    throw new StatisticalPairsMonitorError(`OHLC monitor backoff: ${cached.message}`, "CANDLES_UNAVAILABLE");
  }
  try {
    const [seriesA, seriesB] = await Promise.all([
      client.getCandles(`${plan.assetA}IRT`, plan.config.resolution, plan.config.lookback),
      client.getCandles(`${plan.assetB}IRT`, plan.config.resolution, plan.config.lookback)
    ]);
    const value = calculateStatisticalPairsSnapshot(plan, seriesA, seriesB, now);
    // Risk checks run every supervisor tick, while the heavier OHLC regression is
    // refreshed at most once per minute and only sooner after cache expiry.
    cache.set(key, { kind: "value", expiresAt: now + 60_000, value });
    return value;
  } catch (error) {
    const attempts = cached?.kind === "error" ? cached.attempts + 1 : 1;
    const delay = Math.min(60_000, 5_000 * 2 ** Math.min(attempts - 1, 4));
    const message = error instanceof Error ? error.message : "OHLC request failed";
    cache.set(key, { kind: "error", expiresAt: now + delay, attempts, message });
    throw error;
  }
}

function liquidationBufferBps(position: Awaited<ReturnType<StatisticalPairsExecutionClient["getMarginPosition"]>>) {
  if (position.markPrice.lte(0) || position.liquidationPrice.lte(0)) return new Decimal(-1);
  return position.liquidationPrice.div(position.markPrice).minus(1).mul(10_000);
}

function safeHostname(value: string) {
  try { return new URL(value).hostname.toLowerCase(); } catch { return ""; }
}
