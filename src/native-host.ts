#!/usr/bin/env node
// The native messaging host: a relay, and nothing more.
//
// Chrome owns this process. It spawns it when the extension calls
// connectNative, talks to it over stdin and stdout using a 4-byte
// little-endian length prefix per JSON message, and kills it when the extension
// disconnects. So a client cannot be the one to start it, and needs a second hop
// to reach the extension at all.
//
// That hop is a unix socket in a 0700 directory the user owns, rather than a TCP
// port. Whoever reaches this endpoint can read every tab in a logged-in browser,
// so "any local process can connect" is not an acceptable posture; file
// permissions are the cheapest correct answer. Windows gets a named pipe, where
// the path namespace plays the same role.
import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';

import {
  PROTOCOL, isResponse, type ArgsOf, type OperationName, type Request, type SocketReply, type SocketRequest,
} from './protocol.js';
import { LEGACY_ID, endpointPathFor, isEndpointId } from './socket-path.js';

const DEFAULT_TIMEOUT_MS = 15_000;
/**
 * How long the extension has to identify itself before this host gives up on it.
 *
 * Short because the answer comes from a worker that is already running: Chrome
 * spawned this process because that worker asked it to. A window this size is
 * about telling a live extension from an absent one, not about waiting out a
 * slow one.
 */
const IDENTIFY_MS = 3_000;
/**
 * How long an endpoint's current owner has to prove it can still serve it.
 *
 * A connection that is accepted proves only that a process is there. The host
 * that owns a path can have lost its extension and still accept, answer every
 * op with the relay's timeout error, and hold the endpoint a working profile
 * should have. So the question is put to it, and only an answer keeps it.
 */
const INCUMBENT_MS = 2_000;
/**
 * How long the extension gets to answer the ping that decides this host's fate.
 *
 * Its own question rather than a caller's, because a caller may have asked for
 * an answer in half a second and been told no. Long enough that a busy worker
 * still answers, short enough that a successor is not left waiting on a corpse.
 */
const CONFIRM_MS = 2_000;
/** How long a successor waits for an incumbent to let go before leaving it alone. */
const RETIRE_WAIT_MS = 8_000;

/** 0700, and verified after creation rather than assumed. */
function prepareDirectory(socketPath: string): void {
  const dir = dirname(socketPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') { return; }
  chmodSync(dir, 0o700);
  const mode = statSync(dir).mode & 0o777;
  if (mode !== 0o700) {
    throw new Error(`${dir} is mode ${mode.toString(8)}, refusing to listen where others can reach the socket`);
  }
}

/** Chrome's framing: one 4-byte little-endian length, then that many JSON bytes. */
function writeToChrome(message: Request): void {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function readFromChrome(onMessage: (message: unknown) => void): void {
  let buffer = Buffer.alloc(0);
  process.stdin.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 4) { return; }
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) { return; }
      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      try { onMessage(JSON.parse(body.toString('utf8'))); } catch { /* not ours to fix */ }
    }
  });
}

export async function main(): Promise<void> {
  const waiting = new Map<number, (reply: SocketReply) => void>();
  let nextId = 1;
  let server: Server | undefined;
  let socketPath: string | undefined;

  let listening = false;

  /**
   * Lets go of the endpoint, with exactly one unlink of the path.
   *
   * `server.close()` is what removes a unix socket, and it removes whatever is
   * at that name rather than the socket it opened. A second unlink from here
   * could therefore delete a successor's socket that took the name in between,
   * which is the same theft this file exists to prevent, arriving late. So the
   * explicit unlink is only for a path this process reserved and never served.
   */
  const cleanup = (): void => {
    const path = socketPath;
    socketPath = undefined;
    try { server?.close(); } catch { /* never listened */ }
    if (!listening && process.platform !== 'win32' && path !== undefined) {
      try { unlinkSync(path); } catch { /* already gone */ }
    }
  };

  /** One question to the extension, answered with undefined when it stays silent. */
  const askExtension = <K extends OperationName>(op: K, args: ArgsOf<K>, timeoutMs: number): Promise<SocketReply | undefined> =>
    new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => { waiting.delete(id); resolve(undefined); }, timeoutMs);
      waiting.set(id, (reply) => { clearTimeout(timer); resolve(reply); });
      writeToChrome({ id, op, args });
    });

  /** True while a confirmation is in flight, so a burst of timeouts asks once. */
  let confirming = false;

  /**
   * Gives the endpoint back when the extension behind it has gone.
   *
   * A request that times out is the first sign, and on its own it only says the
   * extension was slow for one caller's budget, so it is confirmed with a `ping`
   * of this host's own. Two silences mean there is nothing to relay to, and a
   * host in that state is worse than no host: its socket answers every caller
   * with a timeout, and the profile that could serve the endpoint cannot have it
   * while this one holds the name. Letting go is also what lets a successor bind
   * without taking a path out from under a running server.
   */
  const retireIfTheExtensionIsGone = async (): Promise<void> => {
    if (confirming || !listening) { return; }
    confirming = true;
    const alive = await askExtension('ping', {}, CONFIRM_MS);
    confirming = false;
    if (alive !== undefined) { return; }
    process.stderr.write(
      'the extension stopped answering, so this host is giving up its endpoint and exiting. Chrome can stop '
      + 'a service worker while leaving this process its pipe, and an endpoint nobody can serve is worse than '
      + 'none: the next caller is told the extension is not connected, which is true.\n');
    cleanup();
    process.exit(0);
  };

  readFromChrome((message) => {
    if (!isResponse(message)) { return; }
    const settle = waiting.get(message.id);
    if (!settle) { return; }
    waiting.delete(message.id);
    settle(message.ok
      ? { ok: true, data: message.data, protocol: PROTOCOL }
      : { ok: false, error: message.error, protocol: PROTOCOL });
  });

  // Chrome closing stdin means the extension went away, so the socket must go
  // too rather than linger and accept callers it can no longer serve.
  process.stdin.on('end', () => { cleanup(); process.exit(0); });

  server = createServer((connection: Socket) => {
    let text = '';
    connection.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
      for (;;) {
        const cut = text.indexOf('\n');
        if (cut === -1) { return; }
        const line = text.slice(0, cut);
        text = text.slice(cut + 1);
        if (!line.trim()) { continue; }

        let request: SocketRequest;
        try {
          request = JSON.parse(line) as SocketRequest;
        } catch {
          const reply: SocketReply = { ok: false, error: 'each line must be one JSON object' };
          connection.write(`${JSON.stringify(reply)}\n`);
          continue;
        }

        const id = nextId++;
        // A silent extension must not hang the caller, and a caller that hangs
        // up must not leave the relay waiting forever.
        const timer = setTimeout(() => {
          if (!waiting.delete(id)) { return; }
          const reply: SocketReply = { ok: false, error: 'the extension did not answer' };
          try { connection.write(`${JSON.stringify(reply)}\n`); } catch { /* gone */ }
          void retireIfTheExtensionIsGone();
        }, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);

        waiting.set(id, (reply) => {
          clearTimeout(timer);
          try { connection.write(`${JSON.stringify(reply)}\n`); } catch { /* caller hung up */ }
        });
        writeToChrome({ id, op: request.op, args: request.args as never });
      }
    });
    connection.on('error', () => { /* a caller going away is not our failure */ });
  });

  // Chrome starts one of these per profile and tells it nothing about which, so
  // the extension is asked. Its answer names the endpoint, which is what lets two
  // profiles be connected at once. An extension from before the question falls
  // back to the path every earlier release used, so it keeps the behaviour it
  // had rather than landing somewhere new.
  const identity = await askExtension('identify', {}, IDENTIFY_MS);
  // Silence is not an old extension, it is no extension. Chrome can leave this
  // process holding a pipe whose service worker is already gone, and a host that
  // then claims an endpoint serves a socket that answers "the extension did not
  // answer" to everything: a caller sees a browser with no tabs rather than a
  // browser that is not there, and the profile that should own that endpoint
  // cannot take it. Exiting makes liveness one thing, decided here, instead of
  // something every command has to work out for itself.
  if (identity === undefined) {
    process.stderr.write(
      'the extension did not answer, so this host is claiming no endpoint. Chrome starts a host for a '
      + 'connection its service worker may no longer be there to serve, and a socket nobody answers reads '
      + 'as a working browser.\n');
    cleanup();
    process.exit(0);
  }
  const claimed = identity.ok ? (identity.data as { id?: unknown } | undefined)?.id : undefined;
  const id = isEndpointId(claimed) ? claimed : LEGACY_ID;
  if (id === LEGACY_ID) {
    process.stderr.write(
      'the extension in this profile does not say which profile it is, so this host is using the shared '
      + 'endpoint. Reload the extension at chrome://extensions to give this profile its own.\n');
  }

  // Asked before the endpoint is claimed, because a profile with nothing in it
  // must not take the endpoint from one the user is actually looking at.
  //
  // The check lives here rather than in the extension because the host is
  // spawned fresh by Chrome for every connection, so it always runs current
  // code, while an extension in another profile may be running whatever was on
  // disk when that profile last loaded it. Relying on the extension to
  // self-restrict only works once every profile has been reloaded, which is not
  // something this can assume.
  const listed = await askExtension('listTabs', {}, IDENTIFY_MS);
  // Silence used to be given the benefit of the doubt here, which let a worker
  // that died between the two questions take an endpoint on the strength of the
  // first one. Naming itself is not the same as being able to serve, so the rule
  // is the same as above: only an answer counts.
  if (listed === undefined) {
    process.stderr.write(
      'the extension named this profile and then stopped answering, so this host is claiming no endpoint. '
      + 'Chrome can stop a service worker between one question and the next, and an endpoint it holds '
      + 'without being able to serve it is worse than none.\n');
    cleanup();
    process.exit(0);
  }

  // An error means the profile could not answer at all, which includes
  // "No current window", and is not drivable.
  const drivable = listed.ok
    && Array.isArray((listed.data as { tabs?: unknown[] } | undefined)?.tabs)
    && ((listed.data as { tabs: unknown[] }).tabs.length > 0);

  if (!drivable) {
    process.stderr.write(
      'this Chrome profile has no tabs, so it is not claiming a yoke endpoint: a caller driving it '
      + 'would be operating a browser nobody can see.\n');
    process.exit(0);
  }

  socketPath = endpointPathFor(id);
  prepareDirectory(socketPath);
  await claimEndpoint(socketPath);
  // Two hosts can reach a freed name in the same breath, and the one that loses
  // gets EADDRINUSE. Without this it is an unhandled error event and a stack
  // trace in the extension's log; with it, the loser is simply the one that
  // leaves, which is what it would have done had it asked a moment later.
  server.on('error', (failure: NodeJS.ErrnoException) => {
    process.stderr.write(`this host could not take ${String(socketPath)}: ${failure.message}\n`);
    process.exit(0);
  });

  server.listen(socketPath, () => {
    listening = true;
    if (process.platform !== 'win32' && socketPath !== undefined) { chmodSync(socketPath, 0o600); }
  });

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => { cleanup(); process.exit(0); });
  }
}

/**
 * Takes the socket path, but only if nobody live is using it.
 *
 * The path is per profile now, so two live hosts wanting one path means a
 * profile whose extension predates per-profile endpoints and so shares the old
 * one, or a host Chrome has not finished stopping. When the path was per user
 * this was the everyday case: unlinking unconditionally let the second profile's
 * host steal it, and the MCP server then drove a different browser than the one
 * the person was looking at, with no error anywhere. Observed as `list_tabs`
 * returning 0 while the visible window held 40 tabs.
 *
 * So the owner is asked to prove it: a `ping`, which only reaches an answer
 * through an extension that is still there. An answer means a live host owns the
 * path and this one has nothing to offer, so it exits and Chrome surfaces that to
 * the extension rather than the two of them trading the socket back and forth.
 * Anything else, whether a refused connection, silence, or the relay's own
 * "the extension did not answer", means the file is a corpse and unlinking it is
 * right. A connect that merely succeeds proves only that a process is there,
 * which a host that has outlived its service worker also manages.
 */
async function claimEndpoint(socketPath: string): Promise<void> {
  if (process.platform === 'win32') { return; }
  if (!existsSync(socketPath)) { return; }

  const owner = await askOwner(socketPath);

  if (owner === 'answering') {
    process.stderr.write(
      `another yoke host already owns ${socketPath}. This one is exiting rather than taking it, `
      + 'because doing so would point the server at a different browser profile. Each profile '
      + 'gets its own endpoint once its extension has been reloaded at chrome://extensions.\n');
    process.exit(0);
  }

  if (owner === 'nobody') {
    // Nothing is listening, so the file is what a host killed before it could
    // clean up leaves behind, and removing it is the only way past it.
    try { unlinkSync(socketPath); } catch { /* nothing there */ }
    return;
  }

  // Listening and not answering: a host that has lost its extension. The ping
  // above is what makes it notice, and it gives the endpoint up itself.
  //
  // Waiting rather than unlinking, because `server.close()` removes whatever
  // holds the name at the moment it runs, not the socket it opened. Taking the
  // path from a server that is still up means losing it later, when that server
  // finally stops and takes the successor's socket with it.
  const deadline = Date.now() + RETIRE_WAIT_MS;
  while (existsSync(socketPath)) {
    if (Date.now() > deadline) {
      process.stderr.write(
        `the host on ${socketPath} is not answering and has not let go, so this one is exiting rather `
        + 'than taking a name another process is still serving.\n');
      process.exit(0);
    }
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
}

/** What is behind an endpoint: an extension that answers, one that does not, or no process at all. */
type Owner = 'answering' | 'silent' | 'nobody';

function askOwner(socketPath: string): Promise<Owner> {
  return new Promise<Owner>((resolve) => {
    const probe = connect(socketPath);
    let text = '';
    let connected = false;
    const settle = (value: Owner): void => { probe.destroy(); resolve(value); };
    // Longer than the budget the question carries, so the host's own answer
    // arrives first and a timeout here means it did not even manage that.
    const timer = setTimeout(() => { settle(connected ? 'silent' : 'nobody'); }, INCUMBENT_MS + 500);
    timer.unref();
    probe.on('connect', () => {
      connected = true;
      probe.write(`${JSON.stringify({ op: 'ping', args: {}, timeoutMs: INCUMBENT_MS })}\n`);
    });
    probe.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
      const cut = text.indexOf('\n');
      if (cut === -1) { return; }
      clearTimeout(timer);
      try {
        settle((JSON.parse(text.slice(0, cut)) as { ok?: unknown }).ok === true ? 'answering' : 'silent');
      } catch {
        settle('silent');
      }
    });
    probe.on('error', () => { clearTimeout(timer); settle('nobody'); });
  });
}

// Runs unconditionally, because this file exists only to be executed.
//
// It used to be guarded by comparing process.argv[1] to this module's path,
// which can never match: Chrome invokes a native messaging host with the calling
// extension's origin as argv[1], not the script path. So the guard was always
// false, main() never ran, the process exited instantly, and Chrome reported
// "Native host has exited" with nothing else to go on. An entry point that the
// runner invokes with unpredictable arguments cannot detect itself from argv, so
// it should not try.
void main().catch((failure) => {
  process.stderr.write(`yoke host failed to start: ${String(failure)}\n`);
  process.exit(1);
});
