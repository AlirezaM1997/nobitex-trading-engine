import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const OWNER_VERSION = 1 as const;
const DEFAULT_HEARTBEAT_MS = 2_000;
const DEFAULT_STALE_MS = 10_000;
const TEST_OVERRIDE_PHRASE = "ALLOW_NON_PRODUCTION_LIVE_EXECUTION_FOR_TESTS";
const OFFICIAL_MAINNET_HOST = "apiv2.nobitex.ir";
const PROCESS_STARTED_AT_MS = Date.now() - Math.floor(process.uptime() * 1_000);
const execFileAsync = promisify(execFile);

type LiveOwnerErrorCode =
  | "LIVE_ENVIRONMENT_BLOCKED"
  | "LIVE_MAINNET_REQUIRED"
  | "LIVE_CREDENTIALS_MISSING"
  | "LIVE_OWNER_CONFLICT"
  | "LIVE_OWNER_LOST";

export class LiveOwnerError extends Error {
  constructor(
    message: string,
    readonly code: LiveOwnerErrorCode,
    readonly blocker: string
  ) {
    super(message);
    this.name = "LiveOwnerError";
  }
}

interface LiveOwnerRecord {
  version: typeof OWNER_VERSION;
  accountFingerprint: string;
  pid: number;
  processStartedAt: string;
  buildId: string;
  token: string;
  acquiredAt: string;
  heartbeatAt: string;
}

interface HeartbeatRecord {
  version: typeof OWNER_VERSION;
  token: string;
  heartbeatAt: string;
}

interface LocalOwnerState {
  handle?: FileHandle;
  record?: LiveOwnerRecord;
  lockPath?: string;
  heartbeatTimer?: ReturnType<typeof setInterval>;
}

export interface PublicLiveOwnerStatus {
  heldByThisProcess: boolean;
  locked: boolean;
  accountFingerprint: string | null;
  pid: number | null;
  buildId: string | null;
  acquiredAt: string | null;
  heartbeatAt: string | null;
  stale: boolean;
}

const GLOBAL_STATE_KEY = Symbol.for("nobitex-arbitrage.live-owner.v1");

function ownerState(): LocalOwnerState {
  const root = globalThis as typeof globalThis & { [GLOBAL_STATE_KEY]?: LocalOwnerState };
  return root[GLOBAL_STATE_KEY] ??= {};
}

function heartbeatIntervalMs() {
  return boundedInteger(process.env.LIVE_OWNER_HEARTBEAT_MS, DEFAULT_HEARTBEAT_MS, 250, 60_000);
}

function staleAfterMs() {
  return boundedInteger(process.env.LIVE_OWNER_STALE_MS, DEFAULT_STALE_MS, 1_000, 300_000);
}

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function isExplicitTestOverride() {
  return process.env.NODE_ENV === "test"
    && process.env.LIVE_EXECUTION_TEST_OVERRIDE === TEST_OVERRIDE_PHRASE;
}

function liveCredentials() {
  const apiBase = (process.env.NOBITEX_API_BASE || "https://apiv2.nobitex.ir").trim().replace(/\/$/, "");
  const apiKey = process.env.NOBITEX_API_KEY?.trim() || "";
  const apiSecret = process.env.NOBITEX_API_SECRET?.trim() || "";
  return { apiBase, apiKey, apiSecret };
}

/**
 * Live execution is deliberately unavailable from `next dev`. Tests must opt
 * in with a phrase that is accepted only when NODE_ENV is exactly `test`.
 */
export function assertProductionLiveEnvironment() {
  if (process.env.NODE_ENV !== "production" && !isExplicitTestOverride()) {
    throw new LiveOwnerError(
      "اجرای واقعی فقط از نسخه Production مجاز است؛ برنامه را Build و با next start اجرا کنید.",
      "LIVE_ENVIRONMENT_BLOCKED",
      "production-runtime-required"
    );
  }

  const { apiBase, apiKey, apiSecret } = liveCredentials();
  let url: URL;
  try {
    url = new URL(apiBase);
  } catch {
    throw new LiveOwnerError("آدرس API نوبیتکس معتبر نیست.", "LIVE_MAINNET_REQUIRED", "official-mainnet-required");
  }
  if (!isExplicitTestOverride() && (url.protocol !== "https:" || url.hostname.toLowerCase() !== OFFICIAL_MAINNET_HOST)) {
    throw new LiveOwnerError(
      "اجرای واقعی فقط روی دامنه رسمی Mainnet نوبیتکس مجاز است.",
      "LIVE_MAINNET_REQUIRED",
      "official-mainnet-required"
    );
  }
  if (!apiKey || !apiSecret) {
    throw new LiveOwnerError(
      "کلید API و Secret برای اجرای واقعی تنظیم نشده‌اند.",
      "LIVE_CREDENTIALS_MISSING",
      "live-credentials-missing"
    );
  }
}

export function liveOwnerAccountFingerprint() {
  const { apiBase, apiKey } = liveCredentials();
  if (!apiKey) {
    throw new LiveOwnerError(
      "کلید API برای تعیین مالک اجرای واقعی تنظیم نشده است.",
      "LIVE_CREDENTIALS_MISSING",
      "live-credentials-missing"
    );
  }
  return createHash("sha256")
    .update(`${apiBase.toLowerCase()}\0${apiKey}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function liveOwnerRoot() {
  const explicit = process.env.LIVE_OWNER_DIR?.trim();
  if (explicit) return path.resolve(/*turbopackIgnore: true*/ explicit);
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (!localAppData) {
      throw new LiveOwnerError(
        "مسیر LOCALAPPDATA برای ساخت قفل اجرای واقعی در دسترس نیست.",
        "LIVE_ENVIRONMENT_BLOCKED",
        "live-owner-storage-unavailable"
      );
    }
    return path.join(localAppData, "NobitexArbitrage", "live-owner");
  }
  return path.join(process.env.XDG_STATE_HOME?.trim() || path.join(homedir(), ".local", "state"), "nobitex-arbitrage", "live-owner");
}

export function liveOwnerLockPath() {
  return path.join(liveOwnerRoot(), `account-${liveOwnerAccountFingerprint()}.lock`);
}

function heartbeatPath(lockPath: string) {
  return `${lockPath}.heartbeat`;
}

function currentBuildId() {
  return (
    process.env.NEXT_BUILD_ID?.trim()
    || process.env.APP_BUILD_ID?.trim()
    || process.env.GIT_COMMIT?.trim()
    || process.env.npm_package_version?.trim()
    || "unknown-build"
  ).slice(0, 160);
}

function parseOwnerRecord(value: unknown): LiveOwnerRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Partial<LiveOwnerRecord>;
  if (
    record.version !== OWNER_VERSION
    || typeof record.accountFingerprint !== "string"
    || !Number.isInteger(record.pid) || Number(record.pid) <= 0
    || typeof record.processStartedAt !== "string" || !Number.isFinite(Date.parse(record.processStartedAt))
    || typeof record.buildId !== "string"
    || typeof record.token !== "string" || record.token.length < 16
    || typeof record.acquiredAt !== "string" || !Number.isFinite(Date.parse(record.acquiredAt))
    || typeof record.heartbeatAt !== "string" || !Number.isFinite(Date.parse(record.heartbeatAt))
  ) return undefined;
  return record as LiveOwnerRecord;
}

function parseHeartbeat(value: unknown): HeartbeatRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Partial<HeartbeatRecord>;
  if (
    record.version !== OWNER_VERSION
    || typeof record.token !== "string"
    || typeof record.heartbeatAt !== "string"
    || !Number.isFinite(Date.parse(record.heartbeatAt))
  ) return undefined;
  return record as HeartbeatRecord;
}

async function readJson(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(/*turbopackIgnore: true*/ filePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

async function readOwnerRecord(lockPath: string) {
  return parseOwnerRecord(await readJson(lockPath));
}

async function readHeartbeat(lockPath: string, owner: LiveOwnerRecord) {
  const heartbeat = parseHeartbeat(await readJson(heartbeatPath(lockPath)));
  return heartbeat?.token === owner.token ? heartbeat.heartbeatAt : owner.heartbeatAt;
}

async function writeHeartbeat(lockPath: string, token: string, now = new Date()) {
  const target = heartbeatPath(lockPath);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const value: HeartbeatRecord = { version: OWNER_VERSION, token, heartbeatAt: now.toISOString() };
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function processAppearsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function processStartedAtMs(pid: number): Promise<number | undefined> {
  if (pid === process.pid) return PROCESS_STARTED_AT_MS;
  try {
    if (process.platform === "win32") {
      const command = `$p=Get-Process -Id ${pid} -ErrorAction Stop; ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds()`;
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
        windowsHide: true,
        timeout: 2_000
      });
      const parsed = Number(String(stdout).trim());
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 2_000 });
    const parsed = Date.parse(String(stdout).trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function ownerCanBeTakenOver(lockPath: string, record: LiveOwnerRecord, nowMs: number) {
  const heartbeatAt = Date.parse(await readHeartbeat(lockPath, record));
  const stale = !Number.isFinite(heartbeatAt) || nowMs - heartbeatAt > staleAfterMs();
  if (!processAppearsAlive(record.pid)) return true;
  const actualStart = await processStartedAtMs(record.pid);
  const recordedStart = Date.parse(record.processStartedAt);
  const pidWasReused = actualStart !== undefined && Math.abs(actualStart - recordedStart) > 2_000;
  return pidWasReused || stale;
}

function startHeartbeat() {
  const local = ownerState();
  if (!local.record || !local.lockPath || local.heartbeatTimer) return;
  local.heartbeatTimer = setInterval(() => {
    const current = ownerState();
    if (!current.record || !current.lockPath) return;
    void assertLiveOwnerForOrder()
      .then(() => writeHeartbeat(current.lockPath!, current.record!.token))
      .catch(() => stopHeartbeat());
  }, heartbeatIntervalMs());
  local.heartbeatTimer.unref?.();
}

function stopHeartbeat() {
  const local = ownerState();
  if (local.heartbeatTimer) clearInterval(local.heartbeatTimer);
  local.heartbeatTimer = undefined;
}

export async function acquireLiveOwner(): Promise<{ newlyAcquired: boolean; status: PublicLiveOwnerStatus }> {
  assertProductionLiveEnvironment();
  const fingerprint = liveOwnerAccountFingerprint();
  const lockPath = liveOwnerLockPath();
  const local = ownerState();

  if (local.record && local.lockPath === lockPath) {
    await assertLiveOwnerForOrder();
    startHeartbeat();
    return { newlyAcquired: false, status: await getLiveOwnerStatus() };
  }

  await mkdir(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const now = new Date();
    const record: LiveOwnerRecord = {
      version: OWNER_VERSION,
      accountFingerprint: fingerprint,
      pid: process.pid,
      processStartedAt: new Date(PROCESS_STARTED_AT_MS).toISOString(),
      buildId: currentBuildId(),
      token: randomUUID(),
      acquiredAt: now.toISOString(),
      heartbeatAt: now.toISOString()
    };
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(record), "utf8");
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
        throw error;
      }
      local.handle = handle;
      local.record = record;
      local.lockPath = lockPath;
      await writeHeartbeat(lockPath, record.token, now);
      startHeartbeat();
      return { newlyAcquired: true, status: await getLiveOwnerStatus() };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readOwnerRecord(lockPath);
      if (!existing) {
        throw new LiveOwnerError(
          "فایل قفل اجرای واقعی خراب یا ناخواناست؛ برای ایمنی به‌صورت خودکار حذف نشد.",
          "LIVE_OWNER_CONFLICT",
          "live-owner-lock-invalid"
        );
      }
      if (!await ownerCanBeTakenOver(lockPath, existing, Date.now())) {
        throw new LiveOwnerError(
          `اجرای واقعی هم‌اکنون در پردازش دیگری (PID ${existing.pid}) فعال است.`,
          "LIVE_OWNER_CONFLICT",
          "live-owner-held-by-another-runtime"
        );
      }

      // ABA protection: remove only the exact stale token that was inspected.
      const confirmation = await readOwnerRecord(lockPath);
      if (!confirmation || confirmation.token !== existing.token) continue;
      const heartbeat = parseHeartbeat(await readJson(heartbeatPath(lockPath)));
      if (!heartbeat || heartbeat.token === existing.token) await rm(heartbeatPath(lockPath), { force: true });
      const finalConfirmation = await readOwnerRecord(lockPath);
      if (!finalConfirmation || finalConfirmation.token !== existing.token) continue;
      await rm(lockPath, { force: true });
      const afterRemoval = await readOwnerRecord(lockPath);
      if (afterRemoval && afterRemoval.token !== existing.token) continue;
    }
  }
  throw new LiveOwnerError(
    "مالک اجرای واقعی هم‌زمان تغییر کرد؛ درخواست برای جلوگیری از اجرای تکراری رد شد.",
    "LIVE_OWNER_CONFLICT",
    "live-owner-race-detected"
  );
}

/** Must run immediately before every request that can create or alter a real order. */
export async function assertLiveOwnerForOrder() {
  assertProductionLiveEnvironment();
  const local = ownerState();
  const expectedFingerprint = liveOwnerAccountFingerprint();
  if (!local.record || !local.lockPath || local.record.accountFingerprint !== expectedFingerprint) {
    throw new LiveOwnerError(
      "این پردازش مالک اجرای واقعی نیست؛ فقط اسکن Paper و درخواست‌های خواندنی مجازند.",
      "LIVE_OWNER_LOST",
      "live-owner-not-held"
    );
  }
  const current = await readOwnerRecord(local.lockPath);
  if (
    !current
    || current.token !== local.record.token
    || current.pid !== process.pid
    || current.processStartedAt !== local.record.processStartedAt
    || current.accountFingerprint !== expectedFingerprint
  ) {
    stopHeartbeat();
    throw new LiveOwnerError(
      "مالکیت اجرای واقعی از دست رفته است؛ سفارش جدید برای جلوگیری از اجرای تکراری متوقف شد.",
      "LIVE_OWNER_LOST",
      "live-owner-lost"
    );
  }
  return true;
}

export async function releaseLiveOwner() {
  const local = ownerState();
  stopHeartbeat();
  const record = local.record;
  const lockPath = local.lockPath;
  const handle = local.handle;
  local.record = undefined;
  local.lockPath = undefined;
  local.handle = undefined;
  if (!record || !lockPath) return false;

  const current = await readOwnerRecord(lockPath);
  if (!current || current.token !== record.token) {
    await handle?.close().catch(() => undefined);
    return false;
  }
  const heartbeat = parseHeartbeat(await readJson(heartbeatPath(lockPath)));
  if (!heartbeat || heartbeat.token === record.token) await rm(heartbeatPath(lockPath), { force: true });
  const confirmation = await readOwnerRecord(lockPath);
  if (!confirmation || confirmation.token !== record.token) {
    await handle?.close().catch(() => undefined);
    return false;
  }
  await rm(lockPath, { force: true });
  await handle?.close().catch(() => undefined);
  return true;
}

export async function getLiveOwnerStatus(): Promise<PublicLiveOwnerStatus> {
  let fingerprint: string;
  try {
    fingerprint = liveOwnerAccountFingerprint();
  } catch {
    return {
      heldByThisProcess: false,
      locked: false,
      accountFingerprint: null,
      pid: null,
      buildId: null,
      acquiredAt: null,
      heartbeatAt: null,
      stale: false
    };
  }
  const lockPath = liveOwnerLockPath();
  const record = await readOwnerRecord(lockPath);
  if (!record) {
    return {
      heldByThisProcess: false,
      locked: false,
      accountFingerprint: fingerprint,
      pid: null,
      buildId: null,
      acquiredAt: null,
      heartbeatAt: null,
      stale: false
    };
  }
  const heartbeatAt = await readHeartbeat(lockPath, record);
  const local = ownerState();
  return {
    heldByThisProcess: Boolean(local.record?.token === record.token && local.lockPath === lockPath),
    locked: true,
    accountFingerprint: fingerprint,
    pid: record.pid,
    buildId: record.buildId,
    acquiredAt: record.acquiredAt,
    heartbeatAt,
    stale: Date.now() - Date.parse(heartbeatAt) > staleAfterMs()
  };
}
