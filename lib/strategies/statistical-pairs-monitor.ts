import Decimal from "decimal.js";
import type { CandleSeries } from "@/lib/exchanges/types";
import type { StatisticalPairsExecutionPlan } from "./statistical-pairs-executor";

export type StatisticalPairsModelSnapshot = {
  checkedAt: number;
  sampleCount: number;
  zScore: Decimal;
  beta: Decimal;
  betaDriftBps: Decimal;
  latestTimestamp: number;
};

export class StatisticalPairsMonitorError extends Error {
  constructor(message: string, public readonly code: "CANDLES_UNAVAILABLE" | "MODEL_INVALID" | "BETA_DRIFT") {
    super(message);
    this.name = "StatisticalPairsMonitorError";
  }
}

export function calculateStatisticalPairsSnapshot(
  plan: StatisticalPairsExecutionPlan,
  seriesA: CandleSeries,
  seriesB: CandleSeries,
  now = Date.now()
): StatisticalPairsModelSnapshot {
  if (seriesA.symbol.toUpperCase() !== `${plan.assetA}IRT` || seriesB.symbol.toUpperCase() !== `${plan.assetB}IRT`) {
    throw new StatisticalPairsMonitorError("Candle markets do not match the persisted pair plan", "CANDLES_UNAVAILABLE");
  }
  const byTimestampB = new Map(seriesB.timestamps.map((timestamp, index) => [timestamp, seriesB.close[index]]));
  const pricesA: Decimal[] = [];
  const pricesB: Decimal[] = [];
  let latestTimestamp = 0;
  for (let index = 0; index < seriesA.timestamps.length; index += 1) {
    const timestamp = seriesA.timestamps[index]!;
    const a = seriesA.close[index];
    const b = byTimestampB.get(timestamp);
    if (!a || !b || a.lte(0) || b.lte(0)) continue;
    pricesA.push(a.ln());
    pricesB.push(b.ln());
    latestTimestamp = Math.max(latestTimestamp, timestamp);
  }
  const count = Math.min(pricesA.length, pricesB.length, plan.config.lookback);
  if (count < 30) throw new StatisticalPairsMonitorError("Fewer than 30 aligned candles are available", "CANDLES_UNAVAILABLE");
  const a = pricesA.slice(-count);
  const b = pricesB.slice(-count);
  const meanA = mean(a);
  const meanB = mean(b);
  const covariance = mean(a.map((value, index) => value.minus(meanA).mul(b[index]!.minus(meanB))));
  const varianceB = mean(b.map(value => value.minus(meanB).pow(2)));
  if (varianceB.lte(0)) throw new StatisticalPairsMonitorError("Pair model variance is zero", "MODEL_INVALID");
  const beta = covariance.div(varianceB);
  if (!beta.isFinite() || beta.lte(0)) throw new StatisticalPairsMonitorError("Pair model produced an invalid hedge beta", "MODEL_INVALID");
  const spread = a.map((value, index) => value.minus(beta.mul(b[index]!)));
  const spreadMean = mean(spread);
  const standardDeviation = mean(spread.map(value => value.minus(spreadMean).pow(2))).sqrt();
  if (!standardDeviation.isFinite() || standardDeviation.lte(0)) {
    throw new StatisticalPairsMonitorError("Pair spread standard deviation is zero", "MODEL_INVALID");
  }
  const zScore = spread.at(-1)!.minus(spreadMean).div(standardDeviation);
  const betaDriftBps = beta.div(plan.beta).minus(1).abs().mul(10_000);
  if (!zScore.isFinite() || !betaDriftBps.isFinite()) throw new StatisticalPairsMonitorError("Pair model produced a non-finite value", "MODEL_INVALID");
  return { checkedAt: now, sampleCount: count, zScore, beta, betaDriftBps, latestTimestamp };
}

function mean(values: Decimal[]) {
  if (!values.length) throw new StatisticalPairsMonitorError("Pair model received no values", "MODEL_INVALID");
  return values.reduce((sum, value) => sum.plus(value), new Decimal(0)).div(values.length);
}
