// Builds the zip the Chrome Web Store wants, into dist/store/.
//
// The store takes a zip of the extension's CONTENTS, not of a folder containing
// them, which is the usual way this goes wrong: a zip with extension/ at the top
// is rejected for having no manifest at its root.
//
// No archiver dependency, because the project ships none: this shells out to the
// zip tool each platform already has.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const powershell = join(process.env['SystemRoot'] ?? String.raw`C:\Windows`, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const manifest = JSON.parse(readFileSync(join(root, 'extension', 'manifest.json'), 'utf8'));

if (manifest.version !== version) {
  throw new Error(
    `extension/manifest.json says ${manifest.version} and package.json says ${version}. `
    + 'Run npm run check:versions.');
}

const outDir = join(root, 'dist', 'store');
const zipPath = join(outDir, `yoke-${version}.zip`);
mkdirSync(outDir, { recursive: true });
rmSync(zipPath, { force: true });

// Staged rather than zipped in place, because the uploaded manifest must differ
// from the one in the repository in exactly one way.
//
// The Chrome Web Store rejects an upload whose manifest carries `key`, with "key
// field is not allowed in manifest". The repository manifest has to keep it: it
// is what pins the id oceljemfocgfidhhdlbojkbkmlbfclna for an unpacked load, and
// the native messaging host allowlists that id. So the field is stripped here,
// for the store copy only, and the store assigns an id of its own.
const source = join(outDir, 'staging');
rmSync(source, { recursive: true, force: true });
cpSync(join(root, 'extension'), source, { recursive: true });

const staged = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
const hadKey = 'key' in staged;
delete staged.key;
writeFileSync(join(source, 'manifest.json'), `${JSON.stringify(staged, null, 2)}\n`);
if (process.platform === 'win32') {
  // -Path with \* takes the contents rather than the directory itself.
  execFileSync(powershell, [
    '-NoProfile', '-Command',
    String.raw`Compress-Archive -Path '${source}\*' -DestinationPath '${zipPath}' -Force`,
  ], { stdio: 'inherit' });
} else {
  execFileSync('/usr/bin/zip', ['-qr', zipPath, '.', '-x', '*.DS_Store'], { cwd: source, stdio: 'inherit' });
}

// A zip whose manifest is not at the root is the failure worth catching here
// rather than in the dashboard, which says only that the package is invalid.
const listing = process.platform === 'win32'
  ? execFileSync(powershell, ['-NoProfile', '-Command',
    `Add-Type -A System.IO.Compression.FileSystem; `
    + `[IO.Compression.ZipFile]::OpenRead('${zipPath}').Entries.FullName`], { encoding: 'utf8' })
  : execFileSync('/usr/bin/unzip', ['-Z1', zipPath], { encoding: 'utf8' });

const entries = listing.split('\n').map((line) => line.trim()).filter(Boolean);
if (!entries.includes('manifest.json')) {
  throw new Error(`manifest.json is not at the root of the zip. Entries: ${entries.join(', ')}`);
}

// Read back out of the archive rather than trusting the staging step, because
// this is the field the store refuses the whole upload over.
const packed = process.platform === 'win32'
  ? execFileSync(powershell, ['-NoProfile', '-Command',
    `Add-Type -A System.IO.Compression.FileSystem; `
    + `$z=[IO.Compression.ZipFile]::OpenRead('${zipPath}'); `
    + `$e=$z.GetEntry('manifest.json'); $r=New-Object IO.StreamReader($e.Open()); $r.ReadToEnd()`],
  { encoding: 'utf8' })
  : execFileSync('/usr/bin/unzip', ['-p', zipPath, 'manifest.json'], { encoding: 'utf8' });

if ('key' in JSON.parse(packed)) {
  throw new Error('the packaged manifest still has a key field, which the store refuses');
}

rmSync(source, { recursive: true, force: true });

console.log(`dist/store/yoke-${version}.zip`);
console.log(`  ${statSync(zipPath).size} bytes, ${entries.length} entries`);
console.log(`  manifest.json at the root: yes, version ${manifest.version}`);
console.log(`  key field: ${hadKey ? 'stripped for the store' : 'was not present'}`);
