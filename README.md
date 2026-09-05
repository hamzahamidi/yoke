# yoke

[![npm](https://img.shields.io/npm/v/yoke-mcp?color=0e8fa3)](https://www.npmjs.com/package/yoke-mcp)
[![tests](https://github.com/hamzahamidi/yoke/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/hamzahamidi/yoke/actions/workflows/test.yml)
[![provenance](https://img.shields.io/badge/npm-signed%20provenance-0e8fa3)](https://www.npmjs.com/package/yoke-mcp#provenance)
[![node](https://img.shields.io/node/v/yoke-mcp)](https://nodejs.org)
[![dependencies](https://img.shields.io/badge/runtime%20deps-0-0e8fa3)](package.json)
[![license](https://img.shields.io/npm/l/yoke-mcp)](LICENSE)

Yoke drives the Chrome you are already using: an extension plus a native messaging host, so there is no browser to launch, no second profile, and no browser-wide debugging port. Chrome spawns the host itself when the extension connects, and the endpoint in between (a Unix socket at mode 0600 inside a directory whose 0700 mode is verified, or a named pipe on Windows) exists only while that connection is live. There is one per Chrome profile, so two profiles with the extension loaded are both reachable and told apart. It does use the Chrome DevTools Protocol, one tab at a time, through the extension's own `debugger` permission, which is why a tab with DevTools open cannot be driven.

`list_tabs` returns every tab in every window of every connected Chrome profile, and every operation on an existing tab names a `tab_id`, because there is no acting on the active tab when none was named. Any tab yoke drives or reads joins a visible tab group called `yoke`, and `read_page` and `find` describe a password field without returning its value. URL fields in tool output are cut to origin and path by default, with `full_urls: true` on `list_tabs` as the way to opt out, and the package has zero runtime dependencies on Node 22 or later.

Chrome requires a three part bridge:

```text
MCP client  <--stdio-->  yoke mcp server  <--Unix socket-->  native host  <--connectNative-->  Chrome extension
```

The MCP client starts `yoke mcp`. Chrome starts the native messaging host when the extension connects to it. The server reaches that host through a local socket. A client cannot connect straight to the extension because Chrome only gives native messaging connections to hosts that Chrome started.

The project and repository are named `yoke`. The npm package is `yoke-mcp` because the bare package name belongs to an unrelated project. The command is `yoke`, and the extension is displayed as Yoke.

## How this differs

### Explicit tab targeting

Every operation on an existing tab requires a `tab_id`, with no active tab fallback. `open_tab` creates a tab and therefore has no existing id to name.

### Your own Chrome profile

Yoke runs through an extension in the Chrome profile you are already using. It can reach every tab in every window of that profile, with its existing cookies, logged in sessions, and other extensions. Load it in a second profile and both are reachable at once: `list_browsers` names each, `list_tabs` covers both, and a tab id is enough to route a call to the profile that owns it, because Chrome numbers tabs once for the whole browser.

### No browser-wide debugging endpoint

Yoke uses `chrome.debugger`, which is Chrome's extension API for the Chrome DevTools Protocol. It attaches to one tab at a time and does not require a Chrome launch flag or a browser-wide remote debugging port. The local bridge is a per-profile Unix socket or Windows named pipe that exists only while Chrome has the extension connected.

### Built for a human and an agent in the same browser

Any tab yoke drives or reads joins a visible tab group named `yoke`. Grouping is a visual marker and is not used to find a tab. Chrome permits one debugger client per tab, so yoke cannot drive a tab while DevTools is open on it.

### Privacy-conscious defaults

URL fields are reduced to origin and path by default, and `list_tabs` can opt out with `full_urls: true`. This redaction does not filter page text, console messages, evaluated JavaScript results, or screenshot pixels. `read_page` and `find` describe password fields without returning their values.

### Small and auditable

The package declares zero runtime dependencies and uses Node builtins only. The
published 0.1.3 tarball is 43 files, all first-party.

TypeScript throughout with `strict` and `noUncheckedIndexedAccess` on. The wire
shapes are declared once in `src/protocol.ts` and imported by both halves, so a
request the server can send is one the extension is compiled to answer, and the
compiler is what enforces that rather than a comment asking nicely.

The permissions and what each one buys are in a table further down, along with
the native messaging setup and the reasons `debugger` and host access are
required. None of that makes yoke safe: it drives a browser you are signed into,
which is privileged by construction. It is documented so the trade is yours to
judge rather than yours to discover.

### Compared with other browser MCP servers

The cells describe the verified versions and their defaults. Flags that change an answer are named in the cell or the numbered notes.

| Capability | Yoke (npm 0.1.3) | @playwright/mcp 0.0.79 (2026-08) | chrome-devtools-mcp 1.7.0 (pub. 2026-08-10) | BrowserMCP: server 0.1.3 (2025-04-11), extension 1.3.4 (2025-05-07), unmaintained |
| --- | --- | --- | --- | --- |
| Runs in the Chrome profile you are already signed in to | Yes. Chrome spawns the host via `connectNative`; there is no browser-launch code | No by default: its own persistent profile keyed to the client's cwd [1]. Yes with `--extension` | No by default: its own profile at `~/.cache/chrome-devtools-mcp/chrome-profile`. Yes with `--autoConnect` [2] | Yes. A Web Store extension in the running browser |
| Reaches tabs that were already open | Yes, every tab in every window of the Chrome profile that owns the endpoint [3] | No by default (fresh browser, so those tabs do not exist in it). Yes with `--extension` [4] | No by default. With `--autoConnect`, all windows of one profile [2] | One tab at a time, picked by the human in the popup. No tab listing and no tab creation tool [5] |
| Explicit target on every operation | Yes, `tab_id`, with no active-tab fallback anywhere [6] | No. Implicit current page, switched by `browser_tabs` with a positional index [7] | No. Server-side selected page via `select_page` [8] | No. The single connected tab; no tab id in any of the 12 exposed tool schemas |
| Needs a Chrome launch flag or a browser-wide debugging port | No | No for the default launch and for `--extension`; yes for `--cdp-endpoint` [9] | Yes on all three attach paths; no when it launches its own browser over a pipe [10] | No |
| How it reaches the browser, and what listens locally | Native messaging. A per-user endpoint (Unix socket mode 0600 in a directory whose 0700 mode is verified; a named pipe on Windows) that exists only while Chrome has the extension connected. CDP one tab at a time via `chrome.debugger` 1.3 | Playwright drives a browser it launched. `--extension` starts an in-process CDP relay the extension dials over WebSocket | Puppeteer over a pipe for its own browser; a CDP HTTP endpoint or `ws://` URL for the three attach paths | WebSocket server on fixed port 9009, bound to all interfaces, no auth and no origin check, and it kills whatever already holds that port [11] |
| Runs with your existing cookies and logged-in session | Yes | No by default. Yes with `--extension` [12] | Only with `--autoConnect` [13] | Yes |
| Marks the tabs it touches | Yes. Any tab it drives or reads joins a visible tab group named "yoke" [14] | No in-tab marker. A separate headed window on its own profile, with automation signals actively suppressed [15] | Nothing added by the server. Chrome's own affordances only, and on `--autoConnect` that is a one-time consent dialog rather than an ongoing marker [16] | Chrome's own debugger infobar, incidental rather than designed, and suppressible [17] |
| URL redaction on by default | Yes. URL fields are cut to origin plus path; opt out with `full_urls` on `list_tabs` [18] | No. The only mechanism is opt-in substitution of known secret values (`--secrets`) | No, at no setting. Header redaction exists, covers headers only, and is off by default | No. The full page URL is in every snapshot header |
| Declared runtime dependencies, and install footprint | 0 declared, Node builtins only. The published 0.1.3 tarball is 43 files, all first-party | 2 declared, both pinned to a 1.63.0 alpha. 19 MB installed. No browser download on the default `chrome` channel | 0 declared, and roughly 14 MB of vendored bundle (puppeteer 25.5.0, lighthouse 13.4.0) [19] | 5 declared, 97 transitive as resolved on 2026-08-24, and rising with no new release [20] |

#### Notes, including every place a flag or a version changes the answer

1. `@playwright/mcp` defaults to `browserName: chromium` with `channel: 'chrome'`, so it drives system-installed Google Chrome, but in `~/Library/Caches/ms-playwright-mcp/mcp-{channel}-{sha256(cwd)[0:7]}`. That profile persists between runs and accumulates its own logins, so it is not your profile and not a throwaway either. Its own `--help` text and README call it a temporary directory, which is wrong. Different project directories silently get different profiles.
2. `--autoConnect` needs Chrome 144 or later plus a manual toggle at `chrome://inspect/#remote-debugging`, and it attaches to one profile (the default, as Chrome determines it), not to every window on the machine. The documented `--browser-url` path steers users away from their real profile: the README tells them to pass `--user-data-dir` so their browsing data is not exposed.
3. Scoped to one Chrome profile, because the endpoint path is per user and not per profile. On published 0.1.2 a second profile with the extension loaded could take the endpoint silently. Published 0.1.3 fixes that failure mode. The next release gives each profile its own endpoint, described under Several Chrome profiles below.
4. `--extension` genuinely attaches to every tab the extension already knows about (`chrome.debugger.attach` per tab), so the honest answer is not by default, and supported with `--extension`.
5. Only from extension v1.3.3 (2025-04-14) could BrowserMCP automate tabs that existed before the extension was installed. The selected tab id is persisted in extension storage and survives a server restart.
6. `open_tab` creates the tab, so there is no id to name, and it lands in Chrome's current window. `scroll` without a `ref` uses a fixed viewport point, still inside the named tab.
7. `browser_click`'s `target` is an element reference from a prior snapshot rather than a tab handle. Element targeting is explicit there; page targeting is not.
8. `--experimentalPageIdRouting` (default false, inert under `--slim`) injects `pageId` into page-scoped tools, so the stateful selection is a default rather than an architectural limit: a selected page by default, with opt-in `pageId` routing.
9. `--browser-url` on chrome-devtools-mcp also requires closing every running Chrome first. `@playwright/mcp`'s `--extension` route is gated differently rather than ungated: it throws unless the Playwright Extension is present in the profile.
10. The three attach paths are `--autoConnect` (reads `DevToolsActivePort` from the user data dir after the manual toggle), `--browserUrl` (needs `--remote-debugging-port=9222` and a non-default user data dir), and `--wsEndpoint`. There is no fourth. The self-launched browser passes `pipe: true` and opens no port.
11. Verified empirically: `address()` returns `{"address":"::"}`. Startup runs `lsof -ti:9009 | xargs kill -9`. A second connection silently closes the first.
12. `@playwright/mcp` does not disable extensions: its default chromium switch list contains `--disable-extensions` and the MCP launch path cancels it through `ignoreDefaultArgs`. It carries none of your extensions because the profile is fresh, not because extensions are off. That is why the extensions half was cut from this row's title.
13. On chrome-devtools-mcp 1.7.0 the two halves land on mutually exclusive paths: session state needs `--autoConnect`, while the extension tooling is documented as unsupported on `autoConnect`, `browserUrl` and `wsEndpoint` until Chrome 149 and works only over the pipe connection, that is the dedicated profile that holds no user extensions. Yoke and BrowserMCP carry the user's other extensions by construction; BrowserMCP has had to fix breakage from 1Password and LastPass injecting elements into snapshots.
14. Every operation that drives or reads a tab marks it: `navigate`, `get_page_text`, `read_page`, `find`, `run_javascript`, `screenshot`, `click`, `type_text`, `press_key`, `scroll`, `read_console`, `read_network`, and `open_tab` groups the tab it creates. Deliberately unmarked: `list_tabs`, `list_tab_groups`, `close_tab`, `ping`, `release_tab`, `ungroup_tabs`. The tab group is present in published 0.1.3. Chrome's own "started debugging this browser" banner also appears when the debugger attaches, and yoke does not suppress it. That is Chrome's behaviour rather than a guarantee from either project: it is not stated on Chrome's `chrome.debugger` reference page. The same caveat applies to the BrowserMCP cell.
15. Headed is the default (headless is auto-selected only on Linux with no `DISPLAY`). The server pushes `--disable-blink-features=AutomationControlled`, `--disable-infobars` is in the default switch list, and `--enable-automation` is absent. The indication is structural (a separate window on a separate profile) rather than a badge. What `--extension` does here could not be established from the package, so this row says nothing about it.
16. chrome-devtools-mcp adds no title change, overlay or badge of its own, and it inherits puppeteer's default args, which contain `--enable-automation` and `--disable-infobars` in the same array. Whether Chrome still draws the infobar with both flags present was not tested, so this row claims nothing either way.
17. Chrome's `--silent-debugger-extension-api` and force-install via `ExtensionInstallForcelist` both remove the infobar, so in those configurations the answer becomes No. BrowserMCP ships no indicator of its own.
18. Redaction covers URL fields, not the whole payload. Unredacted by design: `read_console` message text, `run_javascript` return values (so `location.href` or `document.cookie` comes back whole, with no flag needed), the page body from `get_page_text`, and screenshot pixels. `full_urls` exists on `list_tabs` only; everywhere else redaction is unconditional.
19. This is the devDependencies trap in reverse. `npm view chrome-devtools-mcp@1.7.0 dependencies` is empty and the tarball's `package.json` has no `dependencies` key, so a reader who runs `npm ls` against a "substantial" claim finds nothing. The substance is real but vendored by rollup, not installed. Neither chrome-devtools-mcp nor `@playwright/mcp` downloads a browser on its default path: both use system Chrome.
20. Five direct deps, none of them the five `workspace:*` entries (those are unpublished devDependencies bundled into `dist` at build time). The transitive count grows with no release because `@modelcontextprotocol/sdk ^1.8.0` floats and now resolves to 1.30.0, pulling in express 5.2.1.

## Why yoke exists

yoke grew out of measurements of Anthropic's Claude in Chrome MCP bridge. That bridge could only see and act on tabs in its own managed group, and each reply included its full tab list with raw URLs. Those limits could not be fixed by an outside client. yoke addresses every tab by id and redacts URLs by default. [MOTIVATION.md](MOTIVATION.md) records the observations behind those choices.

yoke is not affiliated with or endorsed by Anthropic or Google. It works with any client that speaks Model Context Protocol.

## Install from source

yoke is not on the Chrome Web Store. You must build it from source and load the extension unpacked.

You need Node 22 or later and a Chromium based browser. The manifest requires Chrome 116 or later. Chrome, Chromium, Edge, and Brave registration paths are present. Only macOS has been exercised so far.

### 1. Clone and build

```sh
git clone https://github.com/hamzahamidi/yoke.git
cd yoke
npm install
npm run build
node dist/cli.js install
```

Do not skip the build. `extension/manifest.json` loads `extension/browser/background.js`, and `extension/browser/` is generated output that is not stored in Git.

`node dist/cli.js install` registers the native messaging host with each Chrome family browser it finds. If the `yoke` binary is already on your `PATH`, `yoke install` runs the same command.

On Windows, `yoke install` does not complete registration. It prints a registry instruction instead of changing the registry. The Windows and Linux paths have not been tested yet.

### 2. Load the extension

In Chrome, Chromium, or Brave:

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Choose **Load unpacked**.
4. Select the `extension/` directory inside the clone, not the repository root.

In Edge, use `edge://extensions` and follow the same steps.

An unpacked load gets the id `oceljemfocgfidhhdlbojkbkmlbfclna`, pinned by a public key in `extension/manifest.json`. A Chrome Web Store install gets a different one, `mebojgahcmmffbaonhnmmjhmbdbfbamm`, because an uploaded package may not carry a key and so cannot choose its id. `yoke install` allowlists both, so either install works. A build whose id is neither is refused by native messaging, which is the point of pinning it.

The native messaging host id is `io.github.hamzahamidi.yoke`.

### 3. Check every connection

```sh
node dist/cli.js doctor
```

When setup is complete, the last line is:

```text
Working. Every link in the chain answered.
```

If something is wrong, `doctor` stops after the first broken link, names it, and prints a suggested fix. It checks the compiled host, browser registration, the local sockets, which profiles answered, and for each profile whether the extension replies and tabs are visible.

For a shorter connection check, run:

```sh
node dist/cli.js status
```

## Connect an MCP client

An MCP client needs to start the command `yoke` with the argument `mcp`.

If you want the binary from this checkout on your `PATH`, run this once from the repository:

```sh
npm link
```

A typical MCP server entry then looks like this:

```json
{
  "mcpServers": {
    "yoke": {
      "command": "yoke",
      "args": ["mcp"]
    }
  }
}
```

Clients use different names and locations for their MCP configuration. If you do not want to run `npm link`, set the command to `node` and pass the absolute path to `dist/cli.js` before `mcp`.

## What it can do

yoke exposes 20 MCP tools. They are grouped here by the job they help with.

| Job | Tools | What they do |
| --- | --- | --- |
| Work with tabs | `list_browsers`, `list_tabs`, `list_tab_groups`, `open_tab`, `navigate`, `close_tab`, `group_tabs`, `ungroup_tabs` | See which profiles are connected and every window in each, open background tabs, visit HTTP or HTTPS URLs, close tabs, and manage Chrome tab groups. |
| Read a page | `get_page_text`, `read_page`, `find`, `screenshot` | Read visible text, describe interactive elements, find a matching element, or capture a foreground or background tab. |
| Act on a page | `click`, `type_text`, `press_key`, `scroll`, `run_javascript` | Use trusted input by element reference, scroll the page, or evaluate JavaScript in the page's own world. |
| Debug a page | `read_console`, `read_network`, `release_tab` | Read recorded console and network activity, then detach yoke and clear that tab's buffers. |

Any tool that acts on an existing tab requires an explicit `tab_id` obtained from `list_tabs`. There is no active tab default. yoke never acts on whichever tab you happen to be viewing because no tab was named.

`read_page` returns references such as `e1` for interactive elements. `click`, `type_text`, `press_key`, and reference based scrolling use those references. A reference expires when the page navigates or renders the element again, so call `read_page` again when a reference is stale.

`navigate` and `open_tab` accept HTTP and HTTPS URLs. New tabs open in the background unless the caller asks to focus one.

### Several Chrome profiles

Chrome starts one native host per profile, and each host listens on its own endpoint named after an id the extension mints the first time it runs in that profile. `list_browsers` lists every profile that answers, with its id, the label you gave it in the popup, its tab and window counts, and the sites it mostly has open, so a profile is recognisable before it has a name.

With one profile connected nothing changes. With more, `list_tabs` and `list_tab_groups` include every profile and add a `browser` column, and every tool that names a `tab_id` reaches the profile holding that tab without being told which: Chrome allocates tab ids from one counter for the whole browser, so two profiles never share one. `open_tab` names no existing tab, so with more than one profile connected it needs `browser`, an id or label from `list_browsers`, and refuses rather than picking.

Two different browsers, such as Chrome and Brave, do number tabs independently. A tab id both report is marked in `list_tabs` and refused by the tab tools, naming both browsers.

The id and label are stored in the extension's own storage in that profile. They never leave your machine.

### Tab groups

Every tab opened by yoke goes into a cyan group titled `yoke`, so the tab strip names what is driving those tabs. Pass `group_title` to `open_tab` for a different label, which is worth doing when more than one agent works in the same browser. The extension creates that group when needed and reuses a group with the same title in the same window. Reuse comes from Chrome's current group state, so it still works after Chrome has stopped and restarted the extension service worker. You do not collect a row of identical group pills.

Any tab yoke drives or reads joins the group as well, whether or not it opened that tab, so the strip always shows what is under automation. Tabs are never moved between windows to achieve it. Grouping is visual only, so no tool depends on it to find a tab. `ungroup_tabs` removes tabs from their group without closing them. When the group becomes empty, Chrome removes its pill.

### URL redaction

yoke reduces URLs in tool output to origin and path by default. Query strings and fragments are omitted because they can contain session tokens or credentials. Non HTTP wrapper URLs are reduced to their scheme because their path can contain another full URL.

`list_tabs` accepts `full_urls: true` when a caller needs raw URLs. The other tools that print URLs currently keep them redacted.

## Permissions and access

Installing Yoke gives a local MCP client broad control over the browser profile where you are signed in. It can read site content, run JavaScript, send trusted input, and observe network activity. That can include private accounts and private data. Install it only for MCP clients and agents you trust with that access.

The extension requests these permissions:

| Permission | What yoke uses it for | What the grant means |
| --- | --- | --- |
| `tabs` | List tabs in every window, including ids, titles, URLs, and group membership. Open, navigate, and close named tabs. | The extension can see which pages are open and can change the tab strip. |
| `tabGroups` | List groups, create or reuse them, set their title and colour, and ungroup tabs. | The extension can inspect and change tab grouping in every window. |
| `nativeMessaging` | Connect to the local host named `io.github.hamzahamidi.yoke`. | The extension can exchange data with a program installed on your computer. |
| `scripting` | Inject the functions that read visible text, collect interactive elements, and resolve element references. | The extension can read and run code inside allowed pages. |
| `debugger` | Use the DevTools Protocol for trusted clicks and typing, JavaScript evaluation, background tab screenshots, console messages, and network requests. | The extension gets deep control and inspection access on each tab it attaches to. |
| `host_permissions: ["<all_urls>"]` | Let `scripting` work on ordinary sites regardless of host. | The site grant is broad. It is not limited to a list of sites chosen during installation. Per site permission is future work. |

Chrome's own pages and the Chrome Web Store still block page script injection. yoke reports that restriction instead of returning an empty page.

### Why the debugger permission is required

An extension cannot create trusted input through page JavaScript. A click made by a content script reaches the page with `isTrusted: false`, and many sites ignore it. `chrome.debugger` is the extension route to `Input.dispatchMouseEvent`, which creates input the page cannot distinguish from a person's input.

Chrome shows its "started debugging this browser" bar when yoke drives a tab. This is expected. Chrome also permits one debugger client per tab. A tab with DevTools open cannot be driven by yoke, and DevTools cannot open on a tab while yoke is attached. Call `release_tab` to detach yoke and clear that tab's console and network buffers. The tab stays in its group.

The same permission lets `screenshot` capture a background tab. `chrome.tabs.captureVisibleTab` can only capture the active tab in a window.

## Local connection and process lifetime

The bridge does not open a TCP port. On macOS and Linux, each native host listens on a Unix socket inside a directory readable only by your user account, one socket per Chrome profile. The socket itself is also restricted to that account. Windows uses a named pipe.

Chrome owns the native host process. It starts the host when the extension calls `connectNative` and stops it when that connection closes. This is why the Unix socket between the MCP server and host is required.

yoke has zero runtime dependencies. TypeScript and the Chrome type declarations are used only during the build.

## Commands

After `npm link`, the command surface is:

| Command | Purpose |
| --- | --- |
| `yoke install` | Register the native messaging host with each detected Chrome family browser. |
| `yoke doctor` | Check each link from the build through tab visibility and suggest the first fix. |
| `yoke status` | Report which Chrome profiles answer, one line each with id, label, tab count and socket path. |
| `yoke uninstall` | Remove the native host registration. |
| `yoke mcp` | Run the MCP server over standard input and standard output. This is what an MCP client starts. |

From a checkout that has not been linked, replace `yoke` with `node dist/cli.js` in these commands.

## Current limits

1. yoke is young and pre 1.0. Tool names, arguments, and results can change.
2. Only macOS has been exercised. Linux and Windows install paths are written but untested. On Windows, `yoke install` prints a manual registry step but does not make the registry change.
3. The project has one offline test file, `test/mcp-server.test.ts`. It checks the MCP surface and URL redaction, but this is not yet a well tested browser project.
4. A driven tab shows Chrome's debugging bar and cannot share its debugger slot with DevTools.
5. Element references expire after navigation or a page render. Console and network history starts when yoke first attaches to that tab, not before.
6. Screenshots capture the page viewport, not browser chrome such as the address bar or tab strip.
7. Two different browsers that both run the extension, such as Chrome and Brave, number their tabs independently. A tab id both report is refused rather than routed, because it cannot be sent to both. Two profiles of the same Chrome never collide.
8. Chrome's internal pages cannot be read or driven. Neither can the Chrome Web Store or the extensions gallery: Chrome refuses both `chrome.scripting` and `chrome.debugger` there, so no extension can automate them, including this one. Publishing an extension is therefore a manual job by design.

## Uninstall

Remove the browser's native host registration with:

```sh
yoke uninstall
```

Then remove Yoke from the browser's extensions page. If you linked the checkout with npm, remove that link with:

```sh
npm unlink --global yoke-mcp
```

## License

[MIT](LICENSE)
