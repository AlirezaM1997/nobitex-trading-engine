import Decimal from "decimal.js";
import { config as appConfig } from "@/lib/config";
import { bookSpreadBps, quoteEdge } from "@/lib/bot/engine";
import type { LegQuote } from "@/lib/bot/types";
import type { MarketOptions, NobitexOrder, OrderBook, Side } from "@/lib/exchanges/types";
import type { StrategySignal } from "./types";
import { measureOrderbookImbalance } from "./orderbook-imbalance";

const BPS = new Decimal(10_000);
const OFFICIAL_MAINNET_HOSTNAME = "apiv2.nobitex.ir";

export type SpotPositionStrategy = "stablecoin" | "orderbook-imbalance";
export type SpotPositionRiskStrategy = "stablecoin" | "imbalance";
export type SpotPositionOrderStage = "entry" | "exit" | "recovery";
export type SpotPositionExitReason =
  | "convergence"
  | "imbalance-normalized"
  | "take-profit"
  | "stop-loss"
  | "max-loss"
  | "max-hold"
  | "risk-control"
  | "partial-entry"
  | "execution-error";

export type SpotPositionOrderRequest = {
  side: Side;
  base: string;
  quote: string;
  amountBase: Decimal;
  expectedPrice: Decimal;
  clientOrderId: string;
};

export type SpotPositionExecutionClient = {
  baseUrl?: string;
  getAllOrderBooks(): Promise<OrderBook[]>;
  getMarketOptions(): Promise<MarketOptions>;
  placeMarketOrder(input: SpotPositionOrderRequest): Promise<NobitexOrder>;
  getOrderStatus(id: string): Promise<NobitexOrder>;
  getOrderStatusByClientOrderId?(clientOrderId: string): Promise<NobitexOrder>;
  cancelOrder(id: string): Promise<void>;
};

export type SpotPositionPlanConfig = {
  capitalToman: Decimal.Value;
  tomanTakerFeeBps: Decimal.Value;
  slippageBps: Decimal.Value;
  liveSafetyBufferBps?: Decimal.Value;
  maxSpreadBps: Decimal.Value;
  maxPriceImpactBps: Decimal.Value;
  depthUsagePercent: Decimal.Value;
  maxAgeMs: number;
  orderTimeoutMs: number;
  orderReserveBps: Decimal.Value;
  takeProfitBps: Decimal.Value;
  stopLossBps: Decimal.Value;
  maxLossToman: Decimal.Value;
  maxResidualToman: Decimal.Value;
  maxHoldMs: number;
  pollIntervalMs: number;
  recoveryMaxSpreadBps: Decimal.Value;
  recoveryMaxPriceImpactBps: Decimal.Value;
  recoverySlippageBps: Decimal.Value;
  stablecoin?: {
    minDeviationBps: Decimal.Value;
    exitDeviationBps: Decimal.Value;
  };
  imbalance?: {
    levels: number;
    levelWeightDecayPercent: Decimal.Value;
    minRatio: Decimal.Value;
    exitRatio: Decimal.Value;
    minVisibleDepthToman: Decimal.Value;
    maxTopLevelSharePercent: Decimal.Value;
    minMicropriceBiasBps: Decimal.Value;
  };
};

export type SpotPositionExecutionPlan = Readonly<{
  id: string;
  signalId: string;
  signalScannedAt: number;
  strategy: SpotPositionStrategy;
  riskStrategy: SpotPositionRiskStrategy;
  symbol: string;
  asset: string;
  referenceSymbol: string | null;
  direction: "LONG";
  capitalToman: Decimal;
  initialMetric: Decimal;
  config: Readonly<{
    tomanTakerFeeBps: Decimal;
    slippageBps: Decimal;
    liveSafetyBufferBps: Decimal;
    maxSpreadBps: Decimal;
    maxPriceImpactBps: Decimal;
    depthUsagePercent: Decimal;
    maxAgeMs: number;
    orderTimeoutMs: number;
    orderReserveBps: Decimal;
    takeProfitBps: Decimal;
    stopLossBps: Decimal;
    maxLossToman: Decimal;
    maxResidualToman: Decimal;
    maxHoldMs: number;
    pollIntervalMs: number;
    recoveryMaxSpreadBps: Decimal;
    recoveryMaxPriceImpactBps: Decimal;
    recoverySlippageBps: Decimal;
    minDeviationBps: Decimal | null;
    exitDeviationBps: Decimal | null;
    imbalanceLevels: number | null;
    imbalanceLevelWeightDecayPercent: Decimal | null;
    minImbalanceRatio: Decimal | null;
    exitImbalanceRatio: Decimal | null;
    minVisibleDepthToman: Decimal | null;
    maxTopLevelSharePercent: Decimal | null;
    minMicropriceBiasBps: Decimal | null;
  }>;
  createdAt: number;
}>;

export type SerializedSpotPositionExecutionPlan = {
  version: 1;
  id: string;
  signalId: string;
  signalScannedAt: number;
  strategy: SpotPositionStrategy;
  riskStrategy: SpotPositionRiskStrategy;
  symbol: string;
  asset: string;
  referenceSymbol: string | null;
  direction: "LONG";
  capitalToman: string;
  initialMetric: string;
  config: {
    [K in keyof SpotPositionExecutionPlan["config"]]: SpotPositionExecutionPlan["config"][K] extends Decimal
      ? string
      : SpotPositionExecutionPlan["config"][K] extends Decimal | null
        ? string | null
        : SpotPositionExecutionPlan["config"][K]
  };
  createdAt: number;
};

export type SpotPositionRevalidation = {
  checkedAt: number;
  entryQuote: LegQuote;
  metric: Decimal;
  expectedNetEdgeBps: Decimal | null;
};

export type SpotPositionRoundTripRisk = {
  projectedEntryCostToman: Decimal;
  projectedImmediateExitToman: Decimal;
  projectedRoundTripLossToman: Decimal;
  projectedRoundTripCostBps: Decimal;
  safetyHeadroomBps: Decimal;
  requiredStopLossBps: Decimal;
};

export type SpotPositionCheck = {
  checkedAt: number;
  exitQuote: LegQuote;
  projectedOutputToman: Decimal;
  projectedPnlToman: Decimal;
  projectedPnlBps: Decimal;
  metric: Decimal;
  exitReason?: SpotPositionExitReason;
};

export type SpotPositionExecutionLeg = {
  stage: SpotPositionOrderStage;
  symbol: string;
  side: Side;
  orderId: string;
  clientOrderId: string;
  status: string;
  submittedAmountBase: Decimal;
  matchedAmountBase: Decimal;
  unmatchedAmountBase: Decimal;
  actualInput: Decimal;
  inputAsset: string;
  actualOutput: Decimal;
  outputAsset: string;
  fee: Decimal;
  feeAsset: string;
  averagePrice: Decimal;
  fullFill: boolean;
};

export type SpotPositionExecutionHooks = {
  onRevalidated?: (event: { phase: "entry-1" | "entry-2"; plan: SpotPositionExecutionPlan; validation: SpotPositionRevalidation }) => Promise<void> | void;
  onBeforeOrder?: (event: { stage: SpotPositionOrderStage; plan: SpotPositionExecutionPlan; quote: LegQuote; request: SpotPositionOrderRequest }) => Promise<void> | void;
  onOrderSubmitted?: (event: { stage: SpotPositionOrderStage; plan: SpotPositionExecutionPlan; order: NobitexOrder; request: SpotPositionOrderRequest }) => Promise<void> | void;
  onOrderFinalized?: (event: { stage: SpotPositionOrderStage; plan: SpotPositionExecutionPlan; leg: SpotPositionExecutionLeg }) => Promise<void> | void;
  onPositionOpened?: (event: { plan: SpotPositionExecutionPlan; entry: SpotPositionExecutionLeg }) => Promise<void> | void;
  /** Return a reason to request an immediate risk-reducing exit. */
  onPositionCheck?: (event: { plan: SpotPositionExecutionPlan; check?: SpotPositionCheck; heldMs: number }) => Promise<string | void> | string | void;
  onRecoveryStarted?: (event: { plan: SpotPositionExecutionPlan; assetAmount: Decimal; reason: string }) => Promise<void> | void;
};

export type SpotPositionExecutionOptions = {
  baseUrl?: string;
  revalidationDelayMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type SpotPositionExecutionResult = {
  status: "completed" | "recovered";
  plan: SpotPositionExecutionPlan;
  entryValidation: SpotPositionRevalidation;
  legs: SpotPositionExecutionLeg[];
  exitReason: SpotPositionExitReason;
  inputToman: Decimal;
  outputToman: Decimal;
  profitToman: Decimal;
  profitBps: Decimal;
  residualAssetAmount: Decimal;
  heldMs: number;
};

export type KnownSpotExposureRecoveryResult = {
  plan: SpotPositionExecutionPlan;
  leg: SpotPositionExecutionLeg;
  recoveredToman: Decimal;
  residualAssetAmount: Decimal;
};

export class SpotPositionExecutionError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "MAINNET_REQUIRED"
      | "INVALID_PLAN"
      | "REVALIDATION_FAILED"
      | "ORDER_FAILED"
      | "RECOVERY_FAILED"
      | "UNTRADABLE_RESIDUAL"
      | "ORDER_STATE_UNKNOWN",
    public readonly manualInterventionRequired = false,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "SpotPositionExecutionError";
  }
}

export function serializeSpotPositionExecutionPlan(plan: SpotPositionExecutionPlan): SerializedSpotPositionExecutionPlan {
  return {
    version: 1,
    id: plan.id,
    signalId: plan.signalId,
    signalScannedAt: plan.signalScannedAt,
    strategy: plan.strategy,
    riskStrategy: plan.riskStrategy,
    symbol: plan.symbol,
    asset: plan.asset,
    referenceSymbol: plan.referenceSymbol,
    direction: plan.direction,
    capitalToman: plan.capitalToman.toString(),
    initialMetric: plan.initialMetric.toString(),
    config: Object.fromEntries(Object.entries(plan.config).map(([key, value]) => [key, value instanceof Decimal ? value.toString() : value])) as SerializedSpotPositionExecutionPlan["config"],
    createdAt: plan.createdAt
  };
}

/** Strictly restores the exact immutable plan persisted before the first order. */
export function deserializeSpotPositionExecutionPlan(input: unknown): SpotPositionExecutionPlan {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalidPlan("Persisted execution plan is missing");
  const value = input as Record<string, unknown>;
  if (value.version !== 1 || (value.strategy !== "stablecoin" && value.strategy !== "orderbook-imbalance")) throw invalidPlan("Persisted execution plan has an invalid version or strategy");
  const strategy = value.strategy;
  const riskStrategy = strategy === "stablecoin" ? "stablecoin" : "imbalance";
  if (value.riskStrategy !== riskStrategy || value.direction !== "LONG") throw invalidPlan("Persisted execution plan direction is invalid");
  const symbol = requiredString(value.symbol, "symbol").toUpperCase();
  const asset = requiredString(value.asset, "asset").toUpperCase();
  if (symbol !== `${asset}IRT` || asset === "USDT") throw invalidPlan("Persisted execution market is invalid");
  const rawConfig = value.config;
  if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) throw invalidPlan("Persisted execution config is missing");
  const c = rawConfig as Record<string, unknown>;
  const nullableDecimal = (key: string) => c[key] == null ? null : decimal(String(c[key]), key);
  const nullableInteger = (key: string) => c[key] == null ? null : positiveInteger(Number(c[key]), key);
  const maxLossToman = positiveDecimal(String(c.maxLossToman), "maxLossToman");
  const maxResidualToman = c.maxResidualToman == null
    ? Decimal.min(maxLossToman, new Decimal(1_000))
    : positiveDecimal(String(c.maxResidualToman), "maxResidualToman");
  if (maxResidualToman.gt(maxLossToman)) throw invalidPlan("maxResidualToman cannot exceed maxLossToman");
  const config = Object.freeze({
    tomanTakerFeeBps: boundedDecimal(String(c.tomanTakerFeeBps), 0, 10_000, "tomanTakerFeeBps"),
    slippageBps: boundedDecimal(String(c.slippageBps), 0, 2_000, "slippageBps"),
    liveSafetyBufferBps: boundedDecimal(String(c.liveSafetyBufferBps), 0, 10_000, "liveSafetyBufferBps"),
    maxSpreadBps: boundedDecimal(String(c.maxSpreadBps), 0, 10_000, "maxSpreadBps"),
    maxPriceImpactBps: boundedDecimal(String(c.maxPriceImpactBps), 0, 10_000, "maxPriceImpactBps"),
    depthUsagePercent: boundedDecimal(String(c.depthUsagePercent), 0.000001, 100, "depthUsagePercent"),
    maxAgeMs: positiveInteger(Number(c.maxAgeMs), "maxAgeMs"),
    orderTimeoutMs: positiveInteger(Number(c.orderTimeoutMs), "orderTimeoutMs"),
    orderReserveBps: boundedDecimal(String(c.orderReserveBps), 0, 2_000, "orderReserveBps"),
    takeProfitBps: positiveDecimal(String(c.takeProfitBps), "takeProfitBps"),
    stopLossBps: positiveDecimal(String(c.stopLossBps), "stopLossBps"),
    maxLossToman,
    maxResidualToman,
    maxHoldMs: positiveInteger(Number(c.maxHoldMs), "maxHoldMs"),
    pollIntervalMs: positiveInteger(Number(c.pollIntervalMs), "pollIntervalMs"),
    recoveryMaxSpreadBps: boundedDecimal(String(c.recoveryMaxSpreadBps), 0, 10_000, "recoveryMaxSpreadBps"),
    recoveryMaxPriceImpactBps: boundedDecimal(String(c.recoveryMaxPriceImpactBps), 0, 10_000, "recoveryMaxPriceImpactBps"),
    recoverySlippageBps: boundedDecimal(String(c.recoverySlippageBps), 0, 2_000, "recoverySlippageBps"),
    minDeviationBps: nullableDecimal("minDeviationBps"),
    exitDeviationBps: nullableDecimal("exitDeviationBps"),
    imbalanceLevels: nullableInteger("imbalanceLevels"),
    imbalanceLevelWeightDecayPercent: strategy === "orderbook-imbalance"
      ? boundedDecimal(String(c.imbalanceLevelWeightDecayPercent ?? 70), 10, 100, "imbalanceLevelWeightDecayPercent")
      : null,
    minImbalanceRatio: nullableDecimal("minImbalanceRatio"),
    exitImbalanceRatio: nullableDecimal("exitImbalanceRatio"),
    minVisibleDepthToman: nullableDecimal("minVisibleDepthToman"),
    maxTopLevelSharePercent: strategy === "orderbook-imbalance"
      ? boundedDecimal(String(c.maxTopLevelSharePercent ?? 100), 10, 100, "maxTopLevelSharePercent")
      : null,
    minMicropriceBiasBps: strategy === "orderbook-imbalance"
      ? boundedDecimal(String(c.minMicropriceBiasBps ?? 0), 0, 500, "minMicropriceBiasBps")
      : null
  });
  if (strategy === "stablecoin" && (!config.minDeviationBps || !config.exitDeviationBps)) throw invalidPlan("Persisted Stablecoin exit config is incomplete");
  if (strategy === "orderbook-imbalance" && (!config.imbalanceLevels || !config.imbalanceLevelWeightDecayPercent || !config.minImbalanceRatio || !config.exitImbalanceRatio || !config.minVisibleDepthToman || !config.maxTopLevelSharePercent || !config.minMicropriceBiasBps)) throw invalidPlan("Persisted Imbalance exit config is incomplete");
  return Object.freeze({
    id: requiredString(value.id, "id"),
    signalId: requiredString(value.signalId, "signalId"),
    signalScannedAt: nonNegativeInteger(Number(value.signalScannedAt), "signalScannedAt"),
    strategy,
    riskStrategy,
    symbol,
    asset,
    referenceSymbol: strategy === "stablecoin" ? "USDTIRT" : null,
    direction: "LONG",
    capitalToman: positiveDecimal(String(value.capitalToman), "capitalToman"),
    initialMetric: decimal(String(value.initialMetric), "initialMetric"),
    config,
    createdAt: nonNegativeInteger(Number(value.createdAt), "createdAt")
  });
}

/** Builds a closed IRT -> asset -> IRT plan from a fresh server-side signal. */
export function createSpotPositionExecutionPlan(
  signal: StrategySignal,
  input: SpotPositionPlanConfig,
  now = Date.now()
): SpotPositionExecutionPlan {
  const strategy: SpotPositionStrategy | undefined = signal.kind === "stablecoin"
    ? "stablecoin"
    : signal.kind === "orderbook-imbalance"
      ? "orderbook-imbalance"
      : undefined;
  if (!strategy || signal.status !== "actionable") {
    throw invalidPlan("Only an actionable Stablecoin or Orderbook Imbalance signal can become a position plan");
  }
  if (signal.metrics.direction !== "LONG" || signal.metrics.spotExecutable !== true) {
    throw invalidPlan("The signal is not an IRT-funded long Spot position");
  }
  if (strategy === "orderbook-imbalance" && (
    signal.metrics.temporalConfirmed !== true
    || signal.metrics.spoofingGuardPassed !== true
    || signal.metrics.priceConfirmationPassed !== true
    || signal.metrics.executionDepthSafe !== true
  )) {
    throw invalidPlan("The imbalance signal is missing temporal, spoofing, price, or execution-depth confirmation");
  }
  const symbol = String(signal.symbols[0] ?? "").toUpperCase();
  if (!symbol.endsWith("IRT") || symbol.length <= 3) throw invalidPlan("The position market must be an asset/IRT Spot market");
  const asset = symbol.slice(0, -3);
  if (asset === "USDT") throw invalidPlan("USDTIRT cannot be used as the position asset");

  const capitalToman = positiveDecimal(input.capitalToman, "capitalToman");
  const maxLossToman = positiveDecimal(input.maxLossToman, "maxLossToman");
  const maxResidualToman = positiveDecimal(input.maxResidualToman, "maxResidualToman");
  if (maxLossToman.gt(capitalToman)) throw invalidPlan("maxLossToman cannot exceed capitalToman");
  if (maxResidualToman.gt(maxLossToman)) throw invalidPlan("maxResidualToman cannot exceed maxLossToman");
  const maxHoldMs = positiveInteger(input.maxHoldMs, "maxHoldMs");
  const orderTimeoutMs = positiveInteger(input.orderTimeoutMs, "orderTimeoutMs");
  if (maxHoldMs > 240_000 || maxHoldMs + orderTimeoutMs * 2 > 300_000) {
    throw invalidPlan("Position and order timeouts must fit inside the five-minute server lease");
  }

  const stablecoin = strategy === "stablecoin" ? input.stablecoin : undefined;
  const imbalance = strategy === "orderbook-imbalance" ? input.imbalance : undefined;
  if (strategy === "stablecoin" && !stablecoin) throw invalidPlan("Stablecoin exit settings are missing");
  if (strategy === "orderbook-imbalance" && !imbalance) throw invalidPlan("Imbalance exit settings are missing");

  const minDeviationBps = stablecoin ? boundedDecimal(stablecoin.minDeviationBps, 0, 10_000, "minDeviationBps") : null;
  const exitDeviationBps = stablecoin ? boundedDecimal(stablecoin.exitDeviationBps, 0, 10_000, "exitDeviationBps") : null;
  if (minDeviationBps && exitDeviationBps && exitDeviationBps.gte(minDeviationBps)) {
    throw invalidPlan("exitDeviationBps must be below minDeviationBps");
  }
  const minImbalanceRatio = imbalance ? boundedDecimal(imbalance.minRatio, 1, 100, "minRatio") : null;
  const exitImbalanceRatio = imbalance ? boundedDecimal(imbalance.exitRatio, 1, 100, "exitRatio") : null;
  if (minImbalanceRatio && exitImbalanceRatio && exitImbalanceRatio.gte(minImbalanceRatio)) {
    throw invalidPlan("exitRatio must be below minRatio");
  }

  const initialMetricRaw = strategy === "stablecoin" ? signal.metrics.deviationBps : signal.metrics.ratio;
  if (typeof initialMetricRaw !== "number" && typeof initialMetricRaw !== "string") throw invalidPlan("Signal metric is missing");
  const route = Object.freeze([symbol, ...(strategy === "stablecoin" ? ["USDTIRT"] : [])]);
  const config = Object.freeze({
    tomanTakerFeeBps: boundedDecimal(input.tomanTakerFeeBps, 0, 10_000, "tomanTakerFeeBps"),
    slippageBps: boundedDecimal(input.slippageBps, 0, 2_000, "slippageBps"),
    liveSafetyBufferBps: boundedDecimal(input.liveSafetyBufferBps ?? 0, 0, 10_000, "liveSafetyBufferBps"),
    maxSpreadBps: boundedDecimal(input.maxSpreadBps, 0, 10_000, "maxSpreadBps"),
    maxPriceImpactBps: boundedDecimal(input.maxPriceImpactBps, 0, 10_000, "maxPriceImpactBps"),
    depthUsagePercent: boundedDecimal(input.depthUsagePercent, 0.000001, 100, "depthUsagePercent"),
    maxAgeMs: positiveInteger(input.maxAgeMs, "maxAgeMs"),
    orderTimeoutMs,
    orderReserveBps: boundedDecimal(input.orderReserveBps, 0, 2_000, "orderReserveBps"),
    takeProfitBps: positiveDecimal(input.takeProfitBps, "takeProfitBps"),
    stopLossBps: positiveDecimal(input.stopLossBps, "stopLossBps"),
    maxLossToman,
    maxResidualToman,
    maxHoldMs,
    pollIntervalMs: positiveInteger(input.pollIntervalMs, "pollIntervalMs"),
    recoveryMaxSpreadBps: boundedDecimal(input.recoveryMaxSpreadBps, 0, 10_000, "recoveryMaxSpreadBps"),
    recoveryMaxPriceImpactBps: boundedDecimal(input.recoveryMaxPriceImpactBps, 0, 10_000, "recoveryMaxPriceImpactBps"),
    recoverySlippageBps: boundedDecimal(input.recoverySlippageBps, 0, 2_000, "recoverySlippageBps"),
    minDeviationBps,
    exitDeviationBps,
    imbalanceLevels: imbalance ? positiveInteger(imbalance.levels, "levels") : null,
    imbalanceLevelWeightDecayPercent: imbalance ? boundedDecimal(imbalance.levelWeightDecayPercent, 10, 100, "levelWeightDecayPercent") : null,
    minImbalanceRatio,
    exitImbalanceRatio,
    minVisibleDepthToman: imbalance ? positiveDecimal(imbalance.minVisibleDepthToman, "minVisibleDepthToman") : null,
    maxTopLevelSharePercent: imbalance ? boundedDecimal(imbalance.maxTopLevelSharePercent, 10, 100, "maxTopLevelSharePercent") : null,
    minMicropriceBiasBps: imbalance ? boundedDecimal(imbalance.minMicropriceBiasBps, 0, 500, "minMicropriceBiasBps") : null
  });

  return Object.freeze({
    id: `spot-position:${strategy}:${signal.id}:${signal.scannedAt}`,
    signalId: signal.id,
    signalScannedAt: signal.scannedAt,
    strategy,
    riskStrategy: strategy === "stablecoin" ? "stablecoin" : "imbalance",
    symbol,
    asset,
    referenceSymbol: strategy === "stablecoin" ? "USDTIRT" : null,
    direction: "LONG" as const,
    capitalToman,
    initialMetric: decimal(initialMetricRaw, "initialMetric"),
    config,
    createdAt: now,
    route
  } as SpotPositionExecutionPlan & { route: readonly string[] });
}

export function revalidateSpotPositionEntry(
  plan: SpotPositionExecutionPlan,
  books: OrderBook[],
  now = Date.now()
): SpotPositionRevalidation {
  const book = findBook(books, plan.symbol);
  assertFresh(book, now, plan.config.maxAgeMs);
  const executionCapital = plan.capitalToman.mul(BPS.minus(plan.config.orderReserveBps)).div(BPS);
  const entryQuote = makeQuote("BUY", book, executionCapital, plan, false);
  if (!entryQuote) throw revalidationError("The entry market has insufficient visible depth");
  assertQuoteRisk(entryQuote, plan.config.maxSpreadBps, plan.config.maxPriceImpactBps, "entry");

  let metric: Decimal;
  let expectedNetEdgeBps: Decimal | null = null;
  if (plan.strategy === "stablecoin") {
    const reference = findBook(books, plan.referenceSymbol!);
    assertFresh(reference, now, plan.config.maxAgeMs);
    if (bookSpreadBps(reference).gt(plan.config.maxSpreadBps)) throw revalidationError("USDTIRT reference spread is above the configured limit");
    metric = stablecoinDeviation(book, reference);
    if (metric.gte(0)) throw revalidationError("The stablecoin is no longer below the USDT reference");
    expectedNetEdgeBps = metric.neg().minus(plan.config.tomanTakerFeeBps.mul(2)).minus(plan.config.slippageBps.mul(2));
    const required = plan.config.minDeviationBps!.plus(plan.config.liveSafetyBufferBps);
    if (expectedNetEdgeBps.lt(required)) {
      throw revalidationError(`Fresh stablecoin edge ${expectedNetEdgeBps.toFixed(2)} BPS is below ${required.toFixed(2)} BPS`);
    }
  } else {
    const imbalance = orderbookImbalance(book, plan.config.imbalanceLevels!, plan.config.imbalanceLevelWeightDecayPercent!);
    metric = imbalance.ratio;
    if (!imbalance.bidHeavy || metric.lt(plan.config.minImbalanceRatio!)) {
      throw revalidationError("The fresh orderbook is no longer bid-heavy enough for a long entry");
    }
    if (Decimal.min(imbalance.bidDepthToman, imbalance.askDepthToman).lt(plan.config.minVisibleDepthToman!)) {
      throw revalidationError("Visible IRT depth is below the configured minimum");
    }
    if (imbalance.dominantTopLevelSharePercent.gt(plan.config.maxTopLevelSharePercent!)) {
      throw revalidationError("The fresh imbalance is concentrated in one top-level wall and failed the spoofing guard");
    }
    if (imbalance.micropriceBiasBps.lt(plan.config.minMicropriceBiasBps!)) {
      throw revalidationError("Fresh microprice no longer confirms upward pressure");
    }
  }
  return { checkedAt: now, entryQuote, metric, expectedNetEdgeBps };
}

/** Mainnet position lifecycle. It never intentionally leaves the selected asset open. */
export async function executeSpotPosition(
  plan: SpotPositionExecutionPlan,
  client: SpotPositionExecutionClient,
  hooks: SpotPositionExecutionHooks = {},
  options: SpotPositionExecutionOptions = {}
): Promise<SpotPositionExecutionResult> {
  assertOfficialMainnet(options.baseUrl ?? client.baseUrl ?? appConfig.NOBITEX_API_BASE);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const marketOptionsPromise = client.getMarketOptions();
  const firstValidation = revalidateSpotPositionEntry(plan, await client.getAllOrderBooks(), now());
  await safeHook(() => hooks.onRevalidated?.({ phase: "entry-1", plan, validation: firstValidation }));
  const delay = Math.max(0, options.revalidationDelayMs ?? 250);
  if (delay) await sleep(delay);
  const entryValidation = revalidateSpotPositionEntry(plan, await client.getAllOrderBooks(), now());
  await safeHook(() => hooks.onRevalidated?.({ phase: "entry-2", plan, validation: entryValidation }));
  const marketOptions = await marketOptionsPromise;
  assertMinimumOrder(entryValidation.entryQuote, marketOptions);
  assertEntryCanCloseToToman(entryValidation.entryQuote, marketOptions, plan);
  assertEntryRoundTripRisk(entryValidation.entryQuote, marketOptions, plan);

  const legs: SpotPositionExecutionLeg[] = [];
  let entry: SpotPositionExecutionLeg;
  try {
    entry = await submitAndWait("entry", entryValidation.entryQuote, plan, marketOptions, client, hooks, { now, sleep });
    legs.push(entry);
  } catch (error) {
    throw normalizeOrderError(error, "Entry order failed before a confirmed fill");
  }
  if (entry.actualOutput.lte(0)) throw new SpotPositionExecutionError("Entry order had no confirmed fill", "ORDER_FAILED");
  await safeHook(() => hooks.onPositionOpened?.({ plan, entry }));
  const openedAt = now();

  if (!entry.fullFill) {
    return recoverPosition(plan, entryValidation, entry, entry.actualOutput, new Decimal(0), "partial-entry", openedAt, legs, marketOptions, client, hooks, now, sleep);
  }

  let check: SpotPositionCheck | undefined;
  while (true) {
    const heldMs = Math.max(0, now() - openedAt);
    let externalExit: string | void;
    try {
      externalExit = await hooks.onPositionCheck?.({ plan, check, heldMs });
    } catch (error) {
      return recoverPosition(plan, entryValidation, entry, entry.actualOutput, new Decimal(0), "risk-control", openedAt, legs, marketOptions, client, hooks, now, sleep, errorMessage(error));
    }
    if (typeof externalExit === "string" && externalExit.trim()) {
      try {
        check = await makeExitCheck(plan, entry, await client.getAllOrderBooks(), now(), heldMs, "risk-control");
      } catch (error) {
        return recoverPosition(plan, entryValidation, entry, entry.actualOutput, new Decimal(0), "risk-control", openedAt, legs, marketOptions, client, hooks, now, sleep, errorMessage(error));
      }
      break;
    }
    if (heldMs >= plan.config.maxHoldMs) {
      try {
        check = await makeExitCheck(plan, entry, await client.getAllOrderBooks(), now(), heldMs, "max-hold");
      } catch (error) {
        return recoverPosition(plan, entryValidation, entry, entry.actualOutput, new Decimal(0), "max-hold", openedAt, legs, marketOptions, client, hooks, now, sleep, errorMessage(error));
      }
      break;
    }
    await sleep(Math.min(plan.config.pollIntervalMs, plan.config.maxHoldMs - heldMs));
    const nextHeldMs = Math.max(0, now() - openedAt);
    try {
      check = await makeExitCheck(plan, entry, await client.getAllOrderBooks(), now(), nextHeldMs);
    } catch (error) {
      return recoverPosition(plan, entryValidation, entry, entry.actualOutput, new Decimal(0), "execution-error", openedAt, legs, marketOptions, client, hooks, now, sleep, errorMessage(error));
    }
    if (check.exitReason) break;
  }

  let exit: SpotPositionExecutionLeg;
  try {
    exit = await submitAndWait("exit", check.exitQuote, plan, marketOptions, client, hooks, { now, sleep });
  } catch (error) {
    if (error instanceof OrderStateUnknownError) {
      throw new SpotPositionExecutionError(
        "Exit order state is unknown; another SELL was blocked to prevent a double-sell",
        "ORDER_STATE_UNKNOWN",
        true,
        { cause: error }
      );
    }
    return recoverPosition(plan, entryValidation, entry, entry.actualOutput, new Decimal(0), check.exitReason!, openedAt, legs, marketOptions, client, hooks, now, sleep, errorMessage(error));
  }
  legs.push(exit);
  const remaining = Decimal.max(entry.actualOutput.minus(exit.matchedAmountBase), 0);
  const amountStep = marketOptions.amountSteps[plan.symbol] ?? new Decimal("0.00000001");
  const minimumToman = marketOptions.minOrderRial.div(10);
  const residualValueToman = remaining.mul(check.exitQuote.bestPrice);
  const recoverableResidual = remaining.gte(amountStep) && residualValueToman.gte(minimumToman);
  if (!exit.fullFill || recoverableResidual) {
    return recoverPosition(plan, entryValidation, entry, remaining, exit.actualOutput, check.exitReason!, openedAt, legs, marketOptions, client, hooks, now, sleep, "Exit order did not flatten the owned asset amount");
  }
  assertResidualWithinLimit(remaining, check.exitQuote.bestPrice, plan, "exit");
  return result("completed", plan, entryValidation, legs, check.exitReason!, entry.actualInput, exit.actualOutput, remaining, now() - openedAt);
}

/**
 * Flattens an already-reconciled, known asset balance. The caller must prove the
 * amount from persisted exchange order ids before invoking this function. It
 * never creates exposure and is therefore suitable for a server Recovery Lease.
 */
export async function recoverKnownSpotExposure(
  plan: SpotPositionExecutionPlan,
  assetAmount: Decimal.Value,
  client: SpotPositionExecutionClient,
  hooks: SpotPositionExecutionHooks = {},
  options: SpotPositionExecutionOptions = {}
): Promise<KnownSpotExposureRecoveryResult> {
  assertOfficialMainnet(options.baseUrl ?? client.baseUrl ?? appConfig.NOBITEX_API_BASE);
  const amount = positiveDecimal(assetAmount, "assetAmount");
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  await safeHook(() => hooks.onRecoveryStarted?.({ plan, assetAmount: amount, reason: "persisted-position-resume" }));
  const marketOptions = await client.getMarketOptions();
  const book = findBook(await client.getAllOrderBooks(), plan.symbol);
  assertFresh(book, now(), plan.config.maxAgeMs);
  const step = marketOptions.amountSteps[plan.symbol] ?? new Decimal("0.00000001");
  if (floorStep(amount, step).lte(0)) {
    throw new SpotPositionExecutionError(
      `Persisted ${plan.asset} exposure ${amount.toString()} is below the exchange amount step ${step.toString()} and cannot be closed automatically`,
      "UNTRADABLE_RESIDUAL",
      true
    );
  }
  const quote = makeQuote("SELL", book, amount, plan, true);
  if (!quote) throw new SpotPositionExecutionError("Recovery market has insufficient visible depth", "RECOVERY_FAILED", true);
  try {
    assertQuoteRisk(quote, plan.config.recoveryMaxSpreadBps, plan.config.recoveryMaxPriceImpactBps, "persisted recovery");
    assertMinimumOrder(quote, marketOptions);
    const leg = await submitAndWait("recovery", quote, plan, marketOptions, client, hooks, { now, sleep });
    const residualAssetAmount = Decimal.max(amount.minus(leg.matchedAmountBase), 0);
    if (!leg.fullFill || residualAssetAmount.gte(step)) {
      throw new SpotPositionExecutionError("Persisted-position recovery was not fully filled", "RECOVERY_FAILED", true);
    }
    assertResidualWithinLimit(residualAssetAmount, leg.averagePrice, plan, "persisted recovery");
    return { plan, leg, recoveredToman: leg.actualOutput, residualAssetAmount };
  } catch (error) {
    if (error instanceof OrderStateUnknownError) {
      throw new SpotPositionExecutionError("Persisted recovery order state is unknown; another SELL was blocked", "ORDER_STATE_UNKNOWN", true, { cause: error });
    }
    if (error instanceof SpotPositionExecutionError) throw error;
    throw new SpotPositionExecutionError(`Persisted-position recovery failed: ${errorMessage(error)}`, "RECOVERY_FAILED", true, { cause: error });
  }
}

async function makeExitCheck(
  plan: SpotPositionExecutionPlan,
  entry: SpotPositionExecutionLeg,
  books: OrderBook[],
  now: number,
  heldMs: number,
  forcedReason?: SpotPositionExitReason
): Promise<SpotPositionCheck> {
  const book = findBook(books, plan.symbol);
  assertFresh(book, now, plan.config.maxAgeMs);
  const exitQuote = makeQuote("SELL", book, entry.actualOutput, plan, false);
  if (!exitQuote) throw revalidationError("Exit market has insufficient visible depth");
  assertQuoteRisk(exitQuote, plan.config.maxSpreadBps, plan.config.maxPriceImpactBps, "exit");
  const output = exitQuote.output;
  const pnl = output.minus(entry.actualInput);
  const pnlBps = pnl.div(entry.actualInput).mul(BPS);
  let metric: Decimal;
  let strategyExit: SpotPositionExitReason | undefined;
  if (plan.strategy === "stablecoin") {
    const reference = findBook(books, plan.referenceSymbol!);
    assertFresh(reference, now, plan.config.maxAgeMs);
    metric = stablecoinDeviation(book, reference);
    if (metric.abs().lte(plan.config.exitDeviationBps!)) strategyExit = "convergence";
  } else {
    const imbalance = orderbookImbalance(book, plan.config.imbalanceLevels!, plan.config.imbalanceLevelWeightDecayPercent!);
    metric = imbalance.ratio;
    if (!imbalance.bidHeavy || metric.lte(plan.config.exitImbalanceRatio!)) strategyExit = "imbalance-normalized";
  }
  const exitReason = forcedReason
    ?? (pnl.lte(plan.config.maxLossToman.neg()) ? "max-loss" : undefined)
    ?? (pnlBps.lte(plan.config.stopLossBps.neg()) ? "stop-loss" : undefined)
    ?? (pnlBps.gte(plan.config.takeProfitBps) ? "take-profit" : undefined)
    ?? strategyExit
    ?? (heldMs >= plan.config.maxHoldMs ? "max-hold" : undefined);
  return { checkedAt: now, exitQuote, projectedOutputToman: output, projectedPnlToman: pnl, projectedPnlBps: pnlBps, metric, exitReason };
}

async function recoverPosition(
  plan: SpotPositionExecutionPlan,
  entryValidation: SpotPositionRevalidation,
  entry: SpotPositionExecutionLeg,
  assetAmount: Decimal,
  alreadyOutputToman: Decimal,
  reason: SpotPositionExitReason,
  openedAt: number,
  legs: SpotPositionExecutionLeg[],
  marketOptions: MarketOptions,
  client: SpotPositionExecutionClient,
  hooks: SpotPositionExecutionHooks,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  detail?: string
): Promise<SpotPositionExecutionResult> {
  if (assetAmount.lte(0)) {
    return result("recovered", plan, entryValidation, legs, reason, entry.actualInput, alreadyOutputToman, new Decimal(0), now() - openedAt);
  }
  await safeHook(() => hooks.onRecoveryStarted?.({ plan, assetAmount, reason: detail ? `${reason}: ${detail}` : reason }));
  try {
    const book = findBook(await client.getAllOrderBooks(), plan.symbol);
    assertFresh(book, now(), plan.config.maxAgeMs);
    const quote = makeQuote("SELL", book, assetAmount, plan, true);
    if (!quote) throw new Error("Recovery market has insufficient visible depth");
    assertQuoteRisk(quote, plan.config.recoveryMaxSpreadBps, plan.config.recoveryMaxPriceImpactBps, "recovery");
    assertMinimumOrder(quote, marketOptions);
    const recovery = await submitAndWait("recovery", quote, plan, marketOptions, client, hooks, { now, sleep });
    legs.push(recovery);
    const residual = Decimal.max(assetAmount.minus(recovery.matchedAmountBase), 0);
    const amountStep = marketOptions.amountSteps[plan.symbol] ?? new Decimal("0.00000001");
    if (!recovery.fullFill || residual.gte(amountStep)) {
      throw new SpotPositionExecutionError("Recovery was only partially filled; manual Mainnet intervention is required", "RECOVERY_FAILED", true);
    }
    assertResidualWithinLimit(residual, recovery.averagePrice, plan, "recovery");
    return result(
      "recovered",
      plan,
      entryValidation,
      legs,
      reason,
      entry.actualInput,
      alreadyOutputToman.plus(recovery.actualOutput),
      residual,
      now() - openedAt
    );
  } catch (error) {
    if (error instanceof SpotPositionExecutionError && error.manualInterventionRequired) throw error;
    if (error instanceof OrderStateUnknownError) {
      throw new SpotPositionExecutionError("Recovery order state is unknown; manual Mainnet intervention is required", "ORDER_STATE_UNKNOWN", true, { cause: error });
    }
    throw new SpotPositionExecutionError(`Automatic IRT recovery failed: ${errorMessage(error)}`, "RECOVERY_FAILED", true, { cause: error });
  }
}

async function submitAndWait(
  stage: SpotPositionOrderStage,
  quote: LegQuote,
  plan: SpotPositionExecutionPlan,
  options: MarketOptions,
  client: SpotPositionExecutionClient,
  hooks: SpotPositionExecutionHooks,
  clock: { now: () => number; sleep: (ms: number) => Promise<void> }
): Promise<SpotPositionExecutionLeg> {
  const amountStep = options.amountSteps[quote.edge.book.symbol] ?? new Decimal("0.00000001");
  const priceStep = options.priceSteps[quote.edge.book.symbol] ?? new Decimal("0.00000001");
  const amountBase = floorStep(quote.edge.side === "BUY" ? quote.grossOutput : quote.input, amountStep);
  if (amountBase.lte(0)) throw new Error(`Rounded amount is zero on ${quote.edge.book.symbol}`);
  const slippage = stage === "recovery" ? plan.config.recoverySlippageBps : plan.config.slippageBps;
  const expectedPrice = priceToStep(quote.edge.side, protectedExpectedPrice(quote.edge.side, quote.averagePrice, slippage), priceStep);
  const request: SpotPositionOrderRequest = {
    side: quote.edge.side,
    base: quote.edge.book.base,
    quote: quote.edge.book.quote,
    amountBase,
    expectedPrice,
    clientOrderId: makeClientOrderId(plan, stage)
  };
  await hooks.onBeforeOrder?.({ stage, plan, quote, request });
  let order: NobitexOrder;
  try {
    order = await client.placeMarketOrder(request);
  } catch (error) {
    if (isDefinitiveRejection(error)) throw error;
    try {
      order = await lookupAcceptedSpotOrder(client, request.clientOrderId, clock);
    } catch (lookupError) {
      throw new OrderStateUnknownError(`clientOrderId ${request.clientOrderId}`, {
        cause: new AggregateError([error, lookupError], "Order submission and clientOrderId reconciliation both failed")
      });
    }
  }
  await safeHook(() => hooks.onOrderSubmitted?.({ stage, plan, order, request }));
  const final = await waitForFinalOrder(client, order, plan.config.orderTimeoutMs, clock);
  const fullFill = final.matchedAmount.gt(0) && final.unmatchedAmount.lte(0) && final.matchedAmount.gte(amountBase);
  const outputAsset = quote.edge.side === "BUY" ? quote.edge.book.base : quote.edge.book.quote;
  const inputAsset = quote.edge.side === "BUY" ? quote.edge.book.quote : quote.edge.book.base;
  const actualOutput = quote.edge.side === "BUY"
    ? Decimal.max(final.matchedAmount.minus(final.fee), 0)
    : Decimal.max(final.totalPrice.minus(final.fee).div(10), 0);
  const actualInput = quote.edge.side === "BUY" ? final.totalPrice.div(10) : final.matchedAmount;
  const leg: SpotPositionExecutionLeg = {
    stage,
    symbol: quote.edge.book.symbol,
    side: quote.edge.side,
    orderId: final.id,
    clientOrderId: request.clientOrderId,
    status: final.status,
    submittedAmountBase: amountBase,
    matchedAmountBase: final.matchedAmount,
    unmatchedAmountBase: final.unmatchedAmount,
    actualInput,
    inputAsset,
    actualOutput,
    outputAsset,
    fee: final.fee.div(outputAsset === "IRT" ? 10 : 1),
    feeAsset: outputAsset,
    averagePrice: final.averagePrice.div(10),
    fullFill
  };
  await safeHook(() => hooks.onOrderFinalized?.({ stage, plan, leg }));
  return leg;
}

async function lookupAcceptedSpotOrder(
  client: SpotPositionExecutionClient,
  clientOrderId: string,
  clock: { sleep: (ms: number) => Promise<void> }
) {
  if (!client.getOrderStatusByClientOrderId) throw new Error("clientOrderId status lookup is unavailable");
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const order = await client.getOrderStatusByClientOrderId(clientOrderId);
      if (!order.id) throw new Error("clientOrderId lookup returned no exchange order id");
      return order;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await clock.sleep(100);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("clientOrderId lookup failed");
}

async function waitForFinalOrder(
  client: SpotPositionExecutionClient,
  initial: NobitexOrder,
  timeoutMs: number,
  clock: { now: () => number; sleep: (ms: number) => Promise<void> }
) {
  const deadline = clock.now() + timeoutMs;
  let order = initial;
  while (clock.now() < deadline) {
    if (isTerminal(order.status)) return order;
    await clock.sleep(Math.min(100, Math.max(1, deadline - clock.now())));
    try { order = await client.getOrderStatus(order.id); } catch (error) {
      throw new OrderStateUnknownError(order.id, { cause: error });
    }
  }
  try {
    await client.cancelOrder(initial.id);
    order = await client.getOrderStatus(initial.id);
    if (!isTerminal(order.status)) throw new Error("Order remained non-terminal after cancellation");
    return order;
  } catch (error) {
    throw new OrderStateUnknownError(initial.id, { cause: error });
  }
}

function result(
  status: "completed" | "recovered",
  plan: SpotPositionExecutionPlan,
  entryValidation: SpotPositionRevalidation,
  legs: SpotPositionExecutionLeg[],
  exitReason: SpotPositionExitReason,
  inputToman: Decimal,
  outputToman: Decimal,
  residualAssetAmount: Decimal,
  heldMs: number
): SpotPositionExecutionResult {
  const profitToman = outputToman.minus(inputToman);
  return {
    status,
    plan,
    entryValidation,
    legs,
    exitReason,
    inputToman,
    outputToman,
    profitToman,
    profitBps: inputToman.gt(0) ? profitToman.div(inputToman).mul(BPS) : new Decimal(0),
    residualAssetAmount,
    heldMs: Math.max(0, heldMs)
  };
}

function makeQuote(side: Side, book: OrderBook, input: Decimal.Value, plan: SpotPositionExecutionPlan, recovery: boolean) {
  return quoteEdge(
    { id: `${book.symbol}:${side}`, from: side === "BUY" ? book.quote : book.base, to: side === "BUY" ? book.base : book.quote, side, book },
    input,
    plan.config.tomanTakerFeeBps,
    recovery ? plan.config.recoverySlippageBps : plan.config.slippageBps,
    recovery ? 100 : plan.config.depthUsagePercent
  );
}

function orderbookImbalance(book: OrderBook, levels: number, levelWeightDecayPercent: Decimal) {
  try {
    return measureOrderbookImbalance(book, levels, levelWeightDecayPercent);
  } catch (error) {
    throw revalidationError(error instanceof Error ? error.message : "Orderbook imbalance could not be measured");
  }
}

function stablecoinDeviation(assetBook: OrderBook, referenceBook: OrderBook) {
  const assetMid = midpoint(assetBook);
  const referenceMid = midpoint(referenceBook);
  if (!assetMid || !referenceMid) throw revalidationError("Stablecoin midpoint is unavailable");
  return assetMid.div(referenceMid).minus(1).mul(BPS);
}

function midpoint(book: OrderBook) {
  const bid = book.bids[0]?.price;
  const ask = book.asks[0]?.price;
  return bid && ask ? bid.plus(ask).div(2) : undefined;
}

function findBook(books: OrderBook[], symbol: string) {
  const book = books.find(item => item.symbol.toUpperCase() === symbol.toUpperCase());
  if (!book) throw revalidationError(`Required market ${symbol} is unavailable`);
  if (book.quote !== "IRT") throw revalidationError(`${symbol} is not an IRT market`);
  return book;
}

function assertFresh(book: OrderBook, now: number, maxAgeMs: number) {
  if (!book.lastUpdate || now - book.lastUpdate > maxAgeMs || book.lastUpdate > now + 5_000) {
    throw revalidationError(`${book.symbol} orderbook is stale or has an invalid timestamp`);
  }
}

function assertQuoteRisk(quote: LegQuote, maxSpread: Decimal, maxImpact: Decimal, phase: string) {
  if (quote.spreadBps.gt(maxSpread)) throw revalidationError(`${phase} spread ${quote.spreadBps.toFixed(2)} BPS exceeds ${maxSpread.toFixed(2)} BPS`);
  if (quote.priceImpactBps.gt(maxImpact)) throw revalidationError(`${phase} price impact ${quote.priceImpactBps.toFixed(2)} BPS exceeds ${maxImpact.toFixed(2)} BPS`);
}

function assertMinimumOrder(quote: LegQuote, options: MarketOptions) {
  const value = quote.edge.side === "BUY" ? quote.input : quote.grossOutput;
  const minimum = options.minOrderRial.div(10);
  if (value.lt(minimum)) throw revalidationError(`${quote.edge.book.symbol} value is below the minimum Spot order`);
}

/**
 * Nobitex charges a BUY fee in the acquired asset. On coarse amount steps this
 * can turn a fully-filled BUY into an amount whose sellable floor leaves an
 * expensive remainder. Reject that market before the first real order.
 */
function assertEntryCanCloseToToman(quote: LegQuote, options: MarketOptions, plan: SpotPositionExecutionPlan) {
  const step = options.amountSteps[plan.symbol] ?? new Decimal("0.00000001");
  const submittedAmount = floorStep(quote.grossOutput, step);
  const expectedFee = submittedAmount.mul(plan.config.tomanTakerFeeBps).div(BPS);
  const expectedOwnedAmount = Decimal.max(submittedAmount.minus(expectedFee), 0);
  const sellableAmount = floorStep(expectedOwnedAmount, step);
  const bidPrice = bestBidPrice(quote.edge.book);
  const minimumToman = options.minOrderRial.div(10);
  if (sellableAmount.lte(0) || sellableAmount.mul(bidPrice).lt(minimumToman)) {
    throw revalidationError(`${plan.symbol} cannot be closed to the minimum IRT order after BUY fee and amount-step rounding`);
  }
  const residualAmount = Decimal.max(expectedOwnedAmount.minus(sellableAmount), 0);
  const residualValueToman = residualAmount.mul(bidPrice);
  if (residualValueToman.gt(plan.config.maxResidualToman)) {
    throw revalidationError(
      `${plan.symbol} expected residual is ${residualValueToman.toFixed(2)} IRT after BUY fee and amount-step rounding; limit is ${plan.config.maxResidualToman.toFixed(2)} IRT`
    );
  }
}

/**
 * Prices an immediate BUY -> SELL unwind before the BUY is submitted. A market
 * position must not open when spread, two taker fees, slippage allowance and
 * amount-step rounding already consume the configured Stop Loss. This avoids
 * the deterministic buy/stop/sell churn that can otherwise happen on the first
 * monitoring tick even when the orderbook itself has not moved.
 */
export function assessSpotPositionRoundTripRisk(
  entryQuote: LegQuote,
  options: MarketOptions,
  plan: SpotPositionExecutionPlan
): SpotPositionRoundTripRisk {
  const step = options.amountSteps[plan.symbol] ?? new Decimal("0.00000001");
  const submittedAmount = floorStep(entryQuote.grossOutput, step);
  const expectedFee = submittedAmount.mul(plan.config.tomanTakerFeeBps).div(BPS);
  const expectedOwnedAmount = Decimal.max(submittedAmount.minus(expectedFee), 0);
  // The slippage allowance is treated as unavailable inventory as well. This
  // keeps the pre-trade estimate conservative when the market moves between
  // the snapshot and the accepted market order.
  const conservativeOwnedAmount = Decimal.min(expectedOwnedAmount, entryQuote.output);
  const sellableAmount = floorStep(conservativeOwnedAmount, step);
  if (sellableAmount.lte(0)) {
    throw revalidationError(`${plan.symbol} has no safely sellable amount after BUY fee, slippage and amount-step rounding`);
  }

  const exitQuote = makeQuote("SELL", entryQuote.edge.book, sellableAmount, plan, false);
  if (!exitQuote) throw revalidationError(`${plan.symbol} has insufficient reserved depth for an immediate IRT unwind`);
  assertQuoteRisk(exitQuote, plan.config.maxSpreadBps, plan.config.maxPriceImpactBps, "immediate unwind");
  assertMinimumOrder(exitQuote, options);

  // entryQuote.input deliberately includes unspent step-rounding reserve. It is
  // a conservative upper bound and cannot make an unsafe entry look cheaper.
  const projectedEntryCostToman = entryQuote.input;
  const projectedImmediateExitToman = exitQuote.output;
  const projectedRoundTripLossToman = Decimal.max(projectedEntryCostToman.minus(projectedImmediateExitToman), 0);
  const projectedRoundTripCostBps = projectedEntryCostToman.gt(0)
    ? projectedRoundTripLossToman.div(projectedEntryCostToman).mul(BPS)
    : new Decimal(BPS);
  // Reserve at least two configured slippage buffers (entry + exit), with a
  // small 10 BPS floor for snapshot/fill latency and decimal-step differences.
  const safetyHeadroomBps = Decimal.max(plan.config.slippageBps.mul(2), 10);
  const requiredStopLossBps = projectedRoundTripCostBps.plus(safetyHeadroomBps);
  const projectedWorstLossToman = projectedRoundTripLossToman.plus(
    projectedEntryCostToman.mul(safetyHeadroomBps).div(BPS)
  );

  if (requiredStopLossBps.gte(plan.config.stopLossBps)) {
    throw revalidationError(
      `ورود ${plan.symbol} رد شد: هزینه رفت‌وبرگشت فوری ${projectedRoundTripCostBps.toFixed(2)} BPS است و با حاشیه اجرا به ${requiredStopLossBps.toFixed(2)} BPS می‌رسد؛ Stop Loss برابر ${plan.config.stopLossBps.toFixed(2)} BPS است. هیچ سفارشی ارسال نشد`
    );
  }
  if (projectedWorstLossToman.gte(plan.config.maxLossToman)) {
    throw revalidationError(
      `ورود ${plan.symbol} رد شد: زیان رفت‌وبرگشت محافظه‌کارانه ${projectedWorstLossToman.toFixed(0)} تومان است و به سقف زیان ${plan.config.maxLossToman.toFixed(0)} تومان نزدیک یا بیشتر است. هیچ سفارشی ارسال نشد`
    );
  }

  return {
    projectedEntryCostToman,
    projectedImmediateExitToman,
    projectedRoundTripLossToman,
    projectedRoundTripCostBps,
    safetyHeadroomBps,
    requiredStopLossBps
  };
}

function assertEntryRoundTripRisk(quote: LegQuote, options: MarketOptions, plan: SpotPositionExecutionPlan) {
  assessSpotPositionRoundTripRisk(quote, options, plan);
}

function assertResidualWithinLimit(
  residualAmount: Decimal,
  referencePriceToman: Decimal,
  plan: SpotPositionExecutionPlan,
  phase: string
) {
  if (residualAmount.lte(0)) return;
  const residualValueToman = residualAmount.mul(referencePriceToman);
  if (residualValueToman.lte(plan.config.maxResidualToman)) return;
  throw new SpotPositionExecutionError(
    `${phase} left ${residualAmount.toString()} ${plan.asset}, worth about ${residualValueToman.toFixed(2)} IRT; the position is not flat and PnL must not be realized`,
    "UNTRADABLE_RESIDUAL",
    true
  );
}

function bestBidPrice(book: OrderBook) {
  const bid = book.bids
    .filter(level => level.price.gt(0) && level.amount.gt(0))
    .reduce<Decimal | undefined>((best, level) => !best || level.price.gt(best) ? level.price : best, undefined);
  if (!bid) throw revalidationError(`${book.symbol} has no executable bid`);
  return bid;
}

function assertOfficialMainnet(raw: string) {
  let hostname = "";
  try { hostname = new URL(raw).hostname.toLowerCase(); } catch { /* handled below */ }
  if (hostname !== OFFICIAL_MAINNET_HOSTNAME) {
    throw new SpotPositionExecutionError(
      `Spot position execution requires official Nobitex Mainnet https://${OFFICIAL_MAINNET_HOSTNAME}`,
      "MAINNET_REQUIRED"
    );
  }
}

class OrderStateUnknownError extends Error {
  constructor(orderId: string, options?: ErrorOptions) {
    super(`Order ${orderId} final state could not be confirmed`, options);
    this.name = "OrderStateUnknownError";
  }
}

function protectedExpectedPrice(side: Side, averagePrice: Decimal, slippageBps: Decimal) {
  const tolerance = Decimal.min(slippageBps.div(BPS), "0.009");
  return side === "BUY" ? averagePrice.mul(new Decimal(1).plus(tolerance)).div("1.01") : averagePrice.mul(new Decimal(1).minus(tolerance)).div("0.99");
}
function floorStep(value: Decimal, step: Decimal) { return value.div(step).floor().mul(step); }
function priceToStep(side: Side, value: Decimal, step: Decimal) {
  const units = value.div(step);
  return (side === "BUY" ? units.floor() : units.ceil()).mul(step);
}
function makeClientOrderId(plan: SpotPositionExecutionPlan, stage: SpotPositionOrderStage) {
  return `sp-${plan.asset.toLowerCase()}-${stage}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`.slice(0, 32);
}
function isTerminal(status: string) { return ["done", "canceled", "cancelled", "rejected"].includes(status.toLowerCase()); }
function isDefinitiveRejection(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  return message.startsWith("order rejected:") || message.includes("insufficient balance") || message.includes("invalid order");
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
function invalidPlan(message: string) { return new SpotPositionExecutionError(message, "INVALID_PLAN"); }
function revalidationError(message: string) { return new SpotPositionExecutionError(message, "REVALIDATION_FAILED"); }
function normalizeOrderError(error: unknown, prefix: string) {
  if (error instanceof OrderStateUnknownError) return new SpotPositionExecutionError(`${prefix}: ${error.message}`, "ORDER_STATE_UNKNOWN", true, { cause: error });
  if (error instanceof SpotPositionExecutionError) return error;
  return new SpotPositionExecutionError(`${prefix}: ${errorMessage(error)}`, "ORDER_FAILED", false, { cause: error });
}
async function safeHook(call: () => Promise<void> | void | undefined) {
  try { await call(); } catch { /* Audit telemetry must not strand an exposed position. */ }
}
function decimal(value: Decimal.Value, name: string) {
  try {
    const result = new Decimal(value);
    if (!result.isFinite()) throw new Error();
    return result;
  } catch { throw invalidPlan(`${name} must be a finite number`); }
}
function positiveDecimal(value: Decimal.Value, name: string) {
  const result = decimal(value, name);
  if (result.lte(0)) throw invalidPlan(`${name} must be positive`);
  return result;
}
function boundedDecimal(value: Decimal.Value, min: number, max: number, name: string) {
  const result = decimal(value, name);
  if (result.lt(min) || result.gt(max)) throw invalidPlan(`${name} must be between ${min} and ${max}`);
  return result;
}
function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw invalidPlan(`${name} must be a positive integer`);
  return value;
}
function nonNegativeInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidPlan(`${name} must be a non-negative integer`);
  return value;
}
function requiredString(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) throw invalidPlan(`${name} must be a non-empty string`);
  return value.trim();
}
