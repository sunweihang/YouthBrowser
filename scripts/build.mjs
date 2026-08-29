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
