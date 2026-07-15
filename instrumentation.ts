/**
 * Next.js Node-process bootstrap. Recovery supervision remains independent of
 * new entries. The Live scheduler can open Triangle cycles only in production,
 * after Master Live and the account-scoped process owner are both valid.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ensureStrategySupervisorStarted } = await import("@/app/api/strategies/supervise/route");
  ensureStrategySupervisorStarted();
  // The AI Demo loop is a virtual broker only: it cannot acquire a Live lease
  // or call an authenticated order endpoint. Keep it independent from the
  // Triangle startup fence so learning also works while Master Live is off.
  const { ensureAiDemoSchedulerStarted } = await import("@/lib/ai-agent/demo-scheduler");
  ensureAiDemoSchedulerStarted();
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
