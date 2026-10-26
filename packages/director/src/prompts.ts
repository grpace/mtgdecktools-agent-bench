/**
 * The prompt folders. `prompts/` holds the current prompts: what seats read (join.md, fundamentals.md,
 * deckbuilding-guide.md) and the setup prompt people paste into a coding agent (setup.md). `prompts/archive/v9`
 * is that same set, so the logged name stays "v9" until the files change.
 *
 * Logs name the set an event ran with in `event_start.prompt_version` and identify it exactly by
 * `prompt_sha256`. The name is the archive folder ("v9"), or "current" for current prompts that no
 * archive matches (prompts refined in place since the last archived set). A released name still resolves:
 * "v9", "prompts/v9" and "prompts/archive/v9" are the same folder (resolvePromptsDir).
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

export const REPO_ROOT = resolve(import.meta.dirname, '../../..');
/** The current prompts. */
export const PROMPTS_DIR = join(REPO_ROOT, 'prompts');
/** The released copy of the current prompts (v9). */
export const PROMPTS_ARCHIVE = join(PROMPTS_DIR, 'archive');
/** prompt_version of current prompts that match no archived set. */
export const CURRENT_PROMPTS = 'current';

/** Not something a seat reads: the setup prompt is for the person's coding agent. Left out of the hash. */
const NOT_FOR_SEATS = new Set(['setup.md']);

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

/**
 * A prompts folder from what a command line, a log or a doc names: a path that exists; "current" or "prompts" (the
 * current prompts); or the released folder name ("v9", "prompts/v9", "prompts/archive/v9") → prompts/archive/v9. Anything
 * else comes back resolved as given (and fails where it is read).
 */
export function resolvePromptsDir(name: string, root = PROMPTS_DIR): string {
  const raw = name.trim().replace(/\/+$/, '');
  if (raw === CURRENT_PROMPTS || raw === 'prompts' || raw === '') return root;
  if (isDir(raw)) return resolve(raw);
  const v = /(?:^|\/)(v\d+)$/.exec(raw)?.[1];
  if (v && isDir(join(root, 'archive', v))) return join(root, 'archive', v);
  return resolve(raw);
}

/**
 * A content hash of the prompts seats read in a folder (every .md file but setup.md, by name), logged in event_start
 * as prompt_sha256. It identifies exactly what agents read without anyone bumping a version by hand, and is the same
 * for a set whether it sits in prompts/ or prompts/archive/vN.
 */
export function promptsHash(promptsDir: string): string | undefined {
  if (!isDir(promptsDir)) return undefined;
  const h = createHash('sha256');
  for (const f of readdirSync(promptsDir).filter((x) => x.endsWith('.md') && !NOT_FOR_SEATS.has(x)).sort()) {
    h.update(`${f}\0`).update(readFileSync(join(promptsDir, f))).update('\0');
  }
  return h.digest('hex');
}

/**
 * The name logged as prompt_version: an archive folder's own name ("v9"); for the current prompts, the archived set
 * with the same content (today "v9"), else "current". Other folders (experiments): their folder name.
 */
export function promptVersionOf(promptsDir: string, root = PROMPTS_DIR): string {
  const dir = resolve(promptsDir);
  if (dir !== resolve(root)) return basename(dir);
  // A few small files: hashed afresh each time, so prompts refined in place while a Director runs are named right.
  const sha = promptsHash(dir);
  const archive = join(root, 'archive');
  const newestFirst = isDir(archive) ? readdirSync(archive).filter((v) => /^v\d+$/.test(v)).sort((a, b) => Number(b.slice(1)) - Number(a.slice(1))) : [];
  return newestFirst.find((v) => promptsHash(join(archive, v)) === sha) ?? CURRENT_PROMPTS;
}
