import { z } from "zod";

const boundedBps = z.coerce.number().min(0).max(10_000);
const positiveBps = z.coerce.number().positive().max(10_000);
const capital = z.coerce.number().positive().max(1_000_000_000_000_000);

export const strategyLabSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  crossQuote: z.object({
    enabled: z.boolean().default(true),
    capitalToman: capital.default(1_000_000),
    minEdgeBps: boundedBps.default(80),
    maxSpreadBps: boundedBps.default(120),
    depthUsagePercent: z.coerce.number().positive().max(100).default(75)
  }).default({}),
  pairs: z.object({
    enabled: z.boolean().default(true),
    assetA: z.string().trim().min(2).max(16).default("BTC"),
    assetB: z.string().trim().min(2).max(16).default("ETH"),
    resolution: z.enum(["15", "30", "60", "240", "D"]).default("60"),
    lookback: z.coerce.number().int().min(30).max(500).default(120),
    entryZScore: z.coerce.number().positive().max(10).default(2),
    exitZScore: z.coerce.number().min(0).max(5).default(0.35),
    maxZScore: z.coerce.number().positive().max(20).default(4),
    notionalToman: capital.default(1_000_000),
    leverage: z.coerce.number().min(1).max(2).default(1),
    hedgeToleranceBps: boundedBps.max(1_000).default(75),
    maxBetaDriftBps: boundedBps.max(5_000).default(1_000),
    minMarginRatio: z.coerce.number().min(1).max(10).default(1.35),
    minLiquidationBufferBps: boundedBps.max(10_000).default(1_500),
    cooldownMs: z.coerce.number().int().min(1_000).max(86_400_000).default(900_000),
    maxEntrySpreadBps: boundedBps.max(2_000).default(120),
    maxPriceImpactBps: boundedBps.max(2_000).default(75),
    validationPercent: z.coerce.number().min(10).max(50).default(25),
    minCorrelation: z.coerce.number().min(0).max(1).default(0.75),
    maxHalfLifeBars: z.coerce.number().positive().max(500).default(60),
    adfCriticalValue: z.coerce.number().min(-20).max(-0.1).default(-2.5),
    maxValidationDriftZ: z.coerce.number().positive().max(10).default(1.5),
    estimatedRoundTripCostBps: boundedBps.max(5_000).default(100),
    minExpectedNetBps: boundedBps.max(5_000).default(50),
    maxHoldingMinutes: z.coerce.number().int().min(1).max(43_200).default(240),
    orderTimeoutMs: z.coerce.number().int().min(1_000).max(120_000).default(15_000)
  }).default({}),
  stablecoin: z.object({
    enabled: z.boolean().default(true),
    assets: z.string().default("USDC,DAI"),
    minDeviationBps: boundedBps.default(100),
    exitDeviationBps: boundedBps.default(20),
    maxSpreadBps: boundedBps.default(100),
    maxPriceImpactBps: boundedBps.default(40),
    depthUsagePercent: z.coerce.number().positive().max(100).default(60),
    capitalToman: capital.default(500_000),
    takeProfitBps: positiveBps.default(80),
    stopLossBps: positiveBps.default(120),
    maxLossToman: capital.default(10_000),
    maxResidualToman: capital.default(1_000),
    maxHoldMs: z.coerce.number().int().min(5_000).max(240_000).default(60_000),
    pollIntervalMs: z.coerce.number().int().min(250).max(10_000).default(1_000),
    cooldownMs: z.coerce.number().int().min(1_000).max(86_400_000).default(300_000),
    orderReserveBps: boundedBps.max(2_000).default(20),
    recoveryMaxSpreadBps: boundedBps.default(1_000),
    recoveryMaxPriceImpactBps: boundedBps.default(1_000),
    recoverySlippageBps: boundedBps.max(2_000).default(100)
  }).default({}),
  gapTrading: z.object({
    enabled: z.boolean().default(false),
    levels: z.coerce.number().int().min(4).max(25).default(10),
    baselineLevels: z.coerce.number().int().min(4).max(50).default(20),
    minGapBps: positiveBps.default(120),
    minGapZScore: z.coerce.number().min(1).max(20).default(3),
    minGapRatio: z.coerce.number().min(1).max(100).default(4),
    sampleWindowMs: z.coerce.number().int().min(2_000).max(120_000).default(60_000),
    minPersistenceMs: z.coerce.number().int().min(0).max(60_000).default(3_000),
    maxPersistenceMs: z.coerce.number().int().min(2_000).max(120_000).default(45_000),
    minConfirmations: z.coerce.number().int().min(2).max(30).default(4),
    maxGapDriftPercent: z.coerce.number().min(0).max(100).default(30),
    maxBoundaryDriftBps: boundedBps.max(2_000).default(20),
    levelWeightDecayPercent: z.coerce.number().min(10).max(100).default(70),
    minBidSupportRatio: z.coerce.number().min(1).max(100).default(1.4),
    minMicropriceBiasBps: boundedBps.max(500).default(1),
    maxTopLevelSharePercent: z.coerce.number().min(10).max(100).default(55),
    minVisibleDepthToman: capital.default(2_000_000),
    maxSpreadBps: boundedBps.default(80),
    maxPriceImpactBps: boundedBps.default(25),
    depthUsagePercent: z.coerce.number().positive().max(100).default(40),
    capitalToman: capital.default(250_000),
    maxPreGapConsumptionPercent: z.coerce.number().positive().max(100).default(15),
    targetCapturePercent: z.coerce.number().positive().max(75).default(35),
    minProjectedNetBps: boundedBps.default(40),
    safetyBufferBps: boundedBps.default(30),
    predictionHorizonMs: z.coerce.number().int().min(500).max(60_000).default(3_000),
    minOutcomeSamples: z.coerce.number().int().min(10).max(60).default(20),
    minOutcomeHitRatePercent: z.coerce.number().min(50).max(100).default(60),
    minPredictedNetBps: boundedBps.max(2_000).default(40),
    forecastSafetyBps: boundedBps.max(2_000).default(30),
    takeProfitBps: positiveBps.default(100),
    stopLossBps: positiveBps.default(100),
    maxLossToman: capital.default(7_500),
    maxResidualToman: capital.default(1_000),
    maxHoldMs: z.coerce.number().int().min(5_000).max(240_000).default(30_000),
    pollIntervalMs: z.coerce.number().int().min(250).max(10_000).default(1_000),
    cooldownMs: z.coerce.number().int().min(1_000).max(86_400_000).default(60_000),
    orderReserveBps: boundedBps.max(2_000).default(20),
    recoveryMaxSpreadBps: boundedBps.default(1_000),
    recoveryMaxPriceImpactBps: boundedBps.default(1_000),
    recoverySlippageBps: boundedBps.max(2_000).default(100)
  }).default({}),
  imbalance: z.object({
    enabled: z.boolean().default(true),
    levels: z.coerce.number().int().min(1).max(25).default(5),
    levelWeightDecayPercent: z.coerce.number().min(10).max(100).default(70),
    minRatio: z.coerce.number().min(1).max(100).default(2.5),
    exitRatio: z.coerce.number().min(1).max(100).default(1.25),
    sampleWindowMs: z.coerce.number().int().min(2_000).max(300_000).default(60_000),
    minPersistenceMs: z.coerce.number().int().min(0).max(30_000).default(2_000),
    maxPersistenceMs: z.coerce.number().int().min(2_000).max(60_000).default(12_000),
    minConfirmations: z.coerce.number().int().min(1).max(20).default(3),
    predictionHorizonMs: z.coerce.number().int().min(500).max(60_000).default(3_000),
    minOutcomeSamples: z.coerce.number().int().min(10).max(40).default(30),
    minOutcomeHitRatePercent: z.coerce.number().min(50).max(100).default(60),
    minPredictedNetBps: boundedBps.max(2_000).default(40),
    forecastSafetyBps: boundedBps.max(2_000).default(30),
    minPressureDelta: z.coerce.number().min(0).max(2).default(0.08),
    maxTopLevelSharePercent: z.coerce.number().min(10).max(100).default(70),
    minMicropriceBiasBps: boundedBps.max(500).default(0.5),
    maxAdverseMoveBps: boundedBps.max(2_000).default(15),
    maxSpreadBps: boundedBps.default(100),
    maxPriceImpactBps: boundedBps.default(40),
    minVisibleDepthToman: capital.default(2_000_000),
    depthUsagePercent: z.coerce.number().positive().max(100).default(60),
    capitalToman: capital.default(250_000),
    takeProfitBps: positiveBps.default(100),
    stopLossBps: positiveBps.default(80),
    maxLossToman: capital.default(7_500),
    maxResidualToman: capital.default(1_000),
    maxHoldMs: z.coerce.number().int().min(5_000).max(240_000).default(30_000),
    pollIntervalMs: z.coerce.number().int().min(250).max(10_000).default(1_000),
    cooldownMs: z.coerce.number().int().min(1_000).max(86_400_000).default(60_000),
    orderReserveBps: boundedBps.max(2_000).default(20),
    recoveryMaxSpreadBps: boundedBps.default(1_000),
    recoveryMaxPriceImpactBps: boundedBps.default(1_000),
    recoverySlippageBps: boundedBps.max(2_000).default(100)
  }).default({}),
  spotEasy: z.object({
    enabled: z.boolean().default(false),
    minEdgeBps: boundedBps.default(100),
    quoteExpiryBufferMs: z.coerce.number().int().min(0).max(60_000).default(2_000)
  }).default({})
}).superRefine((settings, context) => {
  if (settings.imbalance.exitRatio >= settings.imbalance.minRatio) {
    context.addIssue({ code: "custom", path: ["imbalance", "exitRatio"], message: "Exit Imbalance must be below Entry Imbalance" });
  }
  if (settings.imbalance.minPersistenceMs > settings.imbalance.maxPersistenceMs) {
    context.addIssue({ code: "custom", path: ["imbalance", "maxPersistenceMs"], message: "Max Persistence must be at least Min Persistence" });
  }
  if (settings.imbalance.minPersistenceMs > settings.imbalance.sampleWindowMs) {
    context.addIssue({ code: "custom", path: ["imbalance", "sampleWindowMs"], message: "Signal Window must cover Min Persistence" });
  }
  if (settings.gapTrading.minPersistenceMs > settings.gapTrading.maxPersistenceMs) {
    context.addIssue({ code: "custom", path: ["gapTrading", "maxPersistenceMs"], message: "Max Persistence must be at least Min Persistence" });
  }
  if (settings.gapTrading.minPersistenceMs > settings.gapTrading.sampleWindowMs) {
    context.addIssue({ code: "custom", path: ["gapTrading", "sampleWindowMs"], message: "Signal Window must cover Min Persistence" });
  }
});

export type StrategyLabSettings = z.infer<typeof strategyLabSettingsSchema>;

export const defaultStrategyLabSettings: StrategyLabSettings = strategyLabSettingsSchema.parse({});
