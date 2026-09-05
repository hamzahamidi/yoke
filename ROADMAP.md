# Roadmap

yoke is a Chrome extension and local MCP server for driving the browser you are already signed in to. Every operation names an explicit tab id, every tab in every window is reachable, and it needs no second profile and no browser-wide debugging port. It gives any MCP client one interface to tabs, page content, trusted input, screenshots, console output and network activity.

This roadmap records what has been built and what comes next. Each release is small, shippable on its own, and the non-goals are part of the plan.

It was originally written as four releases walking from reading the browser to driving it, one permission at a time. That is not what happened: all four landed together in one unreleased body of work. The sequence below has been rewritten to say what exists rather than what was planned, because a roadmap that disagrees with the manifest is worse than no roadmap. What the staged plan was protecting, a permission set a reviewer can follow, is now the job of v0.2.0.

## Why this exists

yoke exists because a useful browser tool should be able to work with the Chrome profile a person already uses, including every tab in every window. The measured bridge that preceded it could see only tabs inside its own group, offered no group API, and lost a group permanently when its first tab closed. [MOTIVATION.md](MOTIVATION.md) records the evidence, which is also attached upstream at `anthropics/claude-code#75901`.

Tab groups are extension-only surface, proven by closing every alternative: page JavaScript sees a `chrome` object holding only `loadTimes, csi, app`; the DevTools Protocol has no tab-group surface across its 51 domains; Chrome's AppleScript dictionary has no group vocabulary. So the limitation is not something a client can work around. It has to be answered by an extension, which is this one.

## Invariants

Six rules hold across every release below.

1. **No tab-group boundary, ever.** Every tab in every window is addressable. This is the reason the project exists, and a release that reintroduces a scope boundary has failed.
2. **Permissions are earned, never requested speculatively.** Every permission in the manifest must be traceable to a tool that needs it, and the README must say what each one buys. This is the invariant the current tree comes closest to breaking: because reading and driving pages arrived in the same body of work, `scripting`, `debugger` and `host_permissions: ["<all_urls>"]` were all requested at once rather than one release at a time. Each is used by tools that exist, so the letter holds, but `<all_urls>` is broader than any single tool needs. Narrowing it is v0.2.0 and the first thing on the list.
3. **MCP is the interface.** One implementation serves an agent and a shell script alike, so behaviour cannot diverge between them. A convenience CLI may wrap it; it never becomes a second implementation.
4. **URLs are redacted by default.** Origin and path for http and https, bare scheme for anything else, and raw only on an explicit per-call opt-in. A tab listing is exactly where a session token gets copied into a log.
5. **The extension never acts on a tab it was not told to, and shows the ones it does.** No implicit current tab, no acting on the active tab because none was named. Every tab it drives or reads joins the `yoke` group, whether or not it opened that tab: the pill exists to show which tabs are under automation, so provenance is not what earns a tab its label, control is.
6. **Zero runtime dependencies.** TypeScript at build time, nothing shipped but the compiled output and the extension.

One boundary is deliberately outside the sequence: this does not become a general-purpose scraping or automation farm. It drives the browser a human is signed in to, on that human's machine, which is the only thing it is good at and the only thing that justifies the permissions.

## v0.1.0: read and drive the browser

Theme: prove the thesis. Built, working end to end, not yet tagged or published.

- TypeScript throughout, `strict` on, compiled to plain Node output with no runtime dependencies. Source in `src/`, extension in `extension/`, build to `dist/`.
- The three-process shape: the extension connects to a native messaging host that Chrome spawns, the host owns a unix socket in a 0700 directory, and the MCP server connects to that socket. Chrome will only ever spawn the host itself, so this hop is not optional.
- 19 MCP tools. Tabs and groups (`list_tabs`, `list_tab_groups`, `open_tab`, `navigate`, `close_tab`, `group_tabs`, `ungroup_tabs`), reading (`get_page_text`, `read_page`, `find`, `screenshot`), driving (`click`, `type_text`, `press_key`, `scroll`, `run_javascript`), and inspection (`read_console`, `read_network`, `release_tab`).
- Trusted input through `chrome.debugger`, because an extension cannot dispatch it any other way: a synthesised event arrives with `isTrusted` false and many sites ignore it. Both consequences are documented rather than hidden: Chrome shows its debugging bar on a driven tab, and one debugger client per tab means DevTools cannot share it.
- Elements are addressed by reference from `read_page`, never by coordinate, and a reference is re-resolved at the moment of use.
- Tabs yoke opens join one reused group titled `yoke`, per window, created if absent. Tabs the user already had are never moved into it.
- `yoke install` writes the host manifest for every Chromium-family browser present, `doctor` names the first broken link in the chain, `status` says whether the extension is connected, `mcp` runs the server on stdio.
- The extension id is pinned by a key in its manifest, because native messaging allowlists by id and an unpacked load would otherwise get a fresh one each time. The private key never enters the repository, and CI asserts the key still derives the allowlisted id.
- An icon, at 16, 32, 48 and 128, drawn on an 8 unit grid so every line lands on a pixel boundary at 16.
- Offline tests for the MCP surface and the redaction, driven without a browser. CI green on Node 22 and 24 across Linux, macOS and Windows.
- Since 0.1.3, unreleased: one endpoint per Chrome profile, named after an id the extension mints and keeps. `list_browsers` names each connected profile, `list_tabs` covers all of them, tab tools route by tab id, and `open_tab` takes `browser` when there is a choice. Closes the wrong-profile case in #6 and #8, where a single per-user endpoint was won by whichever profile connected first.

The acceptance test is one number, and it holds: `list_tabs` returns every tab in the browser rather than the handful inside a managed group. On the machine this was built against that is 41 tabs, all of them addressable.

Permissions as shipped: `tabs`, `tabGroups`, `nativeMessaging`, `scripting`, `debugger`, and `host_permissions: ["<all_urls>"]`.

Non-goals that held: no publication, no recording, no macros, no scripting language. Composition belongs to the caller.

### Promised in the original plan and not built

Recorded here rather than quietly dropped, because each one is still wanted.

- `focus_tab`, and moving a tab between windows.
- `get_page_html`. `get_page_text` and `read_page` cover what callers actually asked for so far.
- Form filling as its own operation: a native `select` cannot be driven by clicking, and a checkbox's state cannot be read back.
- An explicit, revocable opt-in separating reading a page from driving one. Reading and driving are different grants and one grant currently covers both.

## v0.2.0: ask for less

Theme: the permission set becomes something a reviewer can follow, and yoke asks for less than the extension it replaces.

- Move `<all_urls>` to `optional_host_permissions`, granted per site at the moment a tool first needs it. This is the release's whole point. An extension that drives a signed in browser earns trust by asking narrowly, and a community extension replacing a first-party one has to be strictly better on this axis or the argument for it is weak.
- Separate the read grant from the drive grant, which the original v0.4.0 promised and did not deliver. Attaching the debugger is the moment to ask, not installation.
- Every permission traced to the tools that need it, in a table in the README, with the failure mode stated for each one a user declines.
- Anything unused comes out of the manifest.

Non-goals: no new tools. A release that narrows permissions and adds surface at the same time cannot be reviewed.

## v0.3.0: the gaps

Theme: the operations a caller currently has to work around, and the ones with no workaround at all.

- `form_input`: set a `select`, read a checkbox back, drive a native control that a click cannot reach.
- `file_upload` through `DOM.setFileInputFiles`. Clicking a file input opens an OS picker nothing can dismiss, so there is no substitute for this one.
- The four items from the list above: `focus_tab`, moving a tab between windows, `get_page_html`, and the separated grants if 0.2.0 leaves them.
- `press_key` past its eight named keys, with modifiers. Back and forward. Hover.
- Elements inside a shadow root, which the snapshot cannot currently see.
- `read_console` and `read_network` print the `url` and `line` they already collect.

Non-goals: still no recording or macros.

## v0.4.0: publication

Theme: installable by someone who is not us.

- Chrome Web Store listing, with the privacy policy and permission justifications that `debugger` and host access will be asked to defend. Review is typically days and can be weeks, so publication keeps its own release clock.
- Reproducible build from a tagged commit, so the published bundle can be checked against source. An extension asking for these permissions has to be auditable, and "trust the listing" is not auditable.
- Verify the store honours the pinned `key`, so the published id matches the one the native messaging manifest allowlists. If it does not, the host registration points at the wrong id and nothing connects, which is worth finding before shipping.
- npm publish of `yoke-mcp`, which has not happened yet.

## v0.5.x: stabilisation

Bug fixes only. Soak the debugger path, decide whether Windows is supported and either finish it or say so, and leave the tool names alone.

## v1.0.0: the contract release

1. Frozen tool names, arguments and result shapes. Changing one after 1.0 requires a major bump.
2. Three-platform CI green, including the native messaging install path rather than only the build.
3. A week of the maintainer's real use without an orphaned host process, a stuck socket or a lost group.
4. Every permission in the manifest traceable to a tool that needs it, and none broader than that tool requires.
5. Zero known cases where a raw URL, a password, or any other value a caller did not ask for escapes into output.

## Decisions

**Project identity.** The name is `yoke`. Nothing in the project is specific to one vendor's assistant, so the old vendor-specific framing described the history rather than the software. Google's brand guidance reserves "Chrome" for Google's own products, which also made the previous `chrome-live` code name a poor choice for a possible store listing. The repository and project are `yoke`, the npm package is `yoke-mcp` because the bare package name was taken, the binary is `yoke`, the extension display name is `Yoke`, and the native messaging host id is `io.github.hamzahamidi.yoke`.

## Open decisions

Recorded rather than guessed at, because they are not implementation details.

**Whether browser operations get direct CLI commands.** The `yoke` binary already owns installation, diagnosis, status, removal and the MCP server entry point. MCP remains the browser interface. The open question is whether thin shell commands should expose those same operations for cron jobs and shell pipelines. Invariant 3 permits a wrapper, but not a second implementation.
