import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { browserDirs } from '../dist/install.js';

let copy = 0;

async function run(action?: string, installBrowser = false): Promise<{ code: number; out: string; err: string }> {
  const home = mkdtempSync(join(tmpdir(), 'yoke-cli-'));
  const config = join(home, 'config');
  const runtime = join(home, 'runtime');
  const savedArgv = process.argv;
  const savedExitCode = process.exitCode;
  const savedEnv = {
    HOME: process.env['HOME'],
    XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'],
    XDG_RUNTIME_DIR: process.env['XDG_RUNTIME_DIR'],
  };
  const savedOut = process.stdout.write;
  const savedErr = process.stderr.write;
  let out = '';
  let err = '';
  process.env['HOME'] = home;
  process.env['XDG_CONFIG_HOME'] = config;
  process.env['XDG_RUNTIME_DIR'] = runtime;
  mkdirSync(runtime);
  if (installBrowser) {
    const first = browserDirs(process.platform, home)[0]?.[1];
    assert.ok(first);
    mkdirSync(dirname(first), { recursive: true });
  }
  process.argv = [process.execPath, '/tmp/yoke-cli.js', ...(action === undefined ? [] : [action])];
  process.exitCode = 0;
  process.stdout.write = ((chunk: string | Uint8Array) => { out += chunk.toString(); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { err += chunk.toString(); return true; }) as typeof process.stderr.write;
  try {
    await import(`../dist/cli.js?copy=${++copy}`);
    return { code: process.exitCode ?? 0, out, err };
  } finally {
    process.stdout.write = savedOut;
    process.stderr.write = savedErr;
    process.argv = savedArgv;
    process.exitCode = savedExitCode;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; }
    }
    rmSync(home, { recursive: true, force: true });
  }
}

test('CLI help, invalid commands, and disconnected status have useful exit codes', async () => {
  const noArguments = await run();
  assert.equal(noArguments.code, 0);
  assert.match(noArguments.out, /Usage:/);

  const help = await run('--help');
  assert.equal(help.code, 0);
  assert.match(help.out, /Usage:/);

  const invalid = await run('not-a-command');
  assert.equal(invalid.code, 64);
  assert.match(invalid.out, /Usage:/);

  const status = await run('status');
  assert.equal(status.code, 3);
  assert.match(status.out, /extension: not reachable/);
  assert.match(status.out, /endpoints:/);
});

test('CLI doctor and uninstall report an unconfigured browser without failing cleanup', async () => {
  const doctor = await run('doctor');
  assert.equal(doctor.code, 3);
  assert.match(doctor.out, /registration/);
  assert.match(doctor.out, /host running/);
  assert.match(doctor.out, /Not working yet/);

  const uninstall = await run('uninstall');
  assert.equal(uninstall.code, 0);
  assert.match(uninstall.out, /nothing was registered/);
});

test('CLI install registers only a browser whose configuration directory exists', { skip: process.platform === 'win32' }, async () => {
  const result = await run('install', true);
  assert.equal(result.code, 0);
  assert.match(result.out, /registered for Chrome:/);
  assert.match(result.out, /Now load extension/);
});
