/**
 * Upload Windows update artifacts + refresh the public download page.
 *
 * Env:
 *   JIANXING_SSH_HOST / JIANXING_SSH_USER / JIANXING_SSH_PASSWORD
 */
import { createRequire } from 'module';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const require = createRequire(import.meta.url);
const { Client } = require('ssh2');

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const releaseDir = join(root, 'release');
const pageDir = join(root, 'server', 'download-page');

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
    throw new Error(`latest.yml path "${exeName}" not found in ${releaseDir}`);
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

function cmpVer(a, b) {
  const pa = String(a || '0').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').split('.').map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da - db;
  }
  return 0;
}

/** Build versions.json from remote listing stdout (ls -la style via python). */
function buildVersionsJson(remoteListingJson, latestVersion) {
  const files = JSON.parse(remoteListingJson);
  const byVer = new Map();
  for (const f of files) {
    const m = String(f.name || '').match(
      /^JianXingBrowser-Setup-(\d+\.\d+\.\d+)\.exe$/i
    );
    if (!m) continue;
    byVer.set(m[1], {
      version: m[1],
      file: f.name,
      size: Number(f.size) || 0,
      mtime: f.mtime || null,
      releasedAt: f.mtime || null,
      channel: 'Windows x64',
    });
  }
  const versions = [...byVer.values()].sort((a, b) =>
    cmpVer(b.version, a.version)
  );
  const latest =
    latestVersion && byVer.has(latestVersion)
      ? latestVersion
      : versions[0]?.version || null;
  return {
    generatedAt: new Date().toISOString(),
    latest,
    versions,
  };
}

async function main() {
  if (!password) {
    console.error('Set JIANXING_SSH_PASSWORD or pass --password=...');
    process.exit(1);
  }
  const arts = pickArtifacts();
  const ymlText = readFileSync(arts.yml, 'utf8');
  const verMatch = ymlText.match(/^version:\s*(.+)\s*$/m);
  const latestVersion = verMatch ? verMatch[1].trim() : null;
  const pageHtml = join(pageDir, 'index.html');
  if (!existsSync(pageHtml)) {
    throw new Error(`Missing download page: ${pageHtml}`);
  }

  console.log('Artifacts:', {
    exe: arts.exeName,
    size: statSync(arts.exe).size,
    yml: arts.ymlName,
    blockmap: arts.blockmapName,
    latestVersion,
  });

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
    await upload(conn, pageHtml, `${remoteHome}/index.html`);

    const copies = [
      `sudo mkdir -p "${remoteWeb}"`,
      `sudo cp -f "${remoteHome}/${arts.exeName}" "${remoteWeb}/"`,
      `sudo cp -f "${remoteHome}/${arts.ymlName}" "${remoteWeb}/"`,
      `sudo cp -f "${remoteHome}/index.html" "${remoteWeb}/"`,
    ];
    if (arts.blockmapName) {
      copies.push(
        `sudo cp -f "${remoteHome}/${arts.blockmapName}" "${remoteWeb}/"`
      );
    }
    await exec(conn, copies.join(' && '));

    // Keep only the latest installer (+ blockmap); remove older Setup builds.
    // Use Python so SSH/shell does not expand `$…` variables.
    const keepExe = arts.exeName;
    const keepBlock = arts.blockmapName || '';
    await exec(
      conn,
      `python3 - <<'PY'
import os, subprocess
keep = ${JSON.stringify(keepExe)}
keepb = ${JSON.stringify(keepBlock)}
roots = [
    (${JSON.stringify(remoteHome)}, False),
    (${JSON.stringify(remoteWeb)}, True),
]
patterns_suffix = (
    "JianXingBrowser-Setup-",
    "简行浏览器-Setup-",
)
for root, use_sudo in roots:
    if not os.path.isdir(root):
        continue
    for name in os.listdir(root):
        if not (name.endswith(".exe") or name.endswith(".exe.blockmap")):
            continue
        if not name.startswith(patterns_suffix):
            continue
        if name == keep or (keepb and name == keepb):
            print("KEEP", root, name)
            continue
        path = os.path.join(root, name)
        if use_sudo:
            subprocess.check_call(["sudo", "rm", "-f", path])
        else:
            os.remove(path)
        print("removed", path)
PY`
    );

    const listing = await exec(
      conn,
      `python3 - <<'PY'
import json, os, time
root = "${remoteWeb}"
out = []
for name in os.listdir(root):
    path = os.path.join(root, name)
    if not os.path.isfile(path):
        continue
    st = os.stat(path)
    out.append({
        "name": name,
        "size": st.st_size,
        "mtime": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(st.st_mtime)),
    })
print(json.dumps(out, ensure_ascii=False))
PY`
    );

    const versions = buildVersionsJson(listing, latestVersion);
    const localVersions = join(tmpdir(), 'jianxing-versions.json');
    writeFileSync(localVersions, JSON.stringify(versions, null, 2), 'utf8');
    await upload(conn, localVersions, `${remoteHome}/versions.json`);
    await exec(
      conn,
      `sudo cp -f "${remoteHome}/versions.json" "${remoteWeb}/" && sudo chmod -R a+rX "${remoteWeb}" && ls -lah "${remoteWeb}"`
    );

    console.log('Published.');
    console.log(`Download page: http://${host}/downloads/jianxing/`);
    console.log(`Versions: ${versions.versions.map((v) => v.version).join(', ')}`);
  } finally {
    conn.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
