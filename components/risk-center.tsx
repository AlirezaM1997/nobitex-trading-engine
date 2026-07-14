"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertOctagon,
  ArrowLeft,
  DatabaseZap,
  KeyRound,
  LockKeyhole,
  RefreshCw,
  RotateCcw,
  Save,
  ServerCog,
  ShieldCheck,
  ShieldOff,
  Unplug,
  Workflow
} from "lucide-react";
import type { RiskControlSnapshot, RiskStrategy } from "@/lib/risk/types";
import type { StrategyRuntimeCapability } from "@/lib/strategy-runtime-capabilities";
import type { PublicLiveOwnerStatus } from "@/lib/runtime/live-owner";
import type { LiveSchedulerStatus } from "@/lib/runtime/live-scheduler";

type RiskEnvironment = {
  apiBase: string;
  kind: "mainnet" | "custom";
  credentialsConfigured: boolean;
};

export type RiskSnapshotResponse = RiskControlSnapshot & {
  environment?: RiskEnvironment;
  runtimeCapabilities?: Record<RiskStrategy, StrategyRuntimeCapability>;
  liveOwner?: PublicLiveOwnerStatus;
  liveScheduler?: LiveSchedulerStatus;
};

type RiskCenterProps = {
  snapshot?: RiskSnapshotResponse;
  onSnapshot?: (snapshot: RiskSnapshotResponse) => void;
  strategyFilter?: RiskStrategy;
};

type RiskDisplayError = {
  title: string;
  details?: string[];
};

type StrategyMeta = {
  title: string;
  english: string;
  mechanism: string;
  assets: string;
  entryExit: string;
  recovery: string;
  risks: string;
  settingsHref: string;
  settingsLabel: string;
};

const strategyMeta: Record<RiskStrategy, StrategyMeta> = {
  triangle: {
    title: "آربیتراژ مثلثی",
    english: "Triangular Arbitrage",
    mechanism: "سه بازار متصل با عمق واقعی بررسی می‌شوند و فقط زمانی وارد چرخه می‌شویم که خروجی خالص هر سه ضلع از آستانه‌ها عبور کند.",
    assets: "مبدأ و مقصد همیشه تومان (IRT) است؛ در میانه چرخه یک رمزارز و معمولاً USDT قرار می‌گیرد.",
    entryExit: "ورود پس از بازاعتبارسنجی عمق، اسپرد، اثر قیمت، کارمزد و لغزش است؛ خروج موفق با تکمیل ضلع سوم و بازگشت به IRT ثبت می‌شود.",
    recovery: "اگر ضلع میانی ناقص یا ناموفق شود، وضعیت Fill از صرافی خوانده و موجودی باقی‌مانده از مسیر امن به IRT برگردانده می‌شود.",
    risks: "تغییر قیمت بین اضلاع، Partial Fill، کاهش ناگهانی عمق و تأخیر API. سود اسکن‌شده تضمین سود نهایی نیست.",
    settingsHref: "#settings",
    settingsLabel: "تنظیمات Triangle"
  },
  crossQuote: {
    title: "آربیتراژ دو بازار",
    english: "Cross-Quote Inventory",
    mechanism: "قیمت همان دارایی در بازار IRT و USDT مقایسه و یک چرخش دوضلع اجرا می‌شود؛ این نسخه یک چرخه تومانی بسته و سه‌ضلع نیست.",
    assets: "بسته به جهت سیگنال، مبدأ IRT یا USDT و مقصد می‌تواند USDT یا IRT باشد؛ برای تکرار عملیات باید موجودی هر دو سمت جداگانه مدیریت و متعادل شود.",
    entryExit: "ورود پس از عبور Net Edge و کنترل اسپرد و عمق است؛ خروج ضلع دوم ممکن است با USDT تمام شود و در نسخه فعلی PnL بسته تومانی محسوب نمی‌شود.",
    recovery: "Recovery داخل همان درخواست می‌تواند Fill شناخته‌شده را برگرداند، اما برنامه بازیابی پایدار پس از Restart و Supervisor مستقل این موتور هنوز کامل نیست؛ به همین علت اجرای واقعی آن غیرفعال است.",
    risks: "ریسک نرخ USDT/IRT، عدم‌تعادل Inventory، لغزش دو بازار و سفارش ناقص. تا تکمیل Position State، Recovery پایدار و حسابداری PnL بسته، این موتور مجوز شروع سفارش ندارد.",
    settingsHref: "#strategy-cross-quote",
    settingsLabel: "تنظیمات Cross-Quote"
  },
  pairs: {
    title: "معاملات جفتی آماری",
    english: "Statistical Pairs",
    mechanism: "رابطه تاریخی دو دارایی با OHLC، Beta و Z-Score سنجیده و روی واگرایی موقت یک Long و یک Short هم‌زمان ساخته می‌شود.",
    assets: "سرمایه بر مبنای ارزش تومانی کنترل می‌شود، اما تا زمان خروج در دو پوزیشن Spot/Margin باقی می‌ماند.",
    entryExit: "ورود در عبور Z-Score از Entry، خروج در بازگشت به Exit و توقف اجباری در Stop Z-Score یا شکست مدل است.",
    recovery: "هر دو ضلع باید با وضعیت سفارش مستقل ردیابی شوند؛ در Fill نامتقارن، ضلع باز فوراً هج یا بسته می‌شود.",
    risks: "Model Drift، کمبود امکان Short، لیکوییدیشن Margin، واگرایی پایدار و Fill نامتقارن. اجرای واقعی فقط با Position State و Recovery فعال مجاز است.",
    settingsHref: "#strategy-pairs",
    settingsLabel: "تنظیمات Pairs"
  },
  stablecoin: {
    title: "همگرایی استیبل‌کوین",
    english: "Stablecoin Convergence",
    mechanism: "انحراف استیبل‌کوین‌ها از ارزش مرجع و از یکدیگر بررسی می‌شود تا بازگشت احتمالی قیمت معامله شود.",
    assets: "نسخه اجرایی فعلی با تومان (IRT) وارد Spot می‌شود و هنگام خروج دوباره به تومان برمی‌گردد؛ پوزیشن می‌تواند تا Take Profit، Stop Loss یا Time Stop باز بماند.",
    entryExit: "ورود پس از حداقل Deviation و کیفیت مناسب بازار؛ خروج هنگام همگرایی، Stop زمانی یا عبور انحراف از حد ریسک.",
    recovery: "برای Depeg یا نبود نقدشوندگی باید خروج مرحله‌ای، سقف زمان نگهداری و تبدیل به دارایی مرجع اجرا شود.",
    risks: "Depeg واقعی، ریسک صادرکننده، نبود بازار Short، اسپرد ناگهانی و قفل‌شدن نقدینگی. اجرای Long-only Mainnet با ثبت Position، خروج و Recovery انجام می‌شود.",
    settingsHref: "#strategy-stablecoin",
    settingsLabel: "تنظیمات Stablecoin"
  },
  gapTrading: {
    title: "شکاف نقدشوندگی اردربوک",
    english: "Orderbook Gap / Liquidity Vacuum",
    mechanism: "فاصله بین Levelهای مجاور Ask با خط مبنای مقاوم همان اردربوک مقایسه می‌شود. فقط Gap غیرعادی و پایدار که با فشار Bid، Microprice و کاهش کنترل‌شده نقدینگی پیش از شکاف هم‌جهت باشد به‌عنوان سیگنال سایه ثبت می‌شود.",
    assets: "تحلیل فعلی فقط اردربوک عمومی Spot را پوشش می‌دهد. OTC / خرید آسان اردربوک عمومی و API رسمی پشتیبانی‌شده برای Quote و Execution ندارد، پس Gap آن قابل اندازه‌گیری یا اجرای امن نیست.",
    entryExit: "این نسخه Shadow/Paper است و سفارش ارسال نمی‌کند. بازده پیش‌بینی‌شده پس از Spread، کارمزد، اثر قیمت، سهم محافظه‌کارانه از Gap و عمق قابل استفاده محاسبه می‌شود.",
    recovery: "چون پوزیشن واقعی باز نمی‌شود Recovery معاملاتی ندارد. Snapshot کهنه، ناپایداری Gap، تمرکز مشکوک سطح اول یا عبور هزینه اجرا از بازده مدل، سیگنال را فوراً رد می‌کند.",
    risks: "Gap ایستا آربیتراژ قطعی نیست؛ ممکن است با یک سفارش لغوشده، Spoofing، Feed تأخیردار یا نبود تقاضای تهاجمی ناپدید شود. برای Live به فید event-level، کالیبراسیون Out-of-sample و کنترل خروج نیاز است.",
    settingsHref: "#strategy-orderbook-gap",
    settingsLabel: "تنظیمات Orderbook Gap"
  },
  imbalance: {
    title: "عدم‌تعادل اردربوک",
    english: "Orderbook Imbalance",
    mechanism: "نسبت حجم Bid/Ask در چند سطح سنجیده می‌شود تا فشار کوتاه‌مدت خرید یا فروش شناسایی شود.",
    assets: "نسخه اجرایی فعلی از تومان (IRT) وارد دارایی Spot می‌شود و خروج را دوباره به تومان می‌بندد؛ سیگنال فروش مصنوعی یا Short ساخته نمی‌شود.",
    entryExit: "ورود نیازمند نسبت عدم‌تعادل، اسپرد و عمق معتبر است؛ خروج باید حد سود، حد ضرر و Time Stop داشته باشد.",
    recovery: "در تغییر جهت سیگنال، stale شدن اردربوک یا Fill ناقص، سفارش باز لغو و پوزیشن با سقف لغزش بسته می‌شود.",
    risks: "سیگنال کاذب، دست‌کاری اردربوک، حرکت روندی، Latency و لغزش خروج. اجرای واقعی فقط با Position State، خروج حفاظتی و Recovery فعال می‌شود.",
    settingsHref: "#strategy-imbalance",
    settingsLabel: "تنظیمات Imbalance"
  }
};

export const riskBlockerLabels: Record<string, string> = {
  "master-not-armed": "اجرای کلی معاملات واقعی خاموش است",
  "emergency-stop-active": "توقف اضطراری فعال است",
  "daily-loss-limit-breached": "سقف زیان روزانه رد شده است",
  "consecutive-loss-limit-breached": "تعداد زیان‌های پیاپی به سقف مجاز رسیده است",
  "production-runtime-required": "اجرای واقعی فقط در نسخه Production مجاز است",
  "official-mainnet-required": "دامنه رسمی Mainnet نوبیتکس برای اجرای واقعی لازم است",
  "live-credentials-missing": "کلید API و Secret برای اجرای واقعی تنظیم نشده‌اند",
  "live-owner-not-held": "این پردازش مالک اجرای واقعی نیست",
  "live-owner-lost": "مالکیت اجرای واقعی از این پردازش گرفته شده است",
  "live-owner-held-by-another-runtime": "یک Runtime دیگر مالک اجرای واقعی این حساب است",
  "live-owner-race-detected": "مالک اجرای واقعی هم‌زمان تغییر کرده است؛ دوباره تلاش کنید",
  "live-owner-lock-invalid": "فایل قفل اجرای واقعی خراب یا ناخواناست و باید بررسی شود",
  "live-owner-storage-unavailable": "فضای امن سیستم برای قفل اجرای واقعی در دسترس نیست",
  "strategy-disabled": "اجرای واقعی این موتور خاموش است",
  "position-state-not-ready": "ثبت وضعیت پوزیشن تکمیل نشده است (Position State)",
  "recovery-not-ready": "بازیابی خودکار خطا تکمیل نشده است (Recovery)",
  "execution-adapter-not-ready": "بخش ارسال سفارش آماده نیست (Execution Adapter)",
  "max-concurrent-positions-reached": "ظرفیت اجرای هم‌زمان پر است",
  "runtime-environment-not-supported": "محیط فعلی برای اجرای این موتور پشتیبانی نمی‌شود",
  "runtime-execution-unavailable": "آداپتر رسمی اجرای سفارش برای این موتور در دسترس نیست"
};

function RiskErrorAlert({ value }: { value: RiskDisplayError }) {
  return <div className="risk-error" role="alert">
    <AlertOctagon aria-hidden="true"/>
    <div>
      <b>{value.title}</b>
      {value.details?.length ? <><span>برای ادامه، موارد زیر را برطرف کنید:</span><ul>{value.details.map(detail => <li key={detail}>{detail}</li>)}</ul></> : null}
    </div>
  </div>;
}

function riskErrorTitle(message?: string, code?: string) {
  if (code === "RISK_BLOCKED" || message?.startsWith("No enabled strategy")) return "اجرای واقعی فعال نشد";
  return message?.trim() || "تغییر تنظیمات ریسک ناموفق بود";
}

function displayError(reason: unknown, fallback: string): RiskDisplayError {
  return { title: reason instanceof Error ? riskErrorTitle(reason.message) : fallback };
}

const formatNumber = (value: number) => new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 0 }).format(value);
const formatInput = (value: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
const normalizeNumber = (value: string) => Number(value.replace(/[^\d.]/g, ""));

export default function RiskCenter({ snapshot: controlledSnapshot, onSnapshot, strategyFilter }: RiskCenterProps) {
  const [localSnapshot, setLocalSnapshot] = useState<RiskSnapshotResponse>();
  const [dailyLoss, setDailyLoss] = useState("");
  const [maxPositions, setMaxPositions] = useState("");
  const [maxConsecutiveLosses, setMaxConsecutiveLosses] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<RiskDisplayError | null>(null);
  const snapshot = controlledSnapshot ?? localSnapshot;

  const publish = useCallback((next: RiskSnapshotResponse) => {
    setLocalSnapshot(next);
    onSnapshot?.(next);
  }, [onSnapshot]);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const response = await fetch("/api/risk", { cache: "no-store" });
      const json = await response.json() as RiskSnapshotResponse & { error?: string };
      if (!response.ok) throw new Error(json.error ?? "دریافت وضعیت Risk ناموفق بود");
      publish(json);
      setError(null);
    } catch (reason) {
      setError(displayError(reason, "دریافت وضعیت کنترل ریسک ناموفق بود"));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [publish]);

  useEffect(() => {
    if (controlledSnapshot) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(true), 5_000);
    return () => window.clearInterval(timer);
  }, [controlledSnapshot, refresh]);

  useEffect(() => {
    if (!snapshot) return;
    setDailyLoss(formatInput(snapshot.state.limits.maxDailyLossToman));
    setMaxPositions(String(snapshot.state.limits.maxConcurrentPositions));
    setMaxConsecutiveLosses(String(snapshot.state.limits.maxConsecutiveLosses));
  }, [snapshot?.state.limits.maxDailyLossToman, snapshot?.state.limits.maxConcurrentPositions, snapshot?.state.limits.maxConsecutiveLosses]);

  const readyCount = useMemo(() => snapshot
    ? Object.values(snapshot.evaluation.strategies).filter(item => item.ready).length
    : 0, [snapshot]);

  async function riskRequest(method: "POST" | "PATCH", body: unknown) {
    setSaving(true);
    setError(null);
    setMessage("");
    try {
      const response = await fetch("/api/risk", {
        method,
        headers: { "content-type": "application/json", "x-risk-action": "nobitex-dashboard" },
        body: JSON.stringify(body)
      });
      const json = await response.json() as RiskSnapshotResponse & { error?: string; code?: string; blockers?: string[] };
      if (!response.ok) {
        const details = [...new Set(json.blockers ?? [])].map(item => riskBlockerLabels[item] ?? item);
        setError({ title: riskErrorTitle(json.error, json.code), details });
        return undefined;
      }
      publish(json);
      return json;
    } catch (reason) {
      setError(displayError(reason, "تغییر تنظیمات ریسک ناموفق بود"));
      return undefined;
    } finally {
      setSaving(false);
    }
  }

  async function saveLimits() {
    const maxDailyLossToman = normalizeNumber(dailyLoss);
    const maxConcurrentPositions = Math.floor(normalizeNumber(maxPositions));
    const consecutiveLosses = Math.floor(normalizeNumber(maxConsecutiveLosses));
    if (!(maxDailyLossToman > 0) || !(maxConcurrentPositions >= 1) || !(consecutiveLosses >= 1)) {
      setError({ title: "سقف زیان، زیان پیاپی و تعداد اجرای هم‌زمان باید بزرگ‌تر از صفر باشند." });
      return;
    }
    if (await riskRequest("PATCH", { limits: { maxDailyLossToman, maxConcurrentPositions, maxConsecutiveLosses: consecutiveLosses } })) {
      setMessage("محدودیت‌های سمت سرور ذخیره شد.");
    }
  }

  async function toggleStrategy(strategy: RiskStrategy) {
    if (!snapshot) return;
    const enabled = !snapshot.state.strategies[strategy].enabled;
    if (await riskRequest("PATCH", { strategies: { [strategy]: { enabled } } })) {
      setMessage(`اجرای واقعی «${strategyMeta[strategy].title}» ${enabled ? "روشن" : "خاموش"} شد.${enabled ? " شروع معامله به روشن بودن اجرای کلی و تأیید کنترل‌های ایمنی وابسته است." : " این موتور دیگر سفارش جدیدی ارسال نمی‌کند."}`);
    }
  }

  async function emergencyStop() {
    if (!window.confirm("توقف اضطراری، شروع همه معاملات جدید را فوراً متوقف می‌کند. ادامه می‌دهید؟")) return;
    if (await riskRequest("POST", { action: "emergency-stop", reason: "manual-dashboard-emergency-stop" })) {
      setMessage("توقف اضطراری فعال شد؛ اجرای کلی معاملات واقعی نیز خاموش شد.");
    }
  }

  async function toggleMaster() {
    if (!snapshot) return;
    const action = snapshot.state.masterArmed ? "disarm" : "arm";
    if (action === "arm" && !window.confirm("با روشن کردن اجرای کلی، موتورهای روشن و آماده اجازه ارسال سفارش واقعی پیدا می‌کنند. سود تضمین‌شده نیست. ادامه می‌دهید؟")) return;
    const next = await riskRequest("POST", { action });
    if (next) setMessage(action === "arm" ? "اجرای کلی معاملات واقعی روشن شد؛ فقط موتورهای روشن و آماده اجازه شروع معامله دارند." : "اجرای کلی معاملات واقعی خاموش شد؛ معامله جدیدی شروع نمی‌شود.");
  }

  async function resetEmergency() {
    if (!window.confirm("فقط پس از بررسی سفارش‌ها و دارایی‌های باز، توقف اضطراری را بازنشانی کنید. ادامه می‌دهید؟")) return;
    if (await riskRequest("POST", { action: "reset" })) {
      setMessage("توقف اضطراری بازنشانی شد؛ اجرای کلی همچنان خاموش است و در صورت نیاز باید دوباره روشن شود.");
    }
  }

  if (!snapshot) return <section className="risk-center panel"><div className="risk-loading"><RefreshCw className={loading ? "spin" : ""}/> در حال دریافت وضعیت ایمنی سرور…</div>{error && <RiskErrorAlert value={error}/>}</section>;

  const environment = snapshot.environment;
  const environmentLabel = environment?.kind === "mainnet" ? "Nobitex Mainnet" : "Custom / Unsupported API";

  return <section className={`risk-center ${strategyFilter ? "focused" : "global"}`}>
    {!strategyFilter && <section className={`risk-command panel ${snapshot.state.emergencyStop.active ? "emergency" : snapshot.state.masterArmed ? "armed" : "safe"}`}>
      <div className="risk-command-title">
        <span className="eyebrow">SERVER-SIDE RISK CONTROL</span>
        <h2><ShieldCheck/> مرکز کنترل ریسک و اجرای واقعی</h2>
        <p>اجرای کلی، اجازه ارسال سفارش واقعی را برای همه موتورهای روشن کنترل می‌کند.</p>
      </div>
      <div className="risk-master-state">
        {snapshot.state.emergencyStop.active ? <AlertOctagon/> : snapshot.state.masterArmed ? <KeyRound/> : <LockKeyhole/>}
        <div><span>MASTER LIVE</span><b>{snapshot.state.emergencyStop.active ? "توقف اضطراری فعال" : snapshot.state.masterArmed ? "اجرای واقعی روشن" : "اجرای واقعی خاموش"}</b><small>{snapshot.state.masterArmed ? "موتورهای روشن اجازه معامله دارند" : "هیچ سفارش جدیدی شروع نمی‌شود"}</small></div>
      </div>
      <div className="risk-emergency-actions">
        <button type="button" className={`master-risk-button ${snapshot.state.masterArmed ? "armed" : ""}`} onClick={() => void toggleMaster()} disabled={saving || snapshot.state.emergencyStop.active} aria-pressed={snapshot.state.masterArmed}>{snapshot.state.masterArmed ? <><LockKeyhole/> خاموش کردن اجرای واقعی</> : <><KeyRound/> روشن کردن اجرای واقعی</>}</button>
        <button type="button" className="emergency-button" onClick={() => void emergencyStop()} disabled={saving || snapshot.state.emergencyStop.active} aria-pressed={snapshot.state.emergencyStop.active}><ShieldOff/> توقف اضطراری</button>
        {snapshot.state.emergencyStop.active && <button type="button" className="reset-risk-button" onClick={() => void resetEmergency()} disabled={saving}><RotateCcw/> رفع توقف اضطراری</button>}
      </div>
    </section>}

    {message && <div className="risk-message">{message}</div>}
    {error && <RiskErrorAlert value={error}/>} 

    {!strategyFilter && <section className="risk-overview">
      <article><ServerCog/><div><span>محیط اجرا</span><b>{environmentLabel}</b><small>{!environment?.credentialsConfigured ? "Credentials تنظیم نشده" : snapshot.liveOwner?.heldByThisProcess ? "مالک یکتای Live: همین Runtime" : snapshot.liveOwner?.locked ? "مالک یکتای Live: Runtime دیگر" : "Live خاموش؛ قفل مالک آزاد است"}</small></div></article>
      <article><DatabaseZap/><div><span>زیان تحقق‌یافته امروز</span><b className={snapshot.state.daily.realizedPnlToman < 0 ? "negative" : "positive"}>{formatNumber(snapshot.state.daily.realizedPnlToman)} تومان</b><small>{formatNumber(snapshot.state.daily.tradeCount)} معامله · {formatNumber(snapshot.state.daily.consecutiveLosses)} زیان پیاپی</small></div></article>
      <article><Workflow/><div><span>اجرای هم‌زمان</span><b>{formatNumber(snapshot.activeLeases.length)} / {formatNumber(snapshot.state.limits.maxConcurrentPositions)}</b><small>فعال / مجاز</small></div></article>
      <article><ServerCog/><div><span>اسکن و اجرای خودکار</span><b>{snapshot.liveScheduler?.running ? "Scheduler فعال" : "Scheduler غیرفعال"}</b><small>{snapshot.liveScheduler?.running ? `آخرین نتیجه: ${schedulerOutcomeLabel(snapshot.liveScheduler.lastOutcome)}` : "اجرای واقعی فقط با Production Server فعال می‌شود"}</small></div></article>
      <article><ShieldCheck/><div><span>موتورهای آماده</span><b>{formatNumber(readyCount)} / {formatNumber(Object.keys(snapshot.state.strategies).length)}</b></div></article>
    </section>}

    {!strategyFilter && <section className="risk-limits panel">
      <div><span className="eyebrow">HARD LIMITS</span><h3>محدودیت‌های سراسری</h3></div>
      <label><span>حداکثر زیان روزانه <small>Max Daily Loss</small></span><div><input value={dailyLoss} inputMode="numeric" onChange={event => setDailyLoss(formatInput(normalizeNumber(event.target.value) || 0))}/><em>تومان</em></div></label>
      <label><span>حداکثر اجرای هم‌زمان <small>Max Concurrent Positions</small></span><div><input value={maxPositions} inputMode="numeric" onChange={event => setMaxPositions(event.target.value.replace(/\D/g, ""))}/><em>عدد</em></div></label>
      <label><span>حداکثر زیان پیاپی <small>Max Consecutive Losses</small></span><div><input value={maxConsecutiveLosses} inputMode="numeric" onChange={event => setMaxConsecutiveLosses(event.target.value.replace(/\D/g, ""))}/><em>معامله</em></div></label>
      <button type="button" onClick={() => void saveLimits()} disabled={saving}><Save/> {saving ? "در حال ذخیره…" : "ذخیره محدودیت‌ها"}</button>
    </section>}

    <section className="readiness-panel panel">
      <div className="section-title"><div><span className="eyebrow">LIVE CONTROL</span><h2>{strategyFilter ? "اجرای واقعی" : "کنترل موتورها"}</h2></div><button type="button" className="risk-refresh" onClick={() => void refresh()} disabled={loading}><RefreshCw className={loading ? "spin" : ""}/> تازه‌سازی</button></div>
      <div className="readiness-list">
        {(Object.keys(strategyMeta) as RiskStrategy[]).filter(strategy => !strategyFilter || strategy === strategyFilter).map(strategy => {
          const item = snapshot.state.strategies[strategy];
          const evaluation = snapshot.evaluation.strategies[strategy];
          const capability = snapshot.runtimeCapabilities?.[strategy];
          const runtimeUnavailable = capability?.scope === "unavailable" || evaluation.blockers.includes("runtime-execution-unavailable");
          const environmentSupported = (!capability || (
            capability.scope === "mainnet-only" && environment?.kind === "mainnet"
          )) && !evaluation.blockers.includes("runtime-environment-not-supported");
          const shadowOnly = strategy === "gapTrading";
          const runtimeCanExecute = evaluation.canExecute && environmentSupported && !runtimeUnavailable;
          const unavailableReason = capability?.blocker === "event-level-orderflow-and-calibration-incomplete"
            ? "فید event-level، کالیبراسیون آماری و مدل خروج هنوز برای اجرای واقعی تأیید نشده‌اند؛ تحلیل سایه ادامه دارد."
            : capability?.blocker === "durable-position-recovery-and-closed-toman-pnl-incomplete"
              ? "بازگشت مطمئن سرمایه به تومان پس از قطع برنامه هنوز کامل نیست."
              : "اجرای واقعی این موتور هنوز در دسترس نیست.";
          const foundationReady = item.readiness.positionStateReady
            && item.readiness.recoveryReady
            && item.readiness.executionAdapterReady;
          const status = snapshot.state.emergencyStop.active
            ? { tone: "emergency", title: "توقف اضطراری فعال است", detail: "قفل ایمنی سراسری فعال شده و هیچ موتور جدیدی معامله نمی‌کند." }
            : runtimeUnavailable
              ? { tone: "not-ready", title: shadowOnly ? "تحلیل سایه؛ بدون سفارش" : "فعلاً قابل اجرا نیست", detail: unavailableReason }
              : !item.enabled
                ? { tone: "disabled", title: "خاموش", detail: "معامله واقعی انجام نمی‌شود." }
                : !foundationReady
                  ? { tone: "not-ready", title: "فعلاً قابل اجرا نیست", detail: "زیرساخت اجرایی این موتور کامل نشده است." }
                  : !environmentSupported
                    ? { tone: "not-ready", title: "اتصال نامعتبر", detail: "اتصال رسمی نوبیتکس لازم است." }
                    : !snapshot.state.masterArmed
                      ? { tone: "waiting", title: "موتور روشن؛ اجرای کلی خاموش", detail: strategyFilter ? "برای شروع معامله، اجرای کلی را از بخش کنترل ریسک روشن کنید." : "اجرای کلی معاملات واقعی خاموش است." }
                      : runtimeCanExecute
                        ? { tone: "ready", title: "فعال و در حال پایش", detail: "فرصت معتبر به‌صورت خودکار اجرا می‌شود." }
                        : { tone: "not-ready", title: "متوقف توسط کنترل ریسک", detail: "شروع معامله جدید موقتاً مجاز نیست." };
          const meta = strategyMeta[strategy];
          const liveToggleLabel = runtimeUnavailable
            ? shadowOnly ? "ارسال سفارش غیرفعال است" : "اجرای واقعی در دسترس نیست"
            : item.enabled ? "خاموش کردن" : "روشن کردن";
          return <article className={`readiness-row ${runtimeCanExecute ? "executable" : "not-executable"}`} key={strategy}>
            <div className="readiness-engine"><span className={`status-dot ${runtimeCanExecute ? "online" : ""}`}/><div><b>{meta.title}</b><small>{meta.english}</small></div></div>
            <div className="readiness-result"><span className={`engine-status ${status.tone}`}>{status.title}</span><small>{status.detail}</small>{snapshot.state.emergencyStop.active && strategyFilter && <a className="engine-status-link" href="#risk">بررسی و بازنشانی در کنترل ریسک<ArrowLeft/></a>}</div>
            <div className="readiness-actions"><button type="button" className={`engine-live-toggle ${item.enabled && !runtimeUnavailable ? "on" : "off"}`} onClick={() => void toggleStrategy(strategy)} disabled={saving || runtimeUnavailable} aria-pressed={item.enabled && !runtimeUnavailable}><span className="toggle-indicator"/>{liveToggleLabel}</button></div>
            <details className="engine-guide"><summary>جزئیات و تنظیمات</summary><div className="engine-guide-grid"><dl><dt>روش کار</dt><dd>{meta.mechanism}</dd></dl><dl><dt>دارایی‌ها</dt><dd>{meta.assets}</dd></dl><dl><dt>شروع و پایان معامله</dt><dd>{meta.entryExit}</dd></dl><dl><dt>مدیریت خطا</dt><dd>{meta.recovery}</dd></dl><dl className="engine-guide-risk"><dt>ریسک‌های مهم</dt><dd>{meta.risks}</dd></dl></div></details>
          </article>;
        })}
      </div>
    </section>

    {!environment?.credentialsConfigured && <div className="risk-environment-warning"><Unplug/><span>کلیدهای API روی سرور تنظیم نشده‌اند؛ اسکن عمومی کار می‌کند اما هیچ آداپتر اجرایی قابل استفاده نیست.</span></div>}
  </section>;
}

function schedulerOutcomeLabel(outcome: LiveSchedulerStatus["lastOutcome"]) {
  if (!outcome) return "هنوز اسکن نشده";
  const labels: Record<NonNullable<LiveSchedulerStatus["lastOutcome"]>, string> = {
    "not-production": "محیط Production نیست",
    "master-disarmed": "اجرای کلی خاموش",
    "triangle-disabled": "Triangle خاموش",
    "risk-blocked": "متوقف توسط کنترل ریسک",
    "owner-not-held": "مالک Live در اختیار این سرور نیست",
    "in-flight": "اسکن قبلی در حال اجرا",
    "no-opportunity": "فرصت قابل اجرا نیست",
    busy: "یک اجرا در حال انجام است",
    rejected: "فرصت در بازبینی رد شد",
    executed: "چرخه اجرا شد",
    error: "خطای Scheduler"
  };
  return labels[outcome];
}
