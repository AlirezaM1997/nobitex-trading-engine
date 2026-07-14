import Decimal from "decimal.js";

export type Side = "BUY" | "SELL";
export type Level = { price: Decimal; amount: Decimal };
export type OrderBook = {
  symbol: string;
  base: string;
  quote: string;
  bids: Level[];
  asks: Level[];
  lastUpdate: number;
};
export type MarketOptions = {
  amountSteps: Record<string, Decimal>;
  priceSteps: Record<string, Decimal>;
  minOrderRial: Decimal;
  minOrderUsdt: Decimal;
};
export type Wallet = { asset: string; available: Decimal; blocked: Decimal };
export type NobitexOrder = {
  id: string;
  status: string;
  amount: Decimal;
  matchedAmount: Decimal;
  unmatchedAmount: Decimal;
  totalPrice: Decimal;
  averagePrice: Decimal;
  fee: Decimal;
  raw: unknown;
};

export type MarginMarket = {
  symbol: string;
  base: string;
  quote: "IRT" | "USDT";
  positionFeeRate: Decimal;
  maxLeverage: Decimal;
  sellEnabled: boolean;
  buyEnabled: boolean;
  raw: unknown;
};

export type MarginPosition = {
  id: string;
  base: string;
  quote: "IRT" | "USDT";
  side: "BUY" | "SELL";
  status: string;
  collateral: Decimal;
  leverage: Decimal;
  entryPrice: Decimal;
  exitPrice: Decimal;
  delegatedAmount: Decimal;
  liability: Decimal;
  liabilityInOrder: Decimal;
  assetInOrder: Decimal;
  marginRatio: Decimal;
  unrealizedPnl: Decimal;
  realizedPnl: Decimal;
  markPrice: Decimal;
  liquidationPrice: Decimal;
  openedAt: string | null;
  closedAt: string | null;
  raw: unknown;
};

export type CandleSeries = {
  symbol: string;
  resolution: string;
  timestamps: number[];
  open: Decimal[];
  high: Decimal[];
  low: Decimal[];
  close: Decimal[];
  volume: Decimal[];
};
