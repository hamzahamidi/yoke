// The host half, with a fake Chrome on its stdio and no browser.
//
// Chrome owns this process: it spawns it, speaks the 4 byte length prefixed
// framing over stdin and stdout, and is the only thing that can answer for the
// extension. So a test plays Chrome, and what it withholds is the point. A fake
// that never answers is a worker that died around the moment it opened the port,
// which is the state a real browser reaches and nothing here can force.
//
// The endpoint directory comes from XDG_RUNTIME_DIR, so each test gets its own
// and none of them touch the endpoints on the machine running the suite.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// The host serves a unix socket; the Windows pipe path is untested, as in the
// rest of the suite.
const skip = process.platform === 'win32';

interface Request {
  id: number;
  op: string;
}

/** What the fake answers, or undefined to say nothing at all. */
type Answer = (op: string) => Record<string, unknown> | undefined;

interface Chrome {
  /** Every op the host asked, in order. */
  asked: string[];
  /** Where the host would put a socket, if it claims one. */
  endpoints: string;
  /** Resolves with the exit code once the host stops on its own. */
  stopped: Promise<number | null>;
  stop(): void;
}

function play(answer: Answer, runtime = mkdtempSync(join(tmpdir(), 'yoke-host-test-'))): Chrome {
  const child: ChildProcess = spawn(process.execPath, ['dist/native-host.js'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, XDG_RUNTIME_DIR: runtime },
  });
  const asked: string[] = [];

  const write = (message: unknown): void => {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    child.stdin?.write(Buffer.concat([header, body]));
  };

  let buffer = Buffer.alloc(0);
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 4) { return; }
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) { return; }
      const request = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8')) as Request;
      buffer = buffer.subarray(4 + length);
      asked.push(request.op);
      const reply = answer(request.op);
      if (reply !== undefined) { write({ id: request.id, ...reply }); }
    }
  });

  const stopped = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => { resolve(code); });
  });

  return {
    asked,
    endpoints: join(runtime, 'yoke'),
    stopped,
    stop: () => {
      child.kill();
      rmSync(runtime, { recursive: true, force: true });
    },
  };
}

const sockets = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : []);

/** Long enough for both 3 second handshake windows, and no longer. */
const HANDSHAKE_LIMIT_MS = 9_000;

/** Resolves when the host has claimed something, or when it has run out of time to. */
async function settle(chrome: Chrome): Promise<void> {
  const deadline = Date.now() + HANDSHAKE_LIMIT_MS;
  for (;;) {
    if (sockets(chrome.endpoints).length > 0) { return; }
    const exited = await Promise.race([
      chrome.stopped.then(() => true),
      new Promise<boolean>((resolve) => { setTimeout(() => { resolve(false); }, 100); }),
    ]);
    if (exited || Date.now() > deadline) { return; }
  }
}

test('a host whose extension never answers claims nothing', { skip }, async () => {
  const chrome = play(() => undefined);
  try {
    await settle(chrome);

    assert.deepEqual(sockets(chrome.endpoints), [], 'a silent extension must not leave an endpoint behind');
    assert.equal(await chrome.stopped, 0, 'the host should stop rather than serve a socket nobody answers');
    assert.deepEqual(chrome.asked, ['identify'], 'it should not go on to ask for tabs');
  } finally {
    chrome.stop();
  }
});

test('a host whose extension predates identify keeps the shared endpoint', { skip }, async () => {
  const chrome = play((op) => {
    if (op === 'identify') { return { ok: false, error: 'unknown op identify' }; }
    return { ok: true, data: { tabs: [{ id: 1, windowId: 1, url: 'https://example.com', title: 'one' }] } };
  });
  try {
    await settle(chrome);

    assert.deepEqual(sockets(chrome.endpoints), ['extension.sock'], 'an explicit refusal is still an answer');
  } finally {
    chrome.stop();
  }
});

/** One line in, one line out, the way a host serves its socket. */
function ask(path: string, op: string, timeoutMs = 3_000): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const socket = connect(path);
    let text = '';
    const settle = (value: Record<string, unknown> | undefined): void => { socket.destroy(); resolve(value); };
    const timer = setTimeout(() => { settle(undefined); }, timeoutMs);
    socket.on('connect', () => { socket.write(`${JSON.stringify({ op, args: {} })}\n`); });
    socket.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
      const cut = text.indexOf('\n');
      if (cut === -1) { return; }
      clearTimeout(timer);
      settle(JSON.parse(text.slice(0, cut)) as Record<string, unknown>);
    });
    socket.on('error', () => { clearTimeout(timer); settle(undefined); });
  });
}

/**
 * A host already on the path, answering the way the one it models does.
 *
 * A host that has lost its service worker still accepts connections, which is
 * what makes it look alive, and answers every op with the relay's own timeout
 * error. A healthy one passes the question to an extension that answers.
 */
function incumbent(path: string, reply: Record<string, unknown>): Promise<{ server: Server; asked: string[] }> {
  const asked: string[] = [];
  const server = createServer((connection) => {
    connection.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (!line.trim()) { continue; }
        asked.push((JSON.parse(line) as { op: string }).op);
        connection.write(`${JSON.stringify(reply)}\n`);
      }
    });
    connection.on('error', () => { });
  });
  return new Promise((resolve) => { server.listen(path, () => { resolve({ server, asked }); }); });
}

/** Resolves once the path answers a ping the way a working host does. */
async function serving(path: string, withinMs = 9_000): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    if ((await ask(path, 'ping', 1_000))?.['ok'] === true) { return true; }
    if (Date.now() > deadline) { return false; }
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
}

test('a host takes an endpoint whose incumbent cannot answer', { skip }, async () => {
  const runtime = mkdtempSync(join(tmpdir(), 'yoke-host-test-'));
  mkdirSync(join(runtime, 'yoke'), { recursive: true, mode: 0o700 });
  const path = join(runtime, 'yoke', 'ab12cd34.sock');
  const corpse = await incumbent(path, { ok: false, error: 'the extension did not answer' });
  const chrome = play((op) => (op === 'identify'
    ? { ok: true, data: { id: 'ab12cd34', label: 'work' } }
    : { ok: true, data: { tabs: [{ id: 1, windowId: 1, url: 'https://example.com', title: 'one' }] } }), runtime);
  try {
    assert.ok(await serving(path), 'the new host should end up serving the endpoint');
    assert.ok(corpse.asked.includes('ping'), 'it should have asked the incumbent for proof of life');
  } finally {
    corpse.server.close();
    chrome.stop();
  }
});

test('a host leaves an endpoint alone while its incumbent answers', { skip }, async () => {
  const runtime = mkdtempSync(join(tmpdir(), 'yoke-host-test-'));
  mkdirSync(join(runtime, 'yoke'), { recursive: true, mode: 0o700 });
  const path = join(runtime, 'yoke', 'ab12cd34.sock');
  const live = await incumbent(path, { ok: true, data: { pong: true } });
  const chrome = play((op) => (op === 'identify'
    ? { ok: true, data: { id: 'ab12cd34', label: 'work' } }
    : { ok: true, data: { tabs: [{ id: 1, windowId: 1, url: 'https://example.com', title: 'one' }] } }), runtime);
  try {
    assert.equal(await chrome.stopped, 0, 'the newcomer should step aside rather than take a served endpoint');
    assert.ok(live.asked.includes('ping'));
  } finally {
    live.server.close();
    chrome.stop();
  }
});

test('a host whose extension names itself gets that endpoint', { skip }, async () => {
  const chrome = play((op) => {
    if (op === 'identify') { return { ok: true, data: { id: 'ab12cd34', label: 'work' } }; }
    return { ok: true, data: { tabs: [{ id: 1, windowId: 1, url: 'https://example.com', title: 'one' }] } };
  });
  try {
    await settle(chrome);

    assert.deepEqual(sockets(chrome.endpoints), ['ab12cd34.sock']);
  } finally {
    chrome.stop();
  }
});
