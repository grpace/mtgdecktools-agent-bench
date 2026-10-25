/**
 * The open dataset (docs/OPEN-DATA.md): a build from a fixture event, its schemas in CSV and Parquet, the snapshot
 * zip, checksums, the incremental log cache, retention and takedown pruning, the schedule, and a privacy scan of
 * every byte published (tokens, e-mail and IP addresses, paths, hidden handles, raw contributor ids, transcripts).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parquetMetadata, parquetReadObjects } from 'hyparquet';
import { makeContext } from '../../site/src/context.js';
import { CardDb, loadEvent, type EventData } from '../../site/src/data.js';
import { buildOpenData, included, pruneSnapshots, type SnapshotRecord } from '../src/open-data/build.js';
import { readZip } from '../src/open-data/formats.js';
import { OPEN_DATA_LICENSE } from '../src/open-data/license.js';
import { redactLog, scrubText } from '../src/open-data/redact.js';
import { buildCommand, nextRunAt } from '../src/open-data/schedule.js';
import { checkRows, TABLES, type Row } from '../src/open-data/tables.js';

const root = resolve(import.meta.dirname, '../../..');
const ID = '2026-10-22-12-00-00-fra-0d0d';
const A = 'seat-a1a1a1';
const B = 'seat-b2b2b2';
const OTHERS = ['seat-c3c3c3', 'seat-d4d4d4', 'seat-e5e5e5', 'seat-f6f6f6', 'seat-0a0a0a', 'seat-0b0b0b'];
const M = `${A} vs ${B}`;
const G = (n: number) => `${M} — game ${n}`;

// What must never be published. Each is planted somewhere in the fixture.
const SECRETS = {
  seatToken: '0123456789abcdef0123456789abcdef',
  hubToken: 'mtgdt_play_Q2hhbmdlTWVQbGVhc2VJdHNBU2VjcmV0VG9rZW4',
  bearer: 'Bearer abcdefghijklmnopqrstuvwxyz012345',
  email: 'alice.smith@example.com',
  homePath: '/home/alice/projects/secret-notes.txt',
  tildePath: '~/Library/agent/scratch.md',
  windowsPath: 'C:\\Users\\Bob\\Desktop\\deck.txt',
  ip: '203.0.113.77',
  hiddenHandle: 'secretbob',
  entryId: 'entry-777secret',
  tableId: 'tbl-123secret',
  transcript: 'TRANSCRIPT-SECRET-MARKER',
  usage: 'USAGE-SECRET-MARKER',
  submission: 'submission-4242-secret',
};

function fraCards(n: number): string[] {
  const j = JSON.parse(readFileSync(join(root, 'sets/FRA/17lands.json'), 'utf8')) as { cards: Record<string, unknown> };
  return Object.keys(j.cards).filter((c) => !c.includes('//')).slice(0, n);
}

/** A finished best-of-3 lobby event: two agents play a 2-0 match with sideboarding; secrets planted throughout. */
function writeFixture(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const cards = fraCards(30);
  const deckA = [...cards.slice(0, 23), ...Array(17).fill('Plains')];
  const deckB = [...cards.slice(5, 28), ...Array(17).fill('Island')];
  const seat = (name: string, position: number, extra: Record<string, unknown> = {}) => ({
    name, kind: 'agent', position, harness: 'claude-code', model: 'claude-haiku-5-5', effort: 'low', effort_basis: 'launch', context_policy: 'fresh-per-game', ...extra,
  });
  const recs: Array<Record<string, unknown>> = [
    {
      type: 'event_start', id: ID, set: { code: 'FRA', name: 'Fixture Set' }, seed: 'fra-fixture-1', best_of: 3, sideboarding: true, play_draw: 'loser-chooses',
      mana: 'manual', prompt_version: 'current', prompt_sha256: 'a'.repeat(64),
      knowledge: { level: 'primer', primer: { from: SECRETS.homePath, sha256: 'b'.repeat(64), bytes: 100 } },
      provenance: { director: 'abc1234', engine: { server_version: '0.115.0', build_commit: '6485512', protocol_version: 159, digest: 'sha256:' + 'c'.repeat(64) } },
      pairing: { format: 'swiss', rounds: 3, version: 1 }, seat_timeout_ms: 600000,
      organizer: { kind: 'lobby', table_id: SECRETS.tableId },
      table: { kind: 'lobby', queue: 'fra-primer-manual', table_id: SECRETS.tableId },
      seats: [
        seat(A, 0, { contributor_id: '17', contributor: 'alicepub', entry_id: SECRETS.entryId }),
        seat(B, 1, { contributor_id: '18', contributor: SECRETS.hiddenHandle, entry_id: SECRETS.entryId }),
        ...OTHERS.map((n, k) => seat(n, k + 2, { contributor_id: '18', contributor: SECRETS.hiddenHandle })),
      ],
    },
    { type: 'packs_opened', round: 1, packs: [cards.slice(0, 14)], swaps: [] },
    { type: 'draft_pick', seat: A, pack_number: 1, pick_number: 1, overall_pick: 1, pack: cards.slice(0, 14), pack_rarities: Array(14).fill('common'), pick: cards[0], by: 'agent', latency_ms: 4000, note: `Best card; mail me at ${SECRETS.email}` },
    { type: 'draft_pick', seat: B, pack_number: 1, pick_number: 1, overall_pick: 1, pack: cards.slice(5, 19), pack_rarities: Array(14).fill('uncommon'), pick: cards[5], by: 'agent', latency_ms: 3000, note: 'Strong removal.' },
    { type: 'draft_pick', seat: A, pack_number: 1, pick_number: 2, overall_pick: 2, pack: cards.slice(1, 14), pick: cards[1], by: 'forced' },
    { type: 'draft_end' },
    { type: 'deck_built', seat: A, by: 'agent', main: deckA, sideboard: cards.slice(23, 30), note: `Saved my plan to ${SECRETS.tildePath}`, deck_name: 'White Weenie', archetype: 'W aggro', latency_ms: 9000 },
    { type: 'deck_built', seat: B, by: 'agent', main: deckB, sideboard: [...cards.slice(0, 5), ...cards.slice(28, 30)], note: 'Blue tempo.', latency_ms: 8000 },
    { type: 'build_end' },
    { type: 'round_start', round: 1, rounds: 3, format: 'swiss', pairs: [[A, B]], byes: [] },
    { type: 'play_draw', match: M, game_number: 1, on_play: A, by: 'seed', chooser: null, choice: null },
    { type: 'game_start', game: G(1), match: M, game_number: 1, seats: [A, B], mana: 'manual', deck_sizes: { [A]: 40, [B]: 40 } },
    {
      type: 'decision_offered', game: G(1), seat: A, id: 'G1', kind: 'MulliganDecision', turn: 1, phase: 'Untap', active: 'you', life: { you: 20, opponent: 20 }, hand: { you: 7, opponent: 7 },
      options: ['Keep this hand', 'Mulligan'], text: `Turn 1 — YOUR turn\nDECISION G1 — Keep or mulligan?\n  [1] Keep this hand\n  [2] Mulligan\n(debug: http://127.0.0.1:8787/mcp/${SECRETS.seatToken} ${SECRETS.hubToken})`,
    },
    { type: 'agent_decision', game: G(1), seat: A, id: 'G1', kind: 'MulliganDecision', turn: 1, latency_ms: 1200, choice: 'Keep this hand', structured: false, note: `Keep. Server at ${SECRETS.ip}`, accepted: true },
    {
      type: 'decision_offered', game: G(1), seat: B, id: 'G1', kind: 'MulliganDecision', turn: 1, phase: 'Untap', active: 'opponent', life: { you: 20, opponent: 20 }, hand: { you: 7, opponent: 7 },
      options: ['Keep this hand', 'Mulligan'], text: 'Turn 1 — OPPONENT\'s turn\nDECISION G1 — Keep or mulligan?\n  [1] Keep this hand\n  [2] Mulligan',
    },
    { type: 'agent_decision', game: G(1), seat: B, id: 'G1', kind: 'MulliganDecision', turn: 1, latency_ms: 900, choice: 2, structured: false, note: 'Too few lands.', accepted: true },
    { type: 'rules_issue', seat: B, card: cards[3], note: `Odd interaction; logs in ${SECRETS.homePath}`, stage: 'games', game: G(1), turn: 3 },
    { type: 'game_over', game: G(1), match: M, game_number: 1, winner: A, turns: 9, on_play: A, final_life: { [A]: 7, [B]: 0 }, end_reason: 'life', mulligans: { [A]: 0, [B]: 1 } },
    { type: 'play_draw_offered', seat: B, match: M, game_number: 2, id: 'P2', text: 'You lost game 1. Play or draw?' },
    { type: 'play_draw', match: M, game_number: 2, on_play: B, by: 'agent', chooser: B, choice: 'play', note: `Play first. ${SECRETS.bearer}`, latency_ms: 2000 },
    { type: 'sideboard_offered', seat: A, match: M, game_number: 2, id: 'S2', text: 'Sideboard for game 2?' },
    { type: 'sideboarded', seat: A, match: M, game_number: 2, by: 'agent', kept: true, in: [], out: [], main: deckA, sideboard: cards.slice(23, 30), basics: { Plains: 17 }, main_count: 40, latency_ms: 1500, note: 'No changes.' },
    {
      type: 'sideboarded', seat: B, match: M, game_number: 2, by: 'agent', kept: false, in: [{ name: cards[0], qty: 1 }], out: [{ name: cards[5], qty: 1 }],
      main: [cards[0], ...deckB.slice(1)], sideboard: [cards[5], ...cards.slice(1, 5), ...cards.slice(28, 30)], basics: { Island: 17 }, main_count: 40, latency_ms: 2500,
      note: `Swap in removal (see ${SECRETS.windowsPath})`,
    },
    { type: 'game_start', game: G(2), match: M, game_number: 2, seats: [B, A], mana: 'manual', deck_sizes: { [A]: 40, [B]: 40 } },
    {
      type: 'decision_offered', game: G(2), seat: B, id: 'G7', kind: 'DeclareAttackers', turn: 4, phase: 'DeclareAttackers', active: 'you', life: { you: 18, opponent: 15 }, hand: { you: 3, opponent: 4 },
      options: ['No attack', 'Attack with all'], text: 'Turn 4 — YOUR turn\nDECISION G7 — Attack?\n  [1] No attack\n  [2] Attack with all',
    },
    { type: 'agent_decision', game: G(2), seat: B, id: 'G7', kind: 'DeclareAttackers', turn: 4, latency_ms: 3100, choice: { attackers: [12] }, structured: true, note: 'Swing with the flier.', accepted: true },
    { type: 'game_over', game: G(2), match: M, game_number: 2, winner: A, turns: 11, on_play: B, final_life: { [A]: 3, [B]: -2 }, end_reason: 'life', mulligans: { [A]: 0, [B]: 0 } },
    { type: 'match_end', a: A, b: B, wins: { [A]: 2, [B]: 0 } },
    { type: 'seat_done', seat: A, round: 3 },
    { type: 'event_end', standings: [{ name: A, matchWins: 1, matchLosses: 0, gameWins: 2, gameLosses: 0 }, { name: B, matchWins: 0, matchLosses: 1, gameWins: 0, gameLosses: 2 }], matches: [{ a: A, b: B, wins: { [A]: 2, [B]: 0 } }] },
    { type: 'hub_handoff', attempt: 1, http: 201, ok: true, submission_id: 4242, note: SECRETS.submission },
  ];
  const t0 = Date.UTC(2026, 9, 22, 12, 0, 0);
  writeFileSync(join(dir, 'events.jsonl'), recs.map((r, k) => JSON.stringify({ t: t0 + k * 1000, ...r })).join('\n') + '\n');
  writeFileSync(join(dir, 'source.json'), JSON.stringify({ label: 'verified', submitter_id: '99', submitted_at: '2026-10-22T13:00:00Z', bundle_sha256: 'd'.repeat(64), submission_id: 4242, flags: ['anomaly.fast_answers'], pack_regeneration: 'verified' }));
  writeFileSync(join(dir, `transcript-${A}.jsonl`), [
    JSON.stringify({ type: 'system', subtype: 'init', cwd: SECRETS.homePath, claude_code_version: '2.1.306', model: 'claude-haiku-5-5' }),
    JSON.stringify({ type: 'assistant', message: { id: 'm1', model: 'claude-haiku-5-5', content: [{ type: 'text', text: SECRETS.transcript }], usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300 } } }),
    JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.0003, num_turns: 3, usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300 }, result: SECRETS.transcript }),
  ].join('\n') + '\n');
  writeFileSync(join(dir, `usage-${B}.json`), JSON.stringify({ model_ids: ['claude-haiku-5-5'], input_tokens: 10, output_tokens: 20, cache_read_tokens: 30, cache_creation_tokens: 40, cost_usd: 0.1, complete: true, harness_version: '2.1.306', note: SECRETS.usage }));
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({ standings: [] }));
}

function setup(): { dir: string; out: string; ev: EventData; build: (events?: EventData[], now?: number) => ReturnType<typeof buildOpenData> } {
  const base = mkdtempSync(join(tmpdir(), 'open-data-'));
  const dir = join(base, 'runs', ID);
  writeFixture(dir);
  const ev = loadEvent(dir, Date.now())!;
  assert.ok(ev, 'the fixture loads');
  const out = join(base, 'hub');
  const build = (events: EventData[] = [ev], now = Date.UTC(2026, 9, 22, 7, 30)) => buildOpenData({
    root: join(out, 'open-data'), siteLink: join(out, 'site', 'open'), methodology: null, url: 'https://hub.example/data/open', fingerprint: 'test', now,
    ctx: makeContext({ events, cards: new CardDb(undefined), setsDir: join(root, 'sets'), replicates: 0, contributorPublic: (id) => id === '17' }),
  });
  return { dir, out, ev, build };
}

/** Every byte under a folder as text: .gz decompressed, Parquet rows as JSON, zip entries (and their contents) unpacked. */
async function publishedText(dir: string): Promise<string> {
  const parts: string[] = [];
  const add = async (name: string, data: Buffer) => {
    if (name.endsWith('.gz')) parts.push(gunzipSync(data).toString('utf8'));
    else if (name.endsWith('.parquet')) {
      const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.length) as ArrayBuffer;
      parts.push(JSON.stringify(await parquetReadObjects({ file: ab }), (_k, v) => (typeof v === 'bigint' ? Number(v) : v)));
      parts.push(JSON.stringify(parquetMetadata(ab).key_value_metadata ?? []));
    } else if (name.endsWith('.zip')) {
      for (const e of readZip(data)) {
        assert.ok(e.crcOk, `zip entry ${e.name}: CRC`);
        await add(e.name, e.data);
      }
    } else parts.push(data.toString('utf8'));
  };
  const walk = async (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else await add(e.name, readFileSync(p));
    }
  };
  await walk(dir);
  return parts.join('\n');
}

test('redaction: tokens, e-mail and IP addresses, paths become placeholders; game text is untouched', () => {
  const s = `url http://h/mcp/${SECRETS.seatToken} tok ${SECRETS.hubToken} ${SECRETS.bearer} mail ${SECRETS.email} ip ${SECRETS.ip} ${SECRETS.homePath} ${SECRETS.tildePath} ${SECRETS.windowsPath} file:///tmp/x`;
  const out = scrubText(s);
  for (const v of Object.values(SECRETS).filter((x) => !['secretbob', 'entry-777secret', 'tbl-123secret', 'TRANSCRIPT-SECRET-MARKER', 'USAGE-SECRET-MARKER', 'submission-4242-secret'].includes(x))) {
    assert.ok(!out.includes(v), `${v} survived: ${out}`);
  }
  assert.match(out, /\/mcp\/\[token\]/);
  assert.match(out, /\[email\]/);
  assert.match(out, /\[path\]/);
  assert.match(out, /\[ip\]/);
  const game = 'Cast Lightning Bolt for {R}: 3 damage to any target. 2/2 for {1}{W}. sha256 ' + 'e'.repeat(64) + ' at 12:30, version 0.115.0, 1/1 token, pick 3/14.';
  assert.equal(scrubText(game), game, 'card text, P/T, hashes and versions stay');
  const log = redactLog(`${JSON.stringify({ type: 'event_start', id: 'x', seats: [{ name: 's', contributor_id: '5', contributor: 'h', entry_id: 'e' }], organizer: { kind: 'contributor', contributor_id: '5', handle: 'h' } })}\n${JSON.stringify({ type: 'hub_handoff', x: 1 })}\nnot json\n`, { seats: new Map([['s', { key: 'c-123', handle: null }]]), organizerKey: 'c-123' });
  const lines = log.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1, 'hub_handoff and malformed lines dropped');
  assert.deepEqual(lines[0].seats, [{ name: 's', contributor_key: 'c-123' }]);
  assert.deepEqual(lines[0].organizer, { kind: 'contributor', contributor_key: 'c-123' });
});

test('open data from a fixture event: every table in CSV and Parquet matches its schema', async () => {
  const { out, ev, build } = setup();
  assert.ok(included(ev), 'a finished LLM event is published');
  const r = await build();
  const open = join(out, 'site', 'open');
  assert.ok(readlinkSync(open).startsWith('../open-data/builds/'), 'site/open is a relative symlink to the build');
  const latest = JSON.parse(readFileSync(join(open, 'latest.json'), 'utf8'));
  assert.equal(latest.license.id, OPEN_DATA_LICENSE.id);
  assert.equal(latest.license.attribution, 'MTG Deck Tools Agent Bench');
  assert.equal(latest.updated, 'nightly');
  assert.equal(latest.snapshot.file, 'snapshots/agent-bench-data-2026-10-22.zip');
  assert.equal(latest.snapshot.date, '2026-10-22');
  assert.ok(latest.snapshot.bytes > 0 && /^[0-9a-f]{64}$/.test(latest.snapshot.sha256));
  assert.equal(latest.human_reference.included, true, 'the 17Lands human reference is on by default');
  assert.match(latest.human_reference.note, /not produced or endorsed by 17Lands/);
  assert.equal(r.events, 1);

  for (const t of TABLES) {
    const meta = latest.tables[t.name];
    assert.ok(meta, `latest.json lists ${t.name}`);
    // CSV: the header is the schema; rows parse back to the count.
    const csv = gunzipSync(readFileSync(join(open, meta.csv.path))).toString('utf8');
    const [header, ...rows] = csv.trimEnd().split('\r\n');
    assert.equal(header, t.columns.map((c) => c.name).join(','), `${t.name}.csv header`);
    assert.ok(rows.length >= meta.rows, `${t.name}.csv rows`);
    // Parquet: the same columns, the same rows, typed; license metadata.
    const buf = readFileSync(join(open, meta.parquet.path));
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) as ArrayBuffer;
    const md = parquetMetadata(ab);
    assert.deepEqual(md.schema.slice(1).map((c) => c.name), t.columns.map((c) => c.name), `${t.name}.parquet columns`);
    const kv = Object.fromEntries((md.key_value_metadata ?? []).map((x) => [x.key, x.value]));
    assert.equal(kv.license, 'CC-BY-4.0');
    assert.equal(kv.attribution, t.thirdParty ? 'Data from 17Lands (17lands.com)' : 'MTG Deck Tools Agent Bench');
    const objs = await parquetReadObjects({ file: ab });
    assert.equal(objs.length, meta.rows, `${t.name}.parquet rows`);
    // Read back into the schema's types and check them.
    const back: Row[] = objs.map((o) => Object.fromEntries(t.columns.map((c) => {
      const v = o[c.name];
      if (v === null || v === undefined) return [c.name, null];
      if (c.type === 'int') return [c.name, Number(v)];
      if (c.type === 'timestamp') return [c.name, v instanceof Date ? v.getTime() : Number(v)];
      return [c.name, v as Row[string]];
    })));
    assert.deepEqual(checkRows(t, back), [], `${t.name}: rows read back match the schema`);
    // Per-set split.
    assert.ok(existsSync(join(open, 'tables/by-set/FRA', `${t.name}.parquet`)), `${t.name} by set`);
  }

  const read = async (name: string) => {
    const buf = readFileSync(join(open, `tables/${name}.parquet`));
    return (await parquetReadObjects({ file: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) as ArrayBuffer })) as Array<Record<string, any>>;
  };
  const seats = await read('seats');
  assert.equal(seats.length, 8);
  const a = seats.find((s) => s.seat === A)!;
  const b = seats.find((s) => s.seat === B)!;
  assert.equal(a.contributor_handle, 'alicepub', 'a public contributor is named');
  assert.equal(b.contributor_handle, null, 'a hidden contributor is not');
  assert.match(String(a.contributor_key), /^c-[0-9a-f]{12}$/);
  assert.notEqual(a.contributor_key, b.contributor_key);
  assert.equal(a.contributor_via, 'lobby-seat');
  assert.equal(a.model_id, 'claude-haiku-5-5');
  assert.equal(a.effort, 'low');
  assert.equal(a.effort_source, 'declared-explicit');
  assert.equal(a.context_policy, 'fresh-per-game');
  assert.equal(Number(a.output_tokens), 200, 'usage: token counts kept');
  assert.equal(a.cost_usd, 0.0003, "the reported cost, within 35% of the token estimate (F-2)");
  assert.equal(a.cost_basis, 'reported');
  assert.equal(Number(b.input_tokens), 10, 'usage from a usage file');
  assert.equal(Number(a.standing), 1);

  const picks = await read('picks');
  assert.equal(picks.length, 3);
  const p1 = picks.find((p) => p.seat === A && Number(p.pick_number) === 1)!;
  assert.equal(Number(p1.pack_size), 14);
  assert.equal(p1.pack_contents.length, 14, 'pack contents as a JSON list');
  assert.equal(p1.made_main_deck, true);
  assert.match(p1.note, /\[email\]/, 'notes are kept, scrubbed');

  const games = await read('games');
  assert.equal(games.length, 2);
  const g2 = games.find((g) => Number(g.game_index) === 2)!;
  assert.deepEqual([g2.play_draw_by, g2.play_draw_chooser, g2.play_draw_choice, g2.on_play, Number(g2.round)], ['agent', B, 'play', B, 1]);
  assert.deepEqual([g2.seat_a, g2.seat_b, Number(g2.life_a), Number(g2.deck_size_b)], [A, B, 3, 40], 'sides follow the match pairing');
  const sb = await read('sideboarding');
  assert.equal(sb.length, 2);
  const sbB = sb.find((x) => x.seat === B)!;
  assert.equal(sbB.kept, false);
  assert.equal(sbB.cards_in[0].qty, 1);
  const decisions = await read('decisions');
  assert.equal(decisions.length, 3);
  const att = decisions.find((d) => d.kind === 'DeclareAttackers')!;
  assert.deepEqual([Number(att.options_count), att.status, att.structured, att.active_player], [2, 'answered', true, B]);
  assert.deepEqual(att.choice_raw, { attackers: [12] });
  assert.ok(!('text' in att), 'no prompt text in the decisions table');
  const matches = await read('matches');
  assert.deepEqual([matches.length, Number(matches[0]!.wins_a), matches[0]!.winner], [1, 2, A]);
  const events = await read('events');
  assert.deepEqual([events[0]!.sideboarding, events[0]!.early_test_data, events[0]!.provenance, events[0]!.table_kind, events[0]!.pack_regeneration], [true, false, 'hosted', 'lobby', 'verified']);
  assert.deepEqual(events[0]!.integrity_flags, ['anomaly.fast_answers']);
  assert.equal(events[0]!.log_file, `events/${ID}/events.jsonl.gz`);
  const decks = await read('decks');
  assert.deepEqual(decks.find((d) => d.seat === A)!.main.find((c: any) => c.name === 'Plains'), { name: 'Plains', qty: 17 });
  const hr = await read('human_reference');
  assert.ok(hr.length > 0 && hr.every((x) => x.license === 'CC-BY-4.0' && /17Lands/.test(x.source)), 'human reference rows carry the 17Lands credit');
  const cards = await read('cards');
  assert.ok(cards.some((c) => c.card === 'Plains' && c.is_basic === true));

  // The log: full, redacted, hub_handoff gone; decision texts as their own file.
  const log = gunzipSync(readFileSync(join(open, `events/${ID}/events.jsonl.gz`))).toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(!log.some((x) => x.type === 'hub_handoff'));
  assert.equal(log[0].seats[0].contributor_handle, 'alicepub');
  assert.equal(log[0].seats[1].contributor_handle, undefined);
  assert.deepEqual(log[0].table, { kind: 'lobby', queue: 'fra-primer-manual' });
  assert.ok(log.some((x) => x.type === 'decision_offered' && /DECISION G1/.test(x.text)), 'the text agents saw stays in the log');
  const texts = gunzipSync(readFileSync(join(open, `events/${ID}/decision-texts.jsonl.gz`))).toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(texts.map((x) => x.stage).sort(), ['game', 'game', 'game', 'play_draw', 'sideboard']);
  assert.equal(texts.find((x) => x.decision_id === 'G7').game_index, 2);

  // Checksums: SHA256SUMS covers every file and matches.
  const sums = readFileSync(join(open, 'SHA256SUMS'), 'utf8').trim().split('\n');
  for (const line of sums) {
    const [sha, path] = line.split(/\s+/);
    const { createHash } = await import('node:crypto');
    assert.equal(createHash('sha256').update(readFileSync(join(open, path!))).digest('hex'), sha, path);
  }
  // The zip: the card, license, manifest, checksums, tables and logs; no per-set split, no decision texts.
  const zip = readZip(readFileSync(join(open, latest.snapshot.file)));
  const names = zip.map((e) => e.name);
  assert.ok(names.every((n) => n.startsWith('agent-bench-data-2026-10-22/')));
  for (const want of ['DATASET.md', 'LICENSE.md', 'manifest.json', 'SHA256SUMS', 'tables/picks.parquet', 'tables/picks.csv.gz', `events/${ID}/events.jsonl.gz`]) {
    assert.ok(names.includes(`agent-bench-data-2026-10-22/${want}`), `zip has ${want}`);
  }
  assert.ok(!names.some((n) => n.includes('by-set') || n.includes('decision-texts')));
  assert.ok(zip.every((e) => e.crcOk));
  const card = readFileSync(join(open, 'DATASET.md'), 'utf8');
  for (const want of ['Updated nightly', 'CC BY 4.0', 'Creative Commons Attribution 4.0', 'MTG Deck Tools Agent Bench', 'Data from 17Lands', 'not produced or endorsed by 17Lands', 'Early Test Data', 'scripted', 'Self-reported'.toLowerCase(), 'How to cite', 'best of 3 with sideboarding'.replace(/^b/, 'B')]) {
    assert.ok(card.toLowerCase().includes(want.toLowerCase()), `data card mentions ${want}`);
  }
  for (const t of TABLES) for (const c of t.columns) assert.ok(card.includes(`\`${c.name}\``), `data card documents ${t.name}.${c.name}`);
  // No contact address configured (MTGDT_CONTACT_URL unset here): say requests can't be made yet, never a placeholder.
  if (!process.env.MTGDT_CONTACT_URL) {
    assert.ok(!card.includes('CONTACT_URL'), 'no contact placeholder');
    assert.ok(card.includes("Takedown and erasure requests can't be made yet"), 'says takedown and erasure are not available yet');
  }
});

test('privacy: nothing published carries tokens, e-mail, IP addresses, paths, hidden handles, raw ids or transcripts', async () => {
  const { out, build } = setup();
  await build();
  const text = await publishedText(join(out, 'open-data'));
  for (const [what, v] of Object.entries(SECRETS)) assert.ok(!text.includes(v), `${what} (${v}) was published`);
  for (const re of [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/, /\/home\/|\/Users\/|[A-Za-z]:\\\\/, /\b(?:\d{1,3}\.){3}\d{1,3}\b/, /mtgdt_[a-z]+_/, /\b[0-9a-f]{32}\b/]) {
    const m = re.exec(text);
    assert.equal(m, null, `published text matches ${re}: …${m ? text.slice(Math.max(0, m.index - 60), m.index + 60) : ''}…`);
  }
  for (const key of ['"contributor_id"', '"submitter_id"', '"submitter"', '"entry_id"', '"table_id"', '"handle"', '"submission_id"', 'contributor_id,', 'submitter_id']) {
    assert.ok(!text.includes(key), `key ${key} was published`);
  }
  assert.ok(text.includes('alicepub'), 'a public handle is published (sanity check of the scan)');
});

test('incremental: an unchanged event reuses its cached log; a takedown removes it and every snapshot holding it', async () => {
  const { out, ev, build } = setup();
  const first = await build();
  assert.equal(first.logsRebuilt, 1);
  const second = await build([ev], Date.UTC(2026, 9, 23, 7, 30));
  assert.equal(second.logsRebuilt, 0, 'the cached redacted log is reused');
  assert.equal(second.snapshot.path, 'snapshots/agent-bench-data-2026-10-23.zip');
  const latest = JSON.parse(readFileSync(join(out, 'site', 'open', 'latest.json'), 'utf8'));
  assert.equal(latest.earlier_snapshots.length, 1, 'the previous night stays downloadable');
  assert.ok(existsSync(join(out, 'site', 'open', latest.earlier_snapshots[0].file)));
  // Same night again (a rebuild after a privacy change): a new name, never an overwrite.
  const third = await build([ev], Date.UTC(2026, 9, 23, 9, 0));
  assert.equal(third.snapshot.path, 'snapshots/agent-bench-data-2026-10-23-r2.zip');
  assert.equal(readdirSync(join(out, 'open-data', 'builds')).length, 2, 'only the current and previous builds are kept');

  // Takedown: the event leaves the data; every snapshot that held it is deleted; its cached log too.
  const gone = await build([], Date.UTC(2026, 9, 23, 10, 0));
  assert.equal(gone.events, 0);
  assert.equal(gone.snapshotsDeleted.length, 3);
  const after = JSON.parse(readFileSync(join(out, 'site', 'open', 'latest.json'), 'utf8'));
  assert.equal(after.earlier_snapshots.length, 0);
  assert.ok(!existsSync(join(out, 'open-data', 'cache', 'logs', ID)));
  assert.ok(!existsSync(join(out, 'site', 'open', 'events', ID)));
  assert.equal(after.tables.picks.rows, 0);
  const remaining = readdirSync(join(out, 'open-data', 'snapshots')).filter((f) => f.endsWith('.zip'));
  assert.deepEqual(remaining, ['agent-bench-data-2026-10-23-r3.zip']);
  rmSync(join(out, '..'), { recursive: true, force: true });
});

test('retention: newest daily snapshots, the newest of each month, a size cap; privacy first', () => {
  const snap = (date: string, bytes = 10, events = ['e1'], handles: string[] = []): SnapshotRecord => ({ file: `agent-bench-data-${date}.zip`, date, built_at: `${date}T07:30:00Z`, bytes, sha256: 'x', events, handles });
  const days = Array.from({ length: 40 }, (_, k) => new Date(Date.UTC(2026, 8, 1) + k * 86_400_000).toISOString().slice(0, 10));
  const list = days.map((d) => snap(d));
  const r = pruneSnapshots(list, { events: new Set(['e1']), handles: new Set() }, { daily: 7, monthly: 12, maxBytes: 1e9 });
  const kept = r.keep.map((s) => s.date);
  assert.equal(kept[0], days.at(-1));
  assert.ok(kept.includes('2026-09-30'), 'the newest of September');
  assert.equal(kept.length, 8, '7 nightly + the newest of the previous month');
  const capped = pruneSnapshots(list, { events: new Set(['e1']), handles: new Set() }, { daily: 7, monthly: 12, maxBytes: 35 });
  assert.equal(capped.keep.length, 3, 'size cap');
  assert.equal(capped.keep[0]!.date, days.at(-1), 'the newest is always kept');
  const priv = pruneSnapshots([snap('2026-10-01', 10, ['e1', 'e2']), snap('2026-10-02', 10, ['e1'], ['bob']), snap('2026-10-03')], { events: new Set(['e1']), handles: new Set() }, { daily: 7, monthly: 12, maxBytes: 1e9 });
  assert.deepEqual(priv.keep.map((s) => s.date), ['2026-10-03']);
  assert.deepEqual(priv.drop.map((d) => d.why).sort(), ['holds a handle that is no longer public', 'holds e2, no longer published']);
});

test('schedule: 03:30 server time each night (DST-aware), in a low-priority child process', () => {
  const tz = 'America/New_York';
  // 2026-10-22 18:00 UTC = 14:00 EDT: next is 2026-10-23 03:30 EDT = 07:30 UTC.
  assert.equal(new Date(nextRunAt('03:30', tz, Date.UTC(2026, 9, 22, 18, 0))).toISOString(), '2026-10-23T07:30:00.000Z');
  // Before 03:30 local the same day.
  assert.equal(new Date(nextRunAt('03:30', tz, Date.UTC(2026, 9, 22, 6, 0))).toISOString(), '2026-10-22T07:30:00.000Z');
  // After the switch to EST (2026-11-01): 08:30 UTC.
  assert.equal(new Date(nextRunAt('03:30', tz, Date.UTC(2026, 10, 2, 12, 0))).toISOString(), '2026-11-03T08:30:00.000Z');
  assert.equal(new Date(nextRunAt('03:30', 'UTC', Date.UTC(2026, 9, 22, 3, 0))).toISOString(), '2026-10-22T03:30:00.000Z');
  const full = buildCommand(false, () => true);
  assert.equal(full.cmd, '/usr/bin/ionice');
  assert.deepEqual(full.args.slice(0, 4), ['-c3', '/usr/bin/nice', '-n', '19']);
  assert.ok(full.args.some((a) => a.endsWith('open-data/run.ts')));
  const bare = buildCommand(true, () => false);
  assert.equal(bare.reniceChild, true);
  assert.equal(bare.args.at(-1), '--force');
});

test('docs/OPEN-DATA.md documents every table and column, the license and the schedule', () => {
  const doc = readFileSync(join(root, 'docs/OPEN-DATA.md'), 'utf8');
  for (const t of TABLES) {
    assert.ok(doc.includes(`\`${t.name}\``), `table ${t.name}`);
    for (const c of t.columns) assert.ok(doc.includes(`\`${c.name}\``), `${t.name}.${c.name}`);
  }
  for (const want of ['CC BY 4.0', 'MTG Deck Tools Agent Bench', '17Lands', 'latest.json', 'nightly', 'duckdb', 'pandas', 'cite']) assert.ok(doc.toLowerCase().includes(want.toLowerCase()), want);
});
