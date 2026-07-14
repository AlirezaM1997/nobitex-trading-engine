import { describe, expect, test } from "bun:test";
import { handleStrategySupervisor, shouldStartStrategySupervisor } from "@/app/api/strategies/supervise/route";

function request(origin = "http://localhost", body: unknown = {}) {
  return new Request("http://localhost/api/strategies/supervise", {
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

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    isMainnet: () => true,
    listExecutions: async () => ({ summary: {}, records: [] }),
    monitorPairs: async () => Response.json({ status: "idle" }),
    recoverSpot: async () => Response.json({ status: "not-called" }),
    ...overrides
  } as never;
}

describe("durable strategy supervisor", () => {
  test("starts only in a long-running Production Node process and never during build", () => {
    expect(shouldStartStrategySupervisor({ NODE_ENV: "production", NEXT_RUNTIME: "nodejs" })).toBe(true);
    expect(shouldStartStrategySupervisor({ NODE_ENV: "development", NEXT_RUNTIME: "nodejs" })).toBe(false);
    expect(shouldStartStrategySupervisor({ NODE_ENV: "production", NEXT_RUNTIME: "nodejs", NEXT_PHASE: "phase-production-build" })).toBe(false);
  });

  test("rejects foreign origin and stays inactive outside Mainnet", async () => {
    expect((await handleStrategySupervisor(request("https://attacker.example"), dependencies())).status).toBe(403);
    const response = await handleStrategySupervisor(request(), dependencies({ isMainnet: () => false }));
    expect(await response.json()).toEqual({ status: "inactive", reason: "mainnet-required" });
  });

  test("delegates active Spot records to the child route that owns record fencing", async () => {
    let recoveries = 0;
    const response = await handleStrategySupervisor(request(), dependencies({
      listExecutions: async () => ({ records: [{ id: 5, strategy: "stablecoin", signalId: "stablecoin:USDC", state: "HEDGING", updatedAt: 1 }] }),
      recoverSpot: async () => { recoveries += 1; return Response.json({ status: "busy", code: "POSITION_ALREADY_OWNED" }, { status: 409 }); }
    }));
    expect(response.status).toBe(200);
    expect(recoveries).toBe(1);
  });

  test("delegates an orphaned Spot position only to the recovery route", async () => {
    let kind = "";
    let body: unknown;
    const response = await handleStrategySupervisor(request(), dependencies({
      listExecutions: async () => ({ records: [{ id: 7, strategy: "imbalance", signalId: "imbalance:BTCIRT", state: "RECOVERING", updatedAt: 1 }] }),
      recoverSpot: async (child: Request, value: string) => {
        kind = value;
        body = await child.json();
        return Response.json({ status: "recovered", executionId: 7 });
      }
    }));
    expect(response.status).toBe(200);
    expect(kind).toBe("orderbook-imbalance");
    expect(body).toEqual({ signalId: "imbalance:BTCIRT" });
  });

  test("a busy old position does not starve a later orphan", async () => {
    const seen: string[] = [];
    const response = await handleStrategySupervisor(request(), dependencies({
      listExecutions: async () => ({ records: [
        { id: 1, strategy: "stablecoin", signalId: "stablecoin:USDC", state: "HEDGING", updatedAt: 1 },
        { id: 2, strategy: "imbalance", signalId: "imbalance:ETHIRT", state: "RECOVERING", updatedAt: 2 }
      ] }),
      recoverSpot: async (child: Request) => {
        const input = await child.json() as { signalId: string };
        seen.push(input.signalId);
        return input.signalId === "stablecoin:USDC"
          ? Response.json({ status: "busy" }, { status: 409 })
          : Response.json({ status: "recovered" });
      }
    }));
    expect(response.status).toBe(200);
    expect(seen).toEqual(["stablecoin:USDC", "imbalance:ETHIRT"]);
  });
});
