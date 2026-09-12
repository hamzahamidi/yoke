# Chrome Web Store listing

The published listing is [Yoke](https://chromewebstore.google.com/detail/yoke/mebojgahcmmffbaonhnmmjhmbdbfbamm). A store install gets the id `mebojgahcmmffbaonhnmmjhmbdbfbamm`, which is not the id an unpacked load gets, and `yoke install` allowlists both.

Everything the dashboard asks for, ready to paste. The dashboard cannot be
automated: Chrome refuses both `chrome.scripting` and `chrome.debugger` on the
extensions gallery, so every field here has to be entered by hand.

Take the zip from the GitHub release rather than building it locally. Every `v*`
tag builds it in CI and attaches it, with its SHA-256 in the run summary, so the
package you upload is the one CI built and checked rather than whatever was in a
working copy. Building locally still works and produces the same thing:

    npm run package      # dist/store/yoke-<version>.zip
    npm run screenshot   # docs/store/screenshot-1280x800.png

There is deliberately no CI upload to the store. The `chromewebstore` OAuth scope
is publisher wide with no per-item scoping, so a leaked credential could push code
to every existing user through silent auto-update, into an extension holding
`debugger` and `<all_urls>`, with nothing for them to decline. This repository
holds no long-lived secrets (npm publishes over OIDC), and a manual review gates
every store version anyway, so automating the upload would trade that for one
saved click.

`npm run package` handles the two things the store rejects an upload over.

The zip holds the contents of `extension/`, not the folder itself: a package
whose manifest is not at the root is invalid, and the dashboard says only that
the package could not be uploaded.

And the `key` field is stripped from the packaged manifest. The store refuses an
upload that carries one, with "key field is not allowed in manifest" (measured,
not guessed). The repository manifest keeps its key, because that is what pins
the id `oceljemfocgfidhhdlbojkbkmlbfclna` for an unpacked load, which is the id
the native messaging host allowlists. So the two manifests differ in exactly that
one field, and the script reads the packed manifest back out of the archive to
confirm it.

It also refuses to build when package.json and the extension manifest disagree on
the version.

## Store listing tab

**Name** (45 characters max)

    Yoke

**Short description** (132 characters max, currently 111)

    Let MCP clients drive your signed in Chrome: tabs, page text, trusted input, screenshots, console, and network.

**Category**

    Developer Tools

**Language**

    English (United States)

**Detailed description**

    Yoke lets an AI agent or command line tool drive the Chrome you are already
    signed in to, through the Model Context Protocol.

    Unlike a headless browser, there is nothing to log into again. Your sessions,
    cookies, extensions and open tabs are already there, because it is your
    browser.

    WHAT IT DOES

    - Sees every tab in every window, not a managed subset
    - Reads page text, and describes interactive elements so a client can act on
      them by name rather than by guessing coordinates
    - Sends real clicks and keystrokes that pages cannot distinguish from yours
    - Screenshots any tab, including one in the background
    - Reports console messages and network requests for tabs it is driving
    - Puts every tab it touches into a visible tab group, so you can always see
      what is under automation

    HOW IT WORKS

    Yoke is two halves. This extension is one; the other is a local MCP server
    installed from npm:

        npm install -g yoke-mcp
        yoke install

    The extension talks to that server through a native messaging host on your
    own machine. Nothing leaves your computer by way of Yoke.

    The extension does nothing on its own. With no client connected it sits idle:
    there is no popup, no button, and no background activity.

    BEFORE YOU INSTALL

    This gives a local program broad control of a browser you are signed into. It
    can read page content, run JavaScript and send input on any site you point it
    at. Install it only for tools you would trust with that.

    A tab being driven shows Chrome's own "started debugging this browser" bar.
    That is Chrome telling you the truth and Yoke does not hide it.

    Open source, MIT licensed: https://github.com/hamzahamidi/yoke

## Privacy tab

**Single purpose** (1,000 characters, this is 347)

    Yoke gives a local Model Context Protocol client controlled access to the
    user's own browser, so that developer tools and AI assistants can read and
    operate pages in the browser session the user is already signed in to. Every
    action names one tab explicitly, and the extension does nothing until a
    client the user installed and started asks it to.

**Permission justifications** (1,000 characters each; the form has one box per
permission, labelled exactly as below, plus one for the host permission)

The form warns here that "because of the host permission, your extension may
require an in-depth review that will delay publishing". Expect weeks.

`tabs justification` (472)

    Yoke's client addresses every tab explicitly by id, so it must be able to
    enumerate them: this permission provides the tab list across all windows with
    each tab's id, title, URL and group. It is also what allows opening a tab,
    navigating a named tab to a URL, and closing a named tab, which are the
    operations a caller uses to set up the page it wants to work on. Nothing here
    acts on an implied or active tab; a tab id from this list is required by every
    other operation.

`tabGroups justification` (478)

    Used only for transparency. Tabs that Yoke drives or reads are placed in one
    tab group titled "yoke", so the user can see at a glance which tabs are under
    automation rather than discovering it. This permission provides creating that
    group, reusing it, setting its title and colour, and removing tabs from it. No
    functionality depends on the grouping: no operation locates a tab through its
    group, and a user may rename or delete the group at any time without affecting
    anything.

`nativeMessaging justification` (538)

    Yoke is two halves: this extension and a local MCP server the user installs
    from npm. Native messaging is the only mechanism by which an extension can
    communicate with a program on the user's own machine, and Chrome will only
    start such a host itself, so this permission is what makes the product
    possible at all. The extension connects to exactly one host,
    io.github.hamzahamidi.yoke, whose manifest on the user's disk allowlists this
    extension's id. No data is sent anywhere else, and the extension makes no
    network requests of its own.

`scripting justification` (584)

    Used to read a page the caller named: its visible text, and a description of
    its interactive elements (links, buttons, form fields) so a client can act on
    them by reference rather than by guessing screen coordinates. It is also used
    to resolve such a reference back to an element at the moment of a click, so a
    page that has scrolled is not clicked in the wrong place. Injection happens
    only into a tab named by id in a specific request, never automatically, never
    on a schedule, and never on page load. The contents of password fields are
    deliberately excluded from what is reported.

`debugger justification` (676)

    Required for two things an extension cannot do any other way. First, trusted
    input: an event synthesised from a content script arrives at the page with
    isTrusted false and is ignored by many sites, so chrome.debugger is the only
    route to a click or keystroke a page treats as genuine. Second, capturing a
    tab that is not in the foreground, which chrome.tabs.captureVisibleTab cannot
    do. It also supplies the console messages and network request metadata Yoke
    reports for a tab being driven. It is attached only to a tab named in a
    request, Chrome's own debugging notification is left visible rather than
    suppressed, and the extension exposes an operation to detach on request.

`Host permission justification` (500)

    Yoke cannot know in advance which sites its user will work on, so it cannot
    ship a fixed host list: the user chooses the tab, one request at a time, by
    id. The host permission is what allows reading and driving whichever page
    that is. It is never used to act on a page the caller did not name, there is
    no background or automatic access to any site, and nothing runs on page load.
    Narrowing this to per-site permissions requested at first use is planned and
    tracked publicly in the project's roadmap.

**Are you using remote code?**

Answer **Yes**, and this is a deliberate call rather than the default the form
arrives with.

The form defines remote code as "any JS or Wasm that is not included in the
extension's package... including strings evaluated through eval()". None of
Yoke's own code is remote: there are no external script tags, no modules loaded
from a URL, and no eval in the extension's own context. But `run_javascript`
evaluates a string that did not come from the package, and answering No would be
a certification that contradicts a tool named after exactly that.

The cost of Yes is a stricter review. The cost of a No that a reviewer disagrees
with is removal after publication, which is not a trade worth taking.

`Justification` (655)

    No remotely hosted code is fetched or executed. All of the extension's own
    code ships inside the package: there are no external script references, no
    modules loaded from a URL, and no eval in the extension's own context.

    This is answered Yes because Yoke exposes an operation that evaluates a
    JavaScript string in a page, and that string does not come from the package.
    It comes from the local MCP server the user installed, over native messaging,
    at the user's direction, and it runs in a tab the caller named. It is the same
    capability the DevTools console gives its user, offered to a program on the
    same machine rather than to a person at a keyboard.

**Data usage: tick exactly two boxes**

Two of the nine are Yes, and getting this wrong is worse than a rejection: the
same section carries the Limited Use certification, so a false answer is grounds
for removal after publication rather than something you iterate on.

Google's user data FAQ defines the test, and local processing does not exempt
anything: "by 'handle' we mean collecting, transmitting, using, or sharing user
data", and extensions "are required to disclose how they handle user data, even
when data is processed or stored locally on a user's device and is not
transmitted to external servers or third parties". It names this case directly:
"clipping or scraping content from a website that the user visits, such as taking
screenshots or capturing data from a web page".

| Checkbox | Tick |
| --- | --- |
| Personally identifiable information | no |
| Health information | no |
| Financial and payment information | no |
| Authentication information | no |
| Personal communications | no |
| Location | no |
| Web history | no |
| **User activity** | **yes** |
| **Website content** | **yes** |

`User activity` is described in the form as "network monitoring, clicks, mouse
position, scroll or keystroke logging". Yoke reports network requests and console
output, and dispatches clicks and keystrokes, so this is plainly yes.

`Website content` is "text, images, sounds, videos or hyperlinks". `get_page_text`,
`read_page` and `screenshot` return exactly that.

`Authentication information` stays no: password field values are deliberately
excluded from what Yoke reports, so it does not handle them.

`Web history` stays no: Yoke reports the tabs open right now and never reads or
retains browsing history.

**Certify all three**

They hold truthfully, because Yoke passes data only to the local client the user
themselves connected, which is the item's single purpose, and sends it nowhere
else.

- I do not sell or transfer user data to third parties, apart from the approved
  use cases
- I do not use or transfer user data for purposes that are unrelated to my item's
  single purpose
- I do not use or transfer user data to determine creditworthiness or for lending
  purposes

**Privacy policy URL** (required, since data is handled)

    https://github.com/hamzahamidi/yoke/blob/main/PRIVACY.md

## Test instructions tab

The field a reviewer needs most, and the one most likely to sink this if it is
left empty. Yoke's other half installs from npm, so an extension loaded into a
clean profile reports "Not connected" and does nothing until that is done. A
reviewer who cannot exercise it rejects it.

**Username** and **Password**: leave both blank. There is no account, no login and
no server to sign in to, so there is nothing to give.

**Additional instructions** (500 characters, this is 449)

    No login or account needed. Yoke has a second half: a local server, installed
    separately, which is why the extension alone shows nothing.

    1. Install Node 22 or later
    2. npm install -g yoke-mcp
    3. yoke install
    4. Reload Yoke at chrome://extensions
    5. Click the Yoke toolbar icon. It should read "Connected"

    `yoke doctor` checks every link in the chain and names any broken one.

    Setup and troubleshooting: https://github.com/hamzahamidi/yoke#readme

Step 5 is the point of the whole thing: it lets a reviewer confirm the extension
works without wiring up an MCP client at all. The panel reads the state of the
native messaging connection, so "Connected" proves the chain end to end. Without
the panel there was nothing a reviewer could look at, which is the rejection this
listing was most exposed to.

## Graphic assets

| Asset | Size | Required |
| --- | --- | --- |
| Store icon | 128x128 PNG | yes, use `extension/icons/128.png` |
| Screenshot | 1280x800 or 640x400 PNG | yes, use `docs/store/screenshot-1280x800.png` |
| Small promo tile | 440x280 PNG | no |
| Marquee promo tile | 1400x560 PNG | no |

## After uploading, before publishing

Do this while the item is still a draft, because it is what keeps native
messaging working.

Done for this listing. The item id is `mebojgahcmmffbaonhnmmjhmbdbfbamm`, and as
predicted it is not `oceljemfocgfidhhdlbojkbkmlbfclna`: an upload may not carry a
`key`, so it cannot choose its id. Both are in `EXTENSION_IDS` in
`src/install.ts`, so `yoke install` allowlists both and either install works.

One sequencing rule remains, and it is absolute: **the release carrying both ids
must be on npm before the listing is visible to anyone.** A store install whose
host manifest allowlists only the unpacked id fails silently, because Chrome
refuses the connection and reports nothing on the server side. Anyone who already
ran `yoke install` needs to run it again, since nothing else rewrites that file.
