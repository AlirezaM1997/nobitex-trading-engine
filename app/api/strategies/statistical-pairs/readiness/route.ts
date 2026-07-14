import { NextResponse } from "next/server";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const hostname = new URL(config.NOBITEX_API_BASE).hostname.toLowerCase();
  return NextResponse.json({
    strategy: "pairs",
    environment: hostname === "apiv2.nobitex.ir" ? "mainnet" : "unsupported",
    mainnetExecution: {
      ready: hostname === "apiv2.nobitex.ir",
      entryAdapterReady: true,
      twoSidedSemantics: "Spot long + isolated Margin short",
      shortAvailabilityCheckedPerMarketAndAccount: true,
      delegationLimitCheckedBeforeEntry: true,
      hedgeRatioCheckedBeforeAndAfterFills: true,
      exitStopAndMaxHoldingModelled: true,
      positionStatePersisted: true,
      acceptedOrderIdsPersistedBeforePolling: true,
      crashRecoveryRouteReady: true,
      recoveryLeaseWorksWhileDisarmed: true,
      automaticExecutionSupported: true
    },
    continuousMonitor: {
      serverSideDecisionEngineReady: true,
      dashboardTickRequired: false,
      durableSupervisorReady: true,
      supervisor: "Next.js Node instrumentation starts a 5-second risk-reducing supervisor",
      checks: ["fresh rolling OHLC/Z-Score", "beta drift", "mean exit", "stop Z", "maximum holding time", "interrupted request recovery"],
      reason: "The supervisor never opens a position; it only monitors or flattens persisted Mainnet exposure"
    },
    blockers: hostname === "apiv2.nobitex.ir" ? [] : ["official-mainnet-required"],
    routeContract: {
      endpoint: "/api/strategies/statistical-pairs/execute",
      actions: ["enter", "close", "recover", "monitor"],
      recovery: "POST { action: 'recover', executionId } after restart or interrupted request"
    }
  });
}
