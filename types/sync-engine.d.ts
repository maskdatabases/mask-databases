// mask-databases/sync-engine — sync engine types

export interface SyncMeta {
  version: number;
  lastModified: number;
  isDeleted?: boolean;
  isSynced?: boolean;
  syncedAt?: number;
}

export interface SyncRecord {
  hash?: string;
  data?: any;
  syncMeta?: SyncMeta;
}

export interface SyncSlice {
  promptMap: Record<string, string>;
  metadata: Record<string, any>;
  syncMeta: Record<string, SyncMeta>;
  failedPrompts?: string[];
  needsReview?: any[];
}

export declare function compareRecord(a: SyncMeta | undefined, b: SyncMeta | undefined): number;

export declare function resolvePullWinner(local: SyncRecord, remote: SyncRecord): SyncRecord;

export declare function resolvePushWinner(existing: SyncRecord, incoming: SyncRecord): SyncRecord;

export declare function normalizeSlice(slice: Partial<SyncSlice>): SyncSlice;

export declare function mergePullSlice(
  local: SyncSlice,
  remote: SyncSlice,
  options?: { forceRemoteUnsynced?: boolean }
): SyncSlice;

export declare function mergePushSlice(existing: SyncSlice, incoming: SyncSlice): SyncSlice;

export declare function applyLocalPatchToSlice(slice: SyncSlice, patch: Record<string, SyncMeta>): SyncSlice;

export declare function markLocalSliceSynced(slice: SyncSlice, acceptedKeys: string[]): SyncSlice;

export declare function mergeFetchReconcile(
  paths: any,
  payload: { queries?: any; models?: any },
  options?: { forceRemoteUnsynced?: boolean }
): void;
