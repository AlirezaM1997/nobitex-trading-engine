import { describe, expect, test } from "bun:test";
import Decimal from "decimal.js";
import { findTriangularOpportunities, findTriangularOpportunitiesDetailed, quoteEdge } from "@/lib/bot/engine";
import { liveSafetyRejectionReason, realizedOrderOutput, repriceLiveOpportunity } from "@/lib/bot/executor";
import { botSettingsSchema, defaultBotSettings } from "@/lib/bot-settings";
import type { OrderBook } from "@/lib/exchanges/types";

const now = 1_800_000_000_000;
const book = (symbol: string, base: string, quote: string, bid: string, ask: string, amount = "1000000"): OrderBook => ({
  symbol, base, quote, lastUpdate: now,
  bids: [{ price: new Decimal(bid), amount: new Decimal(amount) }],
  asks: [{ price: new Decimal(ask), amount: new Decimal(amount) }]
});

describe("triangular engine", () => {
  test("finds a profitable IRT -> USDT -> BTC -> IRT cycle", () => {
    const books = [
      book("USDTIRT", "USDT", "IRT", "99900", "100000"),
      book("BTCUSDT", "BTC", "USDT", "49900", "50000"),
      book("BTCIRT", "BTC", "IRT", "5100000000", "5110000000")
    ];
    const result = findTriangularOpportunities({ books, capitalToman: 1_000_000, now, tomanFeeBps: 0, usdtFeeBps: 0, slippageBps: 0, minProfitBps: 1, minNetProfitToman: 1, maxAgeMs: 1000 });
    const route = result.find(x => x.route.join(",") === "IRT,USDT,BTC,IRT");
    expect(route).toBeDefined();
    expect(route!.outputToman.toFixed(0)).toBe("1020000");
    expect(route!.netProfitToman.toFixed(0)).toBe("20000");
    expect(route!.executable).toBe(true);
  });

  test("walks multiple orderbook levels and rejects insufficient depth", () => {
    const b = book("USDTIRT", "USDT", "IRT", "99000", "100000", "5");
    b.asks.push({ price: new Decimal("101000"), amount: new Decimal(5) });
    const buy = { id: "USDTIRT:BUY", from: "IRT", to: "USDT", side: "BUY" as const, book: b };
    const quote = quoteEdge(buy, 1_005_000, 0, 0);
    expect(quote?.levelsUsed).toBe(2);
    expect(quote?.output.toString()).toBe("10");
    expect(quoteEdge(buy, 1_005_001, 0, 0)).toBeUndefined();
  });

  test("reserves part of visible liquidity and reports depth consumption", () => {
    const b = book("USDTIRT", "USDT", "IRT", "99", "100", "10");
    const buy = { id: "USDTIRT:BUY", from: "IRT", to: "USDT", side: "BUY" as const, book: b };
    expect(quoteEdge(buy, 901, 0, 0, 90)).toBeUndefined();
    const quote = quoteEdge(buy, 900, 0, 0, 90);
    expect(quote?.output.toString()).toBe("9");
    expect(quote?.availableInput.toString()).toBe("900");
    expect(quote?.depthConsumedPercent.toString()).toBe("100");
  });

  test("measures weighted price impact across orderbook levels", () => {
    const b = book("USDTIRT", "USDT", "IRT", "99", "100", "5");
    b.asks.push({ price: new Decimal("110"), amount: new Decimal("5") });
    const buy = { id: "USDTIRT:BUY", from: "IRT", to: "USDT", side: "BUY" as const, book: b };
    const quote = quoteEdge(buy, 1_050, 0, 0);
    expect(quote?.levelsUsed).toBe(2);
    expect(quote?.bestPrice.toString()).toBe("100");
    expect(quote?.worstPrice.toString()).toBe("110");
    expect(quote?.priceImpactBps.gt(0)).toBe(true);
  });

  test("automatically reduces trade size when full capital has excessive market impact", () => {
    const usdtIrt = book("USDTIRT", "USDT", "IRT", "99000", "100000", "5");
    usdtIrt.asks.push({ price: new Decimal("110000"), amount: new Decimal("100") });
    const books = [
      usdtIrt,
      book("BTCUSDT", "BTC", "USDT", "0.999", "1", "1000000"),
      book("BTCIRT", "BTC", "IRT", "102000", "103000", "1000000")
    ];
    const result = findTriangularOpportunities({
      books, capitalToman: 1_000_000, now, tomanFeeBps: 0, usdtFeeBps: 0, slippageBps: 0,
      maxPriceImpactBps: 50, maxSpreadBps: 200, depthUsagePercent: 100,
      minProfitBps: 0, minNetProfitToman: 0, maxAgeMs: 1000
    });
    const route = result.find(x => x.route.join(",") === "IRT,USDT,BTC,IRT");
    expect(route?.inputToman.toString()).toBe("500000");
    expect(route?.requestedInputToman.toString()).toBe("1000000");
    expect(route?.sizedByDepth).toBe(true);
    expect(route?.sizingMode).toBe("optimized");
    expect(route?.liquiditySafe).toBe(true);
    expect(route?.netProfitToman.toString()).toBe("10000");
  });

  test("refines capital between coarse steps to capture more absolute profit", () => {
    const usdtIrt = book("USDTIRT", "USDT", "IRT", "99000", "100000", "5.3");
    usdtIrt.asks.push({ price: new Decimal("110000"), amount: new Decimal("100") });
    const result = findTriangularOpportunitiesDetailed({
      books: [usdtIrt, book("BTCUSDT", "BTC", "USDT", "0.999", "1"), book("BTCIRT", "BTC", "IRT", "102000", "103000")],
      capitalToman: 1_000_000, now, tomanFeeBps: 0, usdtFeeBps: 0, slippageBps: 0,
      maxPriceImpactBps: 50, maxSpreadBps: 200, depthUsagePercent: 100,
      minProfitBps: 0, minNetProfitToman: 0, maxAgeMs: 1000
    });
    const route = result.opportunities.find(item => item.route.join(",") === "IRT,USDT,BTC,IRT");
    expect(route?.inputToman.toString()).toBe("530000");
    expect(route?.netProfitToman.toString()).toBe("10600");
    expect(result.stats.refinedPathCount).toBeGreaterThan(0);
  });

  test("evaluates an exact first-leg depth boundary between fixed capital steps", () => {
    const usdtIrt = book("USDTIRT", "USDT", "IRT", "99", "100", "5370");
    usdtIrt.asks.push({ price: new Decimal("110"), amount: new Decimal("100000") });
    const result = findTriangularOpportunitiesDetailed({
      books: [usdtIrt, book("BTCUSDT", "BTC", "USDT", "0.999", "1"), book("BTCIRT", "BTC", "IRT", "102", "103")],
      capitalToman: 1_000_000, now, tomanFeeBps: 0, usdtFeeBps: 0, slippageBps: 0,
      maxPriceImpactBps: 10_000, maxSpreadBps: 200, depthUsagePercent: 100,
      minProfitBps: 0, minNetProfitToman: 0, maxAgeMs: 1_000
    });
    const route = result.opportunities.find(item => item.route.join(",") === "IRT,USDT,BTC,IRT");
    expect(route?.inputToman.toFixed(0)).toBe("537000");
    expect(route?.netProfitToman.toFixed(0)).toBe("10740");
  });

  test("maps a middle-leg depth boundary back to the exact initial Toman size", () => {
    const btcUsdt = book("BTCUSDT", "BTC", "USDT", "0.999", "1", "5370");
    btcUsdt.asks.push({ price: new Decimal("1.1"), amount: new Decimal("100000") });
    const result = findTriangularOpportunitiesDetailed({
      books: [book("USDTIRT", "USDT", "IRT", "99", "100"), btcUsdt, book("BTCIRT", "BTC", "IRT", "102", "103")],
      capitalToman: 1_000_000, now, tomanFeeBps: 0, usdtFeeBps: 0, slippageBps: 0,
      maxPriceImpactBps: 10_000, maxSpreadBps: 200, depthUsagePercent: 100,
      minProfitBps: 0, minNetProfitToman: 0, maxAgeMs: 1_000
    });
    const route = result.opportunities.find(item => item.route.join(",") === "IRT,USDT,BTC,IRT");
    expect(route?.inputToman.toFixed(0)).toBe("537000");
    expect(route?.netProfitToman.toFixed(0)).toBe("10740");
  });

  test("uses one depth evaluation for paths whose best prices cannot be profitable", () => {
    const result = findTriangularOpportunitiesDetailed({
      books: [book("USDTIRT", "USDT", "IRT", "99", "100"), book("BTCUSDT", "BTC", "USDT", "49", "50"), book("BTCIRT", "BTC", "IRT", "4900", "5000")],
      capitalToman: 1_000_000, now, tomanFeeBps: 0, usdtFeeBps: 0, slippageBps: 0,
      maxPriceImpactBps: 10_000, maxSpreadBps: 10_000, depthUsagePercent: 100,
      minProfitBps: 0, minNetProfitToman: 0, maxAgeMs: 1000
    });
    expect(result.stats.promisingPathCount).toBe(0);
    expect(result.stats.evaluatedSizeCount).toBe(result.opportunities.length);
    expect(result.opportunities.every(item => item.netProfitToman.lt(0))).toBe(true);
    expect(result.opportunities.every(item => item.sizingMode === "diagnostic-minimum")).toBe(true);
  });

  test("reprices and resizes the selected route again before live execution", () => {
    const initialBooks = [
      book("USDTIRT", "USDT", "IRT", "99000", "100000", "100"),
      book("BTCUSDT", "BTC", "USDT", "0.999", "1", "1000000"),
      book("BTCIRT", "BTC", "IRT", "102000", "103000", "1000000")
    ];
    const settings = botSettingsSchema.parse({
      ...defaultBotSettings,
      tomanTakerFeeBps: 0,
      usdtTakerFeeBps: 0,
      slippageBufferBps: 0,
      maxPriceImpactBps: 50,
      maxSpreadBps: 200,
      orderbookDepthUsagePercent: 100,
      minProfitBps: 0,
      minNetProfitToman: 0
    });
    const selected = findTriangularOpportunities({
      books: initialBooks,
      capitalToman: 1_000_000,
      now,
      tomanFeeBps: 0,
      usdtFeeBps: 0,
      slippageBps: 0,
      maxPriceImpactBps: 50,
      maxSpreadBps: 200,
      depthUsagePercent: 100,
      minProfitBps: 0,
      minNetProfitToman: 0,
      maxAgeMs: 1000
    }).find(item => item.route.join(",") === "IRT,USDT,BTC,IRT");
    expect(selected?.inputToman.toString()).toBe("1000000");

    const freshUsdtIrt = book("USDTIRT", "USDT", "IRT", "99000", "100000", "5");
    freshUsdtIrt.asks.push({ price: new Decimal("110000"), amount: new Decimal("100") });
    const fresh = repriceLiveOpportunity(selected!, settings, [freshUsdtIrt, initialBooks[1]!, initialBooks[2]!], {
      amountSteps: { USDTIRT: new Decimal("0.0001"), BTCUSDT: new Decimal("0.00000001"), BTCIRT: new Decimal("0.00000001") },
      priceSteps: { USDTIRT: new Decimal(1), BTCUSDT: new Decimal("0.01"), BTCIRT: new Decimal(1) },
      minOrderRial: new Decimal(500_000),
      minOrderUsdt: new Decimal(5)
    }, now);
    expect(fresh?.inputToman.toString()).toBe("500000");
    expect(fresh?.sizedByDepth).toBe(true);
    expect(fresh?.liquiditySafe).toBe(true);
  });

  test("subtracts fee and slippage from every conversion", () => {
    const b = book("BTCIRT", "BTC", "IRT", "100", "101");
    const sell = { id: "BTCIRT:SELL", from: "BTC", to: "IRT", side: "SELL" as const, book: b };
    const quote = quoteEdge(sell, 1, 100, 100);
    expect(quote?.output.toFixed(4)).toBe("98.0100");
  });

  test("uses separate taker fees for IRT and USDT markets", () => {
    const books = [
      book("USDTIRT", "USDT", "IRT", "99900", "100000"),
      book("BTCUSDT", "BTC", "USDT", "49900", "50000"),
      book("BTCIRT", "BTC", "IRT", "5100000000", "5110000000")
    ];
    const result = findTriangularOpportunities({ books, capitalToman: 1_000_000, now, tomanFeeBps: 100, usdtFeeBps: 200, slippageBps: 0, minProfitBps: 0, minNetProfitToman: 0, maxAgeMs: 1000 });
    const route = result.find(x => x.route.join(",") === "IRT,USDT,BTC,IRT");
    expect(route?.legs[0]?.fee.div(route.legs[0].grossOutput).toFixed(2)).toBe("0.01");
    expect(route?.legs[1]?.fee.div(route.legs[1].grossOutput).toFixed(2)).toBe("0.02");
    expect(route?.legs[2]?.fee.div(route.legs[2].grossOutput).toFixed(2)).toBe("0.01");
  });

  test("computes realized order output after the actual Nobitex fee", () => {
    const base = { id: "1", status: "Done", amount: new Decimal(10), unmatchedAmount: new Decimal(0), averagePrice: new Decimal(0), raw: {} };
    expect(realizedOrderOutput("BUY", "IRT", { ...base, matchedAmount: new Decimal("10"), totalPrice: new Decimal("1000000"), fee: new Decimal("0.025") }).toString()).toBe("9.975");
    expect(realizedOrderOutput("SELL", "IRT", { ...base, matchedAmount: new Decimal("10"), totalPrice: new Decimal("1000000"), fee: new Decimal("2500") }).toString()).toBe("99750");
    expect(realizedOrderOutput("SELL", "USDT", { ...base, matchedAmount: new Decimal("10"), totalPrice: new Decimal("5"), fee: new Decimal("0.0065") }).toString()).toBe("4.9935");
  });

  test("rejects a Live entry whose apparent profit does not cover the safety buffer", () => {
    const candidate = findTriangularOpportunities({
      books: [book("USDTIRT", "USDT", "IRT", "99900", "100000"), book("BTCUSDT", "BTC", "USDT", "49900", "50000"), book("BTCIRT", "BTC", "IRT", "5100000000", "5110000000")],
      capitalToman: 2_447_500, now, tomanFeeBps: 0, usdtFeeBps: 0, slippageBps: 0, minProfitBps: 0, minNetProfitToman: 0, maxAgeMs: 1000
    })[0]!;
    const settings = { ...defaultBotSettings, minProfitBps: 80, liveSafetyBufferBps: 150, minNetProfitToman: 10_000 };
    expect(liveSafetyRejectionReason({ ...candidate, netProfitToman: new Decimal(26_170) }, settings)).toContain("حد امن Live");
    expect(liveSafetyRejectionReason({ ...candidate, netProfitToman: new Decimal(60_000) }, settings)).toBeUndefined();
  });
});

describe("dashboard settings", () => {
  test("accepts settings saved before liquidity controls were added", () => {
    const legacy = { ...defaultBotSettings } as Partial<typeof defaultBotSettings>;
    delete legacy.maxPriceImpactBps;
    delete legacy.maxSpreadBps;
    delete legacy.orderbookDepthUsagePercent;
    delete legacy.liveSafetyBufferBps;
    const migrated = botSettingsSchema.parse(legacy);
    expect(migrated.maxPriceImpactBps).toBe(25);
    expect(migrated.maxSpreadBps).toBe(80);
    expect(migrated.orderbookDepthUsagePercent).toBe(40);
    expect(migrated.liveSafetyBufferBps).toBe(150);
  });

  test("does not allow scans faster than one second", () => {
    expect(() => botSettingsSchema.parse({ ...defaultBotSettings, scanIntervalMs: 999 })).toThrow();
  });
});

describe("live sizing and orderbook integrity", () => {
  const marketOptions = {
    amountSteps: {
      USDTIRT: new Decimal("0.0001"),
      BTCUSDT: new Decimal("0.00000001"),
      BTCIRT: new Decimal("0.00000001")
    },
    priceSteps: {
      USDTIRT: new Decimal(1),
      BTCUSDT: new Decimal("0.01"),
      BTCIRT: new Decimal(1)
    },
    minOrderRial: new Decimal(500_000),
    minOrderUsdt: new Decimal(1)
  };

  test("keeps a smaller Live-safe size when the larger absolute-profit size misses the Live return gate", () => {
    const usdtIrt = book("USDTIRT", "USDT", "IRT", "99", "100", "5000");
    usdtIrt.asks.push({ price: new Decimal("101.5"), amount: new Decimal(100_000) });
    const books = [
      usdtIrt,
      book("BTCUSDT", "BTC", "USDT", "0.999", "1", "1000000"),
      book("BTCIRT", "BTC", "IRT", "102.1", "103", "1000000")
    ];
    const common = {
      books, options: marketOptions, capitalToman: 1_000_000, now,
      tomanFeeBps: 0, usdtFeeBps: 0, slippageBps: 0,
      maxPriceImpactBps: 10_000, maxSpreadBps: 10_000, depthUsagePercent: 100,
      minProfitBps: 50, minNetProfitToman: 10_000, maxAgeMs: 1_000
    };
    const paper = findTriangularOpportunities(common)
      .find(item => item.route.join(",") === "IRT,USDT,BTC,IRT")!;
    const live = findTriangularOpportunities({ ...common, liveSafetyBufferBps: 150 })
      .find(item => item.route.join(",") === "IRT,USDT,BTC,IRT")!;

    expect(paper.inputToman.toString()).toBe("1000000");
    expect(paper.profitBps.lt(200)).toBe(true);
    expect(live.inputToman.lt(paper.inputToman)).toBe(true);
    expect(live.profitBps.gte(200)).toBe(true);
    expect(live.netProfitToman.gte(10_000)).toBe(true);
    expect(live.executable).toBe(true);
  });

  test("fails closed on crossed, future-dated, or cross-book-skewed snapshots", () => {
    const baseBooks = [
      book("USDTIRT", "USDT", "IRT", "99", "100"),
      book("BTCUSDT", "BTC", "USDT", "0.99", "1"),
      book("BTCIRT", "BTC", "IRT", "102", "103")
    ];
    const search = (books: OrderBook[]) => findTriangularOpportunities({
      books, options: marketOptions, capitalToman: 100_000, now,
      tomanFeeBps: 0, usdtFeeBps: 0, slippageBps: 0,
      maxPriceImpactBps: 10_000, maxSpreadBps: 10_000, depthUsagePercent: 100,
      minProfitBps: 0, minNetProfitToman: 0, maxAgeMs: 5_000
    });

    const crossed = baseBooks.map(item => ({ ...item, bids: [...item.bids], asks: [...item.asks] }));
    crossed[0]!.bids = [{ price: new Decimal(101), amount: new Decimal(1_000_000) }];
    expect(search(crossed)).toHaveLength(0);

    const future = baseBooks.map(item => ({ ...item, bids: [...item.bids], asks: [...item.asks] }));
    future[1]!.lastUpdate = now + 1_001;
    expect(search(future)).toHaveLength(0);

    const skewed = baseBooks.map(item => ({ ...item, bids: [...item.bids], asks: [...item.asks] }));
    skewed[2]!.lastUpdate = now - 1_001;
    expect(search(skewed)).toHaveLength(0);
  });

  test("requires official amount and price precision whenever market options are supplied", () => {
    const result = findTriangularOpportunities({
      books: [
        book("USDTIRT", "USDT", "IRT", "99", "100"),
        book("BTCUSDT", "BTC", "USDT", "0.99", "1"),
        book("BTCIRT", "BTC", "IRT", "102", "103")
      ],
      options: { ...marketOptions, priceSteps: {} },
      capitalToman: 100_000, now, tomanFeeBps: 0, usdtFeeBps: 0, slippageBps: 0,
      minProfitBps: 0, minNetProfitToman: 0, maxAgeMs: 1_000
    });
    expect(result).toHaveLength(0);
  });
});
