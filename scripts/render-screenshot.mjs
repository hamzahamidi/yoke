// Renders the store assets: the popup as it really looks, and the 1280x800
// screenshot that embeds it.
//
// The popup is rendered from the built extension rather than mocked up, with one
// stub for chrome.runtime.sendMessage, so the picture in the listing is the
// actual panel and cannot drift from it. That also makes this a test: a popup
// that throws stays on its "Checking" state, and the assertion below fails. It
// is the only check on popup.js that needs no browser.
//
// Served over http rather than opened as a file. popup.html loads its script as
// an ES module, and a module cannot be fetched from a file:// origin, so a file
// render silently produces the unpopulated page and reports no error anywhere.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const storeDir = join(root, 'docs', 'store');
const stage = join(root, 'dist', 'store', 'preview');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

const chromes = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
const chrome = chromes.find((path) => existsSync(path));
if (chrome === undefined) {
  throw new Error(`no Chrome found. Looked in:\n  ${chromes.join('\n  ')}`);
}

const dimensions = (file) => {
  const png = readFileSync(file);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), bytes: png.length };
};

// Asynchronous on purpose. execFileSync blocks the event loop, which means the
// http server below never answers, which means Chrome waits forever for a page
// that is never served. That deadlock looked exactly like a hung renderer.
const run = promisify(execFile);

const shoot = (url, out, width, height) => run(chrome, [
  '--headless', '--disable-gpu', '--hide-scrollbars',
  `--window-size=${width},${height}`,
  // Lets the popup's async render settle. Without it the capture lands while it
  // still says "Checking".
  '--virtual-time-budget=4000',
  `--screenshot=${out}`, url,
], { timeout: 60_000 });

const dumpDom = async (url) => (await run(chrome, [
  '--headless', '--disable-gpu', '--virtual-time-budget=3000', '--dump-dom', url,
], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })).stdout;

// The real popup, with only the message channel stubbed.
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'browser'), { recursive: true });
// The polling timer is dropped for the render, and only for the render. Under
// --virtual-time-budget a repeating timer never lets Chrome finish: virtual time
// advances instantly, so setInterval fires forever and the capture never
// happens. The panel keeps its polling in the extension, where it is what makes
// a live count live.
const previewScript = readFileSync(join(root, 'extension', 'browser', 'popup.js'), 'utf8')
  .split('\n')
  .filter((line) => !line.includes('setInterval'))
  .join('\n');
// Asserted, because the first attempt at this used a regex that could not match
// across the callback's own semicolon, left the timer in, and hung Chrome for
// seven minutes with no output. A silent no-op here is expensive.
if (previewScript.includes('setInterval')) {
  throw new Error('the preview copy still schedules a timer, which will hang the render');
}
writeFileSync(join(stage, 'browser', 'popup.js'), previewScript);

const stub = `<script>
  window.chrome = {
    runtime: {
      getManifest: () => ({ version: '${version}' }),
      sendMessage: (request) => Promise.resolve(
        request.kind === 'status'
          ? { kind: 'status', connected: true, version: '${version}',
              host: 'io.github.hamzahamidi.yoke', attached: [418, 419] }
          : { kind: 'released', count: 2 }),
    },
  };
</script>
`;
writeFileSync(
  join(stage, 'popup.html'),
  readFileSync(join(root, 'extension', 'popup.html'), 'utf8')
    .replace('<script type="module"', `${stub}<script type="module"`));

const types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png' };
const server = createServer((request, response) => {
  const relative = (request.url ?? '/').replace(/^\/+/, '') || 'popup.html';
  for (const base of [stage, storeDir]) {
    const file = join(base, relative);
    if (!file.startsWith(base) || !existsSync(file)) { continue; }
    response.writeHead(200, { 'content-type': types[extname(file)] ?? 'text/plain' });
    response.end(readFileSync(file));
    return;
  }
  response.writeHead(404);
  response.end('not found');
});

await new Promise((ready) => { server.listen(0, '127.0.0.1', ready); });
const { port } = server.address();

try {
  const popupPng = join(storeDir, 'popup.png');
  await shoot(`http://127.0.0.1:${port}/popup.html`, popupPng, 320, 300);

  const dom = await dumpDom(`http://127.0.0.1:${port}/popup.html`);
  const state = (/id="state-text"[^>]*>([^<]*)</.exec(dom) ?? [])[1] ?? '';
  if (state !== 'Connected') {
    throw new Error(
      `the popup rendered with state "${state}" rather than "Connected", so popup.js did not run. `
      + 'Check it for an exception, and that popup.html still loads browser/popup.js as a module.');
  }
  const popup = dimensions(popupPng);
  console.log(`docs/store/popup.png\n  ${popup.bytes} bytes, ${popup.width}x${popup.height}, reached state "Connected"`);

  const out = join(storeDir, 'screenshot-1280x800.png');
  await shoot(`http://127.0.0.1:${port}/screenshot.html`, out, 1280, 800);
  const shot = dimensions(out);
  // The store rejects anything that is not exactly 1280x800 or 640x400, and a
  // wrong window-size fails silently as a resized image.
  if (shot.width !== 1280 || shot.height !== 800) {
    throw new Error(`rendered ${shot.width}x${shot.height}, and the store wants exactly 1280x800`);
  }
  console.log(`docs/store/screenshot-1280x800.png\n  ${shot.bytes} bytes, ${shot.width}x${shot.height}`);
} finally {
  server.close();
  rmSync(stage, { recursive: true, force: true });
}
