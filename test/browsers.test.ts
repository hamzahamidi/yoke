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
import { NOT_CONNECTED } from '../dist/socket-client.js';

// Named pipes cannot be created from a directory, so this suite is unix only.
// Windows is listed as untested in the README for the same reason.
const skip = process.platform === 'win32';

interface FakeHost {
  id: string;
  label: string;
  tabs: Array<{ id: number; windowId: number; url: string; title: string }>;
  elements?: Array<{ ref: string; role: string; name: string; tag: string; value?: string; disabled?: boolean }>;
  truncated?: boolean;
  groups?: Array<{ id: number; title: string; color: string; windowId: number; collapsed: boolean }>;
  navigateStatus?: 'complete' | 'timeout';
  openedGroupId?: number | null;
  releaseResult?: boolean;
  /** Every op the host was asked, in order. */
  received: string[];
  /** Answer identify with an unknown-op error, as an extension from before it would. */
  legacy?: boolean;
  /** The id the next openTab hands out. Defaults to 900. */
  nextTabId?: number;
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
      return ok({ groups: host.groups ?? [] });
    case 'getPageText': {
      const tabId = request.args?.['tabId'] as number;
      return ok({ tabId, url: 'https://x/', title: `page in ${host.id}`, text: 'hello', truncated: false });
    }
    case 'readPage': {
      const tabId = request.args?.['tabId'] as number;
      return ok({
        tabId,
        url: 'https://x/',
        title: `page in ${host.id}`,
        elements: host.elements ?? [
          { ref: 'e1', role: 'textbox', name: 'Search', tag: 'input', value: 'hello' },
          { ref: 'e2', role: 'button', name: 'Submit', tag: 'button', disabled: true },
          { ref: 'e3', role: 'link', name: 'Home', tag: 'a' },
        ],
        truncated: host.truncated ?? true,
      });
    }
    case 'navigate': {
      const tabId = request.args?.['tabId'] as number;
      const url = request.args?.['url'] as string;
      return ok({ tabId, url, title: 'navigated', status: host.navigateStatus ?? 'complete' });
    }
    case 'closeTab':
      return ok({ closed: request.args?.['tabId'] });
    case 'click': {
      const tabId = request.args?.['tabId'] as number;
      const ref = request.args?.['ref'] as string;
      return ok({ tabId, ref, dispatched: true, hit: 'covered', topmost: 'dialog' });
    }
    case 'typeText':
      return ok({ tabId: request.args?.['tabId'], typed: String(request.args?.['text'] ?? '').length });
    case 'pressKey':
      return ok({ tabId: request.args?.['tabId'], key: request.args?.['key'] });
    case 'scroll':
      return ok({ tabId: request.args?.['tabId'], dx: request.args?.['dx'] ?? 0, dy: request.args?.['dy'] ?? 400 });
    case 'screenshot': {
      const format = request.args?.['format'] ?? 'png';
      return ok({ tabId: request.args?.['tabId'], format, base64: 'aW1hZ2U=', bytes: 5 });
    }
    case 'evaluate':
      return ok({
        tabId: request.args?.['tabId'],
        value: 'result',
        type: 'string',
        threw: request.args?.['expression'] === 'throw new Error()',
      });
    case 'consoleMessages':
      return ok({
        tabId: request.args?.['tabId'],
        attachedNow: false,
        messages: [{ level: 'warning', text: 'x'.repeat(205), at: 0 }],
      });
    case 'networkRequests':
      return ok({
        tabId: request.args?.['tabId'],
        attachedNow: false,
        requests: [{ method: 'GET', url: 'https://example.com/api?token=secret', status: 200, at: 0 }],
      });
    case 'groupTabs':
      return ok({ groupId: 7, title: request.args?.['title'] ?? 'Yoke', tabIds: request.args?.['tabIds'] });
    case 'ungroupTabs':
      return ok({ tabIds: request.args?.['tabIds'] });
    case 'release':
      return ok({ tabId: request.args?.['tabId'], released: host.releaseResult ?? true });
    case 'openTab': {
      const id = host.nextTabId ?? 900;
      const tab = { id, windowId: 1, url: String(request.args?.['url'] ?? ''), title: 'new' };
      // The listing must show it afterwards, as a real browser's would.
      host.tabs.push(tab);
      const groupId = host.openedGroupId === null ? undefined : host.openedGroupId ?? 1;
      return ok({ tab: { ...tab, groupId: groupId ?? -1 }, groupId, groupTitle: 'yoke' });
    }
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

// Deep enough that a host which grows its tab list does not leak into the next test.
const fresh = (host: FakeHost): FakeHost => ({ ...host, tabs: host.tabs.map((tab) => ({ ...tab })), received: [] });

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

test('read_page formats element values, disabled state, and truncation', { skip }, async () => {
  await withHosts([fresh(work)], async () => {
    const page = await call('read_page', { tab_id: 11, max_elements: 2 });
    assert.equal(page.isError, undefined);
    assert.match(page.content[0]?.text ?? '', /page in a1b2c3d4/);
    assert.match(page.content[0]?.text ?? '', /e1\ttextbox\tSearch\tvalue="hello"/);
    assert.match(page.content[0]?.text ?? '', /e2\tbutton\tSubmit\tdisabled/);
    assert.match(page.content[0]?.text ?? '', /\[truncated; raise max_elements\]/);
  });
});

test('tab tools format navigation, input, screenshots, console, network, groups, and release', { skip }, async () => {
  const host = fresh(work);
  host.groups = [{ id: 7, title: 'Yoke', color: 'cyan', windowId: 1, collapsed: false }];
  await withHosts([host], async () => {
    const groups = await call('list_tab_groups');
    assert.match(groups.content[0]?.text ?? '', /7\t"Yoke"\tcyan\t0 tab\(s\)/);

    const invalidNavigation = await call('navigate', { tab_id: 11, url: 'chrome://settings' });
    assert.equal(invalidNavigation.isError, true);
    assert.match(invalidNavigation.content[0]?.text ?? '', /http or https/);
    const navigation = await call('navigate', { tab_id: 11, url: 'https://example.com/next?token=secret', timeout_ms: 50 });
    assert.match(navigation.content[0]?.text ?? '', /Navigated tab 11 to https:\/\/example.com\/next/);

    host.navigateStatus = 'timeout';
    const timedOut = await call('navigate', { tab_id: 11, url: 'https://example.com/slow' });
    assert.match(timedOut.content[0]?.text ?? '', /did not report finishing loading/);

    const clicked = await call('click', { tab_id: 11, ref: 'e1', button: 'right', click_count: 2 });
    assert.match(clicked.content[0]?.text ?? '', /dialog was on top/);
    const typed = await call('type_text', { tab_id: 11, ref: 'e1', text: 'hello', press_enter: true });
    assert.match(typed.content[0]?.text ?? '', /Typed 5 character\(s\) and pressed Enter/);
    const key = await call('press_key', { tab_id: 11, ref: 'e1', key: 'Escape' });
    assert.match(key.content[0]?.text ?? '', /Pressed Escape/);
    const scrolled = await call('scroll', { tab_id: 11, dx: 0, dy: 250 });
    assert.match(scrolled.content[0]?.text ?? '', /Scrolled/);

    const screenshot = await call('screenshot', { tab_id: 11, format: 'jpeg', quality: 70 });
    assert.equal(screenshot.images?.[0]?.format, 'jpeg');
    const evaluated = await call('run_javascript', { tab_id: 11, expression: '1 + 1' });
    assert.match(evaluated.content[0]?.text ?? '', /string: result/);
    const threw = await call('run_javascript', { tab_id: 11, expression: 'throw new Error()' });
    assert.match(threw.content[0]?.text ?? '', /threw: result/);

    const console = await call('read_console', { tab_id: 11, limit: 3 });
    assert.equal((console.content[0]?.text ?? '').length <= 260, true);
    assert.match(console.content[0]?.text ?? '', /warning\t/);
    const network = await call('read_network', { tab_id: 11, limit: 3 });
    assert.match(network.content[0]?.text ?? '', /200\tGET\thttps:\/\/example.com\/api/);
    assert.doesNotMatch(network.content[0]?.text ?? '', /secret/);

    const grouped = await call('group_tabs', { tab_ids: [11], title: 'Review', color: 'blue' });
    assert.match(grouped.content[0]?.text ?? '', /group 7 "Review"/);
    const ungrouped = await call('ungroup_tabs', { tab_ids: [11] });
    assert.match(ungrouped.content[0]?.text ?? '', /Ungrouped 1 tab/);
    const closed = await call('close_tab', { tab_id: 11 });
    assert.match(closed.content[0]?.text ?? '', /Closed tab 11/);
    const released = await call('release_tab', { tab_id: 11 });
    assert.match(released.content[0]?.text ?? '', /Released tab 11/);
    host.releaseResult = false;
    const alreadyReleased = await call('release_tab', { tab_id: 11 });
    assert.match(alreadyReleased.content[0]?.text ?? '', /was not being driven/);

    host.openedGroupId = null;
    const unknownGroup = await call('open_tab', { url: 'https://example.com/unknown' });
    assert.match(unknownGroup.content[0]?.text ?? '', /grouping unknown/);
    host.openedGroupId = -1;
    const refusedGroup = await call('open_tab', { url: 'https://example.com/refused' });
    assert.match(refusedGroup.content[0]?.text ?? '', /Chrome refused/);
  });
});

test('find filters case insensitively and omits the truncation note for a complete page', { skip }, async () => {
  const host = { ...fresh(work), truncated: false };
  await withHosts([host], async () => {
    const found = await call('find', { tab_id: 11, text: 'SUBMIT' });
    const text = found.content[0]?.text ?? '';
    assert.equal(found.isError, undefined);
    assert.match(text, /1 element\(s\)/);
    assert.match(text, /e2\tbutton\tSubmit\tdisabled/);
    assert.doesNotMatch(text, /Search|Home|truncated/);
  });
});

test('find reports an empty match and read_page reports an empty page', { skip }, async () => {
  await withHosts([fresh(work)], async () => {
    const missing = await call('find', { tab_id: 11, text: 'not found' });
    assert.match(missing.content[0]?.text ?? '', /Nothing on this page matches "not found"/);
  });

  const empty = { ...fresh(work), elements: [] };
  await withHosts([empty], async () => {
    const page = await call('read_page', { tab_id: 11 });
    assert.equal(page.content[0]?.text, 'No interactive elements found on this page.');
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

test('a label two profiles share is refused for open_tab, with the ids to choose from', { skip }, async () => {
  const twin: FakeHost = { ...fresh(work), id: 'c0ffee00', label: 'personal' };
  await withHosts([twin, fresh(personal)], async () => {
    const ambiguous = await call('open_tab', { url: 'https://example.com', browser: 'personal' });
    assert.equal(ambiguous.isError, true);
    assert.match(ambiguous.content[0]?.text ?? '', /2 connected browsers are labelled "personal"/);
    assert.match(ambiguous.content[0]?.text ?? '', /c0ffee00/);
    assert.match(ambiguous.content[0]?.text ?? '', /e5f6a7b8/);
    const byId = await call('open_tab', { url: 'https://example.com', browser: 'e5f6a7b8' });
    assert.equal(byId.isError, undefined);
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

test('a browser that connects after a tab was placed is noticed, and a new collision refused', { skip }, async () => {
  const brave: FakeHost = {
    id: 'ffffffff',
    label: 'brave',
    tabs: [{ id: 11, windowId: 7, url: 'https://example.org/', title: 'same id, other browser' }],
    received: [],
  };
  const a = fresh(work);
  await withHosts([a], async (dir) => {
    // Placed while only one browser is connected.
    const first = await call('get_page_text', { tab_id: 11 });
    assert.equal(first.isError, undefined);
    // A second browser connects with a tab of the same id. Nothing has relisted.
    const late = await serve(dir, brave);
    try {
      const second = await call('get_page_text', { tab_id: 11 });
      assert.equal(second.isError, true, 'the cached placement must not be trusted once the browsers changed');
      assert.match(second.content[0]?.text ?? '', /a1b2c3d4/);
      assert.match(second.content[0]?.text ?? '', /brave/);
      assert.equal(a.received.filter((op) => op === 'getPageText').length, 1, 'the ambiguous call was not sent');
    } finally {
      late.close();
    }
  });
});

test('a tab open_tab creates in one browser with an id cached for another is refused, not misrouted', { skip }, async () => {
  const a = fresh(work);
  // Brave has its own id counter, and its next id happens to be one Chrome already has.
  const brave: FakeHost = { id: 'ffffffff', label: 'brave', tabs: [], received: [], nextTabId: 11 };
  await withHosts([a, brave], async () => {
    const first = await call('get_page_text', { tab_id: 11 });
    assert.equal(first.isError, undefined, 'placed 11 in work');
    const opened = await call('open_tab', { url: 'https://example.com', browser: 'brave' });
    assert.match(opened.content[0]?.text ?? '', /Opened tab 11/);
    // Endpoints on disk are unchanged, so only forgetting the id can save this.
    const second = await call('get_page_text', { tab_id: 11 });
    assert.equal(second.isError, true, 'the stale placement must not win');
    assert.match(second.content[0]?.text ?? '', /a1b2c3d4/);
    assert.match(second.content[0]?.text ?? '', /brave/);
    assert.equal(a.received.filter((op) => op === 'getPageText').length, 1, 'work was not asked again');
  });
});

test('group and ungroup refuse tabs that live in different browsers, naming where each is', { skip }, async () => {
  const a = fresh(work);
  const b = fresh(personal);
  await withHosts([a, b], async () => {
    const grouped = await call('group_tabs', { tab_ids: [11, 200] });
    assert.equal(grouped.isError, true);
    assert.match(grouped.content[0]?.text ?? '', /11 .*a1b2c3d4/);
    assert.match(grouped.content[0]?.text ?? '', /200 .*personal/);
    const ungrouped = await call('ungroup_tabs', { tab_ids: [200, 11] });
    assert.equal(ungrouped.isError, true);
    assert.ok(!a.received.includes('groupTabs') && !b.received.includes('groupTabs'), 'nothing was dispatched');
    assert.ok(!a.received.includes('ungroupTabs') && !b.received.includes('ungroupTabs'), 'nothing was dispatched');
    // Same browser: dispatched to it, once.
    const missing = await call('group_tabs', { tab_ids: [11, 999] });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0]?.text ?? '', /999/);
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
        // The same sentence from every tool, not merely one that reads alike:
        // the wording is what tells a user which of the two causes they have.
        (failure: Error) => failure.message === NOT_CONNECTED,
        `${tool} must answer with the unreachable message`,
      );
    }
  });
});
