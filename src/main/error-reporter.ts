import { app, type RenderProcessGoneDetails, type WebContents } from 'electron';
import { randomUUID } from 'crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { release as osRelease } from 'os';
import { DEFAULT_SERVER_URL } from './account-store';

export type CrashKind =
  | 'uncaught'
  | 'unhandledrejection'
  | 'render-gone'
  | 'child-gone'
  | 'unresponsive'
  | 'page-fail'
  | 'renderer-js';

export interface CrashInput {
  kind: CrashKind;
  message: string;
  stack?: string;
  url?: string;
  extra?: Record<string, unknown>;
  level?: 'error' | 'fatal';
}

interface CrashPayload extends CrashInput {
  id: string;
  ts: number;
  platform: string;
  arch: string;
  osRelease: string;
  appVersion: string;
  electronVersion: string;
  installId: string;
  username: string;
}

export interface ErrorReporterContext {
  getServerUrl: () => string;
  getUsername: () => string;
  getToken: () => string | undefined;
}

const MAX_MESSAGE = 2_000;
const MAX_STACK = 16_000;
const MAX_URL = 1_024;
const MAX_PENDING = 40;
const MAX_LOG_BYTES = 1_500_000;
const DEDUP_MS = 60_000;
const MAX_UPLOADS_PER_WINDOW = 20;
const UPLOAD_WINDOW_MS = 10 * 60_000;
const FLUSH_INTERVAL_MS = 5 * 60_000;

let ctx: ErrorReporterContext | null = null;
let installId = '';
let hooksInstalled = false;
const earlyQueue: CrashInput[] = [];
const recentKeys = new Map<string, number>();
const uploadTimes: number[] = [];

function logsDir(): string {
  let root: string;
  try {
    root = app.getPath('userData');
  } catch {
    root = join(process.cwd(), 'userData');
  }
  return join(root, 'logs');
}

function ensureLogsDir(): string {
  const dir = logsDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

function clip(value: unknown, max: number): string {
  return String(value ?? '')
    .replace(/\u0000/g, '')
    .slice(0, max);
}

function pendingPath(): string {
  return join(ensureLogsDir(), 'pending-reports.json');
}

function logPath(): string {
  return join(ensureLogsDir(), 'app.log');
}

function installIdPath(): string {
  return join(ensureLogsDir(), 'install-id.txt');
}

function loadInstallId(): string {
  const path = installIdPath();
  try {
    if (existsSync(path)) {
      const id = readFileSync(path, 'utf8').trim();
      if (id) return id;
    }
  } catch {
    /* create a new one */
  }
  const id = randomUUID();
  try {
    writeFileSync(path, id, 'utf8');
  } catch {
    /* ignore */
  }
  return id;
}

function rotateLogIfNeeded(): void {
  const path = logPath();
  try {
    if (!existsSync(path) || statSync(path).size < MAX_LOG_BYTES) return;
    const bak = join(ensureLogsDir(), 'app.prev.log');
    try {
      if (existsSync(bak)) unlinkSync(bak);
    } catch {
      /* ignore */
    }
    renameSync(path, bak);
  } catch {
    /* ignore */
  }
}

function writeLocalLog(line: string): void {
  try {
    rotateLogIfNeeded();
    appendFileSync(logPath(), `${line}\n`, 'utf8');
  } catch {
    /* ignore */
  }
}

function readPending(): CrashPayload[] {
  const path = pendingPath();
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(raw) ? (raw as CrashPayload[]) : [];
  } catch {
    return [];
  }
}

function writePending(items: CrashPayload[]): void {
  try {
    const dir = dirname(pendingPath());
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      pendingPath(),
      JSON.stringify(items.slice(-MAX_PENDING)),
      'utf8'
    );
  } catch {
    /* ignore */
  }
}

function enqueuePending(payload: CrashPayload): void {
  const items = readPending();
  items.push(payload);
  writePending(items);
}

function dedupKey(input: CrashInput): string {
  return `${input.kind}|${clip(input.message, 200)}|${clip(input.url, 200)}`;
}

function shouldDedup(input: CrashInput): boolean {
  const now = Date.now();
  for (const [key, ts] of recentKeys) {
    if (now - ts > DEDUP_MS) recentKeys.delete(key);
  }
  const key = dedupKey(input);
  const prev = recentKeys.get(key);
  if (prev && now - prev < DEDUP_MS) return true;
  recentKeys.set(key, now);
  return false;
}

function allowUpload(): boolean {
  const now = Date.now();
  while (uploadTimes.length && now - uploadTimes[0] > UPLOAD_WINDOW_MS) {
    uploadTimes.shift();
  }
  if (uploadTimes.length >= MAX_UPLOADS_PER_WINDOW) return false;
  uploadTimes.push(now);
  return true;
}

function buildPayload(input: CrashInput): CrashPayload {
  let extra: Record<string, unknown> | undefined;
  if (input.extra && typeof input.extra === 'object') {
    try {
      extra = JSON.parse(
        clip(JSON.stringify(input.extra), 8_000) || '{}'
      ) as Record<string, unknown>;
    } catch {
      extra = undefined;
    }
  }
  return {
    kind: input.kind,
    message: clip(input.message, MAX_MESSAGE) || 'unknown error',
    stack: input.stack ? clip(input.stack, MAX_STACK) : undefined,
    url: input.url ? clip(input.url, MAX_URL) : undefined,
    extra,
    level: input.level || (input.kind === 'uncaught' || input.kind === 'render-gone'
      ? 'fatal'
      : 'error'),
    id: randomUUID(),
    ts: Date.now(),
    platform: process.platform,
    arch: process.arch,
    osRelease: osRelease(),
    appVersion: app.getVersion?.() || '',
    electronVersion: process.versions.electron || '',
    installId: installId || loadInstallId(),
    username: clip(ctx?.getUsername() || '', 64),
  };
}

async function postPayload(payload: CrashPayload): Promise<boolean> {
  const base = (ctx?.getServerUrl() || DEFAULT_SERVER_URL).replace(/\/$/, '');
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-SimplyGo-Client': 'desktop',
  };
  const token = ctx?.getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const res = await fetch(`${base}/telemetry/crash`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) return false;
    const data = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    return Boolean(data?.ok);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function upload(payload: CrashPayload): Promise<void> {
  if (!allowUpload()) {
    enqueuePending(payload);
    return;
  }
  const ok = await postPayload(payload);
  if (!ok) enqueuePending(payload);
}

export async function flushPendingReports(): Promise<void> {
  const items = readPending();
  if (!items.length) return;
  const remain: CrashPayload[] = [];
  for (const item of items) {
    if (!allowUpload()) {
      remain.push(item);
      continue;
    }
    const ok = await postPayload(item);
    if (!ok) remain.push(item);
  }
  writePending(remain);
}

export function reportCrash(input: CrashInput): void {
  try {
    if (!input || !input.kind) return;
    if (shouldDedup(input)) return;
    const line = [
      new Date().toISOString(),
      `[${input.level || input.kind}]`,
      input.kind,
      clip(input.message, 400),
      input.url ? clip(input.url, 300) : '',
    ]
      .filter(Boolean)
      .join(' ');
    writeLocalLog(line);
    if (input.stack) writeLocalLog(clip(input.stack, 2000));
    if (!ctx) {
      earlyQueue.push(input);
      return;
    }
    const payload = buildPayload(input);
    void upload(payload);
  } catch {
    /* never throw from the reporter */
  }
}

export function sanitizeRendererReport(raw: unknown): CrashInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const message = clip(o.message, MAX_MESSAGE);
  if (!message) return null;
  return {
    kind: 'renderer-js',
    message,
    stack: o.stack ? clip(o.stack, MAX_STACK) : undefined,
    url: o.url ? clip(o.url, MAX_URL) : undefined,
    extra:
      o.extra && typeof o.extra === 'object'
        ? (o.extra as Record<string, unknown>)
        : undefined,
    level: 'error',
  };
}

export function installProcessHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.on('uncaughtException', (err) => {
    reportCrash({
      kind: 'uncaught',
      level: 'fatal',
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  });
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    reportCrash({
      kind: 'unhandledrejection',
      level: 'error',
      message: err.message,
      stack: err.stack,
    });
  });
}

const CRASHY_FAIL = /crash|killed|oom|out of memory|access.?violation|abnormal|status_access/i;
const IGNORE_FAIL_CODES = new Set([
  -3, // ERR_ABORTED
  -27, // ERR_BLOCKED_BY_CLIENT
]);

export function attachWebContentsDiagnostics(
  wc: WebContents,
  opts?: {
    onRenderGone?: (wc: WebContents, details: RenderProcessGoneDetails) => void;
  }
): void {
  wc.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return;
    let url = '';
    try {
      url = wc.getURL();
    } catch {
      url = '';
    }
    reportCrash({
      kind: 'render-gone',
      level: 'fatal',
      message: `renderer ${details.reason} exit=${details.exitCode}`,
      url,
      extra: {
        reason: details.reason,
        exitCode: details.exitCode,
      },
    });
    opts?.onRenderGone?.(wc, details);
  });

  wc.on('unresponsive', () => {
    let url = '';
    try {
      url = wc.getURL();
    } catch {
      url = '';
    }
    reportCrash({
      kind: 'unresponsive',
      level: 'error',
      message: 'page unresponsive',
      url,
    });
  });

  wc.on(
    'did-fail-load',
    (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      if (IGNORE_FAIL_CODES.has(errorCode)) return;
      if (validatedURL && validatedURL.startsWith('file:')) return;
      if (!CRASHY_FAIL.test(errorDescription || '')) return;
      reportCrash({
        kind: 'page-fail',
        level: 'error',
        message: `${errorDescription || 'load failed'} (${errorCode})`,
        url: validatedURL,
        extra: { errorCode, errorDescription },
      });
    }
  );
}

export function initErrorReporter(context: ErrorReporterContext): void {
  ctx = context;
  installId = loadInstallId();
  writeLocalLog(`${new Date().toISOString()} [boot] v${app.getVersion()} ${process.platform}`);
  const queued = earlyQueue.splice(0, earlyQueue.length);
  for (const item of queued) reportCrash(item);
  void flushPendingReports();
  const timer = setInterval(() => {
    void flushPendingReports();
  }, FLUSH_INTERVAL_MS);
  timer.unref?.();
}
