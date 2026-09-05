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

  const cleanup = (): void => {
    try { server?.close(); } catch { /* never listened */ }
    if (process.platform !== 'win32' && socketPath !== undefined) {
      try { unlinkSync(socketPath); } catch { /* already gone */ }
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
  const identity = await askExtension('identify', {}, 3_000);
  const claimed = identity?.ok ? (identity.data as { id?: unknown } | undefined)?.id : undefined;
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
  const listed = await askExtension('listTabs', {}, 3_000);
  // Silence is given the benefit of the doubt. An error means the profile could
  // not answer at all, which includes "No current window", and is not drivable.
  const drivable = listed === undefined
    || (listed.ok && Array.isArray((listed.data as { tabs?: unknown[] } | undefined)?.tabs)
      && ((listed.data as { tabs: unknown[] }).tabs.length > 0));

  if (!drivable) {
    process.stderr.write(
      'this Chrome profile has no tabs, so it is not claiming a yoke endpoint: a caller driving it '
      + 'would be operating a browser nobody can see.\n');
    process.exit(0);
  }

  socketPath = endpointPathFor(id);
  prepareDirectory(socketPath);
  await claimEndpoint(socketPath);
  server.listen(socketPath, () => {
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
 * So a connect is attempted first. Succeeding means a live host owns the path
 * and this one has nothing to offer: it exits, and Chrome surfaces that to the
 * extension rather than the two of them trading the socket back and forth.
 * Failing means the file is a corpse from a host Chrome killed, and unlinking it
 * is right.
 */
async function claimEndpoint(socketPath: string): Promise<void> {
  if (process.platform === 'win32') { return; }
  if (!existsSync(socketPath)) { return; }

  const alive = await new Promise<boolean>((resolve) => {
    const probe = connect(socketPath)
      .on('connect', () => { probe.destroy(); resolve(true); })
      .on('error', () => resolve(false));
    // A socket that neither connects nor errors is not a working host either.
    setTimeout(() => { probe.destroy(); resolve(false); }, 500).unref();
  });

  if (alive) {
    process.stderr.write(
      `another yoke host already owns ${socketPath}. This one is exiting rather than taking it, `
      + 'because doing so would point the server at a different browser profile. Each profile '
      + 'gets its own endpoint once its extension has been reloaded at chrome://extensions.\n');
    process.exit(0);
  }

  try { unlinkSync(socketPath); } catch { /* nothing there */ }
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
