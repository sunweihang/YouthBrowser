import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

export interface AccountSession {
  serverUrl: string;
  username: string;
  token: string;
  lastSyncAt?: number;
  lastRevision?: number;
}

const DEFAULT_SERVER_URL = 'https://spacedreams.cn/simplygo-api';

function accountPath(): string {
  return join(app.getPath('userData'), 'account.json');
}

export class AccountStore {
  private session: AccountSession | null;

  constructor() {
    this.session = this.load();
  }

  private load(): AccountSession | null {
    const path = accountPath();
    if (!existsSync(path)) return null;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<AccountSession>;
      if (!raw.token || !raw.username || !raw.serverUrl) return null;
      return {
        serverUrl: String(raw.serverUrl).replace(/\/$/, ''),
        username: String(raw.username),
        token: String(raw.token),
        lastSyncAt: typeof raw.lastSyncAt === 'number' ? raw.lastSyncAt : undefined,
        lastRevision:
          typeof raw.lastRevision === 'number' ? raw.lastRevision : undefined,
      };
    } catch {
      return null;
    }
  }

  private persist(): void {
    const path = accountPath();
    mkdirSync(dirname(path), { recursive: true });
    if (!this.session) {
      writeFileSync(path, '{}', 'utf8');
      return;
    }
    writeFileSync(path, JSON.stringify(this.session, null, 2), 'utf8');
  }

  getServerUrl(): string {
    return this.session?.serverUrl || DEFAULT_SERVER_URL;
  }

  getSession(): AccountSession | null {
    return this.session ? { ...this.session } : null;
  }

  isLoggedIn(): boolean {
    return Boolean(this.session?.token);
  }

  setSession(session: AccountSession): void {
    this.session = {
      ...session,
      serverUrl: session.serverUrl.replace(/\/$/, ''),
    };
    this.persist();
  }

  clearSession(): void {
    this.session = null;
    this.persist();
  }

  touchSync(revision: number): void {
    if (!this.session) return;
    this.session.lastSyncAt = Date.now();
    this.session.lastRevision = revision;
    this.persist();
  }

  getPublic() {
    const s = this.session;
    return {
      loggedIn: Boolean(s?.token),
      username: s?.username || '',
      serverUrl: this.getServerUrl(),
      lastSyncAt: s?.lastSyncAt || 0,
      lastRevision: s?.lastRevision || 0,
    };
  }
}

export { DEFAULT_SERVER_URL };
