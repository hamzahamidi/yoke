// The MCP surface, offline. No browser, no extension, no socket.
//
// The protocol shape and the URL redaction are the two things that must not
// regress quietly: a client parses the former, and the latter is what keeps a
// session token out of a tab listing.
import assert from 'node:assert/strict';
import { test } from 'node:test';

// Imports the built output on purpose: the artifact that ships is the one
// worth asserting against, and it also sidesteps resolving TypeScript's .js
// import convention under the type-stripping test runner.
import { handle, shownUrl, TOOLS } from '../dist/mcp-server.js';

test('initialize answers what a client needs to proceed', async () => {
  const init = await handle({ method: 'initialize' }) as {
    protocolVersion: string;
    capabilities: { tools: unknown };
    serverInfo: { name: string };
  };
  assert.equal(typeof init.protocolVersion, 'string');
  assert.equal(typeof init.capabilities.tools, 'object');
  assert.equal(init.serverInfo.name, 'yoke');
});

test('every tool is well formed', async () => {
  const listed = await handle({ method: 'tools/list' }) as { tools: typeof TOOLS };
  assert.ok(Array.isArray(listed.tools));
  for (const tool of listed.tools) {
    assert.ok(tool.name.length > 0, 'a tool needs a name');
    assert.ok(tool.description.length > 0, 'a tool needs a description');
    assert.equal(tool.inputSchema.type, 'object');
  }
});

test('list_tabs promises every tab in every window, which is the point of the project', () => {
  const tabs = TOOLS.find((tool) => tool.name === 'list_tabs');
  assert.ok(tabs, 'list_tabs must exist');
  // The scope, not the phrasing. This used to require the words "whole browser"
  // and failed when the copy was reworded, although the promise was unchanged.
  assert.match(tabs.description, /every open tab/);
  assert.match(tabs.description, /across all windows/);
});

test('an unknown method throws and an unknown tool does not', async () => {
  await assert.rejects(() => handle({ method: 'nonsense' }));
  const result = await handle({ method: 'tools/call', params: { name: 'nope' } }) as { isError?: boolean };
  assert.equal(result.isError, true);
});

test('tool calls reject tab ids that were not returned by list_tabs', async () => {
  await assert.rejects(
    () => handle({
      method: 'tools/call',
      params: { name: 'navigate', arguments: { tab_id: 'not a number', url: 'https://example.com' } },
    }),
    /tab_id must be an integer from list_tabs/,
  );
});

test('a url is reduced to origin and path unless asked otherwise', () => {
  // A raw URL can carry a token, and a tab listing is exactly where one gets
  // copied into a log.
  assert.equal(shownUrl('https://example.com/a/b?token=secret#frag'), 'https://example.com/a/b');
  assert.equal(shownUrl('https://example.com/'), 'https://example.com');
  assert.equal(shownUrl('https://example.com/a?token=secret', true), 'https://example.com/a?token=secret');
});

test('a wrapper scheme shows only its scheme, since its path can be another url', () => {
  assert.equal(shownUrl('blob:https://example.com/uuid'), 'blob:');
  assert.equal(shownUrl('chrome://newtab/'), 'chrome:');
  assert.equal(shownUrl('not a url'), '(unparseable url)');
});
