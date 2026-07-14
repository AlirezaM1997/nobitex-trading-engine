import { handleSpotPositionRequest } from "@/lib/strategies/spot-position-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  return handleSpotPositionRequest(request, "orderbook-imbalance");
}
