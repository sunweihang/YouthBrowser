import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';

export interface SitePasswordPublic {
  id: string;
  origin: string;
  host: string;
  username: string;
  updatedAt: number;
}

interface SitePasswordRecord extends SitePasswordPublic {
  password: string;
}

type StoreFile = {
  version: 1;
  entries: Array<{
    id: string;
    origin: string;
    host: string;
    username: string;
    secret: string;
    updatedAt: number;
  }>;
};

function storePath(): string {
  return join(app.getPath('userData'), 'site-passwords.json');
}

function newId(): string {
  return `p_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function seal(plain: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return `s:${safeStorage.encryptString(plain).toString('base64')}`;
  }
  return `b:${Buffer.from(plain, 'utf8').toString('base64')}`;
}

function unseal(secret: string): string {
  if (!secret) return '';
  try {
    if (secret.startsWith('s:')) {
      return safeStorage.decryptString(Buffer.from(secret.slice(2), 'base64'));
    }
    if (secret.startsWith('b:')) {
      return Buffer.from(secret.slice(2), 'base64').toString('utf8');
    }
  } catch {
    return '';
  }
  return '';
}

export class SitePasswordsStore {
  private entries: SitePasswordRecord[] = [];

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
      this.entries = (Array.isArray(raw.entries) ? raw.entries : [])
        .map((e) => ({
          id: String(e.id || newId()),
          origin: String(e.origin || ''),
          host: String(e.host || hostOf(String(e.origin || ''))),
          username: String(e.username || ''),
          password: unseal(String(e.secret || '')),
          updatedAt: Number(e.updatedAt) || 0,
        }))
        .filter((e) => e.origin && e.password);
    } catch {
      this.entries = [];
    }
  }

  private persist(): void {
    const path = storePath();
    mkdirSync(dirname(path), { recursive: true });
    const data: StoreFile = {
      version: 1,
      entries: this.entries.map((e) => ({
        id: e.id,
        origin: e.origin,
        host: e.host,
        username: e.username,
        secret: seal(e.password),
        updatedAt: e.updatedAt,
      })),
    };
    writeFileSync(path, JSON.stringify(data), 'utf8');
  }

  listPublic(): SitePasswordPublic[] {
    return this.entries
      .map(({ id, origin, host, username, updatedAt }) => ({
        id,
        origin,
        host,
        username,
        updatedAt,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  lookup(origin: string): { username: string; password: string } | null {
    const rows = this.entries
      .filter((e) => e.origin === origin)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const hit = rows[0];
    return hit ? { username: hit.username, password: hit.password } : null;
  }

  find(origin: string, username: string): SitePasswordRecord | undefined {
    return this.entries.find(
      (e) => e.origin === origin && e.username === username
    );
  }

  save(origin: string, username: string, password: string): SitePasswordPublic | null {
    const user = String(username || '').trim();
    const pass = String(password || '');
    if (!origin || !user || !pass) return null;
    const now = Date.now();
    const existing = this.find(origin, user);
    if (existing) {
      existing.password = pass;
      existing.updatedAt = now;
    } else {
      this.entries.push({
        id: newId(),
        origin,
        host: hostOf(origin),
        username: user,
        password: pass,
        updatedAt: now,
      });
    }
    this.persist();
    const row = this.find(origin, user);
    return row
      ? {
          id: row.id,
          origin: row.origin,
          host: row.host,
          username: row.username,
          updatedAt: row.updatedAt,
        }
      : null;
  }

  remove(id: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length === before) return false;
    this.persist();
    return true;
  }
}
