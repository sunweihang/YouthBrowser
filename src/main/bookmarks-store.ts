import { app } from 'electron';
import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

export const BOOKMARKS_TOOLBAR_ID = 'toolbar';
export const BOOKMARKS_OTHER_ID = 'other';

export type BookmarkNodeType = 'bookmark' | 'folder';

export interface BookmarkNode {
  id: string;
  type: BookmarkNodeType;
  title: string;
  url?: string;
  parentId: string;
  createdAt: number;
  order: number;
}

export interface BookmarkTreeFolder {
  id: string;
  title: string;
  children: Array<BookmarkNode | BookmarkTreeFolder>;
}

function bookmarksPath(): string {
  return join(app.getPath('userData'), 'bookmarks.json');
}

function newId(prefix = 'bm'): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

function normalizeBookmarkUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString();
  } catch {
    return url.trim();
  }
}

export class BookmarksStore {
  private nodes: BookmarkNode[] = [];

  constructor() {
    this.nodes = this.load();
  }

  private load(): BookmarkNode[] {
    const path = bookmarksPath();
    if (!existsSync(path)) {
      return this.seedRoots([]);
    }
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as {
        version?: number;
        nodes?: Partial<BookmarkNode>[];
        bookmarks?: Array<{ id?: string; title?: string; url?: string; createdAt?: number }>;
      };

      // v2 tree
      if (Array.isArray(raw.nodes)) {
        const nodes = raw.nodes
          .map((n) => this.normalizeNode(n))
          .filter((n): n is BookmarkNode => Boolean(n));
        return this.ensureRoots(nodes);
      }

      // v1 flat → migrate into toolbar
      if (Array.isArray(raw.bookmarks)) {
        const migrated: BookmarkNode[] = this.seedRoots([]);
        let order = 0;
        for (const b of raw.bookmarks) {
          if (!b?.url || !String(b.url).startsWith('http')) continue;
          migrated.push({
            id: typeof b.id === 'string' && b.id ? b.id : newId(),
            type: 'bookmark',
            title: (b.title || b.url || '').trim() || String(b.url),
            url: String(b.url),
            parentId: BOOKMARKS_TOOLBAR_ID,
            createdAt: typeof b.createdAt === 'number' ? b.createdAt : Date.now(),
            order: order++,
          });
        }
        this.nodes = migrated;
        this.persist();
        return migrated;
      }
      return this.seedRoots([]);
    } catch {
      return this.seedRoots([]);
    }
  }

  private normalizeNode(raw: Partial<BookmarkNode>): BookmarkNode | null {
    if (!raw || typeof raw !== 'object') return null;
    const type: BookmarkNodeType = raw.type === 'folder' ? 'folder' : 'bookmark';
    const id =
      typeof raw.id === 'string' && raw.id
        ? raw.id
        : newId(type === 'folder' ? 'fld' : 'bm');
    if (type === 'bookmark') {
      if (!raw.url || !String(raw.url).startsWith('http')) return null;
    }
    return {
      id,
      type,
      title:
        typeof raw.title === 'string' && raw.title.trim()
          ? raw.title.trim()
          : type === 'folder'
            ? '新建文件夹'
            : String(raw.url || '未命名'),
      url: type === 'bookmark' ? String(raw.url) : undefined,
      parentId:
        typeof raw.parentId === 'string'
          ? raw.parentId
          : id === BOOKMARKS_TOOLBAR_ID || id === BOOKMARKS_OTHER_ID
            ? ''
            : BOOKMARKS_TOOLBAR_ID,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
      order: typeof raw.order === 'number' ? raw.order : 0,
    };
  }

  private seedRoots(extra: BookmarkNode[]): BookmarkNode[] {
    return [
      {
        id: BOOKMARKS_TOOLBAR_ID,
        type: 'folder',
        title: '书签工具栏',
        parentId: '',
        createdAt: 0,
        order: 0,
      },
      {
        id: BOOKMARKS_OTHER_ID,
        type: 'folder',
        title: '其他书签',
        parentId: '',
        createdAt: 0,
        order: 1,
      },
      ...extra,
    ];
  }

  private ensureRoots(nodes: BookmarkNode[]): BookmarkNode[] {
    let next = [...nodes];
    const hasToolbar = next.some((n) => n.id === BOOKMARKS_TOOLBAR_ID);
    const hasOther = next.some((n) => n.id === BOOKMARKS_OTHER_ID);
    if (!hasToolbar || !hasOther) {
      next = this.seedRoots(
        next.filter(
          (n) => n.id !== BOOKMARKS_TOOLBAR_ID && n.id !== BOOKMARKS_OTHER_ID
        )
      );
    }

    // Roots must stay at top level. Empty parentId used to be rewritten to
    // "toolbar" on load, which created a self-cycle and infinite tree.
    let repaired = false;
    next = next.map((n) => {
      if (n.id === BOOKMARKS_TOOLBAR_ID || n.id === BOOKMARKS_OTHER_ID) {
        if (n.parentId !== '' || n.type !== 'folder') {
          repaired = true;
          return {
            ...n,
            type: 'folder',
            parentId: '',
            title:
              n.id === BOOKMARKS_TOOLBAR_ID ? '书签工具栏' : '其他书签',
          };
        }
      }
      return n;
    });

    if (!hasToolbar || !hasOther || repaired) {
      this.nodes = next;
      this.persist();
    }
    return next;
  }

  private persist(): void {
    const path = bookmarksPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ version: 2, nodes: this.nodes }, null, 2),
      'utf8'
    );
  }

  private childrenOf(parentId: string): BookmarkNode[] {
    return this.nodes
      .filter((n) => n.parentId === parentId)
      .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  }

  private nextOrder(parentId: string): number {
    const kids = this.childrenOf(parentId);
    if (!kids.length) return 0;
    return Math.max(...kids.map((k) => k.order)) + 1;
  }

  list(): BookmarkNode[] {
    return this.nodes.map((n) => ({ ...n }));
  }

  /** Flat bookmarks only (for findByUrl). */
  listBookmarks(): BookmarkNode[] {
    return this.nodes.filter((n) => n.type === 'bookmark').map((n) => ({ ...n }));
  }

  getToolbarItems(): BookmarkNode[] {
    return this.childrenOf(BOOKMARKS_TOOLBAR_ID).map((n) => ({ ...n }));
  }

  getChildren(folderId: string): BookmarkNode[] {
    return this.childrenOf(folderId).map((n) => ({ ...n }));
  }

  getFolders(): BookmarkNode[] {
    return this.nodes.filter((n) => n.type === 'folder').map((n) => ({ ...n }));
  }

  findByUrl(url: string): BookmarkNode | undefined {
    const normalized = normalizeBookmarkUrl(url);
    return this.nodes.find(
      (n) =>
        n.type === 'bookmark' &&
        n.url &&
        normalizeBookmarkUrl(n.url) === normalized
    );
  }

  get(id: string): BookmarkNode | undefined {
    const n = this.nodes.find((x) => x.id === id);
    return n ? { ...n } : undefined;
  }

  snapshot() {
    return {
      nodes: this.list(),
      toolbar: this.getToolbarItems(),
      folders: this.getFolders(),
    };
  }

  addBookmark(input: {
    title: string;
    url: string;
    parentId?: string;
  }): { ok: boolean; error?: string; node?: BookmarkNode } {
    const url = (input.url || '').trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return { ok: false, error: '只能收藏网页地址' };
    }
    const parentId = input.parentId || BOOKMARKS_TOOLBAR_ID;
    const parent = this.nodes.find((n) => n.id === parentId && n.type === 'folder');
    if (!parent) return { ok: false, error: '目标文件夹不存在' };

    const existing = this.findByUrl(url);
    if (existing) {
      return { ok: true, node: { ...existing } };
    }

    const node: BookmarkNode = {
      id: newId('bm'),
      type: 'bookmark',
      title: (input.title || '').trim() || url,
      url,
      parentId,
      createdAt: Date.now(),
      order: this.nextOrder(parentId),
    };
    this.nodes.push(node);
    this.persist();
    return { ok: true, node };
  }

  /** Toggle current page on toolbar. */
  toggleUrl(
    title: string,
    url: string
  ): { ok: boolean; error?: string; bookmarked?: boolean } {
    const existing = this.findByUrl(url);
    if (existing) {
      const res = this.remove(existing.id);
      return { ok: res.ok, error: res.error, bookmarked: false };
    }
    const res = this.addBookmark({ title, url, parentId: BOOKMARKS_TOOLBAR_ID });
    return { ok: res.ok, error: res.error, bookmarked: res.ok };
  }

  createFolder(input: {
    title: string;
    parentId?: string;
  }): { ok: boolean; error?: string; node?: BookmarkNode } {
    const title = (input.title || '').trim() || '新建文件夹';
    const parentId = input.parentId || BOOKMARKS_TOOLBAR_ID;
    if (parentId !== '' && parentId !== BOOKMARKS_TOOLBAR_ID && parentId !== BOOKMARKS_OTHER_ID) {
      const parent = this.nodes.find((n) => n.id === parentId && n.type === 'folder');
      if (!parent) return { ok: false, error: '父文件夹不存在' };
      // prevent nesting under self later via move
    } else if (parentId !== BOOKMARKS_TOOLBAR_ID && parentId !== BOOKMARKS_OTHER_ID) {
      return { ok: false, error: '无效的父文件夹' };
    }

    const node: BookmarkNode = {
      id: newId('fld'),
      type: 'folder',
      title,
      parentId,
      createdAt: Date.now(),
      order: this.nextOrder(parentId),
    };
    this.nodes.push(node);
    this.persist();
    return { ok: true, node };
  }

  rename(
    id: string,
    title: string
  ): { ok: boolean; error?: string; node?: BookmarkNode } {
    if (id === BOOKMARKS_TOOLBAR_ID || id === BOOKMARKS_OTHER_ID) {
      return { ok: false, error: '系统文件夹不能改名' };
    }
    const node = this.nodes.find((n) => n.id === id);
    if (!node) return { ok: false, error: '不存在' };
    const next = (title || '').trim();
    if (!next) return { ok: false, error: '名称不能为空' };
    node.title = next;
    this.persist();
    return { ok: true, node: { ...node } };
  }

  move(
    id: string,
    parentId: string
  ): { ok: boolean; error?: string } {
    if (id === BOOKMARKS_TOOLBAR_ID || id === BOOKMARKS_OTHER_ID) {
      return { ok: false, error: '系统文件夹不能移动' };
    }
    if (id === parentId) return { ok: false, error: '不能移动到自身' };
    const node = this.nodes.find((n) => n.id === id);
    if (!node) return { ok: false, error: '不存在' };
    const parent = this.nodes.find((n) => n.id === parentId && n.type === 'folder');
    if (!parent) return { ok: false, error: '目标文件夹不存在' };

    // prevent moving folder into its descendant
    if (node.type === 'folder') {
      let cur: string | undefined = parentId;
      const guard = new Set<string>();
      while (cur) {
        if (cur === id) return { ok: false, error: '不能移动到子文件夹内' };
        if (guard.has(cur)) break;
        guard.add(cur);
        cur = this.nodes.find((n) => n.id === cur)?.parentId;
        if (cur === '') break;
      }
    }

    node.parentId = parentId;
    node.order = this.nextOrder(parentId);
    this.persist();
    return { ok: true };
  }

  remove(id: string): { ok: boolean; error?: string } {
    if (id === BOOKMARKS_TOOLBAR_ID || id === BOOKMARKS_OTHER_ID) {
      return { ok: false, error: '系统文件夹不能删除' };
    }
    const node = this.nodes.find((n) => n.id === id);
    if (!node) return { ok: false, error: '不存在' };

    const toDelete = new Set<string>([id]);
    if (node.type === 'folder') {
      let changed = true;
      while (changed) {
        changed = false;
        for (const n of this.nodes) {
          if (toDelete.has(n.parentId) && !toDelete.has(n.id)) {
            toDelete.add(n.id);
            changed = true;
          }
        }
      }
    }
    this.nodes = this.nodes.filter((n) => !toDelete.has(n.id));
    this.persist();
    return { ok: true };
  }
}
