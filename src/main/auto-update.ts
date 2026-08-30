import { app, BrowserWindow, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';

const UPDATE_FEED =
  process.env.JIANXING_UPDATE_URL ||
  'https://spacedreams.cn/simplygo/';

export type UpdateUiStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'uptodate'
  | 'error';

export type UpdateState = {
  currentVersion: string;
  latestVersion: string | null;
  status: UpdateUiStatus;
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
  message: string;
  error: string | null;
  unpackaged: boolean;
};

let getMainWindow: () => BrowserWindow | null = () => null;
let checking = false;
let downloaded = false;
let started = false;

const state: UpdateState = {
  currentVersion: app.getVersion(),
  latestVersion: null,
  status: 'idle',
  percent: 0,
  transferred: 0,
  total: 0,
  bytesPerSecond: 0,
  message: '',
  error: null,
  unpackaged: !app.isPackaged,
};

function broadcast(): void {
  const payload = { ...state };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('update:status', payload);
    }
  }
}

function setState(patch: Partial<UpdateState>): void {
  Object.assign(state, patch);
  broadcast();
}

export function getUpdateState(): UpdateState {
  return { ...state };
}

export async function checkForAppUpdates(manual = false): Promise<UpdateState> {
  if (!app.isPackaged) {
    setState({
      unpackaged: true,
      status: 'uptodate',
      message: '开发模式不检查更新',
      error: null,
    });
    return getUpdateState();
  }

  if (downloaded) {
    setState({
      status: 'ready',
      percent: 100,
      message: state.latestVersion
        ? `新版本 ${state.latestVersion} 已下载，可立即安装`
        : '更新已下载，可立即安装',
    });
    return getUpdateState();
  }

  // Allow manual re-check even if a previous check hung.
  if (checking && !manual) {
    return getUpdateState();
  }
  if (state.status === 'downloading' && !manual) {
    return getUpdateState();
  }

  checking = true;
  setState({
    status: 'checking',
    message: manual ? '正在检查更新…' : '正在检查更新…',
    error: null,
  });

  try {
    const result = await autoUpdater.checkForUpdates();
    // If nothing available, update-not-available may have already run.
    if (!result && state.status === 'checking') {
      checking = false;
      setState({
        status: 'uptodate',
        message: '当前已是最新版本',
      });
    }
  } catch (err) {
    checking = false;
    setState({
      status: 'error',
      error: err instanceof Error ? err.message : '检查更新失败',
      message: '检查更新失败',
    });
  }

  return getUpdateState();
}

export function installAppUpdate(): { ok: boolean; error?: string } {
  if (!downloaded) {
    return { ok: false, error: '更新尚未下载完成' };
  }
  try {
    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : '安装失败',
    };
  }
}

export function registerUpdateIpc(): void {
  ipcMain.handle('update:getStatus', () => getUpdateState());
  ipcMain.handle('update:check', () => checkForAppUpdates(true));
  ipcMain.handle('update:install', () => installAppUpdate());
}

export function startAutoUpdater(
  getWin: () => BrowserWindow | null
): void {
  getMainWindow = getWin;
  state.currentVersion = app.getVersion();
  state.unpackaged = !app.isPackaged;

  if (started) return;
  started = true;

  if (!app.isPackaged) {
    setState({
      unpackaged: true,
      status: 'idle',
      message: '开发模式',
    });
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // App is not code-signed; allow updates without publisher check.
  autoUpdater.verifyUpdateCodeSignature = false;
  // Server only keeps the latest full installer; delta updates often stall/fail.
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: UPDATE_FEED,
  });

  autoUpdater.on('checking-for-update', () => {
    setState({
      status: 'checking',
      message: '正在检查更新…',
      error: null,
    });
  });

  autoUpdater.on('update-available', (info) => {
    // Download has been (or will be) started by autoDownload.
    checking = false;
    setState({
      status: 'available',
      latestVersion: info.version,
      message: `发现新版本 ${info.version}，开始下载…`,
      error: null,
      percent: 0,
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    checking = false;
    setState({
      status: 'uptodate',
      latestVersion: info?.version || app.getVersion(),
      message: '当前已是最新版本',
      error: null,
      percent: 0,
    });
  });

  autoUpdater.on('error', (err) => {
    checking = false;
    const msg = err?.message || String(err);
    console.error('[update] error', err);
    setState({
      status: 'error',
      error: msg,
      message: '更新出错',
    });
  });

  autoUpdater.on('download-progress', (p) => {
    checking = false;
    setState({
      status: 'downloading',
      percent: Number(p.percent) || 0,
      transferred: Number(p.transferred) || 0,
      total: Number(p.total) || 0,
      bytesPerSecond: Number(p.bytesPerSecond) || 0,
      message: `正在下载 ${p.percent.toFixed(1)}%`,
      error: null,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    downloaded = true;
    checking = false;
    setState({
      status: 'ready',
      latestVersion: info.version,
      percent: 100,
      message: `新版本 ${info.version} 已就绪，可立即安装`,
      error: null,
    });
  });

  setTimeout(() => {
    void checkForAppUpdates(false);
  }, 8_000);
  setInterval(() => {
    void checkForAppUpdates(false);
  }, 6 * 60 * 60 * 1000);
}
