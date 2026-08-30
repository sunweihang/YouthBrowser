import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';
import { parseBiliVideoId, resolveVideoOwner } from './bili-resolver';

export type WatchRequestStatus = 'pending' | 'approved' | 'rejected';

export interface WatchRequest {
  id: string;
  url: string;
  host?: string;
  reason?: string;
  mid?: string;
  bvid?: string;
  aid?: string;
  title?: string;
  status: WatchRequestStatus;
  createdAt: number;
  resolvedAt?: number;
  note?: string;
}

type StoreFile = {
  version: 1;
  requests: WatchRequest[];
};

function storePath(): string {
  return join(app.getPath('userData'), 'watch-requests.json');
}

function newId(): string {
  return `wr_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

function isBiliHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'bilibili.com' || h.endsWith('.bilibili.com');
}

export class WatchRequestsStore {
  private requests: WatchRequest[] = [];

  constructor() {
    this.load();
  }

  private load(): void {
    const path = storePath();
    if (!existsSync(path)) {
      this.requests = [];
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as StoreFile;
      this.requests = Array.isArray(raw.requests) ? raw.requests : [];
    } catch {
      this.requests = [];
    }
  }

  private persist(): void {
    const path = storePath();
    mkdirSync(dirname(path), { recursive: true });
    const data: StoreFile = { version: 1, requests: this.requests };
    writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
  }

  list(): WatchRequest[] {
    return this.requests
      .map((r) => ({ ...r }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  pendingCount(): number {
    return this.requests.filter((r) => r.status === 'pending').length;
  }

  async create(input: {
    url: string;
    reason?: string;
    mid?: string;
    bvid?: string;
    aid?: string;
    title?: string;
  }): Promise<{ ok: boolean; error?: string; request?: WatchRequest }> {
    let url = String(input.url || '').trim();
    if (url && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) {
      url = `https://${url}`;
    }
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, error: '无效的地址' };
    }

    let host: string | undefined;
    let mid = input.mid ? String(input.mid) : undefined;
    let bvid = input.bvid;
    let aid = input.aid;
    let title = input.title;
    const reason = input.reason ? String(input.reason) : undefined;

    try {
      const u = new URL(url);
      host = u.hostname.toLowerCase();
      if (isBiliHost(host)) {
        const ids = parseBiliVideoId(u.pathname || '');
        if (ids) {
          bvid = bvid || ids.bvid;
          aid = aid || ids.aid;
        }
        if (!mid && (bvid || aid)) {
          const owner = await resolveVideoOwner(bvid, aid);
          if (owner.ok && owner.mid) {
            mid = owner.mid;
            if (!title && owner.title) title = owner.title;
          }
        }
      }
      if (!title) title = host;
    } catch {
      // keep partial fields
    }

    const existing = this.requests.find((r) => {
      if (r.status !== 'pending') return false;
      if (r.url === url) return true;
      if (bvid && r.bvid === bvid) return true;
      if (aid && r.aid === aid) return true;
      // Same host pending (non-bili site) — avoid spam
      if (host && r.host === host && !mid && !bvid && !aid) return true;
      return false;
    });
    if (existing) {
      return { ok: true, request: { ...existing } };
    }

    const request: WatchRequest = {
      id: newId(),
      url,
      host,
      reason,
      mid,
      bvid,
      aid,
      title,
      status: 'pending',
      createdAt: Date.now(),
    };
    this.requests.unshift(request);
    if (this.requests.length > 200) {
      this.requests = this.requests.slice(0, 200);
    }
    this.persist();
    return { ok: true, request: { ...request } };
  }

  reject(id: string): { ok: boolean; error?: string; request?: WatchRequest } {
    const req = this.requests.find((r) => r.id === id);
    if (!req) return { ok: false, error: '申请不存在' };
    if (req.status !== 'pending') {
      return { ok: false, error: '该申请已处理' };
    }
    req.status = 'rejected';
    req.resolvedAt = Date.now();
    this.persist();
    return { ok: true, request: { ...req } };
  }

  markApproved(id: string): { ok: boolean; error?: string; request?: WatchRequest } {
    const req = this.requests.find((r) => r.id === id);
    if (!req) return { ok: false, error: '申请不存在' };
    if (req.status !== 'pending') {
      return { ok: false, error: '该申请已处理' };
    }
    req.status = 'approved';
    req.resolvedAt = Date.now();
    this.persist();
    return { ok: true, request: { ...req } };
  }

  get(id: string): WatchRequest | undefined {
    const r = this.requests.find((x) => x.id === id);
    return r ? { ...r } : undefined;
  }

  /** Approved request URLs (same host + path) stay allowed after parent approval. */
  isApprovedUrl(url: string): boolean {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return false;
    }
    const host = target.hostname.toLowerCase();
    const path = target.pathname || '/';
    return this.requests.some((r) => {
      if (r.status !== 'approved') return false;
      try {
        const u = new URL(r.url);
        return (
          u.hostname.toLowerCase() === host && (u.pathname || '/') === path
        );
      } catch {
        return false;
      }
    });
  }
}
