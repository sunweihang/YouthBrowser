import { app, dialog, BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';

const UPDATE_FEED =
  process.env.JIANXING_UPDATE_URL ||
  'http://182.92.120.159/downloads/jianxing/';

let checking = false;
let downloaded = false;

export function startAutoUpdater(getMainWindow: () => BrowserWindow | null): void {
  if (!app.isPackaged) {
    console.log('[update] skip in unpackaged mode');
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // App is not code-signed; allow updates without publisher check.
  autoUpdater.verifyUpdateCodeSignature = false;
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: UPDATE_FEED,
  });

  autoUpdater.on('checking-for-update', () => {
    console.log('[update] checking…');
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[update] available', info.version);
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      void dialog.showMessageBox(win, {
        type: 'info',
        title: '发现新版本',
        message: `简行浏览器 ${info.version} 可更新`,
        detail: '正在后台下载，下载完成后会提示安装。',
        buttons: ['知道了'],
      });
    }
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[update] up to date', app.getVersion());
  });

  autoUpdater.on('error', (err) => {
    console.error('[update] error', err);
    checking = false;
  });

  autoUpdater.on('download-progress', (p) => {
    console.log(
      `[update] download ${p.percent.toFixed(1)}% (${Math.round(p.transferred / 1024 / 1024)}MB)`
    );
  });

  autoUpdater.on('update-downloaded', async (info) => {
    downloaded = true;
    checking = false;
    console.log('[update] downloaded', info.version);
    const win = getMainWindow();
    const result = await dialog.showMessageBox(win ?? undefined, {
      type: 'info',
      title: '更新已就绪',
      message: `新版本 ${info.version} 已下载完成`,
      detail: '点击「立即安装」将重启并完成更新。',
      buttons: ['立即安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
    });
    if (result.response === 0) {
      autoUpdater.quitAndInstall(false, true);
    }
  });

  const runCheck = () => {
    if (checking || downloaded) return;
    checking = true;
    void autoUpdater.checkForUpdates().catch((err) => {
      console.error('[update] check failed', err);
      checking = false;
    });
  };

  // First check shortly after launch, then every 6 hours.
  setTimeout(runCheck, 8_000);
  setInterval(runCheck, 6 * 60 * 60 * 1000);
}
