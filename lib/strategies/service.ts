import type { BotSettings } from "@/lib/bot-settings";
import { NobitexClient } from "@/lib/exchanges/nobitex";
import type { OrderBook } from "@/lib/exchanges/types";
import { scanStrategyLab } from "./engine";
import { recordOrderbookObservations } from "./orderbook-history";

export async function scanConfiguredStrategies(books: OrderBook[], settings: BotSettings, client = new NobitexClient()) {
  const observedAt = Date.now();
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
          settings.strategyLab.gapTrading.enabled
            ? Math.max(
                settings.strategyLab.gapTrading.minConfirmations * 4,
                settings.strategyLab.gapTrading.minOutcomeSamples * 3
              )
            : 0,
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
  }, { now: observedAt, orderbookHistory });
  return result;
}
