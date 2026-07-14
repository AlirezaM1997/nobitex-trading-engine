import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";

export type StatisticalPairsAssetLock = {
  asset: string;
  executionId: number;
  path: string;
};

function targetPath(asset: string) {
  const normalized = asset.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,16}$/.test(normalized)) throw new Error("Invalid Pairs short asset lock");
  const prefix = process.env.PAIRS_ASSET_LOCK_PATH?.trim()
    || path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "pairs-short-asset");
  return { asset: normalized, path: `${prefix}.${normalized}.lock` };
}

export async function acquireStatisticalPairsAssetLock(asset: string, executionId: number) {
  if (!Number.isSafeInteger(executionId) || executionId <= 0) throw new Error("Invalid Pairs execution id");
  const target = targetPath(asset);
  await mkdir(/*turbopackIgnore: true*/ path.dirname(target.path), { recursive: true });
  try {
    const handle = await open(/*turbopackIgnore: true*/ target.path, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ asset: target.asset, executionId }), "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    return { ...target, executionId } satisfies StatisticalPairsAssetLock;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try {
      const current = JSON.parse(await readFile(/*turbopackIgnore: true*/ target.path, "utf8")) as { asset?: string; executionId?: number };
      return current.asset === target.asset && current.executionId === executionId
        ? { ...target, executionId } satisfies StatisticalPairsAssetLock
        : undefined;
    } catch { return undefined; }
  }
}

export async function releaseStatisticalPairsAssetLock(lock: StatisticalPairsAssetLock) {
  try {
    const current = JSON.parse(await readFile(/*turbopackIgnore: true*/ lock.path, "utf8")) as { asset?: string; executionId?: number };
    if (current.asset !== lock.asset || current.executionId !== lock.executionId) return false;
    await rm(/*turbopackIgnore: true*/ lock.path, { force: true });
    return true;
  } catch { return false; }
}
