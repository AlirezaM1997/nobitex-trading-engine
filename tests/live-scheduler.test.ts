import { describe, expect, test } from "bun:test";
import Decimal from "decimal.js";
import {
  createLiveSchedulerRuntime,
  runLiveSchedulerTick,
  type LiveSchedulerDependencies
} from "@/lib/runtime/live-scheduler";

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
            stablecoin: { enabled: true },
            imbalance: { enabled: false }
          }
        },
        evaluation: {
          strategies: {
            triangle: { canExecute: false, blockers: ["strategy-disabled"] },
            stablecoin: { canExecute: true, blockers: [] },
            imbalance: { canExecute: false, blockers: ["strategy-disabled"] }
          }
        }
      } as never),
      executeTriangle: async () => {
        triangleCalls += 1;
        return Response.json({ status: "executed" });
      },
      discoverStrategySignals: async () => [
        {
          id: "ignored-imbalance",
          kind: "orderbook-imbalance",
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
          id: "stablecoin-best",
          kind: "stablecoin",
          title: "stablecoin",
          symbols: ["USDTIRT"],
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

    expect(event).toMatchObject({ outcome: "executed", strategy: "stablecoin", httpStatus: 200 });
    expect(triangleCalls).toBe(0);
    expect(delegated).toEqual({ kind: "stablecoin", signalId: "stablecoin-best" });
  });
});
