import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

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

cpSync(join(root, 'src/renderer'), join(dist, 'renderer'), { recursive: true });
console.log('Build complete → dist/');
