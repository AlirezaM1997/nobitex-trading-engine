import { describe, expect, test } from "bun:test";
import Decimal from "decimal.js";
import type { MarketOptions, NobitexOrder, OrderBook } from "@/lib/exchanges/types";
import type { StrategySignal } from "@/lib/strategies/types";
import {
  CrossQuoteExecutionError,
  createCrossQuoteExecutionPlan,
  executeCrossQuote,
  revalidateCrossQuotePlan,
  type CrossQuoteExecutionClient,
  type CrossQuotePlanConfig
} from "@/lib/strategies/cross-quote-executor";

const now = 1_800_000_000_000;

function book(symbol: string, base: string, quote: string, bid: Decimal.Value, ask: Decimal.Value): OrderBook {
  return {
    symbol,
    base,
    quote,
    lastUpdate: now,
    bids: [{ price: new Decimal(bid), amount: new Decimal(1_000_000) }],
    asks: [{ price: new Decimal(ask), amount: new Decimal(1_000_000) }]
  };
}

function books() {
  return [
    book("USDTIRT", "USDT", "IRT", 99, 100),
    book("XIRT", "X", "IRT", 999, 1_000),
    book("XUSDT", "X", "USDT", 11, 11.01)
  ];
}

function signal(): StrategySignal {
  return {
    id: "cross:X:to-usdt",
    kind: "cross-quote",
    title: "X Cross-Quote Inventory",
    symbols: ["XIRT", "XUSDT"],
    action: "IRT → asset → USDT",
    status: "actionable",
    paperOnly: true,
    expectedEdgeBps: new Decimal(985),
    estimatedNetProfitToman: new Decimal(9_850),
    confidence: new Decimal(90),
    reasons: [],
    metrics: { capitalToman: 100_000 },
    scannedAt: now
  };
}

function reverseSignal(): StrategySignal {
  return {
    ...signal(),
    id: "cross:X:to-irt",
    symbols: ["XUSDT", "XIRT"],
    action: "USDT → asset → IRT"
  };
}

const planConfig: CrossQuotePlanConfig = {
  tomanTakerFeeBps: 25,
  usdtTakerFeeBps: 13,
  slippageBps: 0,
  minEdgeBps: 100,
  liveSafetyBufferBps: 0,
  maxSpreadBps: 200,
  maxPriceImpactBps: 50,
  depthUsagePercent: 100,
  maxAgeMs: 5_000,
  orderTimeoutMs: 500,
  orderReserveBps: 0,
  recoverySlippageBps: 0
};

const marketOptions: MarketOptions = {
  amountSteps: { XIRT: new Decimal("0.01"), XUSDT: new Decimal("0.01") },
  priceSteps: { XIRT: new Decimal("0.1"), XUSDT: new Decimal("0.0001") },
  minOrderRial: new Decimal(0),
  minOrderUsdt: new Decimal(0)
};

function order(input: Partial<NobitexOrder> & Pick<NobitexOrder, "id" | "matchedAmount" | "totalPrice" | "fee">): NobitexOrder {
  return {
    status: "Done",
    amount: input.matchedAmount,
    unmatchedAmount: new Decimal(0),
    averagePrice: new Decimal(0),
    raw: {},
    ...input
  };
}

class MockClient implements CrossQuoteExecutionClient {
  baseUrl = "https://mock.invalid";
  readonly placed: Parameters<CrossQuoteExecutionClient["placeMarketOrder"]>[0][] = [];
  bookCalls = 0;
  constructor(private readonly placements: Array<NobitexOrder | Error>, private readonly snapshots: OrderBook[][] = [books()]) {}

  async getAllOrderBooks() {
    const result = this.snapshots[Math.min(this.bookCalls, this.snapshots.length - 1)]!;
    this.bookCalls += 1;
    return result;
  }
  async getMarketOptions() { return marketOptions; }
  async placeMarketOrder(input: Parameters<CrossQuoteExecutionClient["placeMarketOrder"]>[0]) {
    this.placed.push(input);
    const result = this.placements.shift();
    if (!result) throw new Error("Unexpected mock order");
    if (result instanceof Error) throw result;
    return result;
  }
  async getOrderStatus(): Promise<NobitexOrder> { throw new Error("A terminal mock order must not be polled"); }
  async cancelOrder() { throw new Error("A terminal mock order must not be canceled"); }
}

describe("Cross-Quote Mainnet executor", () => {
  test("builds and freshly reprices the exact route from its signal", () => {
    const plan = createCrossQuoteExecutionPlan(signal(), planConfig, now);
    const validation = revalidateCrossQuotePlan(plan, books(), now);

    expect(plan.direction).toBe("IRT_TO_USDT");
    expect(plan.asset).toBe("X");
    expect(plan.route).toEqual(["XIRT", "XUSDT"]);
    expect(validation.legs.map(item => `${item.edge.side}:${item.edge.book.symbol}`)).toEqual(["BUY:XIRT", "SELL:XUSDT"]);
    expect(validation.edgeBps.toFixed(2)).toBe("985.70");
  });

  test("builds the reverse USDT-to-IRT route without relying on translated action text", () => {
    const plan = createCrossQuoteExecutionPlan(reverseSignal(), planConfig, now);
    expect(plan.direction).toBe("USDT_TO_IRT");
    expect(plan.route).toEqual(["XUSDT", "XIRT"]);
  });

  test("refuses every non-Mainnet URL before reading books or placing an order", async () => {
    const client = new MockClient([]);
    client.baseUrl = "https://example.invalid";

    try {
      await executeCrossQuote(createCrossQuoteExecutionPlan(signal(), planConfig, now), client, {}, {
        now: () => now,
        revalidationDelayMs: 0
      });
      throw new Error("Expected Mainnet gate to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(CrossQuoteExecutionError);
      expect((error as CrossQuoteExecutionError).code).toBe("MAINNET_REQUIRED");
    }
    expect(client.bookCalls).toBe(0);
    expect(client.placed).toHaveLength(0);
  });

  test("executes two fully-filled Spot orders and records actual fee-adjusted outputs", async () => {
    const first = order({
      id: "101",
      matchedAmount: new Decimal(100),
      totalPrice: new Decimal(1_000_000), // Nobitex IRT payloads are in rial.
      fee: new Decimal("0.25") // BUY fee is charged in received X.
    });
    const second = order({
      id: "102",
      matchedAmount: new Decimal("99.75"),
      totalPrice: new Decimal("1097.25"),
      fee: new Decimal("1.426425") // SELL fee is charged in received USDT.
    });
    const client = new MockClient([first, second]);
    const submitted: string[] = [];
    const finalized: string[] = [];
    const result = await executeCrossQuote(
      createCrossQuoteExecutionPlan(signal(), planConfig, now),
      client,
      {
        onOrderSubmitted: ({ stage, order: placed }) => { submitted.push(`${stage}:${placed.id}`); },
        onOrderFinalized: ({ stage, leg }) => { finalized.push(`${stage}:${leg.orderId}`); }
      },
      { explicitMainnetMode: true, now: () => now, revalidationDelayMs: 0 }
    );

    expect(result.status).toBe("completed");
    expect(client.placed.map(item => `${item.side}:${item.base}${item.quote}`)).toEqual(["BUY:XIRT", "SELL:XUSDT"]);
    expect(submitted).toEqual(["leg1:101", "leg2:102"]);
    expect(finalized).toEqual(["leg1:101", "leg2:102"]);
    expect(result.legs[0]!.fee.toString()).toBe("0.25");
    expect(result.legs[0]!.feeAsset).toBe("X");
    expect(result.legs[0]!.actualOutput.toString()).toBe("99.75");
    expect(result.legs[1]!.fee.toString()).toBe("1.426425");
    expect(result.legs[1]!.feeAsset).toBe("USDT");
    expect(result.finalOutput.toString()).toBe("1095.823575");
    expect(result.actualEdgeBps?.toFixed(2)).toBe("985.70");
    expect(result.residualAssetAmount.toString()).toBe("0");
  });

  test("requires full fill and recovers the acquired amount after a partial first order", async () => {
    const partialFirst = order({
      id: "151",
      status: "Canceled",
      amount: new Decimal(100),
      matchedAmount: new Decimal(50),
      unmatchedAmount: new Decimal(50),
      totalPrice: new Decimal(500_000),
      fee: new Decimal("0.125")
    });
    const recovery = order({
      id: "152",
      matchedAmount: new Decimal("49.87"),
      totalPrice: new Decimal("498201.3"),
      fee: new Decimal("1245.50325")
    });
    const client = new MockClient([partialFirst, recovery]);
    const result = await executeCrossQuote(
      createCrossQuoteExecutionPlan(signal(), planConfig, now),
      client,
      {},
      { explicitMainnetMode: true, now: () => now, revalidationDelayMs: 0 }
    );

    expect(result.status).toBe("recovered");
    expect(result.legs.map(item => item.stage)).toEqual(["leg1", "recovery"]);
    expect(client.placed.map(item => `${item.side}:${item.base}${item.quote}`)).toEqual(["BUY:XIRT", "SELL:XIRT"]);
    expect(result.residualAssetAmount.toString()).toBe("0.005");
  });

  test("sells the intermediate asset back to IRT when leg 2 is definitively rejected", async () => {
    const first = order({ id: "201", matchedAmount: new Decimal(100), totalPrice: new Decimal(1_000_000), fee: new Decimal("0.25") });
    const recovery = order({
      id: "203",
      matchedAmount: new Decimal("99.75"),
      totalPrice: new Decimal("996502.5"),
      fee: new Decimal("2491.25625")
    });
    const client = new MockClient([first, new Error("Order rejected: TEST_REJECTION"), recovery]);
    const recoveryReasons: string[] = [];
    const result = await executeCrossQuote(
      createCrossQuoteExecutionPlan(signal(), planConfig, now),
      client,
      { onRecoveryStarted: ({ reason }) => { recoveryReasons.push(reason); } },
      { explicitMainnetMode: true, now: () => now, revalidationDelayMs: 0 }
    );

    expect(result.status).toBe("recovered");
    expect(result.finalAsset).toBe("IRT");
    expect(result.finalOutput.toString()).toBe("99401.124375");
    expect(client.placed.map(item => `${item.side}:${item.base}${item.quote}`)).toEqual([
      "BUY:XIRT",
      "SELL:XUSDT",
      "SELL:XIRT"
    ]);
    expect(result.legs.map(item => item.stage)).toEqual(["leg1", "recovery"]);
    expect(recoveryReasons[0]).toContain("Order rejected");
  });

  test("does not double-sell when the second-order submission has an ambiguous transport failure", async () => {
    const first = order({ id: "301", matchedAmount: new Decimal(100), totalPrice: new Decimal(1_000_000), fee: new Decimal("0.25") });
    const client = new MockClient([first, new Error("socket closed after request write")]);

    try {
      await executeCrossQuote(
        createCrossQuoteExecutionPlan(signal(), planConfig, now),
        client,
        {},
        { explicitMainnetMode: true, now: () => now, revalidationDelayMs: 0 }
      );
      throw new Error("Expected ambiguous order failure");
    } catch (error) {
      expect(error).toBeInstanceOf(CrossQuoteExecutionError);
      expect((error as CrossQuoteExecutionError).code).toBe("ORDER_STATE_UNKNOWN");
      expect((error as CrossQuoteExecutionError).manualInterventionRequired).toBe(true);
    }
    expect(client.placed).toHaveLength(2);
    expect(client.placed.filter(item => `${item.base}${item.quote}` === "XIRT")).toHaveLength(1);
  });

  test("rejects stale revalidation without sending an order", async () => {
    const staleBooks = books().map(item => ({ ...item, lastUpdate: now - 10_000 }));
    const client = new MockClient([], [staleBooks]);
    try {
      await executeCrossQuote(createCrossQuoteExecutionPlan(signal(), planConfig, now), client, {}, {
        explicitMainnetMode: true,
        now: () => now,
        revalidationDelayMs: 0
      });
      throw new Error("Expected stale book rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CrossQuoteExecutionError);
      expect((error as CrossQuoteExecutionError).code).toBe("REVALIDATION_FAILED");
    }
    expect(client.placed).toHaveLength(0);
  });
});
