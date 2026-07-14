import Decimal from "decimal.js";
import { config } from "@/lib/config";
import type { BotSettings } from "@/lib/bot-settings";
import { NobitexClient } from "@/lib/exchanges/nobitex";
import type { MarketOptions, NobitexOrder, OrderBook, Side } from "@/lib/exchanges/types";
import { findTriangularOpportunities, quoteEdge } from "./engine";
import type { Opportunity } from "./types";

export type ExecutionLeg = {
  stage?: "cycle" | "recovery";
  symbol: string;
  side: string;
  orderId: string;
  clientOrderId?: string;
  status: string;
  input: string;
  expectedOutput: string;
  output: string;
  averagePrice: string;
  fee: string;
  slippageBuffer: string;
  levelsUsed: number;
  totalLevels: number;
  depthConsumedPercent: string;
  priceImpactBps: string;
  spreadBps: string;
  inputAsset?: string;
  outputAsset?: string;
  matchedAmount?: string;
  unmatchedAmount?: string;
};

export type LiveExecutionClient = Pick<
  NobitexClient,
  "getAllOrderBooks" | "getMarketOptions" | "placeMarketOrder" | "getOrderStatus" | "cancelOrder"
> & Partial<Pick<NobitexClient, "getOrderStatusByClientOrderId">>;

export type RecoveryPosition = { asset: string; amount: Decimal };
export type LiveInventory = Record<string, Decimal>;
export type RecoveryLegEvent = {
  phase: "submitted" | "finalized";
  reason: string;
  attempt: number;
  position: RecoveryPosition;
  leg: ExecutionLeg;
};
export type LiveRecoveryResult = {
  reason: string;
  actualInputToman: Decimal;
  preRecoveryToman: Decimal;
  startedInventory: RecoveryPosition[];
  residualInventory: RecoveryPosition[];
  recoveredToman: Decimal;
  residualValueToman: Decimal;
  economicRecoveredToman: Decimal;
  legs: ExecutionLeg[];
};
export type RecoverIntermediateInventoryInput = {
  reason: string;
  actualInputToman: Decimal.Value;
  preRecoveryToman?: Decimal.Value;
  inventory: RecoveryPosition[];
  settings: BotSettings;
  options: MarketOptions;
  client: LiveExecutionClient;
  hooks?: LiveExecutionHooks;
  logs?: ExecutionLeg[];
  now?: () => number;
  maxAttemptsPerAsset?: number;
};

export type LiveOrderIntentContext = {
  stage: "cycle" | "recovery";
  legIndex?: number;
  attempt?: number;
  asset?: string;
  symbol: string;
  side: Side;
  clientOrderId: string;
  requestedInput: Decimal;
  amountBase: Decimal;
  worstPrice: Decimal;
  protectedPrice: Decimal;
};

export type LiveExecutionHooks = {
  onPrepared?: (opportunity: Opportunity) => Promise<unknown> | unknown;
  /** Last gate before a normal cycle order. A thrown error prevents that order from being submitted. */
  onBeforeOrder?: (plannedLegIndex: number, context: LiveOrderIntentContext) => Promise<unknown> | unknown;
  /** Separate unwind gate: normal emergency-stop logic must not prevent exposure reduction. */
  onBeforeRecoveryOrder?: (event: {
    asset: string;
    amount: Decimal;
    attempt: number;
    symbol: string;
    side: "SELL";
    clientOrderId: string;
    requestedInput: Decimal;
    amountBase: Decimal;
    worstPrice: Decimal;
    protectedPrice: Decimal;
  }) => Promise<unknown> | unknown;
  /** Persist this intent before the network call, keyed by clientOrderId for crash-safe reconciliation. */
  onOrderIntent?: (event: {
    stage: "cycle" | "recovery";
    clientOrderId: string;
    symbol: string;
    side: Side;
    amountBase: Decimal;
    expectedPrice: Decimal;
  }) => Promise<unknown> | unknown;
  onLeg?: (leg: ExecutionLeg, completedLegs: ExecutionLeg[]) => Promise<unknown> | unknown;
  onRecoveryStarted?: (event: { reason: string; inventory: RecoveryPosition[] }) => Promise<unknown> | unknown;
  onRecoveryLeg?: (event: RecoveryLegEvent) => Promise<unknown> | unknown;
  onRecoveryCompleted?: (result: LiveRecoveryResult) => Promise<unknown> | unknown;
  onManualInterventionRequired?: (event: { reason: string; inventory: RecoveryPosition[]; error: Error }) => Promise<unknown> | unknown;
};
export type LiveMarketSnapshot = { books: OrderBook[]; options: MarketOptions };

export class LiveExecutionRecoveredError extends Error {
  readonly code = "CYCLE_FAILED_RECOVERED";
  readonly manualInterventionRequired = false;

  constructor(message: string, public readonly recovery: LiveRecoveryResult, options?: ErrorOptions) {
    super(message, options);
    this.name = "LiveExecutionRecoveredError";
  }
}

export class LiveManualInterventionError extends Error {
  readonly code = "MANUAL_INTERVENTION_REQUIRED";
  readonly manualInterventionRequired = true;

  constructor(
    message: string,
    public readonly inventory: RecoveryPosition[],
    public readonly recoveryLegs: ExecutionLeg[] = [],
    options?: ErrorOptions
  ) {
    super(`MANUAL INTERVENTION REQUIRED: ${message}`, options);
    this.name = "LiveManualInterventionError";
  }
}

export class LiveOrderStateUnknownError extends Error {
  readonly code = "ORDER_STATE_UNKNOWN";

  constructor(public readonly orderId: string, message?: string, options?: ErrorOptions) {
    super(message ?? `Order ${orderId} did not reach a confirmed terminal state`, options);
    this.name = "LiveOrderStateUnknownError";
  }
}

export async function executeLive(
  opportunity: Opportunity,
  settings: BotSettings,
  client: LiveExecutionClient = new NobitexClient(),
  hooks: LiveExecutionHooks = {},
  snapshot?: LiveMarketSnapshot
) {
  // Dependency-injected mocks do not need account credentials; the production adapter always does.
  if (client instanceof NobitexClient) assertLiveCredentials();
  const [initialBooks, options] = snapshot
    ? [snapshot.books, snapshot.options]
    : await Promise.all([client.getAllOrderBooks(), client.getMarketOptions()]);
  let activeOpportunity = repriceLiveOpportunity(opportunity, settings, initialBooks, options);
  if (!activeOpportunity) throw new Error("مسیر در بازبینی Live دیگر تمام شروط سود و نقدشوندگی را ندارد؛ هیچ سفارشی ارسال نشد");
  assertLiveSafetyMargin(activeOpportunity, settings, "بازبینی اول");

  // یک snapshot سودده ممکن است فقط چند میلی‌ثانیه دوام داشته باشد؛ پیش از سفارش، بازار با اردربوک تازه دوباره قیمت‌گذاری می‌شود.
  const freshBooks = await client.getAllOrderBooks();
  activeOpportunity = repriceLiveOpportunity(opportunity, settings, freshBooks, options);
  if (!activeOpportunity) throw new Error("مسیر در بازاعتبارسنجی نهایی Live ناپدید شد؛ هیچ سفارشی ارسال نشد");
  assertLiveSafetyMargin(activeOpportunity, settings, "بازاعتبارسنجی نهایی");
  await hooks.onPrepared?.(activeOpportunity);
  let current = activeOpportunity.inputToman;
  let actualInputToman: Decimal | undefined;
  let residualInventory: RecoveryPosition[] = [];
  let residualValueToman = new Decimal(0);
  const logs: ExecutionLeg[] = [];
  const persistLegs = async (leg: ExecutionLeg) => {
    try {
      await hooks.onLeg?.(leg, [...logs]);
    } catch {
      // خطای ثبت لاگ پس از ارسال سفارش نباید چرخه را در دارایی میانی متوقف کند.
    }
  };

  // همان مسیر روی اردربوک تازه از سقف سرمایه واقعی دوباره اندازه‌گذاری شده است.
  const freshQuotes = activeOpportunity.legs;
  for (const quote of freshQuotes) assertLiquiditySafe(quote, settings, "before execution");
  current = activeOpportunity.outputToman;
  const expectedProfit = activeOpportunity.netProfitToman;
  const expectedBps = activeOpportunity.profitBps;
  if (expectedProfit.lt(settings.minNetProfitToman) || expectedBps.lt(settings.minProfitBps)) {
    throw new Error("Opportunity disappeared during live revalidation; no order was sent");
  }

  current = activeOpportunity.inputToman;
  let inventory: LiveInventory = { IRT: activeOpportunity.inputToman };
  let confirmedFill = false;
  try {
  for (let i = 0; i < freshQuotes.length; i += 1) {
    const planned = freshQuotes[i];
    // پس از هر fill، کل خروجی نهایی مسیر با موجودی واقعی و اردربوک تازه دوباره محاسبه می‌شود.
    const books = i === 0 ? freshBooks : await client.getAllOrderBooks();
    assertExecutionSnapshot(books, freshQuotes.slice(i), settings, Date.now());
    const book = books.find(b => b.symbol === planned.edge.book.symbol);
    if (!book) throw new Error(`Market disappeared while executing: ${planned.edge.book.symbol}`);
    const edge = { ...planned.edge, book };
    const liveQuote = quoteEdge(edge, current, feeForMarket(edge.book.quote, settings), settings.slippageBufferBps, settings.orderbookDepthUsagePercent);
    if (!liveQuote) throw new Error(`Insufficient live depth on ${book.symbol}; intermediate asset may require manual recovery`);
    assertLiquiditySafe(liveQuote, settings, i === 0 ? "before first order" : "during execution");
    const projectedFinal = projectRemainingOutput(freshQuotes, i, current, inventory, books, options, settings);
    if (!projectedFinal) throw new Error(`مسیر باقی‌مانده قبل از سفارش ${i + 1} عمق کافی ندارد؛ اجرای خودکار متوقف شد`);
    const profitBase = actualInputToman ?? activeOpportunity.inputToman;
    assertProjectedFinal(projectedFinal, profitBase, settings, i);

    // در BUY کارمزد از رمزارز دریافتی کسر می‌شود؛ grossOutput حجم صحیح سفارش است.
    // حجم BUY فقط از مرز واقعی قیمت محافظت‌شده و precision رسمی مشتق می‌شود؛
    // Live profit buffer هیچ‌وقت برای کوچک‌کردن سفارش یا جاگذاشتن موجودی میانی استفاده نمی‌شود.
    const amountStep = officialStep(options.amountSteps, book.symbol, "amount");
    const priceStep = officialStep(options.priceSteps, book.symbol, "price");
    const protection = protectedMarketOrder(liveQuote, priceStep, settings);
    const amountBase = safeOrderAmountBase(edge.side, current, liveQuote, amountStep, protection.maximumBuyFillPrice);
    if (amountBase.lte(0)) throw new Error(`Rounded amount is zero for ${book.symbol}`);
    assertMinimumOrder(book, edge.side, amountBase, liveQuote, options);

    const clientOrderId = `tri-${Date.now().toString(36)}-${i}`;
    let order: NobitexOrder;
    const intentContext: LiveOrderIntentContext = {
      stage: "cycle", legIndex: i, symbol: book.symbol, side: edge.side, clientOrderId,
      requestedInput: new Decimal(current), amountBase,
      worstPrice: new Decimal(liveQuote.worstPrice), protectedPrice: protection.expectedPrice
    };
    await hooks.onBeforeOrder?.(i, intentContext);
    await hooks.onOrderIntent?.({
      stage: "cycle", clientOrderId, symbol: book.symbol, side: edge.side,
      amountBase, expectedPrice: protection.expectedPrice
    });
    order = await submitOrReconcile(client, {
      side: edge.side, base: book.base, quote: book.quote, amountBase,
      expectedPrice: protection.expectedPrice,
      clientOrderId
    }, `submission:${book.symbol}:${i}`);
    const executionLeg: ExecutionLeg = {
      stage: "cycle",
      symbol: book.symbol,
      side: edge.side,
      orderId: order.id,
      clientOrderId,
      status: order.status,
      input: liveQuote.input.toString(),
      expectedOutput: liveQuote.output.toString(),
      output: "0",
      averagePrice: liveQuote.averagePrice.toString(),
      fee: liveQuote.fee.toString(),
      slippageBuffer: liveQuote.slippageBuffer.toString(),
      levelsUsed: liveQuote.levelsUsed,
      totalLevels: liveQuote.totalLevels,
      depthConsumedPercent: liveQuote.depthConsumedPercent.toString(),
      priceImpactBps: liveQuote.priceImpactBps.toString(),
      spreadBps: liveQuote.spreadBps.toString(),
      inputAsset: edge.from,
      outputAsset: edge.to,
      matchedAmount: "0",
      unmatchedAmount: amountBase.toString()
    };
    logs.push(executionLeg);
    await persistLegs(executionLeg);

    const final = await waitForFinalOrder(client, order, settings.orderTimeoutMs);
    executionLeg.status = final.status;
    executionLeg.matchedAmount = final.matchedAmount.toString();
    executionLeg.unmatchedAmount = final.unmatchedAmount.toString();
    executionLeg.input = realizedOrderInput(edge.side, book.quote, final).toString();
    executionLeg.output = realizedOrderOutput(edge.side, book.quote, final).toString();
    executionLeg.averagePrice = normalizeOrderPrice(book.quote, final.averagePrice).toString();
    executionLeg.fee = normalizeOutputFee(edge.side, book, final.fee).toString();
    if (final.matchedAmount.gt(0)) {
      confirmedFill = true;
      inventory = applyConfirmedOrderToInventory(inventory, book, edge.side, final);
      if (i === 0) actualInputToman = realizedOrderInputToman(edge.side, book.quote, final);
    }
    if (final.matchedAmount.lte(0) || final.unmatchedAmount.gt(0)) {
      await persistLegs(executionLeg);
      throw new Error(`Order ${final.id} was not filled completely (${final.status}); cycle stopped for recovery`);
    }
    await persistLegs(executionLeg);
    current = realizedOrderOutput(edge.side, book.quote, final);
    if (current.lte(0)) throw new Error(`Cannot determine output of order ${final.id}`);
    executionLeg.output = current.toString();
    await persistLegs(executionLeg);
  }
  residualInventory = intermediateInventory(inventory);
  if (residualInventory.length) {
    const valuationBooks = await client.getAllOrderBooks();
    const tradable: RecoveryPosition[] = [];
    const dust: RecoveryPosition[] = [];
    for (const residual of residualInventory) {
      const step = officialStep(options.amountSteps, `${residual.asset}IRT`, "amount");
      const directBook = valuationBooks.find(book => book.symbol.toUpperCase() === `${residual.asset}IRT`);
      if (!directBook || !bookIsFreshAndOpen(directBook, Date.now(), settings.orderbookMaxAgeMs)) {
        throw new Error(`Cannot classify residual ${residual.asset}: a fresh direct IRT market is unavailable`);
      }
      const rounded = floorStep(residual.amount, step);
      const liquidation = rounded.gt(0)
        ? quoteEdge(recoverySellEdge(directBook), rounded, settings.tomanTakerFeeBps, settings.slippageBufferBps, settings.orderbookDepthUsagePercent)
        : undefined;
      if (liquidation && liquidation.grossOutput.gte(options.minOrderRial.div(10))) {
        tradable.push(residual);
      } else {
        dust.push(residual);
      }
    }
    if (tradable.length) {
      const settlement = await recoverIntermediateInventory({
        reason: "post-cycle residual settlement",
        actualInputToman: actualInputToman ?? activeOpportunity.inputToman,
        preRecoveryToman: current,
        inventory: tradable,
        settings, options, client, hooks, logs
      });
      current = settlement.recoveredToman;
      residualInventory = mergeRecoveryPositions([...dust, ...settlement.residualInventory]);
    } else {
      residualInventory = dust;
    }
    inventory = { IRT: current };
    for (const residual of residualInventory) inventory[residual.asset] = residual.amount;
    residualValueToman = valueResidualDust(residualInventory, valuationBooks, settings, Date.now());
  }
  } catch (error) {
    const exposed = intermediateInventory(inventory);
    if (error instanceof LiveManualInterventionError) throw error;
    if (error instanceof LiveOrderStateUnknownError) {
      const manual = new LiveManualInterventionError(
        `${error.message}. Inspect the order and wallet before restarting the bot.`,
        exposed,
        logs.filter(leg => leg.stage === "recovery"),
        { cause: error }
      );
      await safeHook(() => hooks.onManualInterventionRequired?.({ reason: manual.message, inventory: exposed, error: manual }));
      throw manual;
    }
    if (!confirmedFill || !exposed.length) throw error;

    let recovery: LiveRecoveryResult;
    try {
      const recoveryInputToman = actualInputToman ?? activeOpportunity.inputToman;
      const unspentInitialToman = Decimal.max(activeOpportunity.inputToman.minus(recoveryInputToman), 0);
      const preRecoveryToman = Decimal.max((inventory.IRT ?? new Decimal(0)).minus(unspentInitialToman), 0);
      recovery = await recoverIntermediateInventory({
        reason: errorMessage(error),
        actualInputToman: recoveryInputToman,
        preRecoveryToman,
        inventory: exposed, settings, options, client, hooks, logs
      });
    } catch (recoveryError) {
      if (recoveryError instanceof LiveManualInterventionError) throw recoveryError;
      const manual = new LiveManualInterventionError(
        `Automatic recovery failed: ${errorMessage(recoveryError)}`,
        exposed,
        logs.filter(leg => leg.stage === "recovery"),
        { cause: recoveryError }
      );
      await safeHook(() => hooks.onManualInterventionRequired?.({ reason: manual.message, inventory: exposed, error: manual }));
      throw manual;
    }
    throw new LiveExecutionRecoveredError(
      recovery.residualInventory.length
        ? `Triangular cycle failed; all tradable inventory was converted to IRT and ${recovery.residualInventory.length} marked dust position remains. Original failure: ${errorMessage(error)}`
        : `Triangular cycle failed, but all tracked intermediate inventory was automatically converted to IRT. Original failure: ${errorMessage(error)}`,
      recovery,
      { cause: error }
    );
  }
  const executedInputToman = actualInputToman ?? activeOpportunity.inputToman;
  const economicOutputToman = current.plus(residualValueToman);
  return {
    requestedInputToman: activeOpportunity.requestedInputToman,
    inputToman: executedInputToman,
    outputToman: economicOutputToman,
    profitToman: economicOutputToman.minus(executedInputToman),
    realizedOutputToman: current,
    realizedProfitToman: current.minus(executedInputToman),
    residualInventory,
    residualValueToman,
    fullySettled: residualInventory.length === 0,
    legs: logs
  };
}

/**
 * Applies only a confirmed exchange fill to an execution-local inventory ledger.
 * This never reads wallet balances, so pre-existing account inventory cannot be sold accidentally.
 */
export function applyConfirmedOrderToInventory(
  inventory: LiveInventory,
  book: Pick<OrderBook, "base" | "quote">,
  side: Side,
  order: NobitexOrder
): LiveInventory {
  const next = Object.fromEntries(
    Object.entries(inventory).map(([asset, amount]) => [asset.toUpperCase(), new Decimal(amount)])
  ) as LiveInventory;
  if (order.matchedAmount.lte(0)) return next;
  const base = book.base.toUpperCase();
  const quote = book.quote.toUpperCase();
  if (side === "BUY") {
    const spent = order.totalPrice.div(quote === "IRT" ? 10 : 1);
    next[quote] = Decimal.max((next[quote] ?? new Decimal(0)).minus(spent), 0);
    next[base] = (next[base] ?? new Decimal(0)).plus(realizedOrderOutput(side, quote, order));
  } else {
    next[base] = Decimal.max((next[base] ?? new Decimal(0)).minus(order.matchedAmount), 0);
    next[quote] = (next[quote] ?? new Decimal(0)).plus(realizedOrderOutput(side, quote, order));
  }
  return next;
}

export function intermediateInventory(inventory: LiveInventory): RecoveryPosition[] {
  return Object.entries(inventory)
    .map(([asset, amount]) => ({ asset: asset.toUpperCase(), amount: new Decimal(amount) }))
    .filter(position => position.asset !== "IRT" && position.amount.gt(0))
    .sort((a, b) => a.asset.localeCompare(b.asset));
}

/**
 * Converts execution-local intermediate balances to IRT. Every attempt uses a new orderbook snapshot,
 * a protected SELL price, configured depth reservation and the same spread/impact limits as Live entry.
 */
export async function recoverIntermediateInventory(input: RecoverIntermediateInventoryInput): Promise<LiveRecoveryResult> {
  const hooks = input.hooks ?? {};
  const logs = input.logs ?? [];
  const now = input.now ?? Date.now;
  const maxAttempts = Math.max(1, Math.min(3, Math.floor(input.maxAttemptsPerAsset ?? 2)));
  const startedInventory = mergeRecoveryPositions(input.inventory);
  const remaining = new Map(startedInventory.map(position => [position.asset, position.amount]));
  const recoveryLegs: ExecutionLeg[] = [];
  const preRecoveryToman = new Decimal(input.preRecoveryToman ?? 0);
  let recoveredToman = preRecoveryToman;
  await safeHook(() => hooks.onRecoveryStarted?.({ reason: input.reason, inventory: clonePositions(startedInventory) }));

  try {
    for (const position of startedInventory) {
      let amount = position.amount;
      for (let attempt = 1; attempt <= maxAttempts && amount.gt(0); attempt += 1) {
        const books = await input.client.getAllOrderBooks();
        const symbol = `${position.asset}IRT`;
        const book = books.find(item => item.symbol.toUpperCase() === symbol);
        if (!book) throw new Error(`Recovery market ${symbol} is unavailable`);
        assertFreshRecoveryBook(book, now(), input.settings.orderbookMaxAgeMs);

        const amountStep = officialStep(input.options.amountSteps, book.symbol, "amount");
        const amountBase = floorStep(amount, amountStep);
        if (amountBase.lte(0)) {
          // A sub-step residue is non-tradable dust, not a reason to risk selling account inventory.
          break;
        }
        const edge = recoverySellEdge(book);
        const quote = quoteEdge(
          edge,
          amountBase,
          input.settings.tomanTakerFeeBps,
          input.settings.slippageBufferBps,
          input.settings.orderbookDepthUsagePercent
        );
        if (!quote) throw new Error(`Recovery market ${symbol} has insufficient reserved depth for ${amountBase.toString()} ${position.asset}`);
        assertLiquiditySafe(quote, input.settings, "during automatic recovery");
        const minimumToman = input.options.minOrderRial.div(10);
        if (quote.grossOutput.lt(minimumToman)) {
          throw new Error(`Recovery value on ${symbol} is ${quote.grossOutput.toFixed(0)} Toman, below the ${minimumToman.toFixed(0)} Toman minimum`);
        }

        const clientOrderId = `tri-rec-${Date.now().toString(36)}-${attempt}`;
        let order: NobitexOrder;
        const priceStep = officialStep(input.options.priceSteps, book.symbol, "price");
        const protection = protectedMarketOrder(quote, priceStep, input.settings);
        await hooks.onBeforeRecoveryOrder?.({
          asset: position.asset, amount: amountBase, attempt,
          symbol: book.symbol, side: "SELL", clientOrderId,
          requestedInput: new Decimal(amount), amountBase,
          worstPrice: new Decimal(quote.worstPrice), protectedPrice: protection.expectedPrice
        });
        await hooks.onOrderIntent?.({
          stage: "recovery", clientOrderId, symbol: book.symbol, side: "SELL",
          amountBase, expectedPrice: protection.expectedPrice
        });
        order = await submitOrReconcile(input.client, {
          side: "SELL", base: book.base, quote: book.quote, amountBase,
          expectedPrice: protection.expectedPrice,
          clientOrderId
        }, `recovery-submission:${symbol}:${attempt}`);

        const leg: ExecutionLeg = {
          stage: "recovery",
          symbol: book.symbol,
          side: "SELL",
          orderId: order.id,
          clientOrderId,
          status: order.status,
          input: amountBase.toString(),
          expectedOutput: quote.output.toString(),
          output: "0",
          averagePrice: quote.averagePrice.toString(),
          fee: quote.fee.toString(),
          slippageBuffer: quote.slippageBuffer.toString(),
          levelsUsed: quote.levelsUsed,
          totalLevels: quote.totalLevels,
          depthConsumedPercent: quote.depthConsumedPercent.toString(),
          priceImpactBps: quote.priceImpactBps.toString(),
          spreadBps: quote.spreadBps.toString(),
          inputAsset: position.asset,
          outputAsset: "IRT",
          matchedAmount: "0",
          unmatchedAmount: amountBase.toString()
        };
        logs.push(leg);
        recoveryLegs.push(leg);
        await safeHook(() => hooks.onLeg?.(leg, [...logs]));
        await safeHook(() => hooks.onRecoveryLeg?.({
          phase: "submitted", reason: input.reason, attempt,
          position: { asset: position.asset, amount }, leg
        }));

        const final = await waitForFinalOrder(input.client, order, input.settings.orderTimeoutMs);
        leg.status = final.status;
        leg.matchedAmount = final.matchedAmount.toString();
        leg.unmatchedAmount = final.unmatchedAmount.toString();
        leg.input = realizedOrderInput("SELL", book.quote, final).toString();
        leg.output = realizedOrderOutput("SELL", book.quote, final).toString();
        leg.averagePrice = normalizeOrderPrice(book.quote, final.averagePrice).toString();
        leg.fee = normalizeOutputFee("SELL", book, final.fee).toString();
        await safeHook(() => hooks.onLeg?.(leg, [...logs]));
        await safeHook(() => hooks.onRecoveryLeg?.({
          phase: "finalized", reason: input.reason, attempt,
          position: { asset: position.asset, amount }, leg
        }));

        if (final.matchedAmount.lte(0)) throw new Error(`Recovery order ${final.id} had no confirmed fill`);
        recoveredToman = recoveredToman.plus(realizedOrderOutput("SELL", book.quote, final));
        amount = Decimal.max(amount.minus(final.matchedAmount), 0);
        remaining.set(position.asset, amount);
        if (amount.lt(amountStep)) break;
        const fullyFilled = final.unmatchedAmount.lte(0) && final.matchedAmount.gte(amountBase);
        if (!fullyFilled && attempt === maxAttempts) {
          throw new Error(`Recovery order ${final.id} remained partially filled after ${maxAttempts} safe attempts`);
        }
      }

      const amountStep = officialStep(input.options.amountSteps, `${position.asset}IRT`, "amount");
      if (amount.gte(amountStep)) {
        throw new Error(`Automatic recovery left ${amount.toString()} ${position.asset}`);
      }
      remaining.set(position.asset, amount);
    }

    const residualInventory = positionsFromMap(remaining);
    const residualValueToman = residualInventory.length
      ? valueResidualDust(residualInventory, await input.client.getAllOrderBooks(), input.settings, now())
      : new Decimal(0);
    const result: LiveRecoveryResult = {
      reason: input.reason,
      actualInputToman: new Decimal(input.actualInputToman),
      preRecoveryToman,
      startedInventory: clonePositions(startedInventory),
      residualInventory,
      recoveredToman,
      residualValueToman,
      economicRecoveredToman: recoveredToman.plus(residualValueToman),
      legs: recoveryLegs
    };
    await safeHook(() => hooks.onRecoveryCompleted?.(result));
    return result;
  } catch (error) {
    const unresolved = positionsFromMap(remaining);
    const manual = error instanceof LiveManualInterventionError
      ? error
      : new LiveManualInterventionError(
        `Automatic IRT recovery failed: ${errorMessage(error)}`,
        unresolved,
        recoveryLegs,
        { cause: error }
      );
    await safeHook(() => hooks.onManualInterventionRequired?.({ reason: manual.message, inventory: unresolved, error: manual }));
    throw manual;
  }
}

export function repriceLiveOpportunity(
  opportunity: Opportunity,
  settings: BotSettings,
  books: OrderBook[],
  options: MarketOptions,
  now = Date.now()
) {
  return findTriangularOpportunities({
    books,
    options,
    capitalToman: opportunity.requestedInputToman,
    now,
    tomanFeeBps: settings.tomanTakerFeeBps,
    usdtFeeBps: settings.usdtTakerFeeBps,
    slippageBps: settings.slippageBufferBps,
    maxPriceImpactBps: settings.maxPriceImpactBps,
    maxSpreadBps: settings.maxSpreadBps,
    depthUsagePercent: settings.orderbookDepthUsagePercent,
    minProfitBps: settings.minProfitBps,
    minNetProfitToman: settings.minNetProfitToman,
    liveSafetyBufferBps: settings.liveSafetyBufferBps,
    maxAgeMs: settings.orderbookMaxAgeMs
  }).find(candidate => candidate.id === opportunity.id && candidate.executable);
}

export function assertLiveCredentials() {
  if (!config.NOBITEX_API_KEY || !config.NOBITEX_API_SECRET) throw new Error("Nobitex credentials are missing");
}

export async function waitForFinalOrder(client: LiveExecutionClient, initial: NobitexOrder, orderTimeoutMs: number) {
  const deadline = Date.now() + orderTimeoutMs;
  let order = initial;
  while (Date.now() < deadline) {
    if (isTerminalOrderStatus(order.status)) return order;
    await new Promise(resolve => setTimeout(resolve, 250));
    try {
      order = await client.getOrderStatus(order.id);
    } catch {
      // A transient status failure is retried until the deadline; no second order is submitted meanwhile.
    }
  }
  try {
    await client.cancelOrder(initial.id);
    order = await client.getOrderStatus(initial.id);
    if (isTerminalOrderStatus(order.status)) return order;
  } catch (error) {
    throw new LiveOrderStateUnknownError(
      initial.id,
      `Order ${initial.id} timed out and its terminal state could not be confirmed after cancellation`,
      { cause: error }
    );
  }
  throw new LiveOrderStateUnknownError(initial.id, `Order ${initial.id} remained active after automatic cancellation`);
}

export function realizedOrderOutput(side: "BUY" | "SELL", quote: string, order: NobitexOrder) {
  if (side === "BUY") return Decimal.max(order.matchedAmount.minus(order.fee), 0);
  return Decimal.max(order.totalPrice.minus(order.fee).div(quote === "IRT" ? 10 : 1), 0);
}

export function realizedOrderInput(side: Side, quote: string, order: NobitexOrder) {
  return side === "BUY"
    ? order.totalPrice.div(quote === "IRT" ? 10 : 1)
    : order.matchedAmount;
}

function isTerminalOrderStatus(status: string) {
  return ["done", "canceled", "cancelled", "rejected"].includes(status.toLowerCase());
}

function normalizeOrderPrice(quote: string, price: Decimal) {
  return price.div(quote === "IRT" ? 10 : 1);
}

function normalizeOutputFee(side: Side, book: Pick<OrderBook, "base" | "quote">, fee: Decimal) {
  const outputAsset = side === "BUY" ? book.base : book.quote;
  return fee.div(outputAsset === "IRT" ? 10 : 1);
}

function mergeRecoveryPositions(positions: RecoveryPosition[]) {
  const merged = new Map<string, Decimal>();
  for (const position of positions) {
    const asset = position.asset.trim().toUpperCase();
    if (!asset || asset === "IRT" || !position.amount.isFinite() || position.amount.lte(0)) continue;
    merged.set(asset, (merged.get(asset) ?? new Decimal(0)).plus(position.amount));
  }
  return positionsFromMap(merged);
}

function positionsFromMap(positions: Map<string, Decimal>) {
  return [...positions.entries()]
    .filter(([, amount]) => amount.gt(0))
    .map(([asset, amount]) => ({ asset, amount: new Decimal(amount) }))
    .sort((a, b) => a.asset.localeCompare(b.asset));
}

function clonePositions(positions: RecoveryPosition[]) {
  return positions.map(position => ({ asset: position.asset, amount: new Decimal(position.amount) }));
}

function recoverySellEdge(book: OrderBook) {
  return {
    id: `${book.symbol}:SELL:RECOVERY`,
    from: book.base,
    to: book.quote,
    side: "SELL" as const,
    book
  };
}

function assertFreshRecoveryBook(book: OrderBook, now: number, maxAgeMs: number) {
  if (!bookIsFreshAndOpen(book, now, maxAgeMs)) {
    throw new Error(`Recovery orderbook ${book.symbol} is stale or has an invalid timestamp`);
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function safeHook(call: () => Promise<unknown> | unknown) {
  try { await call(); } catch { /* Logging must never strand an exposed intermediate balance. */ }
}

function realizedOrderInputToman(side: "BUY" | "SELL", quote: string, order: NobitexOrder) {
  if (side !== "BUY" || quote !== "IRT") throw new Error("ضلع اول چرخه Live باید خرید از بازار تومانی باشد");
  return order.totalPrice.div(10);
}

function floorStep(value: Decimal, step: Decimal) { return value.div(step).floor().mul(step); }

/** Round away from the unprotected side of Nobitex's effective market-order range. */
export function priceToOutwardStep(side: Side, value: Decimal, step: Decimal) {
  if (!step.isFinite() || step.lte(0)) throw new Error("A positive official price step is required");
  const units = value.div(step);
  return (side === "BUY" ? units.ceil() : units.floor()).mul(step);
}

export function safeOrderAmountBase(
  side: Side,
  availableInput: Decimal,
  quote: NonNullable<ReturnType<typeof quoteEdge>>,
  amountStep: Decimal,
  maximumBuyFillPrice: Decimal
) {
  if (!amountStep.isFinite() || amountStep.lte(0)) throw new Error("A positive official amount step is required");
  const raw = side === "SELL"
    ? availableInput
    : Decimal.min(quote.grossOutput, availableInput.div(maximumBuyFillPrice));
  return floorStep(raw, amountStep);
}

// نوبیتکس سفارش مارکت را حدود ۱٪ پیرامون price محدود می‌کند. price طوری عقب/جلو برده می‌شود
// که مرز واقعی اجرا تقریباً با بافر لغزش تنظیم‌شده منطبق باشد.
function protectedExpectedPrice(side: Side, worst: Decimal, settings: BotSettings) {
  const tolerance = Decimal.min(new Decimal(settings.slippageBufferBps).div(10_000), "0.009");
  return side === "BUY"
    ? worst.mul(new Decimal(1).plus(tolerance)).div("1.01")
    : worst.mul(new Decimal(1).minus(tolerance)).div("0.99");
}

export function protectedMarketOrder(
  quote: NonNullable<ReturnType<typeof quoteEdge>>,
  priceStep: Decimal,
  settings: BotSettings
) {
  const side = quote.edge.side;
  const expectedPrice = priceToOutwardStep(side, protectedExpectedPrice(side, quote.worstPrice, settings), priceStep);
  if (!expectedPrice.isFinite() || expectedPrice.lte(0)) {
    throw new Error(`Protected market price rounded to an invalid value on ${quote.edge.book.symbol}`);
  }
  const minimumSellFillPrice = expectedPrice.mul("0.99");
  const maximumBuyFillPrice = expectedPrice.mul("1.01");
  const levels = side === "BUY"
    ? quote.edge.book.asks.filter(level => level.price.gt(0) && level.amount.gt(0)).sort((a, b) => a.price.comparedTo(b.price))
    : quote.edge.book.bids.filter(level => level.price.gt(0) && level.amount.gt(0)).sort((a, b) => b.price.comparedTo(a.price));
  const usedLevels = levels.slice(0, quote.levelsUsed);
  const covered = usedLevels.length === quote.levelsUsed && usedLevels.every(level => side === "BUY"
    ? level.price.lte(maximumBuyFillPrice)
    : level.price.gte(minimumSellFillPrice));
  if (!covered) {
    throw new Error(`Protected market price does not cover every simulated level on ${quote.edge.book.symbol}`);
  }
  return { expectedPrice, minimumSellFillPrice, maximumBuyFillPrice };
}

function feeForMarket(quote: string, settings: BotSettings) {
  return quote === "IRT" ? settings.tomanTakerFeeBps : settings.usdtTakerFeeBps;
}

function assertLiquiditySafe(quote: NonNullable<ReturnType<typeof quoteEdge>>, settings: BotSettings, phase: string) {
  if (quote.spreadBps.gt(settings.maxSpreadBps)) {
    throw new Error(`Spread too high on ${quote.edge.book.symbol} ${phase}: ${quote.spreadBps.toFixed(2)} BPS`);
  }
  if (quote.priceImpactBps.gt(settings.maxPriceImpactBps)) {
    throw new Error(`Price impact too high on ${quote.edge.book.symbol} ${phase}: ${quote.priceImpactBps.toFixed(2)} BPS`);
  }
}

function requiredLiveProfit(input: Decimal, settings: BotSettings) {
  const requiredBps = new Decimal(settings.minProfitBps).plus(settings.liveSafetyBufferBps);
  return Decimal.max(settings.minNetProfitToman, input.mul(requiredBps).div(10_000));
}

function assertLiveSafetyMargin(opportunity: Opportunity, settings: BotSettings, phase: string) {
  const rejection = liveSafetyRejectionReason(opportunity, settings);
  if (rejection) throw new Error(`${phase}: ${rejection}؛ هیچ سفارشی ارسال نشد`);
}

export function liveSafetyRejectionReason(opportunity: Opportunity, settings: BotSettings) {
  const required = requiredLiveProfit(opportunity.inputToman, settings);
  return opportunity.netProfitToman.lt(required)
    ? `سود ${opportunity.netProfitToman.toFixed(0)} تومان از حد امن Live ${required.toFixed(0)} تومان کمتر است`
    : undefined;
}

function assertProjectedFinal(projectedFinal: Decimal, input: Decimal, settings: BotSettings, legIndex: number) {
  const requiredFinal = input.plus(requiredLiveProfit(input, settings));
  if (projectedFinal.lt(requiredFinal)) {
    throw new Error(`گارد سود انتهابه‌انتها قبل از سفارش ${legIndex + 1} فعال شد: خروجی برآوردی ${projectedFinal.toFixed(0)} کمتر از حد امن ${requiredFinal.toFixed(0)} تومان است`);
  }
}

function projectRemainingOutput(
  plannedQuotes: Opportunity["legs"],
  start: number,
  input: Decimal,
  inventory: LiveInventory,
  books: OrderBook[],
  options: MarketOptions,
  settings: BotSettings
) {
  const simulated: LiveInventory = {};
  for (const [asset, amount] of Object.entries(inventory)) {
    if (asset.toUpperCase() !== "IRT" && amount.gt(0)) simulated[asset.toUpperCase()] = new Decimal(amount);
  }
  const startingAsset = plannedQuotes[start]?.edge.from;
  if (!startingAsset) return undefined;
  simulated[startingAsset] = new Decimal(input);
  for (let i = start; i < plannedQuotes.length; i += 1) {
    const planned = plannedQuotes[i];
    const book = books.find(item => item.symbol === planned.edge.book.symbol);
    if (!book) return undefined;
    const edge = { ...planned.edge, book };
    const available = simulated[edge.from] ?? new Decimal(0);
    let quote = quoteEdge(edge, available, feeForMarket(book.quote, settings), settings.slippageBufferBps, settings.orderbookDepthUsagePercent);
    if (!quote || quote.spreadBps.gt(settings.maxSpreadBps) || quote.priceImpactBps.gt(settings.maxPriceImpactBps)) return undefined;
    const amountStep = officialStep(options.amountSteps, book.symbol, "amount");
    if (edge.side === "BUY") {
      const priceStep = officialStep(options.priceSteps, book.symbol, "price");
      const protection = protectedMarketOrder(quote, priceStep, settings);
      const amountBase = safeOrderAmountBase("BUY", available, quote, amountStep, protection.maximumBuyFillPrice);
      if (amountBase.lte(0)) return undefined;
      assertMinimumOrder(book, edge.side, amountBase, quote, options);
      const feeRetention = new Decimal(1).minus(new Decimal(feeForMarket(book.quote, settings)).div(10_000));
      const slipRetention = new Decimal(1).minus(new Decimal(settings.slippageBufferBps).div(10_000));
      const maximumSpend = Decimal.min(available, amountBase.mul(protection.maximumBuyFillPrice));
      simulated[edge.from] = Decimal.max(available.minus(maximumSpend), 0);
      simulated[edge.to] = (simulated[edge.to] ?? new Decimal(0)).plus(amountBase.mul(feeRetention).mul(slipRetention));
    } else {
      const amountBase = floorStep(available, amountStep);
      if (amountBase.lte(0)) return undefined;
      quote = quoteEdge(edge, amountBase, feeForMarket(book.quote, settings), settings.slippageBufferBps, settings.orderbookDepthUsagePercent);
      if (!quote) return undefined;
      assertMinimumOrder(book, edge.side, amountBase, quote, options);
      simulated[edge.from] = Decimal.max(available.minus(amountBase), 0);
      simulated[edge.to] = (simulated[edge.to] ?? new Decimal(0)).plus(quote.output);
    }
  }
  return Object.entries(simulated).reduce<Decimal | undefined>((total, [asset, amount]) => {
    if (!total || amount.lte(0)) return total;
    if (asset === "IRT") return total.plus(amount);
    const book = books.find(item => item.symbol.toUpperCase() === `${asset}IRT`);
    if (!book || !bookIsFreshAndOpen(book, Date.now(), settings.orderbookMaxAgeMs)) return undefined;
    const quote = quoteEdge(recoverySellEdge(book), amount, settings.tomanTakerFeeBps, settings.slippageBufferBps, settings.orderbookDepthUsagePercent);
    return quote ? total.plus(quote.output) : undefined;
  }, new Decimal(0));
}

function officialStep(steps: Record<string, Decimal>, symbol: string, kind: "amount" | "price") {
  const step = steps[symbol] ?? steps[symbol.toUpperCase()];
  if (!step?.isFinite() || step.lte(0)) {
    throw new Error(`Official ${kind} precision is unavailable for ${symbol}; Live execution failed closed`);
  }
  return step;
}

function assertMinimumOrder(
  book: OrderBook,
  side: Side,
  amountBase: Decimal,
  quote: NonNullable<ReturnType<typeof quoteEdge>>,
  options: MarketOptions
) {
  const conservativeQuoteAmount = amountBase.mul(side === "BUY" ? quote.bestPrice : quote.worstPrice);
  const minimum = book.quote === "IRT" ? options.minOrderRial.div(10) : options.minOrderUsdt;
  if (!minimum.isFinite() || minimum.lte(0)) throw new Error(`Official minimum order is unavailable for ${book.quote}`);
  if (conservativeQuoteAmount.lt(minimum)) {
    throw new Error(`Rounded ${book.symbol} order is below the official ${minimum.toString()} ${book.quote} minimum`);
  }
}

function assertExecutionSnapshot(
  books: OrderBook[],
  plannedQuotes: Opportunity["legs"],
  settings: BotSettings,
  now: number
) {
  const selected = plannedQuotes.map(planned => {
    const book = books.find(item => item.symbol === planned.edge.book.symbol);
    if (!book) throw new Error(`Orderbook ${planned.edge.book.symbol} disappeared before submission`);
    if (!bookIsFreshAndOpen(book, now, settings.orderbookMaxAgeMs)) {
      throw new Error(`Orderbook ${book.symbol} is stale, future-dated, empty, or crossed; no order was sent`);
    }
    return book;
  });
  const timestamps = selected.map(book => book.lastUpdate);
  const maxSkew = Math.min(settings.orderbookMaxAgeMs, 1_000);
  if (Math.max(...timestamps) - Math.min(...timestamps) > maxSkew) {
    throw new Error(`Selected orderbooks are not synchronized within ${maxSkew}ms; no order was sent`);
  }
}

function bookIsFreshAndOpen(book: OrderBook, now: number, maxAgeMs: number) {
  const bestBid = book.bids.filter(level => level.price.gt(0) && level.amount.gt(0))
    .reduce<Decimal | undefined>((best, level) => !best || level.price.gt(best) ? level.price : best, undefined);
  const bestAsk = book.asks.filter(level => level.price.gt(0) && level.amount.gt(0))
    .reduce<Decimal | undefined>((best, level) => !best || level.price.lt(best) ? level.price : best, undefined);
  return Number.isFinite(book.lastUpdate)
    && book.lastUpdate > 0
    && now - book.lastUpdate <= maxAgeMs
    && book.lastUpdate - now <= 1_000
    && Boolean(bestBid && bestAsk && bestBid.lt(bestAsk));
}

function valueResidualDust(
  residuals: RecoveryPosition[],
  books: OrderBook[],
  settings: BotSettings,
  now: number
) {
  return residuals.reduce((total, residual) => {
    const symbol = `${residual.asset}IRT`;
    const book = books.find(item => item.symbol.toUpperCase() === symbol);
    if (!book || !bookIsFreshAndOpen(book, now, settings.orderbookMaxAgeMs)) {
      throw new Error(`Cannot mark residual ${residual.asset}: a fresh, uncrossed ${symbol} book is unavailable`);
    }
    const quote = quoteEdge(
      recoverySellEdge(book), residual.amount, settings.tomanTakerFeeBps,
      settings.slippageBufferBps, settings.orderbookDepthUsagePercent
    );
    if (!quote) throw new Error(`Cannot mark residual ${residual.asset}: available ${symbol} depth is insufficient`);
    assertLiquiditySafe(quote, settings, "while valuing residual dust");
    return total.plus(quote.output);
  }, new Decimal(0));
}

type MarketSubmission = {
  side: Side;
  base: string;
  quote: string;
  amountBase: Decimal;
  expectedPrice: Decimal;
  clientOrderId: string;
};

export async function submitOrReconcile(client: LiveExecutionClient, input: MarketSubmission, unknownOrderId: string) {
  try {
    return await client.placeMarketOrder(input);
  } catch (submissionError) {
    if (isDefinitiveSubmissionRejection(submissionError)) throw submissionError;
    if (client.getOrderStatusByClientOrderId) {
      let reconciliationError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, 150));
        try {
          return await client.getOrderStatusByClientOrderId(input.clientOrderId);
        } catch (error) {
          reconciliationError = error;
        }
      }
      throw new LiveOrderStateUnknownError(
        unknownOrderId,
        `Submission outcome for ${input.clientOrderId} remains unknown after clientOrderId reconciliation`,
        { cause: reconciliationError ?? submissionError }
      );
    }
    throw new LiveOrderStateUnknownError(
      unknownOrderId,
      `Submission outcome for ${input.clientOrderId} is unknown and the adapter cannot reconcile clientOrderId`,
      { cause: submissionError }
    );
  }
}

function isDefinitiveSubmissionRejection(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("Order rejected:") || message.startsWith("Margin order rejected:");
}
