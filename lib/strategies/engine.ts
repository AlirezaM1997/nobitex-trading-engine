import Decimal from "decimal.js";
import type { OrderBook } from "@/lib/exchanges/types";
import { bookSpreadBps, quoteEdge } from "@/lib/bot/engine";
import type { StrategyLabConfig, StrategyLabContext, StrategyLabScanResult, StrategySignal, StatisticalPairSeries } from "./types";
import { measureOrderbookImbalance } from "./orderbook-imbalance";
import { scanOrderbookGaps } from "./orderbook-gap";

const BPS = new Decimal(10_000);

export function scanStrategyLab(books: OrderBook[], config: StrategyLabConfig, context: StrategyLabContext = {}): StrategyLabScanResult {
  const now = context.now ?? Date.now();
  const signals: StrategySignal[] = [];
  if (!config.settings.enabled) return { scannedAt: now, signals, actionableCount: 0, watchCount: 0, enabledCount: 0, diagnostics: { disabled: true } };

  if (config.settings.crossQuote.enabled) signals.push(...scanCrossQuoteInventory(books, config, now));
  if (config.settings.pairs.enabled) {
    for (const series of context.statisticalPairs ?? []) {
      const signal = analyzeStatisticalPair(series, config, now);
      if (signal) signals.push(signal);
    }
  }
  if (config.settings.stablecoin.enabled) signals.push(...scanStablecoinConvergence(books, config, now));
  if (config.settings.gapTrading.enabled) signals.push(...scanOrderbookGaps(books, config, now, context));
  if (config.settings.imbalance.enabled) signals.push(...scanOrderbookImbalance(books, config, now, context));

  signals.sort((a, b) => {
    const rank = { actionable: 2, watch: 1, blocked: 0 };
    if (rank[a.status] !== rank[b.status]) return rank[b.status] - rank[a.status];
    return b.confidence.comparedTo(a.confidence) || b.expectedEdgeBps.comparedTo(a.expectedEdgeBps);
  });
  return {
    scannedAt: now,
    signals: signals.slice(0, 100),
    actionableCount: signals.filter(item => item.status === "actionable").length,
    watchCount: signals.filter(item => item.status === "watch").length,
    enabledCount: [config.settings.crossQuote.enabled, config.settings.pairs.enabled, config.settings.stablecoin.enabled, config.settings.gapTrading.enabled, config.settings.imbalance.enabled].filter(Boolean).length,
    diagnostics: { marketCount: books.length, pairSeriesCount: context.statisticalPairs?.length ?? 0, paperOnly: true }
  };
}

export function scanCrossQuoteInventory(books: OrderBook[], config: StrategyLabConfig, now = Date.now()) {
  const settings = config.settings.crossQuote;
  const bySymbol = new Map(books.map(book => [book.symbol, book]));
  const usdtIrt = bySymbol.get("USDTIRT");
  if (!usdtIrt || stale(usdtIrt, now, config.maxAgeMs)) return [];
  const benchmarkBuy = quote("BUY", usdtIrt, new Decimal(settings.capitalToman), config.tomanTakerFeeBps, config.slippageBps, settings.depthUsagePercent);
  if (!benchmarkBuy) return [];
  const signals: StrategySignal[] = [];
  for (const irt of books.filter(book => book.quote === "IRT" && book.base !== "USDT")) {
    const usdt = bySymbol.get(`${irt.base}USDT`);
    if (!usdt || stale(irt, now, config.maxAgeMs) || stale(usdt, now, config.maxAgeMs)) continue;
    const spreads = [bookSpreadBps(irt), bookSpreadBps(usdt), bookSpreadBps(usdtIrt)];
    const spreadSafe = spreads.every(value => value.lte(settings.maxSpreadBps));

    const buyBaseIrt = quote("BUY", irt, settings.capitalToman, config.tomanTakerFeeBps, config.slippageBps, settings.depthUsagePercent);
    const sellBaseUsdt = buyBaseIrt && quote("SELL", usdt, buyBaseIrt.output, config.usdtTakerFeeBps, config.slippageBps, settings.depthUsagePercent);
    if (sellBaseUsdt) {
      const edge = sellBaseUsdt.output.div(benchmarkBuy.output).minus(1).mul(BPS);
      signals.push(crossQuoteSignal(irt.base, "IRT → asset → USDT", [irt.symbol, usdt.symbol], edge, settings.capitalToman, spreadSafe, settings.minEdgeBps, now, spreads));
    }

    const buyBaseUsdt = quote("BUY", usdt, benchmarkBuy.output, config.usdtTakerFeeBps, config.slippageBps, settings.depthUsagePercent);
    const sellBaseIrt = buyBaseUsdt && quote("SELL", irt, buyBaseUsdt.output, config.tomanTakerFeeBps, config.slippageBps, settings.depthUsagePercent);
    if (sellBaseIrt) {
      const edge = sellBaseIrt.output.div(settings.capitalToman).minus(1).mul(BPS);
      signals.push(crossQuoteSignal(irt.base, "USDT → asset → IRT", [usdt.symbol, irt.symbol], edge, settings.capitalToman, spreadSafe, settings.minEdgeBps, now, spreads));
    }
  }
  return signals.filter(item => item.expectedEdgeBps.gt(-50)).sort((a, b) => b.expectedEdgeBps.comparedTo(a.expectedEdgeBps)).slice(0, 20);
}

export function analyzeStatisticalPair(series: StatisticalPairSeries, config: StrategyLabConfig, now = Date.now()): StrategySignal | undefined {
  const count = Math.min(series.pricesA.length, series.pricesB.length);
  if (count < 30) return undefined;
  const a = series.pricesA.slice(-count).map(value => new Decimal(value).ln());
  const b = series.pricesB.slice(-count).map(value => new Decimal(value).ln());
  if (a.some(value => !value.isFinite()) || b.some(value => !value.isFinite())) return undefined;
  const settings = config.settings.pairs;
  const validationCount = Math.max(5, Math.floor(count * settings.validationPercent / 100));
  const trainingCount = count - validationCount;
  if (trainingCount < 25) return undefined;
  const trainingA = a.slice(0, trainingCount);
  const trainingB = b.slice(0, trainingCount);
  const meanA = mean(trainingA), meanB = mean(trainingB);
  const covariance = mean(trainingA.map((value, index) => value.minus(meanA).mul(trainingB[index].minus(meanB))));
  const varianceA = mean(trainingA.map(value => value.minus(meanA).pow(2)));
  const varianceB = mean(trainingB.map(value => value.minus(meanB).pow(2)));
  if (varianceB.lte(0)) return undefined;
  const beta = covariance.div(varianceB);
  const spread = a.map((value, index) => value.minus(beta.mul(b[index])));
  const trainingSpread = spread.slice(0, trainingCount);
  const validationSpread = spread.slice(trainingCount);
  const spreadMean = mean(trainingSpread);
  const std = mean(trainingSpread.map(value => value.minus(spreadMean).pow(2))).sqrt();
  if (std.lte(0)) return undefined;
  const z = spread.at(-1)!.minus(spreadMean).div(std);
  const absZ = z.abs();
  const correlation = varianceA.gt(0)
    ? covariance.div(varianceA.sqrt().mul(varianceB.sqrt()))
    : new Decimal(0);
  const stationarity = residualStationarity(trainingSpread, spreadMean);
  const validationDriftZ = mean(validationSpread).minus(spreadMean).abs().div(std);
  const grossReversionBps = spread.at(-1)!.minus(spreadMean).exp().minus(1).abs().mul(BPS);
  const expectedEdgeBps = grossReversionBps.minus(settings.estimatedRoundTripCostBps);
  const modelReady = beta.gt(0)
    && correlation.gte(settings.minCorrelation)
    && stationarity.halfLifeBars <= settings.maxHalfLifeBars
    && stationarity.adfTStatistic <= settings.adfCriticalValue
    && validationDriftZ.lte(settings.maxValidationDriftZ);
  const stopBreached = absZ.gte(settings.maxZScore);
  const blocked = stopBreached || !modelReady;
  const actionable = absZ.gte(settings.entryZScore)
    && expectedEdgeBps.gte(settings.minExpectedNetBps)
    && !blocked;
  const action = z.gt(0)
    ? `Short ${series.assetA} / Long ${series.assetB}`
    : `Long ${series.assetA} / Short ${series.assetB}`;
  return {
    id: `pairs:${series.assetA}:${series.assetB}`,
    kind: "statistical-pairs",
    title: `${series.assetA}/${series.assetB} Pairs Trading`,
    symbols: [`${series.assetA}IRT`, `${series.assetB}IRT`],
    action: absZ.lte(settings.exitZScore) ? "Close / Mean reached" : action,
    status: blocked ? "blocked" : actionable ? "actionable" : "watch",
    paperOnly: true,
    expectedEdgeBps,
    estimatedNetProfitToman: Decimal.max(0, new Decimal(settings.notionalToman).mul(expectedEdgeBps).div(BPS)),
    confidence: Decimal.min(100, Decimal.max(0, absZ.div(settings.entryZScore).mul(45)
      .plus(correlation.mul(20)).plus(modelReady ? 20 : 0))),
    reasons: stopBreached
      ? ["Z-Score به حد توقف مدل رسیده است؛ ورود جدید مجاز نیست."]
      : !modelReady
        ? ["آزمون پایداری، همبستگی یا اعتبارسنجی خارج از نمونه رد شده است."]
        : actionable
          ? ["انحراف، پایداری مدل و بازده خالص برآوردی هم‌زمان تأیید شده‌اند.", "این سیگنال تا تکمیل کالیبراسیون فقط Shadow است."]
          : ["مدل معتبر است، اما انحراف یا بازده خالص هنوز به آستانه ورود نرسیده است."],
    metrics: {
      zScore: z.toNumber(), beta: beta.toNumber(), correlation: correlation.toNumber(),
      lookback: count, trainingSamples: trainingCount, validationSamples: validationCount,
      validationDriftZ: validationDriftZ.toNumber(), adfTStatistic: stationarity.adfTStatistic,
      halfLifeBars: stationarity.halfLifeBars, grossReversionBps: grossReversionBps.toNumber(),
      estimatedRoundTripCostBps: settings.estimatedRoundTripCostBps,
      modelValidated: modelReady, stopBreached, exitZScore: settings.exitZScore,
      model: "log-spread OLS + ADF/half-life + holdout"
    },
    scannedAt: now
  };
}

export function scanStablecoinConvergence(books: OrderBook[], config: StrategyLabConfig, now = Date.now()) {
  const settings = config.settings.stablecoin;
  const reference = books.find(book => book.symbol === "USDTIRT");
  if (!reference || stale(reference, now, config.maxAgeMs)) return [];
  const referenceMid = mid(reference);
  if (!referenceMid) return [];
  const assets = settings.assets.split(",").map(item => item.trim().toUpperCase()).filter(Boolean);
  return assets.flatMap(asset => {
    const book = books.find(item => item.symbol === `${asset}IRT`);
    const assetMid = book && mid(book);
    if (!book || !assetMid || stale(book, now, config.maxAgeMs)) return [];
    const deviation = assetMid.div(referenceMid).minus(1).mul(BPS);
    const gross = deviation.abs();
    const capital = new Decimal(settings.capitalToman);
    const entryQuote = quote("BUY", book, capital, config.tomanTakerFeeBps, config.slippageBps, settings.depthUsagePercent);
    const immediateExitQuote = entryQuote
      ? quote("SELL", book, entryQuote.output, config.tomanTakerFeeBps, config.slippageBps, settings.depthUsagePercent)
      : undefined;
    const exitMultiplier = new Decimal(1)
      .minus(new Decimal(config.tomanTakerFeeBps).div(BPS))
      .mul(new Decimal(1).minus(new Decimal(config.slippageBps).div(BPS)));
    const targetOutputToman = entryQuote?.output.mul(referenceMid).mul(exitMultiplier);
    const net = targetOutputToman
      ? targetOutputToman.div(capital).minus(1).mul(BPS)
      : new Decimal(-10_000);
    const immediateRoundTripCostBps = immediateExitQuote
      ? Decimal.max(0, capital.minus(immediateExitQuote.output).div(capital).mul(BPS))
      : new Decimal(10_000);
    const spreadSafe = bookSpreadBps(book).lte(settings.maxSpreadBps) && bookSpreadBps(reference).lte(settings.maxSpreadBps);
    const executionDepthSafe = Boolean(entryQuote && immediateExitQuote
      && entryQuote.priceImpactBps.lte(settings.maxPriceImpactBps)
      && immediateExitQuote.priceImpactBps.lte(settings.maxPriceImpactBps));
    // The current execution adapter starts and finishes in IRT and has no margin/borrow leg.
    // An overvalued stablecoin therefore remains a useful Paper signal, but it must never be
    // presented to the Spot executor as a short that it cannot honestly open.
    const longSpotExecutable = deviation.lt(0);
    const actionable = longSpotExecutable
      && gross.gte(settings.minDeviationBps)
      && net.gte(settings.takeProfitBps)
      && spreadSafe
      && executionDepthSafe;
    const blockedShort = !longSpotExecutable && gross.gte(settings.minDeviationBps) && spreadSafe;
    return [{
      id: `stablecoin:${asset}`,
      kind: "stablecoin" as const,
      title: `${asset}/USDT Convergence`,
      symbols: [book.symbol, reference.symbol],
      action: deviation.lt(0) ? `Buy ${asset} / Sell USDT` : `Sell or Short ${asset} / Buy USDT`,
      status: actionable ? "actionable" as const : blockedShort ? "blocked" as const : "watch" as const,
      paperOnly: true as const,
      expectedEdgeBps: net,
      estimatedNetProfitToman: Decimal.max(0, capital.mul(net).div(BPS)),
      confidence: Decimal.min(100, gross.div(settings.minDeviationBps || 1).mul(55)),
      reasons: actionable
        ? ["خرید واقعی در عمق بازار و خروج فرضی در Parity پس از هزینه‌ها سود خالص کافی دارد.", "این موتور تا کالیبراسیون Depeg و زمان همگرایی فقط Shadow است."]
        : !longSpotExecutable
          ? ["این جهت به Short نیاز دارد و با موجودی Spot تومانی قابل اجرا نیست."]
          : !spreadSafe
            ? ["اسپرد بازار دارایی یا مرجع بیش از حد مجاز است."]
            : !executionDepthSafe
              ? ["عمق یا اثر قیمت برای ورود و خروج کامل کافی نیست."]
              : ["بازده خالص پس از کارمزد، لغزش و هدف Parity به حد سود نرسیده است."],
      metrics: {
        deviationBps: deviation.toNumber(),
        grossDeviationBps: gross.toNumber(),
        projectedNetAtParityBps: net.toNumber(),
        immediateRoundTripCostBps: immediateRoundTripCostBps.toNumber(),
        entryPriceImpactBps: entryQuote?.priceImpactBps.toNumber() ?? -1,
        exitPriceImpactBps: immediateExitQuote?.priceImpactBps.toNumber() ?? -1,
        executionDepthSafe,
        targetOutputToman: targetOutputToman?.toNumber() ?? 0,
        spreadBps: bookSpreadBps(book).toNumber(),
        referenceSpreadBps: bookSpreadBps(reference).toNumber(),
        assetMidToman: assetMid.toNumber(),
        referenceMidToman: referenceMid.toNumber(),
        direction: longSpotExecutable ? "LONG" : "SHORT",
        spotExecutable: longSpotExecutable,
        exitDeviationBps: settings.exitDeviationBps,
        capitalToman: settings.capitalToman
      },
      scannedAt: now
    }];
  }).sort((a, b) => b.expectedEdgeBps.comparedTo(a.expectedEdgeBps));
}

export function scanOrderbookImbalance(books: OrderBook[], config: StrategyLabConfig, now = Date.now(), context: StrategyLabContext = {}) {
  const settings = config.settings.imbalance;
  const usdtIrt = books.find(book => book.symbol === "USDTIRT");
  const usdtToman = usdtIrt && mid(usdtIrt);
  const signals: StrategySignal[] = [];
  for (const book of books) {
    if (stale(book, now, config.maxAgeMs) || bookSpreadBps(book).gt(settings.maxSpreadBps)) continue;
    const conversion = book.quote === "IRT" ? new Decimal(1) : usdtToman;
    if (!conversion) continue;
    let current: ReturnType<typeof measureOrderbookImbalance>;
    try {
      current = measureOrderbookImbalance(book, settings.levels, settings.levelWeightDecayPercent, conversion);
    } catch {
      continue;
    }
    if (Decimal.min(current.bidDepthToman, current.askDepthToman).lt(settings.minVisibleDepthToman)) continue;
    if (current.ratio.lt(settings.minRatio)) continue;
    const bidHeavy = current.bidHeavy;

    const sourceObservations = context.orderbookHistory?.get(book.symbol) ?? [{ observedAt: now, book }];
    const observations = sourceObservations
      .filter(item => item.observedAt <= now && now - item.observedAt <= settings.sampleWindowMs)
      .slice(-Math.max(settings.minConfirmations * 3, settings.minOutcomeSamples * 3, 20));
    if (!observations.some(item => item.observedAt === now)) observations.push({ observedAt: now, book });
    const samples = observations.flatMap(observation => {
      try {
        return [{ observedAt: observation.observedAt, measurement: measureOrderbookImbalance(observation.book, settings.levels, settings.levelWeightDecayPercent, conversion) }];
      } catch {
        return [];
      }
    }).sort((a, b) => a.observedAt - b.observedAt);
    const direction = bidHeavy ? 1 : -1;
    const realizedOutcomesBps: number[] = [];
    for (let index = 0; index < samples.length - 1; index += 1) {
      const source = samples[index];
      if (source.measurement.bidHeavy !== bidHeavy || source.measurement.ratio.lt(settings.minRatio)) continue;
      const target = samples.slice(index + 1)
        .find(item => item.observedAt - source.observedAt >= settings.predictionHorizonMs);
      if (!target) continue;
      realizedOutcomesBps.push(target.measurement.midpoint.div(source.measurement.midpoint)
        .minus(1).mul(BPS).mul(direction).toNumber());
    }
    const outcomeHitRatePercent = realizedOutcomesBps.length
      ? realizedOutcomesBps.filter(value => value > 0).length / realizedOutcomesBps.length * 100
      : 0;
    const conservativeForecastBps = percentile(realizedOutcomesBps, 0.25);
    const qualifies = (sample: typeof samples[number]) => sample.measurement.bidHeavy === bidHeavy && sample.measurement.ratio.gte(settings.minRatio);
    let onsetIndex = samples.length - 1;
    while (onsetIndex > 0 && qualifies(samples[onsetIndex - 1])) onsetIndex -= 1;
    const confirmations = samples.slice(onsetIndex).filter(qualifies).length;
    const persistenceMs = samples.length ? Math.max(0, now - samples[onsetIndex].observedAt) : 0;
    const baseline = samples[Math.max(0, onsetIndex - 1)]?.measurement ?? current;
    const pressureDelta = current.normalized.minus(baseline.normalized).mul(direction);
    const favorableMidMoveBps = current.midpoint.div(baseline.midpoint).minus(1).mul(BPS).mul(direction);
    let cusum = new Decimal(0);
    for (const sample of samples.slice(Math.max(0, onsetIndex - 1))) {
      const directionalDeviation = sample.measurement.normalized.minus(baseline.normalized).mul(direction).minus("0.01");
      cusum = Decimal.max(0, cusum.plus(directionalDeviation));
    }
    const changePointScore = Decimal.max(pressureDelta, cusum);
    const persistenceSafe = confirmations >= settings.minConfirmations
      && persistenceMs >= settings.minPersistenceMs
      && persistenceMs <= settings.maxPersistenceMs;
    const changePointSafe = changePointScore.gte(settings.minPressureDelta);
    const concentrationSafe = current.dominantTopLevelSharePercent.lte(settings.maxTopLevelSharePercent);
    const micropriceSafe = bidHeavy
      ? current.micropriceBiasBps.gte(settings.minMicropriceBiasBps)
      : current.micropriceBiasBps.lte(-settings.minMicropriceBiasBps);
    const priceResponseSafe = favorableMidMoveBps.gte(-settings.maxAdverseMoveBps);
    // Like Stablecoin Convergence, this Spot adapter is IRT-funded and cannot create a
    // synthetic short. Ask-heavy signals remain visible but are explicitly blocked.
    const longSpotExecutable = bidHeavy && book.quote === "IRT";
    const executionQuote = longSpotExecutable
      ? quote("BUY", book, settings.capitalToman, config.tomanTakerFeeBps, config.slippageBps, settings.depthUsagePercent)
      : undefined;
    const immediateExitQuote = executionQuote
      ? quote("SELL", book, executionQuote.output, config.tomanTakerFeeBps, config.slippageBps, settings.depthUsagePercent)
      : undefined;
    const priceImpactBps = executionQuote?.priceImpactBps;
    const exitPriceImpactBps = immediateExitQuote?.priceImpactBps;
    const executionDepthSafe = Boolean(
      executionQuote
      && immediateExitQuote
      && priceImpactBps?.lte(settings.maxPriceImpactBps)
      && exitPriceImpactBps?.lte(settings.maxPriceImpactBps)
    );
    const projectedRoundTripLossToman = immediateExitQuote
      ? Decimal.max(new Decimal(settings.capitalToman).minus(immediateExitQuote.output), 0)
      : new Decimal(settings.capitalToman);
    const projectedRoundTripCostBps = new Decimal(settings.capitalToman).gt(0)
      ? projectedRoundTripLossToman.div(settings.capitalToman).mul(BPS)
      : new Decimal(BPS);
    const roundTripSafetyHeadroomBps = Decimal.max(new Decimal(config.slippageBps).mul(2), 10);
    const projectedWorstRoundTripLossToman = projectedRoundTripLossToman.plus(
      new Decimal(settings.capitalToman).mul(roundTripSafetyHeadroomBps).div(BPS)
    );
    const roundTripRiskSafe = projectedRoundTripCostBps.plus(roundTripSafetyHeadroomBps).lt(settings.stopLossBps)
      && projectedWorstRoundTripLossToman.lt(settings.maxLossToman);
    const predictedNetBps = new Decimal(conservativeForecastBps)
      .minus(projectedRoundTripCostBps)
      .minus(settings.forecastSafetyBps);
    const outcomeCalibrated = settings.minOutcomeSamples === 0 || (
      realizedOutcomesBps.length >= settings.minOutcomeSamples
      && outcomeHitRatePercent >= settings.minOutcomeHitRatePercent
      && predictedNetBps.gte(settings.minPredictedNetBps)
    );
    const actionable = longSpotExecutable
      && persistenceSafe
      && changePointSafe
      && concentrationSafe
      && micropriceSafe
      && priceResponseSafe
      && executionDepthSafe
      && roundTripRiskSafe
      && outcomeCalibrated;
    const reasons = actionable
      ? [
          `فشار خرید در ${confirmations} نمونه و ${persistenceMs} میلی‌ثانیه تأیید شده است`,
          "وزن سطوح نزدیک، Microprice و اثر قیمت اجرای واقعی هم‌جهت هستند",
          `کالیبراسیون ${realizedOutcomesBps.length} خروجی تاریخی، Hit Rate ${outcomeHitRatePercent.toFixed(1)}٪ و بازده خالص ${predictedNetBps.toFixed(2)} BPS را تأیید کرده است`,
          "نقدینگی نمایشی می‌تواند لغو یا پنهان شود؛ سود تضمین‌شده نیست و این موتور فعلاً Shadow است."
        ]
      : [
          !longSpotExecutable
            ? bidHeavy ? "این بازار تومانی نیست و اجرای Long Spot ندارد" : "فشار سمت Ask است و موتور Spot امکان Short ندارد"
            : !persistenceSafe
              ? `سیگنال هنوز تداوم کافی ندارد: ${confirmations}/${settings.minConfirmations} نمونه، ${persistenceMs}ms`
              : !changePointSafe
                ? "افزایش فشار نسبت به خط پایه برای Change Point کافی نیست"
                : !concentrationSafe
                  ? "حجم غالب بیش از حد روی Level اول متمرکز است؛ احتمال Wall یا Spoofing بالاست"
                  : !micropriceSafe
                    ? "Microprice حرکت احتمالی را در جهت سیگنال تأیید نمی‌کند"
                    : !priceResponseSafe
                      ? "قیمت میانی برخلاف فشار اردربوک حرکت کرده؛ احتمال Absorption وجود دارد"
                      : !executionDepthSafe
                        ? "عمق قابل اجرا یا اثر قیمت برای سرمایه تنظیم‌شده مناسب نیست"
                        : !roundTripRiskSafe
                          ? `هزینه رفت‌وبرگشت ${projectedRoundTripCostBps.toFixed(2)} BPS با Stop Loss ${settings.stopLossBps} BPS حاشیه امن ندارد`
                          : `کالیبراسیون Shadow کافی نیست: ${realizedOutcomesBps.length}/${settings.minOutcomeSamples} نمونه، Hit Rate ${outcomeHitRatePercent.toFixed(1)}٪، بازده خالص محافظه‌کارانه ${predictedNetBps.toFixed(2)} BPS`,
          "تنها Snapshotهای جدید صرافی شمرده می‌شوند و اجرای واقعی تا اثبات بازده خارج از نمونه مسدود است."
        ];
    const confidence = Decimal.min(90,
      Decimal.min(25, current.ratio.div(settings.minRatio).mul(18))
        .plus(Decimal.min(20, new Decimal(confirmations).div(Math.max(1, settings.minConfirmations)).mul(18)))
        .plus(Decimal.min(20, changePointScore.div(settings.minPressureDelta || 1).mul(15)))
        .plus(concentrationSafe ? 12 : 0)
        .plus(micropriceSafe ? 10 : 0)
        .plus(executionDepthSafe ? 8 : 0)
    );
    signals.push({
      id: `imbalance:${book.symbol}`,
      kind: "orderbook-imbalance",
      title: `${book.symbol} Weighted Imbalance`,
      symbols: [book.symbol],
      action: bidHeavy ? "Momentum Long after confirmation" : "Monitor sell pressure (no Spot short)",
      status: actionable ? "actionable" : longSpotExecutable ? "watch" : "blocked",
      paperOnly: true,
      expectedEdgeBps: outcomeCalibrated ? predictedNetBps : new Decimal(0),
      estimatedNetProfitToman: outcomeCalibrated
        ? Decimal.max(0, new Decimal(settings.capitalToman).mul(predictedNetBps).div(BPS))
        : new Decimal(0),
      confidence,
      reasons,
      metrics: {
        ratio: current.ratio.toNumber(),
        normalizedImbalance: current.normalized.toNumber(),
        bidDepthToman: current.bidDepthToman.toNumber(),
        askDepthToman: current.askDepthToman.toNumber(),
        weightedBidDepthToman: current.weightedBidDepthToman.toNumber(),
        weightedAskDepthToman: current.weightedAskDepthToman.toNumber(),
        levels: settings.levels,
        levelWeightDecayPercent: settings.levelWeightDecayPercent,
        spreadBps: bookSpreadBps(book).toNumber(),
        priceImpactBps: priceImpactBps?.toNumber() ?? -1,
        exitPriceImpactBps: exitPriceImpactBps?.toNumber() ?? -1,
        projectedRoundTripCostBps: projectedRoundTripCostBps.toNumber(),
        projectedRoundTripLossToman: projectedRoundTripLossToman.toNumber(),
        roundTripRiskPassed: roundTripRiskSafe,
        predictionHorizonMs: settings.predictionHorizonMs,
        outcomeSampleCount: realizedOutcomesBps.length,
        outcomeHitRatePercent,
        conservativeForecastBps,
        predictedNetBps: predictedNetBps.toNumber(),
        outcomeCalibrated,
        micropriceBiasBps: current.micropriceBiasBps.toNumber(),
        dominantTopLevelSharePercent: current.dominantTopLevelSharePercent.toNumber(),
        confirmations,
        persistenceMs,
        pressureDelta: pressureDelta.toNumber(),
        cusumScore: cusum.toNumber(),
        changePointScore: changePointScore.toNumber(),
        favorableMidMoveBps: favorableMidMoveBps.toNumber(),
        temporalConfirmed: persistenceSafe && changePointSafe,
        spoofingGuardPassed: concentrationSafe,
        priceConfirmationPassed: micropriceSafe && priceResponseSafe,
        executionDepthSafe,
        direction: bidHeavy ? "LONG" : "SHORT",
        spotExecutable: longSpotExecutable,
        quoteAsset: book.quote,
        exitRatio: settings.exitRatio,
        capitalToman: settings.capitalToman
      },
      scannedAt: now
    });
  }
  return signals.sort((a, b) => b.confidence.comparedTo(a.confidence)).slice(0, 20);
}

function crossQuoteSignal(asset: string, action: string, symbols: string[], edge: Decimal, capital: number, spreadSafe: boolean, threshold: number, now: number, spreads: Decimal[]): StrategySignal {
  const actionable = edge.gte(threshold) && spreadSafe;
  return {
    id: `cross:${asset}:${action.startsWith("IRT") ? "to-usdt" : "to-irt"}`,
    kind: "cross-quote",
    title: `${asset} Cross-Quote Inventory`,
    symbols,
    action,
    status: actionable ? "actionable" : "watch",
    paperOnly: true,
    expectedEdgeBps: edge,
    estimatedNetProfitToman: new Decimal(capital).mul(edge).div(BPS),
    confidence: Decimal.min(100, Decimal.max(0, edge).div(threshold || 1).mul(60)),
    reasons: actionable ? ["مسیر دو سفارش نسبت به تبدیل مستقیم برتری دارد", "خروجی در معرض ریسک موجودی USDT/IRT است"] : [spreadSafe ? "برتری خالص هنوز به آستانه نرسیده است" : "اسپرد یکی از بازارها بیش از حد مجاز است"],
    metrics: { capitalToman: capital, maxLegSpreadBps: Decimal.max(...spreads).toNumber(), fxExposure: true },
    scannedAt: now
  };
}

function quote(side: "BUY" | "SELL", book: OrderBook, input: Decimal.Value, fee: number, slippage: number, depth: number) {
  return quoteEdge({ id: `${book.symbol}:${side}`, from: side === "BUY" ? book.quote : book.base, to: side === "BUY" ? book.base : book.quote, side, book }, input, fee, slippage, depth);
}

function mid(book: OrderBook) {
  const bid = book.bids[0]?.price, ask = book.asks[0]?.price;
  return bid && ask ? bid.plus(ask).div(2) : undefined;
}

function stale(book: OrderBook, now: number, maxAge: number) { return !book.lastUpdate || now - book.lastUpdate > maxAge; }
function mean(values: Decimal[]) { return values.reduce((sum, value) => sum.plus(value), new Decimal(0)).div(values.length); }

function percentile(values: number[], quantile: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.max(0, Math.min(1, quantile)) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function residualStationarity(values: Decimal[], center: Decimal) {
  const residuals = values.map(value => value.minus(center).toNumber());
  let sumXX = 0;
  let sumXDelta = 0;
  for (let index = 1; index < residuals.length; index += 1) {
    const lag = residuals[index - 1];
    const delta = residuals[index] - lag;
    sumXX += lag * lag;
    sumXDelta += lag * delta;
  }
  if (!(sumXX > 0) || residuals.length < 5) {
    return { adfTStatistic: 999, halfLifeBars: 1_000_000 };
  }
  const gamma = sumXDelta / sumXX;
  let squaredError = 0;
  for (let index = 1; index < residuals.length; index += 1) {
    const lag = residuals[index - 1];
    const delta = residuals[index] - lag;
    squaredError += (delta - gamma * lag) ** 2;
  }
  const standardError = Math.sqrt((squaredError / Math.max(1, residuals.length - 2)) / sumXX);
  const adfTStatistic = standardError > 0 ? gamma / standardError : 999;
  const phi = 1 + gamma;
  const halfLifeBars = phi > 0 && phi < 1 ? -Math.log(2) / Math.log(phi) : 1_000_000;
  return {
    adfTStatistic: Number.isFinite(adfTStatistic) ? adfTStatistic : 999,
    halfLifeBars: Number.isFinite(halfLifeBars) && halfLifeBars > 0 ? halfLifeBars : 1_000_000
  };
}
