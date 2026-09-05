// The shapes the three processes agree on.
//
// One file so the extension, the host and the server cannot drift: a request the
// server can send is exactly a request the extension knows how to answer, and
// the compiler is what enforces that rather than a comment asking nicely.

/** Bumped when a message shape changes in a way an older peer cannot read. */
export const PROTOCOL = 1;

export interface TabInfo {
  id: number;
  windowId: number;
  /** `-1` when the tab is in no group. */
  groupId: number;
  title: string;
  url: string;
}

export interface GroupInfo {
  id: number;
  title: string;
  color: string;
  windowId: number;
  collapsed: boolean;
}

/** Every operation the extension implements, and what each one answers with. */
export interface Operations {
  /**
   * Liveness, the extension's version, and every tab it currently holds a
   * debugger on, so a forgotten attachment can be seen rather than guessed at.
   */
  ping: { args: Record<string, never>; result: { extension: string; attached: number[] } };

  /**
   * Which Chrome profile this is.
   *
   * Chrome starts one host per profile but tells it nothing about which, so the
   * extension mints a random id the first time it runs in a profile and keeps it
   * in its own storage. The label is whatever the person typed in the popup, and
   * empty until they do. The host names its endpoint after the id, which is what
   * lets two profiles be connected at once instead of fighting over one path.
   */
  identify: {
    args: Record<string, never>;
    result: { id: string; label: string; windows: number; tabs: number };
  };

  listTabs: { args: Record<string, never>; result: { tabs: TabInfo[] } };
  listGroups: { args: Record<string, never>; result: { groups: GroupInfo[] } };

  /**
   * Navigate one tab, by id, and wait for the load to settle.
   *
   * `tabId` is never implied. There is no acting on the active tab because none
   * was named: that is how a script ends up driving whatever the user happened
   * to be looking at.
   */
  navigate: {
    args: { tabId: number; url: string; timeoutMs?: number };
    result: { tabId: number; url: string; title: string; status: 'complete' | 'timeout' };
  };

  /**
   * Open a new tab, optionally at a URL, optionally in the background.
   *
   * A tab opened here always joins a named group, created if absent and reused
   * if present in that window, so the tab strip shows plainly which tabs an
   * automation is working in. A tab is never moved between windows to achieve
   * that.
   *
   * Any tab this drives or reads joins the group too, whether or not we opened
   * it. What the pill is for is showing which tabs are under automation, and a
   * tab being driven silently is the case that most needs marking.
   *
   * `groupId` is `-1` when grouping did not happen, and `groupTitle` is then the
   * title that was asked for rather than one any group carries.
   */
  openTab: {
    args: { url?: string; active?: boolean; windowId?: number; groupTitle?: string };
    result: { tab: TabInfo; groupId: number; groupTitle: string };
  };

  closeTab: { args: { tabId: number }; result: { closed: number } };

  /** The visible text of a page, by tab id. */
  getPageText: {
    args: { tabId: number; maxChars?: number };
    result: { tabId: number; url: string; title: string; text: string; truncated: boolean };
  };

  /**
   * The interactive elements of a page, each with a reference to act on.
   *
   * Coordinates are deliberately not the interface. A model that clicks at
   * (412, 233) is guessing, and a page that reflows makes the guess wrong; a
   * reference resolves to the element that was described.
   */
  readPage: {
    args: { tabId: number; maxElements?: number };
    result: {
      tabId: number;
      url: string;
      title: string;
      elements: ElementRef[];
      truncated: boolean;
    };
  };

  /** Run JavaScript in the page and return its value. */
  evaluate: {
    args: { tabId: number; expression: string; timeoutMs?: number };
    result: { tabId: number; value: string; type: string; threw: boolean };
  };

  /** A screenshot, which works on a background tab because it goes through CDP. */
  screenshot: {
    args: { tabId: number; format?: 'png' | 'jpeg'; quality?: number };
    result: { tabId: number; format: string; base64: string; bytes: number };
  };

  /**
   * Click, by element reference rather than by coordinate.
   *
   * `hit` is the only part of this a caller can trust as a statement about the
   * page. CDP reports that an input event was dispatched and nothing about what
   * received it, so the element under the point is read at the moment of
   * dispatch: `self` or `nested` mean the click reaches the named element, and
   * `covered` means something else was on top and probably took it instead.
   */
  click: {
    args: { tabId: number; ref: string; button?: 'left' | 'right' | 'middle'; clickCount?: number };
    result: {
      tabId: number;
      ref: string;
      dispatched: true;
      hit: 'self' | 'nested' | 'covered' | 'nothing';
      topmost?: string;
    };
  };

  /** Type into whatever holds focus, optionally focusing a reference first. */
  typeText: {
    args: { tabId: number; text: string; ref?: string; pressEnter?: boolean };
    result: { tabId: number; typed: number };
  };

  pressKey: {
    args: { tabId: number; key: string; ref?: string };
    result: { tabId: number; key: string };
  };

  scroll: {
    args: { tabId: number; dx?: number; dy?: number; ref?: string };
    result: { tabId: number; dx: number; dy: number };
  };

  /** Console messages seen since this tab was first attached to. */
  consoleMessages: {
    args: { tabId: number; limit?: number };
    result: { tabId: number; messages: ConsoleMessage[]; attachedNow: boolean };
  };

  /** Network requests seen since this tab was first attached to. */
  networkRequests: {
    args: { tabId: number; limit?: number };
    result: { tabId: number; requests: NetworkRequest[]; attachedNow: boolean };
  };

  /**
   * Put tabs in a group, creating or reusing one by title within their window.
   *
   * Refused when the named tabs span windows, because a group holds tabs from
   * one window and honouring it would mean moving the rest.
   *
   * Cosmetic only, and that is the point. Nothing here addresses a tab through
   * its group, so a group can be added, renamed or removed at any time without
   * anything losing track of anything. The bridge this replaces made the group
   * load-bearing, which is why losing one stranded every tab inside it.
   */
  groupTabs: {
    args: { tabIds: number[]; title?: string; color?: string };
    result: { groupId: number; title: string; tabIds: number[] };
  };

  /** Take tabs out of whatever group they are in. Leaves the tabs open. */
  ungroupTabs: {
    args: { tabIds: number[] };
    result: { tabIds: number[] };
  };

  /** Stop driving a tab: detaches the debugger and drops its buffers. */
  release: {
    args: { tabId: number };
    result: { tabId: number; released: boolean };
  };
}

export interface ElementRef {
  /** Opaque and stable for the life of the snapshot. */
  ref: string;
  role: string;
  name: string;
  tag: string;
  value?: string;
  disabled?: boolean;
}

export interface ConsoleMessage {
  level: string;
  text: string;
  url?: string;
  line?: number;
  at: number;
}

export interface NetworkRequest {
  method: string;
  url: string;
  status?: number;
  type?: string;
  at: number;
}

export type OperationName = keyof Operations;
export type ArgsOf<K extends OperationName> = Operations[K]['args'];
export type ResultOf<K extends OperationName> = Operations[K]['result'];

/** Host to extension. `id` is the host's, and comes back untouched. */
export interface Request<K extends OperationName = OperationName> {
  id: number;
  op: K;
  args?: ArgsOf<K>;
}

/** Extension to host. */
export type Response =
  | { id: number; ok: true; data: unknown }
  | { id: number; ok: false; error: string };

/** Host to a socket client. */
export type SocketReply =
  | { ok: true; data: unknown; protocol: number }
  | { ok: false; error: string; protocol?: number };

/** A socket client to the host. One JSON object per line. */
export interface SocketRequest {
  op: OperationName;
  args?: Record<string, unknown>;
  timeoutMs?: number;
}

export const isResponse = (value: unknown): value is Response =>
  typeof value === 'object' && value !== null && 'id' in value && 'ok' in value;
