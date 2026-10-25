// Registering the native messaging host with the browsers on this machine.
//
// Chrome will only launch a host declared in a manifest at a fixed path, and will
// only connect an extension whose id appears in that manifest's allowed_origins.
// Both halves are why this exists: the id is pinned by the key in the
// extension's manifest, and this manifest has to be written into each browser's
// own directory.
import { chmodSync, existsSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, win32 as windowsPath } from 'node:path';

// Reverse DNS on the GitHub namespace rather than a domain, because that is the
// ownership actually demonstrable here. Chrome reads this string by exact match
// from a file on the user's disk, so changing it breaks every existing install.
export const HOST_NAME = 'io.github.hamzahamidi.yoke';

/**
 * Every extension id allowed to reach the host.
 *
 * A list because a published extension has a different id from an unpacked one,
 * and both have to work. The id below is derived from the public key pinned in
 * extension/manifest.json, which is what an unpacked load uses. The Chrome Web
 * Store assigns its own id from a key it generates: per Chrome's documentation
 * the key flows the other way, and you "copy the public key from the Dashboard's
 * Package tab" into the manifest afterwards, so a store id cannot be predicted
 * or chosen in advance.
 *
 * Native messaging allowed_origins is documented as a list of extensions, with
 * wildcards explicitly not allowed, so the store id is appended here when the
 * listing exists and both installs keep working. Getting that wrong is silent:
 * Chrome refuses the connection and says nothing.
 */
export const EXTENSION_IDS: readonly string[] = [
  // Derived from the key pinned in extension/manifest.json, so this is the id an
  // unpacked load gets. scripts/check-extension-id.mjs asserts the two agree.
  'oceljemfocgfidhhdlbojkbkmlbfclna',
  // Assigned by the Chrome Web Store when the listing was created, and not
  // predictable: an upload may not carry a key, so it cannot choose its id.
  'mebojgahcmmffbaonhnmmjhmbdbfbamm',
];

/** The unpacked id, which is the one the pinned key has to derive. */
export const EXTENSION_ID = EXTENSION_IDS[0] as string;

export interface HostManifest {
  name: string;
  description: string;
  path: string;
  type: 'stdio';
  allowed_origins: string[];
}

export interface InstallResult {
  written: Array<[browser: string, file: string]>;
  skipped: Array<[browser: string, reason: string]>;
  extensionId: string;
  hostName: string;
  platform: NodeJS.Platform;
}

/**
 * Where each browser looks for host manifests.
 *
 * Per-user directories only. A system-wide install needs root and would register
 * the host for every account on the machine, which is not something a command
 * line should arrange on someone's behalf.
 */
export function browserDirs(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): Array<[browser: string, dir: string]> {
  if (platform === 'darwin') {
    const support = join(home, 'Library', 'Application Support');
    return [
      ['Chrome', join(support, 'Google', 'Chrome', 'NativeMessagingHosts')],
      ['Chrome Beta', join(support, 'Google', 'Chrome Beta', 'NativeMessagingHosts')],
      ['Chromium', join(support, 'Chromium', 'NativeMessagingHosts')],
      ['Edge', join(support, 'Microsoft Edge', 'NativeMessagingHosts')],
      ['Brave', join(support, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts')],
    ];
  }
  if (platform === 'win32') {
    // Windows selects the host through the registry rather than through a
    // per-browser directory, so one location holds the manifest and every
    // browser's registry key points at it. It still has to be WRITTEN
    // somewhere: returning nothing here is what left `install` telling people
    // to point the registry at a manifest it had never created.
    const appData = process.env['LOCALAPPDATA'] ?? windowsPath.join(home, 'AppData', 'Local');
    return [['Windows', windowsPath.join(appData, 'yoke')]];
  }
  const config = process.env['XDG_CONFIG_HOME'] ?? join(home, '.config');
  return [
    ['Chrome', join(config, 'google-chrome', 'NativeMessagingHosts')],
    ['Chromium', join(config, 'chromium', 'NativeMessagingHosts')],
    ['Edge', join(config, 'microsoft-edge', 'NativeMessagingHosts')],
    ['Brave', join(config, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts')],
  ];
}

/**
 * Writes a launcher that runs the host with an absolute node path.
 *
 * Chrome executes the manifest's `path` directly, and a Chrome started from the
 * Dock or Finder inherits a minimal PATH: on macOS typically
 * /usr/bin:/bin:/usr/sbin:/sbin. A `#!/usr/bin/env node` shebang therefore fails
 * to resolve for anyone whose node came from Homebrew, nvm, asdf or Volta, which
 * is nearly everyone, and the failure surfaces only as "Native host has exited".
 * Baking in the interpreter that is running this install removes the guess.
 */
/**
 * A node path that survives a node upgrade, where one can be proven identical.
 *
 * process.execPath is exact but versioned: under Homebrew it reads
 * /opt/homebrew/Cellar/node/26.5.1/bin/node, a path `brew upgrade node` deletes.
 * The launcher would then point at nothing, and Chrome reports that only as
 * "Native host has exited". A stable symlink to the same file does not move, so
 * it is preferred, but only when realpath proves it resolves to the same binary:
 * guessing a path that happens to exist could pin a different node version.
 */
function stableNodePath(): string {
  const exact = process.execPath;
  let resolved: string;
  try { resolved = realpathSync(exact); } catch { return exact; }
  const candidates = [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    join(homedir(), '.volta', 'bin', 'node'),
    '/usr/bin/node',
  ];
  for (const candidate of candidates) {
    try {
      if (realpathSync(candidate) === resolved) { return candidate; }
    } catch { /* not installed, try the next */ }
  }
  return exact;
}

/**
 * The launcher's name and the path rules for a platform.
 *
 * Taken from the platform being installed for, never from process.platform.
 * These functions exist so the Windows path can be exercised from any machine,
 * and reading the host's platform instead made it untestable, which is how it
 * came to write a manifest naming a launcher it had not created.
 */
const launcherName = (platform: NodeJS.Platform): string =>
  (platform === 'win32' ? 'yoke-host.bat' : 'yoke-host.sh');

const pathsFor = (platform: NodeJS.Platform): { join: (...parts: string[]) => string } =>
  (platform === 'win32' ? windowsPath : { join });

/**
 * Writes the launcher into the same directory as the manifest that names it.
 *
 * Not into dist/ next to the host, which is where this used to go and was a
 * quiet trap: dist/ is build output, so `npm run clean` (which prepublishOnly
 * runs) deleted the launcher while four browser manifests still pointed at it.
 * The extension then failed to connect, and the symptom named the extension
 * rather than the missing file. Here it is created and removed with the manifest
 * it belongs to, and no build touches it.
 */
function writeLauncher(
  dir: string,
  hostPath: string,
  platform: NodeJS.Platform,
  nodePath: string = stableNodePath(),
): string {
  const launcher = pathsFor(platform).join(dir, launcherName(platform));
  if (platform === 'win32') {
    writeFileSync(launcher, `@echo off\r\n"${nodePath}" "${hostPath}" %*\r\n`);
    return launcher;
  }
  writeFileSync(launcher, `#!/bin/sh\nexec "${nodePath}" "${hostPath}" "$@"\n`, { mode: 0o755 });
  chmodSync(launcher, 0o755);
  return launcher;
}

export const manifestFor = (hostPath: string): HostManifest => ({
  name: HOST_NAME,
  description: 'yoke native messaging host',
  path: hostPath,
  type: 'stdio',
  allowed_origins: EXTENSION_IDS.map((id) => `chrome-extension://${id}/`),
});

/**
 * Writes the manifest into every browser directory whose parent already exists.
 *
 * Only where the browser is actually installed: creating a Brave directory on a
 * machine with no Brave leaves litter for something that is not there.
 */
export function install({
  hostPath,
  platform = process.platform,
  home = homedir(),
}: { hostPath: string; platform?: NodeJS.Platform; home?: string }): InstallResult {
  if (!existsSync(hostPath)) {
    throw new Error(`the host script is not at ${hostPath}`);
  }
  try { chmodSync(hostPath, 0o755); } catch { /* read-only install; reported below */ }

  const written: InstallResult['written'] = [];
  const skipped: InstallResult['skipped'] = [];

  for (const [browser, dir] of browserDirs(platform, home)) {
    // The parent-exists check asks "is this browser installed", so it only makes
    // sense for a directory the browser owns. On Windows the directory is ours,
    // named by a registry value rather than found by a browser, so skipping it
    // for a missing parent would mean never writing the manifest at all.
    const browserOwnsIt = platform !== 'win32';
    if (browserOwnsIt && !existsSync(dirname(dir))) {
      skipped.push([browser, 'not installed']);
      continue;
    }
    try {
      mkdirSync(dir, { recursive: true });
      // The manifest points at a launcher rather than at the host, so Chrome
      // never has to find node on a PATH it does not have. Both live here, so
      // neither can outlive the other.
      const launcher = writeLauncher(dir, hostPath, platform);
      const file = pathsFor(platform).join(dir, `${HOST_NAME}.json`);
      writeFileSync(file, `${JSON.stringify(manifestFor(launcher), null, 2)}\n`);
      written.push([browser, file]);
    } catch (error_) {
      skipped.push([browser, error_ instanceof Error ? error_.message : String(error_)]);
    }
  }
  return { written, skipped, extensionId: EXTENSION_ID, hostName: HOST_NAME, platform };
}

export function uninstall({
  platform = process.platform,
  home = homedir(),
}: { platform?: NodeJS.Platform; home?: string } = {}): { removed: Array<[string, string]> } {
  const removed: Array<[string, string]> = [];
  for (const [browser, dir] of browserDirs(platform, home)) {
    const file = pathsFor(platform).join(dir, `${HOST_NAME}.json`);
    try { unlinkSync(file); removed.push([browser, file]); } catch { /* not there */ }
    // The launcher lives beside the manifest, so it goes with it rather than
    // being left behind pointing at a host nothing will ask for.
    try { unlinkSync(pathsFor(platform).join(dir, launcherName(platform))); } catch { /* not there */ }
  }
  return { removed };
}
