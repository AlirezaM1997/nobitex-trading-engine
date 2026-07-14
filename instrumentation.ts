/**
 * Next.js Node-process bootstrap. Recovery supervision remains independent of
 * new entries. The Live scheduler can open Triangle cycles only in production,
 * after Master Live and the account-scoped process owner are both valid.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ensureStrategySupervisorStarted } = await import("@/app/api/strategies/supervise/route");
  ensureStrategySupervisorStarted();
  const { ensureLiveSchedulerStarted } = await import("@/lib/runtime/live-scheduler");
  const {
    ensureTriangleStartupAuditCompleted,
    shouldRunTriangleStartupAudit
  } = await import("@/lib/runtime/triangle-startup-audit");
  if (!shouldRunTriangleStartupAudit()) {
    ensureLiveSchedulerStarted();
    return;
  }
  const audit = await ensureTriangleStartupAuditCompleted();
  if (audit.safeToStart) ensureLiveSchedulerStarted();
}
