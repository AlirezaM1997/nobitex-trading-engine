"use client";

import { Activity, BarChart3, CircleDollarSign, Gauge, Radio, Scale, ShieldAlert, SlidersHorizontal, Waves } from "lucide-react";
import type { StrategyLabSettings } from "@/lib/strategy-settings";

export type SerializedStrategySignal = {
  id: string;
  kind: "cross-quote" | "statistical-pairs" | "stablecoin" | "orderbook-gap" | "orderbook-imbalance";
  title: string;
  symbols: string[];
  action: string;
  status: "actionable" | "watch" | "blocked";
  paperOnly: true;
  expectedEdgeBps: string;
  estimatedNetProfitToman: string;
  confidence: string;
  reasons: string[];
  metrics: Record<string, string | number | boolean>;
  scannedAt: number;
};

export type StrategyLabResult = {
  scannedAt: number;
  signals: SerializedStrategySignal[];
  actionableCount: number;
  watchCount: number;
  enabledCount: number;
  diagnostics: Record<string, string | number | boolean>;
};

type Props = {
  settings: StrategyLabSettings;
  result?: StrategyLabResult;
  onChange: (settings: StrategyLabSettings) => void;
  saving?: boolean;
  saved?: boolean;
  only?: StrategyWorkspaceKey;
};

export type StrategyWorkspaceKey = "crossQuote" | "pairs" | "stablecoin" | "gapTrading" | "imbalance";

const fa = (value: string | number, digits = 0) => new Intl.NumberFormat("fa-IR", { maximumFractionDigits: digits }).format(Number(value));
const en = (value: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 }).format(value);
const labels = {
  "cross-quote": "Cross-Quote",
  "statistical-pairs": "Pairs Trading",
  stablecoin: "Stablecoin Convergence",
  "orderbook-gap": "Orderbook Gap",
  "orderbook-imbalance": "Orderbook Imbalance"
} as const;

function metricNumber(signal: SerializedStrategySignal, ...keys: string[]) {
  for (const key of keys) {
    const value = Number(signal.metrics[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function signalMetric(signal: SerializedStrategySignal) {
  if (signal.kind === "statistical-pairs") return {
    label: "Z-Score",
    value: fa(signal.metrics.zScore as number, 3),
    note: "سود از این snapshot قابل برآورد قطعی نیست",
    directional: false
  };
  if (signal.kind === "orderbook-imbalance") return {
    label: "Depth Ratio",
    value: `${fa(signal.metrics.ratio as number, 2)}×`,
    note: "سود از این snapshot قابل برآورد قطعی نیست",
    directional: false
  };
  if (signal.kind === "orderbook-gap") {
    const gap = metricNumber(signal, "gapBps");
    const robustZ = metricNumber(signal, "robustGapZScore", "gapZScore", "robustZScore", "robustZ");
    const persistence = metricNumber(signal, "persistenceMs");
    const preGapConsumption = metricNumber(signal, "plannedPreGapConsumptionPercent", "preGapConsumptionPercent");
    const projectedNet = metricNumber(signal, "projectedNetBps", "projectedNetEdgeBps", "netEdgeBps") ?? Number(signal.expectedEdgeBps);
    return {
      label: "Gap / Robust Z",
      value: `${gap === null ? "—" : fa(gap, 2)} BPS${robustZ === null ? "" : ` · Z ${fa(robustZ, 2)}`}`,
      note: `ماندگاری ${persistence === null ? "—" : `${fa(persistence)} ms`} · مصرف پیش از Gap ${preGapConsumption === null ? "—" : `${fa(preGapConsumption, 1)}٪`} · خالص مدل ${fa(projectedNet, 2)} BPS`,
      directional: true
    };
  }
  return {
    label: "Net Edge",
    value: `${fa(signal.expectedEdgeBps, 2)} BPS`,
    note: `سود تخمینی ${fa(signal.estimatedNetProfitToman)} تومان`,
    directional: true
  };
}

function signalStateLabel(signal: SerializedStrategySignal) {
  if (signal.kind === "orderbook-gap" && signal.status === "watch" && signal.metrics.analyticalSetupPassed === true) return "Setup سایه معتبر";
  if (signal.status === "actionable") return "آماده بررسی Paper";
  if (signal.status === "blocked") return "ردشده";
  return "زیر نظر";
}

export default function StrategyCenter({ settings, result, onChange, saving, saved, only }: Props) {
  const update = <K extends keyof StrategyLabSettings>(key: K, value: StrategyLabSettings[K]) => onChange({ ...settings, [key]: value });
  const updateSection = <K extends Exclude<keyof StrategyLabSettings, "enabled">>(section: K, patch: Partial<StrategyLabSettings[K]>) => {
    update(section, { ...settings[section], ...patch } as StrategyLabSettings[K]);
  };
  const grouped = (kind: SerializedStrategySignal["kind"]) => result?.signals.filter(signal => signal.kind === kind) ?? [];
  const best = (kind: SerializedStrategySignal["kind"]) => grouped(kind).sort((a, b) => Number(b.expectedEdgeBps) - Number(a.expectedEdgeBps))[0];
  const gapSetups = grouped("orderbook-gap").filter(signal => signal.status === "watch" && signal.metrics.analyticalSetupPassed === true);
  const bestGapSetup = [...gapSetups].sort((a, b) => Number(b.expectedEdgeBps) - Number(a.expectedEdgeBps))[0];
  const onlyKind = only && ({ crossQuote: "cross-quote", pairs: "statistical-pairs", stablecoin: "stablecoin", gapTrading: "orderbook-gap", imbalance: "orderbook-imbalance" } as const)[only];
  const visibleSignals = result?.signals.filter(signal => !onlyKind || signal.kind === onlyKind) ?? [];

  return <section className={`strategy-center ${only ? `only-${only}` : ""}`} aria-labelledby="strategy-center-title">
    <div className="strategy-hero panel">
      <div><span className="eyebrow">{only ? "STRATEGY SETTINGS" : "MULTI-STRATEGY RESEARCH DESK"}</span><h2 id="strategy-center-title"><SlidersHorizontal/> {only ? "تنظیمات و سیگنال‌ها" : "مرکز استراتژی‌ها"}</h2><small className="strategy-save">{saving ? "در حال ذخیره تنظیمات…" : saved ? "تمام تغییرات ذخیره شد" : ""}</small></div>
      {!only && <div className="strategy-master"><span className={settings.enabled ? "status-dot online" : "status-dot"}/><div><b>{settings.enabled ? "اسکن Paper همه موتورها روشن" : "اسکن Paper همه موتورها متوقف"}</b><small>{result ? `${fa(result.enabledCount)} موتور · ${fa(result.actionableCount)} سیگنال آماده بررسی` : "در انتظار اولین اسکن"}</small></div><button type="button" className={`mini-toggle ${settings.enabled ? "on" : ""}`} onClick={() => update("enabled", !settings.enabled)} aria-pressed={settings.enabled}>{settings.enabled ? "توقف همه اسکن‌های Paper" : "شروع همه اسکن‌های Paper"}</button></div>}
    </div>

    <div className="strategy-grid">
      <StrategyCard anchor="strategy-cross-quote" icon={Scale} tone="blue" title="آربیتراژ موجودی دو بازار" english="Cross-Quote Inventory" family="Inventory Arbitrage" enabled={settings.crossQuote.enabled} onToggle={() => updateSection("crossQuote", { enabled: !settings.crossQuote.enabled })} count={grouped("cross-quote").length} best={best("cross-quote")} risks={["FX Exposure", "Inventory", "2 Orders"]}>
        <SettingsBand tone="paper" title="اسکن و شبیه‌سازی Paper" description="این مقادیر سیگنال و اندازه‌گذاری را کنترل می‌کنند؛ مجوز Live جداگانه در Risk Center است."/>
        <NumberField label="سرمایه محاسباتی" english="Paper Capital" unit="تومان" value={settings.crossQuote.capitalToman} help="افزایش آن مصرف عمق و ریسک Inventory را بیشتر می‌کند." onChange={capitalToman => updateSection("crossQuote", { capitalToman })}/>
        <NumberField label="حداقل برتری" english="Minimum Edge" unit="BPS" value={settings.crossQuote.minEdgeBps} help="بیشتر: سیگنال کمتر و محافظه‌کارانه‌تر؛ کمتر: فرصت بیشتر با حاشیه خطای کمتر." onChange={minEdgeBps => updateSection("crossQuote", { minEdgeBps })}/>
        <NumberField label="حداکثر اسپرد" english="Max Spread" unit="BPS" value={settings.crossQuote.maxSpreadBps} help="کمترکردن، بازارهای پرهزینه و کم‌عمق را سخت‌گیرانه‌تر حذف می‌کند." onChange={maxSpreadBps => updateSection("crossQuote", { maxSpreadBps })}/>
        <NumberField label="عمق قابل اتکا" english="Usable Depth" unit="٪" value={settings.crossQuote.depthUsagePercent} help="درصد بالاتر به حجم نمایشی بیشتری اعتماد می‌کند و ریسک لغزش را بالا می‌برد." onChange={depthUsagePercent => updateSection("crossQuote", { depthUsagePercent })}/>
      </StrategyCard>

      <StrategyCard anchor="strategy-pairs" icon={BarChart3} tone="violet" title="معامله جفت آماری" english="Statistical Pairs" family="Relative Value" enabled={settings.pairs.enabled} onToggle={() => updateSection("pairs", { enabled: !settings.pairs.enabled })} count={grouped("statistical-pairs").length} best={best("statistical-pairs")} primaryLabel="Z-Score" primaryValue={best("statistical-pairs") ? fa(best("statistical-pairs")!.metrics.zScore as number, 3) : "—"} risks={["Model Drift", "Margin", "Liquidation"]}>
        <SettingsBand tone="paper" title="مدل و سیگنال Paper" description="انتخاب جفت، پنجره آماری و آستانه‌های تشخیص؛ این کلیدها سفارشی ارسال نمی‌کنند."/>
        <TextField label="دارایی A" value={settings.pairs.assetA} help="نماد دارایی اول مدل؛ هر دو دارایی باید بازار IRT و داده OHLC معتبر داشته باشند." onChange={assetA => updateSection("pairs", { assetA: assetA.toUpperCase() })}/>
        <TextField label="دارایی B" value={settings.pairs.assetB} help="نماد دارایی دوم؛ موتور فقط وقتی اجرا می‌شود که ضلع Short در بازار تعهدی نیز مجاز باشد." onChange={assetB => updateSection("pairs", { assetB: assetB.toUpperCase() })}/>
        <SelectField label="تایم‌فریم OHLC" value={settings.pairs.resolution} options={["15", "30", "60", "240", "D"]} help="تایم‌فریم کوتاه‌تر سیگنال سریع‌تر و پرنویزتر؛ بلندتر سیگنال کندتر و پایدارتر می‌دهد." onChange={resolution => updateSection("pairs", { resolution: resolution as StrategyLabSettings["pairs"]["resolution"] })}/>
        <NumberField label="Lookback" english="Samples" unit="کندل" value={settings.pairs.lookback} help="پنجره بزرگ‌تر مدل را آرام‌تر و پایدارتر، ولی واکنش آن به تغییر رژیم را کندتر می‌کند." onChange={lookback => updateSection("pairs", { lookback })}/>
        <NumberField label="آستانه ورود" english="Entry Z-Score" unit="Z" value={settings.pairs.entryZScore} help="بالاتر: انحراف نادرتر و سیگنال کمتر؛ پایین‌تر: ورود بیشتر با احتمال نویز بالاتر." onChange={entryZScore => updateSection("pairs", { entryZScore })}/>
        <NumberField label="آستانه خروج" english="Exit Z-Score" unit="Z" value={settings.pairs.exitZScore} help="کوچک‌تر منتظر همگرایی کامل‌تر می‌ماند و زمان بازبودن پوزیشن را زیاد می‌کند." onChange={exitZScore => updateSection("pairs", { exitZScore })}/>
        <NumberField label="توقف مدل" english="Stop Z-Score" unit="Z" value={settings.pairs.maxZScore} help="عبور از این مقدار شکست فرض Mean Reversion تلقی و خروج حفاظتی آغاز می‌شود." onChange={maxZScore => updateSection("pairs", { maxZScore })}/>
        <NumberField label="ارزش اسمی پوزیشن" english="Position Notional" unit="تومان" value={settings.pairs.notionalToman} help="اندازه مجموع Long/Short است؛ افزایش آن اثر قیمت، نیاز مارجین و زیان بالقوه را زیاد می‌کند." onChange={notionalToman => updateSection("pairs", { notionalToman })}/>
        <SettingsBand tone="live" title="حدود اجرای واقعی" description="این حدود در سفارش واقعی Spot/Margin، مانیتور و Recovery روی حساب اصلی اعمال می‌شوند؛ کنترل ریسک نیز مستقل است."/>
        <NumberField label="اهرم" english="Leverage" unit="×" value={settings.pairs.leverage} help="اهرم بالاتر سود و زیان و خطر لیکوییدیشن را هم‌زمان زیاد می‌کند." onChange={leverage => updateSection("pairs", { leverage })}/>
        <NumberField label="تلورانس هج" english="Hedge Tolerance" unit="BPS" value={settings.pairs.hedgeToleranceBps} help="کمتر: تطابق دو ضلع دقیق‌تر؛ بیشتر: Fill آسان‌تر ولی ریسک جهت‌دار بیشتر." onChange={hedgeToleranceBps => updateSection("pairs", { hedgeToleranceBps })}/>
        <NumberField label="حداکثر تغییر نسبت هج" english="Max Beta Drift" unit="BPS" value={settings.pairs.maxBetaDriftBps} help="کمتر: توقف سریع‌تر هنگام Drift نسبت هج؛ بیشتر: تحمل مدل بالاتر و ریسک بیشتر." onChange={maxBetaDriftBps => updateSection("pairs", { maxBetaDriftBps })}/>
        <NumberField label="حداقل نسبت مارجین" english="Minimum Margin Ratio" unit="×" value={settings.pairs.minMarginRatio} help="بالاتر: فاصله دفاعی بیشتر از لیکوییدیشن و خروج زودتر؛ پایین‌تر: تحمل نوسان بیشتر با ریسک لیکوییدیشن بالاتر." onChange={minMarginRatio => updateSection("pairs", { minMarginRatio })}/>
        <NumberField label="حداقل فاصله تا لیکوییدیشن" english="Liquidation Buffer" unit="BPS" value={settings.pairs.minLiquidationBufferBps} help="بالاتر: مانیتور زودتر Position را می‌بندد؛ پایین‌تر: سرمایه مدت بیشتری باز می‌ماند اما حاشیه ایمنی کمتر می‌شود." onChange={minLiquidationBufferBps => updateSection("pairs", { minLiquidationBufferBps })}/>
        <NumberField label="وقفه ورود مجدد" english="Execution Cooldown" unit="ms" value={settings.pairs.cooldownMs} help="بیشتر: از ورود دوباره سریع پس از خروج/خطا جلوگیری می‌کند؛ کمتر: واکنش سریع‌تر با ریسک تکرار یک رژیم نامعتبر." onChange={cooldownMs => updateSection("pairs", { cooldownMs })}/>
        <NumberField label="حداکثر اسپرد ورود" english="Max Entry Spread" unit="BPS" value={settings.pairs.maxEntrySpreadBps} help="سقف پایین‌تر ورود در بازار پرهزینه را متوقف می‌کند." onChange={maxEntrySpreadBps => updateSection("pairs", { maxEntrySpreadBps })}/>
        <NumberField label="حداکثر اثر قیمت" english="Max Price Impact" unit="BPS" value={settings.pairs.maxPriceImpactBps} help="کمتر: حجم محافظه‌کارانه‌تر و احتمال لغزش کمتر." onChange={maxPriceImpactBps => updateSection("pairs", { maxPriceImpactBps })}/>
        <NumberField label="سهم اعتبارسنجی" english="Holdout Validation" unit="٪" value={settings.pairs.validationPercent} help="بخش انتهایی داده که در برازش استفاده نمی‌شود. افزایش آن آزمون خارج از نمونه را سخت‌گیرانه‌تر، اما داده آموزش را کمتر می‌کند." onChange={validationPercent => updateSection("pairs", { validationPercent })}/>
        <NumberField label="حداقل همبستگی" english="Minimum Correlation" unit="ρ" value={settings.pairs.minCorrelation} help="مقدار بالاتر فقط جفت‌های هم‌رفتارتر را نگه می‌دارد؛ همبستگی به‌تنهایی Cointegration را ثابت نمی‌کند." onChange={minCorrelation => updateSection("pairs", { minCorrelation })}/>
        <NumberField label="حداکثر نیمه‌عمر" english="Maximum Half-Life" unit="کندل" value={settings.pairs.maxHalfLifeBars} help="نیمه‌عمر بزرگ‌تر یعنی همگرایی کندتر و خواب سرمایه بیشتر. کم‌کردن آن مدل‌های کند را حذف می‌کند." onChange={maxHalfLifeBars => updateSection("pairs", { maxHalfLifeBars })}/>
        <NumberField label="حد بحرانی ADF" english="ADF Critical Value" unit="t" value={settings.pairs.adfCriticalValue} help="باید منفی باشد؛ عدد منفی‌تر آزمون ایستایی را سخت‌گیرانه‌تر می‌کند." onChange={adfCriticalValue => updateSection("pairs", { adfCriticalValue })}/>
        <NumberField label="حداکثر Drift خارج نمونه" english="Holdout Drift" unit="Z" value={settings.pairs.maxValidationDriftZ} help="کمترکردن آن تغییر رژیم بین آموزش و داده جدید را زودتر رد می‌کند." onChange={maxValidationDriftZ => updateSection("pairs", { maxValidationDriftZ })}/>
        <NumberField label="هزینه رفت‌وبرگشت برآوردی" english="Round-Trip Cost" unit="BPS" value={settings.pairs.estimatedRoundTripCostBps} help="کارمزد، اسپرد، لغزش و هزینه دو ضلع را محافظه‌کارانه جمع می‌کند؛ کمترکردن بی‌دلیل سود کاذب می‌سازد." onChange={estimatedRoundTripCostBps => updateSection("pairs", { estimatedRoundTripCostBps })}/>
        <NumberField label="حداقل بازده خالص مدل" english="Minimum Expected Net" unit="BPS" value={settings.pairs.minExpectedNetBps} help="پس از کسر هزینه رفت‌وبرگشت اعمال می‌شود. بالاتر: سیگنال کمتر با حاشیه مدل بیشتر." onChange={minExpectedNetBps => updateSection("pairs", { minExpectedNetBps })}/>
        <NumberField label="حداکثر زمان نگهداری" english="Max Holding Time" unit="دقیقه" value={settings.pairs.maxHoldingMinutes} help="پس از این زمان مدل باید پوزیشن را ببندد؛ زمان بیشتر ریسک Model Drift را زیاد می‌کند." onChange={maxHoldingMinutes => updateSection("pairs", { maxHoldingMinutes })}/>
        <NumberField label="مهلت سفارش" english="Order Timeout" unit="ms" value={settings.pairs.orderTimeoutMs} help="زمان بیشتر شانس Fill و هم‌زمان ریسک بازماندن یک ضلع را افزایش می‌دهد." onChange={orderTimeoutMs => updateSection("pairs", { orderTimeoutMs })}/>
      </StrategyCard>

      <StrategyCard anchor="strategy-stablecoin" icon={CircleDollarSign} tone="violet" title="همگرایی استیبل‌کوین" english="Stablecoin Convergence" family="Convergence" enabled={settings.stablecoin.enabled} onToggle={() => updateSection("stablecoin", { enabled: !settings.stablecoin.enabled })} count={grouped("stablecoin").length} best={best("stablecoin")} risks={["Depeg", "Issuer", "Short Availability"]}>
        <SettingsBand tone="paper" title="تشخیص انحراف در Paper" description="دارایی‌ها و شرط تشخیص فرصت؛ فعال‌کردن این بخش فقط اسکن را روشن می‌کند."/>
        <TextField label="دارایی‌ها" value={settings.stablecoin.assets} help="نمادها را با کاما جدا کنید؛ فقط دارایی دارای بازار Spot IRT و مسیر Long قابل اجرا وارد سفارش می‌شود." onChange={assets => updateSection("stablecoin", { assets })}/>
        <NumberField label="حداقل انحراف ورود" english="Entry Deviation" unit="BPS" value={settings.stablecoin.minDeviationBps} help="بیشتر: فقط انحراف‌های بزرگ‌تر؛ کمتر: سیگنال بیشتر با حاشیه ضعیف‌تر." onChange={minDeviationBps => updateSection("stablecoin", { minDeviationBps })}/>
        <NumberField label="انحراف خروج" english="Exit Deviation" unit="BPS" value={settings.stablecoin.exitDeviationBps} help="مقدار کمتر منتظر همگرایی کامل‌تر می‌ماند و زمان نگهداری را زیاد می‌کند." onChange={exitDeviationBps => updateSection("stablecoin", { exitDeviationBps })}/>
        <NumberField label="سرمایه هر پوزیشن" english="Position Capital" unit="تومان" value={settings.stablecoin.capitalToman} help="هم در Paper و هم در اجرای واقعی Mainnet مبنای اندازه‌گذاری است؛ افزایش آن اثر قیمت و زیان بالقوه را زیاد می‌کند." onChange={capitalToman => updateSection("stablecoin", { capitalToman })}/>
        <SettingsBand tone="live" title="ورود، خروج و Recovery واقعی" description="این حدود در سفارش واقعی، Position State، خروج و Recovery روی حساب اصلی اعمال می‌شوند."/>
        <NumberField label="حداکثر اسپرد" english="Max Spread" unit="BPS" value={settings.stablecoin.maxSpreadBps} help="سقف کمتر از ورود در بازارهای پرهزینه جلوگیری می‌کند." onChange={maxSpreadBps => updateSection("stablecoin", { maxSpreadBps })}/>
        <NumberField label="حداکثر اثر قیمت" english="Max Price Impact" unit="BPS" value={settings.stablecoin.maxPriceImpactBps} help="کمتر: اجرای کوچک‌تر و محافظه‌کارانه‌تر." onChange={maxPriceImpactBps => updateSection("stablecoin", { maxPriceImpactBps })}/>
        <NumberField label="سهم مجاز از عمق" english="Usable Depth" unit="٪" value={settings.stablecoin.depthUsagePercent} help="بالاتر به عمق نمایشی بیشتری اتکا می‌کند و لغزش بالقوه را زیاد می‌کند." onChange={depthUsagePercent => updateSection("stablecoin", { depthUsagePercent })}/>
        <NumberField label="حد سود" english="Take Profit" unit="BPS" value={settings.stablecoin.takeProfitBps} help="بالاتر سود هدف را زیاد می‌کند اما احتمال رسیدن به خروج کمتر می‌شود." onChange={takeProfitBps => updateSection("stablecoin", { takeProfitBps })}/>
        <NumberField label="حد ضرر" english="Stop Loss" unit="BPS" value={settings.stablecoin.stopLossBps} help="عدد بزرگ‌تر فضای حرکت و زیان احتمالی بیشتری می‌دهد." onChange={stopLossBps => updateSection("stablecoin", { stopLossBps })}/>
        <NumberField label="حداکثر زیان معامله" english="Max Loss" unit="تومان" value={settings.stablecoin.maxLossToman} help="Circuit Breaker محلی این پوزیشن؛ کمترکردن آن خروج زیان را سریع‌تر می‌کند." onChange={maxLossToman => updateSection("stablecoin", { maxLossToman })}/>
        <NumberField label="حداکثر باقیمانده دارایی" english="Max Residual Value" unit="تومان" value={settings.stablecoin.maxResidualToman} help="اگر ارزش Dust احتمالی پس از کارمزد و گردکردن از این عدد بیشتر باشد، معامله پیش از خرید رد می‌شود." onChange={maxResidualToman => updateSection("stablecoin", { maxResidualToman })}/>
        <NumberField label="حداکثر زمان نگهداری" english="Max Hold" unit="ms" value={settings.stablecoin.maxHoldMs} help="پس از این زمان خروج اجباری شروع می‌شود." onChange={maxHoldMs => updateSection("stablecoin", { maxHoldMs })}/>
        <NumberField label="فاصله پایش" english="Poll Interval" unit="ms" value={settings.stablecoin.pollIntervalMs} help="کمتر: واکنش سریع‌تر و بار API بیشتر." onChange={pollIntervalMs => updateSection("stablecoin", { pollIntervalMs })}/>
        <NumberField label="وقفه ورود مجدد" english="Execution Cooldown" unit="ms" value={settings.stablecoin.cooldownMs} help="بیشتر: از خرید مکرر همان Depeg جلوگیری می‌کند؛ کمتر: فرصت بیشتر با ریسک Overtrading." onChange={cooldownMs => updateSection("stablecoin", { cooldownMs })}/>
        <NumberField label="رزرو سفارش" english="Order Reserve" unit="BPS" value={settings.stablecoin.orderReserveBps} help="بافر قیمت سفارش؛ بیشتر، Fill را آسان‌تر ولی قیمت اجرا را بدتر می‌کند." onChange={orderReserveBps => updateSection("stablecoin", { orderReserveBps })}/>
        <NumberField label="اسپرد مجاز Recovery" english="Recovery Max Spread" unit="BPS" value={settings.stablecoin.recoveryMaxSpreadBps} help="سقف اضطراری است؛ افزایش آن خروج را ممکن‌تر ولی پرهزینه‌تر می‌کند." onChange={recoveryMaxSpreadBps => updateSection("stablecoin", { recoveryMaxSpreadBps })}/>
        <NumberField label="اثر قیمت Recovery" english="Recovery Max Impact" unit="BPS" value={settings.stablecoin.recoveryMaxPriceImpactBps} help="سقف اثر قیمت در بستن اضطراری پوزیشن." onChange={recoveryMaxPriceImpactBps => updateSection("stablecoin", { recoveryMaxPriceImpactBps })}/>
        <NumberField label="لغزش Recovery" english="Recovery Slippage" unit="BPS" value={settings.stablecoin.recoverySlippageBps} help="بالاتر احتمال خروج اضطراری را زیاد و کیفیت قیمت را ضعیف‌تر می‌کند." onChange={recoverySlippageBps => updateSection("stablecoin", { recoverySlippageBps })}/>
      </StrategyCard>

      <StrategyCard anchor="strategy-orderbook-gap" icon={Gauge} tone="amber" title="شکاف نقدشوندگی اردربوک" english="Orderbook Gap / Liquidity Vacuum" family="Market Microstructure" enabled={settings.gapTrading.enabled} onToggle={() => updateSection("gapTrading", { enabled: !settings.gapTrading.enabled })} count={gapSetups.length} best={bestGapSetup} primaryLabel="بزرگ‌ترین Gap معتبر" primaryValue={bestGapSetup ? `${fa(bestGapSetup.metrics.gapBps as number, 2)} BPS` : "—"} risks={["False Gap", "Ephemeral Liquidity", "Feed Latency"]}>
        <div className="gap-venue-grid">
          <div className="gap-venue available"><span>SPOT ORDERBOOK</span><b>تحلیل سایه فعال</b><p>اردربوک رسمی Spot پایش می‌شود، اما این موتور فعلاً فقط سیگنال می‌سازد و هیچ سفارش واقعی نمی‌فرستد.</p></div>
          <div className="gap-venue unavailable"><span>OTC / EASY</span><b>داده قابل اتکا در دسترس نیست</b><p>OTC اردربوک عمومی و API رسمی پشتیبانی‌شده برای Quote/Execution ندارد؛ بنابراین Gap واقعی آن قابل سنجش یا اجرای امن نیست.</p></div>
        </div>
        <SettingsBand tone="paper" title="تشخیص شکاف و آزمون سایه" description="Gap به‌تنهایی فرصت سود نیست. موتور باید بزرگی غیرعادی شکاف، دوام آن، فشار Bid، Microprice، عمق و هزینه رفت‌وبرگشت را هم‌زمان تأیید کند."/>

        <StrategySettingGroup title="ساختار شکاف" english="GAP STRUCTURE" description="تعریف می‌کند کدام فاصله بین سطوح قیمت واقعاً غیرعادی محسوب شود.">
          <NumberField label="تعداد سطوح نزدیک" english="Active Levels" unit="سطح" value={settings.gapTrading.levels} help="بیشتر: شکاف‌های دورتر هم دیده می‌شوند، اما ارتباطشان با حرکت فوری قیمت ضعیف‌تر است." onChange={levels => updateSection("gapTrading", { levels })}/>
          <NumberField label="سطوح خط مبنا" english="Baseline Levels" unit="سطح" value={settings.gapTrading.baselineLevels} help="برای Median/MAD شکاف‌های همان اردربوک است. خیلی کم، Z-Score را ناپایدار می‌کند؛ خیلی زیاد، رژیم نزدیک قیمت را کمرنگ می‌کند." onChange={baselineLevels => updateSection("gapTrading", { baselineLevels })}/>
          <NumberField label="حداقل اندازه شکاف" english="Minimum Gap" unit="BPS" value={settings.gapTrading.minGapBps} help="افزایش آن سیگنال‌های کوچک و پرهزینه را حذف می‌کند؛ کاهش آن تعداد سیگنال و احتمال نویز را بالا می‌برد." onChange={minGapBps => updateSection("gapTrading", { minGapBps })}/>
          <NumberField label="حداقل امتیاز مقاوم" english="Robust Z-Score" unit="Z" value={settings.gapTrading.minGapZScore} help="شکاف را نسبت به Median/MAD همان کتاب می‌سنجد. مقدار بالاتر فقط ناهنجاری‌های آماری قوی‌تر را نگه می‌دارد." onChange={minGapZScore => updateSection("gapTrading", { minGapZScore })}/>
          <NumberField label="نسبت به شکاف معمول" english="Gap / Median Ratio" unit="×" value={settings.gapTrading.minGapRatio} help="مثلاً ۴ یعنی Gap باید دست‌کم چهار برابر فاصله معمول سطوح باشد؛ افزایش آن سیگنال کمتر و انتخابی‌تر می‌دهد." onChange={minGapRatio => updateSection("gapTrading", { minGapRatio })}/>
          <NumberField label="وزن سطوح دورتر" english="Level Weight Decay" unit="٪" value={settings.gapTrading.levelWeightDecayPercent} help="وزن هر Level دورتر نسبت به قبلی است. مقدار کمتر روی نقدینگی نزدیک قیمت تمرکز بیشتری دارد." onChange={levelWeightDecayPercent => updateSection("gapTrading", { levelWeightDecayPercent })}/>
        </StrategySettingGroup>

        <StrategySettingGroup title="تأیید زمانی و جهت حرکت" english="PERSISTENCE & DIRECTION" description="یک Snapshot منفرد کافی نیست؛ Gap باید بماند و جریان سفارش احتمال حرکت رو به بالا را تأیید کند.">
          <NumberField label="حداقل تأیید متوالی" english="Confirmations" unit="نمونه" value={settings.gapTrading.minConfirmations} help="بیشتر: مقاومت بهتر در برابر سفارش لحظه‌ای و Spoof؛ در عوض ورود دیرتر و سیگنال کمتر." onChange={minConfirmations => updateSection("gapTrading", { minConfirmations })}/>
          <NumberField label="پنجره نمونه‌ها" english="Sample Window" unit="ms" value={settings.gapTrading.sampleWindowMs} help="فقط Snapshotهای این بازه در تأیید Gap استفاده می‌شوند. پنجره بلندتر پایدارتر ولی کندتر است." onChange={sampleWindowMs => updateSection("gapTrading", { sampleWindowMs })}/>
          <NumberField label="حداقل ماندگاری" english="Minimum Persistence" unit="ms" value={settings.gapTrading.minPersistenceMs} help="Gap زودگذر پیش از این زمان رد می‌شود. مقدار خیلی کم برای اسکن REST قابل اتکا نیست." onChange={minPersistenceMs => updateSection("gapTrading", { minPersistenceMs })}/>
          <NumberField label="حداکثر عمر سیگنال" english="Maximum Persistence" unit="ms" value={settings.gapTrading.maxPersistenceMs} help="Gap قدیمی ممکن است دیگر اطلاعات تازه‌ای نداشته باشد؛ کوتاه‌تر کردن این زمان سیگنال‌های stale را زودتر حذف می‌کند." onChange={maxPersistenceMs => updateSection("gapTrading", { maxPersistenceMs })}/>
          <NumberField label="حداکثر تغییر اندازه Gap" english="Maximum Gap Drift" unit="٪" value={settings.gapTrading.maxGapDriftPercent} help="اگر اندازه Gap بین نمونه‌ها بیش از این درصد تغییر کند، ساختار ناپایدار تلقی می‌شود. مقدار کمتر سخت‌گیرانه‌تر است." onChange={maxGapDriftPercent => updateSection("gapTrading", { maxGapDriftPercent })}/>
          <NumberField label="جابجایی مرز شکاف" english="Boundary Drift" unit="BPS" value={settings.gapTrading.maxBoundaryDriftBps} help="قیمت دو Level سازنده Gap نباید بیش از این مقدار جابه‌جا شود. سقف پایین‌تر، Gapهای ناپایدار را زودتر رد می‌کند." onChange={maxBoundaryDriftBps => updateSection("gapTrading", { maxBoundaryDriftBps })}/>
          <NumberField label="حداقل حمایت سمت خرید" english="Bid Support Ratio" unit="×" value={settings.gapTrading.minBidSupportRatio} help="نسبت عمق وزنی Bid به Ask است. بالاتر، تأیید صعود قوی‌تر ولی فرصت کمتر ایجاد می‌کند." onChange={minBidSupportRatio => updateSection("gapTrading", { minBidSupportRatio })}/>
          <NumberField label="سوگیری Microprice" english="Microprice Bias" unit="BPS" value={settings.gapTrading.minMicropriceBiasBps} help="Microprice باید بالاتر از Mid باشد. افزایش آن ورودهای هم‌جهت‌تر و دیرتر می‌دهد." onChange={minMicropriceBiasBps => updateSection("gapTrading", { minMicropriceBiasBps })}/>
        </StrategySettingGroup>

        <StrategySettingGroup title="کیفیت نقدشوندگی و ضد دست‌کاری" english="LIQUIDITY QUALITY" description="شکاف مصنوعی، عمق متمرکز و مصرف بیش‌ازحد سطح قبل از Gap را حذف می‌کند.">
          <NumberField label="سقف تمرکز سطح اول" english="Top-Level Share" unit="٪" value={settings.gapTrading.maxTopLevelSharePercent} help="اگر بخش بزرگی از عمق فقط در یک Level باشد، ریسک Wall یا نقدینگی زودگذر بیشتر است. این معیار قصد Spoofing را اثبات نمی‌کند؛ مقدار کمتر سخت‌گیرانه‌تر است." onChange={maxTopLevelSharePercent => updateSection("gapTrading", { maxTopLevelSharePercent })}/>
          <NumberField label="حداکثر مصرف قبل از Gap" english="Pre-Gap Consumption" unit="٪" value={settings.gapTrading.maxPreGapConsumptionPercent} help="تخمین می‌زند ورود چه سهمی از نقدینگی پیش از شکاف را می‌خورد. مقدار کمتر اثر قیمت و خطر ایجاد حرکت توسط خود ربات را محدود می‌کند." onChange={maxPreGapConsumptionPercent => updateSection("gapTrading", { maxPreGapConsumptionPercent })}/>
          <NumberField label="حداقل عمق قابل مشاهده" english="Visible Depth" unit="تومان" value={settings.gapTrading.minVisibleDepthToman} help="افزایش آن بازارهای کم‌عمق را حذف می‌کند، ولی تعداد دارایی‌های قابل بررسی کاهش می‌یابد." onChange={minVisibleDepthToman => updateSection("gapTrading", { minVisibleDepthToman })}/>
          <NumberField label="حداکثر اسپرد ورود" english="Maximum Spread" unit="BPS" value={settings.gapTrading.maxSpreadBps} help="Gap داخل کتاب با Spread خریدوفروش فرق دارد؛ این سقف مانع ورود به بازاری می‌شود که هزینه عبور از Spread زیاد است." onChange={maxSpreadBps => updateSection("gapTrading", { maxSpreadBps })}/>
        </StrategySettingGroup>

        <StrategySettingGroup title="اقتصاد سیگنال و اندازه آزمایشی" english="SHADOW ECONOMICS" description="فقط بازده مدل و سرمایه آزمایشی را می‌سنجد؛ این مقادیر مجوز معامله واقعی نیستند.">
          <NumberField label="سهم قابل انتظار از Gap" english="Target Capture" unit="٪" value={settings.gapTrading.targetCapturePercent} help="فرض می‌کند چه درصدی از فاصله Gap واقعاً قابل برداشت است. مقدار بالاتر برآورد سود را خوش‌بینانه‌تر و پرریسک‌تر می‌کند." onChange={targetCapturePercent => updateSection("gapTrading", { targetCapturePercent })}/>
          <NumberField label="حداقل بازده خالص پیش‌بینی‌شده" english="Projected Net Edge" unit="BPS" value={settings.gapTrading.minProjectedNetBps} help="بعد از Spread، کارمزد، اثر قیمت و حاشیه خطا سنجیده می‌شود. افزایش آن سیگنال کمتر ولی حاشیه مدل بیشتر می‌دهد." onChange={minProjectedNetBps => updateSection("gapTrading", { minProjectedNetBps })}/>
          <NumberField label="حاشیه خطای مدل" english="Safety Buffer" unit="BPS" value={settings.gapTrading.safetyBufferBps} help="از بازده پیش‌بینی‌شده کم می‌شود تا خطای مدل و تأخیر پوشش داده شود. عدد بالاتر محافظه‌کارانه‌تر است." onChange={safetyBufferBps => updateSection("gapTrading", { safetyBufferBps })}/>
          <NumberField label="حداکثر اثر قیمت" english="Maximum Price Impact" unit="BPS" value={settings.gapTrading.maxPriceImpactBps} help="سقف اثر اجرای سرمایه آزمایشی بر قیمت است. کاهش آن اندازه‌های مخرب را حذف می‌کند." onChange={maxPriceImpactBps => updateSection("gapTrading", { maxPriceImpactBps })}/>
          <NumberField label="سهم قابل اتکا از عمق" english="Usable Depth" unit="٪" value={settings.gapTrading.depthUsagePercent} help="درصد بالاتر به حجم نمایشی بیشتری اعتماد می‌کند و خطر ناپدیدشدن نقدینگی را بالا می‌برد." onChange={depthUsagePercent => updateSection("gapTrading", { depthUsagePercent })}/>
          <NumberField label="سرمایه شبیه‌سازی" english="Shadow Capital" unit="تومان" value={settings.gapTrading.capitalToman} help="افزایش سرمایه، مصرف عمق و اثر قیمت را بالا می‌برد. این عدد سرمایه پیشنهادی Live نیست." onChange={capitalToman => updateSection("gapTrading", { capitalToman })}/>
        </StrategySettingGroup>
      </StrategyCard>

      <StrategyCard anchor="strategy-imbalance" icon={Waves} tone="amber" title="عدم‌تعادل اردربوک" english="Orderbook Imbalance" family="Event-Driven" enabled={settings.imbalance.enabled} onToggle={() => updateSection("imbalance", { enabled: !settings.imbalance.enabled })} count={grouped("orderbook-imbalance").length} best={best("orderbook-imbalance")} primaryLabel="Weighted Ratio" primaryValue={best("orderbook-imbalance") ? `${fa(best("orderbook-imbalance")!.metrics.ratio as number, 2)}×` : "—"} risks={["Spoofing", "Absorption", "Latency"]}>
        <SettingsBand tone="paper" title="سیگنال چندنمونه‌ای و ضد Spoofing" description="عمق چند Level با وزن بیشتر برای قیمت‌های نزدیک سنجیده می‌شود؛ ورود فقط پس از تداوم فشار، Change Point، Microprice و کنترل اثر قیمت مجاز است."/>
        <NumberField label="تعداد سطوح" english="Depth Levels" unit="سطح" value={settings.imbalance.levels} help="سطوح بیشتر تصویر عمیق‌تر ولی کندتر و مستعد سفارش‌های دور از قیمت می‌دهد؛ سطوح کمتر حساس‌تر و پرنویزتر است." onChange={levels => updateSection("imbalance", { levels })}/>
        <NumberField label="وزن Level بعدی" english="Level Weight Decay" unit="٪" value={settings.imbalance.levelWeightDecayPercent} help="مثلاً ۷۰٪ یعنی هر سطح دورتر فقط ۷۰٪ سطح قبلی وزن دارد. کمتر: تمرکز بیشتر روی Top of Book؛ بیشتر: اتکای بیشتر به عمق دور." onChange={levelWeightDecayPercent => updateSection("imbalance", { levelWeightDecayPercent })}/>
        <NumberField label="حداقل نسبت ورود" english="Entry Imbalance" unit="×" value={settings.imbalance.minRatio} help="بیشتر: سیگنال قوی‌تر و کمتر؛ کمتر: سیگنال بیشتر و نویز بالاتر." onChange={minRatio => updateSection("imbalance", { minRatio })}/>
        <NumberField label="نسبت خروج" english="Exit Imbalance" unit="×" value={settings.imbalance.exitRatio} help="نزدیک‌تر به ۱ یعنی خروج پس از خنثی‌شدن فشار اردربوک." onChange={exitRatio => updateSection("imbalance", { exitRatio })}/>
        <NumberField label="پنجره نمونه‌ها" english="Signal Window" unit="ms" value={settings.imbalance.sampleWindowMs} help="فقط Snapshotهای این بازه برای تداوم و Change Point استفاده می‌شوند. بزرگ‌تر: سیگنال کندتر و پایدارتر؛ کوچک‌تر: واکنش سریع‌تر و نویز بیشتر." onChange={sampleWindowMs => updateSection("imbalance", { sampleWindowMs })}/>
        <NumberField label="حداقل تأیید" english="Min Confirmations" unit="نمونه" value={settings.imbalance.minConfirmations} help="تعداد Snapshot هم‌جهت لازم. افزایش آن Wallهای لحظه‌ای را بهتر حذف می‌کند، اما ورود را دیرتر می‌کند." onChange={minConfirmations => updateSection("imbalance", { minConfirmations })}/>
        <NumberField label="افق پیش‌بینی" english="Prediction Horizon" unit="ms" value={settings.imbalance.predictionHorizonMs} help="حرکت قیمت پس از این فاصله برای سنجش نتیجه هر سیگنال استفاده می‌شود. کوتاه‌تر پرنویزتر و بلندتر کندتر است." onChange={predictionHorizonMs => updateSection("imbalance", { predictionHorizonMs })}/>
        <NumberField label="حداقل نمونه نتیجه" english="Outcome Samples" unit="نمونه" value={settings.imbalance.minOutcomeSamples} help="تا این تعداد نتیجه مستقل از Snapshotهای واقعاً جدید جمع نشود، موتور فقط Shadow می‌ماند. عدد بالاتر اطمینان آماری بیشتر و سیگنال کمتر می‌دهد." onChange={minOutcomeSamples => updateSection("imbalance", { minOutcomeSamples })}/>
        <NumberField label="حداقل نرخ موفقیت" english="Minimum Hit Rate" unit="٪" value={settings.imbalance.minOutcomeHitRatePercent} help="درصد نمونه‌های تاریخی که پس از سیگنال در جهت پیش‌بینی حرکت کرده‌اند. بالاتر سخت‌گیرانه‌تر است." onChange={minOutcomeHitRatePercent => updateSection("imbalance", { minOutcomeHitRatePercent })}/>
        <NumberField label="حداقل بازده خالص پیش‌بینی" english="Predicted Net Edge" unit="BPS" value={settings.imbalance.minPredictedNetBps} help="صدک محافظه‌کارانه بازده پس از کسر هزینه رفت‌وبرگشت و بافر مدل؛ افزایش آن سود کاذب را کمتر می‌کند." onChange={minPredictedNetBps => updateSection("imbalance", { minPredictedNetBps })}/>
        <NumberField label="بافر خطای پیش‌بینی" english="Forecast Safety" unit="BPS" value={settings.imbalance.forecastSafetyBps} help="از پیش‌بینی تاریخی کم می‌شود تا Latency و خطای مدل پوشش داده شود. بیشتر، محافظه‌کارانه‌تر است." onChange={forecastSafetyBps => updateSection("imbalance", { forecastSafetyBps })}/>
        <NumberField label="حداقل ماندگاری فشار" english="Min Persistence" unit="ms" value={settings.imbalance.minPersistenceMs} help="سیگنال باید حداقل این مدت باقی بماند. مقدار خیلی کم نسبت به سفارش‌های لحظه‌ای و Spoofing حساس است." onChange={minPersistenceMs => updateSection("imbalance", { minPersistenceMs })}/>
        <NumberField label="حداکثر عمر فشار" english="Max Persistence" unit="ms" value={settings.imbalance.maxPersistenceMs} help="پس از این زمان سیگنال قدیمی و احتمالاً جذب‌شده یا قیمت‌گذاری‌شده تلقی می‌شود. باید از حداقل ماندگاری بزرگ‌تر باشد." onChange={maxPersistenceMs => updateSection("imbalance", { maxPersistenceMs })}/>
        <NumberField label="حداقل جهش فشار" english="Change Point Delta" unit="NOBI" value={settings.imbalance.minPressureDelta} help="افزایش لازم در عدم‌تعادل نرمال‌شده/CUSUM نسبت به خط پایه. بیشتر: فقط تغییرات ناگهانی‌تر؛ کمتر: سیگنال‌های آرام‌تر و بیشتر." onChange={minPressureDelta => updateSection("imbalance", { minPressureDelta })}/>
        <NumberField label="سقف تمرکز Level اول" english="Top-Level Concentration" unit="٪" value={settings.imbalance.maxTopLevelSharePercent} help="اگر سهم دیوار Level اول از این مقدار بیشتر باشد، سیگنال برای کاهش ریسک Spoofing رد می‌شود. مقدار کمتر سخت‌گیرانه‌تر است." onChange={maxTopLevelSharePercent => updateSection("imbalance", { maxTopLevelSharePercent })}/>
        <NumberField label="حداقل تأیید Microprice" english="Microprice Bias" unit="BPS" value={settings.imbalance.minMicropriceBiasBps} help="Microprice باید حداقل به این اندازه جهت صعود را تأیید کند. بیشتر: ورود کمتر ولی هم‌جهتی قوی‌تر با Top of Book." onChange={minMicropriceBiasBps => updateSection("imbalance", { minMicropriceBiasBps })}/>
        <NumberField label="حرکت مخالف مجاز" english="Max Adverse Mid Move" unit="BPS" value={settings.imbalance.maxAdverseMoveBps} help="اگر قیمت میانی با وجود فشار Bid بیش از این مقدار افت کند، احتمال Absorption وجود دارد و ورود رد می‌شود. کمتر: فیلتر حساس‌تر؛ بیشتر: تحمل حرکت خلاف جهت." onChange={maxAdverseMoveBps => updateSection("imbalance", { maxAdverseMoveBps })}/>
        <NumberField label="حداقل عمق" english="Visible Depth" unit="تومان" value={settings.imbalance.minVisibleDepthToman} help="بالاتر، بازارهای کم‌عمق را حذف می‌کند." onChange={minVisibleDepthToman => updateSection("imbalance", { minVisibleDepthToman })}/>
        <SettingsBand tone="live" title="ورود، خروج و Recovery واقعی Mainnet" description="این مقادیر در پوزیشن واقعی، Take Profit، Stop، Time Stop و Recovery روی حساب اصلی اعمال می‌شوند."/>
        <NumberField label="سرمایه معامله" english="Live Capital" unit="تومان" value={settings.imbalance.capitalToman} help="بیشتر: اثر قیمت و زیان بالقوه بیشتر؛ سقف‌های سراسری نیز اعمال می‌شوند." onChange={capitalToman => updateSection("imbalance", { capitalToman })}/>
        <NumberField label="حداکثر اسپرد" english="Max Spread" unit="BPS" value={settings.imbalance.maxSpreadBps} help="سقف پایین‌تر ورود در بازار پرهزینه را رد می‌کند." onChange={maxSpreadBps => updateSection("imbalance", { maxSpreadBps })}/>
        <NumberField label="حداکثر اثر قیمت" english="Max Price Impact" unit="BPS" value={settings.imbalance.maxPriceImpactBps} help="کمتر: حجم اجرای محافظه‌کارانه‌تر." onChange={maxPriceImpactBps => updateSection("imbalance", { maxPriceImpactBps })}/>
        <NumberField label="سهم مجاز از عمق" english="Usable Depth" unit="٪" value={settings.imbalance.depthUsagePercent} help="درصد بالاتر اتکا به عمق نمایشی و ریسک لغزش را زیاد می‌کند." onChange={depthUsagePercent => updateSection("imbalance", { depthUsagePercent })}/>
        <NumberField label="حد سود" english="Take Profit" unit="BPS" value={settings.imbalance.takeProfitBps} help="هدف بالاتر زمان نگهداری و احتمال برگشت سود را بیشتر می‌کند." onChange={takeProfitBps => updateSection("imbalance", { takeProfitBps })}/>
        <NumberField label="حد ضرر" english="Stop Loss" unit="BPS" value={settings.imbalance.stopLossBps} help="قبل از خرید، هزینه رفت‌وبرگشت شامل اسپرد، دو کارمزد، لغزش و گردکردن محاسبه می‌شود؛ اگر این هزینه با حاشیه اجرا به Stop Loss برسد، سفارش اصلاً ارسال نمی‌شود. عدد بزرگ‌تر تحمل حرکت مخالف و زیان بالقوه را بیشتر می‌کند." onChange={stopLossBps => updateSection("imbalance", { stopLossBps })}/>
        <NumberField label="حداکثر زیان معامله" english="Max Loss" unit="تومان" value={settings.imbalance.maxLossToman} help="سقف زیان تومانی مستقل از Stop BPS؛ مقدار کمتر محافظه‌کارانه‌تر است." onChange={maxLossToman => updateSection("imbalance", { maxLossToman })}/>
        <NumberField label="حداکثر باقیمانده دارایی" english="Max Residual Value" unit="تومان" value={settings.imbalance.maxResidualToman} help="بازارهایی مثل BNB که گام مقدارشان می‌تواند Dust باارزش بسازد، پیش از ارسال سفارش رد می‌شوند." onChange={maxResidualToman => updateSection("imbalance", { maxResidualToman })}/>
        <NumberField label="حداکثر زمان نگهداری" english="Max Hold" unit="ms" value={settings.imbalance.maxHoldMs} help="Time Stop؛ پس از این زمان خروج اجباری آغاز می‌شود." onChange={maxHoldMs => updateSection("imbalance", { maxHoldMs })}/>
        <NumberField label="فاصله پایش" english="Poll Interval" unit="ms" value={settings.imbalance.pollIntervalMs} help="کمتر: خروج سریع‌تر و بار API بیشتر." onChange={pollIntervalMs => updateSection("imbalance", { pollIntervalMs })}/>
        <NumberField label="وقفه ورود مجدد" english="Execution Cooldown" unit="ms" value={settings.imbalance.cooldownMs} help="بیشتر: سیگنال‌های تکراری و دست‌کاری اردربوک کمتر معامله می‌شوند؛ کمتر: ورود بیشتر با ریسک سیگنال کاذب بالاتر." onChange={cooldownMs => updateSection("imbalance", { cooldownMs })}/>
        <NumberField label="رزرو سفارش" english="Order Reserve" unit="BPS" value={settings.imbalance.orderReserveBps} help="افزایش آن احتمال Fill و هزینه قیمت اجرا را بالا می‌برد." onChange={orderReserveBps => updateSection("imbalance", { orderReserveBps })}/>
        <NumberField label="اسپرد مجاز Recovery" english="Recovery Max Spread" unit="BPS" value={settings.imbalance.recoveryMaxSpreadBps} help="فقط برای خروج اضطراری؛ عدد بزرگ‌تر خروج را پرهزینه‌تر می‌کند." onChange={recoveryMaxSpreadBps => updateSection("imbalance", { recoveryMaxSpreadBps })}/>
        <NumberField label="اثر قیمت Recovery" english="Recovery Max Impact" unit="BPS" value={settings.imbalance.recoveryMaxPriceImpactBps} help="حداکثر اثر قیمت مجاز برای بستن اضطراری." onChange={recoveryMaxPriceImpactBps => updateSection("imbalance", { recoveryMaxPriceImpactBps })}/>
        <NumberField label="لغزش Recovery" english="Recovery Slippage" unit="BPS" value={settings.imbalance.recoverySlippageBps} help="بالاتر احتمال خروج فوری را زیاد و کیفیت قیمت را کمتر می‌کند." onChange={recoverySlippageBps => updateSection("imbalance", { recoverySlippageBps })}/>
      </StrategyCard>

      <article className="strategy-card unavailable">
        <header><div className="strategy-icon"><Radio/></div><div><span>Potential Arbitrage</span><h3>اسپات ↔ خرید آسان<small>Spot ↔ Easy</small></h3></div><em className="availability unsupported">API پشتیبانی نمی‌شود</em></header>
        <p>در OpenAPI فعلی نوبیتکس endpoint رسمی Quote/Execution برای خرید آسان وجود ندارد؛ این موتور عمداً غیرفعال است.</p>
        <div className="risk-tags"><span>Quote Expiry</span><span>Partial Fill</span><span>Unsupported API</span></div>
        <div className="strategy-unavailable"><ShieldAlert/><span>از endpoint قدیمی یا حدسی برای پول واقعی استفاده نمی‌شود.</span></div>
        <details className="strategy-controls"><summary><SlidersHorizontal/> تنظیمات تحقیقاتی Spot ↔ Easy</summary><div>
          <SettingsBand tone="paper" title="فقط نگهداری تنظیمات تحقیق" description="تا زمانی که Nobitex API رسمی Quote/Execution ارائه نکند، این مقادیر نه اسکن قابل اتکا و نه سفارش واقعی ایجاد می‌کنند."/>
          <NumberField label="حداقل برتری قیمت" english="Minimum Edge" unit="BPS" value={settings.spotEasy.minEdgeBps} help="بیشترکردن مقدار، فقط اختلاف‌های بزرگ‌تر را برای تحقیق قابل توجه می‌داند." onChange={minEdgeBps => updateSection("spotEasy", { minEdgeBps })}/>
          <NumberField label="بافر انقضای Quote" english="Quote Expiry Buffer" unit="ms" value={settings.spotEasy.quoteExpiryBufferMs} help="حاشیه زمانی برای ردکردن Quote نزدیک انقضا؛ فعلاً به endpoint واقعی متصل نیست." onChange={quoteExpiryBufferMs => updateSection("spotEasy", { quoteExpiryBufferMs })}/>
        </div></details>
      </article>
    </div>

    <section className="signal-board panel">
      <div className="section-title"><div><span className="eyebrow">UNIFIED SIGNAL TAPE</span><h2><Activity/> سیگنال‌های چنداستراتژی</h2><small className="section-note">«آماده بررسی Paper» فقط نتیجه محاسبات است؛ اجازه اجرای واقعی جداگانه در Risk Center مشخص می‌شود.</small></div><span>{result ? `آخرین اسکن ${new Date(result.scannedAt).toLocaleTimeString("fa-IR")}` : "در انتظار داده"}</span></div>
      {!visibleSignals.length ? <div className="empty">هنوز سیگنالی با داده و شروط فعلی پیدا نشده است.</div> : <div className="signal-list">{visibleSignals.slice(0, 40).map(signal => <article className={`signal-row ${signal.status}`} key={signal.id}>
        <div><span className={`signal-kind ${signal.kind}`}>{labels[signal.kind]}</span><b>{signal.title}</b><small><bdi dir="ltr">{signal.symbols.join(" · ")}</bdi></small></div>
        <div><span>اقدام پیشنهادی Paper</span><b><bdi dir="ltr">{signal.action}</bdi></b><small>{signal.reasons[0]}</small></div>
        {(() => { const metric = signalMetric(signal); return <div><span>{metric.label}</span><b className={metric.directional ? Number(signal.expectedEdgeBps) > 0 ? "positive" : "negative" : ""}>{metric.value}</b><small>{metric.note}</small></div>; })()}
        <div><span>Confidence</span><b>{fa(signal.confidence, 1)}٪</b><div className="confidence-bar"><i style={{ width: `${Math.min(100, Number(signal.confidence))}%` }}/></div></div>
        <div><span className={`signal-state ${signal.status}`}>{signalStateLabel(signal)}</span></div>
        <details><summary>دلیل‌ها و Metrics</summary><div className="signal-details"><ul>{signal.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul><dl>{Object.entries(signal.metrics).map(([key, value]) => <div key={key}><dt>{key}</dt><dd><bdi dir="ltr">{typeof value === "number" ? fa(value, 4) : String(value)}</bdi></dd></div>)}</dl></div></details>
      </article>)}</div>}
    </section>
  </section>;
}

function StrategyCard({ anchor, icon: Icon, tone, title, english, family, enabled, onToggle, count, best, primaryLabel = "بهترین Edge", primaryValue, risks, children }: { anchor: string; icon: typeof Scale; tone: string; title: string; english: string; family: string; enabled: boolean; onToggle: () => void; count: number; best?: SerializedStrategySignal; primaryLabel?: string; primaryValue?: string; risks: string[]; children: React.ReactNode }) {
  return <article id={anchor} className={`strategy-card ${tone} ${enabled ? "enabled" : "disabled"}`}>
    <header><div className="strategy-icon"><Icon/></div><div><span>{family}</span><h3>{title}<small>{english}</small></h3></div><button type="button" className={`mini-toggle ${enabled ? "on" : ""}`} onClick={onToggle} aria-pressed={enabled}>{enabled ? "اسکن Paper روشن" : "اسکن Paper خاموش"}</button></header>
    <div className="strategy-metrics"><div><span>سیگنال</span><b>{fa(count)}</b></div><div><span>{primaryLabel}</span><b>{primaryValue ?? (best ? `${fa(best.expectedEdgeBps, 2)} BPS` : "—")}</b></div><div><span>Confidence</span><b>{best ? `${fa(best.confidence, 1)}٪` : "—"}</b></div></div>
    <div className="risk-tags">{risks.map(risk => <span key={risk}>{risk}</span>)}</div>
    <details className="strategy-controls"><summary><SlidersHorizontal/> مدیریت و تنظیمات</summary><div>{children}</div></details>
  </article>;
}

function SettingsBand({ tone, title, description }: { tone: "paper" | "live"; title: string; description: string }) {
  return <div className={`strategy-settings-band ${tone}`}><b>{tone === "paper" ? "PAPER / SIGNAL" : "LIVE / EXECUTION"} · {title}</b><small>{description}</small></div>;
}

function StrategySettingGroup({ title, english, description, children }: { title: string; english: string; description: string; children: React.ReactNode }) {
  return <section className="strategy-setting-group"><header><div><b>{title}</b><span>{english}</span></div><small>{description}</small></header><div>{children}</div></section>;
}

function NumberField({ label, english, unit, value, help, onChange }: { label: string; english: string; unit: string; value: number; help?: string; onChange: (value: number) => void }) {
  return <label className="strategy-field"><span>{label}<small>{english}</small>{help && <i className="strategy-field-help">{help}</i>}</span><div><input type="text" inputMode="decimal" value={en(value)} onChange={event => { const parsed = Number(event.target.value.replace(/,/g, "")); if (Number.isFinite(parsed)) onChange(parsed); }}/><em>{unit}</em></div></label>;
}
function TextField({ label, value, help, onChange }: { label: string; value: string; help?: string; onChange: (value: string) => void }) {
  return <label className="strategy-field"><span>{label}{help && <i className="strategy-field-help">{help}</i>}</span><div><input type="text" value={value} onChange={event => onChange(event.target.value)}/></div></label>;
}
function SelectField({ label, value, options, help, onChange }: { label: string; value: string; options: string[]; help?: string; onChange: (value: string) => void }) {
  return <label className="strategy-field"><span>{label}{help && <i className="strategy-field-help">{help}</i>}</span><div><select value={value} onChange={event => onChange(event.target.value)}>{options.map(option => <option value={option} key={option}>{option}</option>)}</select></div></label>;
}
