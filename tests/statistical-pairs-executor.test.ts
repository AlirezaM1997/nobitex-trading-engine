import { describe, expect, test } from "bun:test";
import Decimal from "decimal.js";
import type { MarginPosition, NobitexOrder, OrderBook } from "@/lib/exchanges/types";
import {
  StatisticalPairsExecutionError,
  closeStatisticalPairs,
  createStatisticalPairsExecutionPlan,
  enterStatisticalPairs,
  evaluateStatisticalPairsLifecycle,
  type StatisticalPairsExecutionClient,
  type StatisticalPairsOpenPosition
} from "@/lib/strategies/statistical-pairs-executor";
import type { StrategySignal } from "@/lib/strategies/types";

const now = 1_800_000_000_000;

function book(symbol: string, base: string, bid: number, ask: number): OrderBook {
  return {
    symbol, base, quote: "IRT", lastUpdate: now,
    bids: [{ price: new Decimal(bid), amount: new Decimal(1_000_000) }],
    asks: [{ price: new Decimal(ask), amount: new Decimal(1_000_000) }]
  };
}

const books = [book("BTCIRT", "BTC", 1_000, 1_001), book("ETHIRT", "ETH", 100, 100.1)];

const signal: StrategySignal = {
  id: "pairs:BTC:ETH",
  kind: "statistical-pairs",
  title: "BTC/ETH Pairs",
  symbols: ["BTCIRT", "ETHIRT"],
  action: "Short BTC / Long ETH",
  status: "actionable",
  paperOnly: true,
  expectedEdgeBps: new Decimal(0),
  estimatedNetProfitToman: new Decimal(0),
  confidence: new Decimal(80),
  reasons: [],
  metrics: { zScore: 2.5, beta: 2, exitZScore: 0.35, notionalToman: 300_000 },
  scannedAt: now
};

function plan() {
  return createStatisticalPairsExecutionPlan(signal, {
    takerFeeBps: 0,
    slippageBps: 0,
    maxEntrySpreadBps: 120,
    maxPriceImpactBps: 75,
    depthUsagePercent: 100,
    hedgeToleranceBps: 75,
    maxAgeMs: 5_000,
    orderTimeoutMs: 1_000,
    maxHoldingMinutes: 60,
    stopZScore: 4
  }, now);
}

function order(id: string, amount: Decimal.Value, priceToman: Decimal.Value, fee: Decimal.Value = 0, unmatched: Decimal.Value = 0): NobitexOrder {
  const matched = new Decimal(amount).minus(unmatched);
  return {
    id,
    status: "Done",
    amount: new Decimal(amount),
    matchedAmount: matched,
    unmatchedAmount: new Decimal(unmatched),
    totalPrice: matched.mul(priceToman).mul(10),
    averagePrice: new Decimal(priceToman).mul(10),
    fee: new Decimal(fee),
    raw: { id }
  };
}

function position(status = "Open", realizedPnl = 0): MarginPosition {
  return {
    id: "91", base: "BTC", quote: "IRT", side: "SELL", status,
    collateral: new Decimal(100_000), leverage: new Decimal(1), entryPrice: new Decimal(1_000),
    exitPrice: status === "Closed" ? new Decimal(990) : new Decimal(0), delegatedAmount: new Decimal(100),
    liability: status === "Closed" ? new Decimal(0) : new Decimal(100), liabilityInOrder: new Decimal(0),
    assetInOrder: new Decimal(0), marginRatio: new Decimal(2), unrealizedPnl: new Decimal(0),
    realizedPnl: new Decimal(realizedPnl), markPrice: new Decimal(1_000), openedAt: new Date(now).toISOString(),
    liquidationPrice: new Decimal(1_500),
    closedAt: status === "Closed" ? new Date(now + 1_000).toISOString() : null, raw: { id: 91 }
  };
}

function mockClient(options: {
  sellEnabled?: boolean;
  spotFailure?: Error;
  spotUnmatched?: Decimal.Value;
  marginUnmatched?: Decimal.Value;
  marginPnl?: number;
  spotBalanceToman?: Decimal.Value;
  spotLookupOrder?: NobitexOrder;
} = {}) {
  const calls: string[] = [];
  let marginPlaced = false;
  let marginClosed = false;
  let spotCalls = 0;
  const client: StatisticalPairsExecutionClient = {
    baseUrl: "https://apiv2.nobitex.ir",
    getAllOrderBooks: async () => books,
    getMarketOptions: async () => ({
      amountSteps: { BTCIRT: new Decimal("0.0001"), ETHIRT: new Decimal("0.0001") },
      priceSteps: { BTCIRT: new Decimal("0.1"), ETHIRT: new Decimal("0.1") },
      minOrderRial: new Decimal(500_000),
      minOrderUsdt: new Decimal(11)
    }),
    getMarginMarkets: async () => [{
      symbol: "BTCIRT", base: "BTC", quote: "IRT", positionFeeRate: new Decimal("0.001"),
      maxLeverage: new Decimal(2), sellEnabled: options.sellEnabled ?? true, buyEnabled: false, raw: {}
    }],
    getMarginDelegationLimit: async () => new Decimal(1_000),
    getMarginQuoteWallet: async () => ({ asset: "IRT", available: new Decimal(1_000_000), blocked: new Decimal(0) }),
    getSpotTomanWallet: async () => ({ asset: "IRT", available: new Decimal(options.spotBalanceToman ?? 1_000_000), blocked: new Decimal(0) }),
    listMarginPositions: async () => marginPlaced && !marginClosed ? [position()] : [],
    getMarginPosition: async () => position(marginClosed ? "Closed" : "Open", options.marginPnl ?? 0),
    placeMarginOrder: async input => {
      calls.push("margin-short");
      marginPlaced = true;
      return order("1", input.amountBase, 1_000, 0, options.marginUnmatched ?? 0);
    },
    closeMarginPosition: async input => {
      calls.push("margin-close");
      marginClosed = true;
      return order("2", input.amountBase, 1_000);
    },
    placeMarketOrder: async input => {
      spotCalls += 1;
      calls.push(input.side === "BUY" ? "spot-long" : "spot-close");
      if (input.side === "BUY" && options.spotFailure) throw options.spotFailure;
      return input.side === "BUY"
        ? order(`spot-${spotCalls}`, input.amountBase, 100, 0, options.spotUnmatched ?? 0)
        : order(`spot-${spotCalls}`, input.amountBase, 101);
    },
    getOrderStatus: async () => { throw new Error("all mock orders are terminal"); },
    cancelOrder: async () => undefined
  };
  if (options.spotLookupOrder) {
    client.getOrderStatusByClientOrderId = async () => {
      calls.push("spot-lookup");
      return options.spotLookupOrder!;
    };
  }
  return { client, calls, isMarginClosed: () => marginClosed };
}

describe("Statistical Pairs Mainnet executor", () => {
  test("builds beta-neutral notionals and deterministic exit/stop/timeout decisions", () => {
    const value = plan();
    expect(value.direction).toBe("SHORT_A_LONG_B");
    expect(value.shortAsset).toBe("BTC");
    expect(value.longAsset).toBe("ETH");
    expect(value.shortNotionalToman.toNumber()).toBe(100_000);
    expect(value.longNotionalToman.toNumber()).toBe(200_000);
    expect(evaluateStatisticalPairsLifecycle(value, 2.2, now, now + 1_000).action).toBe("HOLD");
    expect(evaluateStatisticalPairsLifecycle(value, 0.2, now, now + 1_000).action).toBe("EXIT_MEAN");
    expect(evaluateStatisticalPairsLifecycle(value, 4.1, now, now + 1_000).action).toBe("EXIT_STOP");
    expect(evaluateStatisticalPairsLifecycle(value, 2.2, now, now + 3_600_000).action).toBe("EXIT_MAX_HOLDING");
  });

  test("rejects non-Mainnet before reading books or submitting an order", async () => {
    const mock = mockClient();
    mock.client.baseUrl = "https://example.invalid";
    let booksRead = 0;
    mock.client.getAllOrderBooks = async () => { booksRead += 1; return books; };
    await expect(enterStatisticalPairs(plan(), mock.client)).rejects.toMatchObject({ code: "MAINNET_REQUIRED" });
    expect(booksRead).toBe(0);
    expect(mock.calls).toEqual([]);
  });

  test("does not fake a pair when the required Margin short is unsupported", async () => {
    const mock = mockClient({ sellEnabled: false });
    await expect(enterStatisticalPairs(plan(), mock.client, {}, { now: () => now, revalidationDelayMs: 0 }))
      .rejects.toMatchObject({ code: "SHORT_UNSUPPORTED" });
    expect(mock.calls).toEqual([]);
  });

  test("preflights free Spot IRT before opening the Margin short", async () => {
    const mock = mockClient({ spotBalanceToman: 10_000 });
    await expect(enterStatisticalPairs(plan(), mock.client, {}, { now: () => now, revalidationDelayMs: 0 }))
      .rejects.toMatchObject({ code: "REVALIDATION_FAILED" });
    expect(mock.calls).toEqual([]);
  });

  test("opens Margin short first, then Spot long, and confirms the hedge", async () => {
    const mock = mockClient();
    const result = await enterStatisticalPairs(plan(), mock.client, {}, { now: () => now, revalidationDelayMs: 0 });
    expect(result.status).toBe("opened");
    expect(mock.calls).toEqual(["margin-short", "spot-long"]);
    if (result.status === "opened") {
      expect(result.position.marginPositionId).toBe("91");
      expect(result.actualHedgeDeviationBps.lte(75)).toBe(true);
    }
  });

  test("definitive Spot rejection closes the already-filled Margin short", async () => {
    const mock = mockClient({ spotFailure: new Error("Order rejected: InsufficientBalance") });
    let rejectionEvents = 0;
    const result = await enterStatisticalPairs(plan(), mock.client, {
      onOrderRejected: async event => { if (event.stage === "spot-long") rejectionEvents += 1; }
    }, { now: () => now, revalidationDelayMs: 0 });
    expect(result.status).toBe("recovered");
    expect(mock.calls).toEqual(["margin-short", "spot-long", "margin-close"]);
    expect(mock.isMarginClosed()).toBe(true);
    expect(rejectionEvents).toBe(1);
  });

  test("a risk or persistence failure before Spot hedge closes the owned Margin short immediately", async () => {
    const mock = mockClient();
    const result = await enterStatisticalPairs(plan(), mock.client, {
      onBeforeOrder: async event => { if (event.stage === "spot-long") throw new Error("server disarmed"); }
    }, { now: () => now, revalidationDelayMs: 0 });
    expect(result.status).toBe("recovered");
    expect(mock.calls).toEqual(["margin-short", "margin-close"]);
    expect(mock.isMarginClosed()).toBe(true);
  });

  test("ambiguous Spot submission does not close Margin and risk a wrong double recovery", async () => {
    const mock = mockClient({ spotFailure: new Error("socket timeout") });
    try {
      await enterStatisticalPairs(plan(), mock.client, {}, { now: () => now, revalidationDelayMs: 0 });
      throw new Error("expected ambiguity");
    } catch (error) {
      expect(error).toBeInstanceOf(StatisticalPairsExecutionError);
      expect((error as StatisticalPairsExecutionError).code).toBe("ORDER_STATE_UNKNOWN");
      expect((error as StatisticalPairsExecutionError).manualInterventionRequired).toBe(true);
    }
    expect(mock.calls).toEqual(["margin-short", "spot-long"]);
    expect(mock.isMarginClosed()).toBe(false);
  });

  test("reconciles a timed-out Spot hedge through clientOrderId without closing the owned Margin short", async () => {
    const mock = mockClient({
      spotFailure: new Error("response timeout after acceptance"),
      spotLookupOrder: order("spot-resolved", 2_000, 100)
    });
    const result = await enterStatisticalPairs(plan(), mock.client, {}, { now: () => now, revalidationDelayMs: 0 });
    expect(result.status).toBe("opened");
    expect(mock.calls).toEqual(["margin-short", "spot-long", "spot-lookup"]);
    expect(mock.isMarginClosed()).toBe(false);
  });

  test("partial Spot fill flattens Margin first and then only the confirmed Spot inventory", async () => {
    const mock = mockClient({ spotUnmatched: 100 });
    const result = await enterStatisticalPairs(plan(), mock.client, {}, { now: () => now, revalidationDelayMs: 0 });
    expect(result.status).toBe("recovered");
    expect(mock.calls).toEqual(["margin-short", "spot-long", "margin-close", "spot-close"]);
  });

  test("closes an open pair Margin-first and accounts Spot plus Margin PnL", async () => {
    const mock = mockClient({ marginPnl: 1_000 });
    const opened = await enterStatisticalPairs(plan(), mock.client, {}, { now: () => now, revalidationDelayMs: 0 });
    if (opened.status !== "opened") throw new Error("expected open position");
    mock.calls.length = 0;
    const closed = await closeStatisticalPairs(plan(), opened.position, "mean-reversion", mock.client, {}, { now: () => now + 1_000 });
    expect(mock.calls).toEqual(["margin-close", "spot-close"]);
    expect(closed.status).toBe("closed");
    expect(closed.marginRealizedPnlToman.toNumber()).toBe(1_000);
    expect(closed.estimatedNetPnlToman.gt(1_000)).toBe(true);
  });

  test("unwinds Spot long when the owned Margin Position is already liquidated/closed", async () => {
    const value = plan();
    const mock = mockClient();
    mock.client.getMarginPosition = async () => position("Liquidated", -5_000);
    const open: StatisticalPairsOpenPosition = {
      planId: value.id, marginPositionId: "91", openedAt: now,
      longAsset: value.longAsset, shortAsset: value.shortAsset,
      longAmountBase: new Decimal(2_000), shortLiabilityBase: new Decimal(0),
      initialLongCostToman: new Decimal(200_000), entryZScore: value.entryZScore
    };
    const result = await closeStatisticalPairs(value, open, "recovery", mock.client, {}, { now: () => now + 1_000 });
    expect(result.status).toBe("closed");
    expect(mock.calls).toEqual(["spot-close"]);
    expect(result.marginRealizedPnlToman.toNumber()).toBe(-5_000);
  });
});
