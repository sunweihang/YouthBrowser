import { app, shell } from 'electron';
import type { Session, WebContents } from 'electron';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import type { ClientRequest, IncomingMessage } from 'http';
import { createWriteStream, existsSync, mkdirSync } from 'fs';
import type { WriteStream } from 'fs';
import { basename, extname, join } from 'path';
import { DownloadsStore, DownloadEntry } from './downloads-store';
import { isDownloadAllowed } from './navigation-guard';
import type { RulesConfig } from '../shared/types';

const DOWNLOAD_EXT =
  /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|pdf|doc|docx|xls|xlsx|ppt|pptx|csv|txt|rtf|mp3|mp4|m4a|wav|flac|aac|ogg|avi|mkv|mov|webm|png|jpe?g|gif|webp|svg|ico|apk|ipa|exe|msi|dmg|pkg|iso|img|bin|torrent|epub|mobi|azw3|json|xml|yaml|yml)(?:[?#]|$)/i;

const DOWNLOAD_MIME =
  /application\/(zip|x-zip-compressed|x-7z-compressed|x-rar-compressed|x-msdownload|octet-stream|pdf|gzip|x-gzip|vnd\.|x-bittorrent)|application\/force-download/i;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';

export function looksLikeDownloadUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return DOWNLOAD_EXT.test(u.pathname);
  } catch {
    return false;
  }
}

function sanitizeFilename(name: string): string {
  const cleaned = String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '_')
    .trim();
  return (cleaned || 'download').slice(0, 180);
}

function filenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split('/').pop() || '');
    if (last && last !== '/' && last !== '.') return last;
  } catch {
    /* ignore */
  }
  return 'download';
}

function filenameFromDisposition(raw: string): string {
  const star = raw.match(/filename\*=(?:UTF-8''|utf-8'')([^;]+)/i);
  if (star?.[1]) {
    try {
      return sanitizeFilename(decodeURIComponent(star[1].trim().replace(/^["']|["']$/g, '')));
    } catch {
      /* ignore */
    }
  }
  const plain = raw.match(/filename\s*=\s*"?([^";]+)"?/i);
  if (plain?.[1]) return sanitizeFilename(plain[1].trim());
  return '';
}

function header(headers: Record<string, string[] | string | undefined>, name: string): string {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  if (!key) return '';
  const v = headers[key];
  return Array.isArray(v) ? v.join('\n') : String(v || '');
}

function uniqueSavePath(dir: string, filename: string): string {
  mkdirSync(dir, { recursive: true });
  const safe = sanitizeFilename(filename);
  const ext = extname(safe);
  const base = basename(safe, ext);
  let dest = join(dir, safe);
  let i = 1;
  while (existsSync(dest)) {
    dest = join(dir, `${base} (${i})${ext}`);
    i += 1;
  }
  return dest;
}

type Job = {
  req?: ClientRequest;
  stream?: WriteStream;
  url: string;
  referer: string;
};

export class DownloadsManager {
  private readonly store: DownloadsStore;
  private readonly getRules: () => RulesConfig;
  private readonly onChanged: (latest?: DownloadEntry) => void;
  private readonly jobs = new Map<string, Job>();
  private ses: Session | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingLatest: DownloadEntry | undefined;
  private intercepting = new Set<string>();

  constructor(opts: {
    store: DownloadsStore;
    getRules: () => RulesConfig;
    onChanged: (latest?: DownloadEntry) => void;
  }) {
    this.store = opts.store;
    this.getRules = opts.getRules;
    this.onChanged = opts.onChanged;
  }

  attach(ses: Session): void {
    this.ses = ses;
    ses.webRequest.onHeadersReceived(
      { urls: ['http://*/*', 'https://*/*'] },
      (details, callback) => {
        if (this.shouldTakeOver(details)) {
          const cd = header(details.responseHeaders || {}, 'content-disposition');
          const name =
            filenameFromDisposition(cd) || filenameFromUrl(details.url);
          const url = details.url;
          callback({ cancel: true });
          setImmediate(() => this.startFromUrl(url, '', name));
          return;
        }
        callback({ responseHeaders: details.responseHeaders });
      }
    );
  }

  list(query?: string): DownloadEntry[] {
    return this.store.list(query);
  }

  count(): number {
    return this.store.count();
  }

  activeCount(): number {
    return this.store.activeCount();
  }

  snapshot(): { entries: DownloadEntry[]; count: number; activeCount: number } {
    return {
      entries: this.store.list(),
      count: this.store.count(),
      activeCount: this.store.activeCount(),
    };
  }

  startUrl(wc: WebContents, url: string): { ok: boolean; error?: string } {
    return this.startFromUrl(url, wc.getURL() || '');
  }

  startFromUrl(
    url: string,
    referer = '',
    suggestedName = ''
  ): { ok: boolean; error?: string } {
    const href = String(url || '').trim();
    if (!/^https?:\/\//i.test(href)) {
      return { ok: false, error: '当前没有可保存的网页' };
    }
    if (!isDownloadAllowed(href, this.getRules())) {
      return { ok: false, error: '该地址不允许下载' };
    }
    if (this.intercepting.has(href)) return { ok: true };
    this.intercepting.add(href);
    setTimeout(() => this.intercepting.delete(href), 8000);

    const filename = sanitizeFilename(suggestedName || filenameFromUrl(href));
    const dest = uniqueSavePath(app.getPath('downloads'), filename);
    const entry = this.store.add(
      {
        url: href,
        filename: basename(dest),
        filePath: dest,
        mime: '',
        state: 'progressing',
        receivedBytes: 0,
        totalBytes: 0,
        startedAt: Date.now(),
        paused: false,
      },
      false
    );
    this.jobs.set(entry.id, { url: href, referer });
    this.schedulePersist();
    this.scheduleNotify(entry);
    void this.runFetch(entry.id, href, dest, referer, 0);
    return { ok: true };
  }

  cancel(id: string): { ok: boolean; error?: string } {
    const job = this.jobs.get(id);
    if (!job) return { ok: false, error: '没有进行中的下载' };
    this.abortJob(id, 'cancelled');
    return { ok: true };
  }

  pause(id: string): { ok: boolean; error?: string } {
    const job = this.jobs.get(id);
    if (!job) return { ok: false, error: '没有进行中的下载' };
    this.abortJob(id, 'cancelled');
    this.store.update(id, { paused: true, state: 'cancelled' });
    this.flushAndNotify(this.store.get(id));
    return { ok: true };
  }

  resume(id: string): { ok: boolean; error?: string } {
    const entry = this.store.get(id);
    if (!entry) return { ok: false, error: '没有可继续的下载' };
    this.startFromUrl(entry.url, '', entry.filename);
    return { ok: true };
  }

  async open(id: string): Promise<{ ok: boolean; error?: string }> {
    const entry = this.store.get(id);
    if (!entry) return { ok: false, error: '记录不存在' };
    if (entry.state !== 'completed' || !entry.filePath || !existsSync(entry.filePath)) {
      return { ok: false, error: '文件不存在' };
    }
    const err = await shell.openPath(entry.filePath);
    return err ? { ok: false, error: err } : { ok: true };
  }

  showInFolder(id: string): { ok: boolean; error?: string } {
    const entry = this.store.get(id);
    if (!entry) return { ok: false, error: '记录不存在' };
    if (!entry.filePath || !existsSync(entry.filePath)) {
      return { ok: false, error: '文件不存在' };
    }
    shell.showItemInFolder(entry.filePath);
    return { ok: true };
  }

  openFolder(): { ok: boolean } {
    const dir = app.getPath('downloads');
    mkdirSync(dir, { recursive: true });
    void shell.openPath(dir);
    return { ok: true };
  }

  remove(id: string): { ok: boolean; error?: string } {
    this.abortJob(id, 'cancelled');
    const res = this.store.remove(id);
    if (res.ok) this.scheduleNotify();
    return res;
  }

  clear(): { ok: boolean } {
    const res = this.store.clear();
    this.scheduleNotify();
    return res;
  }

  private shouldTakeOver(details: Electron.OnHeadersReceivedListenerDetails): boolean {
    if (this.intercepting.has(details.url)) return false;
    if (!/^https?:/i.test(details.url)) return false;
    if (!isDownloadAllowed(details.url, this.getRules())) return false;
    const headers = details.responseHeaders || {};
    const cd = header(headers, 'content-disposition');
    const ct = header(headers, 'content-type');
    if (/attachment/i.test(cd)) return true;
    if (details.resourceType !== 'mainFrame') return false;
    if (/text\/html|text\/css|application\/(javascript|json|xml)|text\/xml/i.test(ct)) {
      return false;
    }
    return DOWNLOAD_MIME.test(ct) || looksLikeDownloadUrl(details.url);
  }

  private async runFetch(
    id: string,
    url: string,
    dest: string,
    referer: string,
    hops: number
  ): Promise<void> {
    if (!this.jobs.has(id)) return;
    if (hops > 6) {
      this.finish(id, 'interrupted');
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      this.finish(id, 'interrupted');
      return;
    }

    let cookie = '';
    try {
      const list = this.ses ? await this.ses.cookies.get({ url }) : [];
      cookie = list.map((c) => `${c.name}=${c.value}`).join('; ');
    } catch {
      cookie = '';
    }
    if (!this.jobs.has(id)) return;

    const send = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        headers: {
          'User-Agent': UA,
          Accept: '*/*',
          ...(cookie ? { Cookie: cookie } : {}),
          Referer: referer || `${parsed.origin}/`,
        },
      },
      (res) => this.onResponse(id, url, dest, referer, hops, res)
    );
    const job = this.jobs.get(id);
    if (job) job.req = req;
    req.on('error', () => this.finish(id, 'interrupted'));
    req.end();
  }

  private onResponse(
    id: string,
    url: string,
    dest: string,
    referer: string,
    hops: number,
    res: IncomingMessage
  ): void {
    if (!this.jobs.has(id)) {
      res.resume();
      return;
    }
    const status = res.statusCode || 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      const next = new URL(res.headers.location, url).toString();
      res.resume();
      void this.runFetch(id, next, dest, referer, hops + 1);
      return;
    }
    if (status >= 400) {
      res.resume();
      this.finish(id, 'interrupted');
      return;
    }

    const cd = String(res.headers['content-disposition'] || '');
    const fromHeader = filenameFromDisposition(cd);
    const current = this.store.get(id);
    let filePath = dest;
    if (fromHeader && current && current.filename === 'download') {
      filePath = uniqueSavePath(app.getPath('downloads'), fromHeader);
      this.store.update(id, { filename: basename(filePath), filePath });
    }

    const total = Number(res.headers['content-length']) || 0;
    const stream = createWriteStream(filePath);
    const job = this.jobs.get(id);
    if (job) job.stream = stream;
    this.store.update(id, {
      totalBytes: total,
      mime: String(res.headers['content-type'] || ''),
      filePath,
      filename: basename(filePath),
    });

    let received = 0;
    res.on('data', (chunk: Buffer) => {
      received += chunk.length;
      stream.write(chunk);
      this.store.update(id, { receivedBytes: received, totalBytes: total || received });
      this.scheduleNotify(this.store.get(id));
    });
    res.on('end', () => {
      stream.end();
      this.finish(id, 'completed', received, total || received);
    });
    res.on('error', () => {
      try {
        stream.destroy();
      } catch {
        /* ignore */
      }
      this.finish(id, 'interrupted');
    });
  }

  private abortJob(id: string, state: 'cancelled' | 'interrupted'): void {
    const job = this.jobs.get(id);
    if (!job) return;
    try {
      job.req?.destroy();
    } catch {
      /* ignore */
    }
    try {
      job.stream?.destroy();
    } catch {
      /* ignore */
    }
    this.jobs.delete(id);
    const next = this.store.update(id, { state, paused: false, endedAt: Date.now() });
    this.store.persist();
    this.scheduleNotify(next);
  }

  private finish(
    id: string,
    state: 'completed' | 'interrupted',
    received = 0,
    total = 0
  ): void {
    if (!this.jobs.has(id) && state === 'completed') return;
    this.jobs.delete(id);
    const next = this.store.update(id, {
      state,
      receivedBytes: received || this.store.get(id)?.receivedBytes || 0,
      totalBytes: total || this.store.get(id)?.totalBytes || 0,
      paused: false,
      endedAt: Date.now(),
    });
    this.store.persist();
    this.scheduleNotify(next);
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.store.persist();
    }, 400);
  }

  private scheduleNotify(latest?: DownloadEntry): void {
    if (latest) this.pendingLatest = latest;
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      const item = this.pendingLatest;
      this.pendingLatest = undefined;
      try {
        this.onChanged(item);
      } catch {
        /* window may be gone */
      }
    }, 80);
  }

  private flushAndNotify(entry?: DownloadEntry): void {
    this.store.persist();
    this.scheduleNotify(entry);
  }
}
