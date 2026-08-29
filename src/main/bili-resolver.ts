const cache = new Map<string, { mid: string; expires: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

export interface ResolveResult {
  ok: boolean;
  mid?: string;
  title?: string;
  error?: string;
}

function cacheGet(key: string): string | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expires) {
    cache.delete(key);
    return undefined;
  }
  return hit.mid;
}

function cacheSet(key: string, mid: string): void {
  cache.set(key, { mid, expires: Date.now() + CACHE_TTL_MS });
}

export function parseBiliVideoId(
  pathname: string
): { bvid?: string; aid?: string } | null {
  const bv = pathname.match(/\/video\/(BV[\w]+)/i);
  if (bv) return { bvid: bv[1] };
  const av = pathname.match(/\/video\/av(\d+)/i);
  if (av) return { aid: av[1] };
  return null;
}

export function parseSpaceMid(pathname: string): string | null {
  const m = pathname.match(/^\/(\d+)(?:\/|$)/);
  return m ? m[1] : null;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Referer: 'https://www.bilibili.com/',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function resolveViaApi(
  bvid?: string,
  aid?: string
): Promise<ResolveResult> {
  const qs = bvid
    ? `bvid=${encodeURIComponent(bvid)}`
    : `aid=${encodeURIComponent(aid!)}`;
  const data = (await fetchJson(
    `https://api.bilibili.com/x/web-interface/view?${qs}`
  )) as {
    code?: number;
    data?: { owner?: { mid?: number }; title?: string };
    message?: string;
  };
  if (data.code !== 0 || !data.data?.owner?.mid) {
    return {
      ok: false,
      error: data.message || 'API 未返回 UP 信息',
    };
  }
  return {
    ok: true,
    mid: String(data.data.owner.mid),
    title: data.data.title,
  };
}

async function resolveViaPage(bvid?: string, aid?: string): Promise<ResolveResult> {
  const videoPath = bvid
    ? bvid.toUpperCase().startsWith('BV')
      ? bvid
      : `BV${bvid}`
    : `av${aid}`;
  const url = `https://www.bilibili.com/video/${videoPath}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    },
  });
  if (!res.ok) return { ok: false, error: `页面 HTTP ${res.status}` };
  const html = await res.text();
  const stateMatch = html.match(
    /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});\s*\(function/
  );
  if (!stateMatch) {
    const midMatch = html.match(/"owner"\s*:\s*\{[^}]*"mid"\s*:\s*(\d+)/);
    if (midMatch) return { ok: true, mid: midMatch[1] };
    return { ok: false, error: '无法从页面解析 UP' };
  }
  try {
    const state = JSON.parse(stateMatch[1]) as {
      videoData?: { owner?: { mid?: number }; title?: string };
    };
    const mid = state.videoData?.owner?.mid;
    if (!mid) return { ok: false, error: '页面态无 mid' };
    return {
      ok: true,
      mid: String(mid),
      title: state.videoData?.title,
    };
  } catch {
    return { ok: false, error: '页面态 JSON 解析失败' };
  }
}

export async function resolveVideoOwner(
  bvid?: string,
  aid?: string
): Promise<ResolveResult> {
  const key = bvid ? `bv:${bvid.toUpperCase()}` : `av:${aid}`;
  const cached = cacheGet(key);
  if (cached) return { ok: true, mid: cached };

  try {
    const api = await resolveViaApi(bvid, aid);
    if (api.ok && api.mid) {
      cacheSet(key, api.mid);
      return api;
    }
  } catch {
    // fall through
  }

  try {
    const page = await resolveViaPage(bvid, aid);
    if (page.ok && page.mid) {
      cacheSet(key, page.mid);
      return page;
    }
    return page;
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : '解析失败',
    };
  }
}

/** Follow b23.tv (and similar) short links to the final URL. */
export async function resolveShortUrl(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
    });
    return res.url || url;
  } catch {
    return url;
  }
}
