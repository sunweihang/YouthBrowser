/**
 * 简行浏览器 · 配置同步服务
 * 纯 Node 内置模块，无额外依赖。
 *
 * 环境变量：
 *   PORT=3910
 *   DATA_DIR=/home/lijin/jianxing-browser/sync-data
 *   TOKEN_TTL_DAYS=30
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3910);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CONFIGS_DIR = path.join(DATA_DIR, 'configs');
const BOOKMARKS_DIR = path.join(DATA_DIR, 'bookmarks');
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const CRASHES_DIR = path.join(DATA_DIR, 'crashes');
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');
const CRASH_DAILY_MAX_BYTES = 20 * 1024 * 1024;
const TOKEN_TTL_MS = (Number(process.env.TOKEN_TTL_DAYS) || 30) * 86400000;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(CONFIGS_DIR, { recursive: true });
  fs.mkdirSync(BOOKMARKS_DIR, { recursive: true });
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  fs.mkdirSync(CRASHES_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '{}', 'utf8');
  if (!fs.existsSync(TOKENS_FILE)) fs.writeFileSync(TOKENS_FILE, '{}', 'utf8');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const parts = stored.split('$');
  if (parts.length !== 3) return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length, SCRYPT);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function normalizeUsername(u) {
  return String(u || '')
    .trim()
    .toLowerCase();
}

function validUsername(u) {
  return /^[a-z0-9_]{3,32}$/.test(u);
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function getBearer(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : '';
}

function authUser(req) {
  const token = getBearer(req);
  if (!token) return null;
  const tokens = readJson(TOKENS_FILE, {});
  const row = tokens[token];
  if (!row) return null;
  if (Date.now() > row.expiresAt) {
    delete tokens[token];
    writeJson(TOKENS_FILE, tokens);
    return null;
  }
  return { username: row.username, token };
}

function configPath(username) {
  return path.join(CONFIGS_DIR, `${username}.json`);
}

function bookmarksPath(username) {
  return path.join(BOOKMARKS_DIR, `${username}.json`);
}

function historyPath(username) {
  return path.join(HISTORY_DIR, `${username}.json`);
}

function emptyHistoryDoc() {
  return {
    entries: [],
    deletedIds: [],
    clearedAt: 0,
    revision: 0,
    updatedAt: 0,
  };
}

function normalizeHistoryPayload(body) {
  const entries = Array.isArray(body && body.entries) ? body.entries : [];
  const out = [];
  const seen = new Set();
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const id = String(e.id || '').slice(0, 80);
    const url = String(e.url || '').slice(0, 2048);
    if (!id || !/^https?:\/\//i.test(url)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      url,
      title: String(e.title || '').slice(0, 500),
      host: String(e.host || '').slice(0, 253).toLowerCase(),
      visitedAt: Number(e.visitedAt) || 0,
    });
    if (out.length >= 2000) break;
  }
  const deletedIds = [
    ...new Set(
      (Array.isArray(body && body.deletedIds) ? body.deletedIds : [])
        .map((x) => String(x || '').slice(0, 80))
        .filter(Boolean)
    ),
  ].slice(-3000);
  const clearedAt = Math.max(0, Number(body && body.clearedAt) || 0);
  return { entries: out, deletedIds, clearedAt };
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    });
    return res.end();
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  // support /simplygo-api/... (and the old /jianxing-api alias) behind nginx
  let pathname = url.pathname;
  for (const prefix of ['/simplygo-api', '/jianxing-api']) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      pathname = pathname.slice(prefix.length) || '/';
      break;
    }
  }

  try {
    if (req.method === 'GET' && pathname === '/health') {
      return send(res, 200, { ok: true, service: 'simplygo-sync' });
    }

    if (req.method === 'POST' && pathname === '/auth/register') {
      const body = await readBody(req);
      const username = normalizeUsername(body.username);
      const password = String(body.password || '');
      if (!validUsername(username)) {
        return send(res, 400, {
          ok: false,
          error: '用户名需为 3–32 位小写字母/数字/下划线',
        });
      }
      if (password.length < 6) {
        return send(res, 400, { ok: false, error: '密码至少 6 位' });
      }
      const users = readJson(USERS_FILE, {});
      if (users[username]) {
        return send(res, 409, { ok: false, error: '用户名已存在' });
      }
      users[username] = {
        passwordHash: hashPassword(password),
        createdAt: Date.now(),
      };
      writeJson(USERS_FILE, users);
      writeJson(configPath(username), {
        groups: [],
        revision: 0,
        updatedAt: Date.now(),
      });
      writeJson(historyPath(username), emptyHistoryDoc());
      const token = issueToken(username);
      return send(res, 200, { ok: true, token, username });
    }

    if (req.method === 'POST' && pathname === '/auth/login') {
      const body = await readBody(req);
      const username = normalizeUsername(body.username);
      const password = String(body.password || '');
      const users = readJson(USERS_FILE, {});
      const user = users[username];
      if (!user || !verifyPassword(password, user.passwordHash)) {
        return send(res, 401, { ok: false, error: '用户名或密码错误' });
      }
      const token = issueToken(username);
      return send(res, 200, { ok: true, token, username });
    }

    if (req.method === 'POST' && pathname === '/auth/logout') {
      const auth = authUser(req);
      if (auth) {
        const tokens = readJson(TOKENS_FILE, {});
        delete tokens[auth.token];
        writeJson(TOKENS_FILE, tokens);
      }
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/auth/me') {
      const auth = authUser(req);
      if (!auth) return send(res, 401, { ok: false, error: '未登录' });
      return send(res, 200, { ok: true, username: auth.username });
    }

    if (req.method === 'GET' && pathname === '/sync/config') {
      const auth = authUser(req);
      if (!auth) return send(res, 401, { ok: false, error: '未登录' });
      const cfg = readJson(configPath(auth.username), {
        groups: [],
        revision: 0,
        updatedAt: 0,
      });
      return send(res, 200, {
        ok: true,
        groups: cfg.groups || [],
        revision: cfg.revision || 0,
        updatedAt: cfg.updatedAt || 0,
      });
    }

    if (req.method === 'PUT' && pathname === '/sync/config') {
      const auth = authUser(req);
      if (!auth) return send(res, 401, { ok: false, error: '未登录' });
      const body = await readBody(req);
      if (!Array.isArray(body.groups)) {
        return send(res, 400, { ok: false, error: 'groups 必须是数组' });
      }
      const current = readJson(configPath(auth.username), {
        groups: [],
        revision: 0,
        updatedAt: 0,
      });
      const clientRev = Number(body.revision);
      if (
        Number.isFinite(clientRev) &&
        clientRev > 0 &&
        clientRev < (current.revision || 0)
      ) {
        return send(res, 409, {
          ok: false,
          error: '服务器配置更新，请先拉取再上传',
          revision: current.revision,
          updatedAt: current.updatedAt,
        });
      }
      const next = {
        groups: body.groups,
        revision: (current.revision || 0) + 1,
        updatedAt: Date.now(),
      };
      writeJson(configPath(auth.username), next);
      return send(res, 200, {
        ok: true,
        revision: next.revision,
        updatedAt: next.updatedAt,
      });
    }

    // Bookmarks sync (no parental permission; account login only)
    if (req.method === 'GET' && pathname === '/sync/bookmarks') {
      const auth = authUser(req);
      if (!auth) return send(res, 401, { ok: false, error: '未登录' });
      const cfg = readJson(bookmarksPath(auth.username), {
        nodes: [],
        revision: 0,
        updatedAt: 0,
      });
      return send(res, 200, {
        ok: true,
        nodes: Array.isArray(cfg.nodes) ? cfg.nodes : [],
        revision: cfg.revision || 0,
        updatedAt: cfg.updatedAt || 0,
      });
    }

    if (req.method === 'PUT' && pathname === '/sync/bookmarks') {
      const auth = authUser(req);
      if (!auth) return send(res, 401, { ok: false, error: '未登录' });
      const body = await readBody(req);
      if (!Array.isArray(body.nodes)) {
        return send(res, 400, { ok: false, error: 'nodes 必须是数组' });
      }
      const current = readJson(bookmarksPath(auth.username), {
        nodes: [],
        revision: 0,
        updatedAt: 0,
      });
      const clientRev = Number(body.revision);
      if (
        Number.isFinite(clientRev) &&
        clientRev > 0 &&
        clientRev < (current.revision || 0)
      ) {
        return send(res, 409, {
          ok: false,
          error: '服务器收藏夹更新，请先拉取再上传',
          revision: current.revision,
          updatedAt: current.updatedAt,
        });
      }
      const next = {
        nodes: body.nodes,
        revision: (current.revision || 0) + 1,
        updatedAt: Date.now(),
      };
      writeJson(bookmarksPath(auth.username), next);
      return send(res, 200, {
        ok: true,
        revision: next.revision,
        updatedAt: next.updatedAt,
      });
    }

    if (req.method === 'GET' && pathname === '/sync/history') {
      const auth = authUser(req);
      if (!auth) return send(res, 401, { ok: false, error: '未登录' });
      const cfg = readJson(historyPath(auth.username), emptyHistoryDoc());
      const normalized = normalizeHistoryPayload(cfg);
      return send(res, 200, {
        ok: true,
        entries: normalized.entries,
        deletedIds: normalized.deletedIds,
        clearedAt: normalized.clearedAt,
        revision: cfg.revision || 0,
        updatedAt: cfg.updatedAt || 0,
      });
    }

    if (req.method === 'PUT' && pathname === '/sync/history') {
      const auth = authUser(req);
      if (!auth) return send(res, 401, { ok: false, error: '未登录' });
      const body = await readBody(req);
      if (!Array.isArray(body.entries)) {
        return send(res, 400, { ok: false, error: 'entries 必须是数组' });
      }
      const current = readJson(historyPath(auth.username), emptyHistoryDoc());
      const clientRev = Number(body.revision);
      if (
        Number.isFinite(clientRev) &&
        clientRev > 0 &&
        clientRev < (current.revision || 0)
      ) {
        return send(res, 409, {
          ok: false,
          error: '服务器历史记录已更新，请先拉取再上传',
          revision: current.revision,
          updatedAt: current.updatedAt,
        });
      }
      const normalized = normalizeHistoryPayload(body);
      const next = {
        entries: normalized.entries,
        deletedIds: normalized.deletedIds,
        clearedAt: normalized.clearedAt,
        revision: (current.revision || 0) + 1,
        updatedAt: Date.now(),
      };
      writeJson(historyPath(auth.username), next);
      return send(res, 200, {
        ok: true,
        revision: next.revision,
        updatedAt: next.updatedAt,
      });
    }

    if (req.method === 'POST' && pathname === '/telemetry/crash') {
      const body = await readBody(req);
      const report = sanitizeCrashReport(body, authUser(req));
      if (!report) {
        return send(res, 400, { ok: false, error: 'invalid report' });
      }
      const ymd = new Date(report.ts || Date.now()).toISOString().slice(0, 10);
      const daily = path.join(CRASHES_DIR, `${ymd}.jsonl`);
      try {
        if (fs.existsSync(daily) && fs.statSync(daily).size > CRASH_DAILY_MAX_BYTES) {
          return send(res, 429, { ok: false, error: 'quota' });
        }
      } catch {
        /* ignore quota check failure */
      }
      fs.appendFileSync(daily, `${JSON.stringify(report)}\n`, 'utf8');
      return send(res, 200, { ok: true, id: report.id });
    }

    return send(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    return send(res, 400, { ok: false, error: e.message || 'bad request' });
  }
}

function clip(value, max) {
  return String(value == null ? '' : value).replace(/\u0000/g, '').slice(0, max);
}

function sanitizeCrashReport(body, auth) {
  if (!body || typeof body !== 'object') return null;
  const message = clip(body.message, 2000);
  if (!message) return null;
  const kinds = new Set([
    'uncaught',
    'unhandledrejection',
    'render-gone',
    'child-gone',
    'unresponsive',
    'page-fail',
    'renderer-js',
    'android-crash',
    'webview-gone',
    'webview-fail',
  ]);
  const kind = kinds.has(body.kind) ? body.kind : 'uncaught';
  let extra;
  if (body.extra && typeof body.extra === 'object') {
    try {
      extra = JSON.parse(clip(JSON.stringify(body.extra), 8000) || '{}');
    } catch {
      extra = undefined;
    }
  }
  return {
    id: clip(body.id, 80) || crypto.randomBytes(16).toString('hex'),
    ts: Number(body.ts) || Date.now(),
    receivedAt: Date.now(),
    kind,
    level: body.level === 'fatal' ? 'fatal' : 'error',
    message,
    stack: body.stack ? clip(body.stack, 16000) : undefined,
    url: body.url ? clip(body.url, 1024) : undefined,
    platform: clip(body.platform, 32),
    arch: clip(body.arch, 32),
    osRelease: clip(body.osRelease, 128),
    appVersion: clip(body.appVersion, 32),
    electronVersion: clip(body.electronVersion, 32),
    installId: clip(body.installId, 80),
    username: clip((auth && auth.username) || body.username, 64),
    extra,
  };
}

function issueToken(username) {
  const tokens = readJson(TOKENS_FILE, {});
  const token = newToken();
  tokens[token] = {
    username,
    expiresAt: Date.now() + TOKEN_TTL_MS,
    createdAt: Date.now(),
  };
  writeJson(TOKENS_FILE, tokens);
  return token;
}

ensureDirs();
const server = http.createServer((req, res) => {
  handle(req, res);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[simplygo-sync] listening on 127.0.0.1:${PORT}`);
  console.log(`[simplygo-sync] data: ${DATA_DIR}`);
});
