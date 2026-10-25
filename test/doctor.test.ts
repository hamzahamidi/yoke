import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { doctor, render } from '../dist/doctor.js';
import { forget } from '../dist/browsers.js';
import { HOST_NAME, browserDirs, install } from '../dist/install.js';
import { endpointPathFor } from '../dist/socket-path.js';

const skip = process.platform === 'win32';
const hostPath = fileURLToPath(new URL('../dist/native-host.js', import.meta.url));

async function inEnvironment<T>(body: (home: string, runtime: string, registration: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'yoke-doctor-'));
  const runtime = join(home, 'runtime');
  const config = join(home, 'config');
  mkdirSync(runtime);
  const saved = {
    HOME: process.env['HOME'],
    XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'],
    XDG_RUNTIME_DIR: process.env['XDG_RUNTIME_DIR'],
  };
  process.env['HOME'] = home;
  process.env['XDG_CONFIG_HOME'] = config;
  process.env['XDG_RUNTIME_DIR'] = runtime;
  try {
    const registration = browserDirs(process.platform, home)[0]?.[1];
    assert.ok(registration);
    mkdirSync(registration, { recursive: true });
    forget();
    return await body(home, runtime, registration);
  } finally {
    forget();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; }
    }
    rmSync(home, { recursive: true, force: true });
  }
}

function writeManifest(registration: string, manifest: { path: string; allowed_origins: string[] }): void {
  writeFileSync(join(registration, `${HOST_NAME}.json`), JSON.stringify(manifest));
}

test('doctor explains invalid registration paths, permissions, interpreters, and origins', { skip }, async () => {
  await inEnvironment(async (home, _runtime, registration) => {
    const manifestPath = join(registration, `${HOST_NAME}.json`);
    writeFileSync(manifestPath, '{');
    assert.match((await doctor())[1]?.detail ?? '', /not valid JSON/);

    writeManifest(registration, { path: join(home, 'missing-launcher'), allowed_origins: [] });
    assert.match((await doctor())[1]?.detail ?? '', /does not exist/);

    const launcher = join(home, 'launcher');
    writeFileSync(launcher, 'no interpreter');
    writeManifest(registration, { path: launcher, allowed_origins: [] });
    assert.match((await doctor())[1]?.detail ?? '', /not executable/);

    writeFileSync(launcher, '#!/bin/sh\nexec "/missing/node" "host.js"\n');
    chmodSync(launcher, 0o755);
    writeManifest(registration, { path: launcher, allowed_origins: [] });
    assert.match((await doctor())[1]?.detail ?? '', /no longer exists/);

    writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${hostPath}"\n`);
    chmodSync(launcher, 0o755);
    writeManifest(registration, { path: launcher, allowed_origins: [] });
    assert.match((await doctor())[1]?.detail ?? '', /missing .*extension/);
  });
});

test('doctor checks the host and extension, then names the failing link', { skip }, async () => {
  await inEnvironment(async (home, runtime) => {
    install({ hostPath, home });
    let failure: 'none' | 'ping' | 'listTabs' = 'none';
    let input = '';
    const server = createServer((connection) => {
      connection.on('data', (chunk) => {
        input += chunk.toString('utf8');
        for (;;) {
          const cut = input.indexOf('\n');
          if (cut === -1) { break; }
          const request = JSON.parse(input.slice(0, cut)) as { op: string };
          input = input.slice(cut + 1);
          const reply = failure === request.op
            ? { ok: false, error: `${request.op} failed`, protocol: 1 }
            : {
              ok: true,
              protocol: 1,
              data: request.op === 'identify'
                ? { id: 'a1b2c3d4', label: '', windows: 1, tabs: 1 }
                : request.op === 'ping'
                  ? { extension: '0.1.10', attached: [7] }
                  : { tabs: [{ id: 7, windowId: 1, url: 'https://example.com/', title: 'Example', groupId: -1 }] },
            };
          connection.write(`${JSON.stringify(reply)}\n`);
        }
      });
    });
    const endpoint = endpointPathFor('a1b2c3d4');
    mkdirSync(dirname(endpoint), { recursive: true });
    await new Promise<void>((resolve) => server.listen(endpoint, resolve));
    try {
      const checks = await doctor();
      assert.equal(checks.every((check) => check.ok), true);
      assert.match(checks[3]?.detail ?? '', /unnamed/);
      assert.match(checks[4]?.detail ?? '', /holding 1 tab/);
      assert.match(render(checks), /Working\. Every link in the chain answered/);

      failure = 'ping';
      const pingFailure = await doctor();
      assert.equal(pingFailure[4]?.ok, false);
      assert.match(pingFailure[4]?.detail ?? '', /ping failed/);

      failure = 'listTabs';
      const tabsFailure = await doctor();
      assert.equal(tabsFailure[5]?.ok, false);
      assert.match(tabsFailure[5]?.detail ?? '', /listTabs failed/);
      assert.match(render(tabsFailure), /Not working yet/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

test('doctor reports a stale endpoint whose host no longer answers', { skip }, async () => {
  await inEnvironment(async (home, runtime) => {
    install({ hostPath, home });
    const endpoints = join(runtime, 'yoke');
    mkdirSync(endpoints, { recursive: true });
    writeFileSync(join(endpoints, 'a1b2c3d4.sock'), '');

    const checks = await doctor();
    assert.equal(checks[2]?.ok, true);
    assert.equal(checks[3]?.label, 'extension');
    assert.equal(checks[3]?.ok, false);
    assert.match(checks[3]?.detail ?? '', /no host behind it answered/);
  });
});
