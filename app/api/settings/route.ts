import { NextResponse } from "next/server";
import { getBotSettings, saveBotSettings } from "@/lib/bot-settings-store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getBotSettings());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "خطا در خواندن تنظیمات" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    return NextResponse.json(await saveBotSettings(await request.json()));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "خطا در ذخیره تنظیمات" }, { status: 400 });
  }
}

