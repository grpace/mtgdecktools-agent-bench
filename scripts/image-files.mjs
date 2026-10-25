#!/usr/bin/env node
// The repository files the Director/Hub image reads at run time, derived from the code (CI-1), one path per line.
// Walks the module graph from the image's entry points (relative imports, JSON imports included) and collects the
// repository paths those modules build from string literals: join/resolve(repoRoot | root, '…'), resolve/join(
// import.meta.dirname, '…') and new URL('…', import.meta.url). Paths git doesn't track (data/, runs/, tmp/: volumes
// or local state) are left out. CI runs `test -e` on every line inside the built image, so a path the .dockerignore
// allow-list drops fails the build instead of the deploy.
//   node scripts/image-files.mjs            the list
//   node scripts/image-files.mjs --explain  with the module that reads each path
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
// What the image runs: the Director (CMD), the card-data stage and the Hub (compose `command`), the Hub admin CLI (`docker exec … npm run hub`)
// and the report export the Director spawns (packages/director/src/server.ts exportData).
const ENTRY = ['packages/director/src/main.ts', 'packages/director/src/stage-card-data.ts', 'packages/hub/src/main.ts', 'packages/hub/src/cli.ts', 'packages/site/src/build-data.ts'];
// Read at run time today; if the scan stops finding one of these, the scan is broken, not the image.
const EXPECTED = ['engine/phase.lock.json', 'deps/manifest.json', 'docs/METHODOLOGY.md', 'highlights/curated.json', 'packages/hub/bounties.json', 'packages/hub/migrations', 'sets', 'registry/prices.json'];

const tracked = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'utf8' }).split('\0').filter(Boolean));
const isTracked = (p) => tracked.has(p) || [...tracked].some((t) => t.startsWith(p + '/'));

const lits = (s) => [...s.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]);
/** Arguments after the base when they are all string literals: `, 'a', 'b/c'` → ['a', 'b/c']; undefined otherwise. */
const literalArgs = (rest) => (/^(\s*,\s*('[^']*'|"[^"]*"))*\s*$/.test(rest) ? lits(rest) : undefined);

const found = new Map(); // repo-relative path → module that reads it
const seen = new Set();
const queue = ENTRY.map((e) => join(repo, e));
const add = (abs, from) => {
  const rel = relative(repo, abs);
  if (rel.startsWith('..') || rel === '') return;
  if (!found.has(rel)) found.set(rel, relative(repo, from));
};

while (queue.length) {
  const file = queue.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  add(file, file);
  const src = readFileSync(file, 'utf8');
  const dir = dirname(file);
  // Static and dynamic relative imports (`./x.js` is the source file `./x.ts`).
  for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.\.?\/[^'"]+)['"]/g)) {
    let target = resolve(dir, m[1]);
    if (target.endsWith('.js') && existsSync(target.slice(0, -3) + '.ts')) target = target.slice(0, -3) + '.ts';
    if (target.endsWith('.ts')) queue.push(target);
    else add(target, file);
  }
  // Names bound to the repository root in this module: `const root = resolve(import.meta.dirname, '../../..')`, or an
  // imported `repoRoot` (packages/hub/src/config.ts, packages/site/src/context.ts).
  const roots = new Map([['repoRoot', repo]]);
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*(?:resolve|join)\(\s*import\.meta\.dirname((?:\s*,\s*(?:'[^']*'|"[^"]*"))*)\s*\)/g)) {
    roots.set(m[1], resolve(dir, ...lits(m[2])));
  }
  for (const m of src.matchAll(/\b(?:resolve|join)\(\s*([\w.]+)((?:\s*,\s*(?:'[^']*'|"[^"]*"))+)\s*\)/g)) {
    const base = m[1] === 'import.meta.dirname' ? dir : roots.get(m[1]);
    const args = literalArgs(m[2]);
    if (base && args) add(resolve(base, ...args), file);
  }
  for (const m of src.matchAll(/new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g)) add(resolve(dir, m[1]), file);
}

const out = [...found].filter(([p]) => isTracked(p)).sort(([a], [b]) => a.localeCompare(b));
const missing = EXPECTED.filter((p) => !found.has(p));
if (missing.length) {
  console.error(`image-files: the scan no longer finds ${missing.join(', ')}; fix the scan (or EXPECTED if the code stopped reading them)`);
  process.exit(1);
}
const explain = process.argv.includes('--explain');
for (const [p, from] of out) console.log(explain && from !== p ? `${p}\t(${from})` : p);
