/**
 * Upload sync server files and restart the process on the update host.
 * Env: JIANXING_SSH_HOST / JIANXING_SSH_USER / JIANXING_SSH_PASSWORD
 */
import { createRequire } from 'module';
import { existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { Client } = require('ssh2');

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const serverDir = join(root, 'server');
const uploadFiles = [
  'sync-server.js',
  'mail.js',
  'password-reset.js',
  'mail.example.json',
  'admin-set-email.js',
];
const host = process.env.JIANXING_SSH_HOST || '182.92.120.159';
const username = process.env.JIANXING_SSH_USER || 'lijin';
const password =
  process.env.JIANXING_SSH_PASSWORD ||
  process.argv.find((a) => a.startsWith('--password='))?.slice('--password='.length) ||
  '';

const remoteRoot = '/home/lijin/jianxing-browser';
const dataDir = `${remoteRoot}/sync-data`;

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
    console.error('Set JIANXING_SSH_PASSWORD or pass --password=...');
    process.exit(1);
  }
  for (const name of uploadFiles) {
    const local = join(serverDir, name);
    if (!existsSync(local)) throw new Error(`Missing ${local}`);
  }

  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn
      .on('ready', resolve)
      .on('error', reject)
      .connect({ host, port: 22, username, password, readyTimeout: 30000 });
  });

  try {
    await exec(conn, `mkdir -p "${remoteRoot}" "${dataDir}"`);
    for (const name of uploadFiles) {
      await upload(conn, join(serverDir, name), `${remoteRoot}/${name}`);
    }
    await exec(
      conn,
      `set -e
if [ ! -f "${dataDir}/mail.json" ]; then
  if [ -f /var/www/simple/data/mail.json ]; then
    cp /var/www/simple/data/mail.json "${dataDir}/mail.json"
    echo "copied mail.json from simple-im"
  else
    cp "${remoteRoot}/mail.example.json" "${dataDir}/mail.json"
    echo "seeded mail.example.json (please fill SMTP)"
  fi
  chmod 600 "${dataDir}/mail.json" || true
fi`
    );

    const restart = `
set -e
cd "${remoteRoot}"
if systemctl --user is-active --quiet jianxing-sync 2>/dev/null; then
  systemctl --user restart jianxing-sync
  echo "restarted systemd user unit jianxing-sync"
elif sudo -n systemctl is-active --quiet jianxing-sync 2>/dev/null; then
  sudo -n systemctl restart jianxing-sync
  echo "restarted systemd unit jianxing-sync"
else
  pids=$(pgrep -f "${remoteRoot}/sync-server.js" || true)
  if [ -n "$pids" ]; then
    echo "stopping $pids"
    kill $pids || true
    sleep 1
    kill -9 $pids 2>/dev/null || true
  fi
  nohup env PORT=3910 DATA_DIR="${dataDir}" node "${remoteRoot}/sync-server.js" >> "${remoteRoot}/sync-server.log" 2>&1 &
  echo "started pid $!"
fi
sleep 1
curl -sS http://127.0.0.1:3910/health || curl -sS http://127.0.0.1:3910/simplygo-api/health || true
echo
`;
    const out = await exec(conn, restart);
    console.log(out.trim());
    console.log('Sync server deployed.');
  } finally {
    conn.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
