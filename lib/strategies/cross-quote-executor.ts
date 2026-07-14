import Decimal from "decimal.js";
import { config as appConfig } from "@/lib/config";
import { findTriangularOpportunities, quoteEdge } from "@/lib/bot/engine";
import {
  executeLive,
  LiveExecutionRecoveredError,
  LiveManualInterventionError,
  type ExecutionLeg,
  type LiveExecutionHooks
} from "@/lib/bot/executor";
import { defaultBotSettings, type BotSettings } from "@/lib/bot-settings";
import type { LegQuote } from "@/lib/bot/types";
import type { MarketOptions, NobitexOrder, OrderBook, Side } from "@/lib/exchanges/types";
import type { StrategySignal } from "./types";

const BPS = new Decimal(10_000);

export type CrossQuoteDirection = "IRT_TO_USDT" | "USDT_TO_IRT";
export type CrossQuoteOrderStage = "leg1" | "leg2" | "leg3" | "recovery";

export type CrossQuoteOrderRequest = {
  side: Side;
  base: string;
  quote: string;
  amountBase: Decimal;
  expectedPrice: Decimal;
  clientOrderId: string;
};

export type CrossQuoteExecutionClient = {
  /** Optional on purpose: the production client uses NOBITEX_API_BASE. Mocks can declare their environment explicitly. */
  baseUrl?: string;
  getAllOrderBooks(): Promise<OrderBook[]>;
  getMarketOptions(): Promise<MarketOptions>;
  placeMarketOrder(input: CrossQuoteOrderRequest): Promise<NobitexOrder>;
  getOrderStatus(id: string): Promise<NobitexOrder>;
  getOrderStatusByClientOrderId?(clientOrderId: string): Promise<NobitexOrder>;
  cancelOrder(id: string): Promise<void>;
};

export type CrossQuotePlanConfig = {
  capitalToman?: Decimal.Value;
  tomanTakerFeeBps: Decimal.Value;
  usdtTakerFeeBps: Decimal.Value;
  slippageBps: Decimal.Value;
  minEdgeBps?: Decimal.Value;
  liveSafetyBufferBps?: Decimal.Value;
  maxSpreadBps?: Decimal.Value;
  maxPriceImpactBps?: Decimal.Value;
  depthUsagePercent?: Decimal.Value;
  maxAgeMs?: number;
  orderTimeoutMs?: number;
  /** Keeps the submitted BUY notional below the capital ceiling when the book moves between quote and matching. */
  orderReserveBps?: Decimal.Value;
  recoveryMaxSpreadBps?: Decimal.Value;
  recoveryMaxPriceImpactBps?: Decimal.Value;
  recoverySlippageBps?: Decimal.Value;
};

export type CrossQuoteExecutionPlan = {
  id: string;
  signalId: string;
  signalScannedAt: number;
  asset: string;
  direction: CrossQuoteDirection;
  route: readonly [string, string];
  capitalToman: Decimal;
  signalEdgeBps: Decimal;
  config: {
    tomanTakerFeeBps: Decimal;
    usdtTakerFeeBps: Decimal;
    slippageBps: Decimal;
    minEdgeBps: Decimal;
    liveSafetyBufferBps: Decimal;
    maxSpreadBps: Decimal;
    maxPriceImpactBps: Decimal;
    depthUsagePercent: Decimal;
    maxAgeMs: number;
    orderTimeoutMs: number;
    orderReserveBps: Decimal;
    recoveryMaxSpreadBps: Decimal;
    recoveryMaxPriceImpactBps: Decimal;
    recoverySlippageBps: Decimal;
  };
  createdAt: number;
};

export type CrossQuoteRevalidation = {
  checkedAt: number;
  edgeBps: Decimal;
  requiredEdgeBps: Decimal;
  referenceOutput: Decimal;
  referenceAsset: "IRT" | "USDT";
  legs: readonly LegQuote[];
};

export type CrossQuoteExecutionLeg = {
  stage: CrossQuoteOrderStage;
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

export type CrossQuoteExecutionHooks = {
  /** Runs before an order is submitted. Throwing here safely prevents that order. */
  onBeforeOrder?: (event: { stage: CrossQuoteOrderStage; plan: CrossQuoteExecutionPlan; quote: LegQuote; request: CrossQuoteOrderRequest }) => Promise<void> | void;
  /** Runs immediately after Nobitex returns an order id. Logging failures do not interrupt an exposed position. */
  onOrderSubmitted?: (event: { stage: CrossQuoteOrderStage; plan: CrossQuoteExecutionPlan; order: NobitexOrder; request: CrossQuoteOrderRequest }) => Promise<void> | void;
  onOrderFinalized?: (event: { stage: CrossQuoteOrderStage; plan: CrossQuoteExecutionPlan; leg: CrossQuoteExecutionLeg }) => Promise<void> | void;
  onRevalidated?: (event: { phase: "entry-1" | "entry-2" | "before-leg2"; plan: CrossQuoteExecutionPlan; edgeBps: Decimal }) => Promise<void> | void;
  onRecoveryStarted?: (event: { plan: CrossQuoteExecutionPlan; assetAmount: Decimal; reason: string }) => Promise<void> | void;
};

export type CrossQuoteExecutionOptions = {
  /** A strict URL check is preferred. This explicit flag exists for injected Mainnet clients and unit-test mocks. */
  explicitMainnetMode?: true;
  baseUrl?: string;
  revalidationDelayMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type CrossQuoteExecutionResult = {
  status: "completed" | "recovered";
  plan: CrossQuoteExecutionPlan;
  entry: CrossQuoteRevalidation;
  legs: CrossQuoteExecutionLeg[];
  finalAsset: "IRT" | "USDT";
  finalOutput: Decimal;
  /** Confirmed IRT actually consumed by the first order. */
  actualInputToman?: Decimal;
  /** Sub-step dust left after flooring a SELL to the exchange amount precision. */
  residualAssetAmount: Decimal;
  /** True only when the executor has proved there is no non-IRT inventory left. */
  fullySettled?: boolean;
  actualEdgeBps?: Decimal;
  recoveryReason?: string;
};

export class CrossQuoteExecutionError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "MAINNET_REQUIRED"
      | "INVALID_PLAN"
      | "REVALIDATION_FAILED"
      | "ORDER_FAILED"
      | "RECOVERY_FAILED"
      | "ORDER_STATE_UNKNOWN",
    public readonly manualInterventionRequired = false,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "CrossQuoteExecutionError";
  }
}

/** Converts an actionable Strategy Lab signal into an immutable execution plan. */
export function createCrossQuoteExecutionPlan(
  signal: StrategySignal,
  input: CrossQuotePlanConfig,
  now = Date.now()
): CrossQuoteExecutionPlan {
  if (signal.kind !== "cross-quote" || signal.status !== "actionable") {
    throw new CrossQuoteExecutionError("Only an actionable cross-quote signal can become an execution plan", "INVALID_PLAN");
  }

  const direction = signal.id.endsWith(":to-usdt")
    ? "IRT_TO_USDT"
    : signal.id.endsWith(":to-irt")
      ? "USDT_TO_IRT"
      : undefined;
  if (!direction || signal.symbols.length !== 2) {
    throw new CrossQuoteExecutionError("Cross-quote signal has an unknown direction or route", "INVALID_PLAN");
  }

  const route = [signal.symbols[0]!.toUpperCase(), signal.symbols[1]!.toUpperCase()] as const;
  const first = splitSymbol(route[0]);
  const second = splitSymbol(route[1]);
  const structurallyValid = first && second && first.base === second.base && first.base !== "USDT"
    && (direction === "IRT_TO_USDT"
      ? first.quote === "IRT" && second.quote === "USDT"
      : first.quote === "USDT" && second.quote === "IRT");
  if (!structurallyValid || !first) {
    throw new CrossQuoteExecutionError(`Invalid cross-quote route: ${route.join(" -> ")}`, "INVALID_PLAN");
  }

  const metricCapital = signal.metrics.capitalToman;
  const capitalToman = decimal(input.capitalToman ?? (typeof metricCapital === "number" || typeof metricCapital === "string" ? metricCapital : 0), "capitalToman");
  if (capitalToman.lte(0)) throw new CrossQuoteExecutionError("Cross-quote capital must be positive", "INVALID_PLAN");

  const planConfig = {
    tomanTakerFeeBps: boundedDecimal(input.tomanTakerFeeBps, 0, 10_000, "tomanTakerFeeBps"),
    usdtTakerFeeBps: boundedDecimal(input.usdtTakerFeeBps, 0, 10_000, "usdtTakerFeeBps"),
    slippageBps: boundedDecimal(input.slippageBps, 0, 10_000, "slippageBps"),
    minEdgeBps: boundedDecimal(input.minEdgeBps ?? 80, 0, 10_000, "minEdgeBps"),
    liveSafetyBufferBps: boundedDecimal(input.liveSafetyBufferBps ?? 150, 0, 10_000, "liveSafetyBufferBps"),
    maxSpreadBps: boundedDecimal(input.maxSpreadBps ?? 120, 0, 10_000, "maxSpreadBps"),
    maxPriceImpactBps: boundedDecimal(input.maxPriceImpactBps ?? 50, 0, 10_000, "maxPriceImpactBps"),
    depthUsagePercent: boundedDecimal(input.depthUsagePercent ?? 75, 0.000001, 100, "depthUsagePercent"),
    maxAgeMs: positiveInteger(input.maxAgeMs ?? 5_000, "maxAgeMs"),
    orderTimeoutMs: positiveInteger(input.orderTimeoutMs ?? 5_000, "orderTimeoutMs"),
    orderReserveBps: boundedDecimal(input.orderReserveBps ?? 10, 0, 2_000, "orderReserveBps"),
    recoveryMaxSpreadBps: boundedDecimal(input.recoveryMaxSpreadBps ?? 1_000, 0, 10_000, "recoveryMaxSpreadBps"),
    recoveryMaxPriceImpactBps: boundedDecimal(input.recoveryMaxPriceImpactBps ?? 1_000, 0, 10_000, "recoveryMaxPriceImpactBps"),
    recoverySlippageBps: boundedDecimal(input.recoverySlippageBps ?? 100, 0, 2_000, "recoverySlippageBps")
  };

  return {
    id: `cross-live:${signal.id}:${signal.scannedAt}`,
    signalId: signal.id,
    signalScannedAt: signal.scannedAt,
    asset: first.base,
    direction,
    route,
    capitalToman,
    signalEdgeBps: signal.expectedEdgeBps,
    config: planConfig,
    createdAt: now
  };
}

/** Pure orderbook revalidation, exported so the server can show the exact reason before arming a run. */
export function revalidateCrossQuotePlan(plan: CrossQuoteExecutionPlan, books: OrderBook[], now = Date.now()): CrossQuoteRevalidation {
  const bySymbol = new Map(books.map(book => [book.symbol.toUpperCase(), book]));
  const firstBook = bySymbol.get(plan.route[0]);
  const secondBook = bySymbol.get(plan.route[1]);
  const usdtIrt = bySymbol.get("USDTIRT");
  if (!firstBook || !secondBook || !usdtIrt) {
    throw new CrossQuoteExecutionError("A required market disappeared during Cross-Quote revalidation", "REVALIDATION_FAILED");
  }
  for (const book of [firstBook, secondBook, usdtIrt]) assertFresh(book, now, plan.config.maxAgeMs);

  // The reserve is applied before simulation, so submitted BUY orders cannot silently exceed the configured ceiling.
  const executionCapital = plan.capitalToman.mul(BPS.minus(plan.config.orderReserveBps)).div(BPS);
  const benchmarkBuy = makeQuote("BUY", usdtIrt, executionCapital, plan);
  if (!benchmarkBuy) throw revalidationError("Direct USDT benchmark has insufficient orderbook depth");

  let firstQuote: LegQuote | undefined;
  let secondQuote: LegQuote | undefined;
  let referenceOutput: Decimal;
  let referenceAsset: "IRT" | "USDT";
  if (plan.direction === "IRT_TO_USDT") {
    firstQuote = makeQuote("BUY", firstBook, executionCapital, plan);
    secondQuote = firstQuote && makeQuote("SELL", secondBook, firstQuote.output, plan);
    referenceOutput = benchmarkBuy.output;
    referenceAsset = "USDT";
  } else {
    firstQuote = makeQuote("BUY", firstBook, benchmarkBuy.output, plan);
    secondQuote = firstQuote && makeQuote("SELL", secondBook, firstQuote.output, plan);
    referenceOutput = executionCapital;
    referenceAsset = "IRT";
  }
  if (!firstQuote || !secondQuote) throw revalidationError("Cross-Quote route has insufficient orderbook depth");
  assertQuoteRisk(firstQuote, plan.config.maxSpreadBps, plan.config.maxPriceImpactBps, "first leg");
  assertQuoteRisk(secondQuote, plan.config.maxSpreadBps, plan.config.maxPriceImpactBps, "second leg");
  assertQuoteRisk(benchmarkBuy, plan.config.maxSpreadBps, plan.config.maxPriceImpactBps, "USDT benchmark");

  const edgeBps = secondQuote.output.div(referenceOutput).minus(1).mul(BPS);
  const requiredEdgeBps = plan.config.minEdgeBps.plus(plan.config.liveSafetyBufferBps);
  if (edgeBps.lt(requiredEdgeBps)) {
    throw revalidationError(`Fresh edge ${edgeBps.toFixed(2)} BPS is below the Mainnet live threshold ${requiredEdgeBps.toFixed(2)} BPS`);
  }
  return { checkedAt: now, edgeBps, requiredEdgeBps, referenceOutput, referenceAsset, legs: [firstQuote, secondQuote] };
}

/**
 * Executes exactly two normal Spot market orders on Mainnet. If exposure remains after leg 1,
 * a separate emergency SELL in ASSET/IRT is attempted and explicitly reported as recovery.
 */
export async function executeCrossQuote(
  plan: CrossQuoteExecutionPlan,
  client: CrossQuoteExecutionClient,
  hooks: CrossQuoteExecutionHooks = {},
  options: CrossQuoteExecutionOptions = {}
): Promise<CrossQuoteExecutionResult> {
  assertMainnet(client, options);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const delay = Math.max(0, options.revalidationDelayMs ?? 250);
  const marketOptionsPromise = client.getMarketOptions();

  const firstSnapshot = await client.getAllOrderBooks();
  const firstValidation = revalidateCrossQuotePlan(plan, firstSnapshot, now());
  await safeHook(() => hooks.onRevalidated?.({ phase: "entry-1", plan, edgeBps: firstValidation.edgeBps }));
  if (delay) await sleep(delay);

  const secondSnapshot = await client.getAllOrderBooks();
  const entry = revalidateCrossQuotePlan(plan, secondSnapshot, now());
  await safeHook(() => hooks.onRevalidated?.({ phase: "entry-2", plan, edgeBps: entry.edgeBps }));
  const marketOptions = await marketOptionsPromise;
  assertMinimumOrder(entry.legs[0], marketOptions);
  assertMinimumOrder(entry.legs[1], marketOptions);

  const legs: CrossQuoteExecutionLeg[] = [];
  let first: CrossQuoteExecutionLeg;
  try {
    first = await submitAndWait("leg1", entry.legs[0], plan, marketOptions, client, hooks);
    legs.push(first);
  } catch (error) {
    throw normalizeOrderError(error, "The first Cross-Quote order failed before a confirmed fill");
  }

  if (!first.fullFill) {
    if (first.actualOutput.gt(0)) {
      return recoverExposure(plan, entry, first.actualOutput, "The first order was only partially filled", legs, marketOptions, client, hooks, now());
    }
    throw new CrossQuoteExecutionError("The first Cross-Quote order was not filled", "ORDER_FAILED", false);
  }

  const intermediate = first.actualOutput;
  let liveSecond: LegQuote;
  try {
    const freshBooks = await client.getAllOrderBooks();
    liveSecond = revalidateSecondLeg(plan, entry, first, intermediate, freshBooks, now());
    assertMinimumOrder(liveSecond, marketOptions);
    const freshEdge = liveSecond.output.div(scaledReference(entry, first)).minus(1).mul(BPS);
    await safeHook(() => hooks.onRevalidated?.({ phase: "before-leg2", plan, edgeBps: freshEdge }));
  } catch (error) {
    return recoverExposure(plan, entry, intermediate, errorMessage(error), legs, marketOptions, client, hooks, now());
  }

  let second: CrossQuoteExecutionLeg;
  try {
    second = await submitAndWait("leg2", liveSecond, plan, marketOptions, client, hooks);
    legs.push(second);
  } catch (error) {
    if (error instanceof OrderStateUnknownError) {
      throw new CrossQuoteExecutionError(
        "The second order state is unknown; automatic recovery was blocked to prevent a double-sell. Inspect the order on Mainnet.",
        "ORDER_STATE_UNKNOWN",
        true,
        { cause: error }
      );
    }
    return recoverExposure(plan, entry, intermediate, errorMessage(error), legs, marketOptions, client, hooks, now());
  }

  if (!second.fullFill) {
    const remaining = Decimal.max(intermediate.minus(second.matchedAmountBase), 0);
    if (remaining.gt(0)) {
      return recoverExposure(plan, entry, remaining, "The second order was only partially filled", legs, marketOptions, client, hooks, now());
    }
    throw new CrossQuoteExecutionError("The second order ended incomplete and left no measurable recoverable balance", "ORDER_FAILED", true);
  }

  const reference = scaledReference(entry, first);
  const actualEdgeBps = second.actualOutput.div(reference).minus(1).mul(BPS);
  const residualAssetAmount = Decimal.max(intermediate.minus(second.matchedAmountBase), 0);
  return {
    status: "completed",
    plan,
    entry,
    legs,
    finalAsset: plan.direction === "IRT_TO_USDT" ? "USDT" : "IRT",
    finalOutput: second.actualOutput,
    residualAssetAmount,
    fullySettled: residualAssetAmount.eq(0) && plan.direction === "USDT_TO_IRT",
    actualEdgeBps
  };
}

/**
 * Production Cross-Quote execution is a closed IRT cycle. The analytical
 * two-quote comparison nominates a direction, while the battle-tested Triangle
 * inventory ledger adds the USDT/IRT settlement leg, protected revalidation,
 * clientOrderId reconciliation and multi-asset recovery.
 */
export async function executeClosedCrossQuote(
  plan: CrossQuoteExecutionPlan,
  client: CrossQuoteExecutionClient,
  hooks: CrossQuoteExecutionHooks = {},
  options: CrossQuoteExecutionOptions = {}
): Promise<CrossQuoteExecutionResult> {
  assertMainnet(client, options);
  const [books, marketOptions] = await Promise.all([client.getAllOrderBooks(), client.getMarketOptions()]);
  const desiredRoute = plan.direction === "IRT_TO_USDT"
    ? ["IRT", plan.asset, "USDT", "IRT"]
    : ["IRT", "USDT", plan.asset, "IRT"];
  const settings = closedCycleSettings(plan);
  const opportunity = findTriangularOpportunities({
    books,
    options: marketOptions,
    capitalToman: plan.capitalToman,
    tomanFeeBps: plan.config.tomanTakerFeeBps,
    usdtFeeBps: plan.config.usdtTakerFeeBps,
    slippageBps: plan.config.slippageBps,
    maxPriceImpactBps: plan.config.maxPriceImpactBps,
    maxSpreadBps: plan.config.maxSpreadBps,
    depthUsagePercent: plan.config.depthUsagePercent,
    minProfitBps: plan.config.minEdgeBps,
    minNetProfitToman: 0,
    liveSafetyBufferBps: plan.config.liveSafetyBufferBps,
    maxAgeMs: plan.config.maxAgeMs
  })
    .filter(candidate => candidate.executable && sameRoute(candidate.route, desiredRoute))
    .sort((left, right) => right.netProfitToman.comparedTo(left.netProfitToman))[0];
  if (!opportunity) throw revalidationError("The closed IRT Cross-Quote cycle is no longer executable");

  const entry: CrossQuoteRevalidation = {
    checkedAt: Date.now(),
    edgeBps: opportunity.profitBps,
    requiredEdgeBps: plan.config.minEdgeBps.plus(plan.config.liveSafetyBufferBps),
    referenceOutput: opportunity.inputToman,
    referenceAsset: "IRT",
    legs: opportunity.legs
  };
  const persisted = new Map<string, CrossQuoteExecutionLeg>();
  let prepared = opportunity;
  const liveHooks: LiveExecutionHooks = {
    onPrepared: async fresh => {
      prepared = fresh;
      await hooks.onRevalidated?.({ phase: "entry-2", plan, edgeBps: fresh.profitBps });
    },
    onBeforeOrder: async (index, context) => {
      const quote = prepared.legs[index];
      if (!quote) throw new Error(`Missing prepared Cross-Quote leg ${index + 1}`);
      await hooks.onBeforeOrder?.({
        stage: cycleStage(index),
        plan,
        quote,
        request: {
          side: context.side,
          base: quote.edge.book.base,
          quote: quote.edge.book.quote,
          amountBase: context.amountBase,
          expectedPrice: context.protectedPrice,
          clientOrderId: context.clientOrderId
        }
      });
    },
    onBeforeRecoveryOrder: async event => {
      const freshBooks = await client.getAllOrderBooks();
      const book = freshBooks.find(item => item.symbol.toUpperCase() === event.symbol.toUpperCase());
      if (!book) throw new Error(`Recovery market ${event.symbol} disappeared`);
      const recoveryQuote = quoteEdge(edge("SELL", book), event.requestedInput, plan.config.tomanTakerFeeBps, plan.config.recoverySlippageBps, 100);
      if (!recoveryQuote) throw new Error(`Recovery market ${event.symbol} has insufficient depth`);
      await hooks.onBeforeOrder?.({
        stage: "recovery",
        plan,
        quote: recoveryQuote,
        request: {
          side: "SELL",
          base: book.base,
          quote: book.quote,
          amountBase: event.amountBase,
          expectedPrice: event.protectedPrice,
          clientOrderId: event.clientOrderId
        }
      });
    },
    onLeg: async leg => {
      if (!leg.matchedAmount || !leg.unmatchedAmount) return;
      if (!isTerminal(leg.status)) return;
      const index = leg.stage === "recovery"
        ? -1
        : prepared.legs.findIndex(item => item.edge.book.symbol === leg.symbol);
      const mapped = mapLiveLeg(leg, index >= 0 ? cycleStage(index) : "recovery");
      persisted.set(mapped.clientOrderId || mapped.orderId, mapped);
      await hooks.onOrderFinalized?.({ stage: mapped.stage, plan, leg: mapped });
    },
    onRecoveryStarted: async event => {
      for (const position of event.inventory) {
        await hooks.onRecoveryStarted?.({ plan, assetAmount: position.amount, reason: event.reason });
      }
    }
  };

  try {
    const result = await executeLive(opportunity, settings, client, liveHooks, { books, options: marketOptions });
    return {
      status: "completed",
      plan,
      entry,
      legs: [...persisted.values()],
      finalAsset: "IRT",
      finalOutput: result.outputToman,
      actualInputToman: result.inputToman,
      residualAssetAmount: result.residualInventory[0]?.amount ?? new Decimal(0),
      fullySettled: result.fullySettled,
      actualEdgeBps: result.inputToman.gt(0) ? result.profitToman.div(result.inputToman).mul(BPS) : new Decimal(0)
    };
  } catch (error) {
    if (error instanceof LiveExecutionRecoveredError) {
      const input = error.recovery.actualInputToman;
      return {
        status: "recovered",
        plan,
        entry,
        legs: [...persisted.values()],
        finalAsset: "IRT",
        finalOutput: error.recovery.economicRecoveredToman,
        actualInputToman: input,
        residualAssetAmount: error.recovery.residualInventory[0]?.amount ?? new Decimal(0),
        fullySettled: error.recovery.residualInventory.length === 0,
        actualEdgeBps: input.gt(0)
          ? error.recovery.economicRecoveredToman.minus(input).div(input).mul(BPS)
          : new Decimal(0),
        recoveryReason: error.message
      };
    }
    if (error instanceof LiveManualInterventionError) {
      throw new CrossQuoteExecutionError(error.message, "ORDER_STATE_UNKNOWN", true, { cause: error });
    }
    throw error;
  }
}

function revalidateSecondLeg(
  plan: CrossQuoteExecutionPlan,
  entry: CrossQuoteRevalidation,
  first: CrossQuoteExecutionLeg,
  intermediate: Decimal,
  books: OrderBook[],
  now: number
) {
  const book = books.find(item => item.symbol.toUpperCase() === plan.route[1]);
  if (!book) throw revalidationError("Second market disappeared after the first fill");
  assertFresh(book, now, plan.config.maxAgeMs);
  const quote = makeQuote("SELL", book, intermediate, plan);
  if (!quote) throw revalidationError("Second market no longer has enough depth for the actual first-leg fill");
  assertQuoteRisk(quote, plan.config.maxSpreadBps, plan.config.maxPriceImpactBps, "second leg after first fill");
  const edge = quote.output.div(scaledReference(entry, first)).minus(1).mul(BPS);
  if (edge.lt(entry.requiredEdgeBps)) {
    throw revalidationError(`Post-fill edge ${edge.toFixed(2)} BPS fell below ${entry.requiredEdgeBps.toFixed(2)} BPS`);
  }
  return quote;
}

async function recoverExposure(
  plan: CrossQuoteExecutionPlan,
  entry: CrossQuoteRevalidation,
  assetAmount: Decimal,
  reason: string,
  legs: CrossQuoteExecutionLeg[],
  options: MarketOptions,
  client: CrossQuoteExecutionClient,
  hooks: CrossQuoteExecutionHooks,
  now: number
): Promise<CrossQuoteExecutionResult> {
  await safeHook(() => hooks.onRecoveryStarted?.({ plan, assetAmount, reason }));
  try {
    const books = await client.getAllOrderBooks();
    const book = books.find(item => item.symbol.toUpperCase() === `${plan.asset}IRT`);
    if (!book) throw new Error(`Recovery market ${plan.asset}IRT is unavailable`);
    assertFresh(book, now, plan.config.maxAgeMs);
    const quote = quoteEdge(edge("SELL", book), assetAmount, plan.config.tomanTakerFeeBps, plan.config.recoverySlippageBps, 100);
    if (!quote) throw new Error("Recovery market has insufficient visible depth");
    assertQuoteRisk(quote, plan.config.recoveryMaxSpreadBps, plan.config.recoveryMaxPriceImpactBps, "recovery");
    assertMinimumOrder(quote, options);
    const recovery = await submitAndWait("recovery", quote, plan, options, client, hooks);
    legs.push(recovery);
    if (!recovery.fullFill) throw new Error("Emergency recovery order was not completely filled");
    return {
      status: "recovered",
      plan,
      entry,
      legs,
      finalAsset: "IRT",
      finalOutput: recovery.actualOutput,
      residualAssetAmount: Decimal.max(assetAmount.minus(recovery.matchedAmountBase), 0),
      fullySettled: Decimal.max(assetAmount.minus(recovery.matchedAmountBase), 0).eq(0),
      recoveryReason: reason
    };
  } catch (error) {
    if (error instanceof OrderStateUnknownError) {
      throw new CrossQuoteExecutionError("Recovery order state is unknown; manual Mainnet intervention is required", "ORDER_STATE_UNKNOWN", true, { cause: error });
    }
    throw new CrossQuoteExecutionError(`Automatic recovery failed: ${errorMessage(error)}`, "RECOVERY_FAILED", true, { cause: error });
  }
}

async function submitAndWait(
  stage: CrossQuoteOrderStage,
  quote: LegQuote,
  plan: CrossQuoteExecutionPlan,
  options: MarketOptions,
  client: CrossQuoteExecutionClient,
  hooks: CrossQuoteExecutionHooks
): Promise<CrossQuoteExecutionLeg> {
  const amountStep = options.amountSteps[quote.edge.book.symbol] ?? new Decimal("0.00000001");
  const priceStep = options.priceSteps[quote.edge.book.symbol] ?? new Decimal("0.00000001");
  const amountBase = floorStep(quote.edge.side === "BUY" ? quote.grossOutput : quote.input, amountStep);
  if (amountBase.lte(0)) throw new Error(`Rounded amount is zero on ${quote.edge.book.symbol}`);
  const slippage = stage === "recovery" ? plan.config.recoverySlippageBps : plan.config.slippageBps;
  const expectedPrice = priceToStep(quote.edge.side, protectedExpectedPrice(quote.edge.side, quote.averagePrice, slippage), priceStep);
  const request: CrossQuoteOrderRequest = {
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
    // A structured exchange rejection means no order exists. Transport/timeout failures are ambiguous:
    // Nobitex may have accepted the clientOrderId even though this process did not receive its id.
    if (isDefinitiveRejection(error)) throw error;
    throw new OrderStateUnknownError(`clientOrderId for ${stage}`, { cause: error });
  }
  await safeHook(() => hooks.onOrderSubmitted?.({ stage, plan, order, request }));
  const final = await waitForFinalOrder(client, order, plan.config.orderTimeoutMs);
  const fullFill = final.matchedAmount.gt(0) && final.unmatchedAmount.lte(0) && final.matchedAmount.gte(amountBase);
  const outputAsset = quote.edge.side === "BUY" ? quote.edge.book.base : quote.edge.book.quote;
  const inputAsset = quote.edge.side === "BUY" ? quote.edge.book.quote : quote.edge.book.base;
  const feeAsset = outputAsset;
  const actualOutput = realizedOutput(quote.edge.side, quote.edge.book.quote, final);
  const actualInput = quote.edge.side === "BUY"
    ? final.totalPrice.div(quote.edge.book.quote === "IRT" ? 10 : 1)
    : final.matchedAmount;
  const leg: CrossQuoteExecutionLeg = {
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
    fee: final.fee.div(feeAsset === "IRT" ? 10 : 1),
    feeAsset,
    averagePrice: final.averagePrice.div(quote.edge.book.quote === "IRT" ? 10 : 1),
    fullFill
  };
  await safeHook(() => hooks.onOrderFinalized?.({ stage, plan, leg }));
  return leg;
}

async function waitForFinalOrder(client: CrossQuoteExecutionClient, initial: NobitexOrder, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let order = initial;
  while (Date.now() < deadline) {
    if (isTerminal(order.status)) return order;
    await new Promise(resolve => setTimeout(resolve, 100));
    try {
      order = await client.getOrderStatus(order.id);
    } catch (error) {
      throw new OrderStateUnknownError(initial.id, { cause: error });
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

class OrderStateUnknownError extends Error {
  constructor(orderId: string, options?: ErrorOptions) {
    super(`Order ${orderId} timed out and its final state could not be confirmed`, options);
    this.name = "OrderStateUnknownError";
  }
}

function makeQuote(side: Side, book: OrderBook, input: Decimal.Value, plan: CrossQuoteExecutionPlan) {
  const fee = book.quote === "IRT" ? plan.config.tomanTakerFeeBps : plan.config.usdtTakerFeeBps;
  return quoteEdge(edge(side, book), input, fee, plan.config.slippageBps, plan.config.depthUsagePercent);
}

function edge(side: Side, book: OrderBook) {
  return {
    id: `${book.symbol}:${side}`,
    from: side === "BUY" ? book.quote : book.base,
    to: side === "BUY" ? book.base : book.quote,
    side,
    book
  };
}

function scaledReference(entry: CrossQuoteRevalidation, first: CrossQuoteExecutionLeg) {
  return entry.referenceOutput.mul(first.actualInput).div(entry.legs[0].input);
}

function assertMinimumOrder(quote: LegQuote, options: MarketOptions) {
  const quoteValue = quote.edge.side === "BUY" ? quote.input : quote.grossOutput;
  const minimum = quote.edge.book.quote === "IRT" ? options.minOrderRial.div(10) : options.minOrderUsdt;
  if (quoteValue.lt(minimum)) {
    throw revalidationError(`${quote.edge.book.symbol} value ${quoteValue.toFixed()} is below its minimum order ${minimum.toFixed()}`);
  }
}

function assertQuoteRisk(quote: LegQuote, maxSpread: Decimal, maxImpact: Decimal, phase: string) {
  if (quote.spreadBps.gt(maxSpread)) throw revalidationError(`${phase} spread ${quote.spreadBps.toFixed(2)} BPS exceeds ${maxSpread.toFixed(2)} BPS`);
  if (quote.priceImpactBps.gt(maxImpact)) throw revalidationError(`${phase} price impact ${quote.priceImpactBps.toFixed(2)} BPS exceeds ${maxImpact.toFixed(2)} BPS`);
}

function assertFresh(book: OrderBook, now: number, maxAgeMs: number) {
  if (!book.lastUpdate || now - book.lastUpdate > maxAgeMs || book.lastUpdate > now + 5_000) {
    throw revalidationError(`${book.symbol} orderbook is stale or has an invalid timestamp`);
  }
}

function assertMainnet(client: CrossQuoteExecutionClient, options: CrossQuoteExecutionOptions) {
  const raw = options.baseUrl ?? client.baseUrl ?? appConfig.NOBITEX_API_BASE;
  let officialMainnet = false;
  try {
    officialMainnet = new URL(raw).hostname.toLowerCase() === "apiv2.nobitex.ir";
  } catch {
    officialMainnet = false;
  }
  if (!officialMainnet && options.explicitMainnetMode !== true) {
    throw new CrossQuoteExecutionError(
      "Cross-Quote execution requires official Nobitex Mainnet https://apiv2.nobitex.ir.",
      "MAINNET_REQUIRED"
    );
  }
}

function splitSymbol(symbol: string) {
  for (const quote of ["USDT", "IRT"] as const) {
    if (symbol.endsWith(quote) && symbol.length > quote.length) return { base: symbol.slice(0, -quote.length), quote };
  }
  return undefined;
}

function realizedOutput(side: Side, quote: string, order: NobitexOrder) {
  return side === "BUY"
    ? Decimal.max(order.matchedAmount.minus(order.fee), 0)
    : Decimal.max(order.totalPrice.minus(order.fee).div(quote === "IRT" ? 10 : 1), 0);
}

function protectedExpectedPrice(side: Side, averagePrice: Decimal, slippageBps: Decimal) {
  const tolerance = Decimal.min(slippageBps.div(BPS), "0.009");
  return side === "BUY"
    ? averagePrice.mul(new Decimal(1).plus(tolerance)).div("1.01")
    : averagePrice.mul(new Decimal(1).minus(tolerance)).div("0.99");
}

function floorStep(value: Decimal, step: Decimal) { return value.div(step).floor().mul(step); }
function priceToStep(side: Side, value: Decimal, step: Decimal) {
  const units = value.div(step);
  return (side === "BUY" ? units.floor() : units.ceil()).mul(step);
}
function closedCycleSettings(plan: CrossQuoteExecutionPlan): BotSettings {
  return {
    ...defaultBotSettings,
    paperCapitalToman: plan.capitalToman.toNumber(),
    maxTradeToman: plan.capitalToman.toNumber(),
    balanceUsagePercent: 100,
    tomanTakerFeeBps: plan.config.tomanTakerFeeBps.toNumber(),
    usdtTakerFeeBps: plan.config.usdtTakerFeeBps.toNumber(),
    slippageBufferBps: plan.config.slippageBps.toNumber(),
    liveSafetyBufferBps: plan.config.liveSafetyBufferBps.toNumber(),
    maxPriceImpactBps: plan.config.maxPriceImpactBps.toNumber(),
    maxSpreadBps: plan.config.maxSpreadBps.toNumber(),
    orderbookDepthUsagePercent: plan.config.depthUsagePercent.toNumber(),
    minProfitBps: plan.config.minEdgeBps.toNumber(),
    minNetProfitToman: 0,
    orderbookMaxAgeMs: plan.config.maxAgeMs,
    orderTimeoutMs: plan.config.orderTimeoutMs
  };
}
function sameRoute(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((asset, index) => asset === right[index]);
}
function cycleStage(index: number): Exclude<CrossQuoteOrderStage, "recovery"> {
  if (index === 0) return "leg1";
  if (index === 1) return "leg2";
  return "leg3";
}
function mapLiveLeg(leg: ExecutionLeg, stage: CrossQuoteOrderStage): CrossQuoteExecutionLeg {
  const inputAsset = leg.inputAsset ?? "";
  const outputAsset = leg.outputAsset ?? "";
  const matched = new Decimal(leg.matchedAmount ?? 0);
  const unmatched = new Decimal(leg.unmatchedAmount ?? 0);
  return {
    stage,
    symbol: leg.symbol,
    side: leg.side as Side,
    orderId: leg.orderId,
    clientOrderId: leg.clientOrderId ?? leg.orderId,
    status: leg.status,
    submittedAmountBase: matched.plus(unmatched),
    matchedAmountBase: matched,
    unmatchedAmountBase: unmatched,
    actualInput: new Decimal(leg.input || 0),
    inputAsset,
    actualOutput: new Decimal(leg.output || 0),
    outputAsset,
    fee: new Decimal(leg.fee || 0),
    feeAsset: outputAsset,
    averagePrice: new Decimal(leg.averagePrice || 0),
    fullFill: matched.gt(0) && unmatched.lte(0)
  };
}
function isTerminal(status: string) { return ["done", "canceled", "cancelled", "rejected"].includes(status.toLowerCase()); }
function makeClientOrderId(plan: CrossQuoteExecutionPlan, stage: CrossQuoteOrderStage) {
  const nonce = Math.random().toString(36).slice(2, 8);
  return `cq-${plan.asset.toLowerCase()}-${stage}-${Date.now().toString(36)}-${nonce}`.slice(0, 32);
}
function isDefinitiveRejection(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  return message.startsWith("order rejected:") || message.includes("insufficient balance") || message.includes("invalid order");
}
function revalidationError(message: string) { return new CrossQuoteExecutionError(message, "REVALIDATION_FAILED"); }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
function normalizeOrderError(error: unknown, prefix: string) {
  if (error instanceof OrderStateUnknownError) return new CrossQuoteExecutionError(`${prefix}: ${error.message}`, "ORDER_STATE_UNKNOWN", true, { cause: error });
  if (error instanceof CrossQuoteExecutionError) return error;
  return new CrossQuoteExecutionError(`${prefix}: ${errorMessage(error)}`, "ORDER_FAILED", false, { cause: error });
}
async function safeHook(call: () => Promise<void> | void | undefined) {
  try { await call(); } catch { /* Persistence telemetry must not strand an already-exposed position. */ }
}
function decimal(value: Decimal.Value, name: string) {
  try {
    const result = new Decimal(value);
    if (!result.isFinite()) throw new Error();
    return result;
  } catch {
    throw new CrossQuoteExecutionError(`${name} must be a finite number`, "INVALID_PLAN");
  }
}
function boundedDecimal(value: Decimal.Value, min: number, max: number, name: string) {
  const result = decimal(value, name);
  if (result.lt(min) || result.gt(max)) throw new CrossQuoteExecutionError(`${name} must be between ${min} and ${max}`, "INVALID_PLAN");
  return result;
}
function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new CrossQuoteExecutionError(`${name} must be a positive integer`, "INVALID_PLAN");
  return value;
}
