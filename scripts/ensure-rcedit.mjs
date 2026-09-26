import { spawnSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tools = join(root, 'tools');
const rcedit = join(tools, 'rcedit-x64.exe');
const seven = join(root, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
const cacheDir = join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'winCodeSign');
const archive = join(cacheDir, 'winCodeSign-2.6.0.7z');
const url =
  'https://npmmirror.com/mirrors/electron-builder-binaries/winCodeSign-2.6.0/winCodeSign-2.6.0.7z';

if (existsSync(rcedit) && (await import('fs')).statSync(rcedit).size > 100000) {
  console.log('rcedit ready:', rcedit);
  process.exit(0);
}

mkdirSync(tools, { recursive: true });
mkdirSync(cacheDir, { recursive: true });

if (!existsSync(archive) || (await import('fs')).statSync(archive).size < 1000000) {
  console.log('Downloading winCodeSign for rcedit…');
  const curl = spawnSync(
    'curl.exe',
    ['-L', '--max-time', '120', '-o', archive, url],
    { stdio: 'inherit' }
  );
  if (curl.status !== 0) process.exit(curl.status || 1);
}

const extract = spawnSync(
  seven,
  ['e', '-bd', '-y', archive, 'rcedit-x64.exe', 'rcedit-ia32.exe', `-o${tools}`],
  { stdio: 'inherit' }
);
if (extract.status !== 0) process.exit(extract.status || 1);
if (!existsSync(rcedit)) {
  console.error('rcedit-x64.exe still missing after extract');
  process.exit(1);
}
console.log('rcedit ready:', rcedit);
