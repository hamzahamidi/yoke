// Asserts that the extension's pinned key still derives the id the native host
// allowlists.
//
// Chrome derives an extension id from the first 128 bits of the SHA-256 of the
// DER public key, mapping each nibble to a-p. The host manifest allowlists a
// literal id, so if the key in extension/manifest.json and EXTENSION_ID in
// install.ts ever disagree, Chrome refuses the native messaging connection and
// the only symptom is that nothing connects.
//
// A .mjs file rather than an inline `node -e`: the inline version mixed require
// with a top-level await import, which Node resolves as ESM, leaving require
// undefined. It failed on all six runs it ever had, so the check it performs had
// never once executed.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

let allowlisted;
try {
  ({ EXTENSION_ID: allowlisted } = await import('../dist/install.js'));
} catch {
  throw new Error('dist/install.js is missing. Run `npm run build` first.');
}

const manifestPath = new URL('../extension/manifest.json', import.meta.url);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

if (typeof manifest.key !== 'string' || manifest.key === '') {
  throw new Error(
    'extension/manifest.json has no "key", so Chrome would assign an id per machine '
    + 'and the allowlist could never match.');
}

const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest();
const derived = [...digest.subarray(0, 16)]
  .map((byte) => byte.toString(16).padStart(2, '0'))
  .join('')
  .split('')
  .map((nibble) => String.fromCodePoint(97 + Number.parseInt(nibble, 16)))
  .join('');

if (derived !== allowlisted) {
  throw new Error(`manifest key derives id ${derived} but install.ts allowlists ${allowlisted}`);
}

// The extension bundle is gitignored but ships in the tarball, so a publish from
// a tree that was not rebuilt would pair a stale extension with a current dist.
// Checked here because this script already runs in CI and before every publish.
const bundle = new URL('../extension/browser/background.js', import.meta.url);
if (!existsSync(bundle)) {
  throw new Error('extension/browser/background.js is missing. Run `npm run build` before packaging.');
}
const bundleVersion = readFileSync(bundle, 'utf8').match(/io\.github\.hamzahamidi\.yoke/);
if (!bundleVersion) {
  throw new Error('the built extension does not name the current native messaging host, so it is stale');
}

console.log(`manifest key derives the allowlisted id: ${derived}`);
