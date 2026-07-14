import { NextResponse } from "next/server";
import Decimal from "decimal.js";
import { botSettingsSchema } from "@/lib/bot-settings";
import type { BotSettings } from "@/lib/bot-settings";
import { liveCapital, scan } from "@/lib/bot/scanner";
import { NobitexClient } from "@/lib/exchanges/nobitex";
import { serializeOpportunity } from "@/lib/serializers";
import { saveProfitableOpportunities } from "@/lib/opportunity-store";
import { liveSafetyRejectionReason } from "@/lib/bot/executor";
import { scanConfiguredStrategies } from "@/lib/strategies/service";
import { serializeStrategyLab } from "@/lib/strategies/serializers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const inputSchema = botSettingsSchema;
const LIVE_CAPITAL_CACHE_MS = 5_000;
let liveCapitalCache: { key: string; value: Awaited<ReturnType<typeof liveCapital>>; expiresAt: number } | undefined;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "بدنه درخواست اسکن JSON معتبر نیست" }, { status: 400 });
  }

  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) {
    const details = parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join(" | ");
    return NextResponse.json({ error: `تنظیمات اسکن نامعتبر است: ${details}` }, { status: 400 });
  }

  try {
    const settings = parsed.data;
    const mode = request.headers.get("x-bot-mode") === "live" ? "live" : "paper";
    const client = new NobitexClient();
    const capital = mode === "live" ? await liveScanCapital(settings, client) : new Decimal(settings.paperCapitalToman);
    if (mode === "live" && capital.lte(0)) throw new Error("موجودی آزاد تومان برای اسکن واقعی کافی نیست");
    const result = await scan(capital, settings, client);
    const strategyLab = await scanConfiguredStrategies(result.books, settings, client);
    if (mode === "live") {
      for (const opportunity of result.opportunities) {
        if (!opportunity.executable) continue;
        const rejection = liveSafetyRejectionReason(opportunity, settings);
        if (rejection) {
          opportunity.executable = false;
          opportunity.rejectionReason = rejection;
        }
      }
      result.executableCount = result.opportunities.filter(item => item.executable).length;
    }
    const profitableSaved = await saveProfitableOpportunities(result.opportunities, mode, settings);
    return NextResponse.json({ mode, scannedAt: result.scannedAt, capitalToman: result.capitalToman.toString(), marketCount: result.marketCount,
      triangleCount: result.triangleCount, evaluatedSizeCount: result.evaluatedSizeCount,
      promisingPathCount: result.promisingPathCount, fastRejectedPathCount: result.fastRejectedPathCount,
      refinedPathCount: result.refinedPathCount, positiveCount: result.positiveCount,
      liquiditySafePositiveCount: result.liquiditySafePositiveCount, engineMs: result.engineMs,
      executableCount: result.executableCount, profitableSaved, opportunities: result.opportunities.slice(0, 100).map(serializeOpportunity),
      strategyLab: serializeStrategyLab(strategyLab) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "خطای ناشناخته در اسکن بازار" }, { status: 502 });
  }
}

async function liveScanCapital(settings: BotSettings, client: NobitexClient) {
  const key = `${settings.maxTradeToman}:${settings.balanceUsagePercent}`;
  if (liveCapitalCache && liveCapitalCache.key === key && liveCapitalCache.expiresAt > Date.now()) return liveCapitalCache.value;
  const value = await liveCapital(settings, client);
  liveCapitalCache = { key, value, expiresAt: Date.now() + LIVE_CAPITAL_CACHE_MS };
  return value;
}
