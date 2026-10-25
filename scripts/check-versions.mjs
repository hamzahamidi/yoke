// Asserts that every place a version is written agrees.
//
// Three files carry it independently: package.json, the extension manifest, and
// SERVER_VERSION in the MCP server (which is what a client sees on initialize).
// Nothing enforced that before, so a release could ship an extension and a
// server claiming different versions, and the only symptom would be a confusing
// answer to "what am I running".
import { readFileSync } from 'node:fs';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

const pkg = JSON.parse(read('../package.json'));
const manifest = JSON.parse(read('../extension/manifest.json'));

// Read from source rather than dist, so this works before a build.
const serverSource = read('../src/mcp-server.ts');
const found = /SERVER_VERSION\s*=\s*'([^']+)'/.exec(serverSource);
if (!found) {
  throw new Error('could not find SERVER_VERSION in src/mcp-server.ts');
}

const versions = {
  'package.json': pkg.version,
  'extension/manifest.json': manifest.version,
  'src/mcp-server.ts SERVER_VERSION': found[1],
};

const distinct = [...new Set(Object.values(versions))];
if (distinct.length !== 1) {
  const detail = Object.entries(versions).map(([where, value]) => `  ${where}: ${value}`).join('\n');
  throw new Error(`versions disagree:\n${detail}`);
}

console.log(`all three version constants agree: ${distinct[0]}`);
