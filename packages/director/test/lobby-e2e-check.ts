/**
 * Checks for the lobby end-to-end test (lobby-e2e.sh): the handed-off bundle of the lobby table passes the Hub's
 * integrity checks (draft, decks, games, Swiss pairings, pack regeneration, 8 agent seats), carries per-seat
 * provenance, and the lobby's public API reports the table and the contributions.
 * With launch "play", the seats' context policies too: 3 fresh-per-game, 2 fresh-per-match, 3 none (lobby-e2e.sh),
 * each rotated seat with later sessions logged (seat_session), and no policy in the lobby's public API.
 *   npx tsx packages/director/test/lobby-e2e-check.ts <bundle.tar.gz> <director-url> [play|direct]
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { unpackTarGz } from '../src/submissions.js';
import { PAIRING_VERSION } from '../src/pairings.js';
import { checkBundle } from '../../hub/src/checks.js';

const [bundlePath, director, launch] = process.argv.slice(2) as [string, string, string | undefined];
const root = resolve(import.meta.dirname, '../../..');
const files = unpackTarGz(readFileSync(bundlePath));
const digest = JSON.parse(readFileSync(join(root, 'engine/phase.lock.json'), 'utf8')).digest as string;
const boosters = { defaultDraftPools: join(root, 'data/draft-pools.json'), defaultUnsupported: join(root, 'data/unsupported-cards.json') };
const report = checkBundle(files, { allowedEngineDigests: [digest], boosters, minLatencyMs: 300, fastShare: 0.1 });
assert.equal(report.structural, true, `structural errors: ${report.errors.join('; ')}`);
const failed = report.checks.filter((c) => (c.class === 'integrity' || c.class === 'eligibility') && c.outcome !== 'pass');
for (const c of report.checks) console.log(`  ${c.outcome.padEnd(12)} ${c.id}: ${c.message}`);
assert.deepEqual(failed.map((c) => `${c.id}: ${c.message}`), [], 'every integrity and eligibility check passes');
assert.ok(existsSync(boosters.defaultDraftPools) ? ['verified', 'partial'].includes(report.regen!.status) : true, `pack regeneration: ${report.regen?.message}`);

const events = files.get('events.jsonl')!.toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const start = events[0];
assert.equal(start.type, 'event_start');
assert.equal(start.seats.length, 8);
assert.ok(start.seats.every((s: any) => s.kind === 'agent'), 'no bot seats');
assert.equal(start.table?.kind, 'lobby');
// One queue for every best-of-3 table: the new key, whichever form (an old -bo3 invite link) the seats joined with.
assert.equal(start.table?.queue, 'fra-none-manual');
assert.equal(start.best_of, 3);
assert.match(String(start.table?.table_id), /^t-[0-9a-f]{8}$/);
assert.deepEqual(start.pairing, { format: 'swiss', rounds: 3, version: PAIRING_VERSION });
assert.equal(start.seat_meta, 'self-reported');
const contributors = new Set(start.seats.map((s: any) => s.contributor_id));
assert.ok(contributors.size >= 3, `seats from ${contributors.size} contributors`);
assert.ok(start.seats.every((s: any) => s.contributor_id && s.harness === 'script'), 'per-seat provenance (contributor, harness)');
const perContributor = [...contributors].map((c) => start.seats.filter((s: any) => s.contributor_id === c).length);
assert.ok(perContributor.every((n) => n <= 3), `at most 3 seats per contributor (${perContributor})`);
assert.ok(!start.seats.some((s: any) => 'entry_id' in s), 'lobby entry ids stay private');
assert.equal(events.filter((e) => e.type === 'round_start').length, 3);
// Context policies, recorded per seat exactly as at a Private Table (only when the CLIs started the seats).
const policies = start.seats.map((s: any) => s.context_policy ?? 'harness').sort();
let rotatedSessions = 0;
if (launch === 'play') {
  assert.deepEqual(policies, ['fresh-per-game', 'fresh-per-game', 'fresh-per-game', 'fresh-per-match', 'fresh-per-match', 'harness', 'harness', 'harness'], 'event_start records each seat\'s context policy');
  for (const s of start.seats.filter((x: any) => x.context_policy)) {
    const later = events.filter((e) => e.type === 'seat_session' && e.seat === s.name);
    // After the deck lock at least; a per-game seat after its games too.
    assert.ok(later.length >= (s.context_policy === 'fresh-per-game' ? 2 : 1), `${s.name} (${s.context_policy}): ${later.length} later sessions`);
    rotatedSessions += later.length;
  }
} else assert.ok(policies.every((p: string) => p === 'harness'), 'seats started by hand record no context policy');
assert.ok(events.some((e) => e.type === 'event_end'));

const lobbyText = await (await fetch(`${director}/api/lobby`)).text();
assert.ok(!/context_policy|fresh-per/.test(lobbyText), 'the public lobby shows no context policies');
const lobby = JSON.parse(lobbyText) as any;
const recent = lobby.recent.find((t: any) => t.event_id === start.id);
assert.ok(recent, 'the table is in recent tables');
assert.equal(recent.stage, 'done');
assert.equal(recent.contributors, contributors.size);
assert.match(recent.watch_url, new RegExp(`/agent-bench/events/${start.id}/live$`));
const stats = await (await fetch(`${director}/api/lobby/stats`)).json() as any;
// Scripted seats (allowed here by LOBBY_ALLOW_SCRIPT=1) count for nothing: no contributor seats, tables or
// reliability (LOB-4), and no model.
for (const h of ['alice', 'bob', 'carol']) assert.ok(!stats.contributors.some((c: any) => c.handle === h), `${h}: scripted seats are not contribution`);
assert.ok(stats.totals.tables >= 1, 'the fired table is counted');
assert.ok(!JSON.stringify(stats).includes('"random"'), 'scripted seats are not a model');
console.log(`LOBBY E2E OK: ${start.id} (${contributors.size} contributors, ${events.filter((e) => e.type === 'game_over').length} games, ${rotatedSessions} rotated sessions, pairings ${report.checks.find((c) => c.id === 'games.pairings')?.outcome}, regen ${report.regen?.status})`);
