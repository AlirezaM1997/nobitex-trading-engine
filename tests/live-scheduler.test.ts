import { describe, expect, test } from "bun:test";
import Decimal from "decimal.js";
import {
  createLiveSchedulerRuntime,
  runLiveSchedulerTick,
  type LiveSchedulerDependencies
} from "@/lib/runtime/live-scheduler";
import { defaultAiAgentSettings } from "@/lib/ai-agent/settings";

function dependencies(overrides: Partial<LiveSchedulerDependencies> = {}): LiveSchedulerDependencies {
  return {
    isProduction: () => true,
    now: () => 1_000,
    getSettings: async () => ({ scanIntervalMs: 1_000 }),
    getRiskSnapshot: async () => ({
      state: {
        masterArmed: true,
        strategies: { triangle: { enabled: true } }
      },
      evaluation: {
        strategies: { triangle: { canExecute: true, blockers: [] } }
      }
    } as never),
    getOwnerStatus: async () => ({
      heldByThisProcess: true,
      locked: true,
      accountFingerprint: "test",
      pid: 1,
      buildId: "test",
      acquiredAt: new Date(0).toISOString(),
      heartbeatAt: new Date(0).toISOString(),
      stale: false
    }),
    assertOwner: async () => true,
    executeTriangle: async () => Response.json({ status: "no-opportunity" }),
    ...overrides
  };
}

describe("production Live scheduler", () => {
  test("never delegates outside production", async () => {
    let delegated = 0;
    const runtime = createLiveSchedulerRuntime(0);
    const event = await runLiveSchedulerTick(runtime, dependencies({
      isProduction: () => false,
      executeTriangle: async () => { delegated += 1; return Response.json({ status: "executed" }); }
    }));
    expect(event.outcome).toBe("not-production");
    expect(delegated).toBe(0);
  });

  test("does not acquire or delegate while Master Live is disarmed", async () => {
    let ownerChecks = 0;
    let delegated = 0;
    const runtime = createLiveSchedulerRuntime(0);
    const event = await runLiveSchedulerTick(runtime, dependencies({
      getRiskSnapshot: async () => ({
        state: { masterArmed: false, strategies: { triangle: { enabled: true } } },
        evaluation: { strategies: { triangle: { canExecute: false, blockers: ["master-not-armed"] } } }
      } as never),
      getOwnerStatus: async () => { ownerChecks += 1; throw new Error("must not be called"); },
      executeTriangle: async () => { delegated += 1; return Response.json({ status: "executed" }); }
    }));
    expect(event.outcome).toBe("master-disarmed");
    expect(ownerChecks).toBe(0);
    expect(delegated).toBe(0);
  });

  test("single-flight fence rejects a concurrent tick", async () => {
    let release!: () => void;
    let delegated = 0;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const runtime = createLiveSchedulerRuntime(0);
    const deps = dependencies({
      executeTriangle: async () => {
        delegated += 1;
        await pending;
        return Response.json({ status: "no-opportunity" });
      }
    });

    const first = runLiveSchedulerTick(runtime, deps);
    const second = await runLiveSchedulerTick(runtime, deps);
    expect(second.outcome).toBe("in-flight");
    expect(delegated).toBe(0);
    release();
    expect((await first).outcome).toBe("no-opportunity");
    expect(delegated).toBe(1);
    expect(runtime.inFlightToken).toBeNull();
  });

  test("loads interval, validates owner, and delegates an internal Triangle request", async () => {
    let request: Request | undefined;
    let ownerAssertions = 0;
    const runtime = createLiveSchedulerRuntime(0);
    const event = await runLiveSchedulerTick(runtime, dependencies({
      getSettings: async () => ({ scanIntervalMs: 250 }),
      assertOwner: async () => { ownerAssertions += 1; },
      executeTriangle: async value => {
        request = value;
        return Response.json({ status: "executed", executionId: 9 });
      }
    }));

    expect(event.outcome).toBe("executed");
    expect(runtime.intervalMs).toBe(1_000);
    expect(ownerAssertions).toBe(1);
    expect(request?.headers.get("x-live-action")).toBe("nobitex-dashboard");
    expect(request?.headers.get("origin")).toBe("http://nobitex-internal");
    expect(await request?.json()).toEqual({});
  });

  test("delegates the best actionable signal when a non-Triangle engine is runnable", async () => {
    let triangleCalls = 0;
    let delegated: { kind: string; signalId: string } | undefined;
    const runtime = createLiveSchedulerRuntime(0);
    const event = await runLiveSchedulerTick(runtime, dependencies({
      getRiskSnapshot: async () => ({
        state: {
          masterArmed: true,
          strategies: {
            triangle: { enabled: false },
            gapTrading: { enabled: false },
            imbalance: { enabled: true }
          }
        },
        evaluation: {
          strategies: {
            triangle: { canExecute: false, blockers: ["strategy-disabled"] },
            gapTrading: { canExecute: false, blockers: ["strategy-disabled"] },
            imbalance: { canExecute: true, blockers: [] }
          }
        }
      } as never),
      executeTriangle: async () => {
        triangleCalls += 1;
        return Response.json({ status: "executed" });
      },
      discoverStrategySignals: async () => [
        {
          id: "gap:ignored:ask:1",
          kind: "orderbook-gap",
          title: "ignored",
          symbols: ["BTCIRT"],
          action: "ignored",
          status: "actionable",
          paperOnly: true,
          expectedEdgeBps: new Decimal(500),
          estimatedNetProfitToman: new Decimal(50_000),
          confidence: new Decimal(90),
          reasons: [],
          metrics: {},
          scannedAt: 1_000
        },
        {
          id: "imbalance:BTCIRT",
          kind: "orderbook-imbalance",
          title: "imbalance",
          symbols: ["BTCIRT"],
          action: "buy",
          status: "actionable",
          paperOnly: true,
          expectedEdgeBps: new Decimal(100),
          estimatedNetProfitToman: new Decimal(10_000),
          confidence: new Decimal(80),
          reasons: [],
          metrics: {},
          scannedAt: 1_000
        }
      ],
      executeStrategy: async (kind, signalId) => {
        delegated = { kind, signalId };
        return Response.json({ status: "completed", executionId: 12 });
      }
    }));

    expect(event).toMatchObject({ outcome: "executed", strategy: "imbalance", httpStatus: 200 });
    expect(triangleCalls).toBe(0);
    expect(delegated).toEqual({ kind: "orderbook-imbalance", signalId: "imbalance:BTCIRT" });
  });

  test("AI Demo mode never suppresses an independently enabled Imbalance engine", async () => {
    let delegated = 0;
    let selected = 0;
    const runtime = createLiveSchedulerRuntime(0);
    const event = await runLiveSchedulerTick(runtime, dependencies({
      getSettings: async () => ({
        scanIntervalMs: 1_000,
        aiAgent: { ...defaultAiAgentSettings, enabled: true, mode: "demo" }
      }),
      getRiskSnapshot: nonTriangleRisk,
      discoverStrategySignals: async () => [strategySignal("imbalance:BTCIRT", "orderbook-imbalance", 100)],
      selectAiCandidate: async () => { selected += 1; return { blockers: [] }; },
      executeStrategy: async () => { delegated += 1; return Response.json({ status: "completed" }); }
    }));

    expect(event).toMatchObject({ outcome: "executed", strategy: "imbalance" });
    expect(selected).toBe(0);
    expect(delegated).toBe(1);
  });

  test("AI Live scans independently and delegates only the server-selected candidate", async () => {
    let delegated: string | undefined;
    let decision: string | undefined;
    const chosen = aiCandidate("ETHIRT", 10);
    const runtime = createLiveSchedulerRuntime(0);
    const event = await runLiveSchedulerTick(runtime, dependencies({
      getSettings: async () => ({
        scanIntervalMs: 1_000,
        aiAgent: { ...defaultAiAgentSettings, enabled: true, mode: "live" }
      }),
      getRiskSnapshot: aiOnlyRisk,
      discoverAiCandidates: async () => [
        aiCandidate("BTCIRT", 1_000),
        chosen
      ],
      selectAiCandidate: async input => {
        expect(input.candidates).toHaveLength(2);
        return { selection: { candidate: chosen, probability: 0.82, features: zeroFeatures() }, blockers: [] };
      },
      recordAiDecision: async input => { decision = `${input.action}:${input.candidate?.id}`; },
      executeAiCandidate: async candidateId => {
        delegated = candidateId;
        return Response.json({ status: "completed" });
      }
    }));

    expect(event.outcome).toBe("executed");
    expect(event.strategy).toBe("aiAgent");
    expect(delegated).toBe("ai-market:ETHIRT");
    expect(decision).toBe("executed:ai-market:ETHIRT");
  });
});

const nonTriangleRisk = async () => ({
  state: {
    masterArmed: true,
    strategies: {
      triangle: { enabled: false },
      gapTrading: { enabled: false },
      imbalance: { enabled: true }
    }
  },
  evaluation: {
    strategies: {
      triangle: { canExecute: false, blockers: ["strategy-disabled"] },
      gapTrading: { canExecute: false, blockers: ["strategy-disabled"] },
      imbalance: { canExecute: true, blockers: [] }
    }
  }
} as never);

const aiOnlyRisk = async () => ({
  state: {
    masterArmed: true,
    strategies: {
      triangle: { enabled: false },
      gapTrading: { enabled: false },
      imbalance: { enabled: false },
      aiAgent: { enabled: true }
    }
  },
  evaluation: {
    strategies: {
      triangle: { canExecute: false, blockers: ["strategy-disabled"] },
      gapTrading: { canExecute: false, blockers: ["strategy-disabled"] },
      imbalance: { canExecute: false, blockers: ["strategy-disabled"] },
      aiAgent: { canExecute: true, blockers: [] }
    }
  }
} as never);

function strategySignal(id: string, kind: "orderbook-gap" | "orderbook-imbalance", profit: number) {
  return {
    id,
    kind,
    title: id,
    symbols: [id.split(":")[1] ?? "BTCIRT"],
    action: "buy",
    status: "actionable" as const,
    paperOnly: true as const,
    expectedEdgeBps: new Decimal(100),
    estimatedNetProfitToman: new Decimal(profit),
    confidence: new Decimal(80),
    reasons: [],
    metrics: {},
    scannedAt: 1_000
  };
}

function zeroFeatures() {
  return {
    expectedEdge: 0,
    confidence: 0,
    orderFlow: 0,
    microprice: 0,
    retention: 0,
    spread: 0,
    impact: 0,
    roundTripCost: 0,
    persistence: 0,
    kind: 0
  };
}

function aiCandidate(symbol: string, profit: number) {
  return {
    id: `ai-market:${symbol}`,
    kind: "autonomous-market" as const,
    source: "independent-orderbook-scanner" as const,
    symbol,
    base: symbol.replace(/IRT$/, ""),
    quote: "IRT" as const,
    direction: "LONG" as const,
    scannedAt: 1_000,
    bookLastUpdate: 1_000,
    confidencePercent: 80,
    expectedEdgeBps: 100,
    estimatedNetProfitToman: profit,
    projectedMoveBps: 150,
    capitalToman: 100_000,
    executable: true as const,
    gatePassed: true,
    blockers: [],
    reasons: [],
    rankScore: 90,
    features: zeroFeatures(),
    metrics: {
      capitalToman: 100_000,
      entryAssetAmount: 1,
      immediateExitToman: 99_000,
      bestBid: 99,
      bestAsk: 100,
      midpoint: 99.5,
      microprice: 99.7,
      micropriceBiasBps: 2,
      multiLevelImbalance: 0.3,
      snapshotOrderFlow: 0.1,
      bidLiquidityRetentionPercent: 80,
      spreadBps: 100,
      entryPriceImpactBps: 0,
      exitPriceImpactBps: 0,
      maxPriceImpactBps: 0,
      roundTripCostBps: 100,
      visibleBidDepthToman: 1_000_000,
      visibleAskDepthToman: 1_000_000,
      entryDepthConsumedPercent: 1,
      exitDepthConsumedPercent: 1,
      entryAvailableInputToman: 1_000_000,
      exitAvailableInputAsset: 10_000,
      entryLevelsUsed: 1,
      exitLevelsUsed: 1,
      imbalanceRatio: 1.5,
      dominantTopLevelSharePercent: 50,
      bookAgeMs: 0,
      historyTransitions: 3,
      persistencePercent: 100,
      persistenceMs: 5_000
    }
  };
}
