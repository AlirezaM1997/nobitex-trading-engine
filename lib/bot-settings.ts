import { z } from "zod";
import { defaultStrategyLabSettings, strategyLabSettingsSchema } from "./strategy-settings";
import { aiAgentSettingsSchema, defaultAiAgentSettings } from "./ai-agent/settings";

export const botSettingsSchema = z.object({
  paperCapitalToman: z.coerce.number().positive().max(1_000_000_000_000_000),
  maxTradeToman: z.coerce.number().positive().max(1_000_000_000_000_000),
  balanceUsagePercent: z.coerce.number().positive().max(100),
  tomanTakerFeeBps: z.coerce.number().min(0).max(10_000),
  usdtTakerFeeBps: z.coerce.number().min(0).max(10_000),
  slippageBufferBps: z.coerce.number().min(0).max(9_000),
  liveSafetyBufferBps: z.coerce.number().min(0).max(10_000).default(150),
  maxPriceImpactBps: z.coerce.number().min(0).max(10_000).default(25),
  maxSpreadBps: z.coerce.number().min(0).max(10_000).default(80),
  orderbookDepthUsagePercent: z.coerce.number().positive().max(100).default(40),
  minProfitBps: z.coerce.number().min(0).max(100_000),
  minNetProfitToman: z.coerce.number().min(0).max(1_000_000_000_000_000),
  orderbookMaxAgeMs: z.coerce.number().int().min(1_000).max(300_000),
  scanIntervalMs: z.coerce.number().int().min(1_000).max(3_600_000),
  orderTimeoutMs: z.coerce.number().int().min(1_000).max(300_000),
  strategyLab: strategyLabSettingsSchema.default(defaultStrategyLabSettings),
  aiAgent: aiAgentSettingsSchema.default(defaultAiAgentSettings)
});

export type BotSettings = z.infer<typeof botSettingsSchema>;

export const defaultBotSettings: BotSettings = {
  paperCapitalToman: 10_000_000,
  maxTradeToman: 1_000_000,
  balanceUsagePercent: 20,
  tomanTakerFeeBps: 25,
  usdtTakerFeeBps: 13,
  slippageBufferBps: 10,
  liveSafetyBufferBps: 150,
  maxPriceImpactBps: 25,
  maxSpreadBps: 80,
  orderbookDepthUsagePercent: 40,
  minProfitBps: 50,
  minNetProfitToman: 10_000,
  orderbookMaxAgeMs: 3_000,
  scanIntervalMs: 1_000,
  orderTimeoutMs: 5_000,
  strategyLab: defaultStrategyLabSettings,
  aiAgent: defaultAiAgentSettings
};
