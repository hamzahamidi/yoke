// The extension half, with a fake `chrome` and no browser.
//
// The worker is a module with top level side effects: importing it is what makes
// it connect, so each test imports a fresh copy against a fresh fake. A query
// string on the specifier buys that second copy, because ESM caches by URL.
import assert from 'node:assert/strict';
import { test } from 'node:test';

interface Listeners<T extends unknown[]> {
  addListener(listener: (...args: T) => void): void;
  /** How many the module registered, which is what decides whether Chrome can wake it. */
  count(): number;
  fire(...args: T): void;
}

function slot<T extends unknown[]>(): Listeners<T> {
  const listeners: Array<(...args: T) => void> = [];
  return {
    addListener: (listener) => { listeners.push(listener); },
    count: () => listeners.length,
    fire: (...args) => { for (const listener of listeners) { listener(...args); } },
  };
}

interface FakePort {
  onMessage: Listeners<[unknown]>;
  onDisconnect: Listeners<[]>;
  postMessage(message: unknown): void;
}

interface Fake {
  /** One entry per `connectNative` that was allowed to succeed, newest last. */
  ports: FakePort[];
  tabs: {
    onActivated: Listeners<[unknown]>;
    onCreated: Listeners<[unknown]>;
    onUpdated: Listeners<[number, unknown, unknown]>;
  };
}

/**
 * Everything the worker touches while loading, and nothing else.
 *
 * Loading reaches `chrome.debugger` and `chrome.tabs` through the modules the
 * worker imports, so those have to answer even though no test drives them.
 */
function install(refuseFirstConnect = false): Fake {
  const ports: FakePort[] = [];
  let refusals = refuseFirstConnect ? 1 : 0;
  const tabs = {
    onActivated: slot<[unknown]>(),
    onCreated: slot<[unknown]>(),
    onUpdated: slot<[number, unknown, unknown]>(),
  };
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      lastError: undefined,
      connectNative: (): FakePort => {
        if (refusals > 0) {
          refusals -= 1;
          // What Chrome throws when it has no manifest for the host.
          throw new Error('Specified native messaging host not found.');
        }
        const port: FakePort = {
          onMessage: slot<[unknown]>(),
          onDisconnect: slot<[]>(),
          postMessage: () => {},
        };
        ports.push(port);
        return port;
      },
      onMessage: slot<[unknown, unknown, unknown]>(),
      onStartup: slot<[]>(),
      onInstalled: slot<[]>(),
    },
    tabs: { ...tabs, onRemoved: slot<[number]>() },
    windows: { onCreated: slot<[unknown]>(), getAll: async () => [{ id: 1 }] },
    debugger: { onEvent: slot<[unknown, string, unknown]>(), onDetach: slot<[unknown]>() },
  };
  return { ports, tabs };
}

let copy = 0;

/** The worker, freshly loaded, after its opening attempt at the host has settled. */
async function load(refuseFirstConnect = false): Promise<Fake> {
  const fake = install(refuseFirstConnect);
  await import(`../extension/browser/background.js?copy=${++copy}`);
  // It asks `chrome.windows.getAll` before it connects, so the attempt lands a
  // turn of the loop after the import resolves.
  await settle();
  return fake;
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

test('it asks Chrome to wake it when somebody uses the browser', async () => {
  const fake = await load();

  assert.ok(fake.tabs.onActivated.count() > 0, 'a tab switch should be able to start the worker');
  assert.ok(fake.tabs.onCreated.count() > 0, 'a new tab should be able to start the worker');
});

test('a tab switch reaches the host when the opening attempt failed', async () => {
  const fake = await load(true);
  assert.equal(fake.ports.length, 0, 'the opening attempt was refused');

  fake.tabs.onActivated.fire({ tabId: 7, windowId: 1 });
  await settle();

  assert.equal(fake.ports.length, 1, 'a tab switch should make it try the host again');
});

test('a new tab reaches the host when the opening attempt failed', async () => {
  const fake = await load(true);

  fake.tabs.onCreated.fire({ id: 8, windowId: 1 });
  await settle();

  assert.equal(fake.ports.length, 1, 'a new tab should make it try the host again');
});

test('browsing does not pile up connections on a worker that has one', async () => {
  const fake = await load();
  assert.equal(fake.ports.length, 1, 'loading connects once');

  fake.tabs.onActivated.fire({ tabId: 7, windowId: 1 });
  fake.tabs.onCreated.fire({ id: 8, windowId: 1 });
  await settle();

  assert.equal(fake.ports.length, 1, 'a live port leaves nothing to reconnect');
});

test('browsing does not shorten the backoff of a worker that is already retrying', async () => {
  const fake = await load();

  fake.ports[0]?.onDisconnect.fire();
  fake.tabs.onActivated.fire({ tabId: 7, windowId: 1 });
  await settle();

  assert.equal(fake.ports.length, 1, 'the retry already scheduled owns the next attempt');
});
