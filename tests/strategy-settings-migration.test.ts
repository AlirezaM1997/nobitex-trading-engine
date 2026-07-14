import { describe, expect, test } from "bun:test";
import { migrateStoredStrategyLabSettings } from "@/lib/bot-settings-store";
import { strategyLabSettingsSchema } from "@/lib/strategy-settings";

describe("strategy settings migration", () => {
  test("replaces legacy Market Making settings without enabling Gap Trading", () => {
    const migrated = migrateStoredStrategyLabSettings({
      enabled: true,
      marketMaking: {
        enabled: true,
        orderSizeToman: 900_000,
        minVisibleDepthToman: 3_000_000,
        maxGrossSpreadBps: 250,
        adverseSelectionBufferBps: 45
      }
    });
    const parsed = strategyLabSettingsSchema.parse(migrated);
    expect(parsed.gapTrading.enabled).toBe(false);
    expect(parsed.gapTrading.capitalToman).toBe(250_000);
    expect(parsed.gapTrading.minVisibleDepthToman).toBe(3_000_000);
    expect(parsed.gapTrading.maxSpreadBps).toBe(80);
    expect(parsed.gapTrading.safetyBufferBps).toBe(45);
  });

  test("does not overwrite an explicit Gap Trading configuration", () => {
    const source = { gapTrading: { enabled: true, capitalToman: 123_000 }, marketMaking: { enabled: true } };
    expect(migrateStoredStrategyLabSettings(source)).toBe(source);
  });
});
