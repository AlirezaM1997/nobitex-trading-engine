import Decimal from "decimal.js";
import { z } from "zod";
import type {
  StatisticalPairsExecutionPlan,
  StatisticalPairsOpenPosition
} from "./statistical-pairs-executor";

const decimalText = z.string().trim().min(1).max(100).refine(value => {
  try { return new Decimal(value).isFinite(); } catch { return false; }
}, "Invalid decimal");

const planSchema = z.object({
  version: z.literal(1),
  id: z.string().trim().min(1).max(200),
  signalId: z.string().trim().min(1).max(200),
  assetA: z.string().regex(/^[A-Z0-9]{2,16}$/),
  assetB: z.string().regex(/^[A-Z0-9]{2,16}$/),
  longAsset: z.string().regex(/^[A-Z0-9]{2,16}$/),
  shortAsset: z.string().regex(/^[A-Z0-9]{2,16}$/),
  direction: z.enum(["SHORT_A_LONG_B", "LONG_A_SHORT_B"]),
  beta: decimalText,
  entryZScore: decimalText,
  grossNotionalToman: decimalText,
  longNotionalToman: decimalText,
  shortNotionalToman: decimalText,
  createdAt: z.number().int().nonnegative(),
  config: z.object({
    leverage: decimalText,
    takerFeeBps: decimalText,
    slippageBps: decimalText,
    maxEntrySpreadBps: decimalText,
    maxPriceImpactBps: decimalText,
    depthUsagePercent: decimalText,
    hedgeToleranceBps: decimalText,
    maxBetaDriftBps: decimalText.default("1000"),
    minMarginRatio: decimalText.default("1.35"),
    minLiquidationBufferBps: decimalText.default("1500"),
    maxAgeMs: z.number().int().positive(),
    orderTimeoutMs: z.number().int().positive(),
    maxHoldingMs: z.number().int().positive(),
    exitZScore: decimalText,
    stopZScore: decimalText,
    resolution: z.enum(["15", "30", "60", "240", "D"]).default("60"),
    lookback: z.number().int().min(30).max(500).default(120)
  })
}).strict();

const positionSchema = z.object({
  version: z.literal(1),
  planId: z.string().trim().min(1).max(200),
  marginPositionId: z.string().regex(/^\d+$/),
  openedAt: z.number().int().nonnegative(),
  longAsset: z.string().regex(/^[A-Z0-9]{2,16}$/),
  shortAsset: z.string().regex(/^[A-Z0-9]{2,16}$/),
  longAmountBase: decimalText,
  shortLiabilityBase: decimalText,
  initialLongCostToman: decimalText,
  entryZScore: decimalText
}).strict();

export type SerializedStatisticalPairsPlan = z.infer<typeof planSchema>;
export type SerializedStatisticalPairsPosition = z.infer<typeof positionSchema>;

export function serializeStatisticalPairsPlan(plan: StatisticalPairsExecutionPlan): SerializedStatisticalPairsPlan {
  return {
    version: 1,
    id: plan.id,
    signalId: plan.signalId,
    assetA: plan.assetA,
    assetB: plan.assetB,
    longAsset: plan.longAsset,
    shortAsset: plan.shortAsset,
    direction: plan.direction,
    beta: plan.beta.toString(),
    entryZScore: plan.entryZScore.toString(),
    grossNotionalToman: plan.grossNotionalToman.toString(),
    longNotionalToman: plan.longNotionalToman.toString(),
    shortNotionalToman: plan.shortNotionalToman.toString(),
    createdAt: plan.createdAt,
    config: {
      leverage: plan.config.leverage.toString(),
      takerFeeBps: plan.config.takerFeeBps.toString(),
      slippageBps: plan.config.slippageBps.toString(),
      maxEntrySpreadBps: plan.config.maxEntrySpreadBps.toString(),
      maxPriceImpactBps: plan.config.maxPriceImpactBps.toString(),
      depthUsagePercent: plan.config.depthUsagePercent.toString(),
      hedgeToleranceBps: plan.config.hedgeToleranceBps.toString(),
      maxBetaDriftBps: plan.config.maxBetaDriftBps.toString(),
      minMarginRatio: plan.config.minMarginRatio.toString(),
      minLiquidationBufferBps: plan.config.minLiquidationBufferBps.toString(),
      maxAgeMs: plan.config.maxAgeMs,
      orderTimeoutMs: plan.config.orderTimeoutMs,
      maxHoldingMs: plan.config.maxHoldingMs,
      exitZScore: plan.config.exitZScore.toString(),
      stopZScore: plan.config.stopZScore.toString(),
      resolution: plan.config.resolution,
      lookback: plan.config.lookback
    }
  };
}

export function deserializeStatisticalPairsPlan(value: unknown): StatisticalPairsExecutionPlan {
  const plan = planSchema.parse(value);
  return {
    ...plan,
    beta: new Decimal(plan.beta),
    entryZScore: new Decimal(plan.entryZScore),
    grossNotionalToman: new Decimal(plan.grossNotionalToman),
    longNotionalToman: new Decimal(plan.longNotionalToman),
    shortNotionalToman: new Decimal(plan.shortNotionalToman),
    config: {
      ...plan.config,
      leverage: new Decimal(plan.config.leverage),
      takerFeeBps: new Decimal(plan.config.takerFeeBps),
      slippageBps: new Decimal(plan.config.slippageBps),
      maxEntrySpreadBps: new Decimal(plan.config.maxEntrySpreadBps),
      maxPriceImpactBps: new Decimal(plan.config.maxPriceImpactBps),
      depthUsagePercent: new Decimal(plan.config.depthUsagePercent),
      hedgeToleranceBps: new Decimal(plan.config.hedgeToleranceBps),
      maxBetaDriftBps: new Decimal(plan.config.maxBetaDriftBps),
      minMarginRatio: new Decimal(plan.config.minMarginRatio),
      minLiquidationBufferBps: new Decimal(plan.config.minLiquidationBufferBps),
      exitZScore: new Decimal(plan.config.exitZScore),
      stopZScore: new Decimal(plan.config.stopZScore)
    }
  };
}

export function serializeStatisticalPairsPosition(position: StatisticalPairsOpenPosition): SerializedStatisticalPairsPosition {
  return {
    version: 1,
    planId: position.planId,
    marginPositionId: position.marginPositionId,
    openedAt: position.openedAt,
    longAsset: position.longAsset,
    shortAsset: position.shortAsset,
    longAmountBase: position.longAmountBase.toString(),
    shortLiabilityBase: position.shortLiabilityBase.toString(),
    initialLongCostToman: position.initialLongCostToman.toString(),
    entryZScore: position.entryZScore.toString()
  };
}

export function deserializeStatisticalPairsPosition(value: unknown): StatisticalPairsOpenPosition {
  const position = positionSchema.parse(value);
  return {
    ...position,
    longAmountBase: new Decimal(position.longAmountBase),
    shortLiabilityBase: new Decimal(position.shortLiabilityBase),
    initialLongCostToman: new Decimal(position.initialLongCostToman),
    entryZScore: new Decimal(position.entryZScore)
  };
}
