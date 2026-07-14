import Decimal from "decimal.js";
import { assertLiveOwnerForOrder } from "@/lib/runtime/live-owner";
import { config } from "@/lib/config";
import { signEd25519Base64 } from "./signing";
import type {
  CandleSeries,
  MarginMarket,
  MarginPosition,
  MarketOptions,
  NobitexOrder,
  OrderBook,
  Wallet
} from "./types";

type Json = Record<string, unknown>;
let marketOptionsCache: { value: MarketOptions; expiresAt: number } | undefined;

export class NobitexClient {
  async getCandles(symbol: string, resolution = "60", countback = 120): Promise<CandleSeries> {
    const normalizedSymbol = symbol.toUpperCase();
    const safeCount = Math.max(20, Math.min(500, Math.floor(countback)));
    const to = Math.floor(Date.now() / 1_000);
    const data = await this.request<Json>(
      "GET",
      `/market/udf/history?symbol=${encodeURIComponent(normalizedSymbol)}&resolution=${encodeURIComponent(resolution)}&to=${to}&countback=${safeCount}`,
      undefined,
      false
    );
    if (data.s !== "ok") throw new Error(`Nobitex candle history failed for ${normalizedSymbol}: ${String(data.errmsg ?? data.s ?? "unknown")}`);
    const timestamps = Array.isArray(data.t) ? data.t.map(Number) : [];
    const pricesInRial = normalizedSymbol.endsWith("IRT");
    const decimals = (value: unknown) => (Array.isArray(value) ? value : []).map(item => {
      const parsed = new Decimal(String(item));
      return pricesInRial ? parsed.div(10) : parsed;
    });
    const volume = (Array.isArray(data.v) ? data.v : []).map(item => new Decimal(String(item)));
    return {
      symbol: normalizedSymbol,
      resolution,
      timestamps,
      open: decimals(data.o),
      high: decimals(data.h),
      low: decimals(data.l),
      close: decimals(data.c),
      volume
    };
  }

  async getAllOrderBooks(): Promise<OrderBook[]> {
    const data = await this.request<Json>("GET", "/v3/orderbook/all", undefined, false);
    if (data.status !== "ok") throw new Error(`Nobitex orderbook failed: ${JSON.stringify(data)}`);
    const books: OrderBook[] = [];
    for (const [symbol, value] of Object.entries(data)) {
      if (symbol === "status" || !value || typeof value !== "object") continue;
      const pair = splitSymbol(symbol);
      if (!pair) continue;
      const item = value as Json;
      const convertPrice = (raw: unknown) => new Decimal(String(raw)).div(pair.quote === "IRT" ? 10 : 1);
      const levels = (raw: unknown): [string, string][] => Array.isArray(raw) ? raw as [string, string][] : [];
      books.push({
        symbol,
        ...pair,
        asks: levels(item.asks).map(([p, a]) => ({ price: convertPrice(p), amount: new Decimal(a) })),
        bids: levels(item.bids).map(([p, a]) => ({ price: convertPrice(p), amount: new Decimal(a) })),
        lastUpdate: Number(item.lastUpdate ?? 0)
      });
    }
    return books;
  }

  async getMarketOptions(): Promise<MarketOptions> {
    if (marketOptionsCache && marketOptionsCache.expiresAt > Date.now()) return marketOptionsCache.value;
    const data = await this.request<Json>("GET", "/v2/options", undefined, false);
    const n = (data.nobitex ?? {}) as Json;
    const map = (value: unknown) => Object.fromEntries(Object.entries((value ?? {}) as Json).map(([k, v]) => [k, new Decimal(String(v))]));
    const priceSteps = map(n.pricePrecisions);
    for (const symbol of Object.keys(priceSteps)) if (symbol.endsWith("IRT")) priceSteps[symbol] = priceSteps[symbol].div(10);
    const min = (n.minOrders ?? {}) as Json;
    const value = {
      amountSteps: map(n.amountPrecisions),
      priceSteps,
      minOrderRial: new Decimal(String(min.rls ?? "500000")),
      minOrderUsdt: new Decimal(String(min.usdt ?? "11"))
    };
    marketOptionsCache = { value, expiresAt: Date.now() + 60 * 60 * 1_000 };
    return value;
  }

  async getWallets(): Promise<Wallet[]> {
    // روش سازگار با API Key نوبیتکس، مطابق آداپتر پروژه مرجع arb.
    const data = await this.request<Json>("POST", "/users/wallets/list", {}, true);
    if (data.status !== "ok") {
      throw new Error(`Nobitex wallets failed: ${String(data.code ?? "unknown")} - ${String(data.message ?? "")}`);
    }
    const wallets = Array.isArray(data.wallets) ? data.wallets as Json[] : [];
    return wallets.map(w => {
      const rawAsset = String(w.currency ?? "").toUpperCase();
      const asset = ["RLS", "IRR", "RIAL"].includes(rawAsset) ? "IRT" : rawAsset;
      const divisor = asset === "IRT" ? 10 : 1;
      return {
        asset,
        available: new Decimal(String(w.activeBalance ?? w.balance ?? 0)).div(divisor),
        blocked: new Decimal(String(w.blockedBalance ?? 0)).div(divisor)
      };
    });
  }

  async getSpotTomanWallet(): Promise<Wallet> {
    const data = await this.request<Json>("GET", "/v2/wallets?currencies=rls&type=spot", undefined, true);
    if (data.status !== "ok") {
      throw new Error(`Nobitex spot wallet failed: ${String(data.code ?? "unknown")} - ${String(data.message ?? "")}`);
    }
    const wallets = (data.wallets ?? {}) as Json;
    const rial = (wallets.RLS ?? wallets.rls) as Json | undefined;
    if (!rial) throw new Error("کیف پول اسپات RLS در پاسخ نوبیتکس پیدا نشد");
    return {
      asset: "IRT",
      available: new Decimal(String(rial.balance ?? 0)).div(10),
      blocked: new Decimal(String(rial.blocked ?? 0)).div(10)
    };
  }

  async getMarginQuoteWallet(quote: "IRT" | "USDT"): Promise<Wallet> {
    const currency = quote === "IRT" ? "rls" : "usdt";
    const data = await this.request<Json>("GET", `/v2/wallets?currencies=${currency}&type=margin`, undefined, true);
    if (data.status !== "ok") {
      throw new Error(`Nobitex margin wallet failed: ${String(data.code ?? "unknown")} - ${String(data.message ?? "")}`);
    }
    const wallets = (data.wallets ?? {}) as Json;
    const raw = (wallets[currency.toUpperCase()] ?? wallets[currency]) as Json | undefined;
    if (!raw) throw new Error(`Nobitex Margin ${currency.toUpperCase()} wallet was not found`);
    const divisor = quote === "IRT" ? 10 : 1;
    return {
      asset: quote,
      available: safeDecimal(raw.balance).div(divisor),
      blocked: safeDecimal(raw.blocked).div(divisor)
    };
  }

  async getSpotPortfolioSummary() {
    const data = await this.request<Json>("POST", "/users/wallets/list", {}, true);
    if (data.status !== "ok") {
      throw new Error(`Nobitex spot portfolio failed: ${String(data.code ?? "unknown")} - ${String(data.message ?? "")}`);
    }
    const wallets = Array.isArray(data.wallets) ? data.wallets as Json[] : [];
    const rialWallet = wallets.find(wallet => ["RLS", "IRR", "RIAL"].includes(String(wallet.currency ?? "").toUpperCase()));
    const totalEstimatedRial = wallets.reduce((total, wallet) => {
      // پنل اسپات نوبیتکس «ارزش تقریبی» هر ردیف را از rialBalance می‌سازد.
      const estimated = wallet.rialBalance ?? wallet.rialBalanceSell ?? 0;
      return total.plus(new Decimal(String(estimated)));
    }, new Decimal(0));
    return {
      totalEstimatedToman: totalEstimatedRial.div(10),
      availableToman: new Decimal(String(rialWallet?.balance ?? 0)).div(10),
      blockedToman: new Decimal(String(rialWallet?.blockedBalance ?? 0)).div(10)
    };
  }

  async placeMarketOrder(input: { side: "BUY" | "SELL"; base: string; quote: string; amountBase: Decimal; expectedPrice: Decimal; clientOrderId: string }) {
    const body: Json = {
      type: input.side.toLowerCase(),
      execution: "market",
      srcCurrency: input.base.toLowerCase(),
      dstCurrency: input.quote === "IRT" ? "rls" : input.quote.toLowerCase(),
      amount: input.amountBase.toString(),
      price: input.expectedPrice.mul(input.quote === "IRT" ? 10 : 1).toString(),
      clientOrderId: input.clientOrderId.slice(0, 32)
    };
    await assertLiveOwnerForOrder();
    const data = await this.request<Json>("POST", "/market/orders/add", body, true);
    if (data.status !== "ok") throw new Error(`Order rejected: ${String(data.code ?? "unknown")} - ${String(data.message ?? "")}`);
    return parseOrder((data.order ?? data) as Json);
  }

  async getMarginMarkets(): Promise<MarginMarket[]> {
    const data = await this.request<Json>("GET", "/margin/markets/list", undefined, true);
    if (data.status !== "ok") {
      throw new Error(`Nobitex margin markets failed: ${String(data.code ?? "unknown")} - ${String(data.message ?? "")}`);
    }
    const markets = (data.markets ?? {}) as Json;
    return Object.entries(markets).flatMap(([symbol, value]) => {
      if (!value || typeof value !== "object") return [];
      const market = value as Json;
      const base = String(market.srcCurrency ?? "").toUpperCase();
      const quote = normalizeQuote(market.dstCurrency);
      if (!base || !quote) return [];
      return [{
        symbol: symbol.toUpperCase(),
        base,
        quote,
        positionFeeRate: safeDecimal(market.positionFeeRate),
        maxLeverage: safeDecimal(market.maxLeverage),
        sellEnabled: market.sellEnabled === true,
        buyEnabled: market.buyEnabled === true,
        raw: market
      } satisfies MarginMarket];
    });
  }

  async getMarginDelegationLimit(asset: string): Promise<Decimal> {
    const currency = normalizeAsset(asset).toLowerCase();
    const data = await this.request<Json>(
      "GET",
      `/margin/delegation-limit?currency=${encodeURIComponent(currency)}`,
      undefined,
      true
    );
    if (data.status !== "ok") {
      throw new Error(`Nobitex delegation limit failed: ${String(data.code ?? "unknown")} - ${String(data.message ?? "")}`);
    }
    return safeDecimal(data.limit);
  }

  async placeMarginOrder(input: {
    side: "BUY" | "SELL";
    base: string;
    quote: "IRT" | "USDT";
    amountBase: Decimal;
    expectedPrice: Decimal;
    leverage: Decimal;
  }): Promise<NobitexOrder> {
    const body: Json = {
      type: input.side.toLowerCase(),
      execution: "market",
      srcCurrency: normalizeAsset(input.base).toLowerCase(),
      dstCurrency: input.quote === "IRT" ? "rls" : input.quote.toLowerCase(),
      leverage: input.leverage.toString(),
      amount: input.amountBase.toString(),
      price: input.expectedPrice.mul(input.quote === "IRT" ? 10 : 1).toString()
    };
    await assertLiveOwnerForOrder();
    const data = await this.request<Json>("POST", "/margin/orders/add", body, true);
    if (data.status !== "ok") {
      throw new Error(`Margin order rejected: ${String(data.code ?? "unknown")} - ${String(data.message ?? "")}`);
    }
    return parseOrder((data.order ?? data) as Json);
  }

  async listMarginPositions(input: {
    base?: string;
    quote?: "IRT" | "USDT";
    status?: "active" | "past";
  } = {}): Promise<MarginPosition[]> {
    const params = new URLSearchParams();
    if (input.base) params.set("srcCurrency", normalizeAsset(input.base).toLowerCase());
    if (input.quote) params.set("dstCurrency", input.quote === "IRT" ? "rls" : input.quote.toLowerCase());
    if (input.status) params.set("status", input.status);
    const suffix = params.size ? `?${params.toString()}` : "";
    const data = await this.request<Json>("GET", `/positions/list${suffix}`, undefined, true);
    if (data.status !== "ok") {
      throw new Error(`Nobitex positions failed: ${String(data.code ?? "unknown")} - ${String(data.message ?? "")}`);
    }
    return (Array.isArray(data.positions) ? data.positions : []).map(item => parseMarginPosition(item as Json));
  }

  async getMarginPosition(id: string): Promise<MarginPosition> {
    const positionId = positiveIntegerId(id, "position id");
    const data = await this.request<Json>("GET", `/positions/${positionId}/status`, undefined, true);
    if (data.status !== "ok") {
      throw new Error(`Nobitex position status failed: ${String(data.code ?? "unknown")} - ${String(data.message ?? "")}`);
    }
    return parseMarginPosition((data.position ?? {}) as Json);
  }

  async closeMarginPosition(input: {
    positionId: string;
    amountBase: Decimal;
    expectedPrice: Decimal;
    quote: "IRT" | "USDT";
  }): Promise<NobitexOrder> {
    const positionId = positiveIntegerId(input.positionId, "position id");
    await assertLiveOwnerForOrder();
    const data = await this.request<Json>("POST", `/positions/${positionId}/close`, {
      execution: "market",
      amount: input.amountBase.toString(),
      price: input.expectedPrice.mul(input.quote === "IRT" ? 10 : 1).toString()
    }, true);
    if (data.status !== "ok") {
      throw new Error(`Margin close rejected: ${String(data.code ?? "unknown")} - ${String(data.message ?? "")}`);
    }
    return parseOrder((data.order ?? data) as Json);
  }

  async getOrderStatus(id: string) {
    const data = await this.request<Json>("POST", "/market/orders/status", { id: Number(id) }, true);
    if (data.status !== "ok") throw new Error(`Order status failed: ${JSON.stringify(data)}`);
    return parseOrder((data.order ?? {}) as Json);
  }

  /**
   * Nobitex documents clientOrderId lookup for Spot orders as an experimental
   * reconciliation path. It is especially useful when the add-order response
   * times out after the exchange may already have accepted the order.
   */
  async getOrderStatusByClientOrderId(clientOrderId: string) {
    const normalized = clientOrderId.trim();
    if (!normalized || normalized.length > 32) throw new Error("Invalid Nobitex clientOrderId");
    const data = await this.request<Json>("POST", "/market/orders/status", { clientOrderId: normalized }, true);
    if (data.status !== "ok") throw new Error(`Order status by clientOrderId failed: ${JSON.stringify(data)}`);
    const order = parseOrder((data.order ?? {}) as Json);
    if (!order.id) throw new Error("Nobitex clientOrderId lookup returned no exchange order id");
    return order;
  }

  async cancelOrder(id: string) {
    await assertLiveOwnerForOrder();
    const data = await this.request<Json>("POST", "/market/orders/update-status", { order: Number(id), status: "canceled" }, true);
    if (data.status !== "ok") throw new Error(`Order cancellation failed: ${JSON.stringify(data)}`);
  }

  private async request<T>(method: "GET" | "POST", path: string, body: Json | undefined, auth: boolean): Promise<T> {
    const bodyText = body ? JSON.stringify(body) : "";
    const headers = new Headers({ "User-Agent": "TraderBot/NobitexTriArb" });
    if (body) headers.set("content-type", "application/json");
    if (auth) {
      if (!config.NOBITEX_API_KEY || !config.NOBITEX_API_SECRET) throw new Error("Nobitex API credentials are not configured");
      const timestamp = String(Math.floor(Date.now() / 1000));
      headers.set("Nobitex-Key", config.NOBITEX_API_KEY);
      headers.set("Nobitex-Timestamp", timestamp);
      headers.set("Nobitex-Signature", signEd25519Base64(config.NOBITEX_API_SECRET, `${timestamp}${method}${path}${bodyText}`));
    }
    const response = await fetch(`${config.NOBITEX_API_BASE}${path}`, { method, headers, body: bodyText || undefined, cache: "no-store", signal: AbortSignal.timeout(15_000) });
    const text = await response.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = text; }
    if (!response.ok) throw new Error(`Nobitex HTTP ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
    return data as T;
  }
}

function splitSymbol(symbol: string) {
  for (const quote of ["USDT", "IRT"]) {
    if (symbol.endsWith(quote) && symbol.length > quote.length) return { base: symbol.slice(0, -quote.length), quote };
  }
  return undefined;
}

function parseOrder(raw: Json): NobitexOrder {
  const d = (v: unknown) => {
    try { return new Decimal(String(v ?? 0)); } catch { return new Decimal(0); }
  };
  return {
    id: String(raw.id ?? ""), status: String(raw.status ?? "Unknown"), amount: d(raw.amount),
    matchedAmount: d(raw.matchedAmount), unmatchedAmount: d(raw.unmatchedAmount), totalPrice: d(raw.totalPrice),
    averagePrice: d(raw.averagePrice ?? raw.price), fee: d(raw.fee), raw
  };
}

function safeDecimal(value: unknown) {
  try { return new Decimal(String(value ?? 0)); } catch { return new Decimal(0); }
}

function normalizeAsset(value: string) {
  const asset = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,16}$/.test(asset)) throw new Error("Invalid Nobitex asset symbol");
  return asset;
}

function normalizeQuote(value: unknown): "IRT" | "USDT" | undefined {
  const quote = String(value ?? "").toUpperCase();
  if (["RLS", "IRR", "RIAL", "IRT"].includes(quote)) return "IRT";
  if (quote === "USDT") return "USDT";
  return undefined;
}

function positiveIntegerId(value: string, name: string) {
  if (!/^\d+$/.test(value) || value === "0") throw new Error(`Invalid ${name}`);
  return value;
}

function parseMarginPosition(raw: Json): MarginPosition {
  const base = String(raw.srcCurrency ?? "").toUpperCase();
  const quote = normalizeQuote(raw.dstCurrency);
  if (!base || !quote) throw new Error("Nobitex returned an invalid margin position market");
  const quoteDivisor = quote === "IRT" ? 10 : 1;
  const quoteAmount = (value: unknown) => safeDecimal(value).div(quoteDivisor);
  return {
    id: String(raw.id ?? ""),
    base,
    quote,
    side: String(raw.side ?? "sell").toLowerCase() === "buy" ? "BUY" : "SELL",
    status: String(raw.status ?? "Unknown"),
    collateral: quoteAmount(raw.collateral),
    leverage: safeDecimal(raw.leverage),
    entryPrice: quoteAmount(raw.entryPrice),
    exitPrice: quoteAmount(raw.exitPrice),
    delegatedAmount: safeDecimal(raw.delegatedAmount),
    liability: safeDecimal(raw.liability),
    liabilityInOrder: safeDecimal(raw.liabilityInOrder),
    assetInOrder: safeDecimal(raw.assetInOrder),
    marginRatio: safeDecimal(raw.marginRatio),
    unrealizedPnl: quoteAmount(raw.unrealizedPNL),
    realizedPnl: quoteAmount(raw.PNL),
    markPrice: quoteAmount(raw.markPrice),
    liquidationPrice: quoteAmount(raw.liquidationPrice),
    openedAt: raw.openedAt == null ? null : String(raw.openedAt),
    closedAt: raw.closedAt == null ? null : String(raw.closedAt),
    raw
  };
}
