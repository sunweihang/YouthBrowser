/**
 * Upload only the public download page + screenshots.
 * Env: JIANXING_SSH_PASSWORD
 */
import { createRequire } from 'module';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { Client } = require('ssh2');

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const pageDir = join(root, 'server', 'download-page');
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
  const pageHtml = join(pageDir, 'index.html');
  const icon = join(pageDir, 'app-icon.png');
  const assetsDir = join(pageDir, 'assets');
  if (!existsSync(pageHtml)) throw new Error('missing index.html');

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
    await exec(conn, `mkdir -p "${remoteHome}/assets"`);
    await upload(conn, pageHtml, `${remoteHome}/index.html`);
    if (existsSync(icon)) {
      await upload(conn, icon, `${remoteHome}/app-icon.png`);
    }
    if (existsSync(assetsDir)) {
      for (const name of readdirSync(assetsDir)) {
        if (!name.toLowerCase().endsWith('.png')) continue;
        await upload(conn, join(assetsDir, name), `${remoteHome}/assets/${name}`);
      }
    }
    await exec(
      conn,
      [
        `sudo mkdir -p "${remoteWeb}/assets"`,
        `sudo cp -f "${remoteHome}/index.html" "${remoteWeb}/"`,
        `sudo cp -f "${remoteHome}/app-icon.png" "${remoteWeb}/" || true`,
        `sudo cp -f "${remoteHome}/assets/"*.png "${remoteWeb}/assets/" || true`,
        `sudo chmod -R a+rX "${remoteWeb}"`,
      ].join(' && ')
    );
    console.log('Published page: https://spacedreams.cn/simplygo/');
  } finally {
    conn.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
