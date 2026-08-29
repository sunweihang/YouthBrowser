import {
  app,
  BrowserView,
  BrowserWindow,
  ipcMain,
  Menu,
  session,
} from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { BookmarksStore } from './bookmarks-store';
import { AccountStore } from './account-store';
import { groupsPayloadEqual, SyncClient } from './sync-client';
import { startAutoUpdater } from './auto-update';
import {
  buildBlockUrl,
  canNavigate,
} from './navigation-guard';
import { extractMidFromInput, RulesStore } from './rules-store';

/** tabs(40) + toolbar(48) + bookmarks(36) */
const TOOLBAR_HEIGHT = 124;

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
let rulesStore: RulesStore;
let bookmarksStore: BookmarksStore;
let accountStore: AccountStore;
let syncClient: SyncClient;
let tabs: TabState[] = [];
let activeTabId: string | null = null;
let parentUnlocked = false;

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
  };
}

function layoutViews(): void {
  if (!mainWindow) return;
  const [width, height] = mainWindow.getContentSize();
  for (const tab of tabs) {
    const bounds = {
      x: 0,
      y: TOOLBAR_HEIGHT,
      width,
      height: Math.max(0, height - TOOLBAR_HEIGHT),
    };
    tab.view.setBounds(bounds);
    tab.view.setAutoResize({ width: true, height: true });
  }
}

function updateNavState(tab: TabState): void {
  const wc = tab.view.webContents;
  tab.canGoBack = wc.canGoBack();
  tab.canGoForward = wc.canGoForward();
  tab.url = wc.getURL();
  tab.title = wc.getTitle() || tab.title;
  if (tab.id === activeTabId) {
    notifyShell('shell:state', tabSnapshot());
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

  const result = await canNavigate(targetUrl, rulesStore.getRaw());
  if (!result.allowed) {
    const blocked = buildBlockUrl(
      blockPageUrl(),
      targetUrl,
      result.reason || 'host_denied',
      result.message || '访问被拦截'
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
    void guardedLoad(tab, url);
    return { action: 'deny' };
  });

  wc.on('will-navigate', (event, url) => {
    if (url.startsWith('file:') && url.includes('/block/')) return;
    event.preventDefault();
    void guardedLoad(tab, url);
  });

  wc.on('will-redirect', (event, url) => {
    if (url.startsWith('file:')) return;
    // Synchronous prevent — async check then load
    event.preventDefault();
    void (async () => {
      const result = await canNavigate(url, rulesStore.getRaw());
      if (result.allowed) {
        await wc.loadURL(result.finalUrl || url);
      } else {
        await wc.loadURL(
          buildBlockUrl(
            blockPageUrl(),
            url,
            result.reason || 'host_denied',
            result.message || '重定向被拦截'
          )
        );
      }
      updateNavState(tab);
    })();
  });

  wc.on('page-title-updated', (_e, title) => {
    tab.title = title;
    updateNavState(tab);
  });

  wc.on('did-navigate', () => updateNavState(tab));
  wc.on('did-navigate-in-page', () => updateNavState(tab));
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
    const welcome = buildBlockUrl(
      blockPageUrl(),
      '(未打开页面)',
      'host_denied',
      '请在地址栏输入已授权的网址。B 站仅可打开白名单 UP 的视频或空间。'
    );
    void tab.view.webContents.loadURL(welcome);
    tab.title = '开始';
    tab.url = '';
  }

  notifyShell('shell:state', tabSnapshot());
  return tab;
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
    webPreferences: {
      preload: distPath('preload', 'browser.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  void mainWindow.loadURL(rendererFile('browser', 'index.html'));

  mainWindow.on('resize', () => layoutViews());
  mainWindow.on('closed', () => {
    mainWindow = null;
    tabs = [];
    activeTabId = null;
  });

  mainWindow.webContents.on('did-finish-load', () => {
    if (tabs.length === 0) createTab();
    else {
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

  ipcMain.handle('account:get', () => {
    if (!parentUnlocked) return null;
    return accountStore.getPublic();
  });

  ipcMain.handle('account:syncStatus', async () => {
    if (!parentUnlocked) return { ok: false, error: '未解锁' };
    if (!accountStore.isLoggedIn()) {
      return { ok: false, error: '请先登录账号' };
    }
    const account = accountStore.getPublic();
    const localRevision = account.lastRevision || 0;
    const localGroups = rulesStore.exportGroups();
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
  });

  ipcMain.handle(
    'account:register',
    async (
      _e,
      input: { username: string; password: string; serverUrl?: string }
    ) => {
      if (!parentUnlocked) return { ok: false, error: '未解锁' };
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
      if (!parentUnlocked) return { ok: false, error: '未解锁' };
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
    if (!parentUnlocked) return { ok: false, error: '未解锁' };
    await syncClient.logout();
    return { ok: true, account: accountStore.getPublic() };
  });

  ipcMain.handle('account:push', async () => {
    if (!parentUnlocked) return { ok: false, error: '未解锁' };
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
    if (!parentUnlocked) return { ok: false, error: '未解锁' };
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
  rulesStore = new RulesStore();
  bookmarksStore = new BookmarksStore();
  accountStore = new AccountStore();
  syncClient = new SyncClient(accountStore);
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
