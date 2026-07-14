import { describe, expect, test } from "bun:test";
import Decimal from "decimal.js";
import {
  handleStatisticalPairsExecute,
  type StatisticalPairsRouteDependencies
} from "@/app/api/strategies/statistical-pairs/execute/route";
import { defaultBotSettings } from "@/lib/bot-settings";
import type { CandleSeries, OrderBook } from "@/lib/exchanges/types";
import { defaultRiskState } from "@/lib/risk/store";
import {
  StatisticalPairsExecutionError,
  createStatisticalPairsExecutionPlan,
  type StatisticalPairsExecutionPlan,
  type StatisticalPairsHooks,
  type StatisticalPairsOpenPosition,
  type StatisticalPairsOrderFill
} from "@/lib/strategies/statistical-pairs-executor";
import { serializeStatisticalPairsPlan, serializeStatisticalPairsPosition } from "@/lib/strategies/statistical-pairs-state";
import type { StrategySignal } from "@/lib/strategies/types";

const now = 1_800_000_000_000;
const signal: StrategySignal = {
  id: "pairs:BTC:ETH", kind: "statistical-pairs", title: "BTC/ETH", symbols: ["BTCIRT", "ETHIRT"],
  action: "Short BTC / Long ETH", status: "actionable", paperOnly: true,
  expectedEdgeBps: new Decimal(0), estimatedNetProfitToman: new Decimal(0), confidence: new Decimal(80),
  reasons: [], metrics: { zScore: 2.5, beta: 2, exitZScore: 0.35, notionalToman: 300_000 }, scannedAt: now
};
const books: OrderBook[] = [{
  symbol: "BTCIRT", base: "BTC", quote: "IRT", lastUpdate: now,
  bids: [{ price: new Decimal(1_000), amount: new Decimal(1_000) }],
  asks: [{ price: new Decimal(1_001), amount: new Decimal(1_000) }]
}];
const settings = {
  ...defaultBotSettings,
  strategyLab: {
    ...defaultBotSettings.strategyLab,
    pairs: { ...defaultBotSettings.strategyLab.pairs, assetA: "BTC", assetB: "ETH", notionalToman: 300_000 }
  }
};

function plan() {
  return createStatisticalPairsExecutionPlan(signal, {
    takerFeeBps: 0, slippageBps: 0, stopZScore: 4, grossNotionalToman: 300_000
  }, now);
}

function position(value = plan()): StatisticalPairsOpenPosition {
  return {
    planId: value.id, marginPositionId: "91", openedAt: now,
    longAsset: value.longAsset, shortAsset: value.shortAsset,
    longAmountBase: new Decimal(2_000), shortLiabilityBase: new Decimal(100),
    initialLongCostToman: new Decimal(200_000), entryZScore: value.entryZScore
  };
}

function fill(stage: StatisticalPairsOrderFill["stage"], side: "BUY" | "SELL", tradeType: "SPOT" | "MARGIN"): StatisticalPairsOrderFill {
  return {
    stage, symbol: stage.includes("spot") ? "ETHIRT" : "BTCIRT", side, tradeType,
    orderId: `${stage}-1`, status: "Done", requestedAmountBase: new Decimal(1), matchedAmountBase: new Decimal(1),
    unmatchedAmountBase: new Decimal(0), averagePriceToman: new Decimal(100), totalToman: new Decimal(100),
    fee: new Decimal(0), fullFill: true, raw: {}
  };
}

function request(body: unknown, origin = "http://localhost") {
  return new Request("http://localhost/api/strategies/statistical-pairs/execute", {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost", origin, "x-strategy-action": "nobitex-dashboard" },
    body: JSON.stringify(body)
  });
}

function lease(purpose: "execution" | "recovery") {
  return {
    acquired: true as const,
    lease: {
      version: 1 as const, slot: 0, strategy: "pairs" as const, purpose, owner: "test",
      token: "00000000-0000-4000-8000-000000000001", acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 300_000).toISOString()
    }
  };
}

function riskState() {
  const state = defaultRiskState(now);
  state.strategies.pairs.enabled = true;
  state.strategies.pairs.readiness = {
    positionStateReady: true, recoveryReady: true, executionAdapterReady: true
  };
  return state;
}

function dependencies(overrides: Partial<StatisticalPairsRouteDependencies> = {}) {
  const base = {
    apiBase: "https://apiv2.nobitex.ir",
    getSettings: async () => settings,
    createClient: () => ({ getAllOrderBooks: async () => books }) as never,
    scanStrategies: async () => ({ scannedAt: now, signals: [signal], actionableCount: 1, watchCount: 0, enabledCount: 1, diagnostics: {} }),
    acquireEntryLease: async () => lease("execution"),
    acquireRecoveryLease: async () => lease("recovery"),
    renewLease: async () => true,
    releaseLease: async () => true,
    getRiskState: async () => riskState(),
    evaluateRisk: () => ({ dailyLossBreached: false, strategies: { pairs: { blockers: [] } } }) as never,
    recordPnl: async () => ({}) as never,
    emergencyStop: async () => ({}) as never,
    createExecution: async () => ({ id: 7 }) as never,
    transitionExecution: async () => ({ id: 7 }) as never,
    addOrder: async () => ({ id: 1 }) as never,
    completeExecution: async () => ({ id: 7 }) as never,
    failExecution: async () => ({ id: 7 }) as never,
    getExecution: async () => ({ id: 7 }) as never,
    listExecutions: async () => ({ summary: {}, records: [] }) as never,
    acquireRecordLock: async (executionId, owner) => ({
      version: 1, executionId, owner, pid: process.pid, token: "test",
      acquiredAt: new Date(now).toISOString(), expiresAt: new Date(now + 600_000).toISOString()
    }),
    releaseRecordLock: async () => true,
    acquireAssetLock: async (asset, executionId) => ({ asset, executionId, path: "asset-test" }),
    releaseAssetLock: async () => true,
    now: () => now,
    enter: async (value: StatisticalPairsExecutionPlan, _client: never, hooks: StatisticalPairsHooks) => {
      const short = fill("margin-short", "SELL", "MARGIN");
      const long = fill("spot-long", "BUY", "SPOT");
      await hooks.onBeforeOrder?.({ plan: value, stage: short.stage, symbol: short.symbol, side: short.side, amountBase: new Decimal(1), expectedPrice: new Decimal(100) });
      await hooks.onOrderSubmitted?.({ plan: value, stage: short.stage, symbol: short.symbol, side: short.side, tradeType: "MARGIN", requestedAmountBase: new Decimal(1), order: order(short.orderId) });
      await hooks.onOrderFinalized?.({ plan: value, fill: short });
      await hooks.onMarginPositionDiscovered?.({ plan: value, position: { id: "91", base: "BTC", liability: new Decimal(1) } as never });
      await hooks.onBeforeOrder?.({ plan: value, stage: long.stage, symbol: long.symbol, side: long.side, amountBase: new Decimal(1), expectedPrice: new Decimal(100) });
      await hooks.onOrderSubmitted?.({ plan: value, stage: long.stage, symbol: long.symbol, side: long.side, tradeType: "SPOT", requestedAmountBase: new Decimal(1), order: order(long.orderId) });
      await hooks.onOrderFinalized?.({ plan: value, fill: long });
      const open = position(value);
      await hooks.onPositionOpened?.({ plan: value, position: open });
      return { status: "opened" as const, plan: value, validation: {} as never, position: open, fills: [short, long], actualHedgeDeviationBps: new Decimal(0) };
    },
    close: async (value: StatisticalPairsExecutionPlan, open: StatisticalPairsOpenPosition, reason: "mean-reversion" | "stop-loss" | "max-holding" | "recovery", _client: never, hooks: StatisticalPairsHooks) => {
      const margin = fill("margin-close", "BUY", "MARGIN");
      const spot = fill("spot-close", "SELL", "SPOT");
      await hooks.onBeforeOrder?.({ plan: value, stage: margin.stage, symbol: margin.symbol, side: margin.side, amountBase: new Decimal(1), expectedPrice: new Decimal(100) });
      await hooks.onOrderFinalized?.({ plan: value, fill: margin });
      await hooks.onBeforeOrder?.({ plan: value, stage: spot.stage, symbol: spot.symbol, side: spot.side, amountBase: new Decimal(1), expectedPrice: new Decimal(100) });
      await hooks.onOrderFinalized?.({ plan: value, fill: spot });
      return { status: "closed" as const, plan: value, position: open, reason, fills: [margin, spot], spotOutputToman: new Decimal(201_000), marginRealizedPnlToman: new Decimal(1_000), estimatedNetPnlToman: new Decimal(2_000) };
    },
    recover: async (value: StatisticalPairsExecutionPlan, input: { marginPositionId?: string | null; confirmedLongAmountBase: Decimal.Value }) => ({
      status: "flat" as const, plan: value, fills: [], marginPositionId: input.marginPositionId ?? "91", recoveredLongAmountBase: new Decimal(input.confirmedLongAmountBase)
    })
  } satisfies StatisticalPairsRouteDependencies;
  return { ...base, ...overrides } as StatisticalPairsRouteDependencies;
}

function order(id: string) {
  return {
    id, status: "Done", amount: new Decimal(1), matchedAmount: new Decimal(1), unmatchedAmount: new Decimal(0),
    totalPrice: new Decimal(1_000), averagePrice: new Decimal(1_000), fee: new Decimal(0), raw: {}
  };
}

function candles(symbol: string, power: number): CandleSeries {
  const timestamps = Array.from({ length: 120 }, (_, index) => Math.floor(now / 1_000) - (119 - index) * 3_600);
  const close = timestamps.map((_, index) => {
    const base = new Decimal(100 + index);
    return base.pow(power).mul(new Decimal(Math.exp(Math.sin(index) * 0.01)));
  });
  return { symbol, resolution: "60", timestamps, open: close, high: close, low: close, close, volume: close.map(() => new Decimal(1)) };
}

describe("Statistical Pairs execution route", () => {
  test("rejects non-Mainnet before settings, client, scan or lease calls", async () => {
    const calls = { settings: 0, client: 0, lease: 0 };
    const response = await handleStatisticalPairsExecute(request({ action: "enter", signalId: signal.id }), dependencies({
      apiBase: "https://example.invalid",
      getSettings: async () => { calls.settings += 1; return settings; },
      createClient: () => { calls.client += 1; return {} as never; },
      acquireEntryLease: async () => { calls.lease += 1; return lease("execution"); }
    }));
    expect(response.status).toBe(423);
    expect(await response.json()).toMatchObject({ code: "MAINNET_REQUIRED" });
    expect(calls).toEqual({ settings: 0, client: 0, lease: 0 });
  });

  test("rejects foreign origins and browser-supplied capital or prices", async () => {
    expect((await handleStatisticalPairsExecute(request({ action: "enter", signalId: signal.id }, "https://evil.example"), dependencies())).status).toBe(403);
    expect((await handleStatisticalPairsExecute(request({ action: "enter", signalId: signal.id, capitalToman: 1 }), dependencies())).status).toBe(400);
  });

  test("entry persists plan, accepted order ids, finalized fills and open Position state", async () => {
    const transitions: Array<{ state: string; metadata?: Record<string, unknown> }> = [];
    const orders: Array<Record<string, unknown>> = [];
    let createdMetadata: Record<string, unknown> = {};
    const response = await handleStatisticalPairsExecute(request({ action: "enter", signalId: signal.id }), dependencies({
      createExecution: async input => { createdMetadata = input.metadata ?? {}; return { id: 7 } as never; },
      transitionExecution: async (_id, state, input) => { transitions.push({ state, metadata: input?.metadata }); return { id: 7 } as never; },
      addOrder: async (_id, input) => { orders.push(input as unknown as Record<string, unknown>); return { id: 1 } as never; }
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "opened", executionId: 7 });
    expect(createdMetadata.pairsPlan).toBeDefined();
    expect(transitions.map(item => item.state)).toEqual(["REVALIDATING", "SUBMITTING", "PARTIALLY_FILLED", "HEDGING"]);
    expect(transitions.at(-1)?.metadata?.openPosition).toBeDefined();
    expect(transitions.find(item => item.state === "PARTIALLY_FILLED")?.metadata?.marginPositionId).toBe("91");
    expect(orders.filter(item => item.exchangeOrderId)).toHaveLength(4);
  });

  test("a short-asset ownership conflict rejects the second entry before any exchange order", async () => {
    let enterCalls = 0;
    const response = await handleStatisticalPairsExecute(request({ action: "enter", signalId: signal.id }), dependencies({
      acquireAssetLock: async () => undefined,
      enter: async () => { enterCalls += 1; throw new Error("must not run"); }
    }));
    expect(response.status).toBe(502);
    expect((await response.json()).code).toBe("ORDER_FAILED");
    expect(enterCalls).toBe(0);
  });

  test("crash recovery uses only the recovery lease and can run while normal risk is blocked", async () => {
    const value = plan();
    const open = position(value);
    const leases: string[] = [];
    let recoveredInput: Record<string, unknown> = {};
    const response = await handleStatisticalPairsExecute(request({ action: "recover", executionId: 7 }), dependencies({
      getExecution: async () => ({
        id: 7, strategy: "pairs", state: "HEDGING", metadata: {
          pairsPlan: serializeStatisticalPairsPlan(value), openPosition: serializeStatisticalPairsPosition(open)
        }, orders: []
      }) as never,
      acquireEntryLease: async () => { leases.push("entry"); return { acquired: false as const, reason: "risk-blocked" as const, blockers: ["emergency-stop-active"] }; },
      acquireRecoveryLease: async () => { leases.push("recovery"); return lease("recovery"); },
      recover: async (p, input) => { recoveredInput = input as unknown as Record<string, unknown>; return { status: "flat", plan: p, fills: [], marginPositionId: open.marginPositionId, recoveredLongAmountBase: new Decimal(input.confirmedLongAmountBase) }; }
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("recovered");
    expect(leases).toEqual(["recovery"]);
    expect(recoveredInput.marginPositionId).toBe("91");
  });

  test("server monitor closes max-holding positions before any OHLC dependency", async () => {
    const value = plan();
    const open = { ...position(value), openedAt: now - value.config.maxHoldingMs - 1 };
    const record = {
      id: 7, strategy: "pairs", state: "HEDGING", updatedAt: now - 1_000,
      metadata: { pairsPlan: serializeStatisticalPairsPlan(value), openPosition: serializeStatisticalPairsPosition(open) },
      orders: []
    } as never;
    const transitions: string[] = [];
    let closeReason = "";
    let candleCalls = 0;
    const response = await handleStatisticalPairsExecute(request({ action: "monitor" }), dependencies({
      listExecutions: async options => ({ summary: {}, records: options?.state === "HEDGING" ? [record] : [] }) as never,
      createClient: () => ({
        getMarginPosition: async () => ({
          id: "91", base: "BTC", quote: "IRT", status: "Open",
          marginRatio: new Decimal(2), markPrice: new Decimal(1_000), liquidationPrice: new Decimal(1_500)
        }),
        getCandles: async (symbol: string) => {
          candleCalls += 1;
          return symbol === "BTCIRT" ? candles("BTCIRT", 2) : candles("ETHIRT", 1);
        }
      }) as never,
      transitionExecution: async (_id, state) => { transitions.push(state); return { id: 7 } as never; },
      close: async (p, pos, reason) => {
        closeReason = reason;
        return { status: "closed", plan: p, position: pos, reason, fills: [], spotOutputToman: new Decimal(201_000), marginRealizedPnlToman: new Decimal(1_000), estimatedNetPnlToman: new Decimal(2_000) };
      }
    }));
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.results[0].status).toBe("closed");
    expect(closeReason).toBe("max-holding");
    expect(transitions).toEqual(["RECOVERING"]);
    expect(candleCalls).toBe(0);
  });

  test("restart recovery subtracts every confirmed Spot SELL and never resells the original full long", async () => {
    const value = plan();
    const open = { ...position(value), longAmountBase: new Decimal(10) };
    let confirmedLong = new Decimal(-1);
    const response = await handleStatisticalPairsExecute(request({ action: "recover", executionId: 7 }), dependencies({
      getExecution: async () => ({
        id: 7, strategy: "pairs", state: "RECOVERING", metadata: {
          pairsPlan: serializeStatisticalPairsPlan(value), openPosition: serializeStatisticalPairsPosition(open)
        },
        orders: [
          { legIndex: 3, status: "submitting", exchangeOrderId: null },
          { legIndex: 3, status: "Done", exchangeOrderId: "501" }
        ]
      }) as never,
      createClient: () => ({
        getOrderStatus: async () => ({
          id: "501", status: "Done", amount: new Decimal(4), matchedAmount: new Decimal(4), unmatchedAmount: new Decimal(0),
          totalPrice: new Decimal(4_000), averagePrice: new Decimal(1_000), fee: new Decimal(0), raw: {}
        }),
        cancelOrder: async () => undefined
      }) as never,
      recover: async (p, input) => {
        confirmedLong = new Decimal(input.confirmedLongAmountBase);
        return { status: "flat", plan: p, fills: [], marginPositionId: "91", recoveredLongAmountBase: confirmedLong };
      }
    }));
    expect(response.status).toBe(200);
    expect(confirmedLong.toNumber()).toBe(6);
  });

  test("restart recovery resolves a Spot close submit intent by clientOrderId before calculating residual inventory", async () => {
    const value = plan();
    const open = { ...position(value), longAmountBase: new Decimal(10) };
    let confirmedLong = new Decimal(-1);
    const resolved = {
      id: "502", status: "Done", amount: new Decimal(4), matchedAmount: new Decimal(4), unmatchedAmount: new Decimal(0),
      totalPrice: new Decimal(4_000), averagePrice: new Decimal(1_000), fee: new Decimal(0), raw: {}
    };
    const response = await handleStatisticalPairsExecute(request({ action: "recover", executionId: 7 }), dependencies({
      getExecution: async () => ({
        id: 7, strategy: "pairs", state: "RECOVERING", metadata: {
          pairsPlan: serializeStatisticalPairsPlan(value), openPosition: serializeStatisticalPairsPosition(open)
        },
        orders: [{ legIndex: 3, status: "submitting", clientOrderId: "spot-close-timeout", exchangeOrderId: null }]
      }) as never,
      createClient: () => ({
        getOrderStatusByClientOrderId: async (id: string) => {
          expect(id).toBe("spot-close-timeout");
          return resolved;
        },
        getOrderStatus: async (id: string) => {
          expect(id).toBe("502");
          return resolved;
        },
        cancelOrder: async () => undefined
      }) as never,
      recover: async (p, input) => {
        confirmedLong = new Decimal(input.confirmedLongAmountBase);
        return { status: "flat", plan: p, fills: [], marginPositionId: "91", recoveredLongAmountBase: confirmedLong };
      }
    }));
    expect(response.status).toBe(200);
    expect(confirmedLong.toNumber()).toBe(6);
  });

  test("manual ambiguity records FAILED_MANUAL and triggers the server emergency stop", async () => {
    let failures = 0;
    let emergencies = 0;
    const response = await handleStatisticalPairsExecute(request({ action: "enter", signalId: signal.id }), dependencies({
      enter: async () => { throw new StatisticalPairsExecutionError("unknown Margin order", "ORDER_STATE_UNKNOWN", true); },
      failExecution: async () => { failures += 1; return { id: 7 } as never; },
      emergencyStop: async () => { emergencies += 1; return {} as never; }
    }));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "ORDER_STATE_UNKNOWN", manualInterventionRequired: true });
    expect(failures).toBe(1);
    expect(emergencies).toBe(1);
  });

  test("ambiguity after submission remains RECOVERING instead of becoming an unrecoverable terminal record", async () => {
    const transitions: string[] = [];
    let failures = 0;
    let emergencies = 0;
    const response = await handleStatisticalPairsExecute(request({ action: "enter", signalId: signal.id }), dependencies({
      enter: async (value, _client, hooks) => {
        await hooks.onBeforeOrder?.({
          plan: value, stage: "margin-short", symbol: "BTCIRT", side: "SELL",
          amountBase: new Decimal(1), expectedPrice: new Decimal(1_000)
        });
        throw new StatisticalPairsExecutionError("margin submit timeout", "ORDER_STATE_UNKNOWN", true);
      },
      transitionExecution: async (_id, state) => { transitions.push(state); return { id: 7 } as never; },
      failExecution: async () => { failures += 1; return { id: 7 } as never; },
      emergencyStop: async () => { emergencies += 1; return {} as never; }
    }));
    expect(response.status).toBe(502);
    expect((await response.json()).recoveryAvailable).toBe(true);
    expect(transitions).toEqual(["REVALIDATING", "SUBMITTING", "RECOVERING"]);
    expect(failures).toBe(0);
    expect(emergencies).toBe(1);
  });
});
