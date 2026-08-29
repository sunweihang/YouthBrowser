import { app } from 'electron';
import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

export interface Bookmark {
  id: string;
  title: string;
  url: string;
  createdAt: number;
}

function bookmarksPath(): string {
  return join(app.getPath('userData'), 'bookmarks.json');
}

function newId(): string {
  return `bm_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

export class BookmarksStore {
  private items: Bookmark[] = [];

  constructor() {
    this.items = this.load();
  }

  private load(): Bookmark[] {
    const path = bookmarksPath();
    if (!existsSync(path)) return [];
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as {
        bookmarks?: Partial<Bookmark>[];
      };
      if (!Array.isArray(raw.bookmarks)) return [];
      return raw.bookmarks
        .filter((b) => b && typeof b.url === 'string' && b.url.startsWith('http'))
        .map((b) => ({
          id: typeof b.id === 'string' && b.id ? b.id : newId(),
          title:
            typeof b.title === 'string' && b.title.trim()
              ? b.title.trim()
              : b.url!,
          url: b.url!,
          createdAt:
            typeof b.createdAt === 'number' ? b.createdAt : Date.now(),
        }));
    } catch {
      return [];
    }
  }

  private persist(): void {
    const path = bookmarksPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ bookmarks: this.items }, null, 2),
      'utf8'
    );
  }

  list(): Bookmark[] {
    return this.items.map((b) => ({ ...b }));
  }

  findByUrl(url: string): Bookmark | undefined {
    const normalized = normalizeBookmarkUrl(url);
    return this.items.find((b) => normalizeBookmarkUrl(b.url) === normalized);
  }

  add(input: {
    title: string;
    url: string;
  }): { ok: boolean; error?: string; bookmark?: Bookmark; bookmarks?: Bookmark[] } {
    const url = (input.url || '').trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return { ok: false, error: '只能收藏网页地址' };
    }
    if (url.startsWith('file:')) {
      return { ok: false, error: '无法收藏此页面' };
    }
    const existing = this.findByUrl(url);
    if (existing) {
      return {
        ok: true,
        bookmark: { ...existing },
        bookmarks: this.list(),
      };
    }
    const bookmark: Bookmark = {
      id: newId(),
      title: (input.title || '').trim() || url,
      url,
      createdAt: Date.now(),
    };
    this.items.push(bookmark);
    this.persist();
    return { ok: true, bookmark, bookmarks: this.list() };
  }

  remove(
    id: string
  ): { ok: boolean; error?: string; bookmarks?: Bookmark[] } {
    const before = this.items.length;
    this.items = this.items.filter((b) => b.id !== id);
    if (this.items.length === before) {
      return { ok: false, error: '收藏不存在' };
    }
    this.persist();
    return { ok: true, bookmarks: this.list() };
  }

  removeByUrl(url: string): { ok: boolean; bookmarks?: Bookmark[] } {
    const found = this.findByUrl(url);
    if (!found) return { ok: true, bookmarks: this.list() };
    return this.remove(found.id);
  }
}

function normalizeBookmarkUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    let href = u.toString();
    if (href.endsWith('/') && u.pathname === '/') {
      // keep
    }
    return href;
  } catch {
    return url.trim();
  }
}
