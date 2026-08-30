import {
  asBiliConfig,
  BILI_HOST_SUFFIXES,
  BlockReason,
  NavigateResult,
  RulesConfig,
  SiteGroup,
} from '../shared/types';
import {
  parseBiliVideoId,
  parseSpaceMid,
  resolveShortUrl,
  resolveVideoOwner,
} from './bili-resolver';

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

export function isBiliFamilyHost(host: string): boolean {
  const h = normalizeHost(host);
  return BILI_HOST_SUFFIXES.some(
    (suffix) => h === suffix || h.endsWith(`.${suffix}`)
  );
}

export function hostAllowed(host: string, allowedHosts: string[]): boolean {
  const h = normalizeHost(host);
  for (const raw of allowedHosts) {
    const rule = normalizeHost(raw);
    if (!rule) continue;
    if (rule.startsWith('*.')) {
      const suffix = rule.slice(2);
      if (h === suffix || h.endsWith(`.${suffix}`)) return true;
    } else if (h === rule) {
      return true;
    }
  }
  return false;
}

function matchingGroups(host: string, rules: RulesConfig): SiteGroup[] {
  return rules.groups.filter(
    (g) => g.enabled && hostAllowed(host, g.hosts)
  );
}

function hasEnabledBiliExtension(rules: RulesConfig): boolean {
  return rules.groups.some((g) => g.enabled && g.extensionId === 'bilibili');
}

function biliMidsFromGroups(groups: SiteGroup[]): string[] {
  const mids = new Set<string>();
  for (const g of groups) {
    if (g.extensionId !== 'bilibili') continue;
    for (const mid of asBiliConfig(g.extensionConfig).allowedMids) {
      mids.add(mid);
    }
  }
  return [...mids];
}

const STATIC_ASSET_HOSTS = [
  'hdslb.com',
  'bilivideo.com',
  'akamaized.net',
  'api.bilibili.com',
];

function isBiliStaticOrApi(host: string): boolean {
  const h = normalizeHost(host);
  return STATIC_ASSET_HOSTS.some(
    (suffix) => h === suffix || h.endsWith(`.${suffix}`)
  );
}

function deny(
  reason: BlockReason,
  message: string,
  meta?: NavigateResult['meta']
): NavigateResult {
  return { allowed: false, reason, message, meta };
}

function allow(finalUrl: string): NavigateResult {
  return { allowed: true, finalUrl };
}

function isAllowedBiliPath(
  pathname: string
): 'space' | 'video' | 'asset' | 'search' | 'home' | false {
  if (
    pathname.startsWith('/bfs/') ||
    pathname.startsWith('/favicon') ||
    pathname === '/robots.txt'
  ) {
    return 'asset';
  }
  // Homepage only (not 热门/动态/分区等)
  if (pathname === '/' || pathname === '') {
    return 'home';
  }
  if (
    pathname === '/search' ||
    pathname.startsWith('/search/') ||
    pathname === '/s' ||
    pathname.startsWith('/s/')
  ) {
    return 'search';
  }
  if (/\/video\/(BV[\w]+|av\d+)/i.test(pathname)) return 'video';
  if (/^\/space\/\d+(?:\/|$)/i.test(pathname)) return 'space';
  if (/^\/\d+(?:\/|$)/.test(pathname)) return 'space';
  return false;
}

function isBiliSearchHost(host: string): boolean {
  const h = normalizeHost(host);
  return h === 'search.bilibili.com' || h.endsWith('.search.bilibili.com');
}

async function enforceBilibili(
  url: URL,
  host: string,
  allowedMids: string[]
): Promise<NavigateResult> {
  const pathname = url.pathname || '/';

  if (isBiliStaticOrApi(host) && !host.includes('www.bilibili') && !host.includes('m.bilibili') && !host.includes('space.bilibili')) {
    return allow(url.toString());
  }

  if (host === 'space.bilibili.com' || host.endsWith('.space.bilibili.com')) {
    const mid = parseSpaceMid(pathname);
    if (!mid) {
      return deny('bili_path_denied', '仅允许打开指定 UP 的空间主页');
    }
    if (!allowedMids.includes(mid)) {
      return deny('bili_up_denied', `UP ${mid} 不在允许列表`, { mid });
    }
    return allow(url.toString());
  }

  if (
    host === 'www.bilibili.com' ||
    host === 'm.bilibili.com' ||
    host.endsWith('.bilibili.com')
  ) {
    const kind = isAllowedBiliPath(pathname);
    if (kind === 'asset' || kind === 'search' || kind === 'home') {
      return allow(url.toString());
    }
    if (kind === 'video') {
      const ids = parseBiliVideoId(pathname);
      if (!ids) return deny('bili_path_denied', '无法识别视频 ID');
      const owner = await resolveVideoOwner(ids.bvid, ids.aid);
      if (!owner.ok || !owner.mid) {
        return deny(
          'bili_resolve_failed',
          owner.error || '无法确认该视频的 UP 主',
          { bvid: ids.bvid, aid: ids.aid }
        );
      }
      if (!allowedMids.includes(owner.mid)) {
        return deny(
          'bili_up_denied',
          `该视频属于 UP ${owner.mid}，不在允许列表`,
          {
            mid: owner.mid,
            bvid: ids.bvid,
            aid: ids.aid,
            title: owner.title,
          }
        );
      }
      return allow(url.toString());
    }
    if (kind === 'space') {
      const mid = parseSpaceMid(pathname);
      if (mid && allowedMids.includes(mid)) return allow(url.toString());
      if (mid) {
        return deny('bili_up_denied', `UP ${mid} 不在允许列表`, { mid });
      }
    }
    return deny(
      'bili_path_denied',
      'B 站已在策略中，但该路径未开放：请用首页/搜索，或点「申请观看」'
    );
  }

  return deny('bili_path_denied', 'B 站该域名路径未授权');
}

export async function canNavigate(
  rawUrl: string,
  rules: RulesConfig
): Promise<NavigateResult> {
  let urlString = rawUrl.trim();
  if (!urlString) return deny('invalid_url', '地址为空');

  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(urlString)) {
    // Bare IP addresses almost never have a valid TLS cert — prefer http.
    const looksLikeIp = /^(\d{1,3}\.){3}\d{1,3}([/:?]|$)/.test(urlString);
    urlString = `${looksLikeIp ? 'http' : 'https'}://${urlString}`;
  }

  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return deny('invalid_url', '无法解析的网址');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    if (url.protocol === 'file:' || url.protocol === 'devtools:') {
      return allow(url.toString());
    }
    return deny('protocol_denied', '仅允许 http/https');
  }

  if (!rules.filteringEnabled) {
    return allow(url.toString());
  }

  let host = normalizeHost(url.hostname);

  if (host === 'b23.tv' || host === 'www.b23.tv') {
    const final = await resolveShortUrl(url.toString());
    try {
      url = new URL(final);
      host = normalizeHost(url.hostname);
    } catch {
      return deny('invalid_url', '短链解析失败');
    }
  }

  // Search subdomain: allow when any Bilibili extension group is enabled
  if (isBiliSearchHost(host) && hasEnabledBiliExtension(rules)) {
    return allow(url.toString());
  }

  // CDN/API for Bilibili: allow when any enabled Bilibili extension group exists
  // and host matches that group's hosts OR is a known static asset host under bili family.
  if (isBiliStaticOrApi(host) && hasEnabledBiliExtension(rules)) {
    const matched = matchingGroups(host, rules);
    const biliMatched = matched.filter((g) => g.extensionId === 'bilibili');
    if (biliMatched.length > 0 || isBiliFamilyHost(host)) {
      // Still require some bili group to list a covering host pattern when possible
      const anyBili = rules.groups.filter(
        (g) => g.enabled && g.extensionId === 'bilibili'
      );
      const covered = anyBili.some((g) => hostAllowed(host, g.hosts));
      if (covered || matched.length > 0) {
        return allow(url.toString());
      }
    }
  }

  const matched = matchingGroups(host, rules);
  if (matched.length === 0) {
    return deny('host_denied', `未匹配任何启用的配置组：${host}`);
  }

  const biliGroups = matched.filter((g) => g.extensionId === 'bilibili');
  if (biliGroups.length > 0 && isBiliFamilyHost(host)) {
    const mids = biliMidsFromGroups(biliGroups);
    return enforceBilibili(url, host, mids);
  }

  // Generic groups (or non-bili hosts): allow
  return allow(url.toString());
}

export function buildBlockUrl(
  blockPageFileUrl: string,
  originalUrl: string,
  reason: string,
  message: string,
  meta?: NavigateResult['meta']
): string {
  let displayUrl = originalUrl;
  try {
    if (displayUrl && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(displayUrl)) {
      displayUrl = `https://${displayUrl}`;
    }
  } catch {
    // keep original
  }
  const u = new URL(blockPageFileUrl);
  u.searchParams.set('url', displayUrl);
  u.searchParams.set('reason', reason);
  u.searchParams.set('message', message);
  if (meta?.mid) u.searchParams.set('mid', meta.mid);
  if (meta?.bvid) u.searchParams.set('bvid', meta.bvid);
  if (meta?.aid) u.searchParams.set('aid', meta.aid);
  if (meta?.title) u.searchParams.set('title', meta.title);
  return u.toString();
}
