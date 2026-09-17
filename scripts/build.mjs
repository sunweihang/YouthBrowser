import * as esbuild from 'esbuild';
import { spawnSync } from 'child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

function copyRenderer() {
  cpSync(join(root, 'src/renderer'), join(dist, 'renderer'), { recursive: true });
}

/** Sandboxed Electron preloads cannot require() sibling files. */
function inlineSandboxedPreloads() {
  const preloadDir = join(dist, 'preload');
  const hookPath = join(preloadDir, 'crash-hook.js');
  let hook = readFileSync(hookPath, 'utf8');
  hook = hook
    .replace(/^"use strict";\r?\n/, '')
    .replace(
      /Object\.defineProperty\(exports, "__esModule", \{ value: true \}\);\r?\n/,
      ''
    )
    .replace(
      /exports\.installRendererCrashHooks = installRendererCrashHooks;\r?\n/,
      ''
    )
    .replace(/const electron_1 = require\("electron"\);\r?\n/, '');

  for (const name of readdirSync(preloadDir)) {
    if (!name.endsWith('.js') || name === 'crash-hook.js') continue;
    const file = join(preloadDir, name);
    let src = readFileSync(file, 'utf8');
    if (!src.includes('require("./crash-hook")')) continue;
    src = src
      .replace(
        /const crash_hook_1 = require\("\.\/crash-hook"\);\r?\n/,
        `${hook}\n`
      )
      .replace(
        /\(0, crash_hook_1\.installRendererCrashHooks\)/g,
        'installRendererCrashHooks'
      );
    writeFileSync(file, src, 'utf8');
  }
}

function buildWithTsc() {
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  const result = spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.json')], {
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  inlineSandboxedPreloads();
}

async function buildWithEsbuild() {
  await esbuild.build({
    entryPoints: [
      join(root, 'src/main/index.ts'),
      join(root, 'src/preload/browser.ts'),
      join(root, 'src/preload/parent.ts'),
      join(root, 'src/preload/bookmarks.ts'),
      join(root, 'src/preload/view.ts'),
      join(root, 'src/preload/history.ts'),
      join(root, 'src/preload/downloads.ts'),
      join(root, 'src/preload/update.ts'),
      join(root, 'src/preload/passwords.ts'),
      join(root, 'src/preload/about.ts'),
    ],
    outdir: dist,
    outbase: join(root, 'src'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron'],
    sourcemap: true,
  });
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

try {
  await buildWithEsbuild();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`esbuild failed (${message}); falling back to tsc`);
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  buildWithTsc();
}

copyRenderer();
console.log('Build complete → dist/');
