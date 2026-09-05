# Privacy policy for Yoke

Last updated: 5 September 2026

Yoke handles a lot of what is on your screen, and sends none of it to us.

There is no Yoke server, no account, no analytics and no telemetry. Every hop is
between processes on your own machine. But "we receive nothing" is not the same
as "nothing is handled", and the honest version is the second one: Yoke reads
page content, captures screenshots and observes network activity when asked to,
and hands all of it to the local client you connected. Where that client sends it
next is the question worth asking, and it is answered below.

## What Yoke can see

Yoke exists to drive the browser you are already signed in to, so it can see a
great deal:

- Every tab and tab group in every window, with titles and URLs.
- The text and the interactive structure of any page it is asked to read.
- Screenshots of any tab it is asked to capture.
- Console messages and network request metadata (method, URL, status) for any tab
  it is attached to.
- Anything a page displays while it is being driven.

It reads these only when a connected client asks for a specific tab by id. There
is no background collection, no crawling, and nothing is read on a schedule.

## Where that information goes

To one place: the local program you connected. The path is

    extension  ->  native messaging host  ->  Unix socket  ->  MCP server  ->  your client

Every hop is on your computer. The sockets, one per Chrome profile, live in a
directory readable only by your user account. Nothing is written to a remote service by Yoke, and the
extension makes no network requests of its own.

What your client then does with what it receives is outside Yoke's control and
governed by that client's own policy. If the client is an AI assistant, page
content you ask Yoke to read will be sent to whatever model that assistant uses.
That is a property of the tool you connected, not of Yoke, and it is the main
thing to understand before installing.

## What Yoke stores

Almost nothing, and nothing that outlives the browser:

- Console messages and network requests for tabs being driven, kept in memory
  only, capped at 500 entries per tab, and discarded when the tab closes, when
  the debugger detaches, or when Chrome restarts the extension.
- A random eight character id for the Chrome profile the extension runs in, and
  the label you type for it in the popup, kept in the extension's own storage in
  that profile. The id names the local socket for that profile and appears in
  tool output so a client can tell two profiles apart. It is not derived from
  anything about you and is not sent anywhere.
- No cookies, credentials, passwords, form values or browsing history are
  recorded or persisted anywhere by Yoke.

The values of password fields are deliberately excluded from what Yoke reports
about a page. The field is described so a client can type into it; its contents
are not returned.

URL fields in tool output are reduced to origin and path, because query strings
routinely carry session tokens. `list_tabs` accepts `full_urls` to opt out of
that, and it is the only tool that does: everywhere else the reduction is
unconditional.

Redaction covers URL fields and not whole payloads, which is worth stating
plainly rather than leaving to be discovered. A page's own text comes back as it
is, so a URL printed on the page arrives whole. So do console messages, and the
value of any expression a caller evaluates, including `location.href` or
`document.cookie`. Screenshots are pixels and are not filtered at all. The
redaction stops Yoke from volunteering a URL, and it is not a filter on what a
page can tell a caller that asks.

## Permissions and why each exists

| Permission | Why |
| --- | --- |
| `tabs` | List, open, navigate and close tabs by id, and see which group each is in. |
| `tabGroups` | Put the tabs it drives into one visible group, so you can see what is under automation. |
| `nativeMessaging` | Talk to the local host, which is the only way an extension can reach a program on your machine. |
| `scripting` | Read page text and describe interactive elements. |
| `debugger` | Send input a page cannot distinguish from yours, and capture background tabs. An extension has no other route to either. |
| `<all_urls>` | Allow the above on whichever site you ask it to work on, rather than a fixed list. |

Attaching the debugger makes Chrome display its own notification that the browser
is being debugged. That bar is Chrome telling you the truth, and Yoke does not
try to hide or suppress it.

## Data sold or shared

None. There is nobody to sell it to and no channel to share it over.

## Contact

Issues and questions: https://github.com/hamzahamidi/yoke/issues
