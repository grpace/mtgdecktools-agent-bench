/**
 * The open data reproduces the leaderboard (docs/OPEN-DATA.md "Reproduce the leaderboard"): from a fixture of rated
 * tables, the published games (rated flag, rating group, identities, on_play_random), boards and rating_pairs let the
 * reference script (scripts/reproduce_leaderboard.py, standard library Python) refit the main board's ratings to
 * within 0.5 Elo, and the snapshot manifest records what it was built from.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { makeContext } from '../../site/src/context.js';
import { CardDb, loadEvent, type EventData } from '../../site/src/data.js';
import { buildOpenData } from '../src/open-data/build.js';
import { readZip } from '../src/open-data/formats.js';

const root = resolve(import.meta.dirname, '../../..');
const SETUPS = [
  { harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high', strength: 0.9 },
  { harness: 'claude-code', model: 'claude-sonnet-5-5', effort: 'high', strength: 0.4 },
  { harness: 'claude-code', model: 'claude-haiku-5-5', effort: 'high', strength: 0 },
  { harness: 'claude-code', model: 'claude-haiku-5-5', effort: 'low', strength: -0.5 },
];

/** A deterministic LCG, so the fixture's results never change. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

/** One finished table: 8 seats (two of each setup), every pair of seats plays one best-of-3 match in a round robin. */
function writeEvent(dir: string, id: string, seed: number): void {
  mkdirSync(dir, { recursive: true });
  const rnd = lcg(seed);
  const seats = SETUPS.flatMap((s, i) => [0, 1].map((k) => ({ name: `seat-${i}${k}${seed.toString(16).padStart(4, '0')}`, ...s })));
  const recs: Array<Record<string, unknown>> = [{
    type: 'event_start', id, set: { code: 'FRA', name: 'Reality Fracture' }, seed: `fra-${seed}`, best_of: 3, sideboarding: true, play_draw: 'loser-chooses',
    mana: 'manual', prompt_version: 'v6', prompt_sha256: 'e'.repeat(64), knowledge: { level: 'primer' }, pairing: { format: 'swiss', rounds: 3, version: 2 },
    seats: seats.map((s, k) => ({ name: s.name, kind: 'agent', position: k, harness: s.harness, model: s.model, effort: s.effort, effort_basis: 'launch' })),
  }];
  for (let i = 0; i < seats.length; i++) {
    for (let j = i + 1; j < seats.length; j++) {
      const [A, B] = [seats[i]!, seats[j]!];
      const M = `${A.name} vs ${B.name}`;
      const wins: Record<string, number> = { [A.name]: 0, [B.name]: 0 };
      let onPlay = rnd() < 0.5 ? A.name : B.name;
      for (let g = 1; g <= 3 && wins[A.name]! < 2 && wins[B.name]! < 2; g++) {
        const pA = 1 / (1 + Math.exp(-(A.strength - B.strength + (onPlay === A.name ? 0.2 : -0.2))));
        const winner = rnd() < pA ? A.name : B.name;
        const game = `${M} — game ${g}`;
        recs.push({ type: 'play_draw', match: M, game_number: g, on_play: onPlay, by: g === 1 ? 'seed' : 'agent', chooser: g === 1 ? null : onPlay, choice: g === 1 ? null : 'play' });
        recs.push({ type: 'game_start', game, match: M, game_number: g, seats: onPlay === A.name ? [A.name, B.name] : [B.name, A.name] });
        recs.push({ type: 'game_over', game, match: M, game_number: g, winner, turns: 9, on_play: onPlay });
        wins[winner]!++;
        onPlay = winner === A.name ? B.name : A.name; // the loser chooses play
      }
      recs.push({ type: 'match_end', a: A.name, b: B.name, wins });
    }
  }
  recs.push({ type: 'event_end', standings: [] });
  const t0 = Date.UTC(2026, 9, 22, 12, 0, 0) + seed * 1000;
  writeFileSync(join(dir, 'events.jsonl'), recs.map((r, k) => JSON.stringify({ t: t0 + k, ...r })).join('\n') + '\n');
  writeFileSync(join(dir, 'source.json'), JSON.stringify({ label: 'verified' }));
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({ standings: [] }));
}

test('the reference script refits the main board from the published tables to within 0.5 Elo', async () => {
  const base = mkdtempSync(join(tmpdir(), 'open-data-refit-'));
  const evs: EventData[] = [];
  for (const [k, seed] of [11, 22, 33].entries()) {
    const id = `2026-10-22-1${k}-00-00-fra-${seed.toString(16).padStart(4, '0')}`;
    const dir = join(base, 'runs', id);
    writeEvent(dir, id, seed);
    evs.push(loadEvent(dir, Date.now())!);
  }
  const out = join(base, 'hub');
  await buildOpenData({
    root: join(out, 'open-data'), siteLink: join(out, 'site', 'open'), methodology: null, url: 'https://hub.example/data/open', fingerprint: 'test', now: Date.UTC(2026, 9, 23, 7, 30),
    ctx: makeContext({ events: evs, cards: new CardDb(undefined), setsDir: join(root, 'sets'), replicates: 50, mainPrompts: [`sha256:${'e'.repeat(12)}`] }),
  });
  const open = join(out, 'site', 'open');
  const csv = (name: string) => gunzipSync(readFileSync(join(open, 'tables', `${name}.csv.gz`))).toString('utf8').trimEnd().split('\r\n');
  // A small RFC 4180 reader (JSON columns hold commas and quotes).
  const parse = (line: string): string[] => {
    const out: string[] = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (q) {
        if (c === '"' && line[i + 1] === '"') (cur += '"', i++);
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') (out.push(cur), cur = '');
      else cur += c;
    }
    out.push(cur);
    return out;
  };
  const games = csv('games');
  const header = parse(games[0]!);
  const col = (row: string, name: string) => parse(row)[header.indexOf(name)];
  const rated = games.slice(1).filter((r) => col(r, 'rated') === 'true');
  const mirrors = games.slice(1).filter((r) => col(r, 'unrated_reason') === 'mirror (same setup on both sides)');
  assert.ok(rated.length > 100, `rated games: ${rated.length}`);
  assert.ok(mirrors.length > 0, 'mirror games are published, marked unrated with the reason');
  assert.ok(csv('rating_pairs').length > 1, 'rating_pairs has the difference intervals');
  assert.match(csv('boards')[0]!, /^board_id,group_key,set_code,/);

  const res = execFileSync('python3', ['-I', join(root, 'scripts', 'reproduce_leaderboard.py'), '--data', open, '--compare'], { encoding: 'utf8' });
  const r = JSON.parse(res);
  assert.equal(r.ok, true, res);
  assert.equal(r.games, r.published_games);
  assert.ok(r.max_abs_diff_elo <= 0.5, `max difference ${r.max_abs_diff_elo} Elo`);
  assert.equal(Object.keys(r.ratings).length, 4);

  // The snapshot says what it was built from, and carries the script.
  const latest = JSON.parse(readFileSync(join(open, 'latest.json'), 'utf8'));
  const zip = readZip(readFileSync(join(open, latest.snapshot.file)));
  const manifest = JSON.parse(zip.find((e) => e.name.endsWith('/manifest.json'))!.data.toString('utf8'));
  for (const k of ['code_commit', 'registry_version', 'registry_sha256', 'methodology_sha256', 'prompt_sha256', 'card_data_sha256', 'rating']) assert.ok(k in manifest.reproducibility, k);
  assert.deepEqual(manifest.reproducibility.prompt_sha256, ['e'.repeat(64)]);
  assert.equal(manifest.reproducibility.rating.play_term, 'game 1 of each match only');
  assert.deepEqual(latest.reproducibility, manifest.reproducibility);
  assert.ok(zip.some((e) => e.name.endsWith('/reproduce_leaderboard.py')), 'the script ships in the snapshot');
});
