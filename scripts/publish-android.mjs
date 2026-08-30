/**
 * Upload the signed Android APK and refresh the public download page.
 * Env: JIANXING_SSH_PASSWORD
 */
import { createRequire } from 'module';
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { Client } = require('ssh2');

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const pageDir = join(root, 'server', 'download-page');
const apkSrc = join(root, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const apkName = `JianXingBrowser-${version}.apk`;

const host = process.env.JIANXING_SSH_HOST || '182.92.120.159';
const username = process.env.JIANXING_SSH_USER || 'lijin';
const password =
  process.env.JIANXING_SSH_PASSWORD ||
  process.argv.find((a) => a.startsWith('--password='))?.slice('--password='.length) ||
  '';

const remoteHome = '/home/lijin/jianxing-browser/downloads';
const remoteWeb = '/var/www/jianliao/simplygo';

function exec(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      let errOut = '';
      stream.on('data', (d) => {
        out += d.toString();
      });
      stream.stderr.on('data', (d) => {
        errOut += d.toString();
      });
      stream.on('close', (code) => {
        if (code !== 0) reject(new Error(errOut || out || `exit ${code}: ${cmd}`));
        else resolve(out);
      });
    });
  });
}

function upload(conn, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      console.log(`Upload ${localPath} → ${remotePath}`);
      sftp.fastPut(localPath, remotePath, (e) => {
        if (e) reject(e);
        else resolve();
      });
    });
  });
}

async function main() {
  if (!password) {
    console.error('Set JIANXING_SSH_PASSWORD');
    process.exit(1);
  }
  if (!existsSync(apkSrc)) {
    throw new Error(`Missing release APK: ${apkSrc}. Run: cd android && gradlew assembleRelease`);
  }
  const pageHtml = join(pageDir, 'index.html');
  if (!existsSync(pageHtml)) throw new Error('missing index.html');

  const size = statSync(apkSrc).size;
  const localApk = join(tmpdir(), apkName);
  copyFileSync(apkSrc, localApk);
  const yml = `version: ${version}\npath: ${apkName}\nfiles:\n  - url: ${apkName}\n    size: ${size}\n`;
  const localYml = join(tmpdir(), 'latest-android.yml');
  writeFileSync(localYml, yml, 'utf8');

  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn.on('ready', resolve).on('error', reject).connect({
      host,
      port: 22,
      username,
      password,
      readyTimeout: 30000,
    });
  });

  try {
    await exec(conn, `mkdir -p "${remoteHome}"`);
    await upload(conn, localApk, `${remoteHome}/${apkName}`);
    await upload(conn, localYml, `${remoteHome}/latest-android.yml`);
    await upload(conn, pageHtml, `${remoteHome}/index.html`);

    const listing = await exec(
      conn,
      `python3 - <<'PY'
import json, os, time
root = ${JSON.stringify(remoteWeb)}
path = os.path.join(root, "versions.json")
data = {}
if os.path.isfile(path):
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
print(json.dumps(data, ensure_ascii=False))
PY`
    );
    let versions = {};
    try {
      versions = JSON.parse(listing.trim() || '{}');
    } catch {
      versions = {};
    }
    versions.android = {
      version,
      file: apkName,
      size,
      channel: 'Android',
      releasedAt: new Date().toISOString(),
      mtime: new Date().toISOString(),
    };
    versions.generatedAt = new Date().toISOString();
    const localVersions = join(tmpdir(), 'simplygo-versions.json');
    writeFileSync(localVersions, JSON.stringify(versions, null, 2), 'utf8');
    await upload(conn, localVersions, `${remoteHome}/versions.json`);

    await exec(
      conn,
      [
        `sudo mkdir -p "${remoteWeb}"`,
        `sudo cp -f "${remoteHome}/${apkName}" "${remoteWeb}/"`,
        `sudo cp -f "${remoteHome}/latest-android.yml" "${remoteWeb}/"`,
        `sudo cp -f "${remoteHome}/index.html" "${remoteWeb}/"`,
        `sudo cp -f "${remoteHome}/versions.json" "${remoteWeb}/"`,
        `sudo chmod -R a+rX "${remoteWeb}"`,
        `ls -lah "${remoteWeb}/${apkName}" "${remoteWeb}/latest-android.yml"`,
      ].join(' && ')
    );
    console.log('Published Android APK.');
    console.log(`Download: https://spacedreams.cn/simplygo/${apkName}`);
    console.log('Page: https://spacedreams.cn/simplygo/');
  } finally {
    conn.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
