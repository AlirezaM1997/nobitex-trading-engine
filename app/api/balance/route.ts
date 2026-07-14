import { NextResponse } from "next/server";
import { NobitexClient } from "@/lib/exchanges/nobitex";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const portfolio = await new NobitexClient().getSpotPortfolioSummary();
    return NextResponse.json({
      spotTotalToman: portfolio.totalEstimatedToman.toString(),
      availableToman: portfolio.availableToman.toString(),
      blockedToman: portfolio.blockedToman.toString(),
      fetchedAt: Date.now()
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "خطا در دریافت موجودی" }, { status: 400 });
  }
}
