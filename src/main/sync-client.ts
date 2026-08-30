import { SiteGroup } from '../shared/types';
import { AccountSession, AccountStore } from './account-store';

async function api<T>(
  baseUrl: string,
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: unknown;
    timeoutMs?: number;
  } = {}
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  const timeoutMs = options.timeoutMs ?? 12_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: ctrl.signal,
    });
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new Error(`服务器响应异常 (${res.status})`);
    }
    return data as T;
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error('连接服务器超时，请检查网络后重试');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

type AuthResult = {
  ok: boolean;
  error?: string;
  token?: string;
  username?: string;
};

type SyncGetResult = {
  ok: boolean;
  error?: string;
  groups?: SiteGroup[];
  revision?: number;
  updatedAt?: number;
};

type SyncPutResult = {
  ok: boolean;
  error?: string;
  revision?: number;
  updatedAt?: number;
};

type BookmarksSyncResult = {
  ok: boolean;
  error?: string;
  nodes?: unknown[];
  revision?: number;
  updatedAt?: number;
};

/** Stable compare for sync "already up to date" checks. */
export function groupsPayloadEqual(a: SiteGroup[], b: SiteGroup[]): boolean {
  return JSON.stringify(normalizeGroupsPayload(a)) === JSON.stringify(normalizeGroupsPayload(b));
}

function normalizeGroupsPayload(groups: SiteGroup[]): unknown {
  const list = Array.isArray(groups) ? groups : [];
  return list
    .map((g) => ({
      id: g.id,
      name: g.name,
      enabled: Boolean(g.enabled),
      hosts: [...(g.hosts || [])].map((h) => String(h).toLowerCase()).sort(),
      extensionId: g.extensionId || 'none',
      extensionConfig: g.extensionConfig || {},
    }))
    .sort((x, y) => String(x.id).localeCompare(String(y.id)));
}

export class SyncClient {
  constructor(private account: AccountStore) {}

  async register(
    username: string,
    password: string,
    serverUrl?: string
  ): Promise<{ ok: boolean; error?: string }> {
    const base = (serverUrl || this.account.getServerUrl()).replace(/\/$/, '');
    const data = await api<AuthResult>(base, '/auth/register', {
      method: 'POST',
      body: { username, password },
    });
    if (!data.ok || !data.token || !data.username) {
      return { ok: false, error: data.error || '注册失败' };
    }
    this.account.setSession({
      serverUrl: base,
      username: data.username,
      token: data.token,
    });
    return { ok: true };
  }

  async login(
    username: string,
    password: string,
    serverUrl?: string
  ): Promise<{ ok: boolean; error?: string }> {
    const base = (serverUrl || this.account.getServerUrl()).replace(/\/$/, '');
    const prev = this.account.getSession();
    const data = await api<AuthResult>(base, '/auth/login', {
      method: 'POST',
      body: { username, password },
    });
    if (!data.ok || !data.token || !data.username) {
      return { ok: false, error: data.error || '登录失败' };
    }
    this.account.setSession({
      serverUrl: base,
      username: data.username,
      token: data.token,
      lastSyncAt: prev?.username === data.username ? prev.lastSyncAt : undefined,
      lastRevision:
        prev?.username === data.username ? prev.lastRevision : undefined,
    });
    return { ok: true };
  }

  async logout(): Promise<void> {
    const s = this.account.getSession();
    if (s) {
      try {
        await api(s.serverUrl, '/auth/logout', {
          method: 'POST',
          token: s.token,
        });
      } catch {
        // ignore network errors on logout
      }
    }
    this.account.clearSession();
  }

  requireSession(): AccountSession {
    const s = this.account.getSession();
    if (!s) throw new Error('未登录账号');
    return s;
  }

  async pull(options: { touch?: boolean } = {}): Promise<{
    ok: boolean;
    error?: string;
    groups?: SiteGroup[];
    revision?: number;
    updatedAt?: number;
  }> {
    try {
      const s = this.requireSession();
      const data = await api<SyncGetResult>(s.serverUrl, '/sync/config', {
        token: s.token,
      });
      if (!data.ok) return { ok: false, error: data.error || '拉取失败' };
      const revision = data.revision || 0;
      if (options.touch !== false) {
        this.account.touchSync(revision);
      }
      return {
        ok: true,
        groups: data.groups || [],
        revision,
        updatedAt: data.updatedAt || 0,
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '拉取失败' };
    }
  }

  async push(groups: SiteGroup[]): Promise<{
    ok: boolean;
    error?: string;
    revision?: number;
  }> {
    try {
      const s = this.requireSession();
      const data = await api<SyncPutResult>(s.serverUrl, '/sync/config', {
        method: 'PUT',
        token: s.token,
        body: {
          groups,
          revision: s.lastRevision || 0,
        },
      });
      if (!data.ok) return { ok: false, error: data.error || '上传失败' };
      const revision = data.revision || 0;
      this.account.touchSync(revision);
      return { ok: true, revision };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '上传失败' };
    }
  }

  async pullBookmarks(options: { touch?: boolean } = {}): Promise<{
    ok: boolean;
    error?: string;
    nodes?: unknown[];
    revision?: number;
    updatedAt?: number;
  }> {
    try {
      const s = this.requireSession();
      const data = await api<BookmarksSyncResult>(s.serverUrl, '/sync/bookmarks', {
        token: s.token,
      });
      if (!data.ok) return { ok: false, error: data.error || '拉取收藏夹失败' };
      return {
        ok: true,
        nodes: Array.isArray(data.nodes) ? data.nodes : [],
        revision: data.revision || 0,
        updatedAt: data.updatedAt || 0,
      };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : '拉取收藏夹失败',
      };
    }
  }

  async pushBookmarks(
    nodes: unknown[],
    localRevision: number
  ): Promise<{ ok: boolean; error?: string; revision?: number; updatedAt?: number }> {
    try {
      const s = this.requireSession();
      const data = await api<BookmarksSyncResult>(s.serverUrl, '/sync/bookmarks', {
        method: 'PUT',
        token: s.token,
        body: {
          nodes,
          revision: localRevision || 0,
        },
      });
      if (!data.ok) return { ok: false, error: data.error || '上传收藏夹失败' };
      return {
        ok: true,
        revision: data.revision || 0,
        updatedAt: data.updatedAt || 0,
      };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : '上传收藏夹失败',
      };
    }
  }
}
