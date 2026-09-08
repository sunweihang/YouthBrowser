import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';

export interface HistoryEntry {
  id: string;
  url: string;
  title: string;
  host: string;
  visitedAt: number;
}

export type HistorySyncPayload = {
  entries: HistoryEntry[];
  deletedIds: string[];
  clearedAt: number;
};

type StoreFile = {
  version: 1 | 2;
  revision?: number;
  clearedAt?: number;
  deletedIds?: string[];
  entries: HistoryEntry[];
};

const MAX_ENTRIES = 2000;
const MAX_DELETED_IDS = 3000;
const DEDUPE_MS = 2000;

function storePath(): string {
  return join(app.getPath('userData'), 'history.json');
}

function newId(): string {
  return `h_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

function parseHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function normalizeEntry(raw: Partial<HistoryEntry> | null | undefined): HistoryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  const url = String(raw.url || '').trim();
  if (!id || !/^https?:\/\//i.test(url)) return null;
  const host = String(raw.host || '').trim().toLowerCase() || parseHost(url);
  const title = String(raw.title || '').trim() || host || url;
  const visitedAt = Number(raw.visitedAt) || 0;
  return { id, url, title, host, visitedAt };
}

function pruneDeletedIds(ids: string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (let i = ids.length - 1; i >= 0; i -= 1) {
    const id = String(ids[i] || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
    if (unique.length >= MAX_DELETED_IDS) break;
  }
  unique.reverse();
  return unique;
}

export function historyPayloadEqual(
  a: HistorySyncPayload,
  b: HistorySyncPayload
): boolean {
  return (
    JSON.stringify(normalizeHistoryPayload(a)) ===
    JSON.stringify(normalizeHistoryPayload(b))
  );
}

function normalizeHistoryPayload(payload: HistorySyncPayload): unknown {
  return {
    clearedAt: Number(payload.clearedAt) || 0,
    deletedIds: [...new Set(payload.deletedIds || [])].filter(Boolean).sort(),
    entries: [...(payload.entries || [])]
      .map((e) => ({
        id: e.id,
        url: e.url,
        title: e.title,
        host: e.host,
        visitedAt: e.visitedAt,
      }))
      .sort((x, y) => x.id.localeCompare(y.id) || x.visitedAt - y.visitedAt),
  };
}

function pickNewer(a: HistoryEntry, b: HistoryEntry): HistoryEntry {
  if (b.visitedAt !== a.visitedAt) {
    return b.visitedAt > a.visitedAt ? b : a;
  }
  const aWeak = !a.title || a.title === a.url || a.title === a.host;
  const bWeak = !b.title || b.title === b.url || b.title === b.host;
  if (aWeak && !bWeak) return b;
  if (bWeak && !aWeak) return a;
  return b.title.length >= a.title.length ? b : a;
}

export class HistoryStore {
  private entries: HistoryEntry[] = [];
  private deletedIds: string[] = [];
  private clearedAt = 0;
  private revision = 0;

  constructor() {
    this.load();
  }

  private load(): void {
    const path = storePath();
    if (!existsSync(path)) {
      this.entries = [];
      this.deletedIds = [];
      this.clearedAt = 0;
      this.revision = 0;
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as StoreFile;
      this.entries = Array.isArray(raw.entries)
        ? raw.entries.map((e) => normalizeEntry(e)).filter((e): e is HistoryEntry => Boolean(e))
        : [];
      this.deletedIds = pruneDeletedIds(Array.isArray(raw.deletedIds) ? raw.deletedIds : []);
      this.clearedAt = Math.max(0, Number(raw.clearedAt) || 0);
      this.revision = Math.max(0, Number(raw.revision) || 0);
    } catch {
      this.entries = [];
      this.deletedIds = [];
      this.clearedAt = 0;
      this.revision = 0;
    }
  }

  private persist(): void {
    const path = storePath();
    mkdirSync(dirname(path), { recursive: true });
    const data: StoreFile = {
      version: 2,
      revision: this.revision,
      clearedAt: this.clearedAt,
      deletedIds: this.deletedIds,
      entries: this.entries,
    };
    writeFileSync(path, JSON.stringify(data), 'utf8');
  }

  list(query?: string): HistoryEntry[] {
    const q = String(query || '')
      .trim()
      .toLowerCase();
    let rows = this.entries.map((e) => ({ ...e }));
    if (q) {
      rows = rows.filter(
        (e) =>
          e.title.toLowerCase().includes(q) ||
          e.url.toLowerCase().includes(q) ||
          e.host.toLowerCase().includes(q)
      );
    }
    return rows.sort((a, b) => b.visitedAt - a.visitedAt);
  }

  count(): number {
    return this.entries.length;
  }

  get(id: string): HistoryEntry | undefined {
    const found = this.entries.find((e) => e.id === id);
    return found ? { ...found } : undefined;
  }

  getRevision(): number {
    return this.revision;
  }

  setRevision(revision: number): void {
    this.revision = Math.max(0, Number(revision) || 0);
    this.persist();
  }

  exportForSync(): HistorySyncPayload {
    return {
      entries: this.entries.map((e) => ({ ...e })),
      deletedIds: [...this.deletedIds],
      clearedAt: this.clearedAt,
    };
  }

  mergeFromSync(
    remoteEntries: Partial<HistoryEntry>[],
    remoteDeletedIds: string[] = [],
    remoteClearedAt = 0,
    remoteRevision = 0
  ): { changed: boolean } {
    const before = JSON.stringify(normalizeHistoryPayload(this.exportForSync()));
    const deleted = pruneDeletedIds([...this.deletedIds, ...remoteDeletedIds]);
    const clearedAt = Math.max(this.clearedAt, Number(remoteClearedAt) || 0);
    const byId = new Map<string, HistoryEntry>();
    for (const raw of [...this.entries, ...remoteEntries]) {
      const entry = normalizeEntry(raw);
      if (!entry) continue;
      if (deleted.includes(entry.id)) continue;
      if (clearedAt > 0 && entry.visitedAt <= clearedAt) continue;
      const prev = byId.get(entry.id);
      byId.set(entry.id, prev ? pickNewer(prev, entry) : entry);
    }
    const merged = [...byId.values()]
      .sort((a, b) => b.visitedAt - a.visitedAt)
      .slice(0, MAX_ENTRIES);
    this.entries = merged;
    this.deletedIds = deleted;
    this.clearedAt = clearedAt;
    if (typeof remoteRevision === 'number' && remoteRevision > this.revision) {
      this.revision = remoteRevision;
    }
    const after = JSON.stringify(normalizeHistoryPayload(this.exportForSync()));
    this.persist();
    return { changed: before !== after };
  }

  record(url: string, title?: string): HistoryEntry | null {
    const href = String(url || '').trim();
    if (!/^https?:\/\//i.test(href)) return null;

    const now = Date.now();
    const host = parseHost(href);
    const pageTitle = String(title || '').trim() || host || href;
    const lastSame = this.entries.find((e) => e.url === href);
    if (lastSame && now - lastSame.visitedAt < DEDUPE_MS) {
      if (pageTitle && pageTitle !== lastSame.title && pageTitle !== href) {
        lastSame.title = pageTitle;
      }
      lastSame.visitedAt = now;
      this.entries = [
        lastSame,
        ...this.entries.filter((e) => e.id !== lastSame.id),
      ];
      this.persist();
      return { ...lastSame };
    }

    const entry: HistoryEntry = {
      id: newId(),
      url: href,
      title: pageTitle,
      host,
      visitedAt: now,
    };
    this.entries.unshift(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(0, MAX_ENTRIES);
    }
    this.persist();
    return { ...entry };
  }

  updateLatestTitle(url: string, title: string): void {
    const href = String(url || '').trim();
    const pageTitle = String(title || '').trim();
    if (!href || !pageTitle) return;
    const latest = this.entries.find((e) => e.url === href);
    if (!latest || latest.title === pageTitle) return;
    latest.title = pageTitle;
    this.persist();
  }

  remove(id: string): { ok: boolean; error?: string } {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx < 0) return { ok: false, error: '记录不存在' };
    this.entries.splice(idx, 1);
    this.deletedIds = pruneDeletedIds([...this.deletedIds, id]);
    this.persist();
    return { ok: true };
  }

  clear(): { ok: boolean } {
    this.deletedIds = pruneDeletedIds([
      ...this.deletedIds,
      ...this.entries.map((e) => e.id),
    ]);
    this.clearedAt = Date.now();
    this.entries = [];
    this.persist();
    return { ok: true };
  }
}
