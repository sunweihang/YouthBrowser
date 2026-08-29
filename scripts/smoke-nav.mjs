/**
 * Smoke test for group-based navigation rules.
 * Run: node scripts/smoke-nav.mjs
 */
import * as esbuild from 'esbuild';
import { mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist-smoke');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [join(root, 'src/main/navigation-guard.ts')],
  outfile: join(outDir, 'nav.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
});

const require = createRequire(import.meta.url);
const { canNavigate, hostAllowed } = require(join(outDir, 'nav.cjs'));

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const rules = {
  version: 2,
  parentPasswordHash: 'x',
  groups: [
    {
      id: 'g1',
      name: 'B站',
      enabled: true,
      hosts: [
        'www.bilibili.com',
        'space.bilibili.com',
        '*.hdslb.com',
        'api.bilibili.com',
      ],
      extensionId: 'bilibili',
      extensionConfig: { allowedMids: ['2'], midNotes: {} },
    },
    {
      id: 'g2',
      name: '学习',
      enabled: true,
      hosts: ['www.example.com'],
      extensionId: 'none',
      extensionConfig: {},
    },
  ],
};

assert(hostAllowed('i0.hdslb.com', rules.groups[0].hosts), 'wildcard');

let r = await canNavigate('https://evil.com', rules);
assert(!r.allowed && r.reason === 'host_denied', 'deny unknown');

r = await canNavigate('https://www.example.com/x', rules);
assert(r.allowed, 'allow generic group');

r = await canNavigate('https://www.bilibili.com/', rules);
assert(!r.allowed && r.reason === 'bili_path_denied', 'deny bili home');

r = await canNavigate('https://space.bilibili.com/2', rules);
assert(r.allowed, 'allow listed space');

r = await canNavigate('https://space.bilibili.com/999', rules);
assert(!r.allowed && r.reason === 'bili_up_denied', 'deny other space');

r = await canNavigate('https://www.bilibili.com/video/BV1xx411c7mD', rules);
assert(r.allowed, 'allow mid=2 video');

rules.groups[0].extensionConfig.allowedMids = ['999'];
r = await canNavigate('https://www.bilibili.com/video/BV1xx411c7mD', rules);
assert(!r.allowed && r.reason === 'bili_up_denied', 'deny after mid change');

rules.groups[0].enabled = false;
r = await canNavigate('https://space.bilibili.com/2', rules);
assert(!r.allowed && r.reason === 'host_denied', 'disabled group blocks');

console.log('smoke-nav: OK');
rmSync(outDir, { recursive: true, force: true });
