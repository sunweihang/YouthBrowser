import { AccountStore } from './account-store';
import {
  HistoryStore,
  historyPayloadEqual,
  type HistoryEntry,
} from './history-store';
import { SyncClient } from './sync-client';

const DEBOUNCE_MS = 8000;

export type HistorySyncResult = {
  ok: boolean;
  error?: string;
  unchanged?: boolean;
  skipped?: boolean;
  revision?: number;
};

export function createHistorySync(options: {
  account: AccountStore;
  store: HistoryStore;
  client: SyncClient;
  onChanged: () => void;
}) {
  const { account, store, client, onChanged } = options;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<HistorySyncResult> | null = null;

  async function runSync(): Promise<HistorySyncResult> {
    if (!account.isLoggedIn()) {
      return { ok: true, skipped: true };
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remote = await client.pullHistory();
      if (!remote.ok) {
        return { ok: false, error: remote.error || '拉取历史记录失败' };
      }
      const merged = store.mergeFromSync(
        (remote.entries || []) as Partial<HistoryEntry>[],
        remote.deletedIds || [],
        remote.clearedAt || 0,
        remote.revision || 0
      );
      const local = store.exportForSync();
      const equal = historyPayloadEqual(local, {
        entries: (remote.entries || []) as HistoryEntry[],
        deletedIds: remote.deletedIds || [],
        clearedAt: remote.clearedAt || 0,
      });
      if (equal) {
        if (typeof remote.revision === 'number') {
          store.setRevision(remote.revision);
        }
        if (merged.changed) onChanged();
        return {
          ok: true,
          unchanged: true,
          revision: remote.revision || store.getRevision(),
        };
      }
      const pushed = await client.pushHistory(
        local.entries,
        local.deletedIds,
        local.clearedAt,
        store.getRevision()
      );
      if (pushed.ok) {
        store.setRevision(pushed.revision || store.getRevision());
        onChanged();
        return {
          ok: true,
          unchanged: false,
          revision: pushed.revision,
        };
      }
      const conflict = /先拉取|已更新/.test(pushed.error || '');
      if (conflict && attempt === 0) continue;
      return { ok: false, error: pushed.error || '上传历史记录失败' };
    }
    return { ok: false, error: '同步历史记录失败' };
  }

  async function syncNow(): Promise<HistorySyncResult> {
    if (inflight) return inflight;
    inflight = runSync().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  function schedule(): void {
    if (!account.isLoggedIn()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void syncNow();
    }, DEBOUNCE_MS);
  }

  return { syncNow, schedule };
}
