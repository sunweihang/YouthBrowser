export type ExtensionId = 'none' | 'bilibili';

export interface ExtensionMeta {
  id: ExtensionId;
  label: string;
  description: string;
}

/** Built-in extensions parents can attach to a config group. */
export const EXTENSION_CATALOG: ExtensionMeta[] = [
  {
    id: 'none',
    label: '无（仅域名放行）',
    description: '匹配域名后整站可访问，不做额外内容过滤。',
  },
  {
    id: 'bilibili',
    label: 'B 站',
    description: '允许首页与搜索，以及指定 UP 的空间与视频；热门/动态等仍拦截。',
  },
];

export interface BilibiliExtensionConfig {
  allowedMids: string[];
  midNotes: Record<string, string>;
}

export interface SiteGroup {
  id: string;
  name: string;
  enabled: boolean;
  hosts: string[];
  extensionId: ExtensionId;
  /** Extension-specific payload (shape depends on extensionId). */
  extensionConfig: Record<string, unknown>;
}

export interface RulesConfig {
  version: 2;
  parentPasswordHash: string;
  /** Master switch: policies only apply when true. Default off. */
  filteringEnabled: boolean;
  /** http(s) homepage. Empty = new-tab welcome page. */
  homepage: string;
  groups: SiteGroup[];
}

export interface PublicRules {
  hasPassword: boolean;
  filteringEnabled: boolean;
  homepage: string;
  groups: SiteGroup[];
  extensions: ExtensionMeta[];
}

export type BlockReason =
  | 'invalid_url'
  | 'host_denied'
  | 'bili_path_denied'
  | 'bili_up_denied'
  | 'bili_resolve_failed'
  | 'protocol_denied';

export interface NavigateResult {
  allowed: boolean;
  reason?: BlockReason;
  finalUrl?: string;
  message?: string;
  meta?: {
    mid?: string;
    bvid?: string;
    aid?: string;
    title?: string;
  };
}

/** Suggested hosts when creating a Bilibili group (editable, not locked). */
export const BILI_SUGGESTED_HOSTS = [
  'www.bilibili.com',
  'm.bilibili.com',
  'space.bilibili.com',
  'www.b23.tv',
  'b23.tv',
  'api.bilibili.com',
  '*.hdslb.com',
  '*.bilivideo.com',
  '*.akamaized.net',
];

export const BILI_HOST_SUFFIXES = [
  'bilibili.com',
  'b23.tv',
  'hdslb.com',
  'bilivideo.com',
  'akamaized.net',
];

export function emptyBiliConfig(): BilibiliExtensionConfig {
  return { allowedMids: [], midNotes: {} };
}

export interface HistoryEntry {
  id: string;
  url: string;
  title: string;
  host: string;
  visitedAt: number;
}

export function asBiliConfig(
  raw: Record<string, unknown> | undefined
): BilibiliExtensionConfig {
  const allowedMids = Array.isArray(raw?.allowedMids)
    ? (raw!.allowedMids as unknown[]).map(String).filter((m) => /^\d+$/.test(m))
    : [];
  const midNotes =
    raw?.midNotes && typeof raw.midNotes === 'object'
      ? (raw.midNotes as Record<string, string>)
      : {};
  return { allowedMids, midNotes };
}
