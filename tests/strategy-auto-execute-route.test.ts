import { beforeEach, describe, expect, test } from "bun:test";
import { POST } from "@/app/api/strategies/auto-execute/route";
import {
  clearStrategyExecutionStore,
  completeStrategyExecution,
  createStrategyExecution,
  transitionStrategyExecution
} from "@/lib/strategy-execution-store";

// Keep this route test completely isolated from the operator's durable live audit log.
process.env.STRATEGY_EXECUTION_DB_PATH = ":memory:";

function dashboardRequest(body: unknown, origin = "http://localhost") {
  return new Request("http://localhost/api/strategies/auto-execute", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "localhost",
      origin,
      "x-strategy-action": "nobitex-dashboard"
    },
    body: JSON.stringify(body)
  });
}

describe("automatic strategy execution route", () => {
  beforeEach(async () => {
    await clearStrategyExecutionStore();
  });

  test("rejects foreign origins and unknown engines", async () => {
    expect((await POST(dashboardRequest({ kind: "stablecoin", signalId: "stablecoin:USDC" }, "https://attacker.example"))).status).toBe(403);
    expect((await POST(dashboardRequest({ kind: "market-making", signalId: "maker:BTCIRT" }))).status).toBe(400);
    // Gap is a supported engine; without a current calibrated signal it is
    // safely rejected by its fresh server-side scan before any order.
    expect((await POST(dashboardRequest({ kind: "orderbook-gap", signalId: "gap:BTCIRT:ask:1" }))).status).toBe(409);
  });

  test("skips a recently completed stable signal before any exchange work", async () => {
    const now = Date.now();
    const record = await createStrategyExecution({
      strategy: "stablecoin",
      signalId: "stablecoin:USDC",
      symbols: ["USDCIRT", "USDTIRT"],
      direction: "LONG",
      detectedAt: now
    });
    await transitionStrategyExecution(record.id, "REVALIDATING", { at: now + 1 });
    await transitionStrategyExecution(record.id, "SUBMITTING", { at: now + 2 });
    await completeStrategyExecution(record.id, { at: now + 3 });

    const response = await POST(dashboardRequest({ kind: "stablecoin", signalId: "stablecoin:USDC" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "skipped",
      reason: "cooldown-active",
      executionId: record.id,
      executionState: "CLOSED"
    });
  });
});
