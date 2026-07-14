import Decimal from "decimal.js";
import { quoteEdge } from "@/lib/bot/engine";
import type { LegQuote } from "@/lib/bot/types";
import type {
  CandleSeries,
  MarginMarket,
  MarginPosition,
  MarketOptions,
  NobitexOrder,
  OrderBook,
  Wallet
} from "@/lib/exchanges/types";
import type { StrategySignal } from "./types";

const BPS = new Decimal(10_000);
const MAINNET_HOSTNAME = "apiv2.nobitex.ir";

export type StatisticalPairsDirection = "SHORT_A_LONG_B" | "LONG_A_SHORT_B";
export type StatisticalPairsOrderStage =
  | "margin-short"
  | "spot-long"
  | "margin-close"
  | "spot-close";

export type StatisticalPairsExecutionClient = {
  baseUrl?: string;
  getAllOrderBooks(): Promise<OrderBook[]>;
  getMarketOptions(): Promise<MarketOptions>;
  getMarginMarkets(): Promise<MarginMarket[]>;
  getMarginDelegationLimit(asset: string): Promise<Decimal>;
  getMarginQuoteWallet?(quote: "IRT" | "USDT"): Promise<Wallet>;
  getSpotTomanWallet?(): Promise<Wallet>;
  listMarginPositions(input?: { base?: string; quote?: "IRT" | "USDT"; status?: "active" | "past" }): Promise<MarginPosition[]>;
  getMarginPosition(id: string): Promise<MarginPosition>;
  placeMarginOrder(input: {
    side: "BUY" | "SELL";
    base: string;
    quote: "IRT" | "USDT";
    amountBase: Decimal;
    expectedPrice: Decimal;
    leverage: Decimal;
  }): Promise<NobitexOrder>;
  closeMarginPosition(input: {
    positionId: string;
    amountBase: Decimal;
    expectedPrice: Decimal;
    quote: "IRT" | "USDT";
  }): Promise<NobitexOrder>;
  placeMarketOrder(input: {
    side: "BUY" | "SELL";
    base: string;
    quote: string;
    amountBase: Decimal;
    expectedPrice: Decimal;
    clientOrderId: string;
  }): Promise<NobitexOrder>;
  getOrderStatus(id: string): Promise<NobitexOrder>;
  getOrderStatusByClientOrderId?(clientOrderId: string): Promise<NobitexOrder>;
  cancelOrder(id: string): Promise<void>;
  getCandles?(symbol: string, resolution?: string, countback?: number): Promise<CandleSeries>;
};

export type StatisticalPairsPlanInput = {
  grossNotionalToman?: Decimal.Value;
  leverage?: Decimal.Value;
  takerFeeBps: Decimal.Value;
  slippageBps: Decimal.Value;
  maxEntrySpreadBps?: Decimal.Value;
  maxPriceImpactBps?: Decimal.Value;
  depthUsagePercent?: Decimal.Value;
  hedgeToleranceBps?: Decimal.Value;
  maxBetaDriftBps?: Decimal.Value;
  minMarginRatio?: Decimal.Value;
  minLiquidationBufferBps?: Decimal.Value;
  maxAgeMs?: number;
  orderTimeoutMs?: number;
  maxHoldingMinutes?: number;
  exitZScore?: Decimal.Value;
  stopZScore?: Decimal.Value;
  resolution?: "15" | "30" | "60" | "240" | "D";
  lookback?: number;
};

export type StatisticalPairsExecutionPlan = {
  id: string;
  signalId: string;
  assetA: string;
  assetB: string;
  longAsset: string;
  shortAsset: string;
  direction: StatisticalPairsDirection;
  beta: Decimal;
  entryZScore: Decimal;
  grossNotionalToman: Decimal;
  longNotionalToman: Decimal;
  shortNotionalToman: Decimal;
  createdAt: number;
  config: {
    leverage: Decimal;
    takerFeeBps: Decimal;
    slippageBps: Decimal;
    maxEntrySpreadBps: Decimal;
    maxPriceImpactBps: Decimal;
    depthUsagePercent: Decimal;
    hedgeToleranceBps: Decimal;
    maxBetaDriftBps: Decimal;
    minMarginRatio: Decimal;
    minLiquidationBufferBps: Decimal;
    maxAgeMs: number;
    orderTimeoutMs: number;
    maxHoldingMs: number;
    exitZScore: Decimal;
    stopZScore: Decimal;
    resolution: "15" | "30" | "60" | "240" | "D";
    lookback: number;
  };
};

export type StatisticalPairsEntryValidation = {
  checkedAt: number;
  longQuote: LegQuote;
  shortQuote: LegQuote;
  longAmountBase: Decimal;
  shortAmountBase: Decimal;
  expectedHedgeRatio: Decimal;
  quotedHedgeRatio: Decimal;
  hedgeDeviationBps: Decimal;
  marginMarket: MarginMarket;
  delegationLimit: Decimal;
  marginAvailableToman: Decimal;
  spotAvailableToman: Decimal;
};

export type StatisticalPairsOpenPosition = {
  planId: string;
  marginPositionId: string;
  openedAt: number;
  longAsset: string;
  shortAsset: string;
  longAmountBase: Decimal;
  shortLiabilityBase: Decimal;
  initialLongCostToman: Decimal;
  entryZScore: Decimal;
};

export type StatisticalPairsOrderFill = {
  stage: StatisticalPairsOrderStage;
  symbol: string;
  side: "BUY" | "SELL";
  tradeType: "SPOT" | "MARGIN";
  orderId: string;
  status: string;
  requestedAmountBase: Decimal;
  matchedAmountBase: Decimal;
  unmatchedAmountBase: Decimal;
  averagePriceToman: Decimal;
  totalToman: Decimal;
  fee: Decimal;
  fullFill: boolean;
  raw: unknown;
};

export type StatisticalPairsEntryResult =
  | {
      status: "opened";
      plan: StatisticalPairsExecutionPlan;
      validation: StatisticalPairsEntryValidation;
      position: StatisticalPairsOpenPosition;
      fills: StatisticalPairsOrderFill[];
      actualHedgeDeviationBps: Decimal;
    }
  | {
      status: "recovered";
      plan: StatisticalPairsExecutionPlan;
      validation: StatisticalPairsEntryValidation;
      fills: StatisticalPairsOrderFill[];
      reason: string;
    };

export type StatisticalPairsCloseResult = {
  status: "closed";
  plan: StatisticalPairsExecutionPlan;
  position: StatisticalPairsOpenPosition;
  reason: "mean-reversion" | "stop-loss" | "max-holding" | "recovery";
  fills: StatisticalPairsOrderFill[];
  spotOutputToman: Decimal;
  marginRealizedPnlToman: Decimal;
  estimatedNetPnlToman: Decimal;
};

export type StatisticalPairsRecoveryResult = {
  status: "flat";
  plan: StatisticalPairsExecutionPlan;
  fills: StatisticalPairsOrderFill[];
  marginPositionId: string | null;
  recoveredLongAmountBase: Decimal;
};

export type StatisticalPairsHooks = {
  onRevalidated?: (event: { plan: StatisticalPairsExecutionPlan; validation: StatisticalPairsEntryValidation }) => Promise<void> | void;
  onBeforeOrder?: (event: {
    plan: StatisticalPairsExecutionPlan;
    stage: StatisticalPairsOrderStage;
    symbol: string;
    side: "BUY" | "SELL";
    amountBase: Decimal;
    expectedPrice: Decimal;
    clientOrderId?: string;
  }) => Promise<void> | void;
  onOrderSubmitted?: (event: {
    plan: StatisticalPairsExecutionPlan;
    stage: StatisticalPairsOrderStage;
    symbol: string;
    side: "BUY" | "SELL";
    tradeType: "SPOT" | "MARGIN";
    requestedAmountBase: Decimal;
    clientOrderId?: string;
    order: NobitexOrder;
  }) => Promise<void> | void;
  onOrderRejected?: (event: {
    plan: StatisticalPairsExecutionPlan;
    stage: "margin-short" | "spot-long";
    symbol: string;
    side: "BUY" | "SELL";
    reason: string;
  }) => Promise<void> | void;
  onOrderFinalized?: (event: { plan: StatisticalPairsExecutionPlan; fill: StatisticalPairsOrderFill }) => Promise<void> | void;
  onPositionOpened?: (event: { plan: StatisticalPairsExecutionPlan; position: StatisticalPairsOpenPosition }) => Promise<void> | void;
  onMarginPositionDiscovered?: (event: { plan: StatisticalPairsExecutionPlan; position: MarginPosition }) => Promise<void> | void;
  onRecoveryStarted?: (event: { plan: StatisticalPairsExecutionPlan; reason: string }) => Promise<void> | void;
};

export type StatisticalPairsExecutionOptions = {
  explicitMainnetMode?: true;
  baseUrl?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  revalidationDelayMs?: number;
};

export class StatisticalPairsExecutionError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "MAINNET_REQUIRED"
      | "INVALID_PLAN"
      | "SHORT_UNSUPPORTED"
      | "REVALIDATION_FAILED"
      | "ORDER_FAILED"
      | "ORDER_STATE_UNKNOWN"
      | "RECOVERY_FAILED",
    public readonly manualInterventionRequired = false,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "StatisticalPairsExecutionError";
  }
}

export function createStatisticalPairsExecutionPlan(
  signal: StrategySignal,
  input: StatisticalPairsPlanInput,
  now = Date.now()
): StatisticalPairsExecutionPlan {
  if (signal.kind !== "statistical-pairs" || signal.status !== "actionable" || signal.symbols.length !== 2) {
    throw new StatisticalPairsExecutionError("Only an actionable Statistical Pairs signal can become a plan", "INVALID_PLAN");
  }
  const assetA = parseIrtSymbol(signal.symbols[0]);
  const assetB = parseIrtSymbol(signal.symbols[1]);
  if (!assetA || !assetB || assetA === assetB) {
    throw new StatisticalPairsExecutionError("Pairs execution requires two distinct IRT Spot markets", "INVALID_PLAN");
  }
  const beta = positiveDecimal(signal.metrics.beta, "beta");
  const entryZScore = decimal(signal.metrics.zScore, "zScore");
  if (entryZScore.eq(0)) throw new StatisticalPairsExecutionError("Entry Z-Score cannot be zero", "INVALID_PLAN");
  const grossNotionalToman = positiveDecimal(input.grossNotionalToman ?? signal.metrics.notionalToman ?? 0, "grossNotionalToman");
  const direction: StatisticalPairsDirection = entryZScore.gt(0) ? "SHORT_A_LONG_B" : "LONG_A_SHORT_B";
  const unit = grossNotionalToman.div(beta.plus(1));
  const longNotionalToman = direction === "SHORT_A_LONG_B" ? unit.mul(beta) : unit;
  const shortNotionalToman = grossNotionalToman.minus(longNotionalToman);
  const exitZScore = boundedDecimal(input.exitZScore ?? signal.metrics.exitZScore ?? 0.35, 0, 5, "exitZScore");
  const stopZScore = boundedDecimal(input.stopZScore ?? 4, 0.01, 20, "stopZScore");
  if (stopZScore.lte(entryZScore.abs())) {
    throw new StatisticalPairsExecutionError("Stop Z-Score must be beyond the entry Z-Score", "INVALID_PLAN");
  }
  return {
    id: `pairs-mainnet:${assetA}:${assetB}:${signal.scannedAt}`,
    signalId: signal.id,
    assetA,
    assetB,
    longAsset: direction === "SHORT_A_LONG_B" ? assetB : assetA,
    shortAsset: direction === "SHORT_A_LONG_B" ? assetA : assetB,
    direction,
    beta,
    entryZScore,
    grossNotionalToman,
    longNotionalToman,
    shortNotionalToman,
    createdAt: now,
    config: {
      leverage: boundedDecimal(input.leverage ?? 1, 1, 2, "leverage"),
      takerFeeBps: boundedDecimal(input.takerFeeBps, 0, 10_000, "takerFeeBps"),
      slippageBps: boundedDecimal(input.slippageBps, 0, 2_000, "slippageBps"),
      maxEntrySpreadBps: boundedDecimal(input.maxEntrySpreadBps ?? 120, 0, 2_000, "maxEntrySpreadBps"),
      maxPriceImpactBps: boundedDecimal(input.maxPriceImpactBps ?? 75, 0, 2_000, "maxPriceImpactBps"),
      depthUsagePercent: boundedDecimal(input.depthUsagePercent ?? 75, 0.000001, 100, "depthUsagePercent"),
      hedgeToleranceBps: boundedDecimal(input.hedgeToleranceBps ?? 75, 0, 1_000, "hedgeToleranceBps"),
      maxBetaDriftBps: boundedDecimal(input.maxBetaDriftBps ?? 1_000, 0, 5_000, "maxBetaDriftBps"),
      minMarginRatio: boundedDecimal(input.minMarginRatio ?? 1.35, 1, 10, "minMarginRatio"),
      minLiquidationBufferBps: boundedDecimal(input.minLiquidationBufferBps ?? 1_500, 0, 10_000, "minLiquidationBufferBps"),
      maxAgeMs: positiveInteger(input.maxAgeMs ?? 10_000, "maxAgeMs"),
      orderTimeoutMs: positiveInteger(input.orderTimeoutMs ?? 15_000, "orderTimeoutMs"),
      maxHoldingMs: positiveInteger(input.maxHoldingMinutes ?? 240, "maxHoldingMinutes") * 60_000,
      exitZScore,
      stopZScore,
      resolution: input.resolution ?? "60",
      lookback: boundedInteger(input.lookback ?? Number(signal.metrics.lookback ?? 120), 30, 500, "lookback")
    }
  };
}

export function evaluateStatisticalPairsLifecycle(
  plan: StatisticalPairsExecutionPlan,
  currentZScore: Decimal.Value,
  openedAt: number,
  now = Date.now()
): { action: "HOLD" | "EXIT_MEAN" | "EXIT_STOP" | "EXIT_MAX_HOLDING"; reason: string } {
  const current = decimal(currentZScore, "currentZScore");
  if (current.abs().gte(plan.config.stopZScore)) {
    return { action: "EXIT_STOP", reason: "Current Z-Score reached the configured model stop" };
  }
  if (current.abs().lte(plan.config.exitZScore) || current.isPositive() !== plan.entryZScore.isPositive()) {
    return { action: "EXIT_MEAN", reason: "The spread reached or crossed its configured mean-exit band" };
  }
  if (now - openedAt >= plan.config.maxHoldingMs) {
    return { action: "EXIT_MAX_HOLDING", reason: "Maximum holding time was reached" };
  }
  return { action: "HOLD", reason: "No statistical exit condition is active" };
}

export async function revalidateStatisticalPairsEntry(
  plan: StatisticalPairsExecutionPlan,
  books: OrderBook[],
  marginMarkets: MarginMarket[],
  delegationLimit: Decimal,
  marginAvailableToman: Decimal,
  spotAvailableToman: Decimal,
  marketOptions: MarketOptions,
  now = Date.now()
): Promise<StatisticalPairsEntryValidation> {
  const longBook = books.find(book => book.symbol.toUpperCase() === `${plan.longAsset}IRT`);
  const shortBook = books.find(book => book.symbol.toUpperCase() === `${plan.shortAsset}IRT`);
  if (!longBook || !shortBook) throw validationError("A required IRT orderbook is unavailable");
  assertFresh(longBook, now, plan.config.maxAgeMs);
  assertFresh(shortBook, now, plan.config.maxAgeMs);
  const marginMarket = marginMarkets.find(market => market.symbol === `${plan.shortAsset}IRT`);
  if (!marginMarket || !marginMarket.sellEnabled) {
    throw new StatisticalPairsExecutionError(
      `${plan.shortAsset}IRT is not enabled for Margin short selling on this account/environment`,
      "SHORT_UNSUPPORTED"
    );
  }
  if (marginMarket.maxLeverage.lt(plan.config.leverage)) {
    throw new StatisticalPairsExecutionError(
      `Requested leverage ${plan.config.leverage.toString()} exceeds ${plan.shortAsset}IRT maximum ${marginMarket.maxLeverage.toString()}`,
      "SHORT_UNSUPPORTED"
    );
  }
  const longQuote = quoteEdge(edge("BUY", longBook), plan.longNotionalToman, plan.config.takerFeeBps, plan.config.slippageBps, plan.config.depthUsagePercent);
  const bestShortBid = shortBook.bids[0]?.price;
  if (!bestShortBid || bestShortBid.lte(0)) throw validationError("Short market has no usable bid");
  const rawShortAmount = plan.shortNotionalToman.div(bestShortBid);
  const shortQuote = quoteEdge(edge("SELL", shortBook), rawShortAmount, plan.config.takerFeeBps, plan.config.slippageBps, plan.config.depthUsagePercent);
  if (!longQuote || !shortQuote) throw validationError("Visible depth cannot support both pair legs");
  assertQuoteRisk(longQuote, plan, "long leg");
  assertQuoteRisk(shortQuote, plan, "short leg");
  const longAmountStep = marketOptions.amountSteps[longBook.symbol] ?? new Decimal("0.00000001");
  const shortAmountStep = marketOptions.amountSteps[shortBook.symbol] ?? new Decimal("0.00000001");
  const longAmountBase = floorStep(longQuote.grossOutput, longAmountStep);
  const shortAmountBase = floorStep(rawShortAmount, shortAmountStep);
  if (longAmountBase.lte(0) || shortAmountBase.lte(0)) throw validationError("Exchange precision rounded a pair leg to zero");
  assertMinimumIrtOrder(plan.longNotionalToman, marketOptions, "long leg");
  assertMinimumIrtOrder(plan.shortNotionalToman, marketOptions, "short leg");
  if (delegationLimit.lt(shortAmountBase)) {
    throw new StatisticalPairsExecutionError(
      `Margin delegation limit ${delegationLimit.toString()} ${plan.shortAsset} is below required ${shortAmountBase.toString()}`,
      "SHORT_UNSUPPORTED"
    );
  }
  // Margin collateral must already be present in the Margin quote wallet. The
  // full short notional is required here even when leverage is greater than one;
  // this intentionally rejects some valid entries instead of underestimating
  // Nobitex collateral requirements.
  if (marginAvailableToman.lt(plan.shortNotionalToman)) {
    throw new StatisticalPairsExecutionError(
      `Free IRT Margin collateral ${marginAvailableToman.toString()} is below conservative requirement ${plan.shortNotionalToman.toString()}`,
      "SHORT_UNSUPPORTED"
    );
  }
  const protectedLongBudget = plan.longNotionalToman.mul(BPS.plus(plan.config.slippageBps)).div(BPS);
  if (spotAvailableToman.lt(protectedLongBudget)) {
    throw new StatisticalPairsExecutionError(
      `Free Spot IRT ${spotAvailableToman.toString()} is below protected long-leg budget ${protectedLongBudget.toString()}`,
      "REVALIDATION_FAILED"
    );
  }
  const expectedHedgeRatio = plan.shortNotionalToman.div(plan.longNotionalToman);
  const quotedHedgeRatio = shortQuote.output.div(longQuote.input);
  const hedgeDeviationBps = quotedHedgeRatio.div(expectedHedgeRatio).minus(1).abs().mul(BPS);
  if (hedgeDeviationBps.gt(plan.config.hedgeToleranceBps)) {
    throw validationError(`Quoted hedge deviation ${hedgeDeviationBps.toFixed(2)} BPS exceeds tolerance`);
  }
  return {
    checkedAt: now,
    longQuote,
    shortQuote,
    longAmountBase,
    shortAmountBase,
    expectedHedgeRatio,
    quotedHedgeRatio,
    hedgeDeviationBps,
    marginMarket,
    delegationLimit,
    marginAvailableToman,
    spotAvailableToman
  };
}

export async function enterStatisticalPairs(
  plan: StatisticalPairsExecutionPlan,
  client: StatisticalPairsExecutionClient,
  hooks: StatisticalPairsHooks = {},
  options: StatisticalPairsExecutionOptions = {}
): Promise<StatisticalPairsEntryResult> {
  assertMainnet(client, options);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  if (!client.getMarginQuoteWallet || !client.getSpotTomanWallet) {
    throw new StatisticalPairsExecutionError("Spot/Margin wallet preflight is unavailable on this adapter", "SHORT_UNSUPPORTED");
  }
  const [marketOptions, marginMarkets, delegationLimit, marginWallet, spotWallet, existingPositions] = await Promise.all([
    client.getMarketOptions(),
    client.getMarginMarkets(),
    client.getMarginDelegationLimit(plan.shortAsset),
    client.getMarginQuoteWallet("IRT"),
    client.getSpotTomanWallet(),
    client.listMarginPositions({ base: plan.shortAsset, quote: "IRT", status: "active" })
  ]);
  if (existingPositions.some(position => isOpen(position.status))) {
    throw new StatisticalPairsExecutionError(
      `An existing ${plan.shortAsset}IRT Margin position prevents unambiguous position ownership`,
      "SHORT_UNSUPPORTED"
    );
  }
  const beforeIds = new Set(existingPositions.map(position => position.id));
  const first = await revalidateStatisticalPairsEntry(
    plan,
    await client.getAllOrderBooks(),
    marginMarkets,
    delegationLimit,
    marginWallet.available,
    spotWallet.available,
    marketOptions,
    now()
  );
  await safeHook(() => hooks.onRevalidated?.({ plan, validation: first }));
  const delay = Math.max(0, options.revalidationDelayMs ?? 250);
  if (delay) await sleep(delay);
  const validation = await revalidateStatisticalPairsEntry(
    plan,
    await client.getAllOrderBooks(),
    marginMarkets,
    delegationLimit,
    marginWallet.available,
    spotWallet.available,
    marketOptions,
    now()
  );
  await safeHook(() => hooks.onRevalidated?.({ plan, validation }));
  const fills: StatisticalPairsOrderFill[] = [];

  const shortPrice = protectedPrice("SELL", validation.shortQuote.averagePrice, plan.config.slippageBps);
  await hooks.onBeforeOrder?.({
    plan,
    stage: "margin-short",
    symbol: `${plan.shortAsset}IRT`,
    side: "SELL",
    amountBase: validation.shortAmountBase,
    expectedPrice: shortPrice
  });
  let shortInitial: NobitexOrder;
  try {
    shortInitial = await client.placeMarginOrder({
      side: "SELL",
      base: plan.shortAsset,
      quote: "IRT",
      amountBase: validation.shortAmountBase,
      expectedPrice: shortPrice,
      leverage: plan.config.leverage
    });
  } catch (error) {
    const normalized = normalizeSubmissionError(error, "Margin short submission has an unknown state");
    if (normalized.code === "ORDER_FAILED") {
      await safeHook(() => hooks.onOrderRejected?.({
        plan, stage: "margin-short", symbol: `${plan.shortAsset}IRT`, side: "SELL", reason: normalized.message
      }));
    }
    throw normalized;
  }
  await safeHook(() => hooks.onOrderSubmitted?.({
    plan,
    stage: "margin-short",
    symbol: `${plan.shortAsset}IRT`,
    side: "SELL",
    tradeType: "MARGIN",
    requestedAmountBase: validation.shortAmountBase,
    order: shortInitial
  }));
  const shortFinal = await waitForFinalOrder(client, shortInitial, plan.config.orderTimeoutMs, sleep);
  const shortFill = makeFill("margin-short", `${plan.shortAsset}IRT`, "SELL", "MARGIN", validation.shortAmountBase, shortFinal);
  fills.push(shortFill);
  await safeHook(() => hooks.onOrderFinalized?.({ plan, fill: shortFill }));
  if (shortFill.matchedAmountBase.lte(0)) {
    throw new StatisticalPairsExecutionError("Margin short received no confirmed fill", "ORDER_FAILED");
  }

  const marginPosition = await discoverNewPosition(client, plan.shortAsset, beforeIds, plan.config.orderTimeoutMs, sleep);
  if (!marginPosition) {
    throw new StatisticalPairsExecutionError(
      "The Margin order filled but its Position could not be uniquely reconciled; do not submit the Spot leg",
      "ORDER_STATE_UNKNOWN",
      true
    );
  }
  try {
    await hooks.onMarginPositionDiscovered?.({ plan, position: marginPosition });
  } catch (error) {
    await safeHook(() => hooks.onRecoveryStarted?.({ plan, reason: "Margin Position ownership could not be persisted" }));
    await closeShortOnly(plan, marginPosition, client, marketOptions, hooks, fills, sleep, now());
    return { status: "recovered", plan, validation, fills, reason: `Margin Position persistence failed: ${errorMessage(error)}` };
  }
  if (!shortFill.fullFill) {
    await safeHook(() => hooks.onRecoveryStarted?.({ plan, reason: "Margin short partially filled" }));
    await closeShortOnly(plan, marginPosition, client, marketOptions, hooks, fills, sleep, now());
    return { status: "recovered", plan, validation, fills, reason: "Margin short partially filled and was closed" };
  }

  const longPrice = protectedPrice("BUY", validation.longQuote.averagePrice, plan.config.slippageBps);
  const spotLongClientOrderId = clientOrderId(plan, "long");
  try {
    await hooks.onBeforeOrder?.({
      plan,
      stage: "spot-long",
      symbol: `${plan.longAsset}IRT`,
      side: "BUY",
      amountBase: validation.longAmountBase,
      expectedPrice: longPrice,
      clientOrderId: spotLongClientOrderId
    });
  } catch (error) {
    await safeHook(() => hooks.onRecoveryStarted?.({ plan, reason: "Spot hedge was blocked before submission" }));
    await closeShortOnly(plan, marginPosition, client, marketOptions, hooks, fills, sleep, now());
    return { status: "recovered", plan, validation, fills, reason: `Spot hedge was blocked and Margin short was closed: ${errorMessage(error)}` };
  }
  let longInitial: NobitexOrder;
  try {
    longInitial = await client.placeMarketOrder({
      side: "BUY",
      base: plan.longAsset,
      quote: "IRT",
      amountBase: validation.longAmountBase,
      expectedPrice: longPrice,
      clientOrderId: spotLongClientOrderId
    });
  } catch (error) {
    if (!isDefinitiveRejection(error)) {
      try {
        longInitial = await lookupAcceptedSpotOrder(client, spotLongClientOrderId, sleep);
      } catch (lookupError) {
        throw new StatisticalPairsExecutionError(
          "Spot long submission is ambiguous and clientOrderId lookup failed; the Margin short remains open to avoid an incorrect double recovery",
          "ORDER_STATE_UNKNOWN",
          true,
          { cause: new AggregateError([error, lookupError], "Spot long submission reconciliation failed") }
        );
      }
    } else {
      await safeHook(() => hooks.onOrderRejected?.({
        plan, stage: "spot-long", symbol: `${plan.longAsset}IRT`, side: "BUY", reason: errorMessage(error)
      }));
      await safeHook(() => hooks.onRecoveryStarted?.({ plan, reason: "Spot long was definitively rejected" }));
      await closeShortOnly(plan, marginPosition, client, marketOptions, hooks, fills, sleep, now());
      return { status: "recovered", plan, validation, fills, reason: "Spot long was rejected and Margin short was closed" };
    }
  }
  await safeHook(() => hooks.onOrderSubmitted?.({
    plan,
    stage: "spot-long",
    symbol: `${plan.longAsset}IRT`,
    side: "BUY",
    tradeType: "SPOT",
    requestedAmountBase: validation.longAmountBase,
    clientOrderId: spotLongClientOrderId,
    order: longInitial
  }));
  const longFinal = await waitForFinalOrder(client, longInitial, plan.config.orderTimeoutMs, sleep);
  const longFill = makeFill("spot-long", `${plan.longAsset}IRT`, "BUY", "SPOT", validation.longAmountBase, longFinal);
  fills.push(longFill);
  await safeHook(() => hooks.onOrderFinalized?.({ plan, fill: longFill }));
  const longAmount = Decimal.max(longFill.matchedAmountBase.minus(longFill.fee), 0);
  if (!longFill.fullFill) {
    await safeHook(() => hooks.onRecoveryStarted?.({ plan, reason: "Spot long partially filled" }));
    await flattenPair(plan, marginPosition, longAmount, client, marketOptions, hooks, fills, sleep, now());
    return { status: "recovered", plan, validation, fills, reason: "Spot long partially filled; both exposures were flattened" };
  }

  const livePosition = await client.getMarginPosition(marginPosition.id);
  if (!isOpen(livePosition.status) || livePosition.liability.lte(0)) {
    throw new StatisticalPairsExecutionError("Margin Position is not confirmed Open after both entry fills", "ORDER_STATE_UNKNOWN", true);
  }
  const actualLongNotional = longFill.totalToman;
  const shortAverage = shortFill.averagePriceToman.gt(0) ? shortFill.averagePriceToman : validation.shortQuote.averagePrice;
  const actualShortNotional = shortFill.matchedAmountBase.mul(shortAverage);
  const actualRatio = actualShortNotional.div(actualLongNotional);
  const actualHedgeDeviationBps = actualRatio.div(validation.expectedHedgeRatio).minus(1).abs().mul(BPS);
  if (!actualHedgeDeviationBps.isFinite() || actualHedgeDeviationBps.gt(plan.config.hedgeToleranceBps)) {
    await safeHook(() => hooks.onRecoveryStarted?.({ plan, reason: "Actual fills exceeded hedge tolerance" }));
    await flattenPair(plan, livePosition, longAmount, client, marketOptions, hooks, fills, sleep, now());
    return { status: "recovered", plan, validation, fills, reason: "Actual fill hedge ratio exceeded tolerance" };
  }
  const position: StatisticalPairsOpenPosition = {
    planId: plan.id,
    marginPositionId: livePosition.id,
    openedAt: now(),
    longAsset: plan.longAsset,
    shortAsset: plan.shortAsset,
    longAmountBase: longAmount,
    shortLiabilityBase: livePosition.liability,
    initialLongCostToman: longFill.totalToman,
    entryZScore: plan.entryZScore
  };
  await safeHook(() => hooks.onPositionOpened?.({ plan, position }));
  return { status: "opened", plan, validation, position, fills, actualHedgeDeviationBps };
}

export async function closeStatisticalPairs(
  plan: StatisticalPairsExecutionPlan,
  position: StatisticalPairsOpenPosition,
  reason: StatisticalPairsCloseResult["reason"],
  client: StatisticalPairsExecutionClient,
  hooks: StatisticalPairsHooks = {},
  options: StatisticalPairsExecutionOptions = {}
): Promise<StatisticalPairsCloseResult> {
  assertMainnet(client, options);
  assertPositionMatchesPlan(plan, position);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const marketOptions = await client.getMarketOptions();
  let live = await client.getMarginPosition(position.marginPositionId);
  if (live.base !== plan.shortAsset || live.quote !== "IRT") {
    throw new StatisticalPairsExecutionError("Recorded Margin Position does not belong to this plan", "ORDER_STATE_UNKNOWN", true);
  }
  live = await waitForRecoverableMarginState(live, client, plan.config.orderTimeoutMs, sleep);
  const fills: StatisticalPairsOrderFill[] = [];
  if (isOpen(live.status)) await closeShortOnly(plan, live, client, marketOptions, hooks, fills, sleep, now());
  if (position.longAmountBase.gt(0)) {
    await sellLong(plan, position.longAmountBase, client, marketOptions, hooks, fills, sleep, now());
  }
  const finalPosition = await client.getMarginPosition(position.marginPositionId);
  if (!isClosed(finalPosition.status)) {
    throw new StatisticalPairsExecutionError("Margin Position is not confirmed closed after close order", "ORDER_STATE_UNKNOWN", true);
  }
  const spotOutputToman = fills
    .filter(fill => fill.stage === "spot-close")
    .reduce((sum, fill) => sum.plus(fill.totalToman).minus(fill.fee), new Decimal(0));
  const estimatedNetPnlToman = spotOutputToman.minus(position.initialLongCostToman).plus(finalPosition.realizedPnl);
  return {
    status: "closed",
    plan,
    position,
    reason,
    fills,
    spotOutputToman,
    marginRealizedPnlToman: finalPosition.realizedPnl,
    estimatedNetPnlToman
  };
}

/**
 * Crash/restart recovery primitive. Callers must first reconcile persisted Spot
 * order ids; this function only accepts a confirmed long amount. It never guesses
 * wallet inventory because the Spot wallet can contain unrelated user assets.
 */
export async function recoverStatisticalPairs(
  plan: StatisticalPairsExecutionPlan,
  input: { marginPositionId?: string | null; confirmedLongAmountBase: Decimal.Value },
  client: StatisticalPairsExecutionClient,
  hooks: StatisticalPairsHooks = {},
  options: StatisticalPairsExecutionOptions = {}
): Promise<StatisticalPairsRecoveryResult> {
  assertMainnet(client, options);
  const longAmount = decimal(input.confirmedLongAmountBase, "confirmedLongAmountBase");
  if (longAmount.lt(0)) throw new StatisticalPairsExecutionError("Confirmed long amount cannot be negative", "INVALID_PLAN");
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const marketOptions = await client.getMarketOptions();
  let margin: MarginPosition | undefined;
  if (input.marginPositionId) {
    if (!/^\d+$/.test(input.marginPositionId)) throw new StatisticalPairsExecutionError("Invalid persisted Margin Position id", "INVALID_PLAN");
    margin = await client.getMarginPosition(input.marginPositionId);
    if (margin.base !== plan.shortAsset || margin.quote !== "IRT") {
      throw new StatisticalPairsExecutionError("Persisted Margin Position does not belong to this pair", "ORDER_STATE_UNKNOWN", true);
    }
  }
  if (margin) margin = await waitForRecoverableMarginState(margin, client, plan.config.orderTimeoutMs, sleep);
  const fills: StatisticalPairsOrderFill[] = [];
  if (margin && isOpen(margin.status)) {
    await closeShortOnly(plan, margin, client, marketOptions, hooks, fills, sleep, now());
  }
  if (longAmount.gt(0)) {
    await sellLong(plan, longAmount, client, marketOptions, hooks, fills, sleep, now());
  }
  return {
    status: "flat",
    plan,
    fills,
    marginPositionId: margin?.id ?? null,
    recoveredLongAmountBase: longAmount
  };
}

async function flattenPair(
  plan: StatisticalPairsExecutionPlan,
  position: MarginPosition,
  longAmount: Decimal,
  client: StatisticalPairsExecutionClient,
  options: MarketOptions,
  hooks: StatisticalPairsHooks,
  fills: StatisticalPairsOrderFill[],
  sleep: (ms: number) => Promise<void>,
  now: number
) {
  await closeShortOnly(plan, position, client, options, hooks, fills, sleep, now);
  if (longAmount.gt(0)) await sellLong(plan, longAmount, client, options, hooks, fills, sleep, now);
}

async function closeShortOnly(
  plan: StatisticalPairsExecutionPlan,
  position: MarginPosition,
  client: StatisticalPairsExecutionClient,
  options: MarketOptions,
  hooks: StatisticalPairsHooks,
  fills: StatisticalPairsOrderFill[],
  sleep: (ms: number) => Promise<void>,
  now: number
) {
  const live = await client.getMarginPosition(position.id);
  const liability = Decimal.max(live.liability.minus(live.liabilityInOrder), 0);
  if (!isOpen(live.status) || liability.lte(0)) {
    if (isClosed(live.status)) return;
    throw new StatisticalPairsExecutionError("Margin liability cannot be reconciled for recovery", "RECOVERY_FAILED", true);
  }
  const books = await client.getAllOrderBooks();
  const book = books.find(item => item.symbol.toUpperCase() === `${plan.shortAsset}IRT`);
  if (!book) throw recoveryError("Margin close orderbook is unavailable");
  assertFresh(book, now, plan.config.maxAgeMs);
  const quote = quoteEdge(edge("BUY", book), liability.mul(book.asks[0]?.price ?? 0), plan.config.takerFeeBps, plan.config.slippageBps, 100);
  if (!quote) throw recoveryError("Margin close orderbook has insufficient depth");
  assertQuoteRisk(quote, plan, "margin recovery");
  // Nobitex defines a final Margin close by the exact remaining liability. That
  // value can contain accrued-fee precision beyond the Spot amount step; flooring
  // it would deliberately leave debt and keep the Position open.
  const amount = liability;
  if (amount.lte(0)) throw recoveryError("Margin close amount rounded to zero");
  const price = protectedPrice("BUY", quote.averagePrice, plan.config.slippageBps);
  await hooks.onBeforeOrder?.({ plan, stage: "margin-close", symbol: book.symbol, side: "BUY", amountBase: amount, expectedPrice: price });
  let initial: NobitexOrder;
  try {
    initial = await client.closeMarginPosition({ positionId: live.id, amountBase: amount, expectedPrice: price, quote: "IRT" });
  } catch (error) {
    throw new StatisticalPairsExecutionError("Margin close submission is ambiguous; Spot exposure was not changed", "ORDER_STATE_UNKNOWN", true, { cause: error });
  }
  await safeHook(() => hooks.onOrderSubmitted?.({
    plan, stage: "margin-close", symbol: book.symbol, side: "BUY", tradeType: "MARGIN",
    requestedAmountBase: amount, order: initial
  }));
  const final = await waitForFinalOrder(client, initial, plan.config.orderTimeoutMs, sleep);
  const fill = makeFill("margin-close", book.symbol, "BUY", "MARGIN", amount, final);
  fills.push(fill);
  await safeHook(() => hooks.onOrderFinalized?.({ plan, fill }));
  if (!fill.fullFill) throw recoveryError("Margin close did not fill completely", true);
  const deadline = Date.now() + plan.config.orderTimeoutMs;
  while (Date.now() < deadline) {
    const status = await client.getMarginPosition(live.id).catch(error => {
      throw new StatisticalPairsExecutionError("Margin Position status became unknown after close", "ORDER_STATE_UNKNOWN", true, { cause: error });
    });
    if (isClosed(status.status)) return;
    await sleep(100);
  }
  throw new StatisticalPairsExecutionError("Margin Position did not become Closed before timeout", "ORDER_STATE_UNKNOWN", true);
}

async function sellLong(
  plan: StatisticalPairsExecutionPlan,
  longAmount: Decimal,
  client: StatisticalPairsExecutionClient,
  options: MarketOptions,
  hooks: StatisticalPairsHooks,
  fills: StatisticalPairsOrderFill[],
  sleep: (ms: number) => Promise<void>,
  now: number
) {
  const books = await client.getAllOrderBooks();
  const book = books.find(item => item.symbol.toUpperCase() === `${plan.longAsset}IRT`);
  if (!book) throw recoveryError("Spot close orderbook is unavailable", true);
  assertFresh(book, now, plan.config.maxAgeMs);
  const amountStep = options.amountSteps[book.symbol] ?? new Decimal("0.00000001");
  const amount = floorStep(longAmount, amountStep);
  const quote = quoteEdge(edge("SELL", book), amount, plan.config.takerFeeBps, plan.config.slippageBps, 100);
  if (!quote) throw recoveryError("Spot close orderbook has insufficient depth", true);
  assertQuoteRisk(quote, plan, "spot recovery");
  assertMinimumIrtOrder(quote.output, options, "spot recovery");
  const price = protectedPrice("SELL", quote.averagePrice, plan.config.slippageBps);
  const spotCloseClientOrderId = clientOrderId(plan, "close");
  await hooks.onBeforeOrder?.({ plan, stage: "spot-close", symbol: book.symbol, side: "SELL", amountBase: amount, expectedPrice: price, clientOrderId: spotCloseClientOrderId });
  let initial: NobitexOrder;
  try {
    initial = await client.placeMarketOrder({
      side: "SELL", base: plan.longAsset, quote: "IRT", amountBase: amount,
      expectedPrice: price, clientOrderId: spotCloseClientOrderId
    });
  } catch (error) {
    if (isDefinitiveRejection(error)) throw recoveryError(`Spot close was rejected: ${errorMessage(error)}`);
    try {
      initial = await lookupAcceptedSpotOrder(client, spotCloseClientOrderId, sleep);
    } catch (lookupError) {
      throw new StatisticalPairsExecutionError(
        "Spot close submission is ambiguous and clientOrderId lookup failed; inspect the Mainnet wallet",
        "ORDER_STATE_UNKNOWN",
        true,
        { cause: new AggregateError([error, lookupError], "Spot close submission reconciliation failed") }
      );
    }
  }
  await safeHook(() => hooks.onOrderSubmitted?.({
    plan, stage: "spot-close", symbol: book.symbol, side: "SELL", tradeType: "SPOT",
    requestedAmountBase: amount, clientOrderId: spotCloseClientOrderId, order: initial
  }));
  const final = await waitForFinalOrder(client, initial, plan.config.orderTimeoutMs, sleep);
  const fill = makeFill("spot-close", book.symbol, "SELL", "SPOT", amount, final);
  fills.push(fill);
  await safeHook(() => hooks.onOrderFinalized?.({ plan, fill }));
  if (!fill.fullFill) throw recoveryError("Spot close did not fill completely and residual inventory remains", true);
}

async function discoverNewPosition(
  client: StatisticalPairsExecutionClient,
  shortAsset: string,
  beforeIds: Set<string>,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidates = (await client.listMarginPositions({ base: shortAsset, quote: "IRT", status: "active" }))
      .filter(position => isOpen(position.status) && !beforeIds.has(position.id));
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) return undefined;
    await sleep(100);
  }
  return undefined;
}

async function waitForRecoverableMarginState(
  initial: MarginPosition,
  client: StatisticalPairsExecutionClient,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>
) {
  let position = initial;
  const deadline = Date.now() + timeoutMs;
  while (!isOpen(position.status) && !isClosed(position.status) && Date.now() < deadline) {
    await sleep(100);
    position = await client.getMarginPosition(position.id).catch(error => {
      throw new StatisticalPairsExecutionError("Margin Position state is unknown during recovery", "ORDER_STATE_UNKNOWN", true, { cause: error });
    });
  }
  if (!isOpen(position.status) && !isClosed(position.status)) {
    throw new StatisticalPairsExecutionError("Margin Position never reached a recoverable Open/Closed state", "ORDER_STATE_UNKNOWN", true);
  }
  return position;
}

async function waitForFinalOrder(
  client: StatisticalPairsExecutionClient,
  initial: NobitexOrder,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>
) {
  const deadline = Date.now() + timeoutMs;
  let order = initial;
  while (Date.now() < deadline) {
    if (isTerminal(order.status)) return order;
    await sleep(100);
    try { order = await client.getOrderStatus(order.id); }
    catch (error) {
      throw new StatisticalPairsExecutionError("Order status is unknown", "ORDER_STATE_UNKNOWN", true, { cause: error });
    }
  }
  try { await client.cancelOrder(initial.id); }
  catch (error) {
    throw new StatisticalPairsExecutionError("Timed-out order could not be canceled", "ORDER_STATE_UNKNOWN", true, { cause: error });
  }
  try {
    const final = await client.getOrderStatus(initial.id);
    if (!isTerminal(final.status)) {
      throw new StatisticalPairsExecutionError("Order remained active after cancellation", "ORDER_STATE_UNKNOWN", true);
    }
    return final;
  }
  catch (error) {
    if (error instanceof StatisticalPairsExecutionError) throw error;
    throw new StatisticalPairsExecutionError("Canceled order final state is unknown", "ORDER_STATE_UNKNOWN", true, { cause: error });
  }
}

async function lookupAcceptedSpotOrder(
  client: StatisticalPairsExecutionClient,
  clientOrderId: string,
  sleep: (ms: number) => Promise<void>
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
      if (attempt < 2) await sleep(100);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("clientOrderId lookup failed");
}

function makeFill(
  stage: StatisticalPairsOrderStage,
  symbol: string,
  side: "BUY" | "SELL",
  tradeType: "SPOT" | "MARGIN",
  requestedAmountBase: Decimal,
  order: NobitexOrder
): StatisticalPairsOrderFill {
  const averagePriceToman = order.averagePrice.div(10);
  const totalToman = order.totalPrice.gt(0)
    ? order.totalPrice.div(10)
    : order.matchedAmount.mul(averagePriceToman);
  const normalizedFee = side === "SELL" ? order.fee.div(10) : order.fee;
  return {
    stage,
    symbol,
    side,
    tradeType,
    orderId: order.id,
    status: order.status,
    requestedAmountBase,
    matchedAmountBase: order.matchedAmount,
    unmatchedAmountBase: order.unmatchedAmount,
    averagePriceToman,
    totalToman,
    fee: normalizedFee,
    fullFill: order.matchedAmount.gte(requestedAmountBase) && order.unmatchedAmount.lte(0) && isDone(order.status),
    raw: order.raw
  };
}

function assertMainnet(client: StatisticalPairsExecutionClient, options: StatisticalPairsExecutionOptions) {
  if (options.explicitMainnetMode === true) return;
  const value = options.baseUrl ?? client.baseUrl;
  let hostname = "";
  try { hostname = value ? new URL(value).hostname.toLowerCase() : ""; } catch { hostname = ""; }
  if (hostname !== MAINNET_HOSTNAME) {
    throw new StatisticalPairsExecutionError("Statistical Pairs execution requires official Nobitex Mainnet", "MAINNET_REQUIRED");
  }
}

function assertPositionMatchesPlan(plan: StatisticalPairsExecutionPlan, position: StatisticalPairsOpenPosition) {
  if (position.planId !== plan.id || position.longAsset !== plan.longAsset || position.shortAsset !== plan.shortAsset || !/^\d+$/.test(position.marginPositionId)) {
    throw new StatisticalPairsExecutionError("Open Position does not belong to this immutable pair plan", "INVALID_PLAN");
  }
}

function assertQuoteRisk(quote: LegQuote, plan: StatisticalPairsExecutionPlan, label: string) {
  if (quote.spreadBps.gt(plan.config.maxEntrySpreadBps)) throw validationError(`${label} spread exceeds the configured limit`);
  if (quote.priceImpactBps.gt(plan.config.maxPriceImpactBps)) throw validationError(`${label} price impact exceeds the configured limit`);
}

function assertFresh(book: OrderBook, now: number, maxAgeMs: number) {
  if (!book.lastUpdate || now - book.lastUpdate > maxAgeMs || book.lastUpdate > now + 5_000) {
    throw validationError(`${book.symbol} orderbook is stale or timestamp-invalid`);
  }
}

function assertMinimumIrtOrder(notionalToman: Decimal, options: MarketOptions, label: string) {
  if (notionalToman.mul(10).lt(options.minOrderRial)) throw validationError(`${label} is below the Nobitex minimum IRT order`);
}

function edge(side: "BUY" | "SELL", book: OrderBook) {
  return {
    id: `${book.symbol}:${side}`,
    from: side === "BUY" ? book.quote : book.base,
    to: side === "BUY" ? book.base : book.quote,
    side,
    book
  } as const;
}

function protectedPrice(side: "BUY" | "SELL", average: Decimal, slippageBps: Decimal) {
  return side === "BUY" ? average.mul(BPS.plus(slippageBps)).div(BPS) : average.mul(BPS.minus(slippageBps)).div(BPS);
}

function floorStep(value: Decimal, step: Decimal) {
  if (step.lte(0)) return value;
  return value.div(step).floor().mul(step);
}

function parseIrtSymbol(value: string) {
  const symbol = value.trim().toUpperCase();
  return symbol.endsWith("IRT") && /^[A-Z0-9]{2,16}IRT$/.test(symbol) ? symbol.slice(0, -3) : undefined;
}

function clientOrderId(plan: StatisticalPairsExecutionPlan, suffix: string) {
  const seed = `${plan.assetA}${plan.assetB}${plan.createdAt.toString(36)}`.replace(/[^a-z0-9]/gi, "");
  return `pr-${seed}-${suffix}`.slice(0, 32);
}

function isTerminal(status: string) {
  const value = status.toLowerCase();
  return ["done", "canceled", "cancelled", "rejected", "failed"].includes(value);
}

function isDone(status: string) { return status.toLowerCase() === "done"; }
function isOpen(status: string) { return status.toLowerCase() === "open"; }
function isClosed(status: string) { return ["closed", "liquidated", "expired"].includes(status.toLowerCase()); }

function isDefinitiveRejection(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("rejected:") || message.includes("order rejected") || message.includes("insufficient") || message.includes("smallorder");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeSubmissionError(error: unknown, message: string) {
  if (isDefinitiveRejection(error)) return new StatisticalPairsExecutionError(error instanceof Error ? error.message : "Margin order rejected", "ORDER_FAILED");
  return new StatisticalPairsExecutionError(message, "ORDER_STATE_UNKNOWN", true, { cause: error });
}

function validationError(message: string) { return new StatisticalPairsExecutionError(message, "REVALIDATION_FAILED"); }
function recoveryError(message: string, manual = false) { return new StatisticalPairsExecutionError(message, "RECOVERY_FAILED", manual); }

function decimal(value: unknown, name: string) {
  try {
    const result = new Decimal(String(value));
    if (!result.isFinite()) throw new Error();
    return result;
  } catch {
    throw new StatisticalPairsExecutionError(`${name} must be a finite decimal`, "INVALID_PLAN");
  }
}

function positiveDecimal(value: unknown, name: string) {
  const result = decimal(value, name);
  if (result.lte(0)) throw new StatisticalPairsExecutionError(`${name} must be positive`, "INVALID_PLAN");
  return result;
}

function boundedDecimal(value: unknown, min: number, max: number, name: string) {
  const result = decimal(value, name);
  if (result.lt(min) || result.gt(max)) throw new StatisticalPairsExecutionError(`${name} is outside the safe range`, "INVALID_PLAN");
  return result;
}

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new StatisticalPairsExecutionError(`${name} must be a positive integer`, "INVALID_PLAN");
  return value;
}

function boundedInteger(value: number, min: number, max: number, name: string) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new StatisticalPairsExecutionError(`${name} must be an integer between ${min} and ${max}`, "INVALID_PLAN");
  }
  return value;
}

async function safeHook(callback: () => Promise<void> | void | undefined) {
  try { await callback(); } catch { /* Audit hooks cannot interrupt an exposed position. */ }
}
