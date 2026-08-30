import { app, shell } from 'electron';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { pathToFileURL } from 'url';

const execFileAsync = promisify(execFile);

const CLIENT_ID = 'SimplyGo';
const PROGID = 'SimplyGoHTML';
const APP_LABEL = '简行浏览器';

export function extractLaunchUrl(argv: string[]): string | null {
  const exe = (process.execPath || '').toLowerCase();
  for (const raw of argv) {
    if (!raw || raw.startsWith('--')) continue;
    const arg = raw.replace(/^["']|["']$/g, '').trim();
    if (!arg) continue;
    if (arg.toLowerCase() === exe) continue;
    if (/^https?:\/\//i.test(arg)) return arg;
    if (/^file:\/\//i.test(arg)) return arg;
    if (/^[a-zA-Z]:[\\/]/.test(arg) && /\.(xhtml|html?)$/i.test(arg)) {
      try {
        return pathToFileURL(arg).href;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export async function openDefaultBrowserSettings(): Promise<void> {
  if (process.platform === 'win32') {
    try {
      await shell.openExternal('ms-settings:default-browser');
    } catch {
      await shell.openExternal('ms-settings:defaultapps');
    }
    return;
  }
  if (process.platform === 'darwin') {
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.general'
    );
    return;
  }
  await shell.openExternal('https://');
}

export async function registerAsDefaultBrowser(): Promise<{
  ok: boolean;
  error?: string;
}> {
  try {
    if (process.platform === 'win32') {
      await registerWindowsBrowser();
    } else {
      try {
        app.setAsDefaultProtocolClient('http');
        app.setAsDefaultProtocolClient('https');
      } catch {
        // Modern OS may ignore http/https; settings UI is the real path.
      }
    }
    await openDefaultBrowserSettings();
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : '无法打开默认浏览器设置',
    };
  }
}

async function regAdd(
  key: string,
  value: string | null,
  data: string
): Promise<void> {
  const args = ['add', key, '/f'];
  if (value === null) args.push('/ve');
  else args.push('/v', value);
  args.push('/d', data);
  await execFileAsync('reg', args, { windowsHide: true });
}

async function registerWindowsBrowser(): Promise<void> {
  const exe = process.execPath;
  const icon = `${exe},0`;
  const command = `"${exe}" "%1"`;
  const capKey = `HKCU\\Software\\Clients\\StartMenuInternet\\${CLIENT_ID}\\Capabilities`;

  await regAdd(
    `HKCU\\Software\\Clients\\StartMenuInternet\\${CLIENT_ID}`,
    null,
    APP_LABEL
  );
  await regAdd(
    `HKCU\\Software\\Clients\\StartMenuInternet\\${CLIENT_ID}\\DefaultIcon`,
    null,
    icon
  );
  await regAdd(
    `HKCU\\Software\\Clients\\StartMenuInternet\\${CLIENT_ID}\\shell\\open\\command`,
    null,
    `"${exe}"`
  );
  await regAdd(capKey, 'ApplicationName', APP_LABEL);
  await regAdd(
    capKey,
    'ApplicationDescription',
    '面向家庭的青少年浏览器'
  );
  await regAdd(capKey, 'ApplicationIcon', icon);
  await regAdd(`${capKey}\\URLAssociations`, 'http', PROGID);
  await regAdd(`${capKey}\\URLAssociations`, 'https', PROGID);
  await regAdd(`${capKey}\\FileAssociations`, '.htm', PROGID);
  await regAdd(`${capKey}\\FileAssociations`, '.html', PROGID);
  await regAdd(
    'HKCU\\Software\\RegisteredApplications',
    CLIENT_ID,
    `Software\\Clients\\StartMenuInternet\\${CLIENT_ID}\\Capabilities`
  );

  await regAdd(`HKCU\\Software\\Classes\\${PROGID}`, null, `${APP_LABEL} 文档`);
  await regAdd(`HKCU\\Software\\Classes\\${PROGID}`, 'URL Protocol', '');
  await regAdd(`HKCU\\Software\\Classes\\${PROGID}\\DefaultIcon`, null, icon);
  await regAdd(
    `HKCU\\Software\\Classes\\${PROGID}\\Application`,
    'ApplicationName',
    APP_LABEL
  );
  await regAdd(
    `HKCU\\Software\\Classes\\${PROGID}\\shell\\open\\command`,
    null,
    command
  );

  try {
    app.setAsDefaultProtocolClient('http');
    app.setAsDefaultProtocolClient('https');
  } catch {
    // Windows 10+ ignores programmatic http/https default.
  }
}
