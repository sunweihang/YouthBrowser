import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * When signAndEditExecutable is false (needed on AppLocker machines that cannot
 * extract winCodeSign symlinks), still embed build/icon.ico into the Windows exe.
 */
export default async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  if (context.packager.platformSpecificBuildOptions.signAndEditExecutable !== false) {
    return;
  }

  const exeName = `${context.packager.appInfo.productFilename}.exe`;
  const exe = join(context.appOutDir, exeName);
  const icon = join(context.packager.projectDir, 'build', 'icon.ico');
  const rcedit = join(context.packager.projectDir, 'tools', 'rcedit-x64.exe');

  if (!existsSync(exe)) {
    console.warn(`[afterPack] missing exe: ${exe}`);
    return;
  }
  if (!existsSync(icon)) {
    console.warn(`[afterPack] missing icon: ${icon}`);
    return;
  }
  if (!existsSync(rcedit)) {
    console.warn(`[afterPack] missing rcedit: ${rcedit} (run scripts/ensure-rcedit.mjs)`);
    return;
  }

  const version = context.packager.appInfo.version;
  const productName = context.packager.appInfo.productName;
  const steps = [
    ['--set-icon', icon],
    ['--set-version-string', 'ProductName', productName],
    ['--set-version-string', 'FileDescription', productName],
    ['--set-version-string', 'InternalName', context.packager.appInfo.productFilename],
    ['--set-version-string', 'OriginalFilename', exeName],
    ['--set-file-version', version],
    ['--set-product-version', version],
  ];

  for (const args of steps) {
    const r = spawnSync(rcedit, [exe, ...args], { stdio: 'inherit' });
    if (r.status !== 0) {
      throw new Error(`[afterPack] rcedit failed: ${args.join(' ')}`);
    }
  }
  console.log(`[afterPack] embedded icon into ${exeName}`);
}
