// Which Chrome profile a call goes to.
//
// Chrome starts one native host per profile, so with the extension loaded in
// two profiles there are two endpoints, and a caller has to end up at the right
// one. The rule is the one the rest of the project already lives by: a tab is
// named by id, and the id decides. Chrome hands out tab ids from one counter for
// the whole browser process, so two profiles of the same Chrome never share one,
// and the server can route on it without a selected browser or a `browser`
// argument on every tool. Only a call that names no tab, open_tab, has to be
// told where.
//
// Two different browsers (Chrome and Brave, say) do each have their own counter,
// so a collision is possible there. It is detected and refused rather than
// guessed at.
import { LEGACY_ID, endpointIdOf, listEndpoints } from './socket-path.js';
import { ask, ExtensionUnavailable } from './socket-client.js';
import type { ArgsOf, OperationName, ResultOf, TabInfo } from './protocol.js';

export interface Browser {
  endpoint: string;
  /** Random, minted by the extension, stable for the life of the profile. */
  id: string;
  /** Typed into the popup by the person. Empty until they do. */
  label: string;
  windows: number;
  tabs: number;
  /** The extension predates `identify`, so id and label are the host's fallback. */
  unidentified: boolean;
}

/** A tab with the browser it lives in. */
export interface PlacedTab extends TabInfo {
  browser: Browser;
}

/** The name a person or a model would use for a browser in output. */
export const displayName = (browser: Browser): string =>
  browser.label === '' ? browser.id : browser.label;

/** Refused because the tab is not, or is ambiguously, anywhere. */
export class NoSuchTab extends Error {
  override readonly name = 'NoSuchTab';
}

/** Refused because the caller named no browser when it had to, or named one that is not there. */
export class NoSuchBrowser extends Error {
  override readonly name = 'NoSuchBrowser';
}

/** Stands in for an endpoint when two browsers both claim the tab id. */
const AMBIGUOUS = '\0ambiguous';

/**
 * Which endpoint holds each tab id, as of the last time anyone looked.
 *
 * The only thing remembered between calls. Identity is asked for afresh each
 * time a browser is listed, because the label is typed into the popup while the
 * server is running, and a cached one would keep answering with the old name.
 */
let placement = new Map<number, string>();

/** Drops every cached fact. For tests, which change the endpoint directory. */
export function forget(): void {
  placement = new Map();
}

async function identify(endpoint: string): Promise<Browser | undefined> {
  try {
    const who = await ask(endpoint, 'identify', {}, { timeoutMs: 3_000 });
    return { endpoint, ...who, unidentified: false };
  } catch (failure) {
    // A dead socket is a corpse and is skipped. A live host whose extension
    // does not know the op is a browser we can still drive, so it is kept under
    // the id the host itself fell back to.
    if (failure instanceof ExtensionUnavailable) { return undefined; }
    return {
      endpoint,
      id: endpointIdOf(endpoint) ?? LEGACY_ID,
      label: '',
      windows: 0,
      tabs: 0,
      unidentified: true,
    };
  }
}

/** Every browser that answers, in a stable order. */
export async function connectedBrowsers(): Promise<Browser[]> {
  const answered = await Promise.all(listEndpoints().map((endpoint) => identify(endpoint)));
  return answered.filter((browser): browser is Browser => browser !== undefined);
}

/**
 * Every tab in every connected browser, each knowing where it lives.
 *
 * Also refreshes the routing table, so a list is what teaches the router about
 * new tabs, and a tool called on a tab nobody has listed yet triggers one.
 */
export async function allTabs(): Promise<{ browsers: Browser[]; tabs: PlacedTab[] }> {
  const browsers = await connectedBrowsers();
  const listed = await Promise.all(browsers.map(async (browser) => {
    try {
      const { tabs } = await ask(browser.endpoint, 'listTabs', {}, { timeoutMs: 5_000 });
      return tabs.map((tab): PlacedTab => ({ ...tab, browser }));
    } catch (failure) {
      // Gone between identify and now. Not an error in the listing.
      if (failure instanceof ExtensionUnavailable) { return []; }
      throw failure;
    }
  }));
  const tabs = listed.flat();
  placement = new Map();
  for (const tab of tabs) {
    const already = placement.get(tab.id);
    if (already === undefined) {
      placement.set(tab.id, tab.browser.endpoint);
    } else if (already !== tab.browser.endpoint) {
      // Two browsers with the same id: marked so nothing routes to either.
      placement.set(tab.id, AMBIGUOUS);
    }
  }
  return { browsers, tabs };
}

/**
 * The one browser a tabless call should go to.
 *
 * With one connected there is nothing to choose. With more, the caller has to
 * say, by id or by label, because picking for them is how a tab ends up opened
 * in a profile nobody is looking at.
 */
export async function chooseBrowser(selector: unknown, tool: string): Promise<Browser> {
  const browsers = await connectedBrowsers();
  if (browsers.length === 0) {
    throw new ExtensionUnavailable(
      'the extension is not connected. Run `yoke install`, then load it in Chrome.');
  }
  if (selector === undefined || selector === '') {
    const only = browsers[0];
    if (browsers.length === 1 && only !== undefined) { return only; }
    const names = browsers.map((browser) => `${displayName(browser)} (${browser.tabs} tab(s))`).join(', ');
    throw new NoSuchBrowser(
      `${browsers.length} browsers are connected: ${names}. ${tool} opens a tab in one of them, so pass `
      + 'browser with an id or label from list_browsers.');
  }
  const wanted = String(selector);
  const byId = browsers.find((browser) => browser.id === wanted);
  if (byId !== undefined) { return byId; }
  // Labels are typed by a person and nothing stops two profiles getting the
  // same one, so a label that fits more than one is refused with the ids,
  // which cannot collide.
  const byLabel = browsers.filter((browser) => browser.label.toLowerCase() === wanted.toLowerCase());
  if (byLabel.length > 1) {
    const ids = byLabel.map((browser) => `${browser.id} (${browser.tabs} tab(s))`).join(', ');
    throw new NoSuchBrowser(
      `${byLabel.length} connected browsers are labelled ${JSON.stringify(wanted)}: ${ids}. Pass the id of the one you mean.`);
  }
  const match = byLabel[0];
  if (match === undefined) {
    const names = browsers.map((browser) => displayName(browser)).join(', ');
    throw new NoSuchBrowser(`no connected browser is ${JSON.stringify(wanted)}. Connected: ${names}.`);
  }
  return match;
}

/**
 * The endpoint holding a tab.
 *
 * The routing table is filled by listing, so a tab the caller learnt about from
 * list_tabs is already placed. One that is not gets a fresh listing before it is
 * declared missing, because a tab the person opened a moment ago is a perfectly
 * good thing to be asked about.
 */
export async function endpointForTab(tabId: number): Promise<string> {
  let endpoint = placement.get(tabId);
  if (endpoint === undefined) {
    await allTabs();
    endpoint = placement.get(tabId);
  }
  if (endpoint === AMBIGUOUS) {
    const { tabs } = await allTabs();
    const owners = tabs.filter((tab) => tab.id === tabId).map((tab) => displayName(tab.browser));
    throw new NoSuchTab(
      `tab ${tabId} exists in ${owners.length} connected browsers at once (${owners.join(', ')}), which `
      + 'happens when two different browsers both run the extension. Nothing is sent, because it '
      + 'cannot be sent to both. Disable the extension in one of them, or close that tab in one.');
  }
  if (endpoint !== undefined) { return endpoint; }
  if ((await connectedBrowsers()).length === 0) {
    throw new ExtensionUnavailable(
      'the extension is not connected. Run `yoke install`, then load it in Chrome.');
  }
  throw new NoSuchTab(`tab ${tabId} is not open in any connected browser. Call list_tabs for ids that are.`);
}

/** Sends an operation to whichever browser holds the tab it names. */
export async function askTab<K extends OperationName>(
  op: K,
  args: ArgsOf<K> & { tabId: number },
  options: { timeoutMs?: number } = {},
): Promise<ResultOf<K>> {
  const endpoint = await endpointForTab(args.tabId);
  try {
    return await ask(endpoint, op, args, options);
  } catch (failure) {
    // The host may have gone since the tab was placed. Once more from a fresh
    // listing, and after that the failure is the answer.
    if (!(failure instanceof ExtensionUnavailable)) { throw failure; }
    placement.delete(args.tabId);
    return ask(await endpointForTab(args.tabId), op, args, options);
  }
}
