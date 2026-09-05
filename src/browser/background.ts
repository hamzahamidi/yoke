// The extension: the only place that can reach the browser's own APIs.
//
// It exists because tab groups and trusted browser control are extension-only
// surface. Page JavaScript sees a `chrome` object holding nothing but
// loadTimes, csi and app; the DevTools Protocol has no tab-group domain at all;
// Chrome's AppleScript dictionary has no group vocabulary. So this is not a
// convenience layer, it is the only route.
//
// Two rules shape everything here. Nothing acts on a tab it was not given the id
// of, because "the active tab" means whatever the user happened to be looking
// at. And it answers questions rather than deciding things: policy, redaction
// and refusal live in the server, which is testable without a browser.
// Type-only, so nothing is emitted and the extension bundle stays a single file.
// Sharing the wire shapes with the server is what stops the two drifting.
import type { GroupInfo, Operations, Request, Response, TabInfo } from '../protocol.js';
import {
  attach, clickAt, consoleFor, detach, evaluate, insertText, networkFor,
  pressKey as dispatchKey, screenshot as capture, scrollBy, attachedTabIds,
} from './cdp.js';
import { collectSnapshot, locateRef, type Located } from './snapshot.js';
import { identity, setLabel } from './identity.js';
import type { PopupReply, PopupRequest } from './messages.js';

// Must match HOST_NAME in ../install.ts exactly: Chrome matches the string
// against the manifest filename it was registered under.
const HOST = 'io.github.hamzahamidi.yoke';

/** How long to wait for a navigation to report complete before giving up on it. */
const NAVIGATE_TIMEOUT_MS = 20_000;

let port: chrome.runtime.Port | undefined;

/** chrome.tabs ids are SessionID::id(), the same numbers Chrome's session file records. */
const describeTab = (tab: chrome.tabs.Tab): TabInfo => ({
  id: tab.id ?? -1,
  windowId: tab.windowId,
  groupId: tab.groupId ?? -1,
  title: tab.title ?? '',
  url: tab.url ?? tab.pendingUrl ?? '',
});

const describeGroup = (group: chrome.tabGroups.TabGroup): GroupInfo => ({
  id: group.id,
  title: group.title ?? '',
  color: group.color,
  windowId: group.windowId,
  collapsed: group.collapsed,
});

/**
 * Waits for a tab to finish loading.
 *
 * Resolving on `status === 'complete'` rather than on the navigate call
 * returning, because chrome.tabs.update resolves as soon as the navigation is
 * *started*. Returning then would have every caller racing the page it just
 * asked for.
 */
function waitForLoad(tabId: number, timeoutMs: number): Promise<'complete' | 'timeout'> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: 'complete' | 'timeout'): void => {
      if (settled) { return; }
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(outcome);
    };
    const listener = (changedId: number, change: chrome.tabs.TabChangeInfo): void => {
      if (changedId === tabId && change.status === 'complete') { finish('complete'); }
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    // The load may already have finished between the update and this listener.
    void chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') { finish('complete'); }
    }).catch(() => finish('timeout'));
  });
}

async function navigate(args: Operations['navigate']['args']): Promise<Operations['navigate']['result']> {
  const { tabId, url } = args;
  await chrome.tabs.update(tabId, { url });
  const status = await waitForLoad(tabId, args.timeoutMs ?? NAVIGATE_TIMEOUT_MS);
  const tab = await chrome.tabs.get(tabId);
  return { tabId, url: tab.url ?? url, title: tab.title ?? '', status };
}

/**
 * The label on the group holding tabs yoke opened.
 *
 * The tool's own name rather than a generic word: the pill exists to tell the
 * person which thing is working in their browser, and "agent" answers that with
 * nothing. Overridable per call, because someone running two of these at once
 * needs to tell them apart.
 */
const DEFAULT_GROUP_TITLE = 'yoke';

/**
 * The group with this title, creating it only if none exists.
 *
 * Reuse is keyed on the title within one window, which is the whole point: a
 * fresh group per call is exactly how the bridge this replaces left four
 * identical `Claude (MCP)` pills in the tab strip with no way to tell them
 * apart. Safe to do freely because nothing addresses a tab through its group.
 */
async function ensureGroup(
  tabIds: number[],
  title: string,
  windowId: number,
  color?: chrome.tabGroups.ColorEnum,
): Promise<{ groupId: number; title: string }> {
  // Scoped to one window because a group lives in one: a TabGroup carries a
  // single windowId. A query by title alone can match a group in a different
  // window, and joining that one would haul the tab out of the window it was
  // opened in, which is the rearranging this is meant to avoid.
  const existing = await chrome.tabGroups.query({ title, windowId });
  // Matched exactly rather than taken from the query, because query treats the
  // title as a pattern: a caller passing "*" would otherwise adopt and rename
  // whichever group it happened to match, which is the opposite of only ever
  // touching what we were pointed at.
  const found = existing.find((group) => group.title === title);
  const groupId = found === undefined
    ? await chrome.tabs.group({ tabIds })
    : await chrome.tabs.group({ tabIds, groupId: found.id });
  await chrome.tabGroups.update(groupId, {
    title,
    ...(color === undefined ? {} : { color }),
  });
  const group = await chrome.tabGroups.get(groupId);
  return { groupId, title: group.title ?? title };
}

async function openTab(args: Operations['openTab']['args']): Promise<Operations['openTab']['result']> {
  const created = await chrome.tabs.create({
    ...(args.url === undefined ? {} : { url: args.url }),
    // Defaults to a background tab: opening something in a script should not
    // yank focus away from whatever the person is doing.
    active: args.active ?? false,
    ...(args.windowId === undefined ? {} : { windowId: args.windowId }),
  });
  if (created.id !== undefined && args.url !== undefined) {
    await waitForLoad(created.id, NAVIGATE_TIMEOUT_MS);
  }
  const title = args.groupTitle ?? DEFAULT_GROUP_TITLE;
  let groupId = -1;
  let groupTitle = title;
  if (created.id !== undefined) {
    // Grouping is cosmetic, so a failure here must not fail the open: the tab
    // exists and is usable whether or not the strip shows a pill.
    try {
      const group = await ensureGroup([created.id], title, created.windowId, 'cyan');
      groupId = group.groupId;
      groupTitle = group.title;
    } catch { groupId = -1; }
  }
  const tab = created.id === undefined ? created : await chrome.tabs.get(created.id);
  return { tab: describeTab(tab), groupId, groupTitle };
}

/**
 * The page's visible text.
 *
 * innerText rather than textContent, because textContent includes script and
 * style bodies and ignores layout, so it returns something no reader would
 * recognise as the page.
 */
async function getPageText(
  args: Operations['getPageText']['args'],
): Promise<Operations['getPageText']['result']> {
  const { tabId } = args;
  const max = args.maxChars ?? 200_000;
  const [injected] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      text: document.body?.innerText ?? '',
      title: document.title,
      url: location.href,
    }),
  });
  const value = injected?.result as { text: string; title: string; url: string } | undefined;
  if (!value) {
    throw new Error(`nothing came back from tab ${tabId}; a chrome:// or Web Store page cannot be read`);
  }
  const truncated = value.text.length > max;
  return {
    tabId,
    url: value.url,
    title: value.title,
    text: truncated ? value.text.slice(0, max) : value.text,
    truncated,
  };
}

/**
 * Where a reference is, right now.
 *
 * Resolved in the page at the moment of use rather than taken from the snapshot,
 * because a page that has scrolled since would otherwise be clicked in the wrong
 * place, and the caller would have no way to tell.
 */
async function pointFor(tabId: number, ref: string): Promise<Located> {
  const [found] = await chrome.scripting.executeScript({
    target: { tabId },
    func: locateRef,
    args: [ref],
  });
  const point = found?.result as Located | undefined;
  if (!point?.found) {
    throw new Error(
      `${ref} is not on this page any more. Call read_page again: a navigation or a `
      + 're-render invalidates every reference from the previous snapshot.');
  }
  return point;
}

async function readPage(args: Operations['readPage']['args']): Promise<Operations['readPage']['result']> {
  const { tabId } = args;
  const max = args.maxElements ?? 200;
  const [injected] = await chrome.scripting.executeScript({
    target: { tabId },
    func: collectSnapshot,
    args: [max],
  });
  const snapshot = injected?.result as
    { url: string; title: string; elements: Array<Operations['readPage']['result']['elements'][number] & { x: number; y: number }> }
    | undefined;
  if (!snapshot) {
    throw new Error(`nothing came back from tab ${tabId}; Chrome's own pages cannot be read`);
  }
  // Coordinates stay inside the extension. A caller acts by reference.
  const elements = snapshot.elements.map(({ x: _x, y: _y, ...rest }) => rest);
  return {
    tabId,
    url: snapshot.url,
    title: snapshot.title,
    elements,
    truncated: elements.length >= max,
  };
}

/**
 * Operations that take control of a tab, so the strip should show it.
 *
 * Reading counts as control. Someone whose page is being read wants to know
 * which tab that is just as much as someone whose page is being clicked.
 *
 * closeTab is deliberately absent (grouping a tab we are about to remove says
 * nothing), and so are the list operations, which name no tab at all.
 */
const MARKS_TAB = new Set<Request['op']>([
  'navigate', 'getPageText', 'readPage', 'evaluate', 'screenshot',
  'click', 'typeText', 'pressKey', 'scroll', 'consoleMessages', 'networkRequests',
]);

/** Tabs already marked, so this costs three API calls per tab and not per call. */
const marked = new Set<number>();
chrome.tabs.onRemoved.addListener((tabId) => { marked.delete(tabId); });

/**
 * Puts a tab we are driving into the group, whether or not we opened it.
 *
 * The earlier rule was that a tab the user already had is never moved, on the
 * grounds that rearranging someone's browser is not honest. That had it
 * backwards: what the pill is for is showing which tabs are under automation,
 * and a tab being driven silently is the case that actually needs marking.
 * Provenance is not the point, control is.
 *
 * Never allowed to fail an operation. A tab that cannot be grouped is still a
 * tab the caller asked to work with.
 */
async function markTab(tabId: number): Promise<void> {
  if (marked.has(tabId)) { return; }
  marked.add(tabId);
  try {
    const tab = await chrome.tabs.get(tabId);
    await ensureGroup([tabId], DEFAULT_GROUP_TITLE, tab.windowId, 'cyan');
  } catch {
    // Left in `marked` on purpose: retrying on every later call would mean a
    // chrome.tabs.get per operation for a tab that cannot be grouped anyway.
  }
}

/**
 * Answers the popup.
 *
 * Kept apart from handle(): those messages arrive from the native host and cross
 * a trust boundary, these come from a page inside this extension. Sharing one
 * dispatcher would let the host reach operations meant only for the popup.
 */
chrome.runtime.onMessage.addListener((message: PopupRequest, _sender, respond) => {
  if (message?.kind === 'status') {
    void identity().then((who) => {
      const reply: PopupReply = {
        kind: 'status',
        connected: port !== undefined,
        version: chrome.runtime.getManifest().version,
        host: HOST,
        attached: attachedTabIds(),
        id: who.id,
        label: who.label,
      };
      respond(reply);
    });
    return true;
  }
  if (message?.kind === 'setLabel') {
    void setLabel(message.label).then((who) => {
      const reply: PopupReply = { kind: 'labelled', id: who.id, label: who.label };
      respond(reply);
    });
    return true;
  }
  if (message?.kind === 'releaseAll') {
    const held = attachedTabIds();
    void Promise.all(held.map((tabId) => detach(tabId))).then(() => {
      const reply: PopupReply = { kind: 'released', count: held.length };
      respond(reply);
    });
    // Keeps the channel open, because respond is called after the detaches.
    return true;
  }
  return false;
});

async function handle(message: Request): Promise<unknown> {
  const named = (message.args as { tabId?: number } | undefined)?.tabId;
  if (named !== undefined && MARKS_TAB.has(message.op)) { await markTab(named); }

  switch (message.op) {
    case 'ping':
      return {
        extension: chrome.runtime.getManifest().version,
        // Reported so a forgotten attachment is visible. An attached tab wears
        // Chrome's debugging bar and cannot be opened in DevTools, and nothing
        // used to say how many were in that state.
        attached: attachedTabIds(),
      };
    case 'identify': {
      // Asked by the host before it picks an endpoint, so this is the first
      // thing a fresh profile answers and it must not depend on anything else.
      const who = await identity();
      const [windows, tabs] = await Promise.all([chrome.windows.getAll(), chrome.tabs.query({})]);
      return { ...who, windows: windows.length, tabs: tabs.length };
    }
    case 'listTabs':
      return { tabs: (await chrome.tabs.query({})).map(describeTab) };
    case 'listGroups':
      return { groups: (await chrome.tabGroups.query({})).map(describeGroup) };
    case 'navigate':
      return navigate(message.args as Operations['navigate']['args']);
    case 'openTab':
      return openTab((message.args ?? {}) as Operations['openTab']['args']);
    case 'closeTab': {
      const { tabId } = message.args as Operations['closeTab']['args'];
      await chrome.tabs.remove(tabId);
      return { closed: tabId };
    }
    case 'getPageText':
      return getPageText(message.args as Operations['getPageText']['args']);
    case 'readPage':
      return readPage(message.args as Operations['readPage']['args']);

    case 'evaluate': {
      const { tabId, expression } = message.args as Operations['evaluate']['args'];
      const outcome = await evaluate(tabId, expression);
      return { tabId, ...outcome };
    }

    case 'screenshot': {
      const args = message.args as Operations['screenshot']['args'];
      const format = args.format ?? 'png';
      const shot = await capture(tabId2(args.tabId), format, args.quality);
      return {
        tabId: args.tabId,
        format: shot.format,
        base64: shot.base64,
        bytes: Math.floor((shot.base64.length * 3) / 4),
      };
    }

    case 'click': {
      const args = message.args as Operations['click']['args'];
      const point = await pointFor(args.tabId, args.ref);
      await clickAt(args.tabId, point, args.button ?? 'left', args.clickCount ?? 1);
      // What was on top is reported rather than swallowed. CDP says an event was
      // dispatched and nothing about what received it, so this is the only part
      // of the answer that is a claim about the page.
      return {
        tabId: args.tabId,
        ref: args.ref,
        dispatched: true,
        hit: point.hit ?? 'nothing',
        ...(point.topmost === undefined ? {} : { topmost: point.topmost }),
      };
    }

    case 'typeText': {
      const args = message.args as Operations['typeText']['args'];
      if (args.ref !== undefined) {
        const point = await pointFor(args.tabId, args.ref);
        await clickAt(args.tabId, point, 'left', 1);
      }
      await insertText(args.tabId, args.text);
      if (args.pressEnter === true) { await dispatchKey(args.tabId, 'Enter'); }
      return { tabId: args.tabId, typed: args.text.length };
    }

    case 'pressKey': {
      const args = message.args as Operations['pressKey']['args'];
      if (args.ref !== undefined) {
        const point = await pointFor(args.tabId, args.ref);
        await clickAt(args.tabId, point, 'left', 1);
      }
      await dispatchKey(args.tabId, args.key);
      return { tabId: args.tabId, key: args.key };
    }

    case 'scroll': {
      const args = message.args as Operations['scroll']['args'];
      const point = args.ref === undefined
        ? { x: 200, y: 300 }
        : await pointFor(args.tabId, args.ref);
      const dx = args.dx ?? 0;
      const dy = args.dy ?? 400;
      await scrollBy(args.tabId, point, dx, dy);
      return { tabId: args.tabId, dx, dy };
    }

    case 'consoleMessages': {
      const args = message.args as Operations['consoleMessages']['args'];
      const { attachedNow } = await attach(args.tabId);
      return { tabId: args.tabId, messages: consoleFor(args.tabId, args.limit ?? 100), attachedNow };
    }

    case 'networkRequests': {
      const args = message.args as Operations['networkRequests']['args'];
      const { attachedNow } = await attach(args.tabId);
      return { tabId: args.tabId, requests: networkFor(args.tabId, args.limit ?? 100), attachedNow };
    }

    case 'groupTabs': {
      const args = message.args as Operations['groupTabs']['args'];
      const members = await Promise.all(args.tabIds.map((id) => chrome.tabs.get(id)));
      const first = members[0];
      if (first === undefined) {
        throw new Error('groupTabs needs at least one tab id');
      }
      // Refused rather than resolved by picking a window, because a group holds
      // tabs from one window and the only way to satisfy this request would be
      // to move the others there.
      const windows = new Set(members.map((tab) => tab.windowId));
      if (windows.size > 1) {
        throw new Error(
          `those ${args.tabIds.length} tabs are spread across ${windows.size} windows, and a group `
          + 'holds tabs from one window. Group them a window at a time.');
      }
      const group = await ensureGroup(
        args.tabIds,
        args.title ?? DEFAULT_GROUP_TITLE,
        first.windowId,
        args.color as chrome.tabGroups.ColorEnum | undefined,
      );
      return { groupId: group.groupId, title: group.title, tabIds: args.tabIds };
    }

    case 'ungroupTabs': {
      const args = message.args as Operations['ungroupTabs']['args'];
      await chrome.tabs.ungroup(args.tabIds);
      return { tabIds: args.tabIds };
    }

    case 'release': {
      const args = message.args as Operations['release']['args'];
      return { tabId: args.tabId, released: await detach(args.tabId) };
    }

    default:
      throw new Error(`unknown op ${String(message.op)}`);
  }
}

/** Narrows a tab id that has already been validated by the server. */
const tabId2 = (value: number): number => value;

/**
 * Whether this profile has anything to drive.
 *
 * A profile with no windows cannot be driven and cannot show anything: the tab
 * group that tells the user which tabs are under automation has nowhere to
 * appear, and list_tabs answers nothing. Chrome keeps such a profile's service
 * worker alive, so without this check a windowless profile can win the endpoint
 * and the caller drives an invisible browser. Observed exactly that way:
 * list_tab_groups answered "No current window" while the visible window held 40
 * tabs.
 */
async function hasWindows(): Promise<boolean> {
  try {
    return (await chrome.windows.getAll()).length > 0;
  } catch {
    // If the question cannot be answered, connecting is the lesser risk: a
    // profile that will not connect is useless, and this check is a tiebreak
    // rather than a safety property.
    return true;
  }
}

/** Grows on each failed attempt, resets once a connection holds. */
let retryDelayMs = 1_000;
const MAX_RETRY_MS = 60_000;

function connect(): void {
  if (port) { return; }
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch (failure) {
    console.log('yoke: native host unavailable', failure);
    return;
  }
  // Reset here rather than on the first message, because a port that opens is
  // the thing being retried. A host that then exits raises the delay again.
  retryDelayMs = 1_000;

  port.onMessage.addListener((message: Request) => {
    if (message?.id === undefined) { return; }
    void handle(message)
      .then((data) => {
        const reply: Response = { id: message.id, ok: true, data };
        port?.postMessage(reply);
      })
      .catch((thrown: unknown) => {
        const reply: Response = {
          id: message.id,
          ok: false,
          error: thrown instanceof Error ? thrown.message : String(thrown),
        };
        port?.postMessage(reply);
      });
  });

  // An open port keeps the service worker alive, and a dropped port means the
  // host went away. Reconnecting on a delay is what lets `install` followed by a
  // first call work without reloading the extension by hand.
  port.onDisconnect.addListener(() => {
    port = undefined;
    // Read, not ignored. Chrome logs "Unchecked runtime.lastError: Native host
    // has exited" for every disconnect nobody inspects, so a profile that cannot
    // get the host filled the extension's error list once per retry.
    const reason = chrome.runtime.lastError?.message ?? 'the host disconnected';
    retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_MS);
    console.log(`yoke: ${reason}. Retrying in ${retryDelayMs / 1_000}s`);
    // Backoff rather than a fixed second. The common reason for a host that
    // exits immediately is another Chrome profile already owning the endpoint,
    // which does not resolve by asking again quickly, and hammering it turned one
    // problem into a log full of them.
    setTimeout(connectWhenDrivable, retryDelayMs);
  });
}

chrome.runtime.onStartup.addListener(() => { connectWhenDrivable(); });
chrome.runtime.onInstalled.addListener(() => { connectWhenDrivable(); });
/**
 * Connects only from a profile that has a window, and waits for one otherwise.
 *
 * Each profile has its own endpoint, so this is no longer about who wins one.
 * It is about not offering a browser nobody can see: a windowless profile would
 * appear in list_browsers with nothing in it and nowhere to draw the tab group.
 */
function connectWhenDrivable(): void {
  void hasWindows().then((yes) => {
    if (yes) { connect(); return; }
    console.log('yoke: this profile has no windows, so it is leaving the host to another profile');
  });
}

chrome.windows.onCreated.addListener(() => { connectWhenDrivable(); });

connectWhenDrivable();
