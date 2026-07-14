import { describe, expect, test } from "bun:test";
import Decimal from "decimal.js";
import type { OrderBook } from "@/lib/exchanges/types";
import type { OrderbookObservation } from "@/lib/strategies/orderbook-history";
import { clearOrderbookObservations, recordOrderbookObservations } from "@/lib/strategies/orderbook-history";
import { defaultStrategyLabSettings } from "@/lib/strategy-settings";
import {
  analyzeStatisticalPair,
  scanCrossQuoteInventory,
  scanOrderbookImbalance,
  scanStablecoinConvergence
} from "@/lib/strategies/engine";
import { measureAdjacentOrderbookGaps, scanOrderbookGaps } from "@/lib/strategies/orderbook-gap";

const now = 1_800_000_000_000;
const book = (symbol: string, base: string, quote: string, bid: number, ask: number, bidAmount = 1_000_000, askAmount = bidAmount): OrderBook => ({
  symbol, base, quote, lastUpdate: now,
  bids: [{ price: new Decimal(bid), amount: new Decimal(bidAmount) }],
  asks: [{ price: new Decimal(ask), amount: new Decimal(askAmount) }]
});
const depthBook = (bid: number, ask: number, bidAmounts: number[], askAmounts: number[]): OrderBook => ({
  symbol: "XIRT", base: "X", quote: "IRT", lastUpdate: now,
  bids: bidAmounts.map((amount, index) => ({ price: new Decimal(bid - index), amount: new Decimal(amount) })),
  asks: askAmounts.map((amount, index) => ({ price: new Decimal(ask + index), amount: new Decimal(amount) }))
});
const imbalanceContext = (observations: Array<{ observedAt: number; book: OrderBook }>) => ({
  orderbookHistory: new Map<string, readonly OrderbookObservation[]>([["XIRT", observations]])
});
const config = {
  settings: defaultStrategyLabSettings,
  tomanTakerFeeBps: 0,
  usdtTakerFeeBps: 0,
  slippageBps: 0,
  maxAgeMs: 5_000
};

describe("strategy lab", () => {
  test("does not count an unchanged REST orderbook as a new confirmation", () => {
    clearOrderbookObservations();
    const snapshot = depthBook(99, 101, [5_000, 5_000, 5_000], [1_000, 1_000, 1_000]);
    recordOrderbookObservations([snapshot], now - 1_000, { minSampleGapMs: 100 });
    const history = recordOrderbookObservations([snapshot], now, { minSampleGapMs: 100 });
    expect(history.get("XIRT")).toHaveLength(1);
  });
  test("finds a cross-quote inventory rotation relative to direct USDT conversion", () => {
    const settings = { ...defaultStrategyLabSettings, crossQuote: { ...defaultStrategyLabSettings.crossQuote, capitalToman: 100_000, minEdgeBps: 80, maxSpreadBps: 200, depthUsagePercent: 100 } };
    const signals = scanCrossQuoteInventory([
      book("USDTIRT", "USDT", "IRT", 99.9, 100),
      book("XIRT", "X", "IRT", 999, 1000),
      book("XUSDT", "X", "USDT", 11, 11.01)
    ], { ...config, settings }, now);
    expect(signals.some(signal => signal.status === "actionable" && signal.expectedEdgeBps.gt(0))).toBe(true);
  });

  test("computes beta and flags an extreme statistical spread", () => {
    const pricesB = Array.from({ length: 60 }, (_, index) => new Decimal(100 + index));
    const pricesA = pricesB.map((value, index) => value.mul(index === 59 ? 3 : 2));
    const signal = analyzeStatisticalPair({ assetA: "BTC", assetB: "ETH", pricesA, pricesB }, config, now);
    expect(signal).toBeDefined();
    expect(["actionable", "blocked"]).toContain(signal!.status);
    expect(Math.abs(Number(signal!.metrics.zScore))).toBeGreaterThan(2);
  });

  test("blocks a negatively related pair instead of treating correlation as a tradable hedge", () => {
    const pricesB = Array.from({ length: 80 }, (_, index) => new Decimal(100 + index));
    const pricesA = Array.from({ length: 80 }, (_, index) => new Decimal(300 - index));
    const signal = analyzeStatisticalPair({ assetA: "A", assetB: "B", pricesA, pricesB }, config, now);
    expect(signal).toBeDefined();
    expect(Number(signal!.metrics.beta)).toBeLessThan(0);
    expect(signal!.metrics.modelValidated).toBe(false);
    expect(signal!.status).toBe("blocked");
  });

  test("detects stablecoin convergence only after costs", () => {
    const settings = { ...defaultStrategyLabSettings, stablecoin: { ...defaultStrategyLabSettings.stablecoin, assets: "USDC", minDeviationBps: 100, maxSpreadBps: 100, capitalToman: 500_000 } };
    const signals = scanStablecoinConvergence([
      book("USDTIRT", "USDT", "IRT", 99.9, 100.1),
      book("USDCIRT", "USDC", "IRT", 94.9, 95.1)
    ], { ...config, settings }, now);
    expect(signals[0]?.status).toBe("actionable");
    expect(signals[0]?.action).toContain("Buy USDC");
  });

  test("keeps a stablecoin discount on watch when entry and exit depth cannot fill the configured capital", () => {
    const settings = {
      ...defaultStrategyLabSettings,
      stablecoin: {
        ...defaultStrategyLabSettings.stablecoin,
        assets: "USDC",
        minDeviationBps: 100,
        maxSpreadBps: 100,
        maxPriceImpactBps: 100,
        capitalToman: 500_000,
        depthUsagePercent: 40
      }
    };
    const signals = scanStablecoinConvergence([
      book("USDTIRT", "USDT", "IRT", 99.9, 100.1, 100_000),
      book("USDCIRT", "USDC", "IRT", 94.9, 95.1, 1)
    ], { ...config, settings }, now);
    expect(signals[0]?.status).toBe("watch");
    expect(signals[0]?.metrics.executionDepthSafe).toBe(false);
    expect(signals[0]?.reasons[0]).toContain("depth");
  });

  test("measures adjacent price gaps with a robust median/MAD baseline", () => {
    const gapBook: OrderBook = {
      symbol: "XIRT", base: "X", quote: "IRT", lastUpdate: now,
      bids: [99, 98.99, 98.98, 98.97, 98.96].map(price => ({ price: new Decimal(price), amount: new Decimal(1_000) })),
      asks: [101, 101.01, 101.02, 105, 105.01].map(price => ({ price: new Decimal(price), amount: new Decimal(1_000) }))
    };
    const measured = measureAdjacentOrderbookGaps(gapBook, "ASK", 5);
    expect(measured.candidate.index).toBe(2);
    expect(measured.candidate.gapBps.gt(300)).toBe(true);
    expect(measured.candidate.robustZScore.gt(3)).toBe(true);
  });

  test("keeps a persistent ask gap on watch until forward outcomes are calibrated", () => {
    const gapBook: OrderBook = {
      symbol: "XIRT", base: "X", quote: "IRT", lastUpdate: now,
      bids: [99, 98.99, 98.98, 98.97, 98.96].map(price => ({ price: new Decimal(price), amount: new Decimal(10_000) })),
      asks: [101, 101.01, 101.02, 105, 105.01].map(price => ({ price: new Decimal(price), amount: new Decimal(1_000) }))
    };
    const settings = {
      ...defaultStrategyLabSettings,
      gapTrading: {
        ...defaultStrategyLabSettings.gapTrading,
        enabled: true,
        levels: 5,
        minGapBps: 100,
        minGapZScore: 3,
        minConfirmations: 2,
        minPersistenceMs: 1_000,
        minBidSupportRatio: 1,
        minMicropriceBiasBps: 0,
        maxTopLevelSharePercent: 100,
        minVisibleDepthToman: 1_000,
        maxSpreadBps: 500,
        maxPriceImpactBps: 1_000,
        depthUsagePercent: 100,
        capitalToman: 50_000,
        maxPreGapConsumptionPercent: 100,
        targetCapturePercent: 75,
        minProjectedNetBps: 0,
        safetyBufferBps: 0
      }
    };
    const context = { orderbookHistory: new Map<string, readonly OrderbookObservation[]>([["XIRT", [
      { observedAt: now - 1_000, book: gapBook },
      { observedAt: now, book: gapBook }
    ]]]) };
    const signal = scanOrderbookGaps([gapBook], { ...config, settings }, now, context).find(item => item.metrics.gapSide === "ASK");
    expect(signal?.status).toBe("watch");
    expect(signal?.metrics.analyticalSetupPassed).toBe(true);
    expect(signal?.metrics.spotExecutable).toBe(false);
    expect(signal?.metrics.liveBlocker).toBe("forward-outcome-calibration-incomplete");
  });

  test("blocks a bid-side liquidity gap because Spot cannot short it", () => {
    const gapBook: OrderBook = {
      symbol: "XIRT", base: "X", quote: "IRT", lastUpdate: now,
      bids: [99, 98.99, 95, 94.99, 94.98].map(price => ({ price: new Decimal(price), amount: new Decimal(1_000) })),
      asks: [101, 101.01, 101.02, 101.03, 101.04].map(price => ({ price: new Decimal(price), amount: new Decimal(1_000) }))
    };
    const settings = { ...defaultStrategyLabSettings, gapTrading: { ...defaultStrategyLabSettings.gapTrading, enabled: true, levels: 5, minGapBps: 100, minGapZScore: 3 } };
    const signal = scanOrderbookGaps([gapBook], { ...config, settings }, now)[0];
    expect(signal?.status).toBe("blocked");
    expect(signal?.metrics.direction).toBe("SHORT");
    expect(signal?.metrics.spotExecutable).toBe(false);
  });

  test("detects deep orderbook imbalance without claiming guaranteed profit", () => {
    const settings = { ...defaultStrategyLabSettings, imbalance: { ...defaultStrategyLabSettings.imbalance, levels: 1, capitalToman: 5_000, minVisibleDepthToman: 1_000, maxSpreadBps: 500, minRatio: 2, minConfirmations: 1, minOutcomeSamples: 0, minPersistenceMs: 0, minPressureDelta: 0, maxTopLevelSharePercent: 100, minMicropriceBiasBps: 0, stopLossBps: 500 } };
    const signals = scanOrderbookImbalance([book("XIRT", "X", "IRT", 99, 101, 1_000, 100)], { ...config, settings }, now);
    expect(signals[0]?.status).toBe("actionable");
    expect(signals[0]?.estimatedNetProfitToman.toString()).toBe("0");
    expect(signals[0]?.reasons.some(reason => reason.includes("not guaranteed"))).toBe(true);
  });

  test("keeps an otherwise valid imbalance on watch when round-trip friction consumes Stop Loss", () => {
    const settings = {
      ...defaultStrategyLabSettings,
      imbalance: {
        ...defaultStrategyLabSettings.imbalance,
        levels: 1,
        capitalToman: 250_000,
        minVisibleDepthToman: 1_000,
        maxSpreadBps: 100,
        minRatio: 2,
        minConfirmations: 1,
        minPersistenceMs: 0,
        minPressureDelta: 0,
        maxTopLevelSharePercent: 100,
        minMicropriceBiasBps: 0,
        stopLossBps: 80,
        maxLossToman: 7_500
      }
    };
    const signal = scanOrderbookImbalance(
      [book("XIRT", "X", "IRT", 255_735, 257_000, 3_000, 1_000)],
      { ...config, settings, tomanTakerFeeBps: 25, slippageBps: 10 },
      now
    )[0];

    expect(signal?.status).toBe("watch");
    expect(signal?.metrics.roundTripRiskPassed).toBe(false);
    expect(signal?.reasons[0]).toContain("round-trip cost");
  });

  test("keeps a one-snapshot imbalance on watch instead of trading a transient wall", () => {
    const settings = { ...defaultStrategyLabSettings, imbalance: { ...defaultStrategyLabSettings.imbalance, levels: 3, minVisibleDepthToman: 1_000, maxSpreadBps: 500, minRatio: 2, minConfirmations: 3, minPersistenceMs: 2_000, minPressureDelta: 0.05, minMicropriceBiasBps: 0 } };
    const balanced = depthBook(99, 101, [1_000, 1_000, 1_000], [1_000, 1_000, 1_000]);
    const wall = depthBook(99, 101, [5_000, 5_000, 5_000], [1_000, 1_000, 1_000]);
    const signal = scanOrderbookImbalance([wall], { ...config, settings }, now, imbalanceContext([
      { observedAt: now - 2_000, book: balanced },
      { observedAt: now, book: wall }
    ]))[0];
    expect(signal?.status).toBe("watch");
    expect(signal?.metrics.confirmations).toBe(1);
    expect(signal?.reasons[0]).toContain("Persistence");
  });

  test("accepts persistent multi-level pressure only after a measurable change point", () => {
    const settings = { ...defaultStrategyLabSettings, imbalance: { ...defaultStrategyLabSettings.imbalance, levels: 3, capitalToman: 50_000, minVisibleDepthToman: 1_000, maxSpreadBps: 500, minRatio: 2, minConfirmations: 3, minOutcomeSamples: 0, minPersistenceMs: 2_000, minPressureDelta: 0.05, minMicropriceBiasBps: 0, stopLossBps: 500 } };
    const balanced = depthBook(99, 101, [1_000, 1_000, 1_000], [1_000, 1_000, 1_000]);
    const pressure = depthBook(99, 101, [5_000, 5_000, 5_000], [1_000, 1_000, 1_000]);
    const signal = scanOrderbookImbalance([pressure], { ...config, settings }, now, imbalanceContext([
      { observedAt: now - 4_000, book: balanced },
      { observedAt: now - 2_000, book: pressure },
      { observedAt: now - 1_000, book: pressure },
      { observedAt: now, book: pressure }
    ]))[0];
    expect(signal?.status).toBe("actionable");
    expect(Number(signal?.metrics.confirmations)).toBe(3);
    expect(Number(signal?.metrics.changePointScore)).toBeGreaterThanOrEqual(0.05);
    expect(signal?.metrics.temporalConfirmed).toBe(true);
    expect(signal?.metrics.executionDepthSafe).toBe(true);
  });

  test("blocks a bid-heavy signal when midpoint falls and indicates absorption", () => {
    const settings = { ...defaultStrategyLabSettings, imbalance: { ...defaultStrategyLabSettings.imbalance, levels: 3, capitalToman: 50_000, minVisibleDepthToman: 1_000, maxSpreadBps: 500, minRatio: 2, minConfirmations: 3, minPersistenceMs: 2_000, minPressureDelta: 0.05, minMicropriceBiasBps: 0, maxAdverseMoveBps: 15 } };
    const balanced = depthBook(99, 101, [1_000, 1_000, 1_000], [1_000, 1_000, 1_000]);
    const pressure = depthBook(99, 101, [5_000, 5_000, 5_000], [1_000, 1_000, 1_000]);
    const fallingPressure = depthBook(98, 100, [5_000, 5_000, 5_000], [1_000, 1_000, 1_000]);
    const signal = scanOrderbookImbalance([fallingPressure], { ...config, settings }, now, imbalanceContext([
      { observedAt: now - 4_000, book: balanced },
      { observedAt: now - 2_000, book: pressure },
      { observedAt: now - 1_000, book: pressure },
      { observedAt: now, book: fallingPressure }
    ]))[0];
    expect(signal?.status).toBe("watch");
    expect(signal?.metrics.priceConfirmationPassed).toBe(false);
    expect(signal?.reasons[0]).toContain("Absorption");
  });

  test("rejects an imbalance concentrated in one spoofable top-level wall", () => {
    const settings = { ...defaultStrategyLabSettings, imbalance: { ...defaultStrategyLabSettings.imbalance, levels: 3, capitalToman: 50_000, minVisibleDepthToman: 1_000, maxSpreadBps: 500, minRatio: 2, minConfirmations: 1, minPersistenceMs: 0, minPressureDelta: 0, maxTopLevelSharePercent: 70, minMicropriceBiasBps: 0 } };
    const wall = depthBook(99, 101, [5_000, 10, 10], [1_000, 1_000, 1_000]);
    const signal = scanOrderbookImbalance([wall], { ...config, settings }, now)[0];
    expect(signal?.status).toBe("watch");
    expect(signal?.metrics.spoofingGuardPassed).toBe(false);
    expect(signal?.reasons[0]).toContain("Spoofing");
  });
});
