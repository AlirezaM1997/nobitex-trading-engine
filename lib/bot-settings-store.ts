import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { botSettingsSchema, defaultBotSettings, type BotSettings } from "./bot-settings";
import { defaultStrategyLabSettings } from "./strategy-settings";

const settingsPath = path.join(process.cwd(), "data", "bot-settings.json");

export async function getBotSettings(): Promise<BotSettings> {
  try {
    const stored = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    const migrated = {
      ...stored,
      tomanTakerFeeBps: stored.tomanTakerFeeBps ?? 25,
      usdtTakerFeeBps: stored.usdtTakerFeeBps ?? 13,
      maxPriceImpactBps: stored.maxPriceImpactBps ?? 25,
      maxSpreadBps: stored.maxSpreadBps ?? 80,
      orderbookDepthUsagePercent: stored.orderbookDepthUsagePercent ?? 40,
      liveSafetyBufferBps: stored.liveSafetyBufferBps ?? 150,
      strategyLab: stored.strategyLab === undefined
        ? defaultStrategyLabSettings
        : migrateStoredStrategyLabSettings(stored.strategyLab)
    };
    return botSettingsSchema.parse(migrated);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await saveBotSettings(defaultBotSettings);
    return { ...defaultBotSettings };
  }
}

/**
 * Market Making and liquidity-gap trading have different risk semantics. Old
 * values are copied only where they make the analytical model stricter, and the
 * replacement engine is always disabled so an upgrade cannot opt the user in.
 */
export function migrateStoredStrategyLabSettings(input: unknown): unknown {
  if (!isRecord(input) || isRecord(input.gapTrading) || !isRecord(input.marketMaking)) return input;
  const legacy = input.marketMaking;
  const defaults = defaultStrategyLabSettings.gapTrading;
  const legacyCapital = positiveNumber(legacy.orderSizeToman);
  const legacyDepth = positiveNumber(legacy.minVisibleDepthToman);
  const legacySpread = nonNegativeNumber(legacy.maxGrossSpreadBps);
  const legacySafety = nonNegativeNumber(legacy.adverseSelectionBufferBps);
  return {
    ...input,
    gapTrading: {
      ...defaults,
      enabled: false,
      capitalToman: legacyCapital ? Math.min(defaults.capitalToman, legacyCapital) : defaults.capitalToman,
      minVisibleDepthToman: legacyDepth ? Math.max(defaults.minVisibleDepthToman, legacyDepth) : defaults.minVisibleDepthToman,
      maxSpreadBps: legacySpread === undefined ? defaults.maxSpreadBps : Math.min(defaults.maxSpreadBps, legacySpread),
      safetyBufferBps: legacySafety === undefined ? defaults.safetyBufferBps : Math.max(defaults.safetyBufferBps, legacySafety)
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function nonNegativeNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export async function saveBotSettings(input: unknown): Promise<BotSettings> {
  const settings = botSettingsSchema.parse(input);
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return settings;
}
