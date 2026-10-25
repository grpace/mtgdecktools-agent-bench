/**
 * Seat identity at export time (METHODOLOGY §2, registry/README.md): canonical keys from the raw strings in the
 * logs, retroactive merging when the registry learns a name, model verification from harness usage, and
 * Mismatch / Unlisted seats kept off the boards.
 *   npx tsx packages/site/src/identity.test.ts
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry, REGISTRY_DATA, type RegistryData } from '../../registry/src/index.js';
import { CardDb, loadEvent, seatModel, type EventData } from './data.js';
import { leaderboard } from './metrics.js';
import { buildBoards, contributorOf, eventRatingStatus, FORFEIT_POLICY, groupKey, Identities, ratingGamesOf, VERIFICATION_LABELS } from './scoring.js';
import { swissFinishes } from './outcomes.js';
import { currentPromptKeys, makeContext } from './context.js';
import { builder, serialize, withDeprecatedKeys } from './export.js';
import { SUMMARY_FINISHES } from './json.js';
import { PROMPTS_ARCHIVE, PROMPTS_DIR, promptsHash, promptVersionOf } from '../../director/src/prompts.js';

const T0 = Date.parse('2026-10-22T12:00:00Z');
const root = mkdtempSync(join(tmpdir(), 'mtgdt-identity-'));
let failed = 0;
const check = (name: string, f: () => void) => {
  try {
    f();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n     ${(err as Error).message}`);
  }
};

interface SeatSpec { name: string; harness?: string; model?: string; effort?: string; harness_declared?: string; model_declared?: string; effort_declared?: string; effort_basis?: string }

/** A finished two-agent event: one game, `a` wins. Optional usage-<seat>.json per seat. */
function event(id: string, seats: [SeatSpec, SeatSpec], usage: Record<string, unknown> = {}): EventData {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  const [a, b] = seats;
  const lines = [
    { t: T0, type: 'event_start', id, set: { code: 'FRA', name: 'Test' }, best_of: 3, sideboarding: true, mana: 'manual', prompt_version: 'v3', knowledge: { level: 'primer' }, seats: [
      { ...a, kind: 'agent', position: 0 }, { ...b, kind: 'agent', position: 1 },
    ] },
    { t: T0 + 1000, type: 'game_start', game: 'm1g1', seats: [a.name, b.name] },
    { t: T0 + 2000, type: 'game_over', game: 'm1g1', winner: a.name, turns: 9, on_play: a.name },
    { t: T0 + 3000, type: 'match_end', a: a.name, b: b.name, wins: { [a.name]: 1, [b.name]: 0 } },
    { t: T0 + 4000, type: 'event_end' },
  ];
  writeFileSync(join(dir, 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  for (const [seat, u] of Object.entries(usage)) writeFileSync(join(dir, `usage-${seat}.json`), JSON.stringify(u));
  const ev = loadEvent(dir, T0 + 10_000);
  assert.ok(ev, `${id} loads`);
  return ev!;
}

/**
 * A finished 8-agent-style event with explicit extras: event_start fields (prompt_sha256, organizer, …), seat fields
 * (contributor_id, …), games [winner, loser, forfeited_by?] and an optional source.json.
 */
function event2(id: string, o: {
  seats: Array<SeatSpec & { contributor_id?: string | number; contributor?: string }>;
  games: Array<[string, string, string?]>;
  start?: Record<string, unknown>;
  source?: Record<string, unknown>;
  forfeits?: Array<{ seat: string; stage: string }>;
  t?: number;
}): EventData {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  const t = o.t ?? T0;
  const lines: unknown[] = [{
    t, type: 'event_start', id, set: { code: 'FRA', name: 'Test' }, best_of: 3, sideboarding: true, mana: 'manual', prompt_version: 'v4', knowledge: { level: 'primer' }, seat_timeout_ms: 600000,
    seats: o.seats.map((x, i) => ({ ...x, kind: 'agent', position: i })), ...o.start,
  }];
  o.games.forEach(([w, l, ff], i) => {
    lines.push({ t: t + 1000 + i * 10, type: 'game_start', game: `m${i}g1`, seats: [w, l] });
    lines.push({ t: t + 1001 + i * 10, type: 'game_over', game: `m${i}g1`, winner: w, turns: 9, on_play: w, ...(ff ? { forfeited_by: ff } : {}) });
  });
  for (const f of o.forfeits ?? []) lines.push({ t: t + 5000, type: 'forfeit', seat: f.seat, stage: f.stage, reason: 'inactive', idle_ms: 600001 });
  lines.push({ t: t + 9000, type: 'event_end' });
  writeFileSync(join(dir, 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  if (o.source) writeFileSync(join(dir, 'source.json'), JSON.stringify(o.source));
  const ev = loadEvent(dir, t + 100_000);
  assert.ok(ev, `${id} loads`);
  return ev!;
}

const OPUS = { harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high' };
const SONNET = { harness: 'claude-code', model: 'claude-sonnet-5-5', effort: 'high' };
const HAIKU = { harness: 'claude-code', model: 'claude-haiku-5-5', effort: 'high' };

try {
  check('a seat\'s model comes from its metadata, never its name: no phantom "claude-haiku-5" from claude-haiku-5-5', () => {
    const ev = event2('ph-1', {
      seats: [{ name: 'claude-haiku-5-5', ...HAIKU }, { name: 'claude-haiku-5-5-2', ...HAIKU }, { name: 'seat-3fa2c9', ...OPUS }, { name: 'claude-sonnet-5-5-7', ...OPUS }],
      games: [['claude-haiku-5-5', 'claude-haiku-5-5-2'], ['seat-3fa2c9', 'claude-sonnet-5-5-7']],
    });
    assert.deepEqual(ev.seats.map((s) => s.model), ['claude-haiku-5-5', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-opus-5-5'], 'a name that looks like another model loses to the metadata');
    assert.deepEqual(leaderboard([ev], () => null, new CardDb(undefined)).map((r) => r.model).sort(), ['claude-haiku-5-5', 'claude-opus-5-5']);
    const ids = new Identities([ev]);
    assert.deepEqual([...new Set(ev.seats.map((s) => ids.of(ev, s.name).model))].sort(), ['claude-haiku-5-5', 'claude-opus-5-5']);
  });

  check('old logs without metadata: only a seat name the registry knows (whole, or without "-<n>") names the model', () => {
    const agent = (name: string) => seatModel({ name, kind: 'agent' }, T0);
    assert.equal(agent('claude-haiku-5-5'), 'claude-haiku-5-5', 'the whole name first: never cut to claude-haiku-5');
    assert.equal(agent('claude-haiku-5-5-2'), 'claude-haiku-5-5');
    assert.equal(agent('seat-3fa2c9'), 'unknown', 'neutral names carry no identity');
    assert.equal(agent('mystery-model-7'), 'unknown', 'a name the registry does not know is not a model');
    assert.equal(seatModel({ name: 'seat-3fa2c9', kind: 'agent', model: 'claude-opus-5-5', model_id: 'claude-opus-5-5-20261001' }), 'claude-opus-5-5-20261001', 'model_id first');
    assert.equal(seatModel({ name: 'bot-3', kind: 'bot' }), 'bot', 'bots keep a plain label');
  });

  /** A finished 8-agent, 3-round Swiss table: Swiss pairs by record, the higher seat wins; standings in summary.json. */
  const swissTable = (id: string, setups: SeatSpec[]): EventData => {
    const names = setups.map((_, i) => `seat-${(0xa0 + i).toString(16)}`);
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    const lines: unknown[] = [{
      t: T0, type: 'event_start', id, set: { code: 'FRA', name: 'Test' }, best_of: 3, sideboarding: true, mana: 'manual', prompt_version: 'v4', knowledge: { level: 'primer' },
      pairing: { format: 'swiss', rounds: 3 }, seats: names.map((name, i) => ({ name, ...setups[i], kind: 'agent', position: i })),
    }];
    const wins = new Map(names.map((n) => [n, 0]));
    let k = 0;
    for (let round = 0; round < 3; round++) {
      const order = [...names].sort((a, b) => wins.get(b)! - wins.get(a)! || names.indexOf(a) - names.indexOf(b));
      for (let i = 0; i < 8; i += 2) {
        const [w, l] = [order[i]!, order[i + 1]!];
        lines.push({ t: T0 + 1000 + k * 10, type: 'game_start', game: `${w} vs ${l} — game 1`, seats: [w, l] });
        lines.push({ t: T0 + 1001 + k++ * 10, type: 'game_over', game: `${w} vs ${l} — game 1`, winner: w, turns: 9, on_play: w });
        lines.push({ t: T0 + 1002 + k * 10, type: 'match_end', a: w, b: l, wins: { [w]: 1, [l]: 0 } });
        wins.set(w, wins.get(w)! + 1);
      }
    }
    lines.push({ t: T0 + 9000, type: 'event_end' });
    writeFileSync(join(dir, 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const standings = [...names].sort((a, b) => wins.get(b)! - wins.get(a)!).map((name) => ({ name, matchWins: wins.get(name)!, matchLosses: 3 - wins.get(name)!, gameWins: wins.get(name)!, gameLosses: 3 - wins.get(name)! }));
    writeFileSync(join(dir, 'summary.json'), JSON.stringify({ standings }));
    const ev = loadEvent(dir, T0 + 100_000);
    assert.ok(ev, `${id} loads`);
    return ev!;
  };
  const HAIKU_LOW = { ...HAIKU, effort: 'low' };

  check('a table of one setup: "No Rated Games" (identical setups), never "Rated"; its Swiss finishes are still exported', () => {
    const mirror = swissTable('mirror-1', Array(8).fill(HAIKU_LOW));
    const ids = new Identities([mirror]);
    assert.deepEqual(eventRatingStatus(mirror, ids), { status: 'no_rated_games', display: 'No Rated Games', rated_games: 0, reason: 'all games were between identical setups' });
    const b = builder(makeContext({ events: [mirror], cards: new CardDb(undefined), setsDir: root, replicates: 0 }), null, join(root, 'no-curated.json'));
    const file = b.event(mirror);
    assert.equal(file.event.rating_display, 'No Rated Games');
    assert.equal(file.event.rated_games, 0);
    const finishes = { identity: 'claude-haiku-5-5/low', events: 1, seats: 8, rounds: 3, counts: { '3-0': 1, '2-1': 3, '1-2': 3, '0-3': 1 }, trophies: 1 };
    assert.deepEqual(file.swiss_finishes, [finishes], 'the event');
    const idx = b.index();
    assert.deepEqual(idx.groups[0]!.swiss_finishes, [finishes], 'the group');
    const row = idx.boards[0]!.rows[0]!;
    assert.equal(row.games, 0);
    assert.deepEqual(row.provisional_reasons, ['all games were between identical setups'], 'not "no LLM-vs-LLM games": they were');
    assert.deepEqual(b.summaryOf(idx).boards[0]!.swiss_finishes, [finishes], 'summary.json board line');
  });

  check('a table of two setups is "Rated" with its rated games; Swiss finishes per setup', () => {
    const mixed = swissTable('mixed-1', [...Array(4).fill(OPUS), ...Array(4).fill(SONNET)]);
    const r = eventRatingStatus(mixed, new Identities([mixed]));
    assert.equal(r.status, 'rated');
    assert.equal(r.display, 'Rated');
    assert.ok(r.rated_games > 0 && r.rated_games < 12, `rated ${r.rated_games} of 12 (same-setup pairings don't count)`);
    const sf = swissFinishes([mixed], (ev, seat) => new Identities([mixed]).of(ev, seat).key);
    assert.deepEqual(sf.map((x) => [x.identity, x.seats]), [['claude-opus-5-5/high', 4], ['claude-sonnet-5-5/high', 4]]);
    assert.equal(sf.reduce((s, x) => s + x.trophies, 0), 1);
    const unfinished = event2('nf-1', { seats: [{ name: 'o-1', ...OPUS }, { name: 's-1', ...SONNET }], games: [['o-1', 's-1']] });
    assert.deepEqual(swissFinishes([unfinished], () => 'x'), [], 'only 8-agent Swiss tables have Swiss finishes');
  });

  check('groups key on the prompt fingerprint, not the folder name; older logs fall back to the folder', () => {
    const shaA = 'a'.repeat(64);
    const shaB = 'b'.repeat(64);
    const p1 = event2('pr-1', { seats: [{ name: 'o-1', ...OPUS }, { name: 's-1', ...SONNET }], games: [['o-1', 's-1']], start: { prompt_sha256: shaA } });
    const p2 = event2('pr-2', { seats: [{ name: 'o-1', ...OPUS }, { name: 's-1', ...SONNET }], games: [['o-1', 's-1']], start: { prompt_sha256: shaB } });
    const p3 = event2('pr-3', { seats: [{ name: 'o-1', ...OPUS }, { name: 's-1', ...SONNET }], games: [['o-1', 's-1']], start: { prompt_sha256: shaA, prompt_version: 'renamed-folder' } });
    const p4 = event2('pr-4', { seats: [{ name: 'o-1', ...OPUS }, { name: 's-1', ...SONNET }], games: [['o-1', 's-1']] });
    assert.equal(groupKey(p1), 'kn=primer;mana=manual;prompt=sha256:aaaaaaaaaaaa', 'no bo= part (2.13)');
    assert.notEqual(groupKey(p1), groupKey(p2), 'an in-place prompt edit (same folder, new content) starts a new group');
    assert.equal(groupKey(p1), groupKey(p3), 'the same content under another folder name pools');
    assert.equal(groupKey(p4), 'kn=primer;mana=manual;prompt=v4', 'no hash logged: the folder name');
    const { groups } = buildBoards({ events: [p1, p2, p4], identities: new Identities([p1, p2, p4]), replicates: 0, cards: new CardDb(undefined), ratingsFor: () => null, archetypesFor: () => null });
    // Labels never show a version: the newest group is plain, earlier ones say "Earlier Prompt" with a date when there are several.
    assert.ok(groups.every((g) => !/v4|sha|aaaa|bbbb/.test(g.label)), groups.map((g) => g.label).join(' | '));
    assert.equal(groups.filter((g) => g.label === 'Set Context · Manual Mana').length, 1);
    assert.equal(groups.filter((g) => g.label.includes('Earlier Prompt')).length, 2);
  });

  check('the main board is Set Context, manual mana with the newest prompts; everything else is a side board; best of 1 is early test data', () => {
    const mk = (id: string, start: Record<string, unknown>, t: number) => event2(id, { seats: [{ name: 'o-1', ...OPUS }, { name: 's-1', ...SONNET }], games: [['o-1', 's-1'], ['s-1', 'o-1']], start, t });
    const old3 = mk('mb-1', { best_of: 3, prompt_sha256: 'c'.repeat(64) }, T0);
    const new3 = mk('mb-2', { best_of: 3, prompt_sha256: 'd'.repeat(64) }, T0 + 60_000);
    const bo1 = mk('mb-3', { best_of: 1 }, T0 + 120_000);
    const big = [0, 1, 2, 3].map((k) => mk(`mb-n${k}`, { best_of: 3, knowledge: { level: 'none' } }, T0 + k));
    assert.equal(groupKey(bo1), null, 'best of 1: early test data, in no group');
    const evs = [old3, new3, bo1, ...big];
    const { groups, boards } = buildBoards({ events: evs, identities: new Identities(evs), replicates: 0, cards: new CardDb(undefined), ratingsFor: () => null, archetypesFor: () => null });
    const main = groups.filter((g) => g.role === 'main');
    assert.equal(main.length, 1);
    assert.equal(main[0]!.key, groupKey(new3), 'the newest prompts under the main condition, not the group with the most games');
    assert.ok(boards.filter((b) => b.group === main[0]!.key).every((b) => b.role === 'main'));
    assert.ok(boards.filter((b) => b.group !== main[0]!.key).every((b) => b.role === 'side'));
  });

  check('the real prompt change (v6 → v7): v6 tables become an earlier side group; no main board until v7 has rated games', () => {
    const v6 = promptsHash(join(PROMPTS_ARCHIVE, 'v6'))!;
    const v7 = promptsHash(PROMPTS_DIR)!;
    assert.notEqual(v6, v7);
    // The current set's version name (v7 when this was written; whichever set is current now).
    assert.deepEqual(currentPromptKeys(), [`sha256:${v7.slice(0, 12)}`, promptVersionOf(PROMPTS_DIR)]);
    const mk = (id: string, sha: string, version: string, t: number) => event2(id, { seats: [{ name: 'o-1', ...OPUS }, { name: 's-1', ...SONNET }], games: [['o-1', 's-1'], ['s-1', 'o-1']], start: { prompt_sha256: sha, prompt_version: version }, t });
    const old = [0, 1, 2].map((k) => mk(`p7-v6-${k}`, v6, 'v6', T0 + k));
    const exportOf = (evs: EventData[]) => builder(makeContext({ events: evs, cards: new CardDb(undefined), setsDir: root, replicates: 0 }), null, join(root, 'no-curated.json')).index();
    let idx = exportOf(old);
    assert.equal(idx.main_board, null, 'the v6 group is not the headline (default mainPrompts: this checkout\u2019s prompts)');
    assert.ok(idx.groups.every((g) => g.role === 'side'));
    idx = exportOf([...old, mk('p7-v7-0', v7, 'v7', T0 + 100)]);
    const main = idx.groups.find((g) => g.role === 'main')!;
    assert.equal(main.conditions.prompt_key, `sha256:${v7.slice(0, 12)}`);
    assert.equal(idx.main_board, `${main.key}|*|all`);
    assert.equal(idx.groups.find((g) => g.conditions.prompt_key === `sha256:${v6.slice(0, 12)}`)?.label.endsWith('Earlier Prompt'), true);
  });

  check('the headline board is the current prompt group: before it has rated games there is none, never an older group', () => {
    const mk = (id: string, start: Record<string, unknown>, t: number, games: Array<[string, string]> = [['o-1', 's-1'], ['s-1', 'o-1']], seats = [{ name: 'o-1', ...OPUS }, { name: 's-1', ...SONNET }]) =>
      event2(id, { seats, games, start, t });
    const v5 = [0, 1, 2].map((k) => mk(`pin-v5-${k}`, { prompt_sha256: 'e'.repeat(64) }, T0 + k));
    const side = mk('pin-side', { prompt_sha256: 'f'.repeat(64), knowledge: { level: 'none' } }, T0 + 10);
    const current = `sha256:${'f'.repeat(12)}`;
    const exportWith = (evs: EventData[]) => {
      const b = builder(makeContext({ events: evs, cards: new CardDb(undefined), setsDir: root, replicates: 0, mainPrompts: [current] }), null, join(root, 'no-curated.json'));
      const idx = b.index();
      return { idx, sum: b.summaryOf(idx) };
    };
    // Prompts just changed: only earlier-prompt events and a side condition with the current prompts.
    let { idx, sum } = exportWith([...v5, side]);
    assert.equal(idx.main_board, null, 'no main board: not the earlier group with the most games, not the side condition');
    assert.equal(sum.main, null, 'summary.json → main: null ("No Rated Games Yet")');
    assert.ok(idx.groups.every((g) => g.role === 'side'));
    assert.equal(idx.boards.length > 0, true, 'the earlier group still has its (side) board');
    // The current group exists but holds only a mirror table: still no rated games, still no main board.
    const mirror = mk('pin-mirror', { prompt_sha256: 'f'.repeat(64) }, T0 + 20, [['o-1', 'o-2']], [{ name: 'o-1', ...OPUS }, { name: 'o-2', ...OPUS }]);
    ({ idx, sum } = exportWith([...v5, side, mirror]));
    assert.equal(idx.groups.find((g) => g.key === groupKey(mirror))?.role, 'main', 'the current group is the main condition');
    assert.equal(idx.main_board, null, 'but with no rated game it is not the headline yet');
    assert.equal(sum.main, null);
    // Its first rated games make it the headline, whatever the earlier group holds.
    const first = mk('pin-first', { prompt_sha256: 'f'.repeat(64) }, T0 + 30);
    ({ idx, sum } = exportWith([...v5, side, mirror, first]));
    assert.equal(idx.main_board, `${groupKey(first)}|*|all`);
    assert.equal(sum.main?.group, groupKey(first));
    assert.equal(sum.main?.games, 2);
    assert.equal(idx.groups.find((g) => g.key === groupKey(v5[0]!))?.role, 'side', 'the earlier prompts are a side board');
  });

  check('the current prompt keys: the prompts/ fingerprint and the archive folder with the same content', () => {
    const keys = currentPromptKeys();
    assert.match(keys[0]!, /^sha256:[0-9a-f]{12}$/);
    assert.ok(keys.slice(1).every((k) => /^v\d+$/.test(k)), keys.join(', '));
  });

  check('contributors come from the logs: lobby seats, a Private Table organizer, a community uploader, admin, older logs', () => {
    const lobby = event2('ct-1', {
      seats: [{ name: 'seat-aa', ...OPUS, contributor_id: 17, contributor: 'alice' }, { name: 'seat-bb', ...SONNET, contributor_id: 23 }],
      games: [['seat-aa', 'seat-bb']], start: { organizer: { kind: 'lobby', table_id: 't1' }, table: { kind: 'lobby' } },
    });
    const everyonePublic = () => true;
    const a = contributorOf(lobby, 'seat-aa', everyonePublic);
    const b = contributorOf(lobby, 'seat-bb', everyonePublic);
    assert.deepEqual([a.via, a.handle, b.via, b.handle], ['lobby-seat', 'alice', 'lobby-seat', null], 'a handle only when the seat showed it');
    // The log keeps the handle alice showed then; the Hub's current setting decides whether it is exported.
    assert.equal(contributorOf(lobby, 'seat-aa', (id) => id !== '17').handle, null, 'hidden on the Hub now: no handle');
    assert.equal(contributorOf(lobby, 'seat-aa').handle, null, 'outside the Hub nothing is known to be public: no handle');
    assert.equal(contributorOf(lobby, 'seat-aa').key, a.key, 'the key does not depend on visibility');
    assert.match(a.key, /^c-[0-9a-f]{12}$/);
    assert.ok(!a.key.includes('17'), 'never the Hub id itself');
    assert.notEqual(a.key, b.key);
    const priv = event2('ct-2', { seats: [{ name: 'o-1', ...OPUS }, { name: 's-1', ...SONNET }], games: [['o-1', 's-1']], start: { organizer: { kind: 'contributor', handle: 'alice', contributor_id: 17 }, table: { kind: 'private' } } });
    const p = contributorOf(priv, 'o-1');
    assert.deepEqual([p.via, p.key, p.handle], ['organizer', a.key, null], 'the same person is the same key at a lobby table and at their Private Table');
    const up = event2('ct-3', { seats: [{ name: 'o-1', ...OPUS, contributor_id: 99 }, { name: 's-1', ...SONNET }], games: [['o-1', 's-1']], source: { label: 'community', submitter: 'bob' } });
    assert.deepEqual([contributorOf(up, 'o-1').via, contributorOf(up, 'o-1', everyonePublic).handle], ['uploader', null], 'community bundles: the uploader, whatever the log says; a handle needs a Hub id known to be public');
    const upId = event2('ct-3b', { seats: [{ name: 'o-1', ...OPUS }, { name: 's-1', ...SONNET }], games: [['o-1', 's-1']], source: { label: 'community', submitter: 'bob', submitter_id: 41 } });
    assert.equal(contributorOf(upId, 'o-1', (id) => id === '41').handle, 'bob');
    assert.equal(contributorOf(upId, 'o-1').handle, null);
    const adm = event2('ct-4', { seats: [{ name: 'o-1', ...OPUS }, { name: 's-1', ...SONNET }], games: [['o-1', 's-1']], start: { organizer: { kind: 'admin' } } });
    assert.equal(contributorOf(adm, 'o-1').key, 'admin');
    const old = event2('ct-5', { seats: [{ name: 'o-1', ...OPUS }, { name: 's-1', ...SONNET }], games: [['o-1', 's-1']] });
    assert.deepEqual(contributorOf(old, 'o-1'), { key: 'unattributed', handle: null, via: 'unattributed' });
    const games = ratingGamesOf([lobby], new Identities([lobby]));
    assert.deepEqual([games[0]!.ca, games[0]!.cb], [a.key, b.key], 'rated games carry both sides\' contributors');
  });

  check('model check labels: Checked Against Logs / Self-Reported / Mismatch / Unlisted, and who read the logs', () => {
    assert.deepEqual(VERIFICATION_LABELS, { verified: 'Checked Against Logs', 'self-reported': 'Self-Reported', mismatch: 'Mismatch', unlisted: 'Unlisted', mixed: 'Mixed' });
    const e = event('lb-1', [{ name: 'son-v', ...SONNET }, { name: 'opus-v', ...OPUS }], { 'son-v': { model_ids: ['claude-sonnet-5-5'] } });
    writeFileSync(join(root, 'lb-1', 'transcript-opus-v.jsonl'), JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-5-5' }) + '\n');
    const ev = loadEvent(join(root, 'lb-1'), T0 + 10_000)!;
    const ids = new Identities([ev]);
    const v = ids.of(ev, 'son-v').verification;
    assert.deepEqual([v.status, v.label, v.logs_read_by], ['verified', 'Checked Against Logs', 'contributor-cli']);
    const t = ids.of(ev, 'opus-v').verification;
    assert.deepEqual([t.label, t.logs_read_by], ['Checked Against Logs', 'export']);
    const s2 = event('lb-2', [{ name: 'son-n', ...SONNET }, { name: 'opus-n', ...OPUS }]);
    const ids2 = new Identities([s2]);
    const ns = ids2.of(s2, 'son-n').verification;
    assert.deepEqual([ns.label, ns.logs_read_by], ['Self-Reported', null]);
    assert.equal(ids2.info.get('claude-sonnet-5-5/high')?.model_verification_label, 'Self-Reported');
  });

  check('forfeits: a forfeit is a loss (the policy in force); both alternatives are one setting away', () => {
    // haiku went silent: its game against opus was conceded (forfeited_by), but it beat sonnet earlier.
    const ev = event2('ff-1', {
      seats: [{ name: 'o-1', ...OPUS }, { name: 's-1', ...SONNET }, { name: 'h-1', ...HAIKU }],
      games: [['h-1', 's-1'], ['o-1', 'h-1', 'h-1'], ['o-1', 's-1']],
      forfeits: [{ seat: 'h-1', stage: 'game' }],
    });
    const ids = new Identities([ev]);
    assert.equal(FORFEIT_POLICY, 'loss');
    const cur = ratingGamesOf([ev], ids);
    assert.equal(cur.length, 3, 'loss (current): the conceded game counts');
    assert.ok(cur.some((g) => g.seatA === 'o-1' && g.seatB === 'h-1' && g.winner === 'a'), 'a loss for the silent seat, a win for its opponent');
    assert.ok(cur.some((g) => g.seatA === 'h-1' && g.seatB === 's-1' && g.winner === 'a'), 'its earlier win still counts');
    assert.equal(eventRatingStatus(ev, ids).rated_games, 3);
    const excluded = ratingGamesOf([ev], ids, { forfeits: 'exclude-game' });
    assert.equal(excluded.length, 2, 'exclude-game: the conceded game is left out, the rest count');
    assert.ok(!excluded.some((g) => g.seatA === 'o-1' && g.seatB === 'h-1'));
    const voided = ratingGamesOf([ev], ids, { forfeits: 'void-seat-event' });
    assert.deepEqual(voided.map((g) => [g.seatA, g.seatB]), [['o-1', 's-1']], 'void-seat-event: every game of the silent seat goes, its win included');
  });

  // Three spellings of Claude Sonnet 5.5 across events: old free-text logs and a resolved Director log.
  const e1 = event('ev-1', [{ name: 'sonnet-1', harness: 'claude-code', model: 'Sonnet 5.5' }, { name: 'opus-2', harness: 'Claude Code', model: 'opus', effort: 'High' }]);
  const e2 = event('ev-2', [
    { name: 'son-a', harness: 'opencode', model: 'anthropic/claude-sonnet-5-5' },
    { name: 'opus-b', harness: 'claude', model: 'claude-opus-5-5', effort: 'high' },
  ]);
  const e3 = event('ev-3', [
    { name: 'son-x', harness: 'claude-code', model: 'claude-sonnet-5-5', effort: 'default', model_declared: 'sonnet' },
    { name: 'opus-y', harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high', harness_declared: 'Claude Code', model_declared: 'Claude Opus 5.5', effort_declared: 'HIGH' },
  ]);

  check('two spellings of one model are one identity, on any harness', () => {
    const ids = new Identities([e1, e2, e3]);
    assert.equal(ids.of(e1, 'sonnet-1').key, 'claude-sonnet-5-5/unknown');
    assert.equal(ids.of(e3, 'son-x').key, 'claude-sonnet-5-5/unknown');
    // Harness and effort spellings too.
    assert.equal(ids.of(e1, 'opus-2').key, 'claude-opus-5-5/high');
    assert.equal(ids.of(e2, 'opus-b').key, 'claude-opus-5-5/high');
    assert.equal(ids.of(e3, 'opus-y').key, 'claude-opus-5-5/high');
    // A different harness is the same row (2.20: the harness is a seat detail).
    assert.equal(ids.of(e2, 'son-a').key, ids.of(e1, 'sonnet-1').key);
    const info = ids.info.get('claude-opus-5-5/high')!;
    assert.equal(info.label, 'Claude Opus 5.5 · High');
    assert.equal(info.model_display, 'Claude Opus 5.5');
    assert.equal(info.provider, 'anthropic');
    assert.deepEqual(info.harnesses, [{ id: 'claude-code', display: 'Claude Code', seats: 3 }]);
    assert.deepEqual(info.model_aliases.sort(), ['Claude Opus 5.5', 'claude-opus-5-5', 'opus'].sort());
  });

  check('rating games are keyed by the canonical identity', () => {
    const ids = new Identities([e1, e2, e3]);
    const games = ratingGamesOf([e1, e3], ids);
    assert.equal(games.length, 2);
    assert.deepEqual(new Set(games.map((g) => g.a)), new Set(['claude-sonnet-5-5/unknown']));
    assert.deepEqual(new Set(games.map((g) => g.b)), new Set(['claude-opus-5-5/high']));
  });

  check('a registry fix (a new alias) merges old rows at the next export; the logs are untouched', () => {
    const e4 = event('ev-4', [{ name: 'son-z', harness: 'claude-code', model: 'Sonnet Five Five' }, { name: 'opus-w', harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high' }]);
    const before = new Identities([e4]).of(e4, 'son-z');
    assert.equal(before.key, 'unlisted:sonnet-five-five/unknown');
    assert.equal(before.listed, false);
    assert.equal(before.rated, false);
    assert.equal(before.verification.status, 'unlisted');
    assert.equal(ratingGamesOf([e4], new Identities([e4])).length, 0, 'Unlisted seats are not rated');
    const data: RegistryData = structuredClone(REGISTRY_DATA);
    data.models.find((m) => m.id === 'claude-sonnet-5-5')!.aliases.push('sonnet five five');
    const after = new Identities([e4], new Registry(data)).of(e4, 'son-z');
    assert.equal(after.key, 'claude-sonnet-5-5/unknown');
    assert.equal(after.rated, true);
    assert.equal(ratingGamesOf([e4], new Identities([e4], new Registry(data))).length, 1);
  });

  check('usage verifies the model; helper models are ignored', () => {
    const e5 = event('ev-5', [
      { name: 'son-v', harness: 'claude-code', model: 'claude-sonnet-5-5', effort: 'high' },
      { name: 'hai-v', harness: 'claude-code', model: 'claude-haiku-5-5', effort: 'high' },
    ], {
      'son-v': { model_ids: ['claude-sonnet-5-5', 'claude-haiku-5-5'], model_output_tokens: { 'claude-sonnet-5-5': 50000, 'claude-haiku-5-5': 19 } },
      'hai-v': { model_ids: ['claude-haiku-5-5'] },
    });
    const ids = new Identities([e5]);
    assert.equal(ids.of(e5, 'son-v').verification.status, 'verified');
    assert.equal(ids.of(e5, 'hai-v').verification.status, 'verified');
    assert.equal(ids.info.get('claude-sonnet-5-5/high')!.model_verification, 'verified');
    assert.equal(ratingGamesOf([e5], ids).length, 1);
  });

  check('a Mismatch seat is excluded from rating, with the reason', () => {
    const e6 = event('ev-6', [
      { name: 'opus-m', harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high' },
      { name: 'son-m', harness: 'claude-code', model: 'claude-sonnet-5-5', effort: 'high' },
    ], { 'opus-m': { model_ids: ['claude-sonnet-5-5'], model_output_tokens: { 'claude-sonnet-5-5': 40000 } } });
    const ids = new Identities([e6]);
    const m = ids.of(e6, 'opus-m');
    assert.equal(m.verification.status, 'mismatch');
    assert.match(m.verification.reason, /claude-sonnet-5-5/);
    assert.equal(m.rated, false);
    assert.equal(ratingGamesOf([e6], ids).length, 0);
    // The other seat had no usage: Self-Reported, still rated (no opponent left in this event though).
    assert.equal(ids.of(e6, 'son-m').verification.status, 'self-reported');
    assert.equal(ids.of(e6, 'son-m').rated, true);
  });

  check('a dated snapshot behind the same id is the same row, recorded and flagged', () => {
    const e7 = event('ev-7', [
      { name: 'son-s', harness: 'claude-code', model: 'claude-sonnet-5-5', effort: 'high' },
      { name: 'opus-s', harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high' },
    ], { 'son-s': { model_ids: ['claude-sonnet-5-5-20261101'] } });
    const ids = new Identities([e7]);
    const s = ids.of(e7, 'son-s');
    assert.equal(s.key, 'claude-sonnet-5-5/high');
    assert.equal(s.verification.status, 'verified');
    assert.equal(s.verification.snapshot, 'claude-sonnet-5-5-20261101');
    const info = ids.info.get(s.key)!;
    assert.deepEqual(info.snapshots, ['claude-sonnet-5-5-20261101']);
    assert.equal(info.unknown_snapshot, true);
  });

  check('effort: detected from logs, set at launch, harness default by version, or Unknown (own row)', () => {
    const e9 = event('ev-9', [
      { name: 'opus-d', harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high', effort_basis: 'launch' } ,
      { name: 'son-d', harness: 'claude-code', model: 'claude-sonnet-5-5' },
    ], {
      'opus-d': { model_ids: ['claude-opus-5-5'], harness_version: '2.1.306', effort_reported: { level: 'xhigh', counts: { xhigh: 30 }, source: 'claude-session' } },
      'son-d': { model_ids: ['claude-sonnet-5-5'], harness_version: '2.1.306' },
    });
    const ids = new Identities([e9]);
    const o = ids.of(e9, 'opus-d');
    // The logs win over the declaration, and the difference is flagged.
    assert.equal(o.key, 'claude-opus-5-5/xhigh');
    assert.deepEqual([o.effortInfo?.source, o.effortInfo?.status], ['detected', 'mismatch']);
    assert.equal(o.rated, true);
    // No level declared, harness version known: the documented Claude Code default.
    const s = ids.of(e9, 'son-d');
    assert.equal(s.key, 'claude-sonnet-5-5/medium');
    assert.deepEqual([s.effortInfo?.source, s.effortInfo?.harness_version], ['harness-default', '2.1.306']);
    const info = ids.info.get(s.key)!;
    assert.deepEqual(info.effort_sources, { 'harness-default': 1 });
    assert.equal(info.label, 'Claude Sonnet 5.5 · Medium');
    // Set at launch, no logs: declared-explicit.
    const e10 = event('ev-10', [
      { name: 'opus-l', harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high', effort_basis: 'launch' } ,
      { name: 'opus-u', harness: 'claude-code', model: 'claude-opus-5-5' },
    ]);
    const ids2 = new Identities([e10]);
    assert.deepEqual([ids2.of(e10, 'opus-l').key, ids2.of(e10, 'opus-l').effortInfo?.source], ['claude-opus-5-5/high', 'declared-explicit']);
    // Nothing declared, no version: Unknown, its own clearly labeled row.
    const u = ids2.of(e10, 'opus-u');
    assert.deepEqual([u.key, u.effortInfo?.source], ['claude-opus-5-5/unknown', 'unknown']);
    assert.equal(ids2.info.get(u.key)!.label, 'Claude Opus 5.5 · Unknown Effort');
  });

  check('an old log resolves its default from the transcript\'s harness version', () => {
    const e11 = event('ev-11', [{ name: 'haiku-t', harness: 'claude-code', model: 'haiku' }, { name: 'opus-t', harness: 'claude-code', model: 'opus' }]);
    writeFileSync(join(root, 'ev-11', 'transcript-haiku-t.jsonl'), JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-haiku-5-5', claude_code_version: '2.1.306' }) + '\n');
    const ev = loadEvent(join(root, 'ev-11'), T0 + 10_000)!;
    const ids = new Identities([ev]);
    assert.equal(ids.of(ev, 'haiku-t').key, 'claude-haiku-5-5/medium');
    assert.equal(ids.of(ev, 'opus-t').key, 'claude-opus-5-5/unknown');
  });

  check('a launcher (T3 Code) is not a harness: the seat is its harness, with the launcher beside it; fast is recorded, not keyed', () => {
    const e12 = event('ev-12', [
      { name: 'opus-t3', harness: 't3-code:claude-code', model: 'claude-opus-5-5', effort: 'high', harness_declared: 'T3 Code (Claude Code)' },
      { name: 'opus-cu', harness: 'cursor', model: 'claude-opus-5-5', effort: 'high' },
    ], {
      'opus-t3': { model_ids: ['claude-opus-5-5'], harness_version: '2.1.306', effort_reported: { level: 'high', counts: { high: 9 }, source: 'claude-session', status: 'tested' } },
      'opus-cu': { model_ids: ['claude-opus-5-5'], effort_reported: { level: 'high', counts: { high: 1 }, source: 'cursor-sdk-store', status: 'tested', fast: true } },
    });
    const ids = new Identities([e12]);
    const t = ids.of(e12, 'opus-t3');
    assert.equal(t.key, 'claude-opus-5-5/high');
    assert.equal(t.launcher, 't3-code');
    const e13 = event('ev-13', [{ name: 'opus-cc', harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high' }, { name: 'opus-cu', harness: 'cursor', model: 'claude-opus-5-5', effort: 'high' }]);
    const cc = new Identities([e13]).of(e13, 'opus-cc');
    assert.equal(cc.key, t.key, 'one row with the plain harness');
    assert.equal(cc.launcher, undefined);
    assert.deepEqual([t.effortInfo?.source, t.effortInfo?.status], ['detected', 'verified']);
    assert.equal(ids.info.get(t.key)!.label, 'Claude Opus 5.5 · High');
    assert.equal(ids.launcherDisplay('t3-code'), 'T3 Code');
    const c = ids.of(e12, 'opus-cu');
    assert.equal(c.key, 'claude-opus-5-5/high');
    assert.equal(c.effortInfo?.fast, true);
  });

  check('a seat excluded on its own (a banned contributor at a lobby table) unrates its games; the event stays', () => {
    const ev = event('ev-ban', [
      { name: 'opus-1', harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high' },
      { name: 'son-1', harness: 'claude-code', model: 'claude-sonnet-5-5', effort: 'high' },
    ]);
    assert.equal(ratingGamesOf([ev], new Identities([ev])).length, 1);
    writeFileSync(join(root, 'ev-ban', 'source.json'), JSON.stringify({ label: 'verified', exclude_seats: { 'opus-1': 'contributor banned: test' } }));
    const again = loadEvent(join(root, 'ev-ban'), T0 + 10_000)!;
    assert.deepEqual(again.source.excludeSeats, { 'opus-1': 'contributor banned: test' });
    assert.equal(again.source.exclude, undefined, 'not the whole event');
    assert.equal(ratingGamesOf([again], new Identities([again])).length, 0);
  });

  check('floating aliases resolve by the event date', () => {
    // On 2026-10-01 "haiku" meant a model the registry doesn't list (Claude Haiku 5.5 shipped 2026-10-07).
    const e8 = event('ev-8', [{ name: 'haiku-1', harness: 'claude-code', model: 'haiku' }, { name: 'opus-1', harness: 'claude-code', model: 'opus' }]);
    const early: EventData = { ...e8, id: 'ev-8-early', startT: Date.parse('2026-10-01T12:00:00Z') };
    assert.equal(new Identities([e8]).of(e8, 'haiku-1').model, 'claude-haiku-5-5');
    assert.equal(new Identities([early]).of(early, 'haiku-1').model, 'unlisted:haiku');
  });
  check('no harness in the log: a transcript before the bench CLI says Claude Code, even empty; nothing at all says Harness Not Recorded', () => {
    const early = Date.parse('2026-10-21T21:02:05Z');
    const mk = (id: string, transcript: boolean) => {
      const ev = event2(id, { seats: [{ name: 'sonnet-1', model: 'sonnet' }, { name: 'haiku-2', model: 'haiku' }], games: [['sonnet-1', 'haiku-2']], t: early });
      if (transcript) for (const seat of ['sonnet-1', 'haiku-2']) writeFileSync(join(root, id, `transcript-${seat}.jsonl`), '');
      return loadEvent(join(root, id), early + 100_000)!;
    };
    const withFiles = mk('hn-1', true);
    const ids = new Identities([withFiles]);
    assert.equal(ids.of(withFiles, 'sonnet-1').harness, 'claude-code');
    const bare = mk('hn-2', false);
    const ids2 = new Identities([bare]);
    const id = ids2.of(bare, 'sonnet-1');
    assert.equal(id.harness, 'unknown');
    assert.deepEqual(ids2.info.get(id.key)?.harnesses?.map((h) => h.display), ['Harness Not Recorded']);
    assert.ok(!ids2.info.get(id.key)?.label.includes('Unknown Harness'));
  });

  check('summary.json: main-board rows carry outcomes, cost per game, influence, the floor, reasons, games needed, live; and head to head', () => {
    const evs = [0, 1, 2].map((k) => event2(`sm-${k}`, {
      seats: [{ name: 'o-1', ...OPUS, contributor_id: 7 }, { name: 's-1', ...SONNET, contributor_id: 8 }], games: [['o-1', 's-1'], ['s-1', 'o-1'], ['o-1', 's-1']],
      start: { best_of: 3, organizer: { kind: 'lobby' }, table: { kind: 'lobby' } }, t: T0 + k * 1000,
    }));
    // These fixtures log prompt_version v4: make v4 the current prompts for this export.
    const b = builder(makeContext({ events: evs, cards: new CardDb(undefined), setsDir: root, replicates: 0, mainPrompts: ['v4'] }), null, join(root, 'no-curated.json'));
    const sum = b.summaryOf(b.index());
    assert.ok(sum.main, 'a main board');
    assert.equal(sum.main!.pairwise.length, 1);
    for (const r of sum.main!.rows) {
      for (const k of ['provisional_reasons', 'games_needed', 'contributor_floor_met', 'influence', 'cost', 'outcomes', 'live'] as const) assert.ok(k in r, `row has ${k}`);
      assert.equal(r.live, false);
      assert.equal(r.outcomes!.games.w + r.outcomes!.games.l, r.games);
      assert.ok(r.outcomes!.events.finishes.length <= SUMMARY_FINISHES);
    }
  });
  check('2.10 US keys, with the deprecated British keys next to them for one release', () => {
    const v = { cards: { 'Colorful Bolt': { colors: 'R' } }, rows: [{ open_colors: 'WU', flow_colors: 'WU' }], colors: '' };
    assert.deepEqual(withDeprecatedKeys(v), {
      cards: { 'Colorful Bolt': { colors: 'R', colours: 'R' } }, rows: [{ open_colors: 'WU', open_colours: 'WU', flow_colors: 'WU' }], colors: '', colours: '',
    });
    assert.deepEqual(v.cards['Colorful Bolt'], { colors: 'R' }, 'the value itself is not changed');
    assert.equal(serialize('# text'), '# text');
    assert.match(serialize({ colors: 'G' }), /"colours":"G"/);
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed) {
  console.log(`\n${failed} identity test(s) failed`);
  process.exit(1);
}
console.log('\nidentity: all passed');
