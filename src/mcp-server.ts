// A stdio MCP server for the browser you are already signed in to.
//
// Register this with any MCP client and it gets browser automation against your
// real Chrome profile: every tab in every window is addressable, each one named
// by id, and nothing is acted on that a caller did not name.
//
// Three processes, because Chrome's rules say so:
//
//   extension  --connectNative-->  native-host  --unix socket-->  this server
//
// Chrome will only ever spawn the native host itself, so a client cannot talk to
// the extension directly and the socket in between is not optional.
import { createInterface } from 'node:readline';

import {
  allTabs, askTab, chooseBrowser, displayName, endpointForTabs, unplace,
  NoSuchBrowser, NoSuchTab, type Browser,
} from './browsers.js';
import { ask, ExtensionUnavailable } from './socket-client.js';

export const SERVER_NAME = 'yoke';
export const SERVER_VERSION = '0.1.4';
export const PROTOCOL_VERSION = '2024-11-05';

/**
 * The label on the group holding tabs yoke opened.
 *
 * Decided here rather than in the extension because it is policy, and policy
 * belongs where it can be changed and tested without reloading a browser. The
 * extension keeps the same value as a fallback, for a caller that names nothing.
 */
export const DEFAULT_GROUP_TITLE = 'yoke';

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  /** Present only for tools that return an image, such as screenshot. */
  images?: Array<{ format: string; base64: string }>;
  isError?: boolean;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number;
  method: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

/** origin and path only, so a tab listing never leaks a token in a query string. */
export function shownUrl(url: string, full = false): string {
  if (full) { return url; }
  try {
    const parsed = new URL(url);
    // A wrapper scheme's path can itself be a URL with credentials in it, so
    // anything that is not plain http shows only its scheme.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') { return parsed.protocol; }
    return `${parsed.origin}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return '(unparseable url)';
  }
}

export const TOOLS = [
  {
    name: 'list_browsers',
    description:
      'The Chrome profiles yoke is connected to, one line each: id, label, how many tabs and '
      + 'windows it has, and the sites it mostly has open, so a profile can be recognised even '
      + 'before anyone has named it. Usually one. When there are more, list_tabs covers all of '
      + 'them and every tab tool routes by tab id on its own; only open_tab needs to be told which '
      + 'browser, by id or label. The label is set in the extension popup in that profile.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_tabs',
    description:
      'List every open tab in the browser, across all windows, with its id, title and URL. '
      + 'Any tab it returns can be passed straight to the other tools. With more than one '
      + 'Chrome profile connected, every profile is included and each row names its browser. '
      + 'URLs are reduced to origin and path by default, '
      + 'because a raw URL can carry credentials, a session token or a query string; pass '
      + 'full_urls to opt out.',
    inputSchema: {
      type: 'object',
      properties: {
        full_urls: {
          type: 'boolean',
          default: false,
          description: 'Return raw URLs instead of origin and path.',
        },
      },
    },
  },
  {
    name: 'list_tab_groups',
    description:
      "List the browser's tab groups with their ids, titles and colours, including groups that "
      + 'hold no tabs, which nothing outside an extension can see.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'navigate',
    description:
      'Navigate one tab to a URL and wait for it to finish loading. The tab is named by id, '
      + 'never implied: there is no acting on "the active tab", because that is whatever the '
      + 'person happens to be looking at. Returns once the load reports complete, so a caller '
      + 'is not left racing the page it just asked for.',
    inputSchema: {
      type: 'object',
      required: ['tab_id', 'url'],
      properties: {
        tab_id: { type: 'number', description: 'From list_tabs.' },
        url: { type: 'string', description: 'http and https only.' },
        timeout_ms: { type: 'number', description: 'How long to wait for the load. Default 20000.' },
      },
    },
  },
  {
    name: 'open_tab',
    description:
      'Open a new tab, optionally at a URL. Opens in the background by default, because a '
      + 'script should not pull focus away from what someone is doing. The new tab joins a named '
      + 'group, created if absent and reused if present, so the tab strip shows which tabs an '
      + 'automation is working in. Any tab these tools then drive or read joins that group too, '
      + 'whether or not it was opened here, so what is under automation is always visible.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        active: { type: 'boolean', default: false, description: 'Focus the new tab.' },
        group_title: {
          type: 'string',
          default: 'yoke',
          description: 'The label on the group. Defaults to yoke, so the tab strip names what is driving it.',
        },
        browser: {
          type: 'string',
          description:
            'Which Chrome profile to open the tab in, by id or label from list_browsers. Needed '
            + 'only when more than one is connected; with one, it is implied.',
        },
      },
    },
  },
  {
    name: 'close_tab',
    description: 'Close one tab by id.',
    inputSchema: {
      type: 'object',
      required: ['tab_id'],
      properties: { tab_id: { type: 'number' } },
    },
  },
  {
    name: 'read_page',
    description:
      'The interactive elements of a page: links, buttons, inputs, each with a ref, a role and a '
      + 'name. Call this before clicking or typing, and act by ref rather than by coordinate. A '
      + 'coordinate is a guess that one reflow invalidates, and afterwards you cannot tell whether '
      + 'you hit what you meant; a ref resolves to the element that was described. Refs are only '
      + 'valid until the page navigates or re-renders.',
    inputSchema: {
      type: 'object',
      required: ['tab_id'],
      properties: {
        tab_id: { type: 'number' },
        max_elements: { type: 'number', description: 'Default 200.' },
      },
    },
  },
  {
    name: 'find',
    description:
      'The elements of a page whose name or role matches some text. A filtered read_page, for '
      + 'when you know what you are looking for.',
    inputSchema: {
      type: 'object',
      required: ['tab_id', 'text'],
      properties: { tab_id: { type: 'number' }, text: { type: 'string' } },
    },
  },
  {
    name: 'click',
    description:
      'Click an element by ref from read_page. Produces a real, trusted click through the '
      + 'DevTools Protocol, which pages cannot tell from a person; a synthesised event from page '
      + 'JavaScript arrives with isTrusted false and many sites ignore it. Attaching the debugger '
      + 'shows Chrome\'s "started debugging this browser" bar on the tab, and Chrome allows one '
      + 'debugger client per tab, so a tab with DevTools open cannot be driven.',
    inputSchema: {
      type: 'object',
      required: ['tab_id', 'ref'],
      properties: {
        tab_id: { type: 'number' },
        ref: { type: 'string', description: 'From read_page.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
        click_count: { type: 'number', default: 1, description: '2 for a double click.' },
      },
    },
  },
  {
    name: 'type_text',
    description:
      'Type into the page. Pass a ref to click it first, which is how you focus a field. Inserts '
      + 'the text in one operation rather than a keystroke at a time, so it also handles '
      + 'characters no single key produces.',
    inputSchema: {
      type: 'object',
      required: ['tab_id', 'text'],
      properties: {
        tab_id: { type: 'number' },
        text: { type: 'string' },
        ref: { type: 'string', description: 'Focus this element first.' },
        press_enter: { type: 'boolean', default: false },
      },
    },
  },
  {
    name: 'press_key',
    description: 'Press one named key: Enter, Tab, Escape, Backspace or an arrow.',
    inputSchema: {
      type: 'object',
      required: ['tab_id', 'key'],
      properties: {
        tab_id: { type: 'number' },
        key: { type: 'string' },
        ref: { type: 'string', description: 'Focus this element first.' },
      },
    },
  },
  {
    name: 'scroll',
    description: 'Scroll a page, or scroll an element into view by ref.',
    inputSchema: {
      type: 'object',
      required: ['tab_id'],
      properties: {
        tab_id: { type: 'number' },
        dy: { type: 'number', default: 400, description: 'Positive scrolls down.' },
        dx: { type: 'number', default: 0 },
        ref: { type: 'string' },
      },
    },
  },
  {
    name: 'screenshot',
    description:
      'A screenshot of a tab, returned as an image. Works on a background tab, which '
      + 'chrome.tabs.captureVisibleTab cannot do: it only photographs the active tab of a window.',
    inputSchema: {
      type: 'object',
      required: ['tab_id'],
      properties: {
        tab_id: { type: 'number' },
        format: { type: 'string', enum: ['png', 'jpeg'], default: 'png' },
        quality: { type: 'number', description: 'JPEG only, 0 to 100.' },
      },
    },
  },
  {
    name: 'run_javascript',
    description:
      "Evaluate an expression in the page's own world, so it sees the page's variables, and "
      + 'return the value. Top-level await works. A thrown error comes back as the result rather '
      + 'than as a transport failure.',
    inputSchema: {
      type: 'object',
      required: ['tab_id', 'expression'],
      properties: { tab_id: { type: 'number' }, expression: { type: 'string' } },
    },
  },
  {
    name: 'read_console',
    description:
      'Console messages and uncaught exceptions for a tab. Only what happened since the tab was '
      + 'first driven: attaching is what starts the recording, so a message from before that is '
      + 'gone. The reply says whether this call was the attachment.',
    inputSchema: {
      type: 'object',
      required: ['tab_id'],
      properties: { tab_id: { type: 'number' }, limit: { type: 'number', default: 100 } },
    },
  },
  {
    name: 'read_network',
    description:
      'Network requests for a tab, with their statuses. Same recording rule as read_console: '
      + 'history begins when the tab was first driven.',
    inputSchema: {
      type: 'object',
      required: ['tab_id'],
      properties: { tab_id: { type: 'number' }, limit: { type: 'number', default: 100 } },
    },
  },
  {
    name: 'group_tabs',
    description:
      'Put tabs into a named tab group, so it is visible in the tab strip which tabs an agent is '
      + 'working in. Reuses an existing group with the same title rather than making a second one, '
      + 'which is how a tab strip ends up with identical pills nobody can tell apart. Purely '
      + 'cosmetic: nothing addresses a tab through its group, so grouping and ungrouping are '
      + 'always safe and never lose track of a tab.',
    inputSchema: {
      type: 'object',
      required: ['tab_ids'],
      properties: {
        tab_ids: { type: 'array', items: { type: 'number' } },
        title: { type: 'string', description: 'The group label. Defaults to yoke.' },
        color: {
          type: 'string',
          enum: ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'],
        },
      },
    },
  },
  {
    name: 'ungroup_tabs',
    description:
      'Take tabs out of their group, leaving the tabs open. Removes the pill when the group '
      + 'empties. This is also how to clear a leftover group from any extension, including ones '
      + 'the Claude bridge stranded.',
    inputSchema: {
      type: 'object',
      required: ['tab_ids'],
      properties: { tab_ids: { type: 'array', items: { type: 'number' } } },
    },
  },
  {
    name: 'release_tab',
    description:
      'Stop driving a tab: detaches the debugger, which removes the "started debugging" bar and '
      + 'frees the tab for DevTools. Console and network history for that tab is dropped.',
    inputSchema: {
      type: 'object',
      required: ['tab_id'],
      properties: { tab_id: { type: 'number' } },
    },
  },
  {
    name: 'get_page_text',
    description:
      'The visible text of a page, by tab id. Uses innerText rather than textContent, so it is '
      + 'what a reader would see: no script or style bodies, and layout respected. Chrome\'s own '
      + 'pages and the Web Store cannot be read, and say so rather than returning nothing.',
    inputSchema: {
      type: 'object',
      required: ['tab_id'],
      properties: {
        tab_id: { type: 'number' },
        max_chars: { type: 'number', description: 'Truncate beyond this. Default 200000.' },
      },
    },
  },
] as const;

const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] });
const failed = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }], isError: true });

/**
 * A tab id, or a refusal naming what arrived instead.
 *
 * An MCP client hands over whatever the model produced, so a string, a float or
 * nothing at all are all realistic. Passing those through would fail somewhere
 * deeper with a worse message.
 */
function asTabId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`tab_id must be an integer from list_tabs, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * The hosts a browser mostly has open, so a profile with no label is still
 * recognisable: "mail.google.com, atlassian.net" reads as work to the person
 * who owns it in a way a random id never will.
 */
function mostlyOpen(urls: string[], limit = 3): string {
  const counts = new Map<string, number>();
  for (const url of urls) {
    try {
      const { protocol, hostname } = new URL(url);
      if (protocol !== 'http:' && protocol !== 'https:') { continue; }
      counts.set(hostname, (counts.get(hostname) ?? 0) + 1);
    } catch { /* not a site */ }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([host]) => host)
    .join(', ');
}

/**
 * A refusal the model can act on comes back as a tool result, not a transport
 * error: "tab 999 is not open anywhere" is an answer, and a JSON-RPC error is
 * how a client learns the server is broken.
 */
export async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    return await dispatch(name, args);
  } catch (failure) {
    if (failure instanceof NoSuchTab || failure instanceof NoSuchBrowser) { return failed(failure.message); }
    throw failure;
  }
}

async function dispatch(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (name === 'list_browsers') {
    const { browsers, tabs } = await allTabs();
    if (browsers.length === 0) {
      throw new ExtensionUnavailable(
        'the extension is not connected. Run `yoke install`, then load it in Chrome.');
    }
    const lines = browsers.map((browser) => {
      const own = tabs.filter((tab) => tab.browser === browser);
      const windows = new Set(own.map((tab) => tab.windowId)).size;
      const label = browser.unidentified
        ? '(unidentified: reload the extension in this profile at chrome://extensions)'
        : browser.label === '' ? '(unnamed)' : browser.label;
      return `${browser.id}\t${label}\t${own.length} tab(s)\t${windows} window(s)\t${mostlyOpen(own.map((tab) => tab.url))}`;
    });
    const hint = browsers.some((browser) => browser.label === '' && !browser.unidentified)
      ? '\nA label is set in the yoke popup of that profile, and is the easier name to pass to open_tab.'
      : '';
    return text(`${browsers.length} browser(s) connected.\nid\tlabel\ttabs\twindows\tmostly\n${lines.join('\n')}${hint}`);
  }

  if (name === 'list_tabs') {
    const { browsers, tabs } = await allTabs();
    if (browsers.length === 0) {
      throw new ExtensionUnavailable(
        'the extension is not connected. Run `yoke install`, then load it in Chrome.');
    }
    if (tabs.length === 0) {
      return text('No tabs reported, which should not happen while a browser is open.');
    }
    const full = args['full_urls'] === true;
    // The browser column appears only when there is a choice to show. One
    // profile reads exactly as it always has.
    const several = browsers.length > 1;
    const lines = tabs.map((tab) =>
      `${tab.id}\t${shownUrl(tab.url, full)}\t${tab.title.slice(0, 80)}${several ? `\t${displayName(tab.browser)}` : ''}`);
    const head = several
      ? `${tabs.length} open tab(s) across ${browsers.length} browsers, every window included.\nid\turl\ttitle\tbrowser`
      : `${tabs.length} open tab(s), every window included.\nid\turl\ttitle`;
    return text(`${head}\n${lines.join('\n')}`);
  }

  if (name === 'list_tab_groups') {
    const { browsers, tabs } = await allTabs();
    if (browsers.length === 0) {
      throw new ExtensionUnavailable(
        'the extension is not connected. Run `yoke install`, then load it in Chrome.');
    }
    const several = browsers.length > 1;
    const listed = await Promise.all(browsers.map(async (browser) => {
      const { groups } = await ask(browser.endpoint, 'listGroups');
      return groups.map((group) => ({ group, browser }));
    }));
    const groups = listed.flat();
    if (groups.length === 0) { return text('No tab groups.'); }
    const lines = groups.map(({ group, browser }) => {
      const members = tabs.filter((tab) => tab.browser === browser && tab.groupId === group.id).length;
      return `${group.id}\t${JSON.stringify(group.title)}\t${group.color}\t${members} tab(s)${several ? `\t${displayName(browser)}` : ''}`;
    });
    const head = several ? 'id\ttitle\tcolour\tmembers\tbrowser' : 'id\ttitle\tcolour\tmembers';
    return text(`${groups.length} group(s).\n${head}\n${lines.join('\n')}`);
  }

  if (name === 'navigate') {
    const tabId = asTabId(args['tab_id']);
    const url = String(args['url'] ?? '');
    // Refused here rather than in the extension, because the reason is a policy
    // and policy belongs where it can be tested without a browser.
    if (!/^https?:\/\//i.test(url)) {
      return failed(`navigate takes an http or https URL, not ${JSON.stringify(url)}`);
    }
    const timeoutMs = typeof args['timeout_ms'] === 'number' ? args['timeout_ms'] : undefined;
    const moved = await askTab('navigate', {
      tabId,
      url,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    return moved.status === 'complete'
      ? text(`Navigated tab ${moved.tabId} to ${shownUrl(moved.url)}\n${moved.title}`)
      : text(`Tab ${moved.tabId} is at ${shownUrl(moved.url)} but did not report finishing loading `
        + 'within the timeout. The page may still be working.');
  }

  if (name === 'open_tab') {
    const url = args['url'] === undefined ? undefined : String(args['url']);
    if (url !== undefined && !/^https?:\/\//i.test(url)) {
      return failed(`open_tab takes an http or https URL, not ${JSON.stringify(url)}`);
    }
    const groupTitle = args['group_title'] === undefined
      ? DEFAULT_GROUP_TITLE
      : String(args['group_title']);
    // The one call that names no tab, so the browser has to be named instead
    // when there is more than one to choose from.
    const browser: Browser = await chooseBrowser(args['browser'], 'open_tab');
    const opened = await ask(browser.endpoint, 'openTab', {
      ...(url === undefined ? {} : { url }),
      active: args['active'] === true,
      groupTitle,
    });
    // The id is new to the router, and may not be new to another browser.
    unplace(opened.tab.id);
    // Three outcomes, not two. A reply with no groupId at all comes from an
    // extension build older than this server, and saying so beats printing the
    // word "undefined" at whoever is reading.
    const where = typeof opened.groupId !== 'number'
      ? ' (grouping unknown: the loaded extension predates it, so reload it at chrome://extensions)'
      : opened.groupId === -1
        ? ' (not grouped: Chrome refused, which does not affect the tab)'
        : ` in group ${JSON.stringify(opened.groupTitle)}`;
    return text(`Opened tab ${opened.tab.id} at ${shownUrl(opened.tab.url)}${where}\n${opened.tab.title}`);
  }

  if (name === 'close_tab') {
    const { closed } = await askTab('closeTab', { tabId: asTabId(args['tab_id']) });
    return text(`Closed tab ${closed}.`);
  }

  if (name === 'get_page_text') {
    const maxChars = typeof args['max_chars'] === 'number' ? args['max_chars'] : undefined;
    const page = await askTab('getPageText', {
      tabId: asTabId(args['tab_id']),
      ...(maxChars === undefined ? {} : { maxChars }),
    });
    const note = page.truncated ? '\n\n[truncated]' : '';
    return text(`${page.title}\n${shownUrl(page.url)}\n---\n${page.text}${note}`);
  }

  if (name === 'read_page' || name === 'find') {
    const maxElements = typeof args['max_elements'] === 'number' ? args['max_elements'] : undefined;
    const page = await askTab('readPage', {
      tabId: asTabId(args['tab_id']),
      ...(maxElements === undefined ? {} : { maxElements }),
    });
    const needle = name === 'find' ? String(args['text'] ?? '').toLowerCase() : null;
    const shown = needle === null
      ? page.elements
      : page.elements.filter((e) => `${e.name} ${e.role} ${e.tag}`.toLowerCase().includes(needle));
    if (shown.length === 0) {
      return text(needle === null
        ? 'No interactive elements found on this page.'
        : `Nothing on this page matches ${JSON.stringify(args['text'])}.`);
    }
    const rows = shown.map((e) => {
      const extra = [e.value ? `value=${JSON.stringify(e.value)}` : '', e.disabled ? 'disabled' : '']
        .filter(Boolean).join(' ');
      return `${e.ref}\t${e.role}\t${e.name.slice(0, 70)}${extra ? `\t${extra}` : ''}`;
    });
    const note = page.truncated ? '\n[truncated; raise max_elements]' : '';
    return text(`${page.title}\n${shownUrl(page.url)}\n${shown.length} element(s)\nref\trole\tname\n${rows.join('\n')}${note}`);
  }

  if (name === 'click') {
    const button = args['button'];
    const clickCount = typeof args['click_count'] === 'number' ? args['click_count'] : undefined;
    const result = await askTab('click', {
      tabId: asTabId(args['tab_id']),
      ref: String(args['ref'] ?? ''),
      ...(button === 'left' || button === 'right' || button === 'middle' ? { button } : {}),
      ...(clickCount === undefined ? {} : { clickCount }),
    });
    // Reported rather than asserted. A click that was dispatched underneath an
    // overlay used to read exactly like one that worked.
    if (result.hit === 'covered') {
      return text(
        `Dispatched a click at ${result.ref}, but ${result.topmost ?? 'another element'} was on top `
        + 'of it at that point and most likely received it instead. Call read_page again and act on '
        + 'what is actually in front, which is often a cookie or consent banner.');
    }
    if (result.hit === 'nothing') {
      return text(
        `Dispatched a click at ${result.ref}, but nothing was hit-testable at that point, so it `
        + 'probably went nowhere. The element may be scrolled out of view or covered by a full '
        + 'page overlay.');
    }
    return text(`Clicked ${result.ref}.`);
  }

  if (name === 'type_text') {
    const ref = args['ref'] === undefined ? undefined : String(args['ref']);
    const typed = await askTab('typeText', {
      tabId: asTabId(args['tab_id']),
      text: String(args['text'] ?? ''),
      ...(ref === undefined ? {} : { ref }),
      pressEnter: args['press_enter'] === true,
    });
    return text(`Typed ${typed.typed} character(s)${args['press_enter'] === true ? ' and pressed Enter' : ''}.`);
  }

  if (name === 'press_key') {
    const ref = args['ref'] === undefined ? undefined : String(args['ref']);
    const pressed = await askTab('pressKey', {
      tabId: asTabId(args['tab_id']),
      key: String(args['key'] ?? ''),
      ...(ref === undefined ? {} : { ref }),
    });
    return text(`Pressed ${pressed.key}.`);
  }

  if (name === 'scroll') {
    const ref = args['ref'] === undefined ? undefined : String(args['ref']);
    const dx = typeof args['dx'] === 'number' ? args['dx'] : undefined;
    const dy = typeof args['dy'] === 'number' ? args['dy'] : undefined;
    const moved = await askTab('scroll', {
      tabId: asTabId(args['tab_id']),
      ...(dx === undefined ? {} : { dx }),
      ...(dy === undefined ? {} : { dy }),
      ...(ref === undefined ? {} : { ref }),
    });
    return text(`Scrolled by ${moved.dx}, ${moved.dy}.`);
  }

  if (name === 'screenshot') {
    const format = args['format'] === 'jpeg' ? 'jpeg' : 'png';
    const quality = typeof args['quality'] === 'number' ? args['quality'] : undefined;
    const shot = await askTab('screenshot', {
      tabId: asTabId(args['tab_id']),
      format,
      ...(quality === undefined ? {} : { quality }),
    }, { timeoutMs: 30_000 });
    // An image part, not base64 in a text blob: a client that can show an image
    // should get one, and a text field would be unreadable either way.
    return {
      content: [
        { type: 'text', text: `Screenshot of tab ${shot.tabId}, ${shot.format}, ${shot.bytes} bytes.` },
      ],
      images: [{ format: shot.format, base64: shot.base64 }],
    } as ToolResult;
  }

  if (name === 'run_javascript') {
    const outcome = await askTab('evaluate', {
      tabId: asTabId(args['tab_id']),
      expression: String(args['expression'] ?? ''),
    }, { timeoutMs: 30_000 });
    // A thrown error is the answer, not a transport failure: the caller asked
    // what the page would do, and this is what it did.
    return outcome.threw
      ? text(`threw: ${outcome.value}`)
      : text(`${outcome.type}: ${outcome.value}`);
  }

  if (name === 'read_console') {
    const limit = typeof args['limit'] === 'number' ? args['limit'] : undefined;
    const seen = await askTab('consoleMessages', {
      tabId: asTabId(args['tab_id']),
      ...(limit === undefined ? {} : { limit }),
    });
    const preface = seen.attachedNow
      ? 'Recording started with this call, so nothing from before it exists.\n'
      : '';
    if (seen.messages.length === 0) { return text(`${preface}No console messages.`); }
    const rows = seen.messages.map((m) => `${m.level}\t${m.text.slice(0, 200)}`);
    return text(`${preface}${seen.messages.length} message(s)\nlevel\ttext\n${rows.join('\n')}`);
  }

  if (name === 'read_network') {
    const limit = typeof args['limit'] === 'number' ? args['limit'] : undefined;
    const seen = await askTab('networkRequests', {
      tabId: asTabId(args['tab_id']),
      ...(limit === undefined ? {} : { limit }),
    });
    const preface = seen.attachedNow
      ? 'Recording started with this call, so nothing from before it exists.\n'
      : '';
    if (seen.requests.length === 0) { return text(`${preface}No requests recorded.`); }
    const rows = seen.requests.map((r) => `${r.status ?? '...'}\t${r.method}\t${shownUrl(r.url)}`);
    return text(`${preface}${seen.requests.length} request(s)\nstatus\tmethod\turl\n${rows.join('\n')}`);
  }

  if (name === 'group_tabs' || name === 'ungroup_tabs') {
    const raw = args['tab_ids'];
    if (!Array.isArray(raw) || raw.length === 0) {
      return failed('tab_ids must be a non-empty array of tab ids from list_tabs');
    }
    const tabIds = raw.map((value) => asTabId(value));
    if (name === 'ungroup_tabs') {
      await ask(await endpointForTabs(tabIds), 'ungroupTabs', { tabIds });
      return text(`Ungrouped ${tabIds.length} tab(s). They are still open.`);
    }
    const title = args['title'] === undefined ? DEFAULT_GROUP_TITLE : String(args['title']);
    const color = args['color'] === undefined ? undefined : String(args['color']);
    const grouped = await ask(await endpointForTabs(tabIds), 'groupTabs', {
      tabIds,
      ...(title === undefined ? {} : { title }),
      ...(color === undefined ? {} : { color }),
    });
    return text(`${tabIds.length} tab(s) are now in group ${grouped.groupId} `
      + `${JSON.stringify(grouped.title)}.`);
  }

  if (name === 'release_tab') {
    const released = await askTab('release', { tabId: asTabId(args['tab_id']) });
    return text(released.released
      // Says what detaching does and no more. The tab keeps its group because
      // releasing is not unmarking.
        ? `Released tab ${released.tabId}. The debugger is detached and this tab's console and `
          + 'network buffers are dropped. It stays in its group.'
      : `Tab ${released.tabId} was not being driven.`);
  }

  return failed(`unknown tool: ${name}`);
}

export async function handle(request: JsonRpcRequest): Promise<unknown> {
  if (request.method === 'initialize') {
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    };
  }
  if (request.method === 'tools/list') { return { tools: TOOLS }; }
  if (request.method === 'tools/call') {
    const params = request.params ?? {};
    return callTool(params.name ?? '', params.arguments ?? {});
  }
  throw new Error(`unknown method: ${request.method}`);
}

export function main(): void {
  const lines = createInterface({ input: process.stdin, terminal: false });
  const send = (object: unknown): void => { process.stdout.write(`${JSON.stringify(object)}\n`); };

  lines.on('line', (raw: string) => {
    const line = raw.trim();
    if (!line) { return; }

    let request: JsonRpcRequest;
    try { request = JSON.parse(line) as JsonRpcRequest; } catch { return; }
    // A notification carries no id and must never be answered.
    if (request.id === undefined) { return; }
    const id = request.id;

    handle(request)
      .then((result) => { send({ jsonrpc: '2.0', id, result }); })
      .catch((thrown: unknown) => {
        // An unreachable extension is a condition to report, not a crash: the
        // client should be told to install or load it rather than see a dead
        // server.
        const message = thrown instanceof ExtensionUnavailable || thrown instanceof Error
          ? thrown.message
          : String(thrown);
        send({ jsonrpc: '2.0', id, error: { code: -32000, message } });
      });
  });
}
