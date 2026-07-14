import { describe, expect, test } from "bun:test";
import Decimal from "decimal.js";
import { defaultBotSettings } from "@/lib/bot-settings";
import { findTriangularOpportunities } from "@/lib/bot/engine";
import {
  applyConfirmedOrderToInventory,
  executeLive,
  LiveExecutionRecoveredError,
  LiveManualInterventionError,
  recoverIntermediateInventory,
  type LiveExecutionClient
} from "@/lib/bot/executor";
import type { MarketOptions, NobitexOrder, OrderBook, Side } from "@/lib/exchanges/types";

const now = Date.now();
const book = (symbol: string, base: string, quote: string, bid: string, ask: string, amount = "1000000"): OrderBook => ({
  symbol, base, quote, lastUpdate: now,
  bids: [{ price: new Decimal(bid), amount: new Decimal(amount) }],
  asks: [{ price: new Decimal(ask), amount: new Decimal(amount) }]
});
const order = (input: Partial<NobitexOrder> & Pick<NobitexOrder, "id" | "status">): NobitexOrder => ({
  id: input.id,
  status: input.status,
  amount: input.amount ?? new Decimal(0),
  matchedAmount: input.matchedAmount ?? new Decimal(0),
  unmatchedAmount: input.unmatchedAmount ?? new Decimal(0),
  totalPrice: input.totalPrice ?? new Decimal(0),
  averagePrice: input.averagePrice ?? new Decimal(0),
  fee: input.fee ?? new Decimal(0),
  raw: input.raw ?? {}
});
const options: MarketOptions = {
  amountSteps: { ETHIRT: new Decimal("0.0001"), USDTIRT: new Decimal("0.0001"), BTCUSDT: new Decimal("0.00000001"), BTCIRT: new Decimal("0.00000001") },
  priceSteps: { ETHIRT: new Decimal(1), USDTIRT: new Decimal(1), BTCUSDT: new Decimal("0.01"), BTCIRT: new Decimal(1) },
  minOrderRial: new Decimal(500_000),
  minOrderUsdt: new Decimal(11)
};
const settings = {
  ...defaultBotSettings,
  tomanTakerFeeBps: 0,
  usdtTakerFeeBps: 0,
  slippageBufferBps: 0,
  liveSafetyBufferBps: 0,
  maxSpreadBps: 200,
  maxPriceImpactBps: 100,
  orderbookDepthUsagePercent: 100,
  minProfitBps: 0,
  minNetProfitToman: 0,
  orderbookMaxAgeMs: 60_000,
  orderTimeoutMs: 1_000
};

class MockClient implements LiveExecutionClient {
  placed: Array<{ side: Side; base: string; quote: string; amountBase: Decimal; expectedPrice: Decimal; clientOrderId: string }> = [];

  constructor(private readonly books: OrderBook[], private readonly orders: NobitexOrder[]) {}

  async getAllOrderBooks() { return this.books; }
  async getMarketOptions() { return options; }
  async placeMarketOrder(input: { side: Side; base: string; quote: string; amountBase: Decimal; expectedPrice: Decimal; clientOrderId: string }) {
    this.placed.push(input);
    const next = this.orders.shift();
    if (!next) throw new Error("Mock has no queued order");
    return next;
  }
  async getOrderStatus(id: string) {
    const next = this.orders.shift();
    if (!next) throw new Error(`Mock has no status for ${id}`);
    return next;
  }
  async cancelOrder() {}
}

describe("triangular automatic recovery", () => {
  test("tracks partial BUY inventory without touching pre-existing wallet balances", () => {
    const inventory = applyConfirmedOrderToInventory(
      { IRT: new Decimal(1_000_000) },
      book("USDTIRT", "USDT", "IRT", "99900", "100000"),
      "BUY",
      order({
        id: "partial-buy", status: "Canceled", matchedAmount: new Decimal(5), unmatchedAmount: new Decimal(5),
        totalPrice: new Decimal(5_000_000), averagePrice: new Decimal(1_000_000), fee: new Decimal("0.01")
      })
    );
    expect(inventory.IRT?.toString()).toBe("500000");
    expect(inventory.USDT?.toString()).toBe("4.99");
  });

  test("re-quotes and retries a known partial recovery fill", async () => {
    const ethIrt = book("ETHIRT", "ETH", "IRT", "100000", "100100", "10");
    const client = new MockClient( [ethIrt], [
      order({
        id: "recovery-1", status: "Canceled", amount: new Decimal(2), matchedAmount: new Decimal(1),
        unmatchedAmount: new Decimal(1), totalPrice: new Decimal(1_000_000), averagePrice: new Decimal(1_000_000)
      }),
      order({
        id: "recovery-2", status: "Done", amount: new Decimal(1), matchedAmount: new Decimal(1),
        unmatchedAmount: new Decimal(0), totalPrice: new Decimal(1_000_000), averagePrice: new Decimal(1_000_000)
      })
    ]);
    const phases: string[] = [];
    const result = await recoverIntermediateInventory({
      reason: "second leg failed",
      actualInputToman: 200_000,
      inventory: [{ asset: "ETH", amount: new Decimal(2) }],
      settings,
      options,
      client,
      now: () => now,
      hooks: { onRecoveryLeg: event => { phases.push(`${event.phase}:${event.attempt}`); } }
    });

    expect(client.placed).toHaveLength(2);
    expect(client.placed.every(item => item.side === "SELL" && item.quote === "IRT")).toBe(true);
    expect(result.recoveredToman.toString()).toBe("200000");
    expect(result.residualInventory).toHaveLength(0);
    expect(result.legs.map(leg => leg.orderId)).toEqual(["recovery-1", "recovery-2"]);
    expect(phases).toEqual(["submitted:1", "finalized:1", "submitted:2", "finalized:2"]);
  });

  test("fails closed with an explicit manual-intervention error when recovery spread is unsafe", async () => {
    const unsafe = book("ETHIRT", "ETH", "IRT", "100000", "110000", "10");
    const client = new MockClient([unsafe], []);
    let manualHook = false;
    try {
      await recoverIntermediateInventory({
        reason: "route vanished",
        actualInputToman: 200_000,
        inventory: [{ asset: "ETH", amount: new Decimal(2) }],
        settings: { ...settings, maxSpreadBps: 50 },
        options,
        client,
        now: () => now,
        hooks: { onManualInterventionRequired: () => { manualHook = true; } }
      });
      throw new Error("Expected recovery to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(LiveManualInterventionError);
      expect((error as LiveManualInterventionError).manualInterventionRequired).toBe(true);
      expect((error as Error).message).toContain("MANUAL INTERVENTION REQUIRED");
      expect((error as LiveManualInterventionError).inventory[0]?.asset).toBe("ETH");
    }
    expect(client.placed).toHaveLength(0);
    expect(manualHook).toBe(true);
  });

  test("integrates recovery into executeLive after a confirmed partial first fill", async () => {
    const books = [
      book("USDTIRT", "USDT", "IRT", "99900", "100000", "100"),
      book("BTCUSDT", "BTC", "USDT", "49900", "50000", "100"),
      book("BTCIRT", "BTC", "IRT", "5100000000", "5110000000", "100")
    ];
    const opportunity = findTriangularOpportunities({
      books, options, capitalToman: 2_000_000, now,
      tomanFeeBps: 0, usdtFeeBps: 0, slippageBps: 0,
      maxPriceImpactBps: 100, maxSpreadBps: 200, depthUsagePercent: 100,
      minProfitBps: 0, minNetProfitToman: 0, maxAgeMs: 60_000
    }).find(item => item.route.join(",") === "IRT,USDT,BTC,IRT")!;
    const client = new MockClient(books, [
      order({
        id: "cycle-partial", status: "Canceled", amount: new Decimal(20), matchedAmount: new Decimal(10),
        unmatchedAmount: new Decimal(10), totalPrice: new Decimal(10_000_000), averagePrice: new Decimal(1_000_000)
      }),
      order({
        id: "auto-unwind", status: "Done", amount: new Decimal(10), matchedAmount: new Decimal(10),
        unmatchedAmount: new Decimal(0), totalPrice: new Decimal(9_990_000), averagePrice: new Decimal(999_000)
      })
    ]);
    const beforeNormal: number[] = [];
    const beforeRecovery: string[] = [];
    const persistedStages: string[] = [];

    try {
      await executeLive(opportunity, settings, client, {
        onBeforeOrder: index => { beforeNormal.push(index); },
        onBeforeRecoveryOrder: event => { beforeRecovery.push(`${event.asset}:${event.attempt}`); },
        onLeg: leg => { persistedStages.push(leg.stage ?? "legacy"); }
      }, { books, options });
      throw new Error("Expected the failed cycle to report recovery");
    } catch (error) {
      expect(error).toBeInstanceOf(LiveExecutionRecoveredError);
      const recovered = error as LiveExecutionRecoveredError;
      expect(recovered.manualInterventionRequired).toBe(false);
      expect(recovered.recovery.actualInputToman.toString()).toBe("1000000");
      expect(recovered.recovery.recoveredToman.toString()).toBe("999000");
      expect(recovered.recovery.legs[0]?.orderId).toBe("auto-unwind");
    }

    expect(client.placed.map(item => `${item.side}:${item.base}${item.quote}`)).toEqual(["BUY:USDTIRT", "SELL:USDTIRT"]);
    expect(beforeNormal).toEqual([0]);
    expect(beforeRecovery).toEqual(["USDT:1"]);
    expect(persistedStages).toContain("recovery");
  });

  test("a normal pre-order risk stop blocks the next leg but does not block emergency unwind", async () => {
    const books = [
      book("USDTIRT", "USDT", "IRT", "99900", "100000", "100"),
      book("BTCUSDT", "BTC", "USDT", "49900", "50000", "100"),
      book("BTCIRT", "BTC", "IRT", "5100000000", "5110000000", "100")
    ];
    const opportunity = findTriangularOpportunities({
      books, options, capitalToman: 2_000_000, now,
      tomanFeeBps: 0, usdtFeeBps: 0, slippageBps: 0,
      maxPriceImpactBps: 100, maxSpreadBps: 200, depthUsagePercent: 100,
      minProfitBps: 0, minNetProfitToman: 0, maxAgeMs: 60_000
    }).find(item => item.route.join(",") === "IRT,USDT,BTC,IRT")!;
    const client = new MockClient(books, [
      order({
        id: "cycle-full", status: "Done", amount: new Decimal(20), matchedAmount: new Decimal(20),
        unmatchedAmount: new Decimal(0), totalPrice: new Decimal(20_000_000), averagePrice: new Decimal(1_000_000)
      }),
      order({
        id: "risk-unwind", status: "Done", amount: new Decimal(20), matchedAmount: new Decimal(20),
        unmatchedAmount: new Decimal(0), totalPrice: new Decimal(19_980_000), averagePrice: new Decimal(999_000)
      })
    ]);
    const normalGates: number[] = [];
    let recoveryGate = 0;

    try {
      await executeLive(opportunity, settings, client, {
        onBeforeOrder: index => {
          normalGates.push(index);
          if (index === 1) throw new Error("risk control disarmed");
        },
        onBeforeRecoveryOrder: () => { recoveryGate += 1; }
      }, { books, options });
      throw new Error("Expected recovered-cycle error");
    } catch (error) {
      expect(error).toBeInstanceOf(LiveExecutionRecoveredError);
      expect((error as Error).message).toContain("risk control disarmed");
    }

    expect(normalGates).toEqual([0, 1]);
    expect(recoveryGate).toBe(1);
    expect(client.placed.map(item => `${item.side}:${item.base}${item.quote}`)).toEqual(["BUY:USDTIRT", "SELL:USDTIRT"]);
  });

  test("recovery accounting includes IRT already produced by a partial final leg", async () => {
    const books = [
      book("USDTIRT", "USDT", "IRT", "99900", "100000", "100"),
      book("BTCUSDT", "BTC", "USDT", "49900", "50000", "100"),
      book("BTCIRT", "BTC", "IRT", "5100000000", "5110000000", "100")
    ];
    const opportunity = findTriangularOpportunities({
      books, options, capitalToman: 2_000_000, now,
      tomanFeeBps: 0, usdtFeeBps: 0, slippageBps: 0,
      maxPriceImpactBps: 100, maxSpreadBps: 200, depthUsagePercent: 100,
      minProfitBps: 0, minNetProfitToman: 0, maxAgeMs: 60_000
    }).find(item => item.route.join(",") === "IRT,USDT,BTC,IRT")!;
    const client = new MockClient(books, [
      order({
        id: "leg-1", status: "Done", amount: new Decimal(20), matchedAmount: new Decimal(20),
        unmatchedAmount: new Decimal(0), totalPrice: new Decimal(20_000_000), averagePrice: new Decimal(1_000_000)
      }),
      order({
        id: "leg-2", status: "Done", amount: new Decimal("0.0004"), matchedAmount: new Decimal("0.0004"),
        unmatchedAmount: new Decimal(0), totalPrice: new Decimal(20), averagePrice: new Decimal(50_000)
      }),
      order({
        id: "leg-3-partial", status: "Canceled", amount: new Decimal("0.0004"), matchedAmount: new Decimal("0.0002"),
        unmatchedAmount: new Decimal("0.0002"), totalPrice: new Decimal(10_200_000), averagePrice: new Decimal(51_000_000_000)
      }),
      order({
        id: "btc-unwind", status: "Done", amount: new Decimal("0.0002"), matchedAmount: new Decimal("0.0002"),
        unmatchedAmount: new Decimal(0), totalPrice: new Decimal(10_200_000), averagePrice: new Decimal(51_000_000_000)
      })
    ]);

    try {
      await executeLive(opportunity, settings, client, {}, { books, options });
      throw new Error("Expected recovered-cycle error");
    } catch (error) {
      expect(error).toBeInstanceOf(LiveExecutionRecoveredError);
      const recovery = (error as LiveExecutionRecoveredError).recovery;
      expect(recovery.actualInputToman.toString()).toBe("2000000");
      expect(recovery.preRecoveryToman.toString()).toBe("1020000");
      expect(recovery.recoveredToman.toString()).toBe("2040000");
      expect(recovery.recoveredToman.minus(recovery.actualInputToman).toString()).toBe("40000");
    }
  });
});

describe("successful-cycle residual settlement", () => {
  test("sells a tradable quote residue and includes it in economic PnL", async () => {
    const books = [
      book("USDTIRT", "USDT", "IRT", "100000", "101000", "100"),
      book("BTCUSDT", "BTC", "USDT", "49900", "50000", "100"),
      book("BTCIRT", "BTC", "IRT", "5200000000", "5210000000", "100")
    ];
    const steppedOptions: MarketOptions = {
      ...options,
      amountSteps: { ...options.amountSteps, BTCUSDT: new Decimal("0.0003") }
    };
    const opportunity = findTriangularOpportunities({
      books, options: steppedOptions, capitalToman: 2_020_000, now,
      tomanFeeBps: 0, usdtFeeBps: 0, slippageBps: 0,
      maxPriceImpactBps: 100, maxSpreadBps: 200, depthUsagePercent: 100,
      minProfitBps: 0, minNetProfitToman: 0, maxAgeMs: 60_000
    }).find(item => item.route.join(",") === "IRT,USDT,BTC,IRT")!;
    const client = new MockClient(books, [
      order({
        id: "buy-usdt", status: "Done", amount: new Decimal(20), matchedAmount: new Decimal(20),
        unmatchedAmount: new Decimal(0), totalPrice: new Decimal(20_200_000), averagePrice: new Decimal(1_010_000)
      }),
      order({
        id: "buy-btc", status: "Done", amount: new Decimal("0.0003"), matchedAmount: new Decimal("0.0003"),
        unmatchedAmount: new Decimal(0), totalPrice: new Decimal(15), averagePrice: new Decimal(50_000)
      }),
      order({
        id: "sell-btc", status: "Done", amount: new Decimal("0.0003"), matchedAmount: new Decimal("0.0003"),
        unmatchedAmount: new Decimal(0), totalPrice: new Decimal(15_600_000), averagePrice: new Decimal(52_000_000_000)
      }),
      order({
        id: "settle-usdt", status: "Done", amount: new Decimal(5), matchedAmount: new Decimal(5),
        unmatchedAmount: new Decimal(0), totalPrice: new Decimal(5_000_000), averagePrice: new Decimal(1_000_000)
      })
    ]);

    const result = await executeLive(opportunity, settings, client, {}, { books, options: steppedOptions });

    expect(client.placed.map(item => `${item.side}:${item.base}${item.quote}`)).toEqual([
      "BUY:USDTIRT", "BUY:BTCUSDT", "SELL:BTCIRT", "SELL:USDTIRT"
    ]);
    expect(result.outputToman.toString()).toBe("2060000");
    expect(result.profitToman.toString()).toBe("40000");
    expect(result.realizedProfitToman.toString()).toBe("40000");
    expect(result.residualValueToman.toString()).toBe("0");
    expect(result.residualInventory).toHaveLength(0);
    expect(result.fullySettled).toBe(true);
    expect(result.legs.at(-1)?.stage).toBe("recovery");
  });

  test("reports and marks sub-minimum dust instead of valuing it at zero", async () => {
    const books = [
      book("USDTIRT", "USDT", "IRT", "100000", "101000", "100"),
      book("BTCUSDT", "BTC", "USDT", "49900", "50000", "100"),
      book("BTCIRT", "BTC", "IRT", "5200000000", "5210000000", "100")
    ];
    const steppedOptions: MarketOptions = {
      ...options,
      amountSteps: { ...options.amountSteps, BTCUSDT: new Decimal("0.000399") }
    };
    const opportunity = findTriangularOpportunities({
      books, options: steppedOptions, capitalToman: 2_020_000, now,
      tomanFeeBps: 0, usdtFeeBps: 0, slippageBps: 0,
      maxPriceImpactBps: 100, maxSpreadBps: 200, depthUsagePercent: 100,
      minProfitBps: 0, minNetProfitToman: 0, maxAgeMs: 60_000
    }).find(item => item.route.join(",") === "IRT,USDT,BTC,IRT")!;
    const client = new MockClient(books, [
      order({
        id: "buy-usdt", status: "Done", amount: new Decimal(20), matchedAmount: new Decimal(20),
        unmatchedAmount: new Decimal(0), totalPrice: new Decimal(20_200_000), averagePrice: new Decimal(1_010_000)
      }),
      order({
        id: "buy-btc", status: "Done", amount: new Decimal("0.000399"), matchedAmount: new Decimal("0.000399"),
        unmatchedAmount: new Decimal(0), totalPrice: new Decimal("19.95"), averagePrice: new Decimal(50_000)
      }),
      order({
        id: "sell-btc", status: "Done", amount: new Decimal("0.000399"), matchedAmount: new Decimal("0.000399"),
        unmatchedAmount: new Decimal(0), totalPrice: new Decimal(20_748_000), averagePrice: new Decimal(52_000_000_000)
      })
    ]);

    const result = await executeLive(opportunity, settings, client, {}, { books, options: steppedOptions });

    expect(client.placed).toHaveLength(3);
    expect(result.realizedOutputToman.toString()).toBe("2074800");
    expect(result.realizedProfitToman.toString()).toBe("54800");
    expect(result.residualInventory[0]?.asset).toBe("USDT");
    expect(result.residualInventory[0]?.amount.toString()).toBe("0.05");
    expect(result.residualValueToman.toString()).toBe("5000");
    expect(result.profitToman.toString()).toBe("59800");
    expect(result.fullySettled).toBe(false);
  });
});
