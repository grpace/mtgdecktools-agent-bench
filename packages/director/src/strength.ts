/**
 * Deck strength (bot duels): score every agent seat's submitted deck, and the reference
 * auto-built deck from the same pool, by win rate against a fixed gauntlet. LLM-free.
 *
 *   npx tsx packages/director/src/strength.ts --run runs/<event-id> [--games 24] [--gauntlet bots|a.txt,b.txt]
 *     [--difficulty Medium] [--pilots alternate|ai] [--concurrency 6] [--phase ws://127.0.0.1:9374/ws]
 *
 * Appends one `deck_strength` record per (seat, deck) to the event's events.jsonl and writes
 * runs/<id>/strength.json (settings, gauntlet decks, every game). See docs/METRICS.md §3.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { PackCard } from './boosters.js';
import { BoosterFactory } from './boosters.js';
import { BotGame, DeckSide, playBotGame, runPool } from './botduel.js';
import { autoBuild } from './build.js';
import { CardDb } from './cards.js';
import { AiDifficulty, DeckData, parseDeckList } from './phase.js';
import { Ratings } from './ratings.js';

const METHOD = 'botduel-v1';
const root = resolve(import.meta.dirname, '../../..');
const env = process.env;
const { values } = parseArgs({
  options: {
    run: { type: 'string' },
    games: { type: 'string', default: '24' },
    gauntlet: { type: 'string', default: 'bots' },
    difficulty: { type: 'string', default: 'Medium' },
    pilots: { type: 'string', default: 'alternate' },
    concurrency: { type: 'string', default: '6' },
    'game-timeout': { type: 'string', default: '600' },
    phase: { type: 'string', default: env.PHASE_SERVER_URL ?? 'ws://127.0.0.1:9374/ws' },
    data: { type: 'string', default: env.DATA_DIR ?? resolve(root, 'data') },
    cache: { type: 'string', default: env.CACHE_DIR },
    sets: { type: 'string', default: resolve(root, 'sets') },
    'dry-run': { type: 'boolean', default: false },
  },
});
if (!values.run) {
  console.error('usage: strength.ts --run runs/<event-id> [--games 24] [--gauntlet bots|deck1.txt,deck2.txt] [--difficulty Medium] [--pilots alternate|ai] [--concurrency 6]');
  process.exit(2);
}

interface Subject {
  seat: string;
  deck: 'submitted' | 'reference';
  data: DeckData;
  /** Reused results: the agent delegated deckbuilding, so submitted == reference. */
  sameAs?: Subject;
}

const runDir = resolve(values.run);
const eventsPath = join(runDir, 'events.jsonl');
const events = readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const start = events.find((e) => e.type === 'event_start');
if (!start) throw new Error(`${eventsPath}: no event_start record`);
const set: string = start.set.code;
const seats: Array<{ name: string; kind: 'agent' | 'bot' }> = start.seats;

// Pools from the draft log (pick order, as the Draft built them), decks from deck_built.
const cacheDir = values.cache ?? values.data!;
const cards = new CardDb(join(values.data!, 'card-data.json'), cacheDir);
const index = new BoosterFactory(join(values.data!, 'draft-pools.json'), []).cardIndex(set);
const ratings = new Ratings(values.sets!, set);
const unknown = new Set<string>();
const toPackCard = (name: string): PackCard => {
  const c = index.get(name.toLowerCase());
  if (c) return c;
  unknown.add(name);
  return { name, rarity: 'common', colors: [], cmc: 0, typeLine: cards.get(name)?.typeLine ?? '' };
};
const pools = new Map<string, PackCard[]>(seats.map((s) => [s.name, []]));
const built = new Map<string, { by: string; main: string[]; sideboard: string[] }>();
for (const e of events) {
  if (e.type === 'draft_pick') pools.get(e.seat)?.push(toPackCard(e.pick));
  if (e.type === 'deck_built') built.set(e.seat, { by: e.by, main: e.main, sideboard: e.sideboard ?? [] });
}
if (unknown.size) console.warn(`warning: ${unknown.size} picked card(s) not on ${set} booster sheets (colors unknown to the reference builder): ${[...unknown].join(', ')}`);

// Gauntlet: the bot seats' reference decks (default) or deck-list files.
const gauntlet: Array<{ name: string; data: DeckData }> = values.gauntlet === 'bots'
  ? seats.filter((s) => s.kind === 'bot').map((s) => ({ name: s.name, data: autoBuild(pools.get(s.name)!, ratings, cards).deck }))
  : values.gauntlet!.split(',').map((f) => ({ name: basename(f).replace(/\.txt$/, ''), data: parseDeckList(readFileSync(f, 'utf8')) }));
if (!gauntlet.length) throw new Error('empty gauntlet');

const subjects: Subject[] = [];
for (const s of seats.filter((x) => x.kind === 'agent')) {
  const pool = pools.get(s.name)!;
  const reference: Subject = { seat: s.name, deck: 'reference', data: autoBuild(pool, ratings, cards).deck };
  const b = built.get(s.name);
  if (!b) {
    console.warn(`warning: ${s.name} has no deck_built record; scoring the reference deck only`);
    subjects.push(reference);
    continue;
  }
  const submitted: Subject = { seat: s.name, deck: 'submitted', data: { main_deck: b.main, sideboard: b.sideboard } };
  const same = [...b.main].sort().join('|') === [...reference.data.main_deck].sort().join('|');
  if (same) submitted.sameAs = reference;
  subjects.push(submitted, reference);
}

// Games per subject: consecutive pairs against the same gauntlet deck with the pilots swapped,
// cycling through the gauntlet. A multiple of 2 × gauntlet size gives every opponent equal weight.
const n = Number(values.games);
const pilots = values.pilots === 'ai' ? 'ai' : 'alternate';
interface Job { subject: Subject; opponent: number; aiDeck: DeckSide }
const jobs: Job[] = [];
for (const subject of subjects.filter((x) => !x.sameAs)) {
  for (let g = 0; g < n; g++) {
    jobs.push({
      subject,
      opponent: (pilots === 'ai' ? g : Math.floor(g / 2)) % gauntlet.length,
      aiDeck: pilots === 'ai' || g % 2 === 0 ? 'A' : 'B',
    });
  }
}

const engine = JSON.parse(readFileSync(join(root, 'engine/phase.lock.json'), 'utf8'));
console.log(`${basename(runDir)} (${set}): ${subjects.length} decks × ${n} games vs ${gauntlet.length}-deck gauntlet (${values.gauntlet}), phase-ai ${values.difficulty}, pilots ${pilots}, ${jobs.length} games, concurrency ${values.concurrency}`);
if (values['dry-run']) process.exit(0);

const t0 = Date.now();
let done = 0;
const results = await runPool(jobs.length, Number(values.concurrency), async (i) => {
  const job = jobs[i]!;
  const g = await playBotGame(values.phase!, job.subject.data, gauntlet[job.opponent]!.data, job.aiDeck, {
    difficulty: values.difficulty as AiDifficulty, cards, gameTimeoutMs: Number(values['game-timeout']) * 1000,
  });
  done++;
  if (done % 10 === 0 || done === jobs.length) console.log(`  ${done}/${jobs.length} games (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  return { job, g };
});

/** Wilson score interval; draws count as half a win. */
function wilson(wins: number, total: number): [number, number] {
  if (!total) return [0, 1];
  const z = 1.96;
  const p = wins / total;
  const den = 1 + (z * z) / total;
  const mid = (p + (z * z) / (2 * total)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / den;
  return [round(Math.max(0, mid - half)), round(Math.min(1, mid + half))];
}
const round = (x: number) => Math.round(x * 1000) / 1000;

function score(games: BotGame[]) {
  const finished = games.filter((g) => g.end === 'game_over');
  const wins = finished.filter((g) => g.winner === 'A').length;
  const draws = finished.filter((g) => g.winner === null).length;
  const points = wins + draws / 2;
  return {
    games: finished.length, wins, losses: finished.length - wins - draws, draws, unfinished: games.length - finished.length,
    win_rate: finished.length ? round(points / finished.length) : null, ci95: wilson(points, finished.length),
  };
}

const records = subjects.map((subject) => {
  const source = subject.sameAs ?? subject;
  const mine = results.filter((r) => r.job.subject === source);
  const s = score(mine.map((r) => r.g));
  const byPilot = Object.fromEntries((['A', 'B'] as const).map((side) => {
    const x = score(mine.filter((r) => r.g.aiDeck === side).map((r) => r.g));
    return [side === 'A' ? 'phase_ai' : 'sparring', { games: x.games, wins: x.wins, win_rate: x.win_rate }];
  }));
  return {
    seat: subject.seat, deck: subject.deck, ...s, by_pilot: byPilot,
    ...(subject.sameAs ? { same_as: 'reference' } : {}),
    main: subject.data.main_deck,
  };
});
for (const r of records.filter((x) => x.deck === 'submitted')) {
  const ref = records.find((x) => x.seat === r.seat && x.deck === 'reference');
  if (ref?.win_rate != null && r.win_rate != null) (r as any).build_delta = round(r.win_rate - ref.win_rate);
}

const settings = {
  method: METHOD, games_per_deck: n, gauntlet: values.gauntlet, gauntlet_decks: gauntlet.map((g) => g.name),
  difficulty: values.difficulty, pilots, engine: { build_commit: engine.build_commit, protocol_version: engine.protocol_version },
  ratings: ratings.source,
};
for (const r of records) {
  const { main, ...rest } = r;
  appendFileSync(eventsPath, JSON.stringify({ t: Date.now(), type: 'deck_strength', ...rest, ...settings }) + '\n');
}
const elapsed = (Date.now() - t0) / 1000;
writeFileSync(join(runDir, 'strength.json'), JSON.stringify({
  event: basename(runDir), set, ...settings, elapsed_s: Math.round(elapsed),
  gauntlet_decks: gauntlet.map((g) => ({ name: g.name, main: g.data.main_deck })),
  results: records,
  games: results.map(({ job, g }) => ({ seat: job.subject.seat, deck: job.subject.deck, opponent: gauntlet[job.opponent]!.name, ...g })),
}, null, 1));

const fin = results.filter((r) => r.g.end === 'game_over');
console.log(`\n${results.length} games in ${elapsed.toFixed(0)} s (${(elapsed / results.length).toFixed(1)} s/game wall, ${(fin.reduce((t, r) => t + r.g.ms, 0) / Math.max(1, fin.length) / 1000).toFixed(1)} s/game each); ${results.length - fin.length} unfinished`);
for (const r of records) {
  const ci = `[${r.ci95.map((x) => (x * 100).toFixed(0)).join('–')}]`;
  const delta = (r as any).build_delta != null ? `  build delta ${((r as any).build_delta * 100).toFixed(0)} pts` : '';
  console.log(`  ${r.seat.padEnd(12)} ${r.deck.padEnd(9)} ${r.win_rate == null ? 'n/a' : `${(r.win_rate * 100).toFixed(0)}%`} ${ci} (${r.wins}-${r.losses}${r.draws ? `-${r.draws}` : ''}${r.unfinished ? `, ${r.unfinished} unfinished` : ''})${r.same_as ? ' (= reference)' : ''}${delta}`);
}
console.log(`\nwrote ${join(runDir, 'strength.json')} and ${records.length} deck_strength records to events.jsonl`);
process.exit(0);
