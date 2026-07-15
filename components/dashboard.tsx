"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, BrainCircuit, CircleHelp, Clock3, Coins, Gauge, LayoutDashboard, RefreshCw, Settings2, ShieldAlert, Trash2, TrendingDown, TrendingUp, WalletCards, Waves, Workflow } from "lucide-react";
import type { BotSettings } from "@/lib/bot-settings";
import AiAgentCenter from "@/components/ai-agent-center";
import StrategyCenter, { type SerializedStrategySignal, type StrategyLabResult, type StrategyWorkspaceKey } from "@/components/strategy-center";
import type { RiskStrategy } from "@/lib/risk/types";
import RiskCenter, { type RiskSnapshotResponse } from "@/components/risk-center";

type Leg = { symbol: string; from: string; to: string; side: string; input: string; output: string; levelsUsed: number; totalLevels?: number; bestPrice?: string; worstPrice?: string; priceImpactBps?: string; spreadBps?: string; availableInput?: string; depthConsumedPercent?: string };
type Opportunity = { id: string; route: string[]; requestedInputToman: string; inputToman: string; outputToman: string; netProfitToman: string; profitBps: string; liquiditySafe: boolean; sizedByDepth: boolean; sizingMode: "optimized" | "diagnostic-minimum"; executable: boolean; rejectionReason?: string; legs: Leg[] };
type Result = { mode: "paper" | "live"; capitalToman: string; scannedAt: number; marketCount: number; triangleCount: number; evaluatedSizeCount: number; promisingPathCount: number; fastRejectedPathCount: number; refinedPathCount: number; positiveCount: number; liquiditySafePositiveCount: number; engineMs: number; executableCount: number; opportunities: Opportunity[]; strategyLab?: StrategyLabResult };
type Balance = { spotTotalToman: string; availableToman: string; blockedToman: string; fetchedAt: number };
type HistoryRecord = { id: number; mode: string; route: string[]; legs: Leg[]; firstSeenAt: number; lastSeenAt: number; detections: number; inputToman: number; latestOutputToman: number; latestProfitToman: number; latestProfitBps: number; bestProfitToman: number; bestProfitBps: number; executable: boolean; settings: Partial<BotSettings>; rejectionReason: string | null };
type OpportunityHistory = { summary: { recordCount: number; detectionCount: number; uniqueRouteCount: number; bestProfitToman: number; bestProfitBps: number }; records: HistoryRecord[] };
type ExecutionOrder = { symbol: string; side: string; orderId: string; status: string; input: string; expectedOutput: string; output: string; averagePrice: string; fee: string; slippageBuffer: string; levelsUsed: number; totalLevels: number; depthConsumedPercent: string; priceImpactBps: string; spreadBps: string };
type LiveExecutionRecord = { id: number; route: string[]; status: "PREPARING" | "RUNNING" | "COMPLETED" | "FAILED"; startedAt: number; completedAt: number | null; requestedInputToman: number; plannedInputToman: number | null; plannedOutputToman: number | null; plannedProfitToman: number | null; actualOutputToman: number | null; actualProfitToman: number | null; realizedOutputToman: number | null; realizedProfitToman: number | null; residualValueToman: number | null; residualInventory: Array<{ asset: string; amount: string }>; fullySettled: boolean | null; orders: ExecutionOrder[]; error: string | null };
type LiveExecutionHistory = { summary: { attemptCount: number; completedCount: number; failedCount: number; runningCount: number; totalActualProfitToman: number }; records: LiveExecutionRecord[] };
type StrategyExecutionState = "DETECTED" | "REVALIDATING" | "SUBMITTING" | "PARTIALLY_FILLED" | "HEDGING" | "RECOVERING" | "CLOSED" | "FAILED_MANUAL";
type StrategyExecutionOrder = { id: number; legIndex: number; symbol: string; side: string; orderType: string; status: string; clientOrderId: string | null; exchangeOrderId: string | null; requestedAmount: string | null; filledAmount: string | null; averagePrice: string | null; fee: string | null; inputAsset: string | null; outputAsset: string | null; createdAt: number };
type StrategyExecutionTransition = { id: number; fromState: StrategyExecutionState | null; toState: StrategyExecutionState; transitionedAt: number; note: string | null };
type StrategyExecutionRecord = { id: number; strategy: string; signalId: string | null; state: StrategyExecutionState; symbols: string[]; direction: string; detectedAt: number; updatedAt: number; closedAt: number | null; requestedCapitalToman: number | null; plannedProfitToman: number | null; actualOutputToman: number | null; actualProfitToman: number | null; error: string | null; metadata?: Record<string, unknown>; orders: StrategyExecutionOrder[]; transitions: StrategyExecutionTransition[] };
type StrategyExecutionHistory = { summary: { totalCount: number; activeCount: number; closedCount: number; failedManualCount: number; partiallyFilledCount: number; totalActualProfitToman: number }; records: StrategyExecutionRecord[] };
type NumericKey = "paperCapitalToman" | "maxTradeToman" | "balanceUsagePercent" | "tomanTakerFeeBps" | "usdtTakerFeeBps" | "slippageBufferBps" | "liveSafetyBufferBps" | "maxPriceImpactBps" | "maxSpreadBps" | "orderbookDepthUsagePercent" | "minProfitBps" | "minNetProfitToman" | "orderbookMaxAgeMs" | "scanIntervalMs" | "orderTimeoutMs";
type SettingField = { key: NumericKey; label: string; english: string; unit: string; description: string; increase: string; decrease: string; step?: number };
type DashboardView = "overview" | "triangle" | "gapTrading" | "imbalance" | "aiAgent" | "risk";
type EngineView = "triangle" | "gapTrading" | "imbalance";

const format = (value: string | number, digits = 0) => new Intl.NumberFormat("fa-IR", { maximumFractionDigits: digits }).format(Number(value));
const formatSettingNumber = (value: number) => new Intl.NumberFormat("en-US", {
  useGrouping: true,
  maximumFractionDigits: 8
}).format(value);

const executionStatusLabel = { PREPARING: "در حال بازبینی", RUNNING: "در حال اجرا", COMPLETED: "تکمیل‌شده", FAILED: "ناموفق" } as const;
const strategyExecutionStatusLabel: Record<StrategyExecutionState, string> = {
  DETECTED: "شناسایی‌شده",
  REVALIDATING: "بازاعتبارسنجی",
  SUBMITTING: "ارسال سفارش",
  PARTIALLY_FILLED: "پرشدن ناقص",
  HEDGING: "هج",
  RECOVERING: "بازیابی",
  CLOSED: "بسته‌شده",
  FAILED_MANUAL: "نیازمند بررسی"
};

const engineNavigation: Array<{ view: EngineView; title: string; english: string; icon: typeof LayoutDashboard; risk: RiskStrategy; workspace?: StrategyWorkspaceKey; storeStrategy?: string; signalKind?: SerializedStrategySignal["kind"] }> = [
  { view: "triangle", title: "آربیتراژ مثلثی", english: "Triangle", icon: Workflow, risk: "triangle" },
  { view: "gapTrading", title: "شکاف اردربوک", english: "Orderbook Gap", icon: Gauge, risk: "gapTrading", workspace: "gapTrading", storeStrategy: "gapTrading", signalKind: "orderbook-gap" },
  { view: "imbalance", title: "عدم‌تعادل اردربوک", english: "Imbalance", icon: Waves, risk: "imbalance", workspace: "imbalance", storeStrategy: "imbalance", signalKind: "orderbook-imbalance" }
];

function engineSignalCount(strategyLab: StrategyLabResult | undefined, engine: (typeof engineNavigation)[number]) {
  if (!strategyLab || !engine.signalKind) return 0;
  return strategyLab.signals.filter(signal => {
    if (signal.kind !== engine.signalKind) return false;
    if (engine.risk === "gapTrading") return signal.status === "watch" && signal.metrics.analyticalSetupPassed === true;
    return signal.status === "actionable";
  }).length;
}

function detectedOpportunityStatus(record: HistoryRecord) {
  if (record.executable) return "شرایط اسکن را پاس کرده؛ نتیجه بازبینی نهایی یا سفارش در لاگ معاملات واقعی ثبت می‌شود";
  if (record.rejectionReason) return `اجرا نشد: ${record.rejectionReason}`;
  return "اجرا نشد؛ این رکورد قدیمی snapshot معیارهای تاریخی ندارد";
}

function normalizeNumericInput(value: string) {
  return value.replace(/[,\s]/g, "").replace(/[^\d.]/g, "");
}
const settingGroups: Array<{ id: string; title: string; english: string; description: string; icon: typeof Coins; fields: SettingField[] }> = [
  {
    id: "capital", title: "سرمایه و اندازه معامله", english: "Capital & Position Sizing", description: "تعیین سقف پولی که در Paper یا Live وارد هر چرخه می‌شود.", icon: Coins,
    fields: [
      { key: "paperCapitalToman", label: "سرمایه فرضی", english: "Paper Capital", unit: "تومان", description: "سقف سرمایه‌ای که حالت Paper برای پیدا کردن و بهینه‌سازی مسیرها در نظر می‌گیرد.", increase: "سود عددی بالقوه بیشتر می‌شود، اما مصرف عمق و اثر قیمت نیز افزایش می‌یابد.", decrease: "مسیرها برای سرمایه کوچک‌تر سنجیده می‌شوند؛ ریسک نقدشوندگی کمتر ولی سود عددی محدودتر است." },
      { key: "maxTradeToman", label: "سقف معامله واقعی", english: "Max Live Trade", unit: "تومان", description: "حداکثر سرمایه مجاز برای یک چرخه واقعی، حتی اگر موجودی حساب بیشتر باشد.", increase: "اجازه استفاده از سرمایه بیشتر و در نتیجه exposure و ریسک اجرای بالاتر را می‌دهد.", decrease: "زیان احتمالی و فشار روی اردربوک را محدود می‌کند، اما سقف سود واقعی هم کمتر می‌شود." },
      { key: "balanceUsagePercent", label: "درصد استفاده از موجودی", english: "Balance Usage", unit: "درصد", description: "درصد موجودی آزاد تومان که Live اجازه دارد برای محاسبه سقف سرمایه استفاده کند.", increase: "بخش بزرگ‌تری از کیف پول در معرض معامله قرار می‌گیرد و حاشیه نقد آزاد کمتر می‌شود.", decrease: "سرمایه رزروشده بیشتری در کیف پول باقی می‌ماند و اجرای Live محافظه‌کارانه‌تر می‌شود.", step: 0.1 }
    ]
  },
  {
    id: "fees", title: "کارمزد و سودآوری", english: "Fees & Profitability", description: "هزینه‌های تخمینی و حداقل سود لازم برای قابل اجرا شدن مسیر.", icon: Gauge,
    fields: [
      { key: "tomanTakerFeeBps", label: "کارمزد تیکر بازار تومانی", english: "IRT Taker Fee", unit: "BPS", description: "کارمزد هر ضلع Market با quote تومانی؛ باید مطابق سطح کارمزدی واقعی حساب باشد.", increase: "محاسبه محافظه‌کارانه‌تر و تعداد فرصت‌ها کمتر می‌شود.", decrease: "فرصت بیشتری دیده می‌شود، اما مقدار کمتر از کارمزد واقعی سود را غیرواقعی نشان می‌دهد.", step: 0.1 },
      { key: "usdtTakerFeeBps", label: "کارمزد تیکر بازار تتری", english: "USDT Taker Fee", unit: "BPS", description: "کارمزد هر ضلع Market در بازارهای USDT نوبیتکس.", increase: "سود خالص تخمینی کاهش و فیلتر فرصت‌ها سخت‌تر می‌شود.", decrease: "سود تخمینی بیشتر می‌شود؛ فقط در صورت تطابق با سطح واقعی حساب کمش کنید.", step: 0.1 },
      { key: "slippageBufferBps", label: "بافر لغزش", english: "Slippage Buffer", unit: "BPS", description: "حاشیه ایمنی اضافه بر قیمت میانگین عمق برای تغییر بازار بین اسکن و پرشدن سفارش.", increase: "فرصت‌های کمتری پذیرفته می‌شوند ولی تحمل تغییرات لحظه‌ای بیشتر می‌شود.", decrease: "ربات تهاجمی‌تر می‌شود، اما احتمال محقق نشدن سود محاسبه‌شده بالاتر می‌رود.", step: 0.1 },
      { key: "liveSafetyBufferBps", label: "حاشیه ایمنی اجرای واقعی", english: "Live Safety Buffer", unit: "BPS", description: "سود اضافه‌ای که فقط در Live و بالاتر از Minimum Net Return لازم است تا تغییر قیمت میان سه سفارش را پوشش دهد.", increase: "ورود Live محافظه‌کارانه‌تر و احتمال زیان ناشی از تغییر لحظه‌ای کمتر می‌شود؛ معاملات نیز کمتر می‌شوند.", decrease: "فرصت‌های بیشتری اجرا می‌شوند، اما حاشیه دفاعی میان سه سفارش کاهش می‌یابد.", step: 0.1 },
      { key: "minProfitBps", label: "حداقل بازده خالص", english: "Minimum Net Return", unit: "BPS", description: "حداقل درصد سود خالص کل چرخه پس از عمق، کارمزد و لغزش.", increase: "فقط مسیرهای با حاشیه سود درصدی بیشتر اجرا می‌شوند و تعداد معاملات کم می‌شود.", decrease: "فرصت‌های کوچک‌تر هم اجرا می‌شوند، اما حاشیه خطا و تغییر بازار کمتر است.", step: 0.1 },
      { key: "minNetProfitToman", label: "حداقل سود خالص", english: "Minimum Net Profit", unit: "تومان", description: "حداقل سود عددی تومانی لازم برای قابل اجرا بودن چرخه.", increase: "معاملات کم‌سود حذف می‌شوند، حتی اگر درصد بازده خوبی داشته باشند.", decrease: "چرخه‌های با سود عددی کوچک‌تر پذیرفته می‌شوند و اثر هزینه‌های پیش‌بینی‌نشده مهم‌تر می‌شود." }
    ]
  },
  {
    id: "liquidity", title: "نقدشوندگی و کیفیت بازار", english: "Liquidity & Market Quality", description: "کنترل کیفیت اردربوک و میزان اتکای ربات به حجم قابل مشاهده.", icon: ShieldAlert,
    fields: [
      { key: "maxPriceImpactBps", label: "حداکثر اثر قیمت", english: "Max Price Impact", unit: "BPS", description: "بیشترین اختلاف مجاز بین بهترین قیمت و قیمت میانگین اجرای هر ضلع.", increase: "بازارهای کم‌عمق‌تر پذیرفته می‌شوند، اما قیمت میانگین اجرای بدتری خواهید داشت.", decrease: "فیلتر عمق سخت‌تر و اجرای سفارشها با کیفیت‌تر، ولی فرصت‌ها کمتر می‌شوند.", step: 0.1 },
      { key: "maxSpreadBps", label: "حداکثر اسپرد بازار", english: "Max Bid-Ask Spread", unit: "BPS", description: "حداکثر فاصله مجاز بین بهترین bid و ask هر بازار.", increase: "بازارهای کم‌نقدشونده و پرهزینه‌تری وارد محاسبات می‌شوند.", decrease: "فقط بازارهای فشرده‌تر پذیرفته می‌شوند و احتمال اجرای مناسب بیشتر است.", step: 0.1 },
      { key: "orderbookDepthUsagePercent", label: "سهم مجاز از عمق بازار", english: "Usable Orderbook Depth", unit: "درصد", description: "درصدی از حجم قابل مشاهده هر سطح که ربات قابل اتکا فرض می‌کند؛ باقی‌مانده reserve است.", increase: "سرمایه بیشتری قابل اجرا دیده می‌شود، اما ریسک حذف سفارش‌های اردربوک قبل از fill بالا می‌رود.", decrease: "حاشیه نقدشوندگی امن‌تر می‌شود، ولی اندازه بهینه و تعداد فرصت‌ها کاهش می‌یابد.", step: 0.1 },
      { key: "orderbookMaxAgeMs", label: "حداکثر عمر اردربوک", english: "Max Orderbook Age", unit: "ms", description: "قدیمی‌ترین داده بازار که هنوز برای قیمت‌گذاری معتبر شناخته می‌شود.", increase: "داده‌های قدیمی‌تر پذیرفته می‌شوند و ریسک تصمیم با قیمت منقضی بالا می‌رود.", decrease: "تازگی داده سخت‌گیرانه‌تر می‌شود، اما بازارهای کم‌فعال بیشتر رد خواهند شد." }
    ]
  },
  {
    id: "timing", title: "زمان‌بندی و اجرای سفارش", english: "Timing & Execution", description: "سرعت اسکن بازار و مدت انتظار برای تعیین تکلیف سفارش واقعی.", icon: Clock3,
    fields: [
      { key: "scanIntervalMs", label: "فاصله اسکن خودکار", english: "Scan Interval", unit: "ms", description: "فاصله شروع اسکن‌های بازار؛ حداقل مجاز برنامه ۱۰۰۰ میلی‌ثانیه است.", increase: "بار API و CPU کمتر می‌شود، اما فرصت‌های کوتاه‌مدت دیرتر شناسایی می‌شوند.", decrease: "واکنش سریع‌تر می‌شود، ولی فشار روی API بیشتر است و کمتر از یک ثانیه مجاز نیست." },
      { key: "orderTimeoutMs", label: "مهلت تکمیل سفارش", english: "Order Timeout", unit: "ms", description: "حداکثر زمان انتظار برای نهایی شدن سفارش واقعی قبل از تلاش برای لغو آن.", increase: "فرصت بیشتری برای fill می‌دهد، اما چرخه مدت بیشتری در وضعیت باز می‌ماند.", decrease: "سفارش زودتر تعیین تکلیف می‌شود، ولی احتمال لغو یا partial fill بیشتر است." }
    ]
  }
];

export default function Dashboard() {
  const [settings, setSettings] = useState<BotSettings>();
  const [data, setData] = useState<Result>();
  const [balance, setBalance] = useState<Balance>();
  const [history, setHistory] = useState<OpportunityHistory>();
  const [liveExecutions, setLiveExecutions] = useState<LiveExecutionHistory>();
  const [strategyExecutions, setStrategyExecutions] = useState<StrategyExecutionHistory>();
  const [riskSnapshot, setRiskSnapshot] = useState<RiskSnapshotResponse>();
  const [mode, setMode] = useState<"paper" | "live">("paper");
  const [activeView, setActiveView] = useState<DashboardView>("overview");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [executionMessage, setExecutionMessage] = useState("");
  const [error, setError] = useState("");
  const [balanceError, setBalanceError] = useState("");
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [openSettingHint, setOpenSettingHint] = useState<NumericKey | null>(null);
  const [clearingHistory, setClearingHistory] = useState(false);
  const [clearingExecutionHistory, setClearingExecutionHistory] = useState(false);
  const [purgingDatabase, setPurgingDatabase] = useState(false);
  const settingsRef = useRef<BotSettings | undefined>(undefined);
  const scanInFlight = useRef(false);
  const modeRef = useRef<"paper" | "live">("paper");

  useEffect(() => {
    void fetch("/api/settings", { cache: "no-store" })
      .then(async response => {
        const json = await response.json();
        if (!response.ok) throw new Error(json.error ?? "خطا در دریافت تنظیمات");
        setSettings(json); settingsRef.current = json;
      })
      .catch(reason => setError(reason instanceof Error ? reason.message : "خطا در دریافت تنظیمات"));
  }, []);

  useEffect(() => { settingsRef.current = settings; }, [settings]);

  useEffect(() => {
    const syncHash = () => {
      const requested = window.location.hash.slice(1);
      const rawView = requested.startsWith("strategy-") ? requested.replace("strategy-", "") : requested;
      const requestedView = ({ "market-making": "gapTrading", "orderbook-gap": "gapTrading" } as Record<string, string>)[rawView] ?? rawView;
      if (["overview", "triangle", "gapTrading", "imbalance", "aiAgent", "risk"].includes(requestedView)) {
        setActiveView(requestedView as DashboardView);
      }
    };
    syncHash();
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, []);

  useEffect(() => {
    if (!settings) return;
    setSaving(true); setSaved(false);
    const timer = window.setTimeout(() => {
      void fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(settings) })
        .then(async response => {
          const json = await response.json();
          if (!response.ok) throw new Error(json.error ?? "خطا در ذخیره تنظیمات");
          setSaved(true);
        })
        .catch(reason => setError(reason instanceof Error ? reason.message : "خطا در ذخیره تنظیمات"))
        .finally(() => setSaving(false));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [settings]);

  const fetchRisk = useCallback(async () => {
    try {
      const response = await fetch("/api/risk", { cache: "no-store" });
      const json = await response.json() as RiskSnapshotResponse & { error?: string };
      if (!response.ok) throw new Error(json.error ?? "خطا در دریافت وضعیت Risk");
      setRiskSnapshot(json);
      const triangleLive = json.state.masterArmed && json.evaluation.strategies.triangle.canExecute;
      if (triangleLive && modeRef.current !== "live") {
        modeRef.current = "live";
        setMode("live");
        setExecutionMessage("اجرای خودکار سمت سرور فعال است؛ آربیتراژ مثلثی بدون وابستگی به باز بودن مرورگر پایش می‌شود.");
      } else if (!triangleLive && modeRef.current === "live") {
        modeRef.current = "paper";
        setMode("paper");
        setExecutionMessage("اجرای واقعی سمت سرور متوقف است؛ داشبورد فقط اسکن و نمایش را ادامه می‌دهد.");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "ارتباط داشبورد با کنترل ریسک قطع شد؛ وضعیت Runtime سرور نامشخص است.");
    }
  }, []);

  useEffect(() => {
    void fetchRisk();
    const timer = window.setInterval(() => void fetchRisk(), 5_000);
    return () => window.clearInterval(timer);
  }, [fetchRisk]);

  const fetchBalance = useCallback(async () => {
    try {
      setBalanceLoading(true);
      setBalanceError("");
      const response = await fetch("/api/balance", { cache: "no-store" });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "خطا در دریافت موجودی");
      setBalance(json);
    } catch (reason) {
      setBalanceError(reason instanceof Error ? reason.message : "خطا در دریافت موجودی");
    } finally {
      setBalanceLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchBalance();
    // Wallet equity matters most while orders are live. Keep it fresh in both
    // modes; the manual refresh remains available for an immediate read.
    const timer = window.setInterval(() => void fetchBalance(), 15_000);
    return () => window.clearInterval(timer);
  }, [fetchBalance]);

  const fetchHistory = useCallback(async () => {
    try {
      const response = await fetch("/api/opportunities?limit=50", { cache: "no-store" });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "خطا در دریافت تاریخچه فرصت‌ها");
      setHistory(json);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "خطا در دریافت تاریخچه فرصت‌ها");
    }
  }, []);

  const fetchLiveExecutions = useCallback(async () => {
    try {
      const response = await fetch("/api/executions?limit=50", { cache: "no-store" });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "خطا در دریافت لاگ معاملات واقعی");
      setLiveExecutions(json);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "خطا در دریافت لاگ معاملات واقعی");
    }
  }, []);

  const fetchStrategyExecutions = useCallback(async () => {
    try {
      const response = await fetch("/api/strategy-executions?limit=50", { cache: "no-store" });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "خطا در دریافت Position State موتورهای جدید");
      setStrategyExecutions(json);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "خطا در دریافت Position State موتورهای جدید");
    }
  }, []);

  const clearDetectedHistory = useCallback(async () => {
    if (!window.confirm("تمام جزئیات و شمارنده‌های فرصت‌های شناسایی‌شده پاک شوند؟ لاگ معاملات واقعی حذف نخواهد شد.")) return;
    setClearingHistory(true);
    setError("");
    try {
      const response = await fetch("/api/opportunities", {
        method: "DELETE",
        headers: { "x-history-action": "clear-opportunity-history" }
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "خطا در پاک‌سازی تاریخچه فرصت‌ها");
      setHistory(json.history);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "خطا در پاک‌سازی تاریخچه فرصت‌ها");
    } finally {
      setClearingHistory(false);
    }
  }, []);

  const clearExecutionHistory = useCallback(async () => {
    if (!window.confirm("تاریخچه اجراهای نهایی و تلاش‌های متوقف‌شده پیش از ارسال سفارش پاک شود؟ رکوردهای دارای سفارش باز، Recovery یا ابهام در وضعیت صرافی برای ایمنی باقی می‌مانند.")) return;
    setClearingExecutionHistory(true);
    setError("");
    try {
      const response = await fetch("/api/executions", {
        method: "DELETE",
        headers: { "x-history-action": "clear-execution-history" }
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "خطا در پاک‌سازی تاریخچه اجراها");
      setLiveExecutions(json.liveExecutions);
      setStrategyExecutions(json.strategyExecutions);
      const deletedCount = Number(json.deletedCount?.total ?? 0);
      const remainingCount = Number(json.remainingCount ?? 0);
      setExecutionMessage(deletedCount > 0
        ? `${format(deletedCount)} رکورد از تاریخچه اجراها پاک شد${remainingCount > 0 ? `؛ ${format(remainingCount)} رکورد دارای سفارش یا وضعیت باز برای ایمنی حفظ شد.` : "."}`
        : remainingCount > 0
          ? `رکورد قابل‌حذفی وجود نداشت؛ ${format(remainingCount)} رکورد دارای سفارش یا وضعیت باز برای ایمنی حفظ شد.`
          : "تاریخچه اجراها از قبل خالی بود.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "خطا در پاک‌سازی تاریخچه اجراها");
    } finally {
      setClearingExecutionHistory(false);
    }
  }, []);

  const purgeAllDatabaseData = useCallback(async () => {
    if (riskSnapshot?.state.masterArmed) {
      setError("برای حذف کامل دیتابیس ابتدا اجرای کلی معاملات واقعی را خاموش کنید.");
      return;
    }
    if (!window.confirm("تمام فرصت‌ها، اجراها، سفارش‌ها، تغییر وضعیت‌ها و Audit Ledger برای همیشه حذف شوند؟ این عملیات قابل بازگشت نیست.")) return;
    const phrase = window.prompt("برای تأیید نهایی عبارت DELETE ALL DATA را دقیقاً وارد کنید:");
    if (phrase !== "DELETE ALL DATA") {
      if (phrase !== null) setError("عبارت تأیید صحیح نبود؛ هیچ دیتایی حذف نشد.");
      return;
    }

    setPurgingDatabase(true);
    setError("");
    try {
      const response = await fetch("/api/admin/database", {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          "x-admin-action": "purge-all-database-data"
        },
        body: JSON.stringify({ confirmation: "DELETE_ALL_DATABASE_DATA" })
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "خطا در حذف کامل دیتابیس");
      await Promise.all([fetchHistory(), fetchLiveExecutions(), fetchStrategyExecutions()]);
      setExecutionMessage(`${format(Number(json.deleted?.total ?? 0))} رکورد دیتابیس برای همیشه حذف شد. تنظیمات، Risk State و اطلاعات اتصال حفظ شدند.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "خطا در حذف کامل دیتابیس");
    } finally {
      setPurgingDatabase(false);
    }
  }, [fetchHistory, fetchLiveExecutions, fetchStrategyExecutions, riskSnapshot?.state.masterArmed]);

  useEffect(() => {
    void fetchHistory();
    void fetchLiveExecutions();
    void fetchStrategyExecutions();
    const timer = window.setInterval(() => { void fetchHistory(); void fetchLiveExecutions(); void fetchStrategyExecutions(); }, 10_000);
    return () => window.clearInterval(timer);
  }, [fetchHistory, fetchLiveExecutions, fetchStrategyExecutions]);

  const runScan = useCallback(async () => {
    if (scanInFlight.current || !settingsRef.current) return;
    scanInFlight.current = true; setLoading(true); setError("");
    try {
      const response = await fetch("/api/scan", { method: "POST", headers: { "content-type": "application/json", "x-bot-mode": modeRef.current }, body: JSON.stringify(settingsRef.current) });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "خطا در اسکن");
      setData(json);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "خطای ناشناخته";
      setError(message);
    }
    finally { scanInFlight.current = false; setLoading(false); }
  }, []);

  useEffect(() => {
    if (!settings) return;
    void runScan();
    const timer = window.setInterval(() => void runScan(), Math.max(1_000, settings.scanIntervalMs));
    return () => window.clearInterval(timer);
  }, [runScan, settings?.scanIntervalMs, Boolean(settings)]);

  function updateNumber(key: NumericKey, value: string) {
    const normalized = normalizeNumericInput(value);
    const parsed = Number(normalized);
    if (normalized !== "" && !Number.isFinite(parsed)) return;
    setSaved(false);
    setSettings(current => current ? { ...current, [key]: normalized === "" ? 0 : parsed } : current);
  }

  function updateStrategyLab(strategyLab: BotSettings["strategyLab"]) {
    setSaved(false);
    setSettings(current => current ? { ...current, strategyLab } : current);
  }

  function updateAiAgent(aiAgent: BotSettings["aiAgent"]) {
    setSaved(false);
    setSettings(current => current ? { ...current, aiAgent } : current);
  }

  function handleRiskSnapshot(next: RiskSnapshotResponse) {
    setRiskSnapshot(next);
    const triangleLive = next.state.masterArmed && next.evaluation.strategies.triangle.canExecute;
    if (triangleLive && modeRef.current !== "live") {
      modeRef.current = "live";
      setMode("live");
      setExecutionMessage("اجرای خودکار سمت سرور فعال است؛ بستن تب مرورگر اجرای مجاز سرور را متوقف نمی‌کند.");
      void runScan();
    } else if (!triangleLive && modeRef.current === "live") {
      modeRef.current = "paper";
      setMode("paper");
      setExecutionMessage("اجرای واقعی سمت سرور متوقف است؛ اسکن نمایشی ادامه دارد.");
    }
  }

  const activeEngine = engineNavigation.find(engine => engine.view === activeView);
  const ActiveEngineIcon = activeEngine?.icon;
  const activeEngineStatus = !activeEngine || !riskSnapshot
    ? { tone: "loading", label: "در حال دریافت وضعیت…" }
    : activeEngine.risk === "gapTrading"
      ? settings?.strategyLab.gapTrading.enabled
        ? { tone: "paused", label: "تحلیل سایه فعال · بدون سفارش" }
        : { tone: "disabled", label: "اسکن شکاف خاموش است" }
    : riskSnapshot.state.emergencyStop.active
      ? { tone: "emergency", label: "توقف اضطراری فعال است" }
      : riskSnapshot.evaluation.strategies[activeEngine.risk].canExecute
        ? { tone: "online", label: "فعال و در حال پایش" }
        : !riskSnapshot.state.strategies[activeEngine.risk].enabled
          ? { tone: "disabled", label: "موتور خاموش است" }
          : !riskSnapshot.state.masterArmed
            ? { tone: "paused", label: "موتور روشن؛ اجرای کلی خاموش است" }
            : { tone: "blocked", label: "فعلاً آماده اجرا نیست" };
  const activeStrategyRecords = activeEngine
    ? strategyExecutions?.records.filter(record => activeEngine.view !== "triangle" && record.strategy === activeEngine.storeStrategy) ?? []
    : [];

  return <main>
    <header className="hero">
      <div className="brand"><div className="logo">△</div><div><span className="eyebrow">NOBITEX STRATEGY TERMINAL</span><h1>میز کنترل معاملات الگوریتمی</h1></div></div>
    </header>

    <nav className="dashboard-nav engine-nav" aria-label="بخش‌های مدیریتی داشبورد">
      <button type="button" className={activeView === "overview" ? "active" : ""} onClick={() => { setActiveView("overview"); window.history.replaceState(null, "", "#overview"); }} aria-current={activeView === "overview" ? "page" : undefined}><LayoutDashboard/><span>نمای مدیریتی</span></button>
      {engineNavigation.map(engine => {
        const Icon = engine.icon;
        const badge = engine.view === "triangle"
          ? data?.executableCount ?? 0
          : engineSignalCount(data?.strategyLab, engine);
        return <button type="button" key={engine.view} className={activeView === engine.view ? "active" : ""} onClick={() => { setActiveView(engine.view); window.history.replaceState(null, "", `#${engine.view}`); }} aria-current={activeView === engine.view ? "page" : undefined} title={engine.english}><Icon/><span>{engine.title}</span>{badge > 0 && <em>{format(badge)}</em>}</button>;
      })}
      <button type="button" className={activeView === "aiAgent" ? "active" : ""} onClick={() => { setActiveView("aiAgent"); window.history.replaceState(null, "", "#aiAgent"); }} aria-current={activeView === "aiAgent" ? "page" : undefined} title="Autonomous Spot Agent"><BrainCircuit/><span>دستیار هوشمند</span></button>
      <button type="button" className={activeView === "risk" ? "active" : ""} onClick={() => { setActiveView("risk"); window.history.replaceState(null, "", "#risk"); }} aria-current={activeView === "risk" ? "page" : undefined}><ShieldAlert/><span>کنترل ریسک</span></button>
    </nav>

    {activeView === "risk" && <RiskCenter snapshot={riskSnapshot} onSnapshot={handleRiskSnapshot}/>} 

    {activeView === "aiAgent" && settings && <AiAgentCenter
      settings={settings.aiAgent}
      saving={saving}
      saved={saved}
      onChange={updateAiAgent}
      onOpenRisk={() => { setActiveView("risk"); window.history.replaceState(null, "", "#risk"); }}
    />}

    {activeEngine && <>
      <section className="engine-workspace-banner panel"><div className="engine-workspace-title">{ActiveEngineIcon && <ActiveEngineIcon/>}<div><span className="eyebrow">ENGINE WORKSPACE</span><h2>{activeEngine.title}<small>{activeEngine.english}</small></h2></div></div><div className={`engine-workspace-state ${activeEngineStatus.tone}`}><span className={`status-dot ${activeEngineStatus.tone}`}/><b>{activeEngineStatus.label}</b></div></section>
      <RiskCenter snapshot={riskSnapshot} onSnapshot={handleRiskSnapshot} strategyFilter={activeEngine.risk}/>
    </>}

    {activeView === "triangle" && <section className="settings-panel panel">
      <div className="settings-head"><div><span className="eyebrow">BOT CONTROL</span><h2><Settings2/> تنظیمات ربات</h2><p>همه ارزهای موجود در بازار بررسی می‌شوند و تغییرات به‌صورت خودکار ذخیره می‌شوند.</p></div><span className="save-state">{saving ? "در حال ذخیره…" : saved ? "تنظیمات ذخیره شد" : ""}</span></div>
      {!settings ? <div className="settings-loading">در حال بارگذاری تنظیمات…</div> : <>
        <div className="settings-groups">{settingGroups.map(group => {
          const GroupIcon = group.icon;
          return <section className="setting-group" key={group.id}>
            <header className="setting-group-head"><GroupIcon/><div><h3>{group.title}<span>{group.english}</span></h3><p>{group.description}</p></div></header>
            <div className="setting-group-grid">{group.fields.map(field => {
              const hintOpen = openSettingHint === field.key;
              return <div className={`setting-field ${hintOpen ? "hint-open" : ""}`} key={field.key}>
                <div className="setting-meta"><label htmlFor={`setting-${field.key}`}><b>{field.label}</b><small>{field.english}</small></label><button type="button" className="setting-help" onClick={() => setOpenSettingHint(current => current === field.key ? null : field.key)} aria-expanded={hintOpen} aria-controls={`hint-${field.key}`} title={`راهنمای ${field.english}`}><CircleHelp/></button></div>
                <div className="setting-input"><input id={`setting-${field.key}`} type="text" inputMode={field.step && field.step < 1 ? "decimal" : "numeric"} value={formatSettingNumber(settings[field.key])} onChange={event => updateNumber(field.key, event.target.value)}/><em>{field.unit}</em></div>
                {hintOpen && <div className="setting-hint" id={`hint-${field.key}`}><p>{field.description}</p><div><span className="hint-up"><TrendingUp/><b>اگر بیشتر شود</b><small>{field.increase}</small></span><span className="hint-down"><TrendingDown/><b>اگر کمتر شود</b><small>{field.decrease}</small></span></div></div>}
              </div>;
            })}</div>
          </section>;
        })}</div>
      </>}
    </section>}

    {activeView === "overview" && <div className={`notice ${riskSnapshot?.state.masterArmed ? "live-notice" : ""}`}><AlertTriangle size={20}/><div><b>{riskSnapshot?.state.masterArmed ? "اجرای کلی معاملات واقعی روشن است." : "اجرای کلی معاملات واقعی خاموش است؛ اسکن آزمایشی ادامه دارد."}</b><span>{riskSnapshot?.state.masterArmed ? `فقط موتورهای روشن و آماده می‌توانند سفارش بفرستند؛ آربیتراژ مثلثی اکنون ${mode === "live" ? "در حالت اجرای خودکار" : "در حالت آزمایشی"} است.` : "اسکن از اردربوک واقعی استفاده می‌کند، اما تا اجرای کلی روشن نشود سفارشی ارسال نمی‌شود."}</span></div></div>}
    {executionMessage && (activeView === "overview" || activeView === "triangle") && <div className={`execution-message ${mode === "live" ? "active" : "paused"}`}>{executionMessage}</div>}
    {error && <div className="error">{error}</div>}

    {activeEngine?.workspace && settings && <StrategyCenter only={activeEngine.workspace} settings={settings.strategyLab} result={data?.strategyLab} onChange={updateStrategyLab} saving={saving} saved={saved}/>}
    {activeEngine?.workspace && <StrategyExecutionLog title={activeEngine.title} records={activeStrategyRecords}/>}

    {data && <>
      {activeView === "overview" && <>
      <section className="stats"><article className={`balance-card ${balanceError ? "balance-error" : ""}`}><span><WalletCards/> ارزش کل کیف اسپات <button type="button" className="balance-refresh" onClick={() => void fetchBalance()} disabled={balanceLoading} title="به‌روزرسانی موجودی" aria-label="به‌روزرسانی موجودی"><RefreshCw className={balanceLoading ? "spin" : ""}/></button></span><b>{balanceError ? "خطا در دریافت موجودی" : balance ? `${format(balance.spotTotalToman)} تومان` : "در حال دریافت…"}</b>{balance && !balanceError && <small>تومان نقد آزاد: {format(balance.availableToman, 2)}</small>}{balanceError && <small title={balanceError}>{balanceError}</small>}</article><article><span>پوشش اسکن بازار</span><b>{format(data.marketCount)} بازار</b><small>{format(data.triangleCount)} چرخه · {format(data.evaluatedSizeCount)} سناریوی سرمایه · Engine {format(data.engineMs)}ms</small></article><article><span>کل تشخیص‌های سود مثبت</span><b>{format(history?.summary.detectionCount ?? 0)}</b><small>تاریخی و شامل مشاهده‌های تکراری</small></article><article><span>زمان اسکن</span><b>{new Date(data.scannedAt).toLocaleTimeString("fa-IR")}</b><small>{format(data.positiveCount)} مثبت · {format(data.liquiditySafePositiveCount)} نقدشونده · {format(data.refinedPathCount)} مسیر refine شده</small></article></section>
      <EngineManagementOverview engines={engineNavigation} risk={riskSnapshot} strategyLab={data.strategyLab} triangleActionableCount={data.executableCount} strategyExecutions={strategyExecutions} liveExecutions={liveExecutions} clearingHistory={clearingExecutionHistory} onClearHistory={() => void clearExecutionHistory()} onOpen={view => { setActiveView(view); window.history.replaceState(null, "", `#${view}`); }}/>
      <section className="database-danger-zone panel">
        <div className="database-danger-icon"><ShieldAlert/></div>
        <div className="database-danger-content"><span className="eyebrow">DATABASE MANAGEMENT</span><h2>حذف کامل داده‌های دیتابیس</h2><p>همه فرصت‌ها، معاملات، Order IDها، رویدادهای وضعیت و Audit Ledger حذف می‌شوند. تنظیمات ربات، Risk State، موجودی صرافی و کلیدهای API دست‌نخورده می‌مانند.</p><small>فقط با اجرای کلی خاموش و بدون معامله، Recovery یا Lease فعال قابل انجام است.</small></div>
        <button type="button" className="database-purge-button" onClick={() => void purgeAllDatabaseData()} disabled={purgingDatabase || riskSnapshot?.state.masterArmed} title={riskSnapshot?.state.masterArmed ? "ابتدا اجرای کلی معاملات واقعی را خاموش کنید" : "حذف دائمی همه رکوردهای دیتابیس"}><Trash2/>{purgingDatabase ? "در حال حذف…" : "حذف کامل دیتابیس"}</button>
      </section>
      </>}
      {activeView === "triangle" && <>
      <section className="results"><div className="section-title"><div><span className="eyebrow">LIVE ORDER BOOK</span><h2>بهترین مسیرها</h2></div><span>{data.mode === "live" ? `اسکن واقعی با سقف ${format(data.capitalToman)} تومان` : `اسکن فرضی با سقف ${format(data.capitalToman)} تومان`} · عمق، اسپرد، اثر قیمت، کارمزد و لغزش لحاظ شده</span></div>
        {!data.opportunities.length && <div className="empty">برای این مبلغ هیچ مسیر سه‌مرحله‌ای با عمق و داده تازه پیدا نشد.</div>}
        {data.opportunities.map((opportunity, index) => <article className={`opportunity ${opportunity.executable ? "good" : ""}`} key={opportunity.id}>
          <div className="rank">{format(index + 1)}</div><div className="route">{opportunity.route.map((asset, i) => <span key={`${asset}-${i}`}><b>{asset === "IRT" ? "تومان" : asset}</b>{i < opportunity.route.length - 1 && <ArrowLeft/>}</span>)}</div>
          <div className="money"><span>خروجی</span><b>{format(opportunity.outputToman)} تومان</b></div><div className={`profit ${Number(opportunity.netProfitToman) >= 0 ? "positive" : "negative"}`}><span>سود خالص</span><b>{format(opportunity.netProfitToman)} تومان</b><small>{format(Number(opportunity.profitBps) / 100, 3)}٪</small></div>
          <div className="status"><span>{opportunity.executable ? "قابل اجرا با عمق فعلی" : opportunity.rejectionReason}</span>{opportunity.sizingMode === "diagnostic-minimum" ? <span className="sizing diagnostic">تست سریع حداقل سفارش: {format(opportunity.inputToman)} تومان · این عدد سرمایه پیشنهادی معامله نیست</span> : <span className="sizing">سرمایه بهینه: {format(opportunity.inputToman)} تومان از سقف {format(opportunity.requestedInputToman)} تومان{opportunity.sizedByDepth ? " · برای نقدشوندگی بهینه شد" : ""}</span>}</div><details><summary>جزئیات عمق سه سفارش</summary><div className="legs">{opportunity.legs.map((leg, i) => <div key={leg.symbol}><span>{i + 1}. {leg.from} ← {leg.to}</span><b>{leg.side} {leg.symbol}</b><small>{format(leg.levelsUsed)} از {format(leg.totalLevels ?? leg.levelsUsed)} سطح · مصرف عمق {format(leg.depthConsumedPercent ?? 0, 2)}٪</small><small>اثر قیمت {format(Number(leg.priceImpactBps ?? 0) / 100, 3)}٪ · اسپرد {format(Number(leg.spreadBps ?? 0) / 100, 3)}٪</small><small>ورودی {format(leg.input, 8)} {leg.from} ← خروجی {format(leg.output, 8)} {leg.to}</small></div>)}</div></details>
        </article>)}
      </section>
      </>}
      {activeView === "triangle" && <>
      <section className="execution-panel panel">
        <div className="section-title"><div><span className="eyebrow">REAL TRADE LOG</span><h2>لاگ معاملات واقعی</h2><small className="section-note">PnL اقتصادی شامل ارزش ماندهٔ Dust است؛ فقط ردیف «کاملاً تسویه‌شده» سود نقدی قطعی دارد.</small></div><span>{format(liveExecutions?.summary.completedCount ?? 0)} تکمیل‌شده از {format(liveExecutions?.summary.attemptCount ?? 0)} تلاش · PnL اقتصادی ثبت‌شده {format(liveExecutions?.summary.totalActualProfitToman ?? 0)} تومان</span></div>
        {!liveExecutions?.records.length ? <div className="empty">هنوز هیچ اجرای واقعی آغاز نشده است.</div> : <div className="execution-list">{liveExecutions.records.map(record => <article className={`execution-row ${record.status.toLowerCase()}`} key={record.id}>
          <div><span className={`execution-status ${record.status.toLowerCase()}`}>{executionStatusLabel[record.status]}</span><b>معامله واقعی #{format(record.id)}</b><div className="history-route">{record.route.map((asset, index) => <span key={`${asset}-${index}`}>{asset === "IRT" ? "تومان" : asset}{index < record.route.length - 1 ? " ← " : ""}</span>)}</div><small>{new Date(record.startedAt).toLocaleString("fa-IR")}</small></div>
          <div><span>سرمایه بهینه</span><b>{record.plannedInputToman === null ? "—" : `${format(record.plannedInputToman)} تومان`}</b><small>سقف واقعی: {format(record.requestedInputToman)} تومان</small></div>
          <div><span>سود برنامه‌ریزی‌شده</span><b>{record.plannedProfitToman === null ? "—" : `${format(record.plannedProfitToman)} تومان`}</b><small>{record.orders.length} سفارش ثبت‌شده در لاگ</small></div>
          <div><span>PnL اقتصادی</span><b className={record.actualProfitToman !== null && record.actualProfitToman >= 0 ? "positive" : "negative"}>{record.actualProfitToman === null ? "—" : `${format(record.actualProfitToman)} تومان`}</b><small>{record.fullySettled === true ? `کاملاً تسویه‌شده · سود نقدی ${format(record.realizedProfitToman ?? record.actualProfitToman ?? 0)} تومان` : record.fullySettled === false ? `تسویه‌نشده · نقدی ${format(record.realizedProfitToman ?? 0)} · مانده ${format(record.residualValueToman ?? 0)} تومان` : record.completedAt ? "رکورد قدیمی؛ وضعیت مانده مشخص نیست" : "در انتظار نتیجه نهایی"}</small></div>
          {record.error && <div className="execution-error">{record.error}</div>}
          <details><summary>سفارش‌های واقعی و شناسه‌های نوبیتکس</summary>{!record.orders.length ? <div className="no-orders">هنوز سفارشی ارسال یا تکمیل نشده است.</div> : <div className="execution-orders">{record.orders.map((order, index) => <div key={`${order.orderId}-${index}`}><span>{index + 1}. {order.side} {order.symbol}</span><b>Order ID: {order.orderId}</b><small>وضعیت: {order.status} · خروجی واقعی: {format(order.output, 8)}</small><small>اثر قیمت {format(Number(order.priceImpactBps) / 100, 3)}٪ · اسپرد {format(Number(order.spreadBps) / 100, 3)}٪ · {format(order.levelsUsed)} سطح</small></div>)}</div>}</details>
        </article>)}</div>}
      </section>
      <section className="history-panel panel">
        <div className="section-title"><div><span className="eyebrow">OPPORTUNITY DETECTIONS</span><h2>تاریخچه فرصت‌های شناسایی‌شده</h2><small className="section-note">برچسب Live فقط یعنی فرصت هنگام اسکن Live دیده شده؛ انجام معامله فقط در «لاگ معاملات واقعی» ثبت می‌شود.</small></div><div className="section-actions"><span>{format(history?.summary.uniqueRouteCount ?? 0)} مسیر یکتا · {format(history?.summary.recordCount ?? 0)} رکورد دقیقه‌ای</span><button type="button" className="history-clear" onClick={() => void clearDetectedHistory()} disabled={clearingHistory}><Trash2/>{clearingHistory ? "در حال پاک‌سازی…" : "پاک کردن تاریخچه"}</button></div></div>
        {!history?.records.length ? <div className="empty">هنوز مسیر دارای سود خالص مثبت در دیتابیس ثبت نشده است.</div> : <div className="history-list">{history.records.map(record => <article className="history-row" key={record.id}>
          <div><span className={`history-mode ${record.mode}`}>{record.mode === "live" ? "اسکن Live" : "اسکن Paper"}</span><div className="history-route">{record.route.map((asset, index) => <span key={`${asset}-${index}`}>{asset === "IRT" ? "تومان" : asset}{index < record.route.length - 1 ? " ← " : ""}</span>)}</div><small>{new Date(record.lastSeenAt).toLocaleString("fa-IR")}</small></div>
          <div><span>آخرین سود</span><b className="positive">{format(record.latestProfitToman)} تومان</b><small>{format(record.latestProfitBps / 100, 3)}٪</small></div>
          <div><span>بهترین سود</span><b>{format(record.bestProfitToman)} تومان</b><small>{format(record.bestProfitBps / 100, 3)}٪</small></div>
          <div><span>دفعات مشاهده</span><b>{format(record.detections)}</b><small className={record.executable ? "positive" : "history-rejection"}>{detectedOpportunityStatus(record)}</small></div>
          <details><summary>جزئیات مسیر</summary><div className="legs">{record.legs.map((leg, index) => <div key={`${leg.symbol}-${index}`}><span>{index + 1}. {leg.from} ← {leg.to}</span><b>{leg.side} {leg.symbol}</b><small>{format(leg.levelsUsed)} از {format(leg.totalLevels ?? leg.levelsUsed)} سطح اردربوک{leg.depthConsumedPercent !== undefined ? ` · مصرف ${format(leg.depthConsumedPercent, 2)}٪` : ""}</small>{leg.priceImpactBps !== undefined && <small>اثر قیمت {format(Number(leg.priceImpactBps) / 100, 3)}٪ · اسپرد {format(Number(leg.spreadBps ?? 0) / 100, 3)}٪</small>}</div>)}</div></details>
        </article>)}</div>}
      </section>
      </>}
    </>}
  </main>;
}

type ManagementFeedTone = "active" | "success" | "loss" | "review" | "neutral";
type ManagementFeedItem = {
  key: string;
  id: number;
  view: EngineView;
  engine: string;
  english: string;
  icon: typeof LayoutDashboard;
  state: string;
  tone: ManagementFeedTone;
  at: number;
  route: string;
  detail: string;
  capital: number | null;
  orderCount: number;
  pnl: number | null;
  plannedPnl: number | null;
  pnlPercent: number | null;
  pnlConfirmed: boolean;
  active: boolean;
  needsReview: boolean;
};

function humanRoute(route: string[]) {
  return route.map(asset => asset === "IRT" ? "تومان" : asset).join(" ← ");
}

function humanMarkets(symbols: string[]) {
  return symbols.map(symbol => {
    if (symbol.endsWith("IRT") && symbol !== "IRT") return `${symbol.slice(0, -3)} / تومان`;
    if (symbol.endsWith("USDT") && symbol !== "USDT") return `${symbol.slice(0, -4)} / USDT`;
    return symbol;
  }).join(" · ");
}

function relativeTime(timestamp: number) {
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return "همین حالا";
  if (elapsed < 3_600_000) return `${format(Math.floor(elapsed / 60_000))} دقیقه پیش`;
  if (elapsed < 86_400_000) return `${format(Math.floor(elapsed / 3_600_000))} ساعت پیش`;
  return `${format(Math.floor(elapsed / 86_400_000))} روز پیش`;
}

function numericValue(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function nestedNumericValue(value: unknown, path: string[]) {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return numericValue(current);
}

function strategyFeedDescription(record: StrategyExecutionRecord, residualValueToman: number | null, needsResidualReview: boolean) {
  if (record.error) return record.error;
  if (needsResidualReview) return `حدود ${format(residualValueToman ?? 0)} تومان دارایی پس از خروج باقی مانده و باید با کیف پول تطبیق داده شود.`;
  const descriptions: Record<StrategyExecutionState, string> = {
    DETECTED: "سیگنال ثبت شده و منتظر بازبینی نهایی است.",
    REVALIDATING: "قیمت، عمق و محدودیت‌های ریسک دوباره بررسی می‌شوند.",
    SUBMITTING: "ارسال یا تعیین تکلیف سفارش در حال انجام است.",
    PARTIALLY_FILLED: "سفارش ناقص پر شده و کنترل پوزیشن فعال است.",
    HEDGING: "پوزیشن باز است و خروج حفاظتی پایش می‌شود.",
    RECOVERING: "بازیابی دارایی و بازگشت امن به تومان در حال انجام است.",
    CLOSED: "چرخه بسته شده و نتیجه مالی ثبت شده است.",
    FAILED_MANUAL: "وضعیت نهایی به بررسی دستی سفارش‌ها و کیف پول نیاز دارد."
  };
  return descriptions[record.state];
}

function EngineManagementOverview({ engines, risk, strategyLab, triangleActionableCount, strategyExecutions, liveExecutions, clearingHistory, onClearHistory, onOpen }: {
  engines: typeof engineNavigation;
  risk?: RiskSnapshotResponse;
  strategyLab?: StrategyLabResult;
  triangleActionableCount: number;
  strategyExecutions?: StrategyExecutionHistory;
  liveExecutions?: LiveExecutionHistory;
  clearingHistory: boolean;
  onClearHistory: () => void;
  onOpen: (view: EngineView) => void;
}) {
  const triangleEngine = engineNavigation.find(engine => engine.view === "triangle")!;
  const triangleFeed: ManagementFeedItem[] = liveExecutions?.records.slice(0, 20).map(record => {
    const capital = record.plannedInputToman ?? record.requestedInputToman;
    const pnlPercent = record.actualProfitToman !== null && capital > 0 ? record.actualProfitToman / capital * 100 : null;
    const active = record.status === "PREPARING" || record.status === "RUNNING";
    const needsReview = record.status === "FAILED" || record.fullySettled !== true && record.status === "COMPLETED";
    const tone: ManagementFeedTone = active ? "active" : needsReview ? "review" : (record.actualProfitToman ?? 0) < 0 ? "loss" : "success";
    return {
      key: `triangle-${record.id}`,
      id: record.id,
      view: "triangle",
      engine: triangleEngine.title,
      english: triangleEngine.english,
      icon: triangleEngine.icon,
      state: executionStatusLabel[record.status],
      tone,
      at: record.completedAt ?? record.startedAt,
      route: humanRoute(record.route),
      detail: record.error ?? (active
        ? "چرخه در حال بازبینی یا اجرای سفارش‌های واقعی است."
        : record.fullySettled === true
          ? "چرخه کاملاً به تومان تسویه و نتیجه نقدی ثبت شده است."
          : `چرخه ماندهٔ تسویه‌نشده به ارزش تقریبی ${format(record.residualValueToman ?? 0)} تومان دارد.`),
      capital,
      orderCount: record.orders.length,
      pnl: record.actualProfitToman,
      plannedPnl: record.plannedProfitToman,
      pnlPercent,
      pnlConfirmed: record.status === "COMPLETED" && record.actualProfitToman !== null && record.fullySettled === true,
      active,
      needsReview
    };
  }) ?? [];
  const strategyFeed: ManagementFeedItem[] = strategyExecutions?.records
    .filter(record => engineNavigation.some(item => item.storeStrategy === record.strategy))
    .slice(0, 30)
    .map(record => {
      const engine = engineNavigation.find(item => item.storeStrategy === record.strategy)!;
      const metadata = record.metadata ?? {};
      const realOrderCount = new Set(record.orders.map(order => order.exchangeOrderId ?? order.clientOrderId).filter(Boolean)).size;
      const residualAmount = numericValue(metadata.residualAssetAmount) ?? 0;
      const lastSell = [...record.orders].reverse().find(order => order.side === "SELL" && numericValue(order.averagePrice));
      const residualPrice = numericValue(lastSell?.averagePrice);
      const residualValueToman = residualAmount > 0 && residualPrice !== null ? residualAmount * residualPrice : null;
      const residualLimit = numericValue(metadata.maxResidualToman)
        ?? nestedNumericValue(metadata.executionPlan, ["config", "maxResidualToman"])
        ?? 1_000;
      const needsResidualReview = residualAmount > 0 && (residualValueToman === null || residualValueToman > residualLimit);
      const capital = numericValue(metadata.entryCostToman) ?? record.requestedCapitalToman;
      const pnlPercent = record.actualProfitToman !== null && capital !== null && capital > 0 ? record.actualProfitToman / capital * 100 : null;
      const active = !["CLOSED", "FAILED_MANUAL"].includes(record.state);
      const rejectedBeforeOrder = record.state === "FAILED_MANUAL"
        && record.orders.length === 0
        && metadata.manualInterventionRequired !== true;
      const needsReview = record.state === "FAILED_MANUAL" && !rejectedBeforeOrder || needsResidualReview;
      const tone: ManagementFeedTone = active ? "active" : needsReview ? "review" : record.actualProfitToman === null ? "neutral" : record.actualProfitToman < 0 ? "loss" : "success";
      return {
        key: `strategy-${record.id}`,
        id: record.id,
        view: engine.view,
        engine: engine.title,
        english: engine.english,
        icon: engine.icon,
        state: needsResidualReview
          ? "نیازمند تطبیق دارایی"
          : rejectedBeforeOrder ? "ردشده پیش از سفارش" : strategyExecutionStatusLabel[record.state],
        tone,
        at: record.updatedAt,
        route: humanMarkets(record.symbols),
        detail: strategyFeedDescription(record, residualValueToman, needsResidualReview),
        capital,
        orderCount: realOrderCount,
        pnl: record.actualProfitToman,
        plannedPnl: record.plannedProfitToman,
        pnlPercent,
        pnlConfirmed: record.state === "CLOSED" && record.actualProfitToman !== null && !needsResidualReview,
        active,
        needsReview
      };
    }) ?? [];
  const recent = [...triangleFeed, ...strategyFeed].sort((a, b) => b.at - a.at).slice(0, 10);
  const recentActive = recent.filter(item => item.active).length;
  const recentReview = recent.filter(item => item.needsReview).length;
  const confirmedPnl = recent.filter(item => item.pnlConfirmed).reduce((sum, item) => sum + (item.pnl ?? 0), 0);

  return <>
    <section className="management-overview panel"><div className="section-title"><div><span className="eyebrow">ENGINE MANAGEMENT OVERVIEW</span><h2>وضعیت لحظه‌ای موتورهای سوددهی</h2><small className="section-note">هر کارت فقط خلاصه همان موتور است؛ برای کنترل، تنظیمات، سیگنال و لاگ اختصاصی وارد Workspace شوید.</small></div><span>{risk?.state.emergencyStop.active ? "توقف اضطراری فعال است" : risk?.state.masterArmed ? "اجرای کلی روشن است" : "اجرای کلی خاموش است"}</span></div><div className="engine-summary-grid">{engines.map(engine => {
      const status = risk?.evaluation.strategies[engine.risk];
      const state = risk?.state.strategies[engine.risk];
      const capability = risk?.runtimeCapabilities?.[engine.risk];
      const signals = engine.view === "triangle"
        ? triangleActionableCount
        : engineSignalCount(strategyLab, engine);
      const records = engine.view === "triangle"
        ? []
        : strategyExecutions?.records.filter(record => record.strategy === engine.storeStrategy) ?? [];
      const active = records.filter(record => !["CLOSED", "FAILED_MANUAL"].includes(record.state)).length
        + (engine.view === "triangle" ? liveExecutions?.summary.runningCount ?? 0 : 0);
      const pnl = records.reduce((sum, record) => sum + (record.actualProfitToman ?? 0), 0)
        + (engine.view === "triangle" ? liveExecutions?.summary.totalActualProfitToman ?? 0 : 0);
      const unavailable = capability?.scope === "unavailable";
      const emergency = risk?.state.emergencyStop.active ?? false;
      const stateLabel = unavailable
        ? engine.risk === "gapTrading" ? "تحلیل سایه · بدون سفارش" : "فعلاً قابل اجرا نیست"
        : emergency
          ? "توقف اضطراری فعال است"
          : status?.canExecute
            ? "روشن و در حال پایش"
            : !state?.enabled
              ? "اجرای واقعی خاموش"
              : !risk?.state.masterArmed
                ? "موتور روشن؛ اجرای کلی خاموش"
                : "متوقف توسط کنترل ریسک";
      const Icon = engine.icon;
      return <article className={`engine-summary-card ${status?.canExecute ? "ready" : unavailable ? "unavailable" : "waiting"}`} key={engine.view}><header><span className="engine-summary-icon"><Icon/></span><div><b>{engine.title}</b><small>{engine.english}</small></div><i className={`status-dot ${emergency ? "emergency" : status?.canExecute ? "online" : ""}`}/></header><div className="engine-summary-state"><strong>{stateLabel}</strong></div><dl><div><dt>سیگنال جاری</dt><dd>{format(signals)}</dd></div><div><dt>اجرای باز</dt><dd>{format(active)}</dd></div><div><dt>PnL بسته</dt><dd className={pnl < 0 ? "negative" : "positive"}>{format(pnl)} تومان</dd></div></dl><button type="button" onClick={() => onOpen(engine.view)}>مدیریت موتور <ArrowLeft/></button></article>;
    })}</div></section>
    <section className="management-activity panel">
      <div className="section-title"><div><span className="eyebrow">LIVE EXECUTION FEED</span><h2>آخرین اجراهای همه موتورها</h2><small className="section-note">سرمایه، سفارش‌ها و نتیجه مالی هر اجرا؛ موارد دارای دارایی باقی‌مانده از PnL قطعی جدا شده‌اند.</small></div><div className="section-actions"><span>{format(recent.length)} اجرای اخیر</span><button type="button" className="history-clear" onClick={onClearHistory} disabled={clearingHistory}><Trash2/>{clearingHistory ? "در حال پاک‌سازی…" : "پاک کردن تاریخچه"}</button></div></div>
      {!!recent.length && <div className="management-feed-summary">
        <div><span>اجرای باز</span><b>{format(recentActive)}</b><small>در حال اجرا یا بازیابی</small></div>
        <div className={recentReview ? "review" : ""}><span>نیازمند بررسی</span><b>{format(recentReview)}</b><small>خطا یا دارایی تطبیق‌نشده</small></div>
        <div><span>PnL قطعی همین فهرست</span><b className={confirmedPnl < 0 ? "negative" : "positive"}>{format(confirmedPnl)} تومان</b><small>فقط چرخه‌های کاملاً بسته</small></div>
      </div>}
      {!recent.length ? <div className="empty">هنوز اجرای واقعی ثبت نشده است.</div> : <div className="management-feed">{recent.map(item => {
        const Icon = item.icon;
        const exactTime = new Date(item.at).toLocaleString("fa-IR");
        const resultText = item.pnl !== null
          ? `${item.pnl > 0 ? "+" : ""}${format(item.pnl)} تومان`
          : item.plannedPnl !== null ? `برآورد ${format(item.plannedPnl)} تومان` : "نتیجه هنوز قطعی نیست";
        return <article className={`management-feed-row ${item.tone}`} key={item.key}>
          <div className="feed-engine"><i><Icon/></i><div><span>{item.engine}</span><b>{item.state}</b><small>{item.english} · اجرای #{format(item.id)}</small></div></div>
          <div className="feed-route"><span>بازار / مسیر</span><b>{item.route || "—"}</b><small>{item.detail}</small></div>
          <div className="feed-facts"><div><span>سرمایه مبنا</span><b>{item.capital === null ? "—" : `${format(item.capital)} تومان`}</b></div><div><span>سفارش واقعی</span><b>{format(item.orderCount)}</b></div></div>
          <div className="feed-result"><span>{item.pnlConfirmed ? "PnL قطعی" : item.needsReview ? "نتیجه نیازمند تطبیق" : "نتیجه مالی"}</span><b className={item.pnl !== null && item.pnl < 0 ? "negative" : item.pnl !== null ? "positive" : ""}>{resultText}</b><small>{item.pnlPercent === null ? "بازده قطعی موجود نیست" : `${format(item.pnlPercent, 2)}٪ بازده ثبت‌شده`}</small></div>
          <div className="feed-time"><time title={exactTime}>{relativeTime(item.at)}</time><small>{exactTime}</small><button type="button" onClick={() => onOpen(item.view)}>جزئیات موتور <ArrowLeft/></button></div>
        </article>;
      })}</div>}
    </section>
  </>;
}

function StrategyExecutionLog({ title, records }: { title: string; records: StrategyExecutionRecord[] }) {
  const active = records.filter(record => !["CLOSED", "FAILED_MANUAL"].includes(record.state)).length;
  const closed = records.filter(record => record.state === "CLOSED").length;
  const pnl = records.reduce((sum, record) => sum + (record.actualProfitToman ?? 0), 0);
  return <section className="strategy-execution-panel panel engine-specific-log"><div className="section-title"><div><span className="eyebrow">TRADE HISTORY</span><h2>معاملات {title}</h2></div><span>{format(active)} باز · {format(closed)} بسته · PnL {format(pnl)} تومان</span></div>{!records.length ? <div className="empty">هنوز معامله واقعی ثبت نشده است.</div> : <div className="strategy-execution-list">{records.map(record => <article className={`strategy-execution-row ${record.state.toLowerCase()}`} key={record.id}><div className="strategy-execution-main"><span className={`strategy-state ${record.state.toLowerCase()}`}>{strategyExecutionStatusLabel[record.state]}</span><b>{title} #{format(record.id)}</b><div className="history-route">{record.symbols.join(" ← ")}</div><small>{record.direction} · {new Date(record.detectedAt).toLocaleString("fa-IR")}</small></div><div><span>سرمایه</span><b>{record.requestedCapitalToman === null ? "—" : `${format(record.requestedCapitalToman)} تومان`}</b><small>Signal: {record.signalId ?? "—"}</small></div><div><span>سفارش / رویداد</span><b>{format(record.orders.length)}</b><small>{format(record.transitions.length)} تغییر وضعیت</small></div><div><span>خروجی حسابداری</span><b>{record.actualOutputToman === null ? "باز / غیرتومانی" : `${format(record.actualOutputToman)} تومان`}</b><small>{record.actualProfitToman === null ? "PnL بسته نشده" : `PnL: ${format(record.actualProfitToman)} تومان`}</small></div>{record.error && <div className="execution-error">{record.error}</div>}<details><summary>Order IDs و Audit Trail</summary><div className="strategy-audit"><div><h4>State Transitions</h4>{record.transitions.map(item => <p key={item.id}><b>{item.fromState ?? "START"} → {item.toState}</b><span>{item.note ?? "—"}</span><small>{new Date(item.transitionedAt).toLocaleTimeString("fa-IR")}</small></p>)}</div><div><h4>Order Events</h4>{record.orders.length ? record.orders.map(order => <p key={order.id}><b>{order.side} {order.symbol} · {order.status}</b><span>Client: {order.clientOrderId ?? "—"} · Exchange: {order.exchangeOrderId ?? "—"}</span><small>Filled: {order.filledAmount ?? "—"} · Fee: {order.fee ?? "—"}</small></p>) : <p><span>هنوز سفارشی ثبت نشده است.</span></p>}</div></div></details></article>)}</div>}</section>;
}
