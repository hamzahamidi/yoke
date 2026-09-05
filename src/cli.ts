#!/usr/bin/env node
// The one command: register the native host, check the connection, or run the
// MCP server. Everything else this project does is a tool call.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { install, uninstall } from './install.js';
import { endpointDir } from './socket-path.js';

const USAGE = `yoke - browser automation in the Chrome you are already signed in to.

Usage:
  yoke install     register the native messaging host with your browsers
  yoke doctor      check every link in the chain and say which one is broken
  yoke status      is the extension connected?
  yoke uninstall   remove the host registration
  yoke mcp         run the MCP server on stdio (what an MCP client spawns)

Getting set up, once:
  1. npm run build
  2. yoke install
  3. load extension/ at chrome://extensions with Developer mode on
  4. yoke doctor            -> says which link is broken, if any
  5. register the server with your MCP client:
       command: yoke
       args:    ["mcp"]
`;

const EXIT = { OK: 0, UNAVAILABLE: 3, USAGE: 64 } as const;

async function main(): Promise<number> {
  const action = process.argv[2];

  if (action === 'mcp') {
    // Hands over to the server, which owns stdio from here on.
    const { main: serve } = await import('./mcp-server.js');
    serve();
    return EXIT.OK;
  }

  if (action === 'install') {
    const here = dirname(fileURLToPath(import.meta.url));
    const result = install({ hostPath: join(here, 'native-host.js') });
    for (const [browser, file] of result.written) {
      process.stdout.write(`registered for ${browser}: ${file}\n`);
    }
    for (const [browser, reason] of result.skipped) {
      process.stderr.write(`skipped ${browser}: ${reason}\n`);
    }
    if (result.platform === 'win32') {
      const manifest = result.written[0]?.[1];
      if (manifest === undefined) { return EXIT.UNAVAILABLE; }
      // Windows finds the host through the registry, so the file above is only
      // half the job. These are the exact commands for the manifest that was
      // just written, rather than a sentence about a file the caller has to
      // locate: every browser key points at the same manifest.
      process.stdout.write(
        '\nOn Windows the host is found through the registry. Run these, for each browser you use:\n\n');
      for (const key of [
        'Software\\Google\\Chrome',
        'Software\\Chromium',
        'Software\\Microsoft\\Edge',
        'Software\\BraveSoftware\\Brave-Browser',
      ]) {
        process.stdout.write(`  reg add "HKCU\\${key}\\NativeMessagingHosts\\${result.hostName}" /ve /t REG_SZ /d "${manifest}" /f\n`);
      }
      process.stdout.write('\nThen load extension\\ at chrome://extensions with Developer mode on.\n');
      process.stdout.write('This path is written but untested: please report what happens.\n');
      return EXIT.OK;
    }
    if (result.written.length === 0) { return EXIT.UNAVAILABLE; }
    process.stdout.write('\nNow load extension/ at chrome://extensions with Developer mode on.\n');
    process.stdout.write(`It has to keep the id ${result.extensionId}, which the pinned key in its manifest guarantees.\n`);
    return EXIT.OK;
  }

  if (action === 'uninstall') {
    const { removed } = uninstall();
    for (const [browser, file] of removed) { process.stdout.write(`removed for ${browser}: ${file}\n`); }
    if (removed.length === 0) { process.stdout.write('nothing was registered\n'); }
    return EXIT.OK;
  }

  if (action === 'doctor') {
    const { doctor, render } = await import('./doctor.js');
    const checks = await doctor();
    process.stdout.write(render(checks));
    return checks.every((check) => check.ok) ? EXIT.OK : EXIT.UNAVAILABLE;
  }

  if (action === 'status') {
    const { connectedBrowsers } = await import('./browsers.js');
    const browsers = await connectedBrowsers();
    if (browsers.length === 0) {
      process.stdout.write('extension: not reachable\n');
      process.stdout.write(`endpoints: ${endpointDir()}\n`);
      process.stdout.write('\nIf install has run and the extension is loaded, open chrome://extensions and '
        + 'check its service worker is running. Chrome starts the host on demand.\n');
      return EXIT.UNAVAILABLE;
    }
    // One line per profile, because with two connected "connected" alone is
    // exactly the answer that hid the wrong-profile case.
    process.stdout.write(`extension: connected, ${browsers.length} browser(s)\n`);
    for (const browser of browsers) {
      const label = browser.unidentified
        ? '(legacy endpoint; reload the extension so this profile gets its own)'
        : browser.label === '' ? '(unnamed)' : browser.label;
      const tabs = browser.unidentified ? 'tabs unknown' : `${browser.tabs} tab(s)`;
      process.stdout.write(`  ${browser.id}\t${label}\t${tabs}\t${browser.endpoint}\n`);
    }
    return EXIT.OK;
  }

  process.stdout.write(USAGE);
  return action === undefined || action === '-h' || action === '--help' ? EXIT.OK : EXIT.USAGE;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((failure: unknown) => {
    process.stderr.write(`yoke: ${failure instanceof Error ? failure.message : String(failure)}\n`);
    process.exitCode = EXIT.UNAVAILABLE;
  });
