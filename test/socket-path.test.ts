// Where each id lands on each platform, pinned because a host from before
// per-profile endpoints has to keep finding the path it always used.
//
// Each half runs only on its own platform. Spoofing process.platform does not
// work: node:path is bound to the real platform at import, so join() keeps
// producing that platform's separators whatever the flag says.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LEGACY_ID, endpointIdOf, endpointPathFor } from '../dist/socket-path.js';

const windows = process.platform === 'win32';

test('on unix the legacy id is the socket every earlier release used', { skip: windows }, () => {
  assert.match(endpointPathFor(LEGACY_ID), /\/yoke\/extension\.sock$/);
  assert.match(endpointPathFor('14ab7cb7'), /\/yoke\/14ab7cb7\.sock$/);
  assert.equal(endpointIdOf('/x/yoke/extension.sock'), LEGACY_ID);
  assert.equal(endpointIdOf('/x/yoke/14ab7cb7.sock'), '14ab7cb7');
  assert.equal(endpointIdOf('/x/yoke/notes.txt'), undefined);
});

test('on windows the legacy id is the bare pipe name, and a profile id is suffixed', { skip: !windows }, () => {
  const previous = process.env['USERNAME'];
  process.env['USERNAME'] = 'hamza';
  try {
    // Exactly what 0.1.3 listened on. A suffix here would strand a host whose
    // extension has not been reloaded on a name nobody looks for.
    assert.equal(endpointPathFor(LEGACY_ID), '\\\\.\\pipe\\yoke-hamza');
    assert.equal(endpointPathFor('14ab7cb7'), '\\\\.\\pipe\\yoke-hamza-14ab7cb7');
    assert.equal(endpointIdOf('\\\\.\\pipe\\yoke-hamza'), LEGACY_ID);
    assert.equal(endpointIdOf('\\\\.\\pipe\\yoke-hamza-14ab7cb7'), '14ab7cb7');
    assert.equal(endpointIdOf('\\\\.\\pipe\\yoke-someoneelse-14ab7cb7'), undefined);
  } finally {
    if (previous === undefined) { delete process.env['USERNAME']; } else { process.env['USERNAME'] = previous; }
  }
});

test('an id that could escape the directory is refused', () => {
  assert.throws(() => endpointPathFor('../etc'));
  assert.throws(() => endpointPathFor('A1B2'));
});
