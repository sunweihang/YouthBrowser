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

type StoreFile = {
  version: 1;
  entries: HistoryEntry[];
};

const MAX_ENTRIES = 2000;
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

export class HistoryStore {
  private entries: HistoryEntry[] = [];

  constructor() {
    this.load();
  }

  private load(): void {
    const path = storePath();
    if (!existsSync(path)) {
      this.entries = [];
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as StoreFile;
      this.entries = Array.isArray(raw.entries) ? raw.entries : [];
    } catch {
      this.entries = [];
    }
  }

  private persist(): void {
    const path = storePath();
    mkdirSync(dirname(path), { recursive: true });
    const data: StoreFile = { version: 1, entries: this.entries };
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

  record(url: string, title?: string): HistoryEntry | null {
    const href = String(url || '').trim();
    if (!/^https?:\/\//i.test(href)) return null;

    const now = Date.now();
    const host = parseHost(href);
    const pageTitle = String(title || '').trim() || host || href;
    const last = this.entries[0];
    if (last && last.url === href && now - last.visitedAt < DEDUPE_MS) {
      if (pageTitle && pageTitle !== last.title && pageTitle !== href) {
        last.title = pageTitle;
        this.persist();
      }
      last.visitedAt = now;
      return { ...last };
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
    this.persist();
    return { ok: true };
  }

  clear(): { ok: boolean } {
    this.entries = [];
    this.persist();
    return { ok: true };
  }
}
