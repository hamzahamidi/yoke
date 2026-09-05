// Where hosts listen, in a module with no side effects.
//
// Separate from the host itself because the host is an entry point: Chrome
// executes it and it must always run. Anything that needs only a path should
// not have to import a file whose job is to start a server.
//
// There is one endpoint per Chrome profile, named after the id the extension
// reports, so two profiles with the extension loaded are both reachable and a
// caller can tell them apart. Before that the path was per user, and the second
// profile to start either stole the endpoint or was refused it (#6, #8).
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The id a host uses when its extension cannot say which profile it is.
 *
 * Chosen so the resulting path is the one every earlier release used, which
 * keeps a not-yet-reloaded extension on the behaviour it had rather than on a
 * new path nothing has documented.
 */
export const LEGACY_ID = 'extension';

/** Only what the extension is allowed to mint, so a path can never escape the directory. */
const SAFE_ID = /^[a-z0-9]{1,32}$/;

export const isEndpointId = (value: unknown): value is string =>
  typeof value === 'string' && SAFE_ID.test(value);

/** The pipe name every release before per-profile endpoints used on Windows. */
const legacyPipe = (): string => `yoke-${process.env['USERNAME'] ?? 'user'}`;
const pipePrefix = (): string => `${legacyPipe()}-`;

/**
 * Kept out of /tmp so another user cannot pre-create it, and out of the
 * project so it survives a rebuild.
 */
export function endpointDir(): string {
  const base = process.env['XDG_RUNTIME_DIR'] ?? join(homedir(), '.cache');
  return join(base, 'yoke');
}

export function endpointPathFor(id: string): string {
  if (!isEndpointId(id)) {
    throw new Error(`${JSON.stringify(id)} is not a usable endpoint id`);
  }
  if (process.platform === 'win32') {
    // The legacy id maps to the bare pre-existing name, not to a suffixed one,
    // so an extension that has not been reloaded lands where it always did.
    return `\\\\.\\pipe\\${id === LEGACY_ID ? legacyPipe() : `${pipePrefix()}${id}`}`;
  }
  return join(endpointDir(), `${id}.sock`);
}

/** The id a path was made from, or undefined for a file that is not one of ours. */
export function endpointIdOf(path: string): string | undefined {
  const name = path.split(/[\\/]/).pop() ?? '';
  if (process.platform === 'win32' && name === legacyPipe()) { return LEGACY_ID; }
  const match = process.platform === 'win32'
    ? (name.startsWith(pipePrefix()) ? name.slice(pipePrefix().length) : undefined)
    : (name.endsWith('.sock') ? name.slice(0, -'.sock'.length) : undefined);
  return isEndpointId(match) ? match : undefined;
}

/**
 * Every endpoint currently on disk, live or not.
 *
 * Existence is not liveness: a host Chrome killed leaves its socket behind, so a
 * caller has to connect to find out. Windows can enumerate its pipe namespace
 * through readdir, and a pipe there does vanish with its process, but that path
 * is untested.
 */
export function listEndpoints(): string[] {
  if (process.platform === 'win32') {
    try {
      return readdirSync('\\\\.\\pipe\\')
        .filter((name) => name === legacyPipe() || name.startsWith(pipePrefix()))
        .map((name) => `\\\\.\\pipe\\${name}`)
        .filter((path) => endpointIdOf(path) !== undefined);
    } catch {
      return [];
    }
  }
  const dir = endpointDir();
  if (!existsSync(dir)) { return []; }
  return readdirSync(dir)
    .filter((name) => endpointIdOf(name) !== undefined)
    .sort()
    .map((name) => join(dir, name));
}
