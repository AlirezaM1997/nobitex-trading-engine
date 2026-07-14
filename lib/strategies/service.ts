import type { BotSettings } from "@/lib/bot-settings";
import { NobitexClient } from "@/lib/exchanges/nobitex";
import type { OrderBook } from "@/lib/exchanges/types";
import { scanStrategyLab } from "./engine";
import type { StatisticalPairSeries } from "./types";
import { recordOrderbookObservations } from "./orderbook-history";

let pairCache: { key: string; expiresAt: number; value: StatisticalPairSeries[] } | undefined;

export async function scanConfiguredStrategies(books: OrderBook[], settings: BotSettings, client = new NobitexClient()) {
  const observedAt = Date.now();
  let statisticalPairs: StatisticalPairSeries[] = [];
  let pairDataError: string | undefined;
  if (settings.strategyLab.enabled && settings.strategyLab.pairs.enabled) {
    try {
      statisticalPairs = await getPairSeries(settings, client);
    } catch (error) {
      pairDataError = error instanceof Error ? error.message : "خطا در دریافت تاریخچه Pairs";
    }
  }
  const historyWindows = [
    settings.strategyLab.imbalance.enabled
      ? Math.max(settings.strategyLab.imbalance.sampleWindowMs, settings.strategyLab.imbalance.maxPersistenceMs)
      : 0,
    settings.strategyLab.gapTrading.enabled
      ? Math.max(settings.strategyLab.gapTrading.sampleWindowMs, settings.strategyLab.gapTrading.maxPersistenceMs)
      : 0
  ];
  const historyEnabled = historyWindows.some(value => value > 0);
  const orderbookHistory = historyEnabled
    ? recordOrderbookObservations(books, observedAt, {
        maxAgeMs: Math.max(...historyWindows) + 5_000,
        maxSamples: Math.max(
          40,
          settings.strategyLab.gapTrading.enabled ? settings.strategyLab.gapTrading.minConfirmations * 4 : 0,
          settings.strategyLab.imbalance.enabled
            ? Math.max(
                settings.strategyLab.imbalance.minConfirmations * 3,
                settings.strategyLab.imbalance.minOutcomeSamples * 3
              )
            : 0
        )
      })
    : undefined;
  const result = scanStrategyLab(books, {
    settings: settings.strategyLab,
    tomanTakerFeeBps: settings.tomanTakerFeeBps,
    usdtTakerFeeBps: settings.usdtTakerFeeBps,
    slippageBps: settings.slippageBufferBps,
    maxAgeMs: settings.orderbookMaxAgeMs
  }, { now: observedAt, statisticalPairs, orderbookHistory });
  if (pairDataError) result.diagnostics.pairDataError = pairDataError;
  return result;
}

async function getPairSeries(settings: BotSettings, client: NobitexClient) {
  const pair = settings.strategyLab.pairs;
  const assetA = pair.assetA.toUpperCase();
  const assetB = pair.assetB.toUpperCase();
  const key = `${assetA}:${assetB}:${pair.resolution}:${pair.lookback}`;
  if (pairCache?.key === key && pairCache.expiresAt > Date.now()) return pairCache.value;
  const [a, b] = await Promise.all([
    client.getCandles(`${assetA}IRT`, pair.resolution, pair.lookback),
    client.getCandles(`${assetB}IRT`, pair.resolution, pair.lookback)
  ]);
  const byTimestampB = new Map(b.timestamps.map((timestamp, index) => [timestamp, b.close[index]]));
  const pricesA = [], pricesB = [];
  for (let index = 0; index < a.timestamps.length; index += 1) {
    const paired = byTimestampB.get(a.timestamps[index]);
    if (!paired || !a.close[index]) continue;
    pricesA.push(a.close[index]);
    pricesB.push(paired);
  }
  const value = [{ assetA, assetB, pricesA, pricesB }];
  pairCache = { key, value, expiresAt: Date.now() + 60_000 };
  return value;
}
