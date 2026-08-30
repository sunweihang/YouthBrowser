import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';
import {
  asBiliConfig,
  BILI_SUGGESTED_HOSTS,
  emptyBiliConfig,
  EXTENSION_CATALOG,
  ExtensionId,
  PublicRules,
  RulesConfig,
  SiteGroup,
} from '../shared/types';
import { hashPassword, verifyPassword } from './parent-auth';

function rulesPath(): string {
  return join(app.getPath('userData'), 'rules.json');
}

function newId(): string {
  return `g_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

function cleanHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .replace(/\/$/, '');
}

function defaultExtensionConfig(extensionId: ExtensionId): Record<string, unknown> {
  if (extensionId === 'bilibili') {
    return { ...emptyBiliConfig() };
  }
  return {};
}

function defaultRules(): RulesConfig {
  return {
    version: 2,
    parentPasswordHash: '',
    filteringEnabled: false,
    homepage: '',
    groups: [],
  };
}

function readHomepage(raw: unknown): string {
  const parsed = normalizeHomepage(typeof raw === 'string' ? raw : '');
  return parsed.ok ? parsed.url : '';
}

export function normalizeHomepage(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const s = String(raw || '').trim();
  if (!s) return { ok: true, url: '' };
  let url = s;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) {
    url = `https://${url}`;
  }
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, error: '仅支持 http/https 地址' };
    }
    return { ok: true, url: u.toString() };
  } catch {
    return { ok: false, error: '网址无效' };
  }
}

function normalizeGroup(raw: Partial<SiteGroup>): SiteGroup | null {
  if (!raw || typeof raw !== 'object') return null;
  const extensionId: ExtensionId =
    raw.extensionId === 'bilibili' ? 'bilibili' : 'none';
  const hosts = Array.isArray(raw.hosts)
    ? [...new Set(raw.hosts.map(cleanHost).filter(Boolean))]
    : [];
  let extensionConfig: Record<string, unknown> =
    raw.extensionConfig && typeof raw.extensionConfig === 'object'
      ? { ...raw.extensionConfig }
      : defaultExtensionConfig(extensionId);
  if (extensionId === 'bilibili') {
    extensionConfig = { ...asBiliConfig(extensionConfig) };
  }
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : '未命名配置组',
    enabled: raw.enabled !== false,
    hosts,
    extensionId,
    extensionConfig,
  };
}

/** Migrate v1 flat whitelist → v2 groups. */
function migrateV1(raw: Record<string, unknown>): RulesConfig {
  const hosts = Array.isArray(raw.allowedHosts)
    ? (raw.allowedHosts as string[]).map(cleanHost).filter(Boolean)
    : [...BILI_SUGGESTED_HOSTS];
  const mids = Array.isArray(raw.allowedBiliMids)
    ? (raw.allowedBiliMids as unknown[]).map(String)
    : [];
  const notes =
    raw.biliUpNotes && typeof raw.biliUpNotes === 'object'
      ? (raw.biliUpNotes as Record<string, string>)
      : {};
  const group: SiteGroup = {
    id: newId(),
    name: 'B 站',
    enabled: raw.biliHostsEnabled !== false,
    hosts: hosts.length ? hosts : [...BILI_SUGGESTED_HOSTS],
    extensionId: 'bilibili',
    extensionConfig: {
      allowedMids: mids,
      midNotes: notes,
    },
  };
  return {
    version: 2,
    parentPasswordHash:
      typeof raw.parentPasswordHash === 'string' ? raw.parentPasswordHash : '',
    filteringEnabled: raw.filteringEnabled === true,
    homepage: '',
    groups: [group],
  };
}

export class RulesStore {
  private rules: RulesConfig;

  constructor() {
    this.rules = this.load();
  }

  private load(): RulesConfig {
    const path = rulesPath();
    if (!existsSync(path)) {
      const initial = defaultRules();
      this.persist(initial);
      return initial;
    }
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      if (raw.version === 2 && Array.isArray(raw.groups)) {
        const groups = (raw.groups as Partial<SiteGroup>[])
          .map(normalizeGroup)
          .filter((g): g is SiteGroup => Boolean(g));
        return {
          version: 2,
          parentPasswordHash:
            typeof raw.parentPasswordHash === 'string'
              ? raw.parentPasswordHash
              : '',
          filteringEnabled: raw.filteringEnabled === true,
          homepage: readHomepage(raw.homepage),
          groups,
        };
      }
      // v1 or unknown → migrate
      const migrated = migrateV1(raw);
      this.persist(migrated);
      return migrated;
    } catch {
      return defaultRules();
    }
  }

  private persist(rules: RulesConfig = this.rules): void {
    const path = rulesPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(rules, null, 2), 'utf8');
  }

  getPublic(): PublicRules {
    return {
      hasPassword: Boolean(this.rules.parentPasswordHash),
      filteringEnabled: this.isFilteringEnabled(),
      homepage: this.getHomepage(),
      groups: this.rules.groups.map((g) => ({
        ...g,
        hosts: [...g.hosts],
        extensionConfig: { ...g.extensionConfig },
      })),
      extensions: EXTENSION_CATALOG.map((e) => ({ ...e })),
    };
  }

  getRaw(): RulesConfig {
    return this.rules;
  }

  hasPassword(): boolean {
    return Boolean(this.rules.parentPasswordHash);
  }

  isFilteringEnabled(): boolean {
    return this.rules.filteringEnabled === true;
  }

  getHomepage(): string {
    return this.rules.homepage || '';
  }

  setHomepage(raw: string): { ok: boolean; error?: string; rules?: PublicRules } {
    const parsed = normalizeHomepage(raw);
    if (!parsed.ok) return parsed;
    this.rules.homepage = parsed.url;
    this.persist();
    return { ok: true, rules: this.getPublic() };
  }

  setFilteringEnabled(
    enabled: boolean
  ): { ok: boolean; rules?: PublicRules } {
    this.rules.filteringEnabled = Boolean(enabled);
    this.persist();
    return { ok: true, rules: this.getPublic() };
  }

  setPassword(password: string): { ok: boolean; error?: string } {
    if (!password || password.length < 4) {
      return { ok: false, error: '密码至少 4 位' };
    }
    this.rules.parentPasswordHash = hashPassword(password);
    this.persist();
    return { ok: true };
  }

  changePassword(
    current: string,
    next: string
  ): { ok: boolean; error?: string } {
    if (!this.verify(current)) {
      return { ok: false, error: '当前密码错误' };
    }
    return this.setPassword(next);
  }

  verify(password: string): boolean {
    if (!this.rules.parentPasswordHash) return false;
    return verifyPassword(password, this.rules.parentPasswordHash);
  }

  private findGroup(id: string): SiteGroup | undefined {
    return this.rules.groups.find((g) => g.id === id);
  }

  createGroup(input: {
    name: string;
    extensionId?: ExtensionId;
    useSuggestedHosts?: boolean;
  }): { ok: boolean; error?: string; group?: SiteGroup; rules?: PublicRules } {
    const name = (input.name || '').trim();
    if (!name) return { ok: false, error: '请填写配置组名称' };
    const extensionId: ExtensionId =
      input.extensionId === 'bilibili' ? 'bilibili' : 'none';
    const hosts =
      extensionId === 'bilibili' && input.useSuggestedHosts !== false
        ? [...BILI_SUGGESTED_HOSTS]
        : [];
    const group: SiteGroup = {
      id: newId(),
      name,
      enabled: true,
      hosts,
      extensionId,
      extensionConfig: defaultExtensionConfig(extensionId),
    };
    this.rules.groups.push(group);
    this.persist();
    return { ok: true, group, rules: this.getPublic() };
  }

  updateGroup(
    id: string,
    patch: Partial<Pick<SiteGroup, 'name' | 'enabled' | 'extensionId'>>
  ): { ok: boolean; error?: string; rules?: PublicRules } {
    const group = this.findGroup(id);
    if (!group) return { ok: false, error: '配置组不存在' };
    if (typeof patch.name === 'string' && patch.name.trim()) {
      group.name = patch.name.trim();
    }
    if (typeof patch.enabled === 'boolean') {
      group.enabled = patch.enabled;
    }
    if (patch.extensionId === 'bilibili' || patch.extensionId === 'none') {
      if (patch.extensionId !== group.extensionId) {
        group.extensionId = patch.extensionId;
        group.extensionConfig = defaultExtensionConfig(patch.extensionId);
      }
    }
    this.persist();
    return { ok: true, rules: this.getPublic() };
  }

  deleteGroup(id: string): { ok: boolean; error?: string; rules?: PublicRules } {
    const before = this.rules.groups.length;
    this.rules.groups = this.rules.groups.filter((g) => g.id !== id);
    if (this.rules.groups.length === before) {
      return { ok: false, error: '配置组不存在' };
    }
    this.persist();
    return { ok: true, rules: this.getPublic() };
  }

  addHost(
    groupId: string,
    host: string
  ): { ok: boolean; error?: string; rules?: PublicRules } {
    const group = this.findGroup(groupId);
    if (!group) return { ok: false, error: '配置组不存在' };
    const cleaned = cleanHost(host);
    if (!cleaned) return { ok: false, error: '无效域名' };
    if (!group.hosts.includes(cleaned)) group.hosts.push(cleaned);
    this.persist();
    return { ok: true, rules: this.getPublic() };
  }

  removeHost(
    groupId: string,
    host: string
  ): { ok: boolean; error?: string; rules?: PublicRules } {
    const group = this.findGroup(groupId);
    if (!group) return { ok: false, error: '配置组不存在' };
    group.hosts = group.hosts.filter((h) => h !== host);
    this.persist();
    return { ok: true, rules: this.getPublic() };
  }

  addBiliUp(
    groupId: string,
    mid: string,
    note?: string
  ): { ok: boolean; error?: string; rules?: PublicRules } {
    const group = this.findGroup(groupId);
    if (!group) return { ok: false, error: '配置组不存在' };
    if (group.extensionId !== 'bilibili') {
      return { ok: false, error: '该配置组未启用 B 站扩展' };
    }
    const cfg = asBiliConfig(group.extensionConfig);
    if (!cfg.allowedMids.includes(mid)) cfg.allowedMids.push(mid);
    if (note) cfg.midNotes[mid] = note;
    group.extensionConfig = { ...cfg };
    this.persist();
    return { ok: true, rules: this.getPublic() };
  }

  removeBiliUp(
    groupId: string,
    mid: string
  ): { ok: boolean; error?: string; rules?: PublicRules } {
    const group = this.findGroup(groupId);
    if (!group) return { ok: false, error: '配置组不存在' };
    if (group.extensionId !== 'bilibili') {
      return { ok: false, error: '该配置组未启用 B 站扩展' };
    }
    const cfg = asBiliConfig(group.extensionConfig);
    cfg.allowedMids = cfg.allowedMids.filter((m) => m !== mid);
    delete cfg.midNotes[mid];
    group.extensionConfig = { ...cfg };
    this.persist();
    return { ok: true, rules: this.getPublic() };
  }

  /** Replace all groups from cloud sync (keeps local parent password). */
  replaceGroups(
    groups: SiteGroup[]
  ): { ok: boolean; error?: string; rules?: PublicRules } {
    if (!Array.isArray(groups)) {
      return { ok: false, error: '配置格式无效' };
    }
    const normalized = groups
      .map((g) => normalizeGroup(g))
      .filter((g): g is SiteGroup => Boolean(g));
    this.rules.groups = normalized;
    this.persist();
    return { ok: true, rules: this.getPublic() };
  }

  exportGroups(): SiteGroup[] {
    return this.rules.groups.map((g) => ({
      ...g,
      hosts: [...g.hosts],
      extensionConfig: { ...g.extensionConfig },
    }));
  }
}

export function extractMidFromInput(input: string): string | null {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(
      trimmed.startsWith('http') ? trimmed : `https://${trimmed}`
    );
    if (url.hostname.includes('space.bilibili.com')) {
      const m = url.pathname.match(/^\/(\d+)/);
      if (m) return m[1];
    }
    const midParam = url.searchParams.get('mid');
    if (midParam && /^\d+$/.test(midParam)) return midParam;
  } catch {
    // ignore
  }
  const spaceMatch = trimmed.match(/space\.bilibili\.com\/(\d+)/);
  if (spaceMatch) return spaceMatch[1];
  return null;
}
