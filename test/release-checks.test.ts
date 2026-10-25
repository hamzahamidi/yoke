import { test } from 'node:test';

test('the extension identifier release check accepts the built extension', async () => {
  await import('../scripts/check-extension-id.mjs');
});

test('the version release check accepts matching package, manifest, and server versions', async () => {
  await import('../scripts/check-versions.mjs');
});
