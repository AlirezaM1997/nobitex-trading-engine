import { NextResponse } from "next/server";
import { z } from "zod";
import { handleSpotPositionRequest, isDashboardStrategyRequest } from "@/lib/strategies/spot-position-route";
import { findRecentStrategyExecution } from "@/lib/strategy-execution-store";
import { getBotSettings } from "@/lib/bot-settings-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const inputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("orderbook-imbalance"), signalId: z.string().trim().regex(/^imbalance:[A-Z0-9_-]+IRT$/i).max(100) }).strict(),
  z.object({ kind: z.literal("orderbook-gap"), signalId: z.string().trim().regex(/^gap:[A-Z0-9_-]+IRT:ask:\d+$/i).max(120) }).strict()
]);

const executionPolicy = {
  "orderbook-imbalance": { storeStrategy: "imbalance" },
  "orderbook-gap": { storeStrategy: "gapTrading" }
} as const;

/**
 * A narrow automatic-execution front door. The browser may nominate only the
 * stable signal identity and engine kind; each underlying route reconstructs
 * settings, prices, capital and direction from a fresh server-side scan.
 */
export async function POST(request: Request) {
  if (!isDashboardStrategyRequest(request)) {
    return NextResponse.json({ error: "Automatic strategy execution is accepted only from this dashboard" }, { status: 403 });
  }

  let input: z.infer<typeof inputSchema>;
  try {
    input = inputSchema.parse(await request.json());
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Body accepts only a supported kind and signalId", issues: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  const policy = executionPolicy[input.kind];
  const settings = await getBotSettings();
  const cooldownMs = input.kind === "orderbook-imbalance"
      ? settings.strategyLab.imbalance.cooldownMs
      : settings.strategyLab.gapTrading.cooldownMs;
  const recent = await findRecentStrategyExecution({
    strategy: policy.storeStrategy,
    signalId: input.signalId,
    since: Date.now() - cooldownMs
  });
  if (recent) {
    return NextResponse.json({
      status: "skipped",
      reason: recent.state === "CLOSED" || recent.state === "FAILED_MANUAL" ? "cooldown-active" : "execution-already-active",
      executionId: recent.id,
      executionState: recent.state,
      retryAfterMs: recent.state === "CLOSED" || recent.state === "FAILED_MANUAL"
        ? Math.max(0, (recent.closedAt ?? recent.updatedAt) + cooldownMs - Date.now())
        : null
    });
  }

  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  const delegated = new Request(request.url, { method: "POST", headers, body: JSON.stringify({ signalId: input.signalId }) });
  return input.kind === "orderbook-imbalance"
      ? handleSpotPositionRequest(delegated, "orderbook-imbalance")
      : handleSpotPositionRequest(delegated, "orderbook-gap");
}
