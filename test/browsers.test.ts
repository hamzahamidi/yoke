// Several Chrome profiles at once, against fake hosts on real sockets.
//
// The host protocol is one JSON object per line, so a test can stand up two
// hosts in a temporary endpoint directory and see which one each tool call
// reaches. No browser is involved, which is what makes routing assertable.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { handle } from '../dist/mcp-server.js';
import { forget } from '../dist/browsers.js';

// Named pipes cannot be created from a directory, so this suite is unix only.
// Windows is listed as untested in the README for the same reason.
const skip = process.platform === 'win32';

interface FakeHost {
  id: string;
  label: string;
  tabs: Array<{ id: number; windowId: number; url: string; title: string }>;
  /** Every op the host was asked, in order. */
  received: string[];
  /** Answer identify with an unknown-op error, as an extension from before it would. */
  legacy?: boolean;
}

function serve(dir: string, host: FakeHost): Promise<Server> {
  const file = join(dir, host.legacy ? 'extension.sock' : `${host.id}.sock`);
  const server = createServer((connection) => {
    let text = '';
    connection.on('data', (chunk) => {
      text += chunk.toString('utf8');
      for (;;) {
        const cut = text.indexOf('\n');
        if (cut === -1) { return; }
        const request = JSON.parse(text.slice(0, cut)) as { op: string; args?: Record<string, unknown> };
        text = text.slice(cut + 1);
        host.received.push(request.op);
        connection.write(`${JSON.stringify(answer(host, request))}\n`);
      }
    });
  });
  return new Promise((resolve) => server.listen(file, () => resolve(server)));
}

function answer(host: FakeHost, request: { op: string; args?: Record<string, unknown> }): unknown {
  const ok = (data: unknown): unknown => ({ ok: true, data, protocol: 1 });
  switch (request.op) {
    case 'identify':
      return host.legacy
        ? { ok: false, error: 'unknown op identify', protocol: 1 }
        : ok({ id: host.id, label: host.label, windows: 1, tabs: host.tabs.length });
    case 'ping':
      return ok({ extension: '0.1.3', attached: [] });
    case 'listTabs':
      return ok({ tabs: host.tabs.map((tab) => ({ ...tab, groupId: -1 })) });
    case 'listGroups':
      return ok({ groups: [] });
    case 'getPageText': {
      const tabId = request.args?.['tabId'] as number;
      return ok({ tabId, url: 'https://x/', title: `page in ${host.id}`, text: 'hello', truncated: false });
    }
    case 'openTab':
      return ok({
        tab: { id: 900, windowId: 1, groupId: 1, url: String(request.args?.['url'] ?? ''), title: 'new' },
        groupId: 1,
        groupTitle: 'yoke',
      });
    default:
      return { ok: false, error: `fake host has no ${request.op}`, protocol: 1 };
  }
}

async function withHosts<T>(
  hosts: FakeHost[],
  body: (dir: string) => Promise<T>,
): Promise<T> {
  // tmpdir rather than the project: a unix socket path is capped at 104 bytes
  // on macOS, and a checkout can easily live deeper than that.
  const dir = mkdtempSync(join(tmpdir(), 'yoke-'));
  const previous = process.env['XDG_RUNTIME_DIR'];
  process.env['XDG_RUNTIME_DIR'] = dir;
  mkdirSync(join(dir, 'yoke'), { mode: 0o700 });
  forget();
  const servers = await Promise.all(hosts.map((host) => serve(join(dir, 'yoke'), host)));
  try {
    return await body(join(dir, 'yoke'));
  } finally {
    for (const server of servers) { server.close(); }
    if (previous === undefined) { delete process.env['XDG_RUNTIME_DIR']; } else { process.env['XDG_RUNTIME_DIR'] = previous; }
    forget();
    rmSync(dir, { recursive: true, force: true });
  }
}

const call = (name: string, args: Record<string, unknown> = {}): Promise<{ content: Array<{ text: string }>; isError?: boolean }> =>
  handle({ method: 'tools/call', params: { name, arguments: args } }) as Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

const work: FakeHost = {
  id: 'a1b2c3d4',
  label: '',
  tabs: [
    { id: 11, windowId: 1, url: 'https://mail.google.com/mail/u/0/', title: 'Inbox' },
    { id: 12, windowId: 1, url: 'https://github.com/hamzahamidi/yoke', title: 'yoke' },
  ],
  received: [],
};

const personal: FakeHost = {
  id: 'e5f6a7b8',
  label: 'personal',
  tabs: [
    { id: 200, windowId: 2, url: 'https://medium.com/new-story', title: 'New story' },
  ],
  received: [],
};

const fresh = (host: FakeHost): FakeHost => ({ ...host, received: [] });

test('one browser reads exactly as it did before profiles existed', { skip }, async () => {
  await withHosts([fresh(work)], async () => {
    const listed = await call('list_tabs');
    assert.equal(
      listed.content[0]?.text,
      '2 open tab(s), every window included.\nid\turl\ttitle\n'
      + '11\thttps://mail.google.com/mail/u/0/\tInbox\n'
      + '12\thttps://github.com/hamzahamidi/yoke\tyoke');
    // open_tab needs no browser argument when there is only one to choose.
    const opened = await call('open_tab', { url: 'https://example.com' });
    assert.equal(opened.isError, undefined);
    assert.match(opened.content[0]?.text ?? '', /Opened tab 900/);
  });
});

test('two browsers: every tab is listed and each is labelled with its browser', { skip }, async () => {
  await withHosts([fresh(work), fresh(personal)], async () => {
    const listed = await call('list_tabs');
    const text = listed.content[0]?.text ?? '';
    assert.match(text, /^3 open tab\(s\) across 2 browsers/);
    assert.match(text, /id\turl\ttitle\tbrowser/);
    assert.match(text, /200\thttps:\/\/medium\.com\/new-story\tNew story\tpersonal/);
    assert.match(text, /11\thttps:\/\/mail\.google\.com\/mail\/u\/0\/\tInbox\ta1b2c3d4/);
  });
});

test('a tab tool reaches the browser that owns the tab, by id alone', { skip }, async () => {
  const a = fresh(work);
  const b = fresh(personal);
  await withHosts([a, b], async () => {
    const page = await call('get_page_text', { tab_id: 200 });
    assert.equal(page.isError, undefined);
    assert.match(page.content[0]?.text ?? '', /page in e5f6a7b8/);
    assert.ok(b.received.includes('getPageText'), 'the owning browser answered');
    assert.ok(!a.received.includes('getPageText'), 'the other browser was not asked');
  });
});

test('a tab nobody has is refused by name rather than sent somewhere', { skip }, async () => {
  await withHosts([fresh(work), fresh(personal)], async () => {
    const page = await call('get_page_text', { tab_id: 999 });
    assert.equal(page.isError, true);
    assert.match(page.content[0]?.text ?? '', /999/);
    assert.match(page.content[0]?.text ?? '', /list_tabs/);
  });
});

test('list_browsers names each browser, its label, and what it mostly has open', { skip }, async () => {
  await withHosts([fresh(work), fresh(personal)], async () => {
    const browsers = await call('list_browsers');
    const text = browsers.content[0]?.text ?? '';
    assert.match(text, /2 browser\(s\) connected/);
    assert.match(text, /a1b2c3d4\t\(unnamed\)\t2 tab\(s\)\t1 window\(s\)\tmail\.google\.com, github\.com/);
    assert.match(text, /e5f6a7b8\tpersonal\t1 tab\(s\)\t1 window\(s\)\tmedium\.com/);
  });
});

test('open_tab with two browsers connected needs one named, by id or by label', { skip }, async () => {
  const a = fresh(work);
  const b = fresh(personal);
  await withHosts([a, b], async () => {
    const unnamed = await call('open_tab', { url: 'https://medium.com/new-story' });
    assert.equal(unnamed.isError, true);
    assert.match(unnamed.content[0]?.text ?? '', /2 browsers/);
    assert.match(unnamed.content[0]?.text ?? '', /browser/);

    const byLabel = await call('open_tab', { url: 'https://medium.com/new-story', browser: 'Personal' });
    assert.equal(byLabel.isError, undefined);
    assert.ok(b.received.includes('openTab'));
    assert.ok(!a.received.includes('openTab'));

    const byId = await call('open_tab', { url: 'https://example.com', browser: 'a1b2c3d4' });
    assert.equal(byId.isError, undefined);
    assert.ok(a.received.includes('openTab'));

    const unknown = await call('open_tab', { url: 'https://example.com', browser: 'nope' });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0]?.text ?? '', /nope/);
  });
});

test('a tab id two browsers both report is refused, naming both', { skip }, async () => {
  const brave: FakeHost = {
    id: 'ffffffff',
    label: 'brave',
    tabs: [{ id: 11, windowId: 7, url: 'https://example.org/', title: 'same id, other browser' }],
    received: [],
  };
  await withHosts([fresh(work), brave], async () => {
    const page = await call('get_page_text', { tab_id: 11 });
    assert.equal(page.isError, true);
    assert.match(page.content[0]?.text ?? '', /a1b2c3d4/);
    assert.match(page.content[0]?.text ?? '', /brave/);
  });
});

test('a host whose extension predates identify is still reachable, and says so', { skip }, async () => {
  const old: FakeHost = { ...fresh(work), id: 'extension', legacy: true };
  await withHosts([old], async () => {
    const browsers = await call('list_browsers');
    assert.match(browsers.content[0]?.text ?? '', /1 browser\(s\) connected/);
    assert.match(browsers.content[0]?.text ?? '', /reload/i);
    const listed = await call('list_tabs');
    assert.match(listed.content[0]?.text ?? '', /^2 open tab\(s\), every window included\./);
  });
});

test('a label typed into the popup shows up on the next call, without a restart', { skip }, async () => {
  const renamed = fresh(work);
  await withHosts([renamed, fresh(personal)], async () => {
    const before = await call('list_browsers');
    assert.match(before.content[0]?.text ?? '', /a1b2c3d4\t\(unnamed\)/);
    renamed.label = 'work';
    const after = await call('list_browsers');
    assert.match(after.content[0]?.text ?? '', /a1b2c3d4\twork\t/);
    const opened = await call('open_tab', { url: 'https://example.com', browser: 'work' });
    assert.equal(opened.isError, undefined);
  });
});

test('a socket file with nobody behind it is skipped, not reported as a browser', { skip }, async () => {
  await withHosts([fresh(work)], async (dir) => {
    // A corpse: the file exists, nothing listens. A crashed host leaves these.
    writeFileSync(join(dir, 'deadbeef.sock'), '');
    const browsers = await call('list_browsers');
    assert.match(browsers.content[0]?.text ?? '', /1 browser\(s\) connected/);
    assert.doesNotMatch(browsers.content[0]?.text ?? '', /deadbeef/);
  });
});

test('no browser at all is reported as the extension being unreachable', { skip }, async () => {
  await withHosts([], async () => {
    for (const tool of ['list_tabs', 'list_tab_groups', 'list_browsers']) {
      await assert.rejects(
        () => call(tool),
        (failure: Error) => /not connected/.test(failure.message),
        `${tool} must say the extension is not connected`,
      );
    }
  });
});
