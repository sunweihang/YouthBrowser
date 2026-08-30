import {
  app,
  BrowserView,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
} from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { pathToFileURL } from 'url';
import { BookmarksStore } from './bookmarks-store';
import { AccountStore } from './account-store';
import { groupsPayloadEqual, SyncClient } from './sync-client';
import { startAutoUpdater, registerUpdateIpc } from './auto-update';
import {
  buildBlockUrl,
  canNavigate,
  hostAllowed,
  isDownloadAllowed,
} from './navigation-guard';
import { HistoryStore } from './history-store';
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

const TAB_BAR_HEIGHT = 40;
const TOOLBAR_HEIGHT = 48;
const BOOKMARKS_BAR_HEIGHT = 36;
/** Extra space for chrome overlays (e.g. update / find) that would otherwise sit under BrowserView */
let chromeExtraHeight = 0;
let bookmarksBarVisible = true;
let menuBarVisible = true;
let homepage = '';

function chromeHeight(): number {
  return (
    TAB_BAR_HEIGHT +
    TOOLBAR_HEIGHT +
    (bookmarksBarVisible ? BOOKMARKS_BAR_HEIGHT : 0) +
    chromeExtraHeight
  );
}

function chromePrefsPath(): string {
  return join(app.getPath('userData'), 'chrome.json');
}

function loadChromePrefs(): void {
  let hasHomepageKey = false;
  try {
    const raw = JSON.parse(readFileSync(chromePrefsPath(), 'utf8')) as {
      bookmarksBarVisible?: boolean;
      menuBarVisible?: boolean;
      homepage?: string;
    };
    bookmarksBarVisible = raw.bookmarksBarVisible !== false;
    menuBarVisible = raw.menuBarVisible !== false;
    if (Object.prototype.hasOwnProperty.call(raw, 'homepage')) {
      hasHomepageKey = true;
      const parsed = normalizeHomepage(String(raw.homepage || ''));
      homepage = parsed.ok ? parsed.url : '';
    }
  } catch {
    bookmarksBarVisible = true;
    menuBarVisible = true;
  }
  if (!hasHomepageKey) {
    const migrated = rulesStore.getHomepage();
    if (migrated) homepage = migrated;
    saveChromePrefs();
  }
}

function saveChromePrefs(): void {
  const path = chromePrefsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ bookmarksBarVisible, menuBarVisible, homepage }, null, 2),
    'utf8'
  );
}

function getHomepage(): string {
  return homepage;
}

function setHomepage(
  raw: string
): { ok: boolean; error?: string; homepage?: string } {
  const parsed = normalizeHomepage(raw);
  if (!parsed.ok) return parsed;
  homepage = parsed.url;
  saveChromePrefs();
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
let rulesStore: RulesStore;
let bookmarksStore: BookmarksStore;
let accountStore: AccountStore;
let watchRequestsStore: WatchRequestsStore;
let historyStore: HistoryStore;
let downloadsStore: DownloadsStore;
let downloadsManager: DownloadsManager;
let sitePasswordsStore: SitePasswordsStore;
let syncClient: SyncClient;
let tabs: TabState[] = [];
let activeTabId: string | null = null;
let parentUnlocked = false;
let pendingLaunchUrl: string | null = null;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
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
  if (historyWindow && !historyWindow.isDestroyed()) {
    historyWindow.webContents.send('history:changed', {
      entries: historyStore.list(),
      count: historyStore.count(),
    });
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
}

function authorizeHistoryDelete(password?: string): { ok: boolean; error?: string } {
  if (parentUnlocked) return { ok: true };
  if (!rulesStore.hasPassword()) return { ok: true };
  if (typeof password === 'string' && rulesStore.verify(password)) {
    return { ok: true };
  }
  return { ok: false, error: '需要家长密码才能删除历史记录' };
}

function sendShellCommand(action: string, payload?: unknown): void {
  notifyShell('shell:command', { action, payload });
}

function notifyShell(channel: string, payload: unknown): void {
  mainWindow?.webContents.send(channel, payload);
}

function isHttpUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
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
    needsParentSetup: !rulesStore.hasPassword(),
    filteringEnabled: rulesStore.isFilteringEnabled(),
    homepage: getHomepage(),
    bookmarksBarVisible,
    menuBarVisible,
    zoomFactor: active ? Number(active.view.webContents.getZoomFactor() || 1) : 1,
  };
}

function layoutViews(): void {
  if (!mainWindow) return;
  const [width, height] = mainWindow.getContentSize();
  const top = chromeHeight();
  for (const tab of tabs) {
    const bounds = {
      x: 0,
      y: top,
      width,
      height: Math.max(0, height - top),
    };
    tab.view.setBounds(bounds);
    tab.view.setAutoResize({ width: true, height: true });
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
    menuBarVisible ? '1' : '0',
  ].join('|');
  if (key === lastMenuKey) return;
  lastMenuKey = key;
  refreshAppMenu();
}

function updateNavState(tab: TabState): void {
  const wc = tab.view.webContents;
  tab.canGoBack = wc.canGoBack();
  tab.canGoForward = wc.canGoForward();
  tab.url = wc.getURL();
  tab.title = wc.getTitle() || tab.title;
  if (tab.id === activeTabId) {
    notifyShell('shell:state', tabSnapshot());
    refreshAppMenuIfNeeded();
  }
}

async function guardedLoad(tab: TabState, targetUrl: string): Promise<void> {
  tab.loading = true;
  notifyShell('shell:state', tabSnapshot());

  // Allow loading our own block / blank pages without rule check
  if (
    targetUrl.startsWith('file:') &&
    (targetUrl.includes('/block/') || targetUrl.includes('/blank'))
  ) {
    await tab.view.webContents.loadURL(targetUrl);
    tab.loading = false;
    updateNavState(tab);
    return;
  }

  // Parent-approved watch request: allow same host+path again
  if (watchRequestsStore?.isApprovedUrl(targetUrl)) {
    try {
      await tab.view.webContents.loadURL(targetUrl);
    } catch {
      const blocked = buildBlockUrl(
        blockPageUrl(),
        targetUrl,
        'invalid_url',
        '页面加载失败'
      );
      await tab.view.webContents.loadURL(blocked);
    }
    tab.loading = false;
    updateNavState(tab);
    return;
  }

  const result = await canNavigate(targetUrl, rulesStore.getRaw());
  if (!result.allowed) {
    const blocked = buildBlockUrl(
      blockPageUrl(),
      targetUrl,
      result.reason || 'host_denied',
      result.message || '访问被拦截',
      result.meta
    );
    await tab.view.webContents.loadURL(blocked);
    tab.url = targetUrl;
    tab.title = '已拦截';
    tab.loading = false;
    updateNavState(tab);
    return;
  }

  try {
    await tab.view.webContents.loadURL(result.finalUrl || targetUrl);
  } catch {
    const blocked = buildBlockUrl(
      blockPageUrl(),
      targetUrl,
      'invalid_url',
      '页面加载失败'
    );
    await tab.view.webContents.loadURL(blocked);
  }
  tab.loading = false;
  updateNavState(tab);
}

function attachGuards(tab: TabState): void {
  const wc = tab.view.webContents;

  wc.setWindowOpenHandler(({ url }) => {
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
    if (url.startsWith('file:') && url.includes('/block/')) return;
    event.preventDefault();
    if (
      looksLikeDownloadUrl(url) &&
      isDownloadAllowed(url, rulesStore.getRaw())
    ) {
      downloadsManager.startFromUrl(url, wc.getURL() || '');
      return;
    }
    void guardedLoad(tab, url);
  });

  // Only cancel denied redirects. preventDefault + loadURL on allowed
  // redirects is a known Electron/Chromium crash trigger.
  wc.on('will-redirect', (event, url) => {
    if (url.startsWith('file:')) return;
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
    void wc.loadURL(
      buildBlockUrl(
        blockPageUrl(),
        url,
        'host_denied',
        '重定向目标未授权'
      )
    );
    updateNavState(tab);
  });

  wc.on('page-title-updated', (_e, title) => {
    tab.title = title;
    updateNavState(tab);
    if (isHttpUrl(tab.url)) {
      historyStore.updateLatestTitle(tab.url, title);
      notifyHistory();
    }
  });

  wc.on('did-navigate', (_e, url) => {
    updateNavState(tab);
    recordTabVisit(tab, url);
  });
  wc.on('did-navigate-in-page', (_e, url) => {
    updateNavState(tab);
    recordTabVisit(tab, url);
  });
  wc.on('found-in-page', (_e, result) => {
    if (tab.id === activeTabId) {
      notifyShell('shell:findResult', result);
    }
  });
  wc.on('did-start-loading', () => {
    tab.loading = true;
    updateNavState(tab);
  });
  wc.on('did-stop-loading', () => {
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

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: APP_NAME,
    autoHideMenuBar: !menuBarVisible,
    webPreferences: {
      preload: distPath('preload', 'browser.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  applyMenuBarVisibility();
  void mainWindow.loadURL(rendererFile('browser', 'index.html'));

  mainWindow.on('resize', () => layoutViews());
  mainWindow.on('closed', () => {
    mainWindow = null;
    tabs = [];
    activeTabId = null;
  });

  mainWindow.webContents.on('did-finish-load', () => {
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
    if (!rulesStore.hasPassword()) {
      openParentWindow(true);
    }
  });
}

function openParentWindow(forceSetup = false): void {
  if (parentWindow && !parentWindow.isDestroyed()) {
    parentWindow.focus();
    parentWindow.webContents.send('parent:meta', {
      forceSetup: forceSetup || !rulesStore.hasPassword(),
      unlocked: parentUnlocked && rulesStore.hasPassword(),
    });
    return;
  }

  parentWindow = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 720,
    minHeight: 520,
    parent: mainWindow ?? undefined,
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
  void parentWindow.loadURL(rendererFile('parent', 'index.html'));
  parentWindow.on('closed', () => {
    parentWindow = null;
    parentUnlocked = false;
  });
}

function applyMenuBarVisibility(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setAutoHideMenuBar(!menuBarVisible);
  mainWindow.setMenuBarVisibility(menuBarVisible);
}

function currentZoomFactor(): number {
  const tab = activeTab();
  return tab ? Number(tab.view.webContents.getZoomFactor() || 1) : 1;
}

function setZoomFactor(factor: number): void {
  const tab = activeTab();
  if (!tab) return;
  const next = Math.max(0.5, Math.min(3, Math.round(factor * 100) / 100));
  tab.view.webContents.setZoomFactor(next);
  notifyShell('shell:state', tabSnapshot());
  refreshAppMenu();
}

function zoomBy(delta: number): void {
  setZoomFactor(currentZoomFactor() + delta);
}

function findInActiveTab(text: string, forward = true, findNext = true): void {
  const tab = activeTab();
  if (!tab) return;
  const query = String(text || '');
  if (!query) {
    tab.view.webContents.stopFindInPage('clearSelection');
    notifyShell('shell:findResult', null);
    return;
  }
  tab.view.webContents.findInPage(query, { forward, findNext });
}

function openUpdateWindow(): void {
  if (updateWindow && !updateWindow.isDestroyed()) {
    updateWindow.focus();
    return;
  }
  updateWindow = new BrowserWindow({
    width: 440,
    height: 380,
    minWidth: 400,
    minHeight: 340,
    parent: mainWindow ?? undefined,
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
  passwordsWindow = new BrowserWindow({
    width: 640,
    height: 520,
    minWidth: 480,
    minHeight: 360,
    parent: mainWindow ?? undefined,
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
  void passwordsWindow.loadURL(rendererFile('passwords', 'index.html'));
  passwordsWindow.on('closed', () => {
    passwordsWindow = null;
  });
}

function openHistoryWindow(): void {
  if (historyWindow && !historyWindow.isDestroyed()) {
    historyWindow.focus();
    historyWindow.webContents.send('history:changed', {
      entries: historyStore.list(),
      count: historyStore.count(),
    });
    return;
  }

  historyWindow = new BrowserWindow({
    width: 860,
    height: 640,
    minWidth: 640,
    minHeight: 420,
    parent: mainWindow ?? undefined,
    modal: false,
    title: `${APP_NAME} · 历史记录`,
    webPreferences: {
      preload: distPath('preload', 'history.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  historyWindow.setMenuBarVisibility(false);
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

  downloadsWindow = new BrowserWindow({
    width: 860,
    height: 640,
    minWidth: 640,
    minHeight: 420,
    parent: mainWindow ?? undefined,
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
      label: `缩放（${zoom}%）`,
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
      label: rulesStore.hasPassword() ? '家长设置' : '家长设置（尚未完成）',
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
      label: '菜单栏',
      type: 'checkbox',
      checked: menuBarVisible,
      click: () => {
        menuBarVisible = !menuBarVisible;
        saveChromePrefs();
        applyMenuBarVisibility();
        notifyShell('shell:state', tabSnapshot());
        refreshAppMenu();
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
    x: Math.round(x),
    y: Math.round(y),
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
        {
          label: '菜单栏',
          type: 'checkbox',
          checked: menuBarVisible,
          click: () => {
            menuBarVisible = !menuBarVisible;
            saveChromePrefs();
            applyMenuBarVisibility();
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
        {
          label: '重新载入',
          accelerator: 'CmdOrCtrl+R',
          click: () => tab?.view.webContents.reload(),
        },
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
        {
          label: '后退',
          accelerator: 'Alt+Left',
          enabled: Boolean(tab?.canGoBack),
          click: () => {
            if (tab?.view.webContents.canGoBack()) tab.view.webContents.goBack();
          },
        },
        {
          label: '前进',
          accelerator: 'Alt+Right',
          enabled: Boolean(tab?.canGoForward),
          click: () => {
            if (tab?.view.webContents.canGoForward()) tab.view.webContents.goForward();
          },
        },
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
  const options = {
    type: 'info' as const,
    title: `关于 ${APP_NAME}`,
    message: APP_NAME,
    detail: `版本 ${app.getVersion()}\n面向家庭的青少年浏览器。\n访问由家长配置组控制；历史记录仅家长可删除。`,
    buttons: ['确定'],
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    void dialog.showMessageBox(mainWindow, options);
  } else {
    void dialog.showMessageBox(options);
  }
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

  bookmarksWindow = new BrowserWindow({
    width: 920,
    height: 620,
    minWidth: 720,
    minHeight: 480,
    parent: mainWindow ?? undefined,
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
    x: Math.round(x),
    y: Math.round(y),
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
    const tab = tabs.find((t) => t.id === activeTabId);
    if (tab?.view.webContents.canGoBack()) tab.view.webContents.goBack();
  });

  ipcMain.handle('shell:goForward', () => {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (tab?.view.webContents.canGoForward()) tab.view.webContents.goForward();
  });

  ipcMain.handle('shell:reload', () => {
    const tab = tabs.find((t) => t.id === activeTabId);
    tab?.view.webContents.reload();
  });

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

  ipcMain.handle('shell:toggleBookmarksBar', () => {
    bookmarksBarVisible = !bookmarksBarVisible;
    saveChromePrefs();
    layoutViews();
    notifyShell('shell:state', tabSnapshot());
    refreshAppMenu();
    return { ok: true, visible: bookmarksBarVisible };
  });

  ipcMain.handle('shell:toggleMenuBar', () => {
    menuBarVisible = !menuBarVisible;
    saveChromePrefs();
    applyMenuBarVisibility();
    notifyShell('shell:state', tabSnapshot());
    refreshAppMenu();
    return { ok: true, visible: menuBarVisible };
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

  ipcMain.handle('history:open', async (_e, id: string) => {
    const entry = historyStore.get(id);
    if (!entry) return { ok: false, error: '记录不存在' };
    const tab = activeTab();
    if (tab) await guardedLoad(tab, entry.url);
    else createTab(entry.url);
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
    if (result.ok) notifyHistory();
    return result;
  });

  ipcMain.handle('history:clear', (_e, password?: string) => {
    const auth = authorizeHistoryDelete(password);
    if (!auth.ok) return auth;
    const result = historyStore.clear();
    notifyHistory();
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
  ipcMain.handle('bookmarks:appVersion', () => app.getVersion());
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
    forceSetup: !rulesStore.hasPassword(),
    unlocked: parentUnlocked && rulesStore.hasPassword(),
    rules: parentUnlocked ? rulesStore.getPublic() : null,
  }));

  ipcMain.handle('parent:setupPassword', (_e, password: string) => {
    if (rulesStore.hasPassword()) {
      return { ok: false, error: '密码已设置，请使用验证登录' };
    }
    const result = rulesStore.setPassword(password);
    if (result.ok) parentUnlocked = true;
    return result;
  });

  ipcMain.handle('parent:unlock', (_e, password: string) => {
    if (!rulesStore.verify(password)) {
      return { ok: false, error: '密码错误' };
    }
    parentUnlocked = true;
    return { ok: true, rules: rulesStore.getPublic() };
  });

  ipcMain.handle('parent:changePassword', (_e, current: string, next: string) => {
    if (!parentUnlocked) return { ok: false, error: '未解锁' };
    return rulesStore.changePassword(current, next);
  });

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
      input: { username: string; password: string; serverUrl?: string }
    ) => {
      try {
        return await syncClient.register(
          input.username,
          input.password,
          input.serverUrl
        );
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
        return await syncClient.login(
          input.username,
          input.password,
          input.serverUrl
        );
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : '登录失败',
        };
      }
    }
  );

  ipcMain.handle('account:logout', async () => {
    await syncClient.logout();
    return { ok: true, account: accountStore.getPublic() };
  });

  ipcMain.handle('account:push', async () => {
    if (!parentUnlocked) {
      return { ok: false, error: '上传访问配置需要先输入家长密码解锁' };
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
  loadChromePrefs();
  refreshAppMenu();
  registerIpc();

  // Block permission prompts that could be abused
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => {
    cb(false);
  });

  createMainWindow();
  startAutoUpdater(() => mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
