import type { AssetSyncStatus } from "./asset-sync.ts";
import { sessionSyncStatus } from "./session-sync.ts";

let assets: AssetSyncStatus | null = null;
export function setAssetSyncStatus(status: AssetSyncStatus): void { assets = status; }
export function backgroundSyncStatus() {
  return { assets: assets ? structuredClone(assets) : null, sessions: sessionSyncStatus() };
}
