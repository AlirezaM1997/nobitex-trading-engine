import Decimal from "decimal.js";
import { bookSpreadBps, quoteEdge } from "@/lib/bot/engine";
import type { Level, OrderBook } from "@/lib/exchanges/types";
import { measureOrderbookImbalance } from "./orderbook-imbalance";
import type { OrderbookObservation } from "./orderbook-history";
import type { StrategyLabConfig, StrategyLabContext, StrategySignal } from "./types";

const BPS = new Decimal(10_000);
const MAD_NORMALIZATION = new Decimal("1.4826");

export type GapSide = "ASK" | "BID";

export type AdjacentOrderbookGap = {
  side: GapSide;
  index: number;
  nearPrice: Decimal;
  farPrice: Decimal;
  gapBps: Decimal;
  medianGapBps: Decimal;
  madGapBps: Decimal;
  robustZScore: Decimal;
  preGapBaseAmount: Decimal;
  preGapQuoteNotional: Decimal;
};

export type OrderbookGapMeasurement = {
  side: GapSide;
  levelCount: number;
  baselineLevelCount: number;
  gaps: AdjacentOrderbookGap[];
  candidate: AdjacentOrderbookGap;
};

/**
 * Measures empty price intervals between adjacent occupied levels. Log returns
 * make gaps comparable across differently priced assets. Median/MAD keeps one
 * extreme empty interval from moving its own anomaly baseline too much.
 */
export function measureAdjacentOrderbookGaps(
  book: OrderBook,
  side: GapSide,
  levels: number,
  baselineLevels: number = levels
): OrderbookGapMeasurement {
  const rows = normalizedLevels(book, side, Math.max(levels, baselineLevels));
  const candidateLevelCount = Math.min(rows.length, Math.max(4, Math.floor(levels)));
  const baselineLevelCount = Math.min(rows.length, Math.max(4, Math.floor(baselineLevels)));
  if (candidateLevelCount < 4 || baselineLevelCount < 4) throw new Error("At least four occupied price levels are required");

  const raw = rows.slice(0, baselineLevelCount - 1).map((near, index) => {
    const far = rows[index + 1];
    const ratio = side === "ASK" ? far.price.div(near.price) : near.price.div(far.price);
    if (ratio.lte(1)) throw new Error("Orderbook levels are not strictly ordered");
    return ratio.ln().mul(BPS);
  });
  const medianGapBps = median(raw);
  const madGapBps = median(raw.map(value => value.minus(medianGapBps).abs()));
  // A zero MAD is common in tick-sized books. A small median-relative floor
  // preserves a finite, deterministic score without hiding a genuine outlier.
  const robustScale = Decimal.max(
    madGapBps.mul(MAD_NORMALIZATION),
    medianGapBps.abs().mul("0.1"),
    "0.01"
  );

  let preGapBaseAmount = new Decimal(0);
  let preGapQuoteNotional = new Decimal(0);
  const gaps = raw.slice(0, candidateLevelCount - 1).map((gapBps, index) => {
    const near = rows[index];
    preGapBaseAmount = preGapBaseAmount.plus(near.amount);
    preGapQuoteNotional = preGapQuoteNotional.plus(near.price.mul(near.amount));
    return {
      side,
      index,
      nearPrice: near.price,
      farPrice: rows[index + 1].price,
      gapBps,
      medianGapBps,
      madGapBps,
      robustZScore: gapBps.minus(medianGapBps).div(robustScale),
      preGapBaseAmount,
      preGapQuoteNotional
    } satisfies AdjacentOrderbookGap;
  });
  const candidate = [...gaps].sort((left, right) =>
    right.robustZScore.comparedTo(left.robustZScore)
      || right.gapBps.comparedTo(left.gapBps)
      || left.index - right.index
  )[0];
  return { side, levelCount: candidateLevelCount, baselineLevelCount, gaps, candidate };
}

/**
 * REST snapshots cannot establish queue events or aggressive order flow. This
 * scanner therefore never emits `actionable`: a fully confirmed setup is only
 * a Shadow/Paper watch signal and every incomplete setup is explicitly blocked.
 */
export function scanOrderbookGaps(
  books: OrderBook[],
  config: StrategyLabConfig,
  now = Date.now(),
  context: StrategyLabContext = {}
): StrategySignal[] {
  const settings = config.settings.gapTrading;
  const signals: StrategySignal[] = [];

  for (const book of books) {
    if (book.quote !== "IRT") continue;
    const candidates = (["ASK", "BID"] as const).flatMap(side => {
      try {
        const measurement = measureAdjacentOrderbookGaps(book, side, settings.levels, settings.baselineLevels);
        const candidate = measurement.candidate;
        const gapRatio = candidate.gapBps.div(Decimal.max(candidate.medianGapBps, "0.01"));
        return candidate.gapBps.gte(settings.minGapBps)
          && candidate.robustZScore.gte(settings.minGapZScore)
          && gapRatio.gte(settings.minGapRatio)
          ? [{ measurement, candidate }]
          : [];
      } catch {
        return [];
      }
    });

    for (const { measurement, candidate } of candidates) {
      const longCandidate = candidate.side === "ASK";
      const fresh = Boolean(book.lastUpdate && book.lastUpdate <= now && now - book.lastUpdate <= config.maxAgeMs);
      const spread = bookSpreadBps(book);
      const spreadSafe = spread.lte(settings.maxSpreadBps);
      const source = context.orderbookHistory?.get(book.symbol) ?? [{ observedAt: now, book }];
      const persistence = measurePersistence(source, book, candidate, settings, now);

      let imbalance: ReturnType<typeof measureOrderbookImbalance> | undefined;
      try {
        imbalance = measureOrderbookImbalance(book, settings.levels, settings.levelWeightDecayPercent, 1);
      } catch {
        // The gates below remain false and the signal is blocked.
      }
      const visibleDepthSafe = Boolean(imbalance
        && Decimal.min(imbalance.bidDepthToman, imbalance.askDepthToman).gte(settings.minVisibleDepthToman));
      const bidSupportSafe = Boolean(imbalance?.bidHeavy && imbalance.ratio.gte(settings.minBidSupportRatio));
      const micropriceSafe = Boolean(imbalance?.micropriceBiasBps.gte(settings.minMicropriceBiasBps));
      const concentrationSafe = Boolean(
        imbalance?.bidHeavy
        && imbalance.dominantTopLevelSharePercent.lte(settings.maxTopLevelSharePercent)
      );

      const entry = longCandidate
        ? quote("BUY", book, settings.capitalToman, config.tomanTakerFeeBps, config.slippageBps, settings.depthUsagePercent)
        : undefined;
      const immediateExit = entry
        ? quote("SELL", book, entry.output, config.tomanTakerFeeBps, config.slippageBps, settings.depthUsagePercent)
        : undefined;
      const impactSafe = Boolean(
        entry
        && immediateExit
        && entry.priceImpactBps.lte(settings.maxPriceImpactBps)
        && immediateExit.priceImpactBps.lte(settings.maxPriceImpactBps)
      );
      const entryStopsBeforeGap = Boolean(entry && entry.worstPrice.lte(candidate.nearPrice));
      const usablePreGapLiquidityToman = candidate.preGapQuoteNotional.mul(settings.depthUsagePercent).div(100);
      const preGapConsumptionPercent = usablePreGapLiquidityToman.gt(0)
        ? new Decimal(settings.capitalToman).div(usablePreGapLiquidityToman).mul(100)
        : new Decimal(100);
      const preGapConsumptionSafe = entryStopsBeforeGap
        && preGapConsumptionPercent.lte(settings.maxPreGapConsumptionPercent);

      const currentRoundTripCostBps = immediateExit
        ? Decimal.max(0, new Decimal(settings.capitalToman).minus(immediateExit.output))
            .div(settings.capitalToman)
            .mul(BPS)
        : new Decimal(BPS);
      const capturedGapBps = candidate.gapBps.mul(settings.targetCapturePercent).div(100);
      const projectedNetBps = capturedGapBps
        .minus(currentRoundTripCostBps)
        .minus(settings.safetyBufferBps);
      const projectedNetSafe = projectedNetBps.gte(settings.minProjectedNetBps);
      const targetPrice = longCandidate
        ? candidate.nearPrice.mul(capturedGapBps.div(BPS).exp())
        : candidate.nearPrice.div(capturedGapBps.div(BPS).exp());

      const gates = {
        longCandidate,
        fresh,
        spreadSafe,
        gapAnomalySafe: true,
        persistenceSafe: persistence.safe,
        visibleDepthSafe,
        bidSupportSafe,
        micropriceSafe,
        concentrationSafe,
        impactSafe,
        preGapConsumptionSafe,
        projectedNetSafe
      };
      const failedGates = Object.entries(gates).filter(([, passed]) => !passed).map(([name]) => name);
      const analyticalSetupPassed = failedGates.length === 0;
      const reasons = gapReasons({
        analyticalSetupPassed,
        longCandidate,
        fresh,
        spreadSafe,
        persistenceSafe: persistence.safe,
        visibleDepthSafe,
        bidSupportSafe,
        micropriceSafe,
        concentrationSafe,
        impactSafe,
        preGapConsumptionSafe,
        projectedNetSafe,
        confirmations: persistence.confirmations,
        persistenceMs: persistence.persistenceMs
      });
      const confidence = gapConfidence({
        candidate,
        settings,
        persistence,
        bidSupportRatio: imbalance?.ratio,
        analyticalSetupPassed
      });

      signals.push({
        id: `gap:${book.symbol}:${candidate.side.toLowerCase()}:${candidate.index + 1}`,
        kind: "orderbook-gap",
        title: `${book.symbol} Liquidity Gap`,
        symbols: [book.symbol],
        action: longCandidate
          ? "Shadow: monitor an ask-side liquidity vacuum"
          : "Blocked: bid-side gap implies a Spot short",
        status: analyticalSetupPassed ? "watch" : "blocked",
        paperOnly: true,
        expectedEdgeBps: projectedNetBps,
        estimatedNetProfitToman: new Decimal(settings.capitalToman).mul(projectedNetBps).div(BPS),
        confidence,
        reasons,
        metrics: {
          gapSide: candidate.side,
          gapFromLevel: candidate.index + 1,
          gapToLevel: candidate.index + 2,
          observedLevels: measurement.levelCount,
          baselineLevels: measurement.baselineLevelCount,
          nearPrice: candidate.nearPrice.toNumber(),
          farPrice: candidate.farPrice.toNumber(),
          gapBps: candidate.gapBps.toNumber(),
          medianGapBps: candidate.medianGapBps.toNumber(),
          madGapBps: candidate.madGapBps.toNumber(),
          robustGapZScore: candidate.robustZScore.toNumber(),
          gapToMedianRatio: candidate.gapBps.div(Decimal.max(candidate.medianGapBps, "0.01")).toNumber(),
          confirmations: persistence.confirmations,
          persistenceMs: persistence.persistenceMs,
          temporalConfirmed: persistence.safe,
          spreadBps: spread.toNumber(),
          bidSupportRatio: imbalance?.ratio.toNumber() ?? 0,
          micropriceBiasBps: imbalance?.micropriceBiasBps.toNumber() ?? 0,
          dominantTopLevelSharePercent: imbalance?.dominantTopLevelSharePercent.toNumber() ?? 100,
          bidDepthToman: imbalance?.bidDepthToman.toNumber() ?? 0,
          askDepthToman: imbalance?.askDepthToman.toNumber() ?? 0,
          entryPriceImpactBps: entry?.priceImpactBps.toNumber() ?? -1,
          exitPriceImpactBps: immediateExit?.priceImpactBps.toNumber() ?? -1,
          currentRoundTripCostBps: currentRoundTripCostBps.toNumber(),
          rawPreGapLiquidityToman: candidate.preGapQuoteNotional.toNumber(),
          usablePreGapLiquidityToman: usablePreGapLiquidityToman.toNumber(),
          plannedPreGapConsumptionPercent: preGapConsumptionPercent.toNumber(),
          capturedGapBps: capturedGapBps.toNumber(),
          targetPrice: targetPrice.toNumber(),
          projectedNetBps: projectedNetBps.toNumber(),
          projectedNetProfitToman: new Decimal(settings.capitalToman).mul(projectedNetBps).div(BPS).toNumber(),
          analyticalSetupPassed,
          failedGates: failedGates.join(","),
          quoteAsset: book.quote,
          direction: longCandidate ? "LONG" : "SHORT",
          capitalToman: settings.capitalToman,
          spotExecutable: false,
          otcExecutable: false,
          snapshotOnly: true,
          liveBlocker: "event-level-orderflow-and-calibration-incomplete"
        },
        scannedAt: now
      });
    }
  }

  return signals
    .sort((left, right) => {
      if (left.status !== right.status) return left.status === "watch" ? -1 : 1;
      return right.confidence.comparedTo(left.confidence) || right.expectedEdgeBps.comparedTo(left.expectedEdgeBps);
    })
    .slice(0, 30);
}

type GapSettings = StrategyLabConfig["settings"]["gapTrading"];

function measurePersistence(
  observations: readonly OrderbookObservation[],
  currentBook: OrderBook,
  current: AdjacentOrderbookGap,
  settings: GapSettings,
  now: number
) {
  const recent = observations
    .filter(item => item.observedAt <= now && now - item.observedAt <= settings.sampleWindowMs)
    .slice(-Math.max(settings.minConfirmations * 4, 30));
  if (!recent.some(item => item.observedAt === now)) recent.push({ observedAt: now, book: currentBook });

  const samples = recent.flatMap(observation => {
    if (!observation.book) return [];
    try {
      const measured = measureAdjacentOrderbookGaps(
        observation.book,
        current.side,
        settings.levels,
        settings.baselineLevels
      ).candidate;
      const driftPercent = current.gapBps.gt(0)
        ? measured.gapBps.minus(current.gapBps).abs().div(current.gapBps).mul(100)
        : new Decimal(100);
      const boundaryDriftBps = Decimal.max(
        measured.nearPrice.div(current.nearPrice).ln().abs().mul(BPS),
        measured.farPrice.div(current.farPrice).ln().abs().mul(BPS)
      );
      const gapRatio = measured.gapBps.div(Decimal.max(measured.medianGapBps, "0.01"));
      const qualifies = measured.index === current.index
        && measured.gapBps.gte(settings.minGapBps)
        && measured.robustZScore.gte(settings.minGapZScore)
        && gapRatio.gte(settings.minGapRatio)
        && driftPercent.lte(settings.maxGapDriftPercent)
        && boundaryDriftBps.lte(settings.maxBoundaryDriftBps);
      return [{ observedAt: observation.observedAt, qualifies }];
    } catch {
      return [{ observedAt: observation.observedAt, qualifies: false }];
    }
  }).sort((left, right) => left.observedAt - right.observedAt);

  let onset = samples.length - 1;
  while (onset > 0 && samples[onset]?.qualifies && samples[onset - 1]?.qualifies) onset -= 1;
  const run = samples.slice(Math.max(0, onset)).filter(sample => sample.qualifies);
  const confirmations = run.length;
  const persistenceMs = run.length ? Math.max(0, now - run[0].observedAt) : 0;
  return {
    confirmations,
    persistenceMs,
    safe: confirmations >= settings.minConfirmations
      && persistenceMs >= settings.minPersistenceMs
      && persistenceMs <= settings.maxPersistenceMs
  };
}

function gapReasons(input: {
  analyticalSetupPassed: boolean;
  longCandidate: boolean;
  fresh: boolean;
  spreadSafe: boolean;
  persistenceSafe: boolean;
  visibleDepthSafe: boolean;
  bidSupportSafe: boolean;
  micropriceSafe: boolean;
  concentrationSafe: boolean;
  impactSafe: boolean;
  preGapConsumptionSafe: boolean;
  projectedNetSafe: boolean;
  confirmations: number;
  persistenceMs: number;
}) {
  if (input.analyticalSetupPassed) return [
    `گپ Ask در ${input.confirmations} نمونه و ${input.persistenceMs} میلی‌ثانیه پایدار مانده و فیلترهای ایستای نقدشوندگی را پاس کرده است`,
    "این فقط سیگنال Shadow/Paper است؛ اسنپ‌شات یک‌ثانیه‌ای جهت جریان سفارش و ترتیب رویدادها را ثابت نمی‌کند",
    "اجرای واقعی تا اتصال Event-level Order Flow و کالیبراسیون خارج از نمونه مسدود است"
  ];
  if (!input.longCandidate) return [
    "گپ در سمت Bid دیده شده است؛ بهره‌برداری جهت‌دار از آن به Short نیاز دارد و در Spot مجاز نیست",
    "این سیگنال عمداً مسدود شده و سفارش واقعی تولید نمی‌کند"
  ];
  const primary = !input.fresh
    ? "داده اردربوک تازه نیست"
    : !input.spreadSafe
      ? "اسپرد فعلی از سقف مجاز بیشتر است"
      : !input.persistenceSafe
        ? `پایداری گپ کافی نیست: ${input.confirmations} تأیید در ${input.persistenceMs} میلی‌ثانیه`
        : !input.visibleDepthSafe
          ? "عمق قابل مشاهده دو سمت برای تحلیل قابل اتکا کافی نیست"
          : !input.bidSupportSafe
            ? "عمق Bid از حرکت رو به بالا پشتیبانی نمی‌کند"
            : !input.micropriceSafe
              ? "Microprice جهت صعودی گپ را تأیید نمی‌کند"
              : !input.concentrationSafe
                ? "حجم سمت غالب بیش از حد در Level اول متمرکز است؛ ریسک Wall یا نقدینگی زودگذر بالاست"
                : !input.impactSafe
                  ? "اثر قیمت ورود یا خروج فوری برای سرمایه انتخاب‌شده زیاد است"
                  : !input.preGapConsumptionSafe
                    ? "سفارش فرضی سهم زیادی از نقدینگی پیش از گپ را مصرف می‌کند یا وارد خود گپ می‌شود"
                    : !input.projectedNetSafe
                      ? "سهم محافظه‌کارانه از گپ، هزینه رفت‌وبرگشت و حاشیه ایمنی را پوشش نمی‌دهد"
                      : "شرایط تحلیلی کامل نیست";
  return [primary, "موتور Gap در وضعیت Shadow/Paper است و اجازه اجرای واقعی ندارد"];
}

function gapConfidence(input: {
  candidate: AdjacentOrderbookGap;
  settings: GapSettings;
  persistence: { confirmations: number; safe: boolean };
  bidSupportRatio?: Decimal;
  analyticalSetupPassed: boolean;
}) {
  const anomaly = Decimal.min(25, input.candidate.robustZScore.div(input.settings.minGapZScore).mul(18));
  const magnitude = Decimal.min(20, input.candidate.gapBps.div(input.settings.minGapBps).mul(12));
  const persistence = Decimal.min(20, new Decimal(input.persistence.confirmations).div(input.settings.minConfirmations).mul(18));
  const support = input.bidSupportRatio
    ? Decimal.min(15, input.bidSupportRatio.div(input.settings.minBidSupportRatio).mul(10))
    : new Decimal(0);
  return Decimal.min(85, anomaly.plus(magnitude).plus(persistence).plus(support).plus(input.analyticalSetupPassed ? 5 : 0));
}

function normalizedLevels(book: OrderBook, side: GapSide, levels: number): Level[] {
  const aggregated = new Map<string, Level>();
  for (const level of side === "ASK" ? book.asks : book.bids) {
    if (level.price.lte(0) || level.amount.lte(0)) continue;
    const key = level.price.toString();
    const previous = aggregated.get(key);
    aggregated.set(key, previous
      ? { price: previous.price, amount: previous.amount.plus(level.amount) }
      : { price: level.price, amount: level.amount });
  }
  const rows = [...aggregated.values()]
    .sort((left, right) => side === "ASK"
      ? left.price.comparedTo(right.price)
      : right.price.comparedTo(left.price));
  return rows.slice(0, Math.max(4, Math.floor(levels)));
}

function median(values: Decimal[]) {
  if (!values.length) throw new Error("Median of an empty sample is undefined");
  const sorted = [...values].sort((left, right) => left.comparedTo(right));
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : sorted[middle - 1].plus(sorted[middle]).div(2);
}

function quote(
  side: "BUY" | "SELL",
  book: OrderBook,
  input: Decimal.Value,
  feeBps: Decimal.Value,
  slippageBps: Decimal.Value,
  depthUsagePercent: Decimal.Value
) {
  return quoteEdge({
    id: `${book.symbol}:${side}`,
    from: side === "BUY" ? book.quote : book.base,
    to: side === "BUY" ? book.base : book.quote,
    side,
    book
  }, input, feeBps, slippageBps, depthUsagePercent);
}
