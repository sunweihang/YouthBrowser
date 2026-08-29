/**
 * Upload Windows update artifacts to the Aliyun download mirror.
 *
 * Env:
 *   JIANXING_SSH_HOST     default 182.92.120.159
 *   JIANXING_SSH_USER     default lijin
 *   JIANXING_SSH_PASSWORD required (or pass as argv --password=)
 *
 * Uploads: JianXingBrowser-Setup-*.exe, *.blockmap, latest.yml
 * to /home/lijin/jianxing-browser/downloads and /var/www/jianliao/downloads/jianxing
 */
import { createRequire } from 'module';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { Client } = require('ssh2');

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const releaseDir = join(root, 'release');

const host = process.env.JIANXING_SSH_HOST || '182.92.120.159';
const username = process.env.JIANXING_SSH_USER || 'lijin';
const password =
  process.env.JIANXING_SSH_PASSWORD ||
  process.argv.find((a) => a.startsWith('--password='))?.slice('--password='.length) ||
  '';

const remoteHome = '/home/lijin/jianxing-browser/downloads';
const remoteWeb = '/var/www/jianliao/downloads/jianxing';

function pickArtifacts() {
  const files = readdirSync(releaseDir);
  const ymlName = files.find((f) => f === 'latest.yml');
  if (!ymlName) {
    throw new Error(`Missing latest.yml in ${releaseDir}. Run: npm run dist`);
  }
  const ymlPath = join(releaseDir, ymlName);
  const ymlText = readFileSync(ymlPath, 'utf8');
  const pathMatch = ymlText.match(/^path:\s*(.+)\s*$/m);
  const exeName = pathMatch ? pathMatch[1].trim() : '';
  if (!exeName || !existsSync(join(releaseDir, exeName))) {
    throw new Error(
      `latest.yml path "${exeName}" not found in ${releaseDir}`
    );
  }
  const blockmapName = files.find((f) => f === `${exeName}.blockmap`) || null;
  return {
    yml: ymlPath,
    exe: join(releaseDir, exeName),
    blockmap: blockmapName ? join(releaseDir, blockmapName) : null,
    exeName,
    ymlName,
    blockmapName,
  };
}

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
        if (code !== 0) {
          reject(new Error(errOut || out || `exit ${code}: ${cmd}`));
        } else {
          resolve(out);
        }
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
  const arts = pickArtifacts();
  console.log('Artifacts:', {
    exe: arts.exeName,
    size: statSync(arts.exe).size,
    yml: arts.ymlName,
    blockmap: arts.blockmapName,
  });
  console.log('latest.yml preview:\n' + readFileSync(arts.yml, 'utf8'));

  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn
      .on('ready', resolve)
      .on('error', reject)
      .connect({ host, port: 22, username, password, readyTimeout: 30000 });
  });

  try {
    await exec(conn, `mkdir -p "${remoteHome}"`);
    await upload(conn, arts.exe, `${remoteHome}/${arts.exeName}`);
    await upload(conn, arts.yml, `${remoteHome}/${arts.ymlName}`);
    if (arts.blockmap && arts.blockmapName) {
      await upload(conn, arts.blockmap, `${remoteHome}/${arts.blockmapName}`);
    }

    const copies = [
      `sudo cp -f "${remoteHome}/${arts.exeName}" "${remoteWeb}/"`,
      `sudo cp -f "${remoteHome}/${arts.ymlName}" "${remoteWeb}/"`,
    ];
    if (arts.blockmapName) {
      copies.push(
        `sudo cp -f "${remoteHome}/${arts.blockmapName}" "${remoteWeb}/"`
      );
    }
    await exec(
      conn,
      `sudo mkdir -p "${remoteWeb}" && ${copies.join(' && ')} && sudo chmod -R a+rX "${remoteWeb}" && ls -lah "${remoteWeb}"`
    );

    console.log('Published.');
    console.log(`Feed: http://${host}/downloads/jianxing/latest.yml`);
    console.log(`Installer: http://${host}/downloads/jianxing/${arts.exeName}`);
  } finally {
    conn.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
