import { describe, expect, test } from "bun:test";
import Decimal from "decimal.js";
import { GET as GET_EXECUTIONS } from "@/app/api/strategy-executions/route";
import {
  handleCrossQuoteExecute,
  type CrossQuoteRouteDependencies
} from "@/app/api/strategies/cross-quote/execute/route";
import { defaultBotSettings } from "@/lib/bot-settings";
import { quoteEdge } from "@/lib/bot/engine";
import type { NobitexOrder, OrderBook } from "@/lib/exchanges/types";
import {
  CrossQuoteExecutionError,
  createCrossQuoteExecutionPlan,
  revalidateCrossQuotePlan,
  type CrossQuoteExecutionLeg,
  type CrossQuoteExecutionPlan,
  type CrossQuoteOrderRequest
} from "@/lib/strategies/cross-quote-executor";
import type { StrategySignal } from "@/lib/strategies/types";

const now = 1_800_000_000_000;

function book(symbol: string, base: string, quote: string, bid: number, ask: number): OrderBook {
  return {
    symbol, base, quote, lastUpdate: now,
    bids: [{ price: new Decimal(bid), amount: new Decimal(1_000_000) }],
    asks: [{ price: new Decimal(ask), amount: new Decimal(1_000_000) }]
  };
}

const marketBooks = [
  book("USDTIRT", "USDT", "IRT", 99, 100),
  book("XIRT", "X", "IRT", 999, 1_000),
  book("XUSDT", "X", "USDT", 11, 11.01)
];

const strategySignal: StrategySignal = {
  id: "cross:X:to-usdt",
  kind: "cross-quote",
  title: "X Cross-Quote",
  symbols: ["XIRT", "XUSDT"],
  action: "IRT → asset → USDT",
  status: "actionable",
  paperOnly: true,
  expectedEdgeBps: new Decimal(900),
  estimatedNetProfitToman: new Decimal(9_000),
  confidence: new Decimal(90),
  reasons: [],
  metrics: { capitalToman: 100_000 },
  scannedAt: now
};

const settings = {
  ...defaultBotSettings,
  orderbookMaxAgeMs: 5_000,
  strategyLab: {
    ...defaultBotSettings.strategyLab,
    crossQuote: {
      ...defaultBotSettings.strategyLab.crossQuote,
      capitalToman: 100_000,
      depthUsagePercent: 100,
      minEdgeBps: 100,
      maxSpreadBps: 200
    }
  }
};

function makePlan() {
  return createCrossQuoteExecutionPlan(strategySignal, {
    capitalToman: 100_000,
    tomanTakerFeeBps: 25,
    usdtTakerFeeBps: 13,
    slippageBps: 0,
    minEdgeBps: 100,
    liveSafetyBufferBps: 0,
    maxSpreadBps: 200,
    maxPriceImpactBps: 50,
    depthUsagePercent: 100,
    maxAgeMs: 5_000,
    orderTimeoutMs: 1_000,
    orderReserveBps: 0
  }, now);
}

function order(id: string, matchedAmount: Decimal.Value, totalPrice: Decimal.Value, fee: Decimal.Value): NobitexOrder {
  return {
    id,
    status: "Done",
    amount: new Decimal(matchedAmount),
    matchedAmount: new Decimal(matchedAmount),
    unmatchedAmount: new Decimal(0),
    totalPrice: new Decimal(totalPrice),
    averagePrice: new Decimal(0),
    fee: new Decimal(fee),
    raw: { id }
  };
}

function client() {
  return {
    baseUrl: "https://apiv2.nobitex.ir",
    getAllOrderBooks: async () => marketBooks,
    getMarketOptions: async () => { throw new Error("unused"); },
    placeMarketOrder: async () => { throw new Error("unused"); },
    getOrderStatus: async () => { throw new Error("unused"); },
    cancelOrder: async () => { throw new Error("unused"); }
  };
}

function request(body: unknown, origin = "http://localhost") {
  return new Request("http://localhost/api/strategies/cross-quote/execute", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "localhost",
      origin,
      "x-strategy-action": "nobitex-dashboard"
    },
    body: JSON.stringify(body)
  });
}

function dependencies(overrides: Partial<CrossQuoteRouteDependencies> = {}) {
  const base = {
    getSettings: async () => settings,
    createClient: client,
    scanStrategies: async () => ({
      scannedAt: now,
      signals: [strategySignal],
      actionableCount: 1,
      watchCount: 0,
      enabledCount: 1,
      diagnostics: {}
    }),
    createPlan: () => makePlan(),
    acquireLease: async () => ({
      acquired: true as const,
      lease: {
        version: 1 as const,
        slot: 0,
        strategy: "crossQuote" as const,
        purpose: "execution" as const,
        owner: "test",
        token: "00000000-0000-4000-8000-000000000001",
        acquiredAt: "2026-07-12T12:00:00.000Z",
        expiresAt: "2026-07-12T12:05:00.000Z"
      }
    }),
    renewLease: async () => true,
    releaseLease: async () => true,
    getRiskState: async () => ({}) as never,
    evaluateRisk: () => ({
      strategies: { crossQuote: { enabled: true, ready: true, canExecute: true, blockers: [] } }
    }) as never,
    emergencyStop: async () => settings as never,
    createExecution: async () => ({ id: 7 }) as never,
    transitionExecution: async () => ({ id: 7 }) as never,
    addOrder: async () => ({ id: 1 }) as never,
    completeExecution: async () => ({ id: 7 }) as never,
    failExecution: async () => ({ id: 7 }) as never,
    execute: async () => { throw new Error("unused"); }
  } satisfies CrossQuoteRouteDependencies;
  return { ...base, ...overrides } as CrossQuoteRouteDependencies;
}

function finalizedLeg(
  stage: "leg1" | "leg2",
  symbol: string,
  side: "BUY" | "SELL",
  orderId: string,
  clientOrderId: string,
  input: Decimal.Value,
  output: Decimal.Value,
  fee: Decimal.Value
): CrossQuoteExecutionLeg {
  return {
    stage, symbol, side, orderId, clientOrderId, status: "Done",
    submittedAmountBase: side === "BUY" ? new Decimal(100) : new Decimal("99.75"),
    matchedAmountBase: side === "BUY" ? new Decimal(100) : new Decimal("99.75"),
    unmatchedAmountBase: new Decimal(0),
    actualInput: new Decimal(input),
    inputAsset: side === "BUY" ? "IRT" : "X",
    actualOutput: new Decimal(output),
    outputAsset: side === "BUY" ? "X" : "USDT",
    fee: new Decimal(fee),
    feeAsset: side === "BUY" ? "X" : "USDT",
    averagePrice: new Decimal(side === "BUY" ? 1_000 : 11),
    fullFill: true
  };
}

describe("Cross-Quote execution route", () => {
  test("rejects a foreign origin before loading settings or touching the exchange", async () => {
    let settingsCalls = 0;
    const response = await handleCrossQuoteExecute(request({ signalId: strategySignal.id }, "https://evil.example"), dependencies({
      getSettings: async () => { settingsCalls += 1; return settings; }
    }));
    expect(response.status).toBe(403);
    expect(settingsCalls).toBe(0);
  });

  test("accepts only signalId and rejects browser-supplied settings or prices", async () => {
    const response = await handleCrossQuoteExecute(request({ signalId: strategySignal.id, capitalToman: 1 }), dependencies());
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("only signalId");

    const extraField = await handleCrossQuoteExecute(request({ signalId: strategySignal.id, extra: true }), dependencies());
    expect(extraField.status).toBe(400);
    expect((await extraField.json()).error).toContain("only signalId");
  });

  test("returns 423 with server risk blockers and never calls the executor", async () => {
    let executeCalls = 0;
    const response = await handleCrossQuoteExecute(request({ signalId: strategySignal.id }), dependencies({
      acquireLease: async () => ({ acquired: false as const, reason: "risk-blocked" as const, blockers: ["master-not-armed"] }),
      execute: async () => { executeCalls += 1; throw new Error("must not execute"); }
    }));
    expect(response.status).toBe(423);
    expect(await response.json()).toMatchObject({ code: "RISK_BLOCKED", blockers: ["master-not-armed"] });
    expect(executeCalls).toBe(0);
  });

  test("persists lifecycle snapshots and both client/exchange ids for a completed execution", async () => {
    const transitions: string[] = [];
    const storedOrders: Array<Record<string, unknown>> = [];
    let released = 0;
    const response = await handleCrossQuoteExecute(request({ signalId: strategySignal.id }), dependencies({
      transitionExecution: async (_id, state) => { transitions.push(state); return { id: 7 } as never; },
      addOrder: async (_id, value) => { storedOrders.push(value as unknown as Record<string, unknown>); return { id: storedOrders.length } as never; },
      completeExecution: async () => { transitions.push("CLOSED"); return { id: 7 } as never; },
      releaseLease: async () => { released += 1; return true; },
      execute: async (plan, _client, hooks) => {
        const validation = revalidateCrossQuotePlan(plan, marketBooks, now);
        const firstRequest: CrossQuoteOrderRequest = {
          side: "BUY", base: "X", quote: "IRT", amountBase: new Decimal(100), expectedPrice: new Decimal(1_000), clientOrderId: "cq-client-1"
        };
        const secondRequest: CrossQuoteOrderRequest = {
          side: "SELL", base: "X", quote: "USDT", amountBase: new Decimal("99.75"), expectedPrice: new Decimal(11), clientOrderId: "cq-client-2"
        };
        const firstOrder = order("exchange-1", 100, 1_000_000, "0.25");
        const secondOrder = order("exchange-2", "99.75", "1097.25", "1.426425");
        const firstLeg = finalizedLeg("leg1", "XIRT", "BUY", firstOrder.id, firstRequest.clientOrderId, 100_000, "99.75", "0.25");
        const secondLeg = finalizedLeg("leg2", "XUSDT", "SELL", secondOrder.id, secondRequest.clientOrderId, "99.75", "1095.823575", "1.426425");
        await hooks.onBeforeOrder?.({ stage: "leg1", plan, quote: validation.legs[0], request: firstRequest });
        await hooks.onOrderSubmitted?.({ stage: "leg1", plan, order: firstOrder, request: firstRequest });
        await hooks.onOrderFinalized?.({ stage: "leg1", plan, leg: firstLeg });
        await hooks.onBeforeOrder?.({ stage: "leg2", plan, quote: validation.legs[1], request: secondRequest });
        await hooks.onOrderSubmitted?.({ stage: "leg2", plan, order: secondOrder, request: secondRequest });
        await hooks.onOrderFinalized?.({ stage: "leg2", plan, leg: secondLeg });
        return {
          status: "completed",
          plan,
          entry: validation,
          legs: [firstLeg, secondLeg],
          finalAsset: "USDT",
          finalOutput: secondLeg.actualOutput,
          residualAssetAmount: new Decimal(0),
          actualEdgeBps: new Decimal(985)
        };
      }
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "completed", executionId: 7, pnlRecorded: false });
    expect(transitions).toEqual(["REVALIDATING", "SUBMITTING", "CLOSED"]);
    expect(storedOrders).toHaveLength(6);
    expect(storedOrders.some(value => value.clientOrderId === "cq-client-1" && value.exchangeOrderId === "exchange-1")).toBe(true);
    expect(storedOrders.some(value => value.clientOrderId === "cq-client-2" && value.exchangeOrderId === "exchange-2")).toBe(true);
    expect(released).toBe(1);
  });

  test("moves an ambiguous exposed execution through recovery/manual failure and triggers emergency stop", async () => {
    const transitions: string[] = [];
    let failed = 0;
    let emergency = 0;
    let released = 0;
    const response = await handleCrossQuoteExecute(request({ signalId: strategySignal.id }), dependencies({
      transitionExecution: async (_id, state) => { transitions.push(state); return { id: 7 } as never; },
      failExecution: async () => { failed += 1; transitions.push("FAILED_MANUAL"); return { id: 7 } as never; },
      emergencyStop: async () => { emergency += 1; return settings as never; },
      releaseLease: async () => { released += 1; return true; },
      execute: async (plan, _client, hooks) => {
        const validation = revalidateCrossQuotePlan(plan, marketBooks, now);
        const pending: CrossQuoteOrderRequest = {
          side: "BUY", base: "X", quote: "IRT", amountBase: new Decimal(100), expectedPrice: new Decimal(1_000), clientOrderId: "cq-ambiguous"
        };
        await hooks.onBeforeOrder?.({ stage: "leg1", plan, quote: validation.legs[0], request: pending });
        throw new CrossQuoteExecutionError("unknown exchange order state", "ORDER_STATE_UNKNOWN", true);
      }
    }));

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "ORDER_STATE_UNKNOWN", manualInterventionRequired: true });
    expect(transitions).toEqual(["REVALIDATING", "SUBMITTING", "RECOVERING", "FAILED_MANUAL"]);
    expect(failed).toBe(1);
    expect(emergency).toBe(1);
    expect(released).toBe(1);
  });

  test("blocks leg 2 after a server stop but renews the same lease and permits only IRT recovery", async () => {
    const transitions: string[] = [];
    let riskChecks = 0;
    let renewals = 0;
    let emergencyCalls = 0;
    const response = await handleCrossQuoteExecute(request({ signalId: strategySignal.id }), dependencies({
      transitionExecution: async (_id, state) => { transitions.push(state); return { id: 7 } as never; },
      completeExecution: async () => { transitions.push("CLOSED"); return { id: 7 } as never; },
      renewLease: async () => { renewals += 1; return true; },
      getRiskState: async () => ({}) as never,
      evaluateRisk: () => {
        riskChecks += 1;
        const permitted = riskChecks === 1;
        return {
          strategies: {
            crossQuote: {
              enabled: true,
              ready: true,
              canExecute: permitted,
              blockers: permitted ? [] : ["emergency-stop-active"]
            }
          }
        } as never;
      },
      emergencyStop: async () => { emergencyCalls += 1; return settings as never; },
      execute: async (plan, _client, hooks) => {
        const validation = revalidateCrossQuotePlan(plan, marketBooks, now);
        const firstRequest: CrossQuoteOrderRequest = {
          side: "BUY", base: "X", quote: "IRT", amountBase: new Decimal(100), expectedPrice: new Decimal(1_000), clientOrderId: "cq-risk-first"
        };
        const secondRequest: CrossQuoteOrderRequest = {
          side: "SELL", base: "X", quote: "USDT", amountBase: new Decimal("99.75"), expectedPrice: new Decimal(11), clientOrderId: "cq-risk-second"
        };
        await hooks.onBeforeOrder?.({ stage: "leg1", plan, quote: validation.legs[0], request: firstRequest });
        await expect(hooks.onBeforeOrder?.({ stage: "leg2", plan, quote: validation.legs[1], request: secondRequest })).rejects.toMatchObject({ code: "ORDER_FAILED" });

        const recoveryQuote = quoteEdge({
          id: "XIRT:SELL", from: "X", to: "IRT", side: "SELL", book: marketBooks[1]!
        }, "99.75", 25, 0, 100)!;
        const recoveryRequest: CrossQuoteOrderRequest = {
          side: "SELL", base: "X", quote: "IRT", amountBase: new Decimal("99.75"), expectedPrice: new Decimal(999), clientOrderId: "cq-risk-recovery"
        };
        await hooks.onRecoveryStarted?.({ plan, assetAmount: new Decimal("99.75"), reason: "emergency-stop-active" });
        await hooks.onBeforeOrder?.({ stage: "recovery", plan, quote: recoveryQuote, request: recoveryRequest });
        return {
          status: "recovered",
          plan,
          entry: validation,
          legs: [],
          finalAsset: "IRT",
          finalOutput: new Decimal(99_000),
          residualAssetAmount: new Decimal(0),
          recoveryReason: "emergency-stop-active"
        };
      }
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "recovered", pnlRecorded: false });
    expect(riskChecks).toBe(2);
    expect(renewals).toBe(3);
    expect(transitions).toEqual(["REVALIDATING", "SUBMITTING", "RECOVERING", "CLOSED"]);
    expect(emergencyCalls).toBe(0);
  });

  test("validates execution-history query filters before touching the database", async () => {
    const response = await GET_EXECUTIONS(new Request("http://localhost/api/strategy-executions?state=NOT_A_STATE"));
    expect(response.status).toBe(400);
  });
});
