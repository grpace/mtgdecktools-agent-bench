/**
 * JSON data export for client apps (the mtgdecktools.com/agent-bench pages). Schema: docs/SITE-DATA.md.
 *
 *   npm run site:data                  # reads runs/ and sets/ at the repo root, writes packages/site/dist-data/
 *   npm run site:data -- --runs <dir> --sets <dir> --cards <card-data.slim.json> --out <dir>
 *
 * Output (all lazy-loadable):
 *   index.json                         leaderboard, events, sets, totals
 *   events/<id>.json                   one event: config, standings, matches, games, decks, drafts, usage
 *   events/<id>/draft-<seat>.json      every pick with pack contents and 17Lands numbers
 *   events/<id>/game-<n>.json          replay timeline
 *   sets/<SET>.json                    agent picks, archetypes and deck shape; 17Lands as a human reference
 *   models/<model_id>.json             model page: ratings by version, outcomes, head to head, diagnostics, highlights
 *   highlights.json                    curated highlights, resolved to their decision or pick
 *   methodology.md                     docs/METHODOLOGY.md, the definitions behind every number
 *
 * --bootstrap <n> sets the bootstrap replicates for rating, outcome and diagnostic intervals (default 1000; 0 = no intervals).
 *
 * The directory is written next to the target and swapped in at the end, so a server never serves a half-written export.
 *
 * Public text: every value goes through the scrubber every public output uses (packages/director/src/public-text.ts),
 * and the Hub's moderation list applies when MTGDT_MODERATION_FILE names one (a hosted Director sets it: taken-down
 * events left out, hidden rules reports replaced, hidden handles dropped, erased contributors anonymized).
 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadContext, repoRoot } from './context.js';
import { builder, readMethodology, serialize, writeAll } from './export.js';
import { readModerationFile, scrubPublic } from '../../director/src/public-text.js';
import { moderateEvents } from './moderation.js';

const t0 = Date.now();
const { ctx, out } = loadContext('dist-data');
const kept = moderateEvents(ctx.events, readModerationFile(process.env.MTGDT_MODERATION_FILE));
ctx.events.splice(0, ctx.events.length, ...kept);
// The methodology travels with the numbers it explains (single source: docs/METHODOLOGY.md).
const methodology = readMethodology(join(repoRoot, 'docs', 'METHODOLOGY.md'));
const b = builder(ctx, methodology);
const tmp = `${out}.tmp-${process.pid}`;
rmSync(tmp, { recursive: true, force: true });

let files = 0;
let bytes = 0;
function write(path: string, data: unknown): void {
  const full = join(tmp, path);
  mkdirSync(dirname(full), { recursive: true });
  const s = serialize(typeof data === 'string' ? data : scrubPublic(data));
  writeFileSync(full, s);
  files++;
  bytes += s.length;
}

writeAll(ctx, b, methodology, write);

const old = `${out}.old-${process.pid}`;
if (existsSync(out)) renameSync(out, old);
renameSync(tmp, out);
rmSync(old, { recursive: true, force: true });

const live = ctx.events.filter((e) => e.status === 'in-progress').length;
console.log(
  `site:data: ${files} files, ${(bytes / 1024).toFixed(0)} KiB from ${ctx.events.length} event(s)${live ? ` (${live} in progress)` : ''} in ${((Date.now() - t0) / 1000).toFixed(1)} s → ${out}`,
);
