import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';

export type DownloadState =
  | 'progressing'
  | 'completed'
  | 'cancelled'
  | 'interrupted';

export interface DownloadEntry {
  id: string;
  url: string;
  filename: string;
  filePath: string;
  mime: string;
  state: DownloadState;
  receivedBytes: number;
  totalBytes: number;
  startedAt: number;
  endedAt?: number;
  paused?: boolean;
}

type StoreFile = {
  version: 1;
  entries: DownloadEntry[];
};

const MAX_ENTRIES = 500;

function storePath(): string {
  return join(app.getPath('userData'), 'downloads.json');
}

function newId(): string {
  return `d_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

export class DownloadsStore {
  private entries: DownloadEntry[] = [];

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

  persist(): void {
    const path = storePath();
    mkdirSync(dirname(path), { recursive: true });
    const data: StoreFile = { version: 1, entries: this.entries };
    writeFileSync(path, JSON.stringify(data), 'utf8');
  }

  list(query?: string): DownloadEntry[] {
    const q = String(query || '')
      .trim()
      .toLowerCase();
    let rows = this.entries.map((e) => ({ ...e }));
    if (q) {
      rows = rows.filter(
        (e) =>
          e.filename.toLowerCase().includes(q) ||
          e.url.toLowerCase().includes(q) ||
          e.filePath.toLowerCase().includes(q)
      );
    }
    return rows.sort((a, b) => b.startedAt - a.startedAt);
  }

  count(): number {
    return this.entries.length;
  }

  activeCount(): number {
    return this.entries.filter((e) => e.state === 'progressing').length;
  }

  get(id: string): DownloadEntry | undefined {
    const found = this.entries.find((e) => e.id === id);
    return found ? { ...found } : undefined;
  }

  add(partial: Omit<DownloadEntry, 'id'>, persistNow = true): DownloadEntry {
    const entry: DownloadEntry = { id: newId(), ...partial };
    this.entries.unshift(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(0, MAX_ENTRIES);
    }
    if (persistNow) this.persist();
    return { ...entry };
  }

  update(
    id: string,
    patch: Partial<DownloadEntry>
  ): DownloadEntry | undefined {
    const found = this.entries.find((e) => e.id === id);
    if (!found) return undefined;
    Object.assign(found, patch);
    return { ...found };
  }

  remove(id: string): { ok: boolean; error?: string } {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx < 0) return { ok: false, error: '记录不存在' };
    this.entries.splice(idx, 1);
    this.persist();
    return { ok: true };
  }

  clear(): { ok: boolean } {
    this.entries = this.entries.filter((e) => e.state === 'progressing');
    this.persist();
    return { ok: true };
  }
}
