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
  email?: string;
  message?: string;
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

type HistorySyncResult = {
  ok: boolean;
  error?: string;
  entries?: unknown[];
  deletedIds?: string[];
  clearedAt?: number;
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
    serverUrl?: string,
    email?: string
  ): Promise<{ ok: boolean; error?: string }> {
    const base = (serverUrl || this.account.getServerUrl()).replace(/\/$/, '');
    const data = await api<AuthResult>(base, '/auth/register', {
      method: 'POST',
      body: { username, password, email },
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

  async verifyResetEmail(
    username: string,
    email: string,
    serverUrl?: string
  ): Promise<{ ok: boolean; error?: string; message?: string }> {
    const base = (serverUrl || this.account.getServerUrl()).replace(/\/$/, '');
    try {
      const data = await api<AuthResult>(base, '/auth/verify-reset-email', {
        method: 'POST',
        body: { username, email },
      });
      if (!data.ok) return { ok: false, error: data.error || '验证失败' };
      return { ok: true, message: data.message };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : '验证失败',
      };
    }
  }

  async forgotPassword(
    username: string,
    email: string,
    serverUrl?: string
  ): Promise<{ ok: boolean; error?: string; message?: string }> {
    const base = (serverUrl || this.account.getServerUrl()).replace(/\/$/, '');
    try {
      const data = await api<AuthResult>(base, '/auth/forgot-password', {
        method: 'POST',
        body: { username, email },
      });
      if (!data.ok) return { ok: false, error: data.error || '发送失败' };
      return { ok: true, message: data.message || '验证码已发送，请查收邮箱' };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : '发送失败',
      };
    }
  }

  async resetPassword(
    input: {
      username: string;
      email: string;
      code: string;
      newPassword: string;
      serverUrl?: string;
    }
  ): Promise<{ ok: boolean; error?: string; message?: string }> {
    const base = (input.serverUrl || this.account.getServerUrl()).replace(
      /\/$/,
      ''
    );
    try {
      const data = await api<AuthResult>(base, '/auth/reset-password', {
        method: 'POST',
        body: {
          username: input.username,
          email: input.email,
          code: input.code,
          newPassword: input.newPassword,
        },
      });
      if (!data.ok) return { ok: false, error: data.error || '重置失败' };
      return {
        ok: true,
        message: data.message || '密码已修改，请使用新密码登录',
      };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : '重置失败',
      };
    }
  }

  async changePassword(
    currentPassword: string,
    newPassword: string
  ): Promise<{ ok: boolean; error?: string; message?: string }> {
    try {
      const s = this.requireSession();
      const data = await api<AuthResult>(s.serverUrl, '/auth/change-password', {
        method: 'POST',
        token: s.token,
        body: { currentPassword, newPassword },
      });
      if (!data.ok) return { ok: false, error: data.error || '修改失败' };
      return { ok: true, message: data.message || '密码已修改' };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : '修改失败',
      };
    }
  }

  async bindEmail(
    email: string,
    password: string
  ): Promise<{ ok: boolean; error?: string; email?: string; message?: string }> {
    try {
      const s = this.requireSession();
      const data = await api<AuthResult & { emailMasked?: string }>(
        s.serverUrl,
        '/auth/bind-email',
        {
          method: 'POST',
          token: s.token,
          body: { email, password },
        }
      );
      if (!data.ok) return { ok: false, error: data.error || '绑定失败' };
      return {
        ok: true,
        email: data.email,
        message: data.message || '邮箱绑定成功',
      };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : '绑定失败',
      };
    }
  }

  async me(): Promise<{
    ok: boolean;
    error?: string;
    username?: string;
    email?: string;
    emailMasked?: string;
    hasEmail?: boolean;
  }> {
    try {
      const s = this.requireSession();
      const data = await api<{
        ok: boolean;
        error?: string;
        username?: string;
        email?: string;
        emailMasked?: string;
        hasEmail?: boolean;
      }>(s.serverUrl, '/auth/me', { token: s.token });
      if (!data.ok) return { ok: false, error: data.error || '未登录' };
      return {
        ok: true,
        username: data.username,
        email: data.email || '',
        emailMasked: data.emailMasked || '',
        hasEmail: Boolean(data.hasEmail),
      };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : '读取账号失败',
      };
    }
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

  async pullHistory(): Promise<{
    ok: boolean;
    error?: string;
    entries?: unknown[];
    deletedIds?: string[];
    clearedAt?: number;
    revision?: number;
    updatedAt?: number;
  }> {
    try {
      const s = this.requireSession();
      const data = await api<HistorySyncResult>(s.serverUrl, '/sync/history', {
        token: s.token,
      });
      if (!data.ok) return { ok: false, error: data.error || '拉取历史记录失败' };
      return {
        ok: true,
        entries: Array.isArray(data.entries) ? data.entries : [],
        deletedIds: Array.isArray(data.deletedIds)
          ? data.deletedIds.map((id) => String(id))
          : [],
        clearedAt: Number(data.clearedAt) || 0,
        revision: data.revision || 0,
        updatedAt: data.updatedAt || 0,
      };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : '拉取历史记录失败',
      };
    }
  }

  async pushHistory(
    entries: unknown[],
    deletedIds: string[],
    clearedAt: number,
    localRevision: number
  ): Promise<{ ok: boolean; error?: string; revision?: number; updatedAt?: number }> {
    try {
      const s = this.requireSession();
      const data = await api<HistorySyncResult>(s.serverUrl, '/sync/history', {
        method: 'PUT',
        token: s.token,
        body: {
          entries,
          deletedIds,
          clearedAt,
          revision: localRevision || 0,
        },
      });
      if (!data.ok) return { ok: false, error: data.error || '上传历史记录失败' };
      return {
        ok: true,
        revision: data.revision || 0,
        updatedAt: data.updatedAt || 0,
      };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : '上传历史记录失败',
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
