import {
  app,
  BrowserView,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  screen,
  session,
  shell,
} from 'electron';
import type {
  BrowserWindowConstructorOptions,
  MenuItemConstructorOptions,
} from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { pathToFileURL } from 'url';
import { BookmarksStore } from './bookmarks-store';
import { AccountStore } from './account-store';
import { groupsPayloadEqual, SyncClient } from './sync-client';
import { startAutoUpdater, registerUpdateIpc } from './auto-update';
import {
  buildBlockUrl,
  canLetNativeNavigate,
  canNavigate,
  hostAllowed,
  isDownloadAllowed,
  parseExternalAppUrl,
} from './navigation-guard';
import { HistoryStore } from './history-store';
import { createHistorySync } from './history-sync';
import { DownloadsStore, type DownloadEntry } from './downloads-store';
import {
  DownloadsManager,
  looksLikeDownloadUrl,
} from './downloads-manager';
import { extractMidFromInput, normalizeHomepage, RulesStore } from './rules-store';
import { WatchRequestsStore } from './watch-requests-store';
import { SitePasswordsStore } from './site-passwords-store';
import {
  extractLaunchUrl,
  registerAsDefaultBrowser,
} from './default-browser';
import {
  attachWebContentsDiagnostics,
  initErrorReporter,
  installProcessHooks,
  reportCrash,
  sanitizeRendererReport,
} from './error-reporter';

const TAB_BAR_HEIGHT = 40;
const TITLE_MENU_HEIGHT = 32;
const TOOLBAR_HEIGHT = 48;
const BOOKMARKS_BAR_HEIGHT = 36;
const CHROME_BG = '#1a2332';
const CHROME_FG = '#e8eef7';

function usesInWindowTitleMenu(): boolean {
  return process.platform === 'win32';
}
/** Extra space for chrome overlays (e.g. update / find) that would otherwise sit under BrowserView */
let chromeExtraHeight = 0;
let bookmarksBarVisible = true;
let homepage = '';
/** Firefox-style browser zoom: scales chrome UI and page content together. */
let browserZoomFactor = 1;
let applyingBrowserZoom = false;

function clampZoomFactor(factor: number): number {
  return Math.max(0.5, Math.min(3, Math.round(factor * 100) / 100));
}

function titleBarOverlayHeight(): number {
  return Math.max(
    TITLE_MENU_HEIGHT,
    Math.round(TITLE_MENU_HEIGHT * browserZoomFactor)
  );
}

function chromeCssHeight(): number {
  return (
    (usesInWindowTitleMenu() ? TITLE_MENU_HEIGHT : 0) +
    TAB_BAR_HEIGHT +
    TOOLBAR_HEIGHT +
    (bookmarksBarVisible ? BOOKMARKS_BAR_HEIGHT : 0) +
    chromeExtraHeight
  );
}

function chromeHeight(): number {
  return Math.round(chromeCssHeight() * browserZoomFactor);
}

function toChromeDip(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.round(Number(x) * browserZoomFactor),
    y: Math.round(Number(y) * browserZoomFactor),
  };
}

function chromePrefsPath(): string {
  return join(app.getPath('userData'), 'chrome.json');
}

function loadChromePrefs(): void {
  let hasHomepageKey = false;
  try {
    const raw = JSON.parse(readFileSync(chromePrefsPath(), 'utf8')) as {
      bookmarksBarVisible?: boolean;
      homepage?: string;
      browserZoomFactor?: number;
    };
    bookmarksBarVisible = raw.bookmarksBarVisible !== false;
    if (
      typeof raw.browserZoomFactor === 'number' &&
      Number.isFinite(raw.browserZoomFactor)
    ) {
      browserZoomFactor = clampZoomFactor(raw.browserZoomFactor);
    }
    if (Object.prototype.hasOwnProperty.call(raw, 'homepage')) {
      hasHomepageKey = true;
      const parsed = normalizeHomepage(String(raw.homepage || ''));
      homepage = parsed.ok ? parsed.url : '';
    }
  } catch {
    bookmarksBarVisible = true;
  }
  const chromeHome = homepage;
  if (!homepage) {
    homepage = rulesStore.getHomepage() || '';
  }
  if (!hasHomepageKey || (!chromeHome && homepage)) {
    saveChromePrefs();
  }
}

function saveChromePrefs(): void {
  const path = chromePrefsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ bookmarksBarVisible, homepage, browserZoomFactor }, null, 2),
    'utf8'
  );
}

function getHomepage(): string {
  return homepage || rulesStore.getHomepage() || '';
}

function setHomepage(
  raw: string
): { ok: boolean; error?: string; homepage?: string } {
  const parsed = normalizeHomepage(raw);
  if (!parsed.ok) return parsed;
  homepage = parsed.url;
  saveChromePrefs();
  rulesStore.setHomepage(parsed.url);
  return { ok: true, homepage };
}

function setCurrentPageAsHomepage(): { ok: boolean; error?: string; homepage?: string } {
  const tab = activeTab();
  const url = tab?.url || '';
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return { ok: false, error: '当前没有打开的网页' };
  }
  return setHomepage(url);
}

const APP_NAME = '简行浏览器';
const OFFICIAL_WEBSITE = 'https://spacedreams.cn/simplygo/';

interface TabState {
  id: string;
  view: BrowserView;
  title: string;
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

let mainWindow: BrowserWindow | null = null;
let parentWindow: BrowserWindow | null = null;
let bookmarksWindow: BrowserWindow | null = null;
let historyWindow: BrowserWindow | null = null;
let downloadsWindow: BrowserWindow | null = null;
let updateWindow: BrowserWindow | null = null;
let passwordsWindow: BrowserWindow | null = null;
let aboutWindow: BrowserWindow | null = null;
let rulesStore: RulesStore;
let bookmarksStore: BookmarksStore;
let accountStore: AccountStore;
let watchRequestsStore: WatchRequestsStore;
let historyStore: HistoryStore;
let downloadsStore: DownloadsStore;
let downloadsManager: DownloadsManager;
let sitePasswordsStore: SitePasswordsStore;
let syncClient: SyncClient;
let historySync: ReturnType<typeof createHistorySync> | undefined;
let tabs: TabState[] = [];
let activeTabId: string | null = null;
let parentUnlocked = false;
let pendingLaunchUrl: string | null = null;
/** Track render-process-gone auto-reloads so a bad page cannot crash-loop. */
const renderCrashState = new WeakMap<
  Electron.WebContents,
  { url: string; count: number; lastAt: number }
>();
let sessionRendererCrashes = 0;

if (process.env.JIANXING_USER_DATA) {
  app.setPath('userData', process.env.JIANXING_USER_DATA);
}

function gpuSafeModePath(): string {
  return join(app.getPath('userData'), 'gpu-safe-mode');
}

function enableGpuSafeMode(reason: string): void {
  if (process.platform !== 'win32') return;
  try {
    writeFileSync(
      gpuSafeModePath(),
      `${new Date().toISOString()} ${reason}\n`,
      'utf8'
    );
  } catch {
    /* ignore */
  }
}

// Windows: GPU TDR / Chromium ImmediateCrash (0x80000003) has been taking
// down SimplyGo repeatedly. Prefer software rendering after a prior GPU
// fault, and disable a known occlusion feature that destabilizes BrowserView.
if (process.platform === 'win32') {
  try {
    if (existsSync(gpuSafeModePath())) {
      app.disableHardwareAcceleration();
    }
  } catch {
    /* ignore */
  }
  app.commandLine.appendSwitch(
    'disable-features',
    'CalculateNativeWinOcclusion'
  );
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  installProcessHooks();
}

app.on('second-instance', (_event, argv) => {
  const url = extractLaunchUrl(argv);
  if (url) openLaunchUrl(url);
  else focusMainWindow();
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  if (/^https?:\/\//i.test(url) || /^file:\/\//i.test(url)) {
    openLaunchUrl(url);
  }
});

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function openLaunchUrl(url: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    pendingLaunchUrl = url;
    return;
  }
  createTab(url);
  focusMainWindow();
}

function distPath(...parts: string[]): string {
  return join(__dirname, '..', ...parts);
}

function rendererFile(...parts: string[]): string {
  return pathToFileURL(distPath('renderer', ...parts)).toString();
}

function blockPageUrl(): string {
  return rendererFile('block', 'index.html');
}

function notifyBookmarks(): void {
  if (bookmarksWindow && !bookmarksWindow.isDestroyed()) {
    bookmarksWindow.webContents.send(
      'bookmarks:changed',
      bookmarksStore.snapshot()
    );
  }
}

function notifyHistory(): void {
  const payload = {
    entries: historyStore.list(),
    count: historyStore.count(),
  };
  for (const win of [historyWindow, parentWindow]) {
    if (!win || win.isDestroyed()) continue;
    try {
      win.webContents.send('history:changed', payload);
    } catch {
      // Window can tear down between the check and send.
    }
  }
}

function notifyDownloads(latest?: DownloadEntry): void {
  const payload = {
    ...downloadsManager.snapshot(),
    latest: latest || null,
  };
  if (downloadsWindow && !downloadsWindow.isDestroyed()) {
    downloadsWindow.webContents.send('downloads:changed', payload);
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    sendShellCommand('downloadChanged', {
      latest: latest || null,
      activeCount: payload.activeCount,
    });
  }
}

function activeTab(): TabState | undefined {
  return tabs.find((t) => t.id === activeTabId);
}

function recordTabVisit(tab: TabState, url?: string): void {
  const href = url || tab.url;
  if (!isHttpUrl(href)) return;
  historyStore.record(href, tab.title || href);
  notifyHistory();
  historySync?.schedule();
}

/** Keep local unlock hash in sync with the account password. */
function syncLocalUnlockPassword(password: string): { ok: boolean; error?: string } {
  return rulesStore.setPassword(password);
}

function authorizeHistoryDelete(password?: string): { ok: boolean; error?: string } {
  if (parentUnlocked) return { ok: true };
  if (!rulesStore.hasPassword()) return { ok: true };
  if (typeof password === 'string' && rulesStore.verify(password)) {
    return { ok: true };
  }
  return { ok: false, error: '需要账号密码才能删除历史记录' };
}

function sendShellCommand(action: string, payload?: unknown): void {
  notifyShell('shell:command', { action, payload });
}

function isLiveWebContents(
  wc: Electron.WebContents | null | undefined
): wc is Electron.WebContents {
  return Boolean(wc && !wc.isDestroyed());
}

function notifyShell(channel: string, payload: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wc = mainWindow.webContents;
  if (!isLiveWebContents(wc)) return;
  try {
    wc.send(channel, payload);
  } catch {
    // Window can finish tearing down between the checks and send.
  }
}

function isHttpUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

/** Address-bar URL while a navigation is in flight (hide file:// chrome pages). */
function omniboxUrl(raw: string): string {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) {
    return isHttpUrl(s) ? s : '';
  }
  const looksLikeIp = /^(\d{1,3}\.){3}\d{1,3}([/:?]|$)/.test(s);
  return `${looksLikeIp ? 'http' : 'https'}://${s}`;
}

function isChromeFileUrl(url: string): boolean {
  return (
    url.startsWith('file:') &&
    (url.includes('/block/') || url.includes('/blank'))
  );
}

function tabSnapshot() {
  const active = activeTabId
    ? tabs.find((x) => x.id === activeTabId) || null
    : null;
  const activeUrl = active?.url || '';
  return {
    tabs: tabs.map((t) => ({
      id: t.id,
      title: t.title,
      url: t.url,
      loading: t.loading,
    })),
    activeTabId,
    active: active
      ? {
          id: active.id,
          title: active.title,
          url: active.url,
          canGoBack: active.canGoBack,
          canGoForward: active.canGoForward,
          loading: active.loading,
            isBookmarked:
            isHttpUrl(activeUrl) &&
            Boolean(bookmarksStore.findByUrl(activeUrl)),
        }
      : null,
    bookmarks: bookmarksStore.snapshot(),
    needsParentSetup: !accountStore.isLoggedIn() || !rulesStore.hasPassword(),
    filteringEnabled: rulesStore.isFilteringEnabled(),
    homepage: getHomepage(),
    bookmarksBarVisible,
    customTitleMenu: usesInWindowTitleMenu(),
    zoomFactor: currentZoomFactor(),
  };
}

function layoutViews(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [width, height] = mainWindow.getContentSize();
  const top = chromeHeight();
  const bounds = {
    x: 0,
    y: top,
    width: Math.max(0, Math.round(width)),
    height: Math.max(0, Math.round(height - top)),
  };
  for (const tab of tabs) {
    if (!isLiveWebContents(tab.view.webContents)) continue;
    // Auto-resize + setBounds together over-sizes the view on Windows DPI,
    // so pages that center with max-width appear shifted.
    tab.view.setAutoResize({ width: false, height: false });
    tab.view.setBounds(bounds);
  }
}

function currentPageIsBookmarked(): boolean {
  const tab = activeTab();
  return Boolean(tab && isHttpUrl(tab.url) && bookmarksStore.findByUrl(tab.url));
}

function canBookmarkCurrentPage(): boolean {
  const tab = activeTab();
  return Boolean(tab && isHttpUrl(tab.url));
}

function bookmarkCurrentPage(): void {
  const tab = activeTab();
  if (!tab || !isHttpUrl(tab.url)) return;
  bookmarksStore.toggleUrl(tab.title || tab.url, tab.url);
  notifyShell('shell:state', tabSnapshot());
  notifyBookmarks();
  refreshAppMenu();
}

let lastMenuKey = '';

function refreshAppMenuIfNeeded(): void {
  const tab = activeTab();
  const key = [
    tab?.url || '',
    tab?.canGoBack ? '1' : '0',
    tab?.canGoForward ? '1' : '0',
    currentPageIsBookmarked() ? '1' : '0',
    bookmarksBarVisible ? '1' : '0',
  ].join('|');
  if (key === lastMenuKey) return;
  lastMenuKey = key;
  refreshAppMenu();
}

function updateNavState(tab: TabState): void {
  const wc = tab.view.webContents;
  if (!isLiveWebContents(wc)) return;
  try {
    tab.canGoBack = wc.canGoBack();
    tab.canGoForward = wc.canGoForward();
    const current = wc.getURL();
    if (isHttpUrl(current)) {
      tab.url = current;
    } else if (isChromeFileUrl(current)) {
      // Keep pending / blocked http(s) URL in the omnibox; never show file://
      if (!isHttpUrl(tab.url)) tab.url = '';
    } else if (current) {
      tab.url = current;
    }
    tab.title = wc.getTitle() || tab.title;
  } catch {
    return;
  }
  if (tab.id === activeTabId) {
    notifyShell('shell:state', tabSnapshot());
    refreshAppMenuIfNeeded();
  }
}

const guardNavigating = new WeakSet<Electron.WebContents>();

/** Redirects / superseded navigations reject loadURL with ERR_ABORTED — not a real failure. */
function isBenignLoadError(err: unknown): boolean {
  const e = err as { code?: string; errno?: number; message?: string };
  if (e?.errno === -3 || e?.code === 'ERR_ABORTED') return true;
  return /ERR_ABORTED/i.test(String(e?.message || err || ''));
}

/** Map Chromium/Electron loadURL failures to a short Chinese explanation. */
function describeLoadError(err: unknown): string {
  const e = err as { code?: string; errno?: number; message?: string };
  const raw = String(e?.code || e?.message || err || '');
  const code = (e?.code || raw.match(/ERR_[A-Z0-9_]+/)?.[0] || '').toUpperCase();
  const table: Record<string, string> = {
    ERR_NAME_NOT_RESOLVED: '无法解析域名（DNS）',
    ERR_INTERNET_DISCONNECTED: '网络未连接',
    ERR_CONNECTION_REFUSED: '连接被拒绝',
    ERR_CONNECTION_RESET: '连接被重置',
    ERR_CONNECTION_CLOSED: '连接已关闭',
    ERR_CONNECTION_TIMED_OUT: '连接超时',
    ERR_TIMED_OUT: '连接超时',
    ERR_ADDRESS_UNREACHABLE: '地址不可达（可能需 VPN / 内网）',
    ERR_NETWORK_CHANGED: '网络已切换，请重试',
    ERR_NETWORK_ACCESS_DENIED: '网络访问被拒绝',
    ERR_EMPTY_RESPONSE: '服务器无响应',
    ERR_CONNECTION_FAILED: '无法建立连接',
    ERR_SSL_PROTOCOL_ERROR: 'SSL 协议错误',
    ERR_SSL_VERSION_OR_CIPHER_MISMATCH: 'SSL 版本或加密套件不匹配',
    ERR_CERT_AUTHORITY_INVALID: '证书不被信任',
    ERR_CERT_COMMON_NAME_INVALID: '证书域名不匹配',
    ERR_CERT_DATE_INVALID: '证书已过期或尚未生效',
    ERR_CERT_INVALID: '证书无效',
    ERR_FAILED_SSL_HANDSHAKE: 'SSL 握手失败',
    ERR_TOO_MANY_REDIRECTS: '重定向次数过多',
    ERR_INVALID_URL: '网址格式无效',
    ERR_INVALID_RESPONSE: '服务器返回无效响应',
    ERR_HTTP_RESPONSE_CODE_FAILURE: '服务器返回错误状态码',
  };
  if (code && table[code]) return table[code];
  for (const key of Object.keys(table)) {
    if (raw.toUpperCase().includes(key)) return table[key];
  }
  return '页面加载失败';
}

async function loadTabUrl(
  wc: Electron.WebContents,
  url: string
): Promise<void> {
  if (!isLiveWebContents(wc)) return;
  try {
    if (wc.isLoading()) wc.stop();
  } catch {
    /* ignore */
  }
  if (!isLiveWebContents(wc)) return;
  guardNavigating.add(wc);
  try {
    await wc.loadURL(url);
  } catch (err) {
    if (!isBenignLoadError(err)) throw err;
  } finally {
    guardNavigating.delete(wc);
  }
}

async function openExternalAppUrl(rawUrl: string): Promise<boolean> {
  const target = parseExternalAppUrl(rawUrl);
  if (!target) return false;
  try {
    await shell.openExternal(target);
  } catch {
    const opts = {
      type: 'warning' as const,
      title: '无法打开应用',
      message: '未能打开对应的本地应用，请确认已安装飞连（CorpLink）。',
    };
    if (mainWindow && !mainWindow.isDestroyed()) {
      await dialog.showMessageBox(mainWindow, opts);
    } else {
      await dialog.showMessageBox(opts);
    }
  }
  return true;
}

async function guardedLoad(tab: TabState, targetUrl: string): Promise<void> {
  const wc = tab.view.webContents;
  if (!isLiveWebContents(wc)) return;
  if (await openExternalAppUrl(targetUrl)) {
    tab.loading = false;
    updateNavState(tab);
    return;
  }
  tab.loading = true;
  const pendingUrl = omniboxUrl(targetUrl);
  if (pendingUrl) tab.url = pendingUrl;
  notifyShell('shell:state', tabSnapshot());

  // Allow loading our own block / blank pages without rule check
  if (isChromeFileUrl(targetUrl)) {
    await loadTabUrl(wc, targetUrl);
    tab.loading = false;
    updateNavState(tab);
    return;
  }

  // Parent-approved watch request: allow same host+path again
  if (watchRequestsStore?.isApprovedUrl(targetUrl)) {
    try {
      await loadTabUrl(wc, targetUrl);
    } catch (err) {
      const blocked = buildBlockUrl(
        blockPageUrl(),
        targetUrl,
        'load_failed',
        describeLoadError(err)
      );
      await loadTabUrl(wc, blocked);
    }
    tab.loading = false;
    updateNavState(tab);
    return;
  }

  const result = await canNavigate(targetUrl, rulesStore.getRaw());
  if (!isLiveWebContents(wc)) return;
  if (!result.allowed) {
    const blocked = buildBlockUrl(
      blockPageUrl(),
      targetUrl,
      result.reason || 'host_denied',
      result.message || '访问被拦截',
      result.meta
    );
    await loadTabUrl(wc, blocked);
    tab.url = targetUrl;
    tab.title = '已拦截';
    tab.loading = false;
    updateNavState(tab);
    return;
  }

  try {
    await loadTabUrl(wc, result.finalUrl || targetUrl);
  } catch (err) {
    const blocked = buildBlockUrl(
      blockPageUrl(),
      targetUrl,
      'load_failed',
      describeLoadError(err)
    );
    await loadTabUrl(wc, blocked);
  }
  tab.loading = false;
  updateNavState(tab);
}

function attachGuards(tab: TabState): void {
  const wc = tab.view.webContents;

  wc.setWindowOpenHandler(({ url }) => {
    if (parseExternalAppUrl(url)) {
      void openExternalAppUrl(url);
      return { action: 'deny' };
    }
    if (
      looksLikeDownloadUrl(url) &&
      isDownloadAllowed(url, rulesStore.getRaw())
    ) {
      downloadsManager.startFromUrl(url, wc.getURL() || '');
      return { action: 'deny' };
    }
    void guardedLoad(tab, url);
    return { action: 'deny' };
  });

  wc.on('will-navigate', (event, url) => {
    if (guardNavigating.has(wc)) return;
    if (parseExternalAppUrl(url)) {
      event.preventDefault();
      void openExternalAppUrl(url);
      return;
    }
    if (url.startsWith('file:') && url.includes('/block/')) return;
    if (
      looksLikeDownloadUrl(url) &&
      isDownloadAllowed(url, rulesStore.getRaw())
    ) {
      event.preventDefault();
      downloadsManager.startFromUrl(url, wc.getURL() || '');
      return;
    }
    // Allowed navigations must proceed natively. preventDefault + loadURL
    // drops POST bodies, so site logins reload with no error and empty fields.
    if (canLetNativeNavigate(url, rulesStore.getRaw())) {
      const pending = omniboxUrl(url);
      if (pending) {
        tab.url = pending;
        tab.loading = true;
        if (tab.id === activeTabId) {
          notifyShell('shell:state', tabSnapshot());
        }
      }
      return;
    }
    event.preventDefault();
    void guardedLoad(tab, url);
  });

  // Only cancel denied redirects. preventDefault + loadURL on allowed
  // redirects is a known Electron/Chromium crash trigger. Even denied
  // redirects must not loadURL inside this handler — defer it.
  wc.on('will-redirect', (event, url) => {
    if (url.startsWith('file:')) return;
    if (parseExternalAppUrl(url)) {
      event.preventDefault();
      void openExternalAppUrl(url);
      return;
    }
    if (!rulesStore.isFilteringEnabled()) return;
    let allowed = false;
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        const host = u.hostname.toLowerCase().replace(/\.$/, '');
        const rules = rulesStore.getRaw();
        allowed = rules.groups.some(
          (g) => g.enabled && hostAllowed(host, g.hosts)
        );
      }
    } catch {
      allowed = false;
    }
    if (allowed) return;
    event.preventDefault();
    const blocked = buildBlockUrl(
      blockPageUrl(),
      url,
      'host_denied',
      '重定向目标未授权'
    );
    setImmediate(() => {
      if (!isLiveWebContents(wc)) return;
      void loadTabUrl(wc, blocked);
      updateNavState(tab);
    });
  });

  wc.on('page-title-updated', (_e, title) => {
    if (!isLiveWebContents(wc)) return;
    tab.title = title;
    updateNavState(tab);
    if (isHttpUrl(tab.url)) {
      historyStore.updateLatestTitle(tab.url, title);
      notifyHistory();
      historySync?.schedule();
    }
  });

  wc.on('did-navigate', (_e, url) => {
    if (!isLiveWebContents(wc)) return;
    updateNavState(tab);
    recordTabVisit(tab, url);
  });
  wc.on('did-navigate-in-page', (_e, url) => {
    if (!isLiveWebContents(wc)) return;
    updateNavState(tab);
    recordTabVisit(tab, url);
  });
  wc.on('found-in-page', (_e, result) => {
    if (!isLiveWebContents(wc)) return;
    if (tab.id === activeTabId) {
      notifyShell('shell:findResult', result);
    }
  });
  wc.on('did-start-loading', () => {
    if (!isLiveWebContents(wc)) return;
    tab.loading = true;
    updateNavState(tab);
  });
  wc.on('did-stop-loading', () => {
    if (!isLiveWebContents(wc)) return;
    tab.loading = false;
    updateNavState(tab);
  });

  // Harden: no DevTools in production-ish usage
  wc.on('before-input-event', (event, input) => {
    if (
      input.type === 'keyDown' &&
      (input.key === 'F12' ||
        (input.control && input.shift && input.key.toLowerCase() === 'i') ||
        (input.meta && input.alt && input.key.toLowerCase() === 'i'))
    ) {
      event.preventDefault();
    }
  });
  applyZoomToWebContents(wc);
  wireZoomEvents(wc);
}

function createTab(initialUrl?: string): TabState {
  const id = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'persist:youth',
      preload: distPath('preload', 'view.js'),
    },
  });

  const tab: TabState = {
    id,
    view,
    title: '新标签页',
    url: '',
    canGoBack: false,
    canGoForward: false,
    loading: false,
  };

  attachGuards(tab);
  tabs.push(tab);
  mainWindow?.setBrowserView(view);
  layoutViews();
  activeTabId = id;

  if (initialUrl) {
    void guardedLoad(tab, initialUrl);
  } else {
    loadStartPage(tab);
  }

  notifyShell('shell:state', tabSnapshot());
  return tab;
}

function loadStartPage(tab: TabState): void {
  const home = getHomepage();
  if (home) {
    void guardedLoad(tab, home);
    return;
  }
  const welcomeHint = rulesStore.isFilteringEnabled()
    ? '请在地址栏输入已授权的网址。B 站仅可打开白名单 UP 的视频或空间。'
    : '访问过滤未开启。请在地址栏输入网址开始浏览。';
  const welcome = buildBlockUrl(
    blockPageUrl(),
    '(未打开页面)',
    'host_denied',
    welcomeHint
  );
  void tab.view.webContents.loadURL(welcome);
  tab.title = '开始';
  tab.url = '';
}

function goHome(): void {
  const tab = activeTab();
  if (!tab) {
    createTab();
    return;
  }
  loadStartPage(tab);
  notifyShell('shell:state', tabSnapshot());
}

function activateTab(id: string): void {
  const tab = tabs.find((t) => t.id === id);
  if (!tab || !mainWindow) return;
  activeTabId = id;
  mainWindow.setBrowserView(tab.view);
  layoutViews();
  notifyShell('shell:state', tabSnapshot());
}

function closeTab(id: string): void {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const [tab] = tabs.splice(idx, 1);
  if (mainWindow?.getBrowserView() === tab.view) {
    mainWindow.setBrowserView(null);
  }
  const wc = tab.view.webContents as Electron.WebContents & {
    destroy?: () => void;
  };
  wc.removeAllListeners();
  if (typeof wc.destroy === 'function') {
    wc.destroy();
  } else {
    wc.close();
  }

  if (tabs.length === 0) {
    createTab();
    return;
  }
  if (activeTabId === id) {
    activateTab(tabs[Math.max(0, idx - 1)].id);
  } else {
    notifyShell('shell:state', tabSnapshot());
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureMarketingShots(): Promise<void> {
  const dir =
    process.env.JIANXING_CAPTURE_DIR ||
    join(process.cwd(), 'server', 'download-page', 'assets');
  mkdirSync(dir, { recursive: true });
  await delay(1800);
  openHistoryWindow();
  openBookmarksManager();
  openDownloadsWindow();
  openParentWindow(!rulesStore.hasPassword());
  await delay(1000);
  if (parentWindow && !parentWindow.isDestroyed()) {
    try {
      await parentWindow.webContents.executeJavaScript(`
        document.getElementById('authShell')?.classList.add('hidden');
        document.getElementById('dashboard')?.classList.remove('hidden');
        document.querySelector('[data-page="overview"]')?.click();
      `);
    } catch {
      /* ignore */
    }
    await delay(500);
  }

  const shot = async (win: BrowserWindow | null, name: string) => {
    if (!win || win.isDestroyed()) return;
    try {
      win.show();
      win.focus();
      await delay(200);
      const img = await win.webContents.capturePage();
      writeFileSync(join(dir, `${name}.png`), img.toPNG());
    } catch (err) {
      writeFileSync(
        join(dir, `${name}.err.txt`),
        String(err && (err as Error).stack ? (err as Error).stack : err)
      );
    }
  };

  await shot(historyWindow, 'history');
  await shot(bookmarksWindow, 'bookmarks');
  await shot(downloadsWindow, 'downloads');
  await shot(parentWindow, 'parent');
  writeFileSync(join(dir, 'capture-ready.txt'), 'ok\n');
}

function createMainWindow(): void {
  const winOpts: BrowserWindowConstructorOptions = {
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: APP_NAME,
    backgroundColor: CHROME_BG,
    autoHideMenuBar: false,
    webPreferences: {
      preload: distPath('preload', 'browser.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
  if (usesInWindowTitleMenu()) {
    winOpts.titleBarStyle = 'hidden';
    winOpts.titleBarOverlay = {
      color: CHROME_BG,
      symbolColor: CHROME_FG,
      height: titleBarOverlayHeight(),
    };
  }
  mainWindow = new BrowserWindow(winOpts);
  attachWindowZoom(mainWindow);

  applyMenuBarVisibility();
  void mainWindow.loadURL(rendererFile('browser', 'index.html'));

  for (const ev of [
    'resize',
    'resized',
    'maximize',
    'unmaximize',
    'restore',
    'enter-full-screen',
    'leave-full-screen',
    'show',
  ] as const) {
    mainWindow.on(ev, () => layoutViews());
  }
  mainWindow.on('close', () => {
    for (const tab of tabs) {
      const wc = tab.view.webContents as Electron.WebContents & {
        destroy?: () => void;
      };
      try {
        wc.removeAllListeners();
        if (typeof wc.destroy === 'function') wc.destroy();
      } catch {
        /* view may already be gone */
      }
    }
    tabs = [];
    activeTabId = null;
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    tabs = [];
    activeTabId = null;
  });

  mainWindow.webContents.on('did-finish-load', () => {
    applyZoomToWebContents(mainWindow?.webContents);
    if (tabs.length === 0) {
      if (pendingLaunchUrl) {
        const url = pendingLaunchUrl;
        pendingLaunchUrl = null;
        createTab(url);
      } else {
        createTab();
      }
    } else {
      layoutViews();
      notifyShell('shell:state', tabSnapshot());
    }
    if (!accountStore.isLoggedIn() || !rulesStore.hasPassword()) {
      openParentWindow();
    }
  });
}

function openParentWindow(_forceSetup = false): void {
  if (parentWindow && !parentWindow.isDestroyed()) {
    parentWindow.focus();
    parentWindow.webContents.send('parent:meta', {
      forceSetup: false,
      unlocked: parentUnlocked && rulesStore.hasPassword(),
    });
    return;
  }

  // Do not parent to mainWindow: BrowserView + child window crashes Chromium on Windows.
  parentWindow = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 720,
    minHeight: 520,
    modal: false,
    title: `${APP_NAME} · 家长设置`,
    webPreferences: {
      preload: distPath('preload', 'parent.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  parentWindow.setMenuBarVisibility(false);
  attachWindowZoom(parentWindow);
  void parentWindow.loadURL(rendererFile('parent', 'index.html'));
  parentWindow.on('closed', () => {
    parentWindow = null;
    parentUnlocked = false;
  });
}

function applyTitleBarOverlay(): void {
  if (!mainWindow || mainWindow.isDestroyed() || !usesInWindowTitleMenu()) return;
  try {
    mainWindow.setTitleBarOverlay({
      color: CHROME_BG,
      symbolColor: CHROME_FG,
      height: titleBarOverlayHeight(),
    });
  } catch {
    /* overlay not available */
  }
}

function applyMenuBarVisibility(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (usesInWindowTitleMenu()) {
    // Keep the native in-window menu off so title + menus share one row.
    // Accelerators still come from Menu.setApplicationMenu.
    mainWindow.setAutoHideMenuBar(false);
    mainWindow.setMenuBarVisibility(false);
    applyTitleBarOverlay();
  } else {
    mainWindow.setAutoHideMenuBar(false);
    mainWindow.setMenuBarVisibility(true);
  }
  layoutViews();
}

function applyZoomToWebContents(
  wc: Electron.WebContents | null | undefined
): void {
  if (!isLiveWebContents(wc)) return;
  wc.setZoomFactor(browserZoomFactor);
}

function appWindows(): BrowserWindow[] {
  return [
    mainWindow,
    parentWindow,
    bookmarksWindow,
    historyWindow,
    downloadsWindow,
    updateWindow,
    passwordsWindow,
    aboutWindow,
  ].filter((w): w is BrowserWindow => Boolean(w && !w.isDestroyed()));
}

function applyBrowserZoom(): void {
  applyingBrowserZoom = true;
  try {
    for (const win of appWindows()) {
      applyZoomToWebContents(win.webContents);
    }
    for (const tab of tabs) {
      applyZoomToWebContents(tab.view.webContents);
    }
    applyTitleBarOverlay();
    layoutViews();
  } finally {
    applyingBrowserZoom = false;
  }
}

function wireZoomEvents(wc: Electron.WebContents): void {
  wc.on('did-finish-load', () => applyZoomToWebContents(wc));
  wc.on('zoom-changed', (_e, direction) => {
    if (applyingBrowserZoom) return;
    zoomBy(direction === 'in' ? 0.1 : -0.1);
  });
}

function attachWindowZoom(win: BrowserWindow): void {
  applyZoomToWebContents(win.webContents);
  wireZoomEvents(win.webContents);
}

function currentZoomFactor(): number {
  return browserZoomFactor;
}

function setZoomFactor(factor: number): void {
  const next = clampZoomFactor(factor);
  if (next !== browserZoomFactor) {
    browserZoomFactor = next;
    saveChromePrefs();
  }
  applyBrowserZoom();
  notifyShell('shell:state', tabSnapshot());
  refreshAppMenu();
}

function zoomBy(delta: number): void {
  if (applyingBrowserZoom) return;
  setZoomFactor(currentZoomFactor() + delta);
}

function findInActiveTab(text: string, forward = true, findNext = true): void {
  const tab = activeTab();
  const wc = tab?.view.webContents;
  if (!tab || !isLiveWebContents(wc)) return;
  const query = String(text || '');
  if (!query) {
    wc.stopFindInPage('clearSelection');
    notifyShell('shell:findResult', null);
    return;
  }
  wc.findInPage(query, { forward, findNext });
}

function openUpdateWindow(): void {
  if (updateWindow && !updateWindow.isDestroyed()) {
    updateWindow.focus();
    return;
  }
  // Do not parent to mainWindow: BrowserView + child window crashes Chromium on Windows.
  updateWindow = new BrowserWindow({
    width: 440,
    height: 380,
    minWidth: 400,
    minHeight: 340,
    modal: false,
    title: `${APP_NAME} · 软件更新`,
    webPreferences: {
      preload: distPath('preload', 'update.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  updateWindow.setMenuBarVisibility(false);
  attachWindowZoom(updateWindow);
  void updateWindow.loadURL(rendererFile('update', 'index.html'));
  updateWindow.on('closed', () => {
    updateWindow = null;
  });
}

function httpOriginFromEvent(e: Electron.IpcMainInvokeEvent): string {
  const url = e.senderFrame?.url || e.sender.getURL() || '';
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.origin;
  } catch {
    return '';
  }
}

function notifyPasswordsChanged(): void {
  if (passwordsWindow && !passwordsWindow.isDestroyed()) {
    passwordsWindow.webContents.send('sitePassword:changed', {
      entries: sitePasswordsStore.listPublic(),
    });
  }
}

function openPasswordsWindow(): void {
  if (passwordsWindow && !passwordsWindow.isDestroyed()) {
    passwordsWindow.focus();
    notifyPasswordsChanged();
    return;
  }
  // Do not parent to mainWindow: BrowserView + child window crashes Chromium on Windows.
  passwordsWindow = new BrowserWindow({
    width: 640,
    height: 520,
    minWidth: 480,
    minHeight: 360,
    modal: false,
    title: `${APP_NAME} · 已保存的密码`,
    webPreferences: {
      preload: distPath('preload', 'passwords.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  passwordsWindow.setMenuBarVisibility(false);
  attachWindowZoom(passwordsWindow);
  void passwordsWindow.loadURL(rendererFile('passwords', 'index.html'));
  passwordsWindow.on('closed', () => {
    passwordsWindow = null;
  });
}

function closeHistoryWindow(): void {
  if (!historyWindow || historyWindow.isDestroyed()) return;
  try {
    historyWindow.close();
  } catch {
    /* ignore */
  }
}

function openHistoryWindow(): void {
  if (historyWindow && !historyWindow.isDestroyed()) {
    historyWindow.focus();
    try {
      historyWindow.webContents.send('history:changed', {
        entries: historyStore.list(),
        count: historyStore.count(),
      });
    } catch {
      /* ignore */
    }
    return;
  }

  // Do not parent this to mainWindow. BrowserView + a child window is a
  // known Chromium crash on Windows when the tab later navigates.
  historyWindow = new BrowserWindow({
    width: 860,
    height: 640,
    minWidth: 640,
    minHeight: 420,
    title: `${APP_NAME} · 历史记录`,
    backgroundColor: CHROME_BG,
    autoHideMenuBar: true,
    webPreferences: {
      preload: distPath('preload', 'history.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  historyWindow.setMenuBarVisibility(false);
  attachWindowZoom(historyWindow);
  void historyWindow.loadURL(rendererFile('history', 'index.html'));
  historyWindow.on('closed', () => {
    historyWindow = null;
  });
}

function openDownloadsWindow(): void {
  if (downloadsWindow && !downloadsWindow.isDestroyed()) {
    downloadsWindow.focus();
    downloadsWindow.webContents.send(
      'downloads:changed',
      downloadsManager.snapshot()
    );
    return;
  }

  // Do not parent to mainWindow: BrowserView + child window crashes Chromium on Windows.
  downloadsWindow = new BrowserWindow({
    width: 860,
    height: 640,
    minWidth: 640,
    minHeight: 420,
    modal: false,
    title: `${APP_NAME} · 下载`,
    webPreferences: {
      preload: distPath('preload', 'downloads.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  downloadsWindow.setMenuBarVisibility(false);
  attachWindowZoom(downloadsWindow);
  void downloadsWindow.loadURL(rendererFile('downloads', 'index.html'));
  downloadsWindow.on('closed', () => {
    downloadsWindow = null;
  });
}

function saveCurrentPage(): void {
  const tab = activeTab();
  const url = tab?.url || '';
  if (!tab) return;
  downloadsManager.startUrl(tab.view.webContents, url);
}

function goBackActive(): void {
  const wc = activeTab()?.view.webContents;
  if (isLiveWebContents(wc) && wc.canGoBack()) wc.goBack();
}

function goForwardActive(): void {
  const wc = activeTab()?.view.webContents;
  if (isLiveWebContents(wc) && wc.canGoForward()) wc.goForward();
}

function reloadActiveTab(ignoreCache = false): void {
  const wc = activeTab()?.view.webContents;
  if (!isLiveWebContents(wc)) return;
  if (ignoreCache) wc.reloadIgnoringCache();
  else wc.reload();
}

function historyNavMenuItems(): MenuItemConstructorOptions[] {
  const tab = activeTab();
  return [
    {
      label: '后退',
      accelerator: 'Alt+Left',
      enabled: Boolean(tab?.canGoBack),
      click: () => goBackActive(),
    },
    {
      label: '前进',
      accelerator: 'Alt+Right',
      enabled: Boolean(tab?.canGoForward),
      click: () => goForwardActive(),
    },
  ];
}

async function confirmClearCache(): Promise<void> {
  const options = {
    type: 'question' as const,
    title: '清理缓存',
    message: '清理网页缓存？',
    detail: '将删除已缓存的网页文件，不会清除历史、书签、密码或登录状态。',
    buttons: ['取消', '清理'],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
  };
  const result =
    mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
  if (result.response !== 1) return;
  await session.fromPartition('persist:youth').clearCache();
  reloadActiveTab(true);
}

function reloadMenuItems(includeHiddenAccelerators = false): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [
    {
      label: '重新载入',
      accelerator: 'CmdOrCtrl+R',
      click: () => reloadActiveTab(false),
    },
    {
      label: '强制刷新',
      accelerator: 'CmdOrCtrl+Shift+R',
      click: () => reloadActiveTab(true),
    },
    {
      label: '清理缓存',
      accelerator: 'CmdOrCtrl+Shift+Delete',
      click: () => {
        void confirmClearCache();
      },
    },
  ];
  if (!includeHiddenAccelerators) return items;
  items.push(
    {
      label: '重新载入',
      accelerator: 'F5',
      visible: false,
      acceleratorWorksWhenHidden: true,
      click: () => reloadActiveTab(false),
    },
    {
      label: '强制刷新',
      accelerator: 'CmdOrCtrl+F5',
      visible: false,
      acceleratorWorksWhenHidden: true,
      click: () => reloadActiveTab(true),
    },
    {
      label: '强制刷新',
      accelerator: 'Shift+F5',
      visible: false,
      acceleratorWorksWhenHidden: true,
      click: () => reloadActiveTab(true),
    },
  );
  return items;
}

function popupNamedMenu(name: string, x: number, y: number): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const top = buildAppMenuTemplate().find((item) => item.label === name);
  const submenu = top?.submenu;
  if (!submenu || !Array.isArray(submenu)) return;
  Menu.buildFromTemplate(submenu).popup({
    window: mainWindow,
    ...toChromeDip(x, y),
  });
}

function popupAppMenu(x: number, y: number): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const tab = activeTab();
  const zoom = Math.round(currentZoomFactor() * 100);
  const menu = Menu.buildFromTemplate([
    {
      label: '新建标签页',
      accelerator: 'CmdOrCtrl+T',
      click: () => createTab(),
    },
    {
      label: '关闭标签页',
      accelerator: 'CmdOrCtrl+W',
      click: () => {
        if (activeTabId) closeTab(activeTabId);
      },
    },
    { type: 'separator' },
    ...historyNavMenuItems(),
    {
      label: '书签',
      submenu: [
        {
          label: currentPageIsBookmarked()
            ? '取消此页书签'
            : '将此页添加为书签',
          accelerator: 'CmdOrCtrl+D',
          enabled: canBookmarkCurrentPage(),
          click: () => bookmarkCurrentPage(),
        },
        {
          label: '管理书签',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => openBookmarksManager(),
        },
      ],
    },
    {
      label: '主页',
      accelerator: 'Alt+Home',
      click: () => goHome(),
    },
    {
      label: '将当前页设为主页',
      click: () => setCurrentPageAsHomepage(),
    },
    {
      label: '设置主页…',
      click: () => sendShellCommand('editHomepage'),
    },
    {
      label: '历史记录',
      accelerator: 'CmdOrCtrl+H',
      click: () => openHistoryWindow(),
    },
    {
      label: '下载',
      accelerator: 'CmdOrCtrl+J',
      click: () => openDownloadsWindow(),
    },
    ...reloadMenuItems(),
    { type: 'separator' },
    {
      label: '在页面中查找',
      accelerator: 'CmdOrCtrl+F',
      click: () => sendShellCommand('openFind'),
    },
    {
      label: '打印…',
      accelerator: 'CmdOrCtrl+P',
      click: () => tab?.view.webContents.print({}),
    },
    {
      label: `浏览器缩放（${zoom}%）`,
      submenu: [
        { label: '放大', accelerator: 'CmdOrCtrl+=', click: () => zoomBy(0.1) },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => zoomBy(-0.1) },
        { label: '实际大小', accelerator: 'CmdOrCtrl+0', click: () => setZoomFactor(1) },
      ],
    },
    {
      label: '全屏',
      accelerator: 'F11',
      click: () => mainWindow?.setFullScreen(!mainWindow.isFullScreen()),
    },
    { type: 'separator' },
    {
      label: '家长设置',
      click: () => openParentWindow(!rulesStore.hasPassword()),
    },
    {
      label: '检查更新',
      click: () => openUpdateWindow(),
    },
    {
      label: '已保存的密码',
      click: () => openPasswordsWindow(),
    },
    {
      label: '设为默认浏览器…',
      click: () => {
        void registerAsDefaultBrowser();
      },
    },
    {
      label: '书签工具栏',
      type: 'checkbox',
      checked: bookmarksBarVisible,
      click: () => {
        bookmarksBarVisible = !bookmarksBarVisible;
        saveChromePrefs();
        layoutViews();
        notifyShell('shell:state', tabSnapshot());
        refreshAppMenu();
      },
    },
    { type: 'separator' },
    { label: '关于简行', click: () => showAboutDialog() },
    { label: '退出', click: () => app.quit() },
  ]);
  menu.popup({
    window: mainWindow,
    ...toChromeDip(x, y),
  });
}

function refreshAppMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenuTemplate()));
}

function buildAppMenuTemplate(): MenuItemConstructorOptions[] {
  const tab = activeTab();
  return [
    {
      label: '文件',
      submenu: [
        {
          label: '新建标签页',
          accelerator: 'CmdOrCtrl+T',
          click: () => createTab(),
        },
        {
          label: '关闭标签页',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            if (activeTabId) closeTab(activeTabId);
          },
        },
        { type: 'separator' },
        {
          label: '保存页面…',
          accelerator: 'CmdOrCtrl+S',
          click: () => saveCurrentPage(),
        },
        {
          label: '打印…',
          accelerator: 'CmdOrCtrl+P',
          click: () => tab?.view.webContents.print({}),
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        {
          label: '在页面中查找',
          accelerator: 'CmdOrCtrl+F',
          click: () => sendShellCommand('openFind'),
        },
        {
          label: '查找下一个',
          accelerator: 'F3',
          click: () => sendShellCommand('findNext'),
        },
        {
          label: '查找上一个',
          accelerator: 'Shift+F3',
          click: () => sendShellCommand('findPrev'),
        },
      ],
    },
    {
      label: '查看',
      submenu: [
        {
          label: '书签工具栏',
          type: 'checkbox',
          checked: bookmarksBarVisible,
          click: () => {
            bookmarksBarVisible = !bookmarksBarVisible;
            saveChromePrefs();
            layoutViews();
            notifyShell('shell:state', tabSnapshot());
            refreshAppMenu();
          },
        },
        { type: 'separator' },
        {
          label: '放大',
          accelerator: 'CmdOrCtrl+=',
          click: () => zoomBy(0.1),
        },
        {
          label: '缩小',
          accelerator: 'CmdOrCtrl+-',
          click: () => zoomBy(-0.1),
        },
        {
          label: '实际大小',
          accelerator: 'CmdOrCtrl+0',
          click: () => setZoomFactor(1),
        },
        { type: 'separator' },
        {
          label: '主页',
          accelerator: 'Alt+Home',
          click: () => goHome(),
        },
        {
          label: '将当前页设为主页',
          click: () => setCurrentPageAsHomepage(),
        },
        {
          label: '设置主页…',
          click: () => sendShellCommand('editHomepage'),
        },
        ...reloadMenuItems(true),
        {
          label: '全屏',
          accelerator: 'F11',
          click: () => {
            if (!mainWindow) return;
            mainWindow.setFullScreen(!mainWindow.isFullScreen());
          },
        },
      ],
    },
    {
      label: '历史',
      submenu: [
        ...historyNavMenuItems(),
        { type: 'separator' },
        {
          label: '显示全部历史',
          accelerator: 'CmdOrCtrl+H',
          click: () => openHistoryWindow(),
        },
        {
          label: '下载',
          accelerator: 'CmdOrCtrl+J',
          click: () => openDownloadsWindow(),
        },
      ],
    },
    {
      label: '书签',
      submenu: [
        {
          label: currentPageIsBookmarked()
            ? '取消此页书签'
            : '将此页添加为书签',
          accelerator: 'CmdOrCtrl+D',
          enabled: canBookmarkCurrentPage(),
          click: () => bookmarkCurrentPage(),
        },
        {
          label: '管理书签',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => openBookmarksManager(),
        },
      ],
    },
    {
      label: '工具',
      submenu: [
        {
          label: '设置主页…',
          click: () => sendShellCommand('editHomepage'),
        },
        {
          label: '将当前页设为主页',
          click: () => setCurrentPageAsHomepage(),
        },
        {
          label: '下载',
          accelerator: 'CmdOrCtrl+J',
          click: () => openDownloadsWindow(),
        },
        {
          label: '已保存的密码',
          click: () => openPasswordsWindow(),
        },
        { type: 'separator' },
        {
          label: '家长设置',
          click: () => openParentWindow(!rulesStore.hasPassword()),
        },
        {
          label: '检查更新',
          click: () => openUpdateWindow(),
        },
        {
          label: '设为默认浏览器…',
          click: () => {
            void registerAsDefaultBrowser();
          },
        },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于简行',
          click: () => showAboutDialog(),
        },
      ],
    },
  ];
}

function showAboutDialog(): void {
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    aboutWindow.focus();
    return;
  }
  // Do not parent to mainWindow: BrowserView + child window crashes Chromium on Windows.
  aboutWindow = new BrowserWindow({
    width: 360,
    height: 300,
    resizable: false,
    minimizable: false,
    maximizable: false,
    modal: false,
    title: `关于 ${APP_NAME}`,
    backgroundColor: '#121a24',
    autoHideMenuBar: true,
    webPreferences: {
      preload: distPath('preload', 'about.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  aboutWindow.setMenuBarVisibility(false);
  attachWindowZoom(aboutWindow);
  void aboutWindow.loadURL(rendererFile('about', 'index.html'));
  aboutWindow.on('closed', () => {
    aboutWindow = null;
  });
}

function openBookmarksManager(): void {
  if (bookmarksWindow && !bookmarksWindow.isDestroyed()) {
    bookmarksWindow.focus();
    bookmarksWindow.webContents.send(
      'bookmarks:changed',
      bookmarksStore.snapshot()
    );
    return;
  }

  // Do not parent to mainWindow: BrowserView + child window crashes Chromium on Windows.
  bookmarksWindow = new BrowserWindow({
    width: 920,
    height: 620,
    minWidth: 720,
    minHeight: 480,
    modal: false,
    title: `${APP_NAME} · 管理书签`,
    webPreferences: {
      preload: distPath('preload', 'bookmarks.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  bookmarksWindow.setMenuBarVisibility(false);
  attachWindowZoom(bookmarksWindow);
  void bookmarksWindow.loadURL(rendererFile('bookmarks', 'index.html'));
  bookmarksWindow.on('closed', () => {
    bookmarksWindow = null;
  });
}

async function openBookmarkById(id: string): Promise<{ ok: boolean; error?: string }> {
  const bm = bookmarksStore.get(id);
  if (!bm || bm.type !== 'bookmark' || !bm.url) {
    return { ok: false, error: '收藏不存在' };
  }
  const tab = tabs.find((t) => t.id === activeTabId);
  if (tab) await guardedLoad(tab, bm.url);
  else createTab(bm.url);
  return { ok: true };
}

function buildBookmarkMenuTemplate(folderId: string): MenuItemConstructorOptions[] {
  const kids = bookmarksStore.getChildren(folderId);
  if (!kids.length) {
    return [{ label: '（空文件夹）', enabled: false }];
  }
  return kids.map((item) => {
    if (item.type === 'folder') {
      return {
        label: item.title || '文件夹',
        submenu: buildBookmarkMenuTemplate(item.id),
      };
    }
    return {
      label: item.title || item.url || '书签',
      click: () => {
        void openBookmarkById(item.id);
      },
    };
  });
}

function popupBookmarkFolder(folderId: string, x: number, y: number): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const menu = Menu.buildFromTemplate(buildBookmarkMenuTemplate(folderId));
  menu.popup({
    window: mainWindow,
    ...toChromeDip(x, y),
  });
}

function registerIpc(): void {
  ipcMain.handle('shell:getState', () => tabSnapshot());

  ipcMain.handle('shell:navigate', async (_e, url: string) => {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab) return { ok: false };
    await guardedLoad(tab, url);
    return { ok: true };
  });

  ipcMain.handle('shell:goBack', () => {
    goBackActive();
  });

  ipcMain.handle('shell:goForward', () => {
    goForwardActive();
  });

  ipcMain.handle('shell:reload', (_e, ignoreCache?: boolean) => {
    reloadActiveTab(Boolean(ignoreCache));
  });

  ipcMain.handle('shell:clearCache', () => confirmClearCache());

  ipcMain.handle('shell:newTab', (_e, url?: string) => {
    createTab(url);
  });

  ipcMain.handle('shell:closeTab', (_e, id: string) => {
    closeTab(id);
  });

  ipcMain.handle('shell:activateTab', (_e, id: string) => {
    activateTab(id);
  });

  ipcMain.handle('shell:openParent', () => {
    openParentWindow(!rulesStore.hasPassword());
  });

  ipcMain.handle('shell:setChromeExtra', (_e, extra: number) => {
    chromeExtraHeight = Math.max(0, Math.min(480, Math.round(Number(extra) || 0)));
    layoutViews();
    return { ok: true, chromeHeight: chromeHeight() };
  });

  ipcMain.handle('shell:getHomepage', () => getHomepage());

  ipcMain.handle('shell:setHomepage', (_e, url: string) => setHomepage(String(url || '')));

  ipcMain.handle('shell:setCurrentHomepage', () => setCurrentPageAsHomepage());

  ipcMain.handle('shell:openHistory', () => {
    openHistoryWindow();
    return { ok: true };
  });

  ipcMain.handle('shell:openDownloads', () => {
    openDownloadsWindow();
    return { ok: true };
  });

  ipcMain.handle('shell:savePage', () => {
    saveCurrentPage();
    return { ok: true };
  });

  ipcMain.handle('shell:popupAppMenu', (_e, x: number, y: number) => {
    popupAppMenu(Number(x) || 0, Number(y) || 0);
    return { ok: true };
  });

  ipcMain.handle(
    'shell:popupMenu',
    (_e, name: string, x: number, y: number) => {
      popupNamedMenu(String(name || ''), Number(x) || 0, Number(y) || 0);
      return { ok: true };
    }
  );

  ipcMain.handle('shell:toggleBookmarksBar', () => {
    bookmarksBarVisible = !bookmarksBarVisible;
    saveChromePrefs();
    layoutViews();
    notifyShell('shell:state', tabSnapshot());
    refreshAppMenu();
    return { ok: true, visible: bookmarksBarVisible };
  });

  ipcMain.handle('shell:zoomIn', () => {
    zoomBy(0.1);
    return { ok: true, zoomFactor: currentZoomFactor() };
  });

  ipcMain.handle('shell:zoomOut', () => {
    zoomBy(-0.1);
    return { ok: true, zoomFactor: currentZoomFactor() };
  });

  ipcMain.handle('shell:zoomReset', () => {
    setZoomFactor(1);
    return { ok: true, zoomFactor: currentZoomFactor() };
  });

  ipcMain.handle(
    'shell:findInPage',
    (_e, text: string, options?: { forward?: boolean; findNext?: boolean }) => {
      findInActiveTab(
        text,
        options?.forward !== false,
        options?.findNext !== false
      );
      return { ok: true };
    }
  );

  ipcMain.handle('shell:stopFindInPage', () => {
    const tab = activeTab();
    tab?.view.webContents.stopFindInPage('clearSelection');
    notifyShell('shell:findResult', null);
    return { ok: true };
  });

  ipcMain.handle('shell:print', () => {
    activeTab()?.view.webContents.print({});
    return { ok: true };
  });

  ipcMain.handle('shell:toggleFullscreen', () => {
    if (!mainWindow) return { ok: false };
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
    return { ok: true, fullscreen: mainWindow.isFullScreen() };
  });

  ipcMain.handle('shell:quit', () => {
    app.quit();
    return { ok: true };
  });

  ipcMain.handle('shell:setAsDefaultBrowser', () => registerAsDefaultBrowser());

  ipcMain.handle('shell:about', () => {
    showAboutDialog();
    return { ok: true, version: app.getVersion() };
  });

  ipcMain.handle('about:getInfo', () => ({
    name: APP_NAME,
    version: app.getVersion(),
    website: OFFICIAL_WEBSITE,
  }));

  ipcMain.handle('about:openWebsite', () => {
    void shell.openExternal(OFFICIAL_WEBSITE);
    return { ok: true };
  });

  ipcMain.handle('about:close', () => {
    if (aboutWindow && !aboutWindow.isDestroyed()) aboutWindow.close();
    return { ok: true };
  });

  ipcMain.handle('shell:appInfo', () => ({
    name: APP_NAME,
    version: app.getVersion(),
  }));

  ipcMain.handle('sitePassword:lookup', (e) => {
    const origin = httpOriginFromEvent(e);
    if (!origin) return null;
    return sitePasswordsStore.lookup(origin);
  });

  ipcMain.handle(
    'sitePassword:submitted',
    (e, input: { username?: string; password?: string }) => {
      const origin = httpOriginFromEvent(e);
      const username = String(input?.username || '').trim();
      const password = String(input?.password || '');
      if (!origin || !username || !password) return { offer: false };
      const existing = sitePasswordsStore.find(origin, username);
      if (existing && existing.password === password) return { offer: false };
      sendShellCommand('offerSavePassword', {
        origin,
        host: existing?.host || new URL(origin).hostname,
        username,
        password,
        update: Boolean(existing),
      });
      return { offer: true };
    }
  );

  ipcMain.handle(
    'sitePassword:saveOffer',
    (
      _e,
      input: { origin?: string; username?: string; password?: string }
    ) => {
      const origin = String(input?.origin || '');
      try {
        const u = new URL(origin);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          return { ok: false, error: '无效地址' };
        }
      } catch {
        return { ok: false, error: '无效地址' };
      }
      const saved = sitePasswordsStore.save(
        origin,
        String(input?.username || ''),
        String(input?.password || '')
      );
      if (!saved) return { ok: false, error: '保存失败' };
      notifyPasswordsChanged();
      return { ok: true };
    }
  );

  ipcMain.handle('sitePassword:list', () => ({
    entries: sitePasswordsStore.listPublic(),
  }));

  ipcMain.handle('sitePassword:remove', (_e, id: string) => {
    const ok = sitePasswordsStore.remove(String(id || ''));
    if (ok) notifyPasswordsChanged();
    return { ok };
  });

  ipcMain.handle('downloads:list', (_e, query?: string) => ({
    entries: downloadsManager.list(query),
    count: downloadsManager.count(),
    activeCount: downloadsManager.activeCount(),
  }));
  ipcMain.handle('downloads:open', (_e, id: string) =>
    downloadsManager.open(String(id || ''))
  );
  ipcMain.handle('downloads:show', (_e, id: string) =>
    downloadsManager.showInFolder(String(id || ''))
  );
  ipcMain.handle('downloads:cancel', (_e, id: string) =>
    downloadsManager.cancel(String(id || ''))
  );
  ipcMain.handle('downloads:pause', (_e, id: string) =>
    downloadsManager.pause(String(id || ''))
  );
  ipcMain.handle('downloads:resume', (_e, id: string) =>
    downloadsManager.resume(String(id || ''))
  );
  ipcMain.handle('downloads:remove', (_e, id: string) =>
    downloadsManager.remove(String(id || ''))
  );
  ipcMain.handle('downloads:clear', () => downloadsManager.clear());
  ipcMain.handle('downloads:openFolder', () => downloadsManager.openFolder());

  ipcMain.handle('history:list', (_e, query?: string) => {
    return { ok: true, entries: historyStore.list(query), count: historyStore.count() };
  });

  ipcMain.handle('history:open', (_e, id: string) => {
    const entry = historyStore.get(String(id || ''));
    if (!entry) return { ok: false, error: '记录不存在' };
    const url = entry.url;
    // Reply first, then close the history window and navigate. Doing
    // loadURL on the BrowserView while this child window is the IPC
    // sender (and was parented to main) crashes Chromium on Windows.
    setImmediate(() => {
      closeHistoryWindow();
      const tab = activeTab();
      if (tab) void guardedLoad(tab, url);
      else createTab(url);
      focusMainWindow();
    });
    return { ok: true };
  });

  ipcMain.handle('history:canDelete', () => ({
    ok: true,
    canDeleteWithoutPassword: parentUnlocked || !rulesStore.hasPassword(),
    hasPassword: rulesStore.hasPassword(),
    parentUnlocked,
  }));

  ipcMain.handle('history:remove', (_e, id: string, password?: string) => {
    const auth = authorizeHistoryDelete(password);
    if (!auth.ok) return auth;
    const result = historyStore.remove(id);
    if (result.ok) {
      notifyHistory();
      void historySync?.syncNow();
    }
    return result;
  });

  ipcMain.handle('history:clear', (_e, password?: string) => {
    const auth = authorizeHistoryDelete(password);
    if (!auth.ok) return auth;
    const result = historyStore.clear();
    notifyHistory();
    void historySync?.syncNow();
    return result;
  });

  registerUpdateIpc();

  ipcMain.handle('bookmarks:snapshot', () => bookmarksStore.snapshot());

  ipcMain.handle('bookmarks:toggleCurrent', () => {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab || !isHttpUrl(tab.url)) {
      return { ok: false, error: '当前页无法收藏' };
    }
    const result = bookmarksStore.toggleUrl(tab.title || tab.url, tab.url);
    notifyShell('shell:state', tabSnapshot());
    notifyBookmarks();
    return result;
  });

  ipcMain.handle(
    'bookmarks:add',
    (
      _e,
      input: { title: string; url: string; parentId?: string }
    ) => {
      const result = bookmarksStore.addBookmark(input || { title: '', url: '' });
      notifyShell('shell:state', tabSnapshot());
      notifyBookmarks();
      return { ...result, snapshot: bookmarksStore.snapshot() };
    }
  );

  ipcMain.handle(
    'bookmarks:createFolder',
    (_e, input: { title: string; parentId?: string }) => {
      const result = bookmarksStore.createFolder(input || { title: '' });
      notifyShell('shell:state', tabSnapshot());
      notifyBookmarks();
      return { ...result, snapshot: bookmarksStore.snapshot() };
    }
  );

  ipcMain.handle('bookmarks:rename', (_e, id: string, title: string) => {
    const result = bookmarksStore.rename(id, title);
    notifyShell('shell:state', tabSnapshot());
    notifyBookmarks();
    return { ...result, snapshot: bookmarksStore.snapshot() };
  });

  ipcMain.handle('bookmarks:move', (_e, id: string, parentId: string) => {
    const result = bookmarksStore.move(id, parentId);
    notifyShell('shell:state', tabSnapshot());
    notifyBookmarks();
    return { ...result, snapshot: bookmarksStore.snapshot() };
  });

  ipcMain.handle('bookmarks:remove', (_e, id: string) => {
    const result = bookmarksStore.remove(id);
    notifyShell('shell:state', tabSnapshot());
    notifyBookmarks();
    return { ...result, snapshot: bookmarksStore.snapshot() };
  });

  ipcMain.handle('bookmarks:children', (_e, folderId: string) => {
    return bookmarksStore.getChildren(folderId || 'toolbar');
  });

  ipcMain.handle('bookmarks:open', async (_e, id: string) => {
    return openBookmarkById(id);
  });

  ipcMain.handle(
    'bookmarks:popupFolder',
    (_e, folderId: string, x: number, y: number) => {
      popupBookmarkFolder(folderId, Number(x) || 0, Number(y) || 0);
      return { ok: true };
    }
  );

  ipcMain.handle('bookmarks:openManager', () => {
    openBookmarksManager();
  });

  // Bookmark sync: account login only, no parent unlock required
  ipcMain.handle('bookmarks:account', () => accountStore.getPublic());

  ipcMain.handle('bookmarks:syncStatus', async () => {
    if (!accountStore.isLoggedIn()) {
      return { ok: false, error: '请先在家长设置中登录账号', loggedIn: false };
    }
    const localRevision = bookmarksStore.getRevision();
    const localNodes = bookmarksStore.exportForSync();
    try {
      const remote = await syncClient.pullBookmarks();
      if (!remote.ok) {
        return {
          ok: false,
          error: remote.error || '无法读取服务器收藏夹',
          loggedIn: true,
          localRevision,
          serverRevision: null,
        };
      }
      const serverRevision = remote.revision || 0;
      const contentEqual =
        JSON.stringify(localNodes) === JSON.stringify(remote.nodes || []);
      let status = '本地收藏夹已是最新';
      if (!contentEqual) {
        status =
          serverRevision > localRevision
            ? '服务器收藏夹有更新，请拉取'
            : '本地收藏夹有未上传更改，请上传';
      }
      return {
        ok: true,
        loggedIn: true,
        localRevision,
        serverRevision,
        contentEqual,
        status,
        username: accountStore.getPublic().username,
      };
    } catch (e) {
      return {
        ok: false,
        loggedIn: true,
        error: e instanceof Error ? e.message : '检查失败',
        localRevision,
        serverRevision: null,
      };
    }
  });

  ipcMain.handle('bookmarks:pushSync', async () => {
    if (!accountStore.isLoggedIn()) {
      return { ok: false, error: '请先在家长设置中登录账号' };
    }
    const localNodes = bookmarksStore.exportForSync();
    const localRevision = bookmarksStore.getRevision();
    const remote = await syncClient.pullBookmarks();
    if (!remote.ok) {
      return { ok: false, error: remote.error || '无法读取云端收藏夹' };
    }
    if (JSON.stringify(localNodes) === JSON.stringify(remote.nodes || [])) {
      return {
        ok: true,
        unchanged: true,
        revision: remote.revision || 0,
        snapshot: bookmarksStore.snapshot(),
      };
    }
    const result = await syncClient.pushBookmarks(localNodes, localRevision);
    if (!result.ok) return result;
    bookmarksStore.setRevision(result.revision || localRevision);
    notifyShell('shell:state', tabSnapshot());
    notifyBookmarks();
    return {
      ok: true,
      unchanged: false,
      revision: result.revision,
      snapshot: bookmarksStore.snapshot(),
    };
  });

  ipcMain.handle('bookmarks:pullSync', async () => {
    if (!accountStore.isLoggedIn()) {
      return { ok: false, error: '请先在家长设置中登录账号' };
    }
    const localNodes = bookmarksStore.exportForSync();
    const pulled = await syncClient.pullBookmarks();
    if (!pulled.ok) {
      return { ok: false, error: pulled.error || '拉取收藏夹失败' };
    }
    if (JSON.stringify(localNodes) === JSON.stringify(pulled.nodes || [])) {
      if (typeof pulled.revision === 'number') {
        bookmarksStore.setRevision(pulled.revision);
      }
      return {
        ok: true,
        unchanged: true,
        revision: pulled.revision || 0,
        snapshot: bookmarksStore.snapshot(),
      };
    }
    const applied = bookmarksStore.replaceFromSync(
      (pulled.nodes || []) as Partial<import('./bookmarks-store').BookmarkNode>[],
      pulled.revision
    );
    if (!applied.ok) return applied;
    notifyShell('shell:state', tabSnapshot());
    notifyBookmarks();
    return {
      ok: true,
      unchanged: false,
      revision: pulled.revision,
      snapshot: applied.snapshot,
    };
  });

  // Parent IPC
  ipcMain.handle('parent:getMeta', () => ({
    forceSetup: false,
    unlocked: parentUnlocked && rulesStore.hasPassword(),
    rules: parentUnlocked ? rulesStore.getPublic() : null,
  }));

  ipcMain.handle('parent:setupPassword', (_e, password: string) => {
    // Legacy: local-only setup no longer used; account login sets the unlock hash.
    if (rulesStore.hasPassword()) {
      return { ok: false, error: '密码已设置，请使用账号密码解锁' };
    }
    const result = syncLocalUnlockPassword(password);
    if (result.ok) parentUnlocked = true;
    return result;
  });

  ipcMain.handle('parent:unlock', async (_e, password: string) => {
    if (typeof password !== 'string' || !password) {
      return { ok: false, error: '请输入账号密码' };
    }
    if (rulesStore.verify(password)) {
      parentUnlocked = true;
      return { ok: true, rules: rulesStore.getPublic() };
    }
    // Migration / forgot local hash: accept account password via server.
    const session = accountStore.getSession();
    if (session?.username) {
      try {
        const login = await syncClient.login(session.username, password);
        if (login.ok) {
          syncLocalUnlockPassword(password);
          parentUnlocked = true;
          void historySync?.syncNow();
          return { ok: true, rules: rulesStore.getPublic() };
        }
      } catch {
        // fall through
      }
    }
    return { ok: false, error: '密码错误' };
  });

  ipcMain.handle(
    'parent:changePassword',
    async (_e, current: string, next: string) => {
      if (!parentUnlocked) return { ok: false, error: '未解锁' };
      if (typeof next !== 'string' || next.length < 6) {
        return { ok: false, error: '新密码至少 6 位' };
      }
      if (accountStore.isLoggedIn()) {
        const remote = await syncClient.changePassword(current, next);
        if (!remote.ok) return remote;
        const local = syncLocalUnlockPassword(next);
        if (!local.ok) return local;
        return { ok: true, message: remote.message || '密码已更新' };
      }
      return rulesStore.changePassword(current, next);
    }
  );

  ipcMain.handle('parent:setFilteringEnabled', (_e, enabled: boolean) => {
    if (!parentUnlocked) return { ok: false, error: '未解锁' };
    const result = rulesStore.setFilteringEnabled(Boolean(enabled));
    notifyShell('shell:state', tabSnapshot());
    return result;
  });

  ipcMain.handle('parent:getRules', () => {
    if (!parentUnlocked) return null;
    return rulesStore.getPublic();
  });

  ipcMain.handle(
    'parent:createGroup',
    (
      _e,
      input: {
        name: string;
        extensionId?: 'none' | 'bilibili';
        useSuggestedHosts?: boolean;
      }
    ) => {
      if (!parentUnlocked) return { ok: false, error: '未解锁' };
      return rulesStore.createGroup(input || { name: '' });
    }
  );

  ipcMain.handle(
    'parent:updateGroup',
    (
      _e,
      id: string,
      patch: { name?: string; enabled?: boolean; extensionId?: 'none' | 'bilibili' }
    ) => {
      if (!parentUnlocked) return { ok: false, error: '未解锁' };
      return rulesStore.updateGroup(id, patch || {});
    }
  );

  ipcMain.handle('parent:deleteGroup', (_e, id: string) => {
    if (!parentUnlocked) return { ok: false, error: '未解锁' };
    return rulesStore.deleteGroup(id);
  });

  ipcMain.handle('parent:addHost', (_e, groupId: string, host: string) => {
    if (!parentUnlocked) return { ok: false, error: '未解锁' };
    return rulesStore.addHost(groupId, host);
  });

  ipcMain.handle('parent:removeHost', (_e, groupId: string, host: string) => {
    if (!parentUnlocked) return { ok: false, error: '未解锁' };
    return rulesStore.removeHost(groupId, host);
  });

  ipcMain.handle(
    'parent:addBiliUp',
    (_e, groupId: string, midOrUrl: string, note?: string) => {
      if (!parentUnlocked) return { ok: false, error: '未解锁' };
      const mid = extractMidFromInput(midOrUrl);
      if (!mid) return { ok: false, error: '无法识别 mid 或空间链接' };
      return rulesStore.addBiliUp(groupId, mid, note);
    }
  );

  ipcMain.handle('parent:removeBiliUp', (_e, groupId: string, mid: string) => {
    if (!parentUnlocked) return { ok: false, error: '未解锁' };
    return rulesStore.removeBiliUp(groupId, mid);
  });

  // Watch requests: child can create from block page; approve/reject need parent unlock
  ipcMain.handle(
    'watchRequest:create',
    async (
      e,
      input: {
        url: string;
        reason?: string;
        mid?: string;
        bvid?: string;
        aid?: string;
        title?: string;
      }
    ) => {
      const senderUrl = e.sender.getURL() || '';
      if (!senderUrl.includes('/block/')) {
        return { ok: false, error: '仅可从拦截页发起申请' };
      }
      return watchRequestsStore.create(input || { url: '' });
    }
  );

  ipcMain.handle('watchRequest:list', () => {
    if (!parentUnlocked) return { ok: false, error: '未解锁', requests: [] };
    return {
      ok: true,
      requests: watchRequestsStore.list(),
      pendingCount: watchRequestsStore.pendingCount(),
    };
  });

  ipcMain.handle('watchRequest:pendingCount', () => {
    // Safe to show badge count without unlock when parent window is open after login gate
    return { ok: true, count: watchRequestsStore.pendingCount() };
  });

  ipcMain.handle('watchRequest:reject', (_e, id: string) => {
    if (!parentUnlocked) return { ok: false, error: '未解锁' };
    return watchRequestsStore.reject(id);
  });

  ipcMain.handle('watchRequest:approve', async (_e, id: string) => {
    if (!parentUnlocked) return { ok: false, error: '未解锁' };
    const req = watchRequestsStore.get(id);
    if (!req) return { ok: false, error: '申请不存在' };
    if (req.status !== 'pending') return { ok: false, error: '该申请已处理' };

    let host = req.host;
    try {
      host = host || new URL(req.url).hostname.toLowerCase();
    } catch {
      // ignore
    }
    const isBili =
      !!host &&
      (host === 'bilibili.com' || host.endsWith('.bilibili.com'));

    let mid = req.mid;
    if (isBili && !mid) {
      const { resolveVideoOwner, parseBiliVideoId } = await import(
        './bili-resolver'
      );
      try {
        const u = new URL(req.url);
        const ids = parseBiliVideoId(u.pathname);
        const owner = await resolveVideoOwner(
          req.bvid || ids?.bvid,
          req.aid || ids?.aid
        );
        if (owner.ok && owner.mid) mid = owner.mid;
      } catch {
        // ignore
      }
    }

    let rules = rulesStore.getRaw();
    let addedHost: string | undefined;

    if (isBili && mid) {
      const biliGroup = rules.groups.find(
        (g) => g.enabled && g.extensionId === 'bilibili'
      );
      if (!biliGroup) {
        return { ok: false, error: '没有启用的 B 站配置组' };
      }
      const note =
        req.title && req.title.trim()
          ? `访问申请：${req.title.trim().slice(0, 40)}`
          : '访问申请';
      const added = rulesStore.addBiliUp(biliGroup.id, mid, note);
      if (!added.ok) return added;
      rules = added.rules!;
    } else if (!isBili && host) {
      // Add site host to a generic whitelist group
      let group = rules.groups.find(
        (g) => g.enabled && g.extensionId === 'none' && g.name === '访问申请'
      );
      if (!group) {
        group = rules.groups.find(
          (g) => g.enabled && g.extensionId === 'none'
        );
      }
      if (!group) {
        const created = rulesStore.createGroup({
          name: '访问申请',
          extensionId: 'none',
          useSuggestedHosts: false,
        });
        if (!created.ok || !created.group) {
          return { ok: false, error: created.error || '无法创建配置组' };
        }
        group = created.group;
        rules = created.rules!;
      }
      const added = rulesStore.addHost(group.id, host);
      if (!added.ok) return added;
      rules = added.rules!;
      addedHost = host;
    }

    const marked = watchRequestsStore.markApproved(id);
    if (!marked.ok) return marked;

    const tab = tabs.find((t) => t.id === activeTabId) || tabs[0];
    if (tab) {
      void guardedLoad(tab, req.url);
    }

    return {
      ok: true,
      request: marked.request,
      rules,
      mid: mid || undefined,
      host: addedHost,
    };
  });

  ipcMain.handle('error:report', (_e, raw: unknown) => {
    const parsed = sanitizeRendererReport(raw);
    if (parsed) reportCrash(parsed);
    return { ok: true };
  });

  ipcMain.handle('account:get', () => {
    return accountStore.getPublic();
  });

  ipcMain.handle('account:syncStatus', async () => {
    if (!accountStore.isLoggedIn()) {
      return { ok: false, error: '请先登录账号', loggedIn: false };
    }
    const account = accountStore.getPublic();
    const localRevision = account.lastRevision || 0;
    const localGroups = rulesStore.exportGroups();
    try {
      const remote = await syncClient.pull({ touch: false });
      if (!remote.ok) {
        return {
          ok: false,
          error: remote.error || '无法读取服务器版本',
          localRevision,
          serverRevision: null,
          contentEqual: false,
          lastSyncAt: account.lastSyncAt || 0,
        };
      }
      const serverRevision = remote.revision || 0;
      const contentEqual = groupsPayloadEqual(localGroups, remote.groups || []);
      let status = '本地已是最新配置';
      if (!contentEqual) {
        if (serverRevision > localRevision) {
          status = '服务器有新版本，请拉取';
        } else {
          status = '本地有未上传更改，请上传';
        }
      }
      return {
        ok: true,
        localRevision,
        serverRevision,
        contentEqual,
        status,
        lastSyncAt: account.lastSyncAt || 0,
        serverUpdatedAt: remote.updatedAt || 0,
      };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : '检查服务器版本失败',
        localRevision,
        serverRevision: null,
        contentEqual: false,
        lastSyncAt: account.lastSyncAt || 0,
      };
    }
  });

  ipcMain.handle(
    'account:register',
    async (
      _e,
      input: {
        username: string;
        password: string;
        email?: string;
        serverUrl?: string;
      }
    ) => {
      try {
        const result = await syncClient.register(
          input.username,
          input.password,
          input.serverUrl,
          input.email
        );
        if (result.ok) {
          syncLocalUnlockPassword(input.password);
          parentUnlocked = true;
          void historySync?.syncNow();
          return {
            ok: true,
            unlocked: true,
            rules: rulesStore.getPublic(),
            account: accountStore.getPublic(),
          };
        }
        return result;
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : '注册失败',
        };
      }
    }
  );

  ipcMain.handle(
    'account:login',
    async (
      _e,
      input: { username: string; password: string; serverUrl?: string }
    ) => {
      try {
        const result = await syncClient.login(
          input.username,
          input.password,
          input.serverUrl
        );
        if (result.ok) {
          syncLocalUnlockPassword(input.password);
          parentUnlocked = true;
          void historySync?.syncNow();
          return {
            ok: true,
            unlocked: true,
            rules: rulesStore.getPublic(),
            account: accountStore.getPublic(),
          };
        }
        return result;
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : '登录失败',
        };
      }
    }
  );

  ipcMain.handle('account:logout', async (_e, password?: string) => {
    // Gate screen is locked: require parent password before account logout
    if (!parentUnlocked && rulesStore.hasPassword()) {
      if (!rulesStore.verify(typeof password === 'string' ? password : '')) {
        return { ok: false, error: '密码错误' };
      }
    }
    await syncClient.logout();
    parentUnlocked = false;
    return { ok: true, account: accountStore.getPublic() };
  });

  ipcMain.handle(
    'account:verifyResetEmail',
    async (_e, input: { username: string; email: string; serverUrl?: string }) => {
      try {
        return await syncClient.verifyResetEmail(
          input.username,
          input.email,
          input.serverUrl
        );
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : '验证失败',
        };
      }
    }
  );

  ipcMain.handle(
    'account:forgotPassword',
    async (_e, input: { username: string; email: string; serverUrl?: string }) => {
      try {
        return await syncClient.forgotPassword(
          input.username,
          input.email,
          input.serverUrl
        );
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : '发送失败',
        };
      }
    }
  );

  ipcMain.handle(
    'account:resetPassword',
    async (
      _e,
      input: {
        username: string;
        email: string;
        code: string;
        newPassword: string;
        serverUrl?: string;
      }
    ) => {
      try {
        const result = await syncClient.resetPassword(input);
        if (result.ok) {
          syncLocalUnlockPassword(input.newPassword);
          accountStore.clearSession();
          parentUnlocked = false;
        }
        return result;
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : '重置失败',
        };
      }
    }
  );

  ipcMain.handle(
    'account:bindEmail',
    async (_e, input: { email: string; password: string }) => {
      try {
        return await syncClient.bindEmail(input.email, input.password);
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : '绑定失败',
        };
      }
    }
  );

  ipcMain.handle('account:me', async () => {
    try {
      return await syncClient.me();
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : '读取账号失败',
      };
    }
  });

  ipcMain.handle('account:push', async () => {
    if (!parentUnlocked) {
      return { ok: false, error: '上传访问配置需要先输入账号密码解锁' };
    }
    if (!accountStore.isLoggedIn()) {
      return { ok: false, error: '请先登录账号' };
    }
    const localGroups = rulesStore.exportGroups();
    const remote = await syncClient.pull({ touch: false });
    if (!remote.ok) {
      return { ok: false, error: remote.error || '无法读取云端配置' };
    }
    if (groupsPayloadEqual(localGroups, remote.groups || [])) {
      return {
        ok: true,
        unchanged: true,
        revision: remote.revision,
        updatedAt: remote.updatedAt,
        account: accountStore.getPublic(),
        rules: rulesStore.getPublic(),
      };
    }
    const result = await syncClient.push(localGroups);
    return {
      ...result,
      unchanged: false,
      account: accountStore.getPublic(),
      rules: rulesStore.getPublic(),
    };
  });

  ipcMain.handle('account:pull', async () => {
    if (!accountStore.isLoggedIn()) {
      return { ok: false, error: '请先登录账号' };
    }
    const localGroups = rulesStore.exportGroups();
    const pulled = await syncClient.pull();
    if (!pulled.ok || !pulled.groups) {
      return { ok: false, error: pulled.error || '拉取失败' };
    }
    if (groupsPayloadEqual(localGroups, pulled.groups)) {
      return {
        ok: true,
        unchanged: true,
        revision: pulled.revision,
        updatedAt: pulled.updatedAt,
        account: accountStore.getPublic(),
        rules: rulesStore.getPublic(),
      };
    }
    const applied = rulesStore.replaceGroups(pulled.groups);
    return {
      ok: applied.ok,
      error: applied.error,
      unchanged: false,
      revision: pulled.revision,
      updatedAt: pulled.updatedAt,
      account: accountStore.getPublic(),
      rules: rulesStore.getPublic(),
    };
  });
}

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;
  pendingLaunchUrl = extractLaunchUrl(process.argv) || pendingLaunchUrl;
  rulesStore = new RulesStore();
  bookmarksStore = new BookmarksStore();
  accountStore = new AccountStore();
  watchRequestsStore = new WatchRequestsStore();
  historyStore = new HistoryStore();
  downloadsStore = new DownloadsStore();
  downloadsManager = new DownloadsManager({
    store: downloadsStore,
    getRules: () => rulesStore.getRaw(),
    onChanged: (latest) => notifyDownloads(latest),
  });
  downloadsManager.attach(session.fromPartition('persist:youth'));
  sitePasswordsStore = new SitePasswordsStore();
  syncClient = new SyncClient(accountStore);
  historySync = createHistorySync({
    account: accountStore,
    store: historyStore,
    client: syncClient,
    onChanged: () => notifyHistory(),
  });
  void historySync.syncNow();
  initErrorReporter({
    getServerUrl: () => accountStore.getServerUrl(),
    getUsername: () => accountStore.getSession()?.username || '',
    getToken: () => accountStore.getSession()?.token,
  });
  loadChromePrefs();
  refreshAppMenu();
  registerIpc();

  app.on('web-contents-created', (_e, wc) => {
    attachWebContentsDiagnostics(wc, {
      onRenderGone: (contents, details) => {
        if (details.reason === 'clean-exit') return;
        const tab = tabs.find((t) => t.view.webContents === contents);
        if (!tab || !isHttpUrl(tab.url)) return;

        sessionRendererCrashes += 1;
        if (sessionRendererCrashes >= 3) {
          enableGpuSafeMode(`renderer-crash-x${sessionRendererCrashes}`);
        }

        const crashedUrl = tab.url;
        const now = Date.now();
        let state = renderCrashState.get(contents);
        if (
          !state ||
          state.url !== crashedUrl ||
          now - state.lastAt > 60_000
        ) {
          state = { url: crashedUrl, count: 0, lastAt: now };
        }
        state.count += 1;
        state.lastAt = now;
        renderCrashState.set(contents, state);

        // Auto-reloading a page that keeps killing the renderer creates a
        // tight APPCRASH loop (seen as 0x80000003 in Windows Error Reporting).
        if (state.count >= 2) {
          const blocked = buildBlockUrl(
            blockPageUrl(),
            crashedUrl,
            'page_crashed',
            '页面反复崩溃，已停止自动刷新。可关闭标签或换个网址。'
          );
          setTimeout(() => {
            if (!isLiveWebContents(tab.view.webContents)) return;
            void loadTabUrl(tab.view.webContents, blocked);
          }, 100);
          return;
        }

        setTimeout(() => {
          if (isLiveWebContents(tab.view.webContents)) {
            void guardedLoad(tab, crashedUrl);
          }
        }, 400);
      },
    });
  });

  app.on('child-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return;
    if (details.type === 'GPU') {
      enableGpuSafeMode(
        `gpu ${details.reason} exit=${details.exitCode}`
      );
    }
    reportCrash({
      kind: 'child-gone',
      level: details.type === 'GPU' ? 'fatal' : 'error',
      message: `${details.type} ${details.reason} exit=${details.exitCode}`,
      extra: {
        type: details.type,
        reason: details.reason,
        exitCode: details.exitCode,
        serviceName: details.serviceName,
        name: details.name,
      },
    });
  });

  // Block permission prompts that could be abused
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => {
    cb(false);
  });

  createMainWindow();
  screen.on('display-metrics-changed', () => layoutViews());
  if (process.env.JIANXING_CAPTURE === '1') {
    void captureMarketingShots();
  } else {
    startAutoUpdater(() => mainWindow);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('before-quit', () => {
  void historySync?.syncNow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
