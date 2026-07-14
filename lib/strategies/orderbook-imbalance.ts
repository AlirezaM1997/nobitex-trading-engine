import Decimal from "decimal.js";
import type { OrderBook } from "@/lib/exchanges/types";

const BPS = new Decimal(10_000);

export type OrderbookImbalanceMeasurement = {
  bidDepthToman: Decimal;
  askDepthToman: Decimal;
  weightedBidDepthToman: Decimal;
  weightedAskDepthToman: Decimal;
  bidHeavy: boolean;
  ratio: Decimal;
  normalized: Decimal;
  midpoint: Decimal;
  microprice: Decimal;
  micropriceBiasBps: Decimal;
  dominantTopLevelSharePercent: Decimal;
};

/**
 * Multi-level normalized imbalance with exponentially decaying weights. Near
 * levels influence the signal most, while deeper executable liquidity still
 * contributes. Raw depth remains available for the minimum-liquidity gate.
 */
export function measureOrderbookImbalance(
  book: OrderBook,
  levels: number,
  levelWeightDecayPercent: Decimal.Value,
  quoteToToman: Decimal.Value = 1
): OrderbookImbalanceMeasurement {
  const safeLevels = Math.max(1, Math.floor(levels));
  const decay = new Decimal(levelWeightDecayPercent).div(100);
  const conversion = new Decimal(quoteToToman);
  if (decay.lte(0) || decay.gt(1) || conversion.lte(0)) throw new Error("Invalid imbalance measurement parameters");
  const bids = book.bids.filter(level => level.price.gt(0) && level.amount.gt(0)).slice(0, safeLevels);
  const asks = book.asks.filter(level => level.price.gt(0) && level.amount.gt(0)).slice(0, safeLevels);
  if (!bids.length || !asks.length) throw new Error("Orderbook depth is empty");

  const side = (rows: typeof bids) => rows.reduce((result, level, index) => {
    const value = level.price.mul(level.amount).mul(conversion);
    return {
      raw: result.raw.plus(value),
      weighted: result.weighted.plus(value.mul(decay.pow(index)))
    };
  }, { raw: new Decimal(0), weighted: new Decimal(0) });
  const bid = side(bids);
  const ask = side(asks);
  if (bid.raw.lte(0) || ask.raw.lte(0) || bid.weighted.lte(0) || ask.weighted.lte(0)) throw new Error("Orderbook depth is empty");

  const bidHeavy = bid.weighted.gt(ask.weighted);
  const dominantRows = bidHeavy ? bids : asks;
  const dominantRaw = bidHeavy ? bid.raw : ask.raw;
  const topValue = dominantRows[0].price.mul(dominantRows[0].amount).mul(conversion);
  const bestBid = bids[0];
  const bestAsk = asks[0];
  const midpoint = bestBid.price.plus(bestAsk.price).div(2);
  const topAmount = bestBid.amount.plus(bestAsk.amount);
  const microprice = topAmount.gt(0)
    ? bestAsk.price.mul(bestBid.amount).plus(bestBid.price.mul(bestAsk.amount)).div(topAmount)
    : midpoint;
  return {
    bidDepthToman: bid.raw,
    askDepthToman: ask.raw,
    weightedBidDepthToman: bid.weighted,
    weightedAskDepthToman: ask.weighted,
    bidHeavy,
    ratio: Decimal.max(bid.weighted, ask.weighted).div(Decimal.min(bid.weighted, ask.weighted)),
    normalized: bid.weighted.minus(ask.weighted).div(bid.weighted.plus(ask.weighted)),
    midpoint,
    microprice,
    micropriceBiasBps: microprice.div(midpoint).minus(1).mul(BPS),
    dominantTopLevelSharePercent: topValue.div(dominantRaw).mul(100)
  };
}
