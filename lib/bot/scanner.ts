import Decimal from "decimal.js";
import type { BotSettings } from "@/lib/bot-settings";
import { NobitexClient } from "@/lib/exchanges/nobitex";
import { findTriangularOpportunitiesDetailed } from "./engine";

export async function scan(capitalToman: Decimal.Value, settings: BotSettings, client = new NobitexClient()) {
  const [books, options] = await Promise.all([client.getAllOrderBooks(), client.getMarketOptions()]);
  const engineStartedAt = performance.now();
  const { opportunities, stats } = findTriangularOpportunitiesDetailed({
    books, options, capitalToman,
    tomanFeeBps: settings.tomanTakerFeeBps,
    usdtFeeBps: settings.usdtTakerFeeBps,
    slippageBps: settings.slippageBufferBps,
    maxPriceImpactBps: settings.maxPriceImpactBps,
    maxSpreadBps: settings.maxSpreadBps,
    depthUsagePercent: settings.orderbookDepthUsagePercent,
    minProfitBps: settings.minProfitBps,
    minNetProfitToman: settings.minNetProfitToman,
    maxAgeMs: settings.orderbookMaxAgeMs
  });
  return {
    scannedAt: Date.now(),
    capitalToman: new Decimal(capitalToman),
    marketCount: books.length,
    executableCount: opportunities.filter(o => o.executable).length,
    positiveCount: opportunities.filter(o => o.netProfitToman.gt(0)).length,
    liquiditySafePositiveCount: opportunities.filter(o => o.netProfitToman.gt(0) && o.liquiditySafe).length,
    engineMs: Math.round(performance.now() - engineStartedAt),
    ...stats,
    opportunities,
    books,
    options
  };
}

export async function liveCapital(settings: BotSettings, client = new NobitexClient()) {
  // Keep Live sizing on the same Spot-only balance source used by the dashboard.
  const wallet = await client.getSpotTomanWallet();
  if (!wallet) throw new Error("کیف پول ریالی/تومانی در پاسخ نوبیتکس پیدا نشد");
  const usable = wallet.available.mul(settings.balanceUsagePercent).div(100);
  return Decimal.min(usable, settings.maxTradeToman);
}
