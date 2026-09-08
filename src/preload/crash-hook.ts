import { ipcRenderer } from 'electron';

function send(source: string, message: string, stack?: string, url?: string): void {
  try {
    void ipcRenderer.invoke('error:report', {
      kind: 'renderer-js',
      message: String(message || 'unknown').slice(0, 2000),
      stack: stack ? String(stack).slice(0, 16000) : undefined,
      url: url ? String(url).slice(0, 1024) : undefined,
      extra: { source },
    });
  } catch {
    /* ignore */
  }
}

type ErrorEventLike = {
  message?: string;
  error?: unknown;
  filename?: string;
};

type RejectionEventLike = {
  reason?: unknown;
};

const root = globalThis as typeof globalThis & {
  addEventListener(type: string, listener: (event: ErrorEventLike & RejectionEventLike) => void): void;
};

export function installRendererCrashHooks(source: string): void {
  root.addEventListener('error', (e) => {
    const err = e.error;
    send(
      source,
      e.message || 'window.error',
      err instanceof Error ? err.stack : undefined,
      e.filename
    );
  });
  root.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    send(
      source,
      r instanceof Error ? r.message : String(r),
      r instanceof Error ? r.stack : undefined
    );
  });
}
