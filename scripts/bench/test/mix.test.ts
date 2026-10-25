/**
 * Make Your Table Count (mix.ts) and Most Needed (needed.ts): rated games per table from the real Swiss pairing,
 * the plain warning for mirror tables, mixes built from what this machine can run, the Hub's bounties matched
 * against it, and setup's agent mode carrying all of it (a stub Director and Hub; nothing is created).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { capabilities, detectApps, ratedTable, tableAdvice, type Capability } from '../mix.js';
import { ratedMatchesFor } from '../../../packages/director/src/lobby.js';
import { loadBounties, neededForYou, neededHeadline, type Bounty } from '../needed.js';
import { expandSeatSpecs } from '../harnesses.js';
import { resolveSeat } from '../models.js';

const scratch = mkdtempSync(join(tmpdir(), 'mtgdt-mix-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

// A fake `claude` on the spawned CLI's PATH: setup fetches the Hub's bounties ("Most Needed … from what you can run")
// only when the machine can seat a harness (mix.ts capabilities → installedVersion runs `claude --version`), and a
// GitHub runner has no harness CLIs — the same flow was passing on a developer's machine and failing there.
mkdirSync(join(scratch, 'bin'), { recursive: true });
writeFileSync(join(scratch, 'bin', 'claude'), `#!/bin/sh\nprintf '2.1.306 (Claude Code)\\n'\n`, { mode: 0o755 });
const fakeCliPath = () => `${join(scratch, 'bin')}:${process.env.PATH ?? ''}`;

const seats = (...lines: string[]) => expandSeatSpecs(lines).map((s) => {
  const r = resolveSeat(s, { allowUnlisted: false });
  assert.ok(r.ok, JSON.stringify(r));
  return r.seat;
});
const ids = (n: number, id: string) => Array<string>(n).fill(id);

test('rated games follow the mix (the real Swiss pairing, version 3): a mirror table rates nothing, 4 + 4 rates most matches', () => {
  const mirror = ratedTable(ids(8, 'claude-haiku-5-5/low'));
  assert.equal(mirror.matches, 12);
  assert.equal(mirror.rated_matches, 0);
  assert.equal(mirror.level, 'none');
  const ladder = ratedTable([...ids(4, 'claude-haiku-5-5/low'), ...ids(4, 'claude-haiku-5-5/high')]);
  // Round 1 pairs every low seat with a high one; round 2 floats a seat to the next record group rather than pair a
  // mirror; the last round is strictly by points, so a record group holding more of one setup pairs a mirror there.
  assert.equal(ladder.rated_matches, 10, 'a median 10 of 12 matches pair different setups');
  assert.equal(ladder.level, 'most');
  assert.equal(ladder.games, 29);
  assert.equal(ladder.rated_games, 24);
  const sevenOne = ratedTable([...ids(7, 'a/x/low'), 'a/x/high']);
  assert.equal(sevenOne.rated_matches, 3, 'one different seat: one rated match a round');
  assert.equal(sevenOne.level, 'few');
  assert.equal(ratedTable([...ids(6, 'a/x/low'), ...ids(2, 'a/x/high')]).rated_matches, 6);
  assert.equal(ratedTable([...ids(5, 'a/x/low'), ...ids(3, 'a/x/high')]).rated_matches, 9);
  assert.equal(ratedTable([...ids(5, 'a/x/low'), ...ids(3, 'a/x/high')]).level, 'most');
  const four = ratedTable([...ids(2, 'a/x/low'), ...ids(2, 'a/x/high'), ...ids(2, 'b/x/low'), ...ids(2, 'b/x/high')]);
  assert.equal(four.rated_matches, 12, 'four setups: most pods rate every match');
  assert.ok(four.rated_matches_min < 12, 'but not every pod');
  assert.equal(four.level, 'most');
  assert.equal(ratedTable(['a/x/low', 'a/y/low', 'b/x/low', 'b/y/low', 'c/x/low', 'c/y/low', 'd/x/low', 'd/y/low']).rated_matches, 12);
  // The lobby's needs reads the same estimate (packages/director/src/rated-estimate.ts).
  assert.equal(ladder.rated_matches, ratedMatchesFor([4, 4], 8).rated);
  assert.equal(ladder.rated_games, Math.round(ratedMatchesFor([4, 4], 8).rated * 2.4));
  // Scripted seats are never rated.
  assert.equal(ratedTable([...ids(4, 'a/x/low'), null, null, null, null]).rated_matches <= 4, true);
});

const claudeHere: Capability[] = capabilities(new Map([['claude-code', '2.1.306']]));

test('a mirror table gets the plain warning and mixes from what this machine can run, never a refusal', () => {
  const a = tableAdvice(seats('8x Claude Code / Claude Haiku 5.5 / low'), { caps: claudeHere, table: 'private' })!;
  assert.equal(a.warning, 'All 8 seats are the same setup, so no games will be rated (they still add format data).');
  assert.equal(a.line, 'Rated games this table can produce: 0 (of up to 29)');
  assert.deepEqual(a.suggestions.map((s) => s.kind), ['effort-ladder', 'model-mix', 'lobby'], 'one provider here: no provider mix');
  const ladder = a.suggestions[0]!;
  assert.deepEqual(ladder.seats, ['4x Claude Code / Claude Haiku 5.5 / low', '4x Claude Code / Claude Haiku 5.5 / high']);
  assert.equal(ladder.rated_games, 24);
  const mixLines = a.suggestions[1]!.seats;
  assert.equal(mixLines.length, 3);
  assert.match(mixLines[0]!, /^3x Claude Code \/ Claude Haiku 5\.5 \/ low$/, 'the chosen model and effort first');
  assert.ok(mixLines.every((l) => / \/ low$/.test(l)), 'the same effort across the models');
  assert.ok(!mixLines.some((l) => /Fable/.test(l)), 'the cheapest other models of the provider');
  // Every suggested line is a valid seats answer.
  for (const s of a.suggestions) if (s.seats.length) assert.equal(seats(...s.seats).length, 8);
});

test('a harness alone is not a different setup: one model and level on two harnesses is a mirror; a Provider Mix crosses providers', () => {
  // Claude Code here and Cursor via T3 Code: Claude Sonnet 5.5 at high on both is one setup.
  const withT3Cursor: Capability[] = capabilities(new Map([['claude-code', '2.1.306']]), [{ app: 't3-code', label: 'T3 Code', harnesses: ['t3-code:claude-code', 't3-code:cursor'] }]);
  const same = tableAdvice(seats('4x Claude Code / Claude Sonnet 5.5 / high', '4x t3-code:cursor / Claude Sonnet 5.5 / high'), { caps: withT3Cursor, table: 'private' })!;
  assert.equal(same.rated_games, 0);
  assert.match(same.warning!, /same setup/);
  // The suggestion across tools is another provider's model, here through Cursor started from T3 Code.
  const a = tableAdvice(seats('8x Claude Code / Claude Sonnet 5.5 / high'), { caps: withT3Cursor, table: 'private' })!;
  assert.ok(!a.suggestions.some((s) => (s.kind as string) === 'harness-mix'));
  const p = a.suggestions.find((s) => s.kind === 'provider-mix')!;
  assert.ok(p, 'a provider mix');
  assert.equal(p.by_hand, true);
  assert.match(p.seats[0]!, /^4x Claude Code \/ Claude Sonnet 5\.5 \/ high$/);
  assert.match(p.seats[1]!, /^4x Cursor CLI via T3 Code \/ /);
  assert.ok(p.rated_games > 0);
  // Only Anthropic models here: no provider mix.
  assert.ok(!tableAdvice(seats('8x Claude Code / Claude Sonnet 5.5 / high'), { caps: claudeHere, table: 'private' })!.suggestions.some((s) => s.kind === 'provider-mix'));
  const loop = tableAdvice(seats('8x Claude Code / Claude Sonnet 5.5 / high'), { caps: withT3Cursor, table: 'private', continuous: true })!;
  assert.ok(!loop.suggestions.some((s) => s.kind === 'provider-mix'), 'Keep Playing starts every seat here');
});

test('a mixed table needs no advice; a scripted test table gets none; the lobby says it depends on who joins', () => {
  const ok = tableAdvice(seats('4x Claude Code / Claude Haiku 5.5 / low', '4x Claude Code / Claude Haiku 5.5 / high'), { caps: claudeHere, table: 'private' })!;
  assert.equal(ok.warning, null);
  assert.equal(ok.suggestions.length, 0);
  assert.equal(ok.line, 'Rated games this table can produce: 24 (of up to 29)');
  assert.equal(tableAdvice(seats('8x script/random'), { caps: claudeHere, table: 'private' }), null);
  const lobby = tableAdvice(seats('3x Claude Code / Claude Haiku 5.5 / low'), { caps: claudeHere, table: 'lobby' })!;
  assert.equal(lobby.warning, null);
  assert.match(lobby.line, /decided by who joins/);
  // Few: 6 + 2 rates half the matches.
  const few = tableAdvice(seats('6x Claude Code / Claude Haiku 5.5 / low', '2x Claude Code / Claude Opus 5.5 / high'), { caps: claudeHere, table: 'private' })!;
  assert.match(few.warning!, /^6 of the 8 seats are the same setup \(Claude Haiku 5\.5 · Low\), so only about 14 of this table's 29 games will be rated/);
});

test('seats whose effort is still to be asked share one level (setup asks it once per harness and model)', () => {
  const s = expandSeatSpecs(['8x Claude Code / Claude Haiku 5.5']).map((x) => resolveSeat(x, { allowUnlisted: false })).map((r) => (r.ok ? r.seat : assert.fail()));
  assert.equal(tableAdvice(s, { caps: claudeHere, table: 'private' })!.level, 'none');
});

test('apps: T3 Code is found by its data folder, and each engine is its own harness', () => {
  const home = join(scratch, 'home');
  mkdirSync(join(home, '.t3'), { recursive: true });
  const [t3] = detectApps(home);
  assert.equal(t3?.label, 'T3 Code');
  assert.ok(t3!.harnesses.includes('t3-code:claude-code'));
  assert.deepEqual(detectApps(join(scratch, 'nobody')), []);
});

test('apps: the Antigravity CLI is found by its state folder; its seats are Antigravity, seated by hand', () => {
  const home = join(scratch, 'home-agy');
  mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true });
  assert.deepEqual(detectApps(home), [{ app: 'antigravity', label: 'Antigravity CLI', harnesses: ['antigravity'] }]);
  const caps = capabilities(new Map(), detectApps(home));
  assert.ok(caps.some((c) => c.harness === 'antigravity' && c.starts === 'by-hand' && c.models.some((m) => m.id === 'gemini-4-argon')));
});

const BOUNTIES: Bounty[] = [
  { id: 'first-games:claude-opus-5-5', kind: 'first_games', label: 'First Games', bonus: 20, text: 'Claude Opus 5.5 has no rated games yet', model_id: 'claude-opus-5-5', model_display: 'Claude Opus 5.5' },
  { id: 'first-games:gemini-3.8-flash', kind: 'first_games', label: 'First Games', bonus: 20, text: 'Gemini 3.8 Flash has no rated games yet', model_id: 'gemini-3.8-flash', model_display: 'Gemini 3.8 Flash' },
  {
    id: 'provisional:kn=primer;mana=manual;prompt=abc:claude-code/claude-sonnet-5-5/high', kind: 'provisional', label: 'Needs Games', bonus: 10, text: '…',
    identity: 'claude-sonnet-5-5/high', identity_label: 'Claude Sonnet 5.5 · High', group: 'kn=primer;mana=manual;prompt=abc', progress: { games: 8, games_needed: 30 },
  },
  { id: 'provisional:kn=none;mana=manual;prompt=abc:claude-code/claude-haiku-5-5/low', kind: 'provisional', label: 'Needs Games', bonus: 10, text: '…', identity: 'claude-haiku-5-5/low', group: 'kn=none;mana=manual;prompt=abc' },
  { id: 'new-set:FRA', kind: 'new_set', label: 'New Set', bonus: 5, text: 'Reality Fracture has 0 rated tables so far', set: 'FRA' },
];

test('Most Needed: only what this person can run, First Games first, Needs Games in the table\'s conditions', () => {
  const gemini = capabilities(new Map([['gemini-cli', '0.30.0']]));
  const n = neededForYou(BOUNTIES, gemini);
  assert.deepEqual(n.map((x) => x.id), ['first-games:gemini-3.8-flash']);
  assert.equal(n[0]!.seat, 'Gemini CLI / Gemini 3.8 Flash', 'Gemini CLI has no effort setting');
  assert.equal(neededHeadline(n), 'Your Gemini access is the most needed right now: no Gemini 3.8 Flash games yet.');
  const claude = neededForYou(BOUNTIES, claudeHere);
  assert.deepEqual(claude.map((x) => x.kind), ['first_games', 'provisional']);
  assert.equal(claude[1]!.seat, 'Claude Code / Claude Sonnet 5.5 / high');
  assert.match(claude[1]!.text, /needs 22 more rated games/);
  assert.deepEqual(neededForYou(BOUNTIES, claudeHere, { knowledge: 'none' }).map((x) => x.id).slice(1), ['provisional:kn=none;mana=manual;prompt=abc:claude-code/claude-haiku-5-5/low']);
  assert.deepEqual(neededForYou(null, claudeHere), []);
  assert.deepEqual(neededForYou(BOUNTIES, []), []);
});

test('Most Needed is one cached call: fetched once an hour, a failure remembered for ten minutes', async () => {
  const cacheFile = join(scratch, 'needed.json');
  let calls = 0;
  const fetchJson = async () => (calls++, { api_version: 1, bounties: [...BOUNTIES, { kind: 'bogus', text: 'x' }, { id: 'admin:x', kind: 'admin', label: 'Launch\u0007 Week', bonus: 9999, text: 'a\nb', model_id: 'claude-haiku-5-5' }] });
  const t = Date.parse('2026-10-22T12:00:00Z');
  const a = await loadBounties('https://hub.test', { cacheFile, now: t, fetchJson });
  assert.equal(a!.length, BOUNTIES.length + 1, 'unknown kinds dropped');
  const admin = a!.find((b) => b.kind === 'admin')!;
  assert.equal(admin.bonus, 100, 'bonuses are capped');
  assert.doesNotMatch(admin.label + admin.text, /[\u0000-\u001f]/, 'control characters are removed');
  await loadBounties('https://hub.test', { cacheFile, now: t + 30 * 60_000, fetchJson });
  assert.equal(calls, 1, 'cached for an hour');
  await loadBounties('https://hub.test', { cacheFile, now: t + 61 * 60_000, fetchJson });
  assert.equal(calls, 2);
  const failing = async () => (calls++, undefined);
  assert.equal(await loadBounties('https://other.test', { cacheFile, now: t, fetchJson: failing }), null);
  assert.equal(await loadBounties('https://other.test', { cacheFile, now: t + 5 * 60_000, fetchJson: failing }), null);
  assert.equal(calls, 3, 'a failure is remembered for ten minutes');
});

// ---------------------------------------------------------------------------
// setup --agent with a stub Director and Hub

function stub(routes: Record<string, unknown>): Promise<{ url: string; server: Server; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    const body = routes[(req.url ?? '').split('?')[0]!];
    if (body === undefined) return res.writeHead(404).end('{}');
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server, hits })));
}

function bench(args: string[], env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const p = spawn(process.execPath, ['--import', 'tsx', resolve(import.meta.dirname, '../cli.ts'), ...args], {
      env: { ...process.env, XDG_CONFIG_HOME: join(scratch, 'xdg'), HOME: join(scratch, 'nobody'), BENCH_RUNS_DIR: join(scratch, 'runs'), BENCH_CMD: 'bench', BENCH_TOKEN: 'tok-test-0123456789abcdef', ...env },
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (status) => done({ status, stdout, stderr }));
  });
}

test('setup --agent: the seats question carries Most Needed, a mirror table carries table_check, the Confirmation the rated line', async () => {
  const director = await stub({ '/health': { ok: true }, '/api/sets': { sets: [{ code: 'FRA', name: 'Reality Fracture', releaseDate: '2026-10-01', set_context: true, human_stats: true }], featured: ['FRA'] }, '/api/capacity': { capacity: 30, load: 0, queued: 0, draining: false }, '/api/lobby': { queues: [] } });
  const hub = await stub({ '/api/bounties': { api_version: 1, bounties: BOUNTIES } });
  after(() => { director.server.close(); hub.server.close(); });
  const env = { BENCH_DIRECTOR: director.url, BENCH_HUB: hub.url };
  const base = { table: 'private', play_mode: 'once', where: 'hosted', set: 'fra' };
  const q = await bench(['setup', '--agent', '--no-launch', '--skip-preflight', '--answers', JSON.stringify(base)], { ...env, PATH: fakeCliPath() });
  assert.equal(q.status, 0, q.stderr);
  const qs = JSON.parse(q.stdout);
  const seatsQ = qs.questions.find((x: { id: string }) => x.id === 'seats');
  assert.match(seatsQ.help, /Only games between different setups/);
  assert.equal(hub.hits.filter((h) => h === '/api/bounties').length, 1);

  const mirror = await bench(['setup', '--agent', '--no-launch', '--skip-preflight', '--answers', JSON.stringify({ ...base, seats: ['8x Claude Code / Claude Haiku 5.5'] })], env);
  const m = JSON.parse(mirror.stdout);
  assert.equal(m.step, 'questions');
  assert.equal(m.table_check.warning, 'All 8 seats are the same setup, so no games will be rated (they still add format data).');
  assert.ok(m.table_check.suggestions.some((s: { kind: string }) => s.kind === 'effort-ladder'));
  assert.match(m.instructions, /table_check\.warning/);

  const conf = await bench(['setup', '--agent', '--no-launch', '--skip-preflight', '--answers', JSON.stringify({ ...base, seats: ['8x Claude Code / Claude Haiku 5.5 / low'], knowledge: 'primer' })], env);
  const c = JSON.parse(conf.stdout);
  assert.equal(c.step, 'confirm', conf.stdout + conf.stderr);
  assert.equal(c.confirmation.ready, true, 'a mirror table is never refused');
  assert.equal(c.confirmation.rated.rated_games, 0);
  assert.match(c.confirmation.text, /\n {2}Rated games this table can produce: 0 \(of up to 29\)\n/);
  assert.match(c.confirmation.text, /All 8 seats are the same setup, so no games will be rated \(they still add format data\)\./);
  assert.match(c.instructions, /confirmation\.suggestions/);

  const mixed = await bench(['setup', '--agent', '--no-launch', '--skip-preflight', '--answers', JSON.stringify({ ...base, seats: ['4x Claude Code / Claude Haiku 5.5 / low', '4x Claude Code / Claude Haiku 5.5 / high'], knowledge: 'primer' })], env);
  const x = JSON.parse(mixed.stdout);
  assert.equal(x.confirmation.table_warning, null);
  assert.match(x.confirmation.text, /this table can produce: 24 \(of up to 29\)/);
});

test('setup --dry-run: an agent dry run never offers a `next` that creates the event; flags take the documented defaults', async () => {
  const director = await stub({ '/health': { ok: true }, '/api/sets': { sets: [{ code: 'FRA', name: 'Reality Fracture', releaseDate: '2026-10-01', set_context: true, human_stats: true }], featured: ['FRA'] }, '/api/capacity': { capacity: 30, load: 0, queued: 0, draining: false }, '/api/lobby': { queues: [] } });
  const hub = await stub({ '/api/bounties': { api_version: 1, bounties: [] } });
  after(() => { director.server.close(); hub.server.close(); });
  const env = { BENCH_DIRECTOR: director.url, BENCH_HUB: hub.url };
  const answers = { table: 'private', play_mode: 'once', where: 'hosted', set: 'fra', seats: ['4x Claude Code / Claude Haiku 5.5 / low', '4x Claude Code / Claude Haiku 5.5 / high'] };

  // Questions carry --dry-run in `next`, so the agent's later steps stay dry.
  const q = JSON.parse((await bench(['setup', '--agent', '--dry-run', '--no-launch', '--skip-preflight', '--answers', JSON.stringify(answers)], env)).stdout);
  assert.equal(q.step, 'questions');
  assert.match(q.next, / --dry-run /);

  // The confirmation of a dry run: no `next`, and it says nothing will be created.
  const c = JSON.parse((await bench(['setup', '--agent', '--dry-run', '--no-launch', '--skip-preflight', '--answers', JSON.stringify({ ...answers, knowledge: 'primer' })], env)).stdout);
  assert.equal(c.step, 'confirm');
  assert.equal(c.dry_run, true);
  assert.equal(c.next, undefined);
  assert.match(c.instructions, /dry run: nothing will be created/);

  // --confirm with --dry-run is refused before anything is created.
  const refused = await bench(['setup', '--agent', '--dry-run', '--no-launch', '--skip-preflight', '--answers', JSON.stringify({ ...answers, knowledge: 'primer' }), '--confirm', c.confirmation.code], env);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr + refused.stdout, /a dry run creates nothing/);
  assert.ok(!director.hits.some((h) => h.startsWith('/api/events')), 'no event created');

  // A lobby's seats question gives an example that fits the 1–4 seat limit.
  const lobby = JSON.parse((await bench(['setup', '--agent', '--dry-run', '--no-launch', '--skip-preflight', '--answers', JSON.stringify({ table: 'lobby', play_mode: 'once', set: 'fra' })], env)).stdout);
  const seatsQ = lobby.questions.find((x: { id: string }) => x.id === 'seats');
  assert.match(seatsQ.ask, /1 to 4/);
  assert.doesNotMatch(seatsQ.format, /4x/);

  // Flags without --hosted or --knowledge: hosted and Set Context, said out loud, then the confirmation.
  const flags = await bench(['setup', '--private', '--set', 'fra', '--seat', '4x Claude Code/Claude Haiku 5.5/low', '--seat', '4x Claude Code/Claude Haiku 5.5/high', '--dry-run', '--no-launch', '--skip-preflight'], env);
  assert.equal(flags.status, 0, flags.stderr);
  assert.match(flags.stdout, /Where should the table run\? Hosted \(the default/);
  assert.match(flags.stdout, /What may the agents know\? The same for every seat\. Set Context \(the default/);
  assert.match(flags.stdout, /Nothing created\./);

  // Missing seats: the error says how to give them, without listing every model.
  const noSeats = await bench(['setup', '--private', '--set', 'fra', '--dry-run', '--no-launch', '--skip-preflight'], env);
  assert.notEqual(noSeats.status, 0);
  assert.match(noSeats.stderr, /--seat "4x Claude Code \/ Claude Opus 5\.5 \/ high"/);
  assert.doesNotMatch(noSeats.stderr, /Options:/);
});
