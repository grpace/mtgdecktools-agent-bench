/**
 * Best of 3 between games (sideboard.ts): sideboarding validation and copy counts (the deckbuilding rules), keep and
 * forfeit, the swaps logged, who chooses play or draw, game 1 from the seed, hidden information in the decision text
 * and in the spectator stream, the starting player read from a new game, and resuming from the log.
 *   npx tsx packages/director/src/sideboard.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PackCard } from './boosters.js';
import { CardDb } from './cards.js';
import { resumeLog, type Raw } from './durable.js';
import { Event } from './event.js';
import { Game } from './game.js';
import { AgentSeat } from './seat.js';
import {
  askPlayDraw, askSideboard, deckData, deckFromSideboardLog, deckOf, nextChooser, seededStarter, sideboardText, swapLine, swaps, type MatchDeck, type SideboardContext,
} from './sideboard.js';
import { Spectator } from './spectate.js';
import { DEFAULT_SPECTATE_POLICY } from './spectate-policy.js';

let passed = 0;
const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

// --- a tiny card database ------------------------------------------------------------------------------------------
const cost = (generic: number, ...shards: string[]) => ({ type: 'Cost', generic, shards });
const type = (core: string[], sub: string[] = [], sup: string[] = []) => ({ supertypes: sup, core_types: core, subtypes: sub });
const creature = (name: string, c: object, text = '') => ({ name, mana_cost: c, card_type: type(['Creature'], ['Bear']), power: { type: 'Fixed', value: 2 }, toughness: { type: 'Fixed', value: 2 }, oracle_text: text, keywords: [], layout: 'normal' });
const spell = (name: string, c: object, text: string) => ({ name, mana_cost: c, card_type: type(['Instant']), oracle_text: text, keywords: [], layout: 'normal' });
const basic = (name: string, sub: string, sym: string) => ({ name, mana_cost: { type: 'NoCost' }, card_type: type(['Land'], [sub], ['Basic']), oracle_text: `({T}: Add {${sym}}.)`, keywords: [], layout: 'normal' });
const raw: Record<string, any> = {
  'grizzly bears': creature('Grizzly Bears', cost(1, 'Green')),
  'river scout': creature('River Scout', cost(1, 'Blue')),
  'sky knight': creature('Sky Knight', cost(2, 'White'), 'Flying'),
  'shock': spell('Shock', cost(0, 'Red'), 'Shock deals 2 damage to any target.'),
  'plummet': spell('Plummet', cost(1, 'Green'), 'Destroy target creature with flying.'),
  'secret bomb': creature('Secret Bomb', cost(5, 'Black'), 'When this enters, each opponent loses 5 life.'),
  'forest': basic('Forest', 'Forest', 'G'),
  'mountain': basic('Mountain', 'Mountain', 'R'),
  'island': basic('Island', 'Island', 'U'),
};
const dir = mkdtempSync(join(tmpdir(), 'mtgdt-sideboard-'));
writeFileSync(join(dir, 'card-data.json'), JSON.stringify(raw));
const cards = new CardDb(join(dir, 'card-data.json'), dir);

const pc = (name: string, colors: string[], cmc: number, typeLine: string): PackCard => ({ name, rarity: 'common', colors, cmc, typeLine });
const BEARS = pc('Grizzly Bears', ['G'], 2, 'Creature — Bear');
const SHOCK = pc('Shock', ['R'], 1, 'Instant');
const SCOUT = pc('River Scout', ['U'], 2, 'Creature — Bear');
const PLUMMET = pc('Plummet', ['G'], 2, 'Instant');
const FOREST = pc('Forest', [], 0, 'Basic Land — Forest');
// Pool numbers: 1–10 Grizzly Bears, 11–16 Shock, 17–20 River Scout, 21–22 Plummet, 23 a drafted Forest.
const pool: PackCard[] = [
  ...Array.from({ length: 10 }, () => ({ ...BEARS })), ...Array.from({ length: 6 }, () => ({ ...SHOCK })),
  ...Array.from({ length: 4 }, () => ({ ...SCOUT })), { ...PLUMMET }, { ...PLUMMET }, { ...FOREST },
];
const idx = (...nums: number[]) => nums.map((n) => n - 1);
/** The registered deck: 10 Bears, 6 Shock and 24 basics (40); sideboard: 4 River Scout, 2 Plummet, the drafted Forest. */
const registered: MatchDeck = { main: idx(...Array.from({ length: 16 }, (_, i) => i + 1)), basics: { Forest: 12, Mountain: 12 } };

const ctx = (over: Partial<SideboardContext> = {}): SideboardContext => ({
  game: 2, roundLabel: 'Round 1 of 3', score: { me: 0, them: 1 }, results: [{ game: 1, result: 'lost', turns: 9 }],
  onPlay: 'you', chose: 'you', opponentSeen: { 'Sky Knight': 2, Island: 7 }, opponentDeck: 40, opponentSideboard: 5, setContext: true, ...over,
});

function harness() {
  const records: Raw[] = [];
  const log = (type: string, data: Record<string, unknown>) => records.push({ t: Date.now(), type, ...data });
  const seat = new AgentSeat('seat-a', 0);
  return { records, log, seat };
}
const meta = { match: 'seat-a vs seat-b', game_number: 2 };

// --- sideboarding ----------------------------------------------------------------------------------------------------

test('the decision shows the deck and sideboard as card JSON, the match memory, and the current deck as an answer', () => {
  const t = sideboardText('S7', pool, registered, cards, ctx());
  assert.match(t, /^SIDEBOARDING — game 2 of your best-of-3 match \(Round 1 of 3\) is next\. Score: you 0–1 opponent \(game 1: you lost on turn 9\)\. In game 2 you play first \(you chose to play\)\./);
  assert.match(t, /YOUR DECK \(as in game 1\): 40 cards, 16 from your pool \+ 24 basic lands \{"Forest":12,"Mountain":12\}/);
  // Card JSON as at deckbuilding: "n", "count" (copies in that list) and every copy's pool number.
  const deckPart = t.split('YOUR SIDEBOARD')[0]!;
  const bears = JSON.parse(deckPart.split('\n').find((l) => l.includes('"Grizzly Bears"'))!);
  assert.equal(bears.count, 10);
  assert.deepEqual(bears.poolNumbers, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const sidePart = t.split('YOUR SIDEBOARD')[1]!.split('\n\n')[0]!;
  assert.match(sidePart, /^: 6 cards \(drafted basic lands aren't listed/);
  const plummet = JSON.parse(sidePart.split('\n').find((l) => l.includes('"Plummet"'))!);
  assert.deepEqual([plummet.n, plummet.count, plummet.text], [21, 2, 'Destroy target creature with flying.']);
  assert.ok(!sidePart.includes('"Forest"'), 'drafted basics are not listed');
  // Match memory: what this seat saw, with printed data (basic lands by name only), and the public sizes.
  assert.match(t, /\{"seen":2,"name":"Sky Knight",.*"text":"Flying"\}/);
  assert.match(t, /\{"seen":7,"name":"Island"\}/);
  assert.match(t, /The opponent's deck: 40 cards; their sideboard: 5 cards \(before their sideboarding\)\./);
  assert.match(t, /Your current deck as an answer: cards=\[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16\], basics=\{"Forest":12,"Mountain":12\}\./);
});

test('hidden information: the text names no opponent card it was not shown (only the match memory and sizes)', () => {
  const t = sideboardText('S7', pool, registered, cards, ctx({ opponentSeen: { 'Sky Knight': 1 } }));
  assert.ok(!t.includes('Secret Bomb'));
  const none = sideboardText('S7', pool, registered, cards, ctx({ opponentSeen: {} }));
  assert.match(none, /THE OPPONENT'S CARDS YOU SAW THIS MATCH: none\./);
});

test('validation and copy counts are the deckbuilding rules: pool numbers, copies drafted, basics, at least 40', async () => {
  const { records, log, seat } = harness();
  const done = askSideboard(seat, pool, registered, cards, ctx(), log, meta);
  const id = seat.pending!.id;
  assert.match(id, /^S\d+$/);
  const all16 = Array.from({ length: 16 }, (_, i) => i + 1);
  // Three Plummets: only two were drafted.
  let r = await seat.decide({ decision_id: id, cards: [...all16.slice(0, 13), 21, 21, 21], basics: { Forest: 12, Mountain: 12 } });
  assert.match(r, /^Not accepted: You drafted 2 copies of Plummet \(pool numbers 21, 22\); your deck asks for 3\. Play at most 2\./);
  // A number outside the pool, and an unknown basic.
  r = await seat.decide({ decision_id: id, cards: [...all16, 99], basics: { Forest: 12, Wastes: 12 } });
  assert.match(r, /Pool numbers run from 1 to 23; 99 is not in your pool/);
  assert.match(r, /"Wastes" is not a basic land you can add/);
  // 39 cards.
  r = await seat.decide({ decision_id: id, cards: all16.slice(0, 15), basics: { Forest: 12, Mountain: 12 } });
  assert.match(r, /has 39 cards .*needs at least 40/);
  // Keep with a deck: a conflict, nothing applied; another option: refused.
  r = await seat.decide({ decision_id: id, option: 'keep', cards: all16, basics: { Forest: 12 } });
  assert.match(r, /option "keep" keeps your deck as it is, but you also sent a deck/);
  r = await seat.decide({ decision_id: id, option: 'auto' });
  assert.match(r, /takes option "keep", or your whole deck/);
  // Game-only fields are refused.
  r = await seat.decide({ decision_id: id, attackers: [3] });
  assert.match(r, /Sideboarding doesn't take `attackers`/);
  assert.equal(records.filter((x) => x.type === 'sideboarded').length, 0);
  // Valid: two Shocks out for two Plummets (repeating 21 takes the other copy, 22), one Mountain for a Forest.
  r = await seat.decide({ decision_id: id, cards: [...all16.slice(0, 14), 21, 21], basics: { Forest: 13, Mountain: 11 } });
  assert.match(r, /^Deck for game 2: \+1 Forest, \+2 Plummet, −1 Mountain, −2 Shock\. 40 cards, 24 lands\./);
  const res = await done;
  assert.equal(res.kept, false);
  assert.deepEqual(res.deck.main.slice(-2), [20, 21]);
  const rec = records.find((x) => x.type === 'sideboarded')!;
  assert.deepEqual(rec.in, [{ name: 'Forest', qty: 1 }, { name: 'Plummet', qty: 2 }]);
  assert.deepEqual(rec.out, [{ name: 'Mountain', qty: 1 }, { name: 'Shock', qty: 2 }]);
  assert.equal(rec.main_count, 40);
  assert.equal(rec.by, 'agent');
  assert.equal(rec.rejected.length, 6);
  // Main + sideboard is the pool plus basics, exactly.
  const pooled = [...rec.main, ...rec.sideboard].filter((n: string) => !['Forest', 'Mountain'].includes(n)).sort();
  assert.deepEqual(pooled, pool.filter((c) => c.name !== 'Forest').map((c) => c.name).sort());
  assert.ok(rec.sideboard.includes('Forest'), 'the drafted Forest stays in the sideboard');
  assert.ok(records.some((x) => x.type === 'sideboard_offered' && x.id === id && x.game_number === 2));
});

test('a deck above 40 is legal, and a land swap that leaves a card uncastable is noted', async () => {
  const { records, log, seat } = harness();
  const done = askSideboard(seat, pool, registered, cards, ctx(), log, meta);
  const all16 = Array.from({ length: 16 }, (_, i) => i + 1);
  const r = await seat.decide({ decision_id: seat.pending!.id, cards: [...all16, 17], basics: { Forest: 24 } });
  assert.match(r, /\+12 Forest, \+1 River Scout, −12 Mountain\. 41 cards, 24 lands\. Note: Can't be cast: Shock needs \{R\}.* Can't be cast: River Scout needs \{U\}/);
  await done;
  assert.equal(records.find((x) => x.type === 'sideboarded')!.main_count, 41);
});

test('"keep" keeps the deck; the watchdog\'s forfeit keeps it too, logged by forfeit', async () => {
  let h = harness();
  let done = askSideboard(h.seat, pool, registered, cards, ctx(), h.log, meta);
  assert.match(await h.seat.decide({ decision_id: h.seat.pending!.id, option: 'keep' }), /^Deck kept for game 2: 40 cards\./);
  let res = await done;
  assert.deepEqual([res.kept, res.deck], [true, registered]);
  let rec = h.records.find((x) => x.type === 'sideboarded')!;
  assert.deepEqual([rec.kept, rec.in, rec.out, rec.by, 'note' in rec], [true, [], [], 'agent', false]);
  h = harness();
  done = askSideboard(h.seat, pool, registered, cards, ctx(), h.log, meta);
  const details = h.seat.pending!.forfeit!();
  assert.deepEqual(details, { kept: true, game_number: 2 });
  assert.equal(h.seat.pending, undefined);
  res = await done;
  rec = h.records.find((x) => x.type === 'sideboarded')!;
  assert.deepEqual([res.kept, rec.by, rec.kept], [true, 'forfeit', true]);
});

test('drafted basics in a built deck become basics; a logged deck reads back the same', () => {
  // The reference builder or a logged deck may hold the drafted Forest (pool number 23) as a main deck card.
  const d = deckOf({ mainCards: [pool[0]!, pool[22]!, pool[10]!], basics: { Forest: 2 } }, pool);
  assert.deepEqual(d, { main: [0, 10], basics: { Forest: 3 } });
  const data = deckData(registered, pool);
  assert.equal(data.main_deck.length, 40);
  assert.deepEqual(deckFromSideboardLog({ main: data.main_deck }, pool), registered);
});

test('swaps: by name with copies, basics included; the line shown in replays', () => {
  const s = swaps(['A', 'A', 'B', 'Island'], ['A', 'C', 'C', 'Island', 'Island']);
  assert.deepEqual(s, { in: [{ name: 'C', qty: 2 }, { name: 'Island', qty: 1 }], out: [{ name: 'A', qty: 1 }, { name: 'B', qty: 1 }] });
  assert.equal(swapLine(s), '+2 C, +1 Island, −1 A, −1 B');
  assert.equal(swapLine(swaps(['A'], ['A'])), 'kept the deck');
});

// --- play or draw ----------------------------------------------------------------------------------------------------

test('the loser of the previous game chooses; after a draw the previous chooser (game 1: the seat on the play)', () => {
  assert.equal(nextChooser({ winner: 'a', chooser: null, onPlay: 'a' }, 'a', 'b'), 'b');
  assert.equal(nextChooser({ winner: 'b', chooser: 'a', onPlay: 'b' }, 'a', 'b'), 'a');
  assert.equal(nextChooser({ winner: null, chooser: 'b', onPlay: 'a' }, 'a', 'b'), 'b');
  assert.equal(nextChooser({ winner: null, chooser: null, onPlay: 'a' }, 'a', 'b'), 'a');
});

test('game 1: who plays first comes from the seed (the same every time, both seats across seeds)', () => {
  assert.equal(seededStarter('s1', 'a vs b', 'a', 'b'), seededStarter('s1', 'a vs b', 'a', 'b'));
  const firsts = new Set(Array.from({ length: 40 }, (_, i) => seededStarter(`seed-${i}`, 'a vs b', 'a', 'b')));
  assert.deepEqual([...firsts].sort(), ['a', 'b']);
});

test('the play-or-draw decision takes "play" or "draw" only; the watchdog plays first', async () => {
  const h = harness();
  const pctx = { game: 2, roundLabel: 'Round 2 of 3', score: { me: 0, them: 1 }, reason: 'lost' as const };
  let done = askPlayDraw(h.seat, pctx, h.log, meta);
  const o = h.seat.pending!;
  assert.match(o.id, /^P\d+$/);
  assert.match(o.text, /^PLAY OR DRAW — your best-of-3 match \(Round 2 of 3\), score: you 0–1 opponent\. You lost game 1, so you choose who plays first in game 2\./);
  assert.match(await h.seat.decide({ decision_id: o.id, option: 'first' }), /answer with option "play"/);
  assert.match(await h.seat.decide({ decision_id: o.id, option: 'draw', cards: [1] }), /doesn't take `cards`/);
  assert.match(await h.seat.decide({ decision_id: o.id, option: 'draw' }), /^Your opponent plays first in game 2; you draw\./);
  assert.deepEqual(await done, { choice: 'draw', by: 'agent', latency_ms: (await done).latency_ms });
  assert.ok(h.records.some((x) => x.type === 'play_draw_offered' && x.id === o.id));
  const h2 = harness();
  done = askPlayDraw(h2.seat, pctx, h2.log, meta);
  h2.seat.pending!.forfeit!();
  assert.equal((await done).choice, 'play');
});

test('a game whose first state names the other player is replayed: the starting seat read from held updates', () => {
  const a = new AgentSeat('seat-a', 0);
  const b = new AgentSeat('seat-b', 1);
  const g = new Game('ws://127.0.0.1:1/ws', cards, [a, b], [deckData(registered, pool), deckData(registered, pool)], () => {}, 'seat-a vs seat-b — game 2', 'manual', {}, undefined, { starter: 'seat-b' });
  const players = (g as any).players as any[];
  const upd = (p: number) => ({ revision: 2, state: { turn_number: 1, active_player: p, current_starting_player: p }, legal: [], logEntries: [], byObject: {} });
  (g as any).held = new Map([[players[0], [upd(1)]], [players[1], [upd(1)]]]);
  assert.equal((g as any).startingSeat(), 'seat-b');
  (g as any).held = new Map([[players[0], [upd(0)]], [players[1], []]]);
  assert.equal((g as any).startingSeat(), 'seat-a');
  // While held, nothing reaches a seat.
  (g as any).onUpdate(players[0], { ...upd(0), legal: [{ type: 'PassPriority' }, { type: 'Concede' }] });
  assert.equal(a.pending, undefined);
});

// --- the spectator stream ----------------------------------------------------------------------------------------------

test('spectators: "sideboarded" with the deck size after the delay; what went in and out only once the seat is done', () => {
  let now = 1_000_000;
  const sp = new Spectator('ev', { ...DEFAULT_SPECTATE_POLICY, delayMs: 90_000 }, () => now);
  const seats = [{ name: 'seat-a', kind: 'agent', position: 0 }, { name: 'seat-b', kind: 'agent', position: 1 }];
  sp.ingest({ t: now, type: 'event_start', seats, pairing: { rounds: 1 } });
  sp.ingest({ t: now, type: 'draft_end' });
  sp.ingest({ t: now, type: 'build_end' });
  sp.ingest({ t: now, type: 'round_start', round: 1, pairs: [['seat-a', 'seat-b']], byes: [] });
  sp.ingest({ t: now, type: 'play_draw', match: 'seat-a vs seat-b', game_number: 2, on_play: 'seat-a', by: 'agent', chooser: 'seat-a', choice: 'play', note: 'my curve is low' });
  sp.ingest({ t: now, type: 'sideboarded', seat: 'seat-a', match: 'seat-a vs seat-b', game_number: 2, by: 'agent', kept: false, in: [{ name: 'Plummet', qty: 2 }], out: [{ name: 'Shock', qty: 2 }], main: [], sideboard: [], main_count: 40, note: 'Plummet for their fliers' });
  const msgs = () => sp.since(0).messages;
  assert.ok(!msgs().some((m) => m.type === 'sideboarded' || m.type === 'play_draw'), 'nothing before the broadcast delay');
  now += 91_000;
  sp.flush();
  const pub = msgs().find((m) => m.type === 'sideboarded')!;
  assert.deepEqual([pub.seat, pub.main_count, 'in' in pub, 'note' in pub], ['seat-a', 40, false, false]);
  const pd = msgs().find((m) => m.type === 'play_draw')!;
  assert.deepEqual([pd.on_play, pd.choice, 'note' in pd], ['seat-a', 'play', false]);
  assert.ok(JSON.stringify(msgs()).indexOf('Plummet') < 0, 'no card name while the seat plays');
  // The seat's last match ends: its swaps are released (after the delay, like its results); a note never is.
  sp.ingest({ t: now, type: 'match_end', a: 'seat-a', b: 'seat-b', wins: { 'seat-a': 2, 'seat-b': 0 } });
  now += 91_000;
  sp.flush();
  const full = msgs().find((m) => m.type === 'sideboarded')!;
  assert.deepEqual([full.full, full.in, 'note' in full], [true, [{ name: 'Plummet', qty: 2 }], false]);
  assert.equal('note' in msgs().find((m) => m.type === 'play_draw')!, false);
});

// --- the event: between games of a match ------------------------------------------------------------------------------

test('a match: game 1 from the seed; the loser chooses; then both seats sideboard at once, unaware of each other', async () => {
  const seats = ['seat-a', 'seat-b'].map((n, i) => new AgentSeat(n, i));
  const [a, b] = seats as [AgentSeat, AgentSeat];
  const logged: Raw[] = [];
  const ev: any = Object.create(Event.prototype);
  const built = { mainCards: registered.main.map((i) => pool[i]!), basics: registered.basics, by: 'agent', deck: deckData(registered, pool) };
  Object.assign(ev, {
    cfg: { bestOf: 3 }, plan: { format: 'swiss', rounds: 1, version: 1 }, rounds: [{ round: 1, pairs: [['seat-a', 'seat-b']], byes: [] }], round: 0,
    matches: [], playing: new Set(), roundMatches: new Map(), forfeits: new Map(), liveGames: new Set(), sessions: new Map(), seats, aborted: undefined,
    seed: 'seed-x', sideboarding: true, pools: [pool, pool], decks: new Map([['seat-a', built], ['seat-b', built]]), cards,
    knowledge: { level: 'none', stats: false }, log: (type: string, d: Record<string, unknown>) => logged.push({ t: Date.now(), type, ...d }), persist: () => {},
    // Both games are in the log (a resumed event replays them without the rules engine): a wins 2–0.
    resume: {
      games: new Map([1, 2].map((g) => [`seat-a vs seat-b — game ${g}`, { over: { winner: 'seat-a', turns: 9, opponent_cards_seen: { 'seat-a': { 'Sky Knight': 1 } } } }])),
      matchEnds: new Map(), seatsDone: new Set(), forfeits: [], records: [], playDraw: new Map(), sideboards: new Map(),
    },
  });
  // A getter, so assertions on one state don't narrow the type for the next.
  const pend = (s: AgentSeat) => s.pending;
  const match = ev.playMatch(a, b, 0);
  await new Promise((r) => setTimeout(r, 20));
  // Game 1: the seed decided; nobody was asked. Game 2: b lost, so b chooses; a only waits.
  const g1 = logged.find((x) => x.type === 'play_draw' && x.game_number === 1)!;
  assert.deepEqual([g1.by, g1.chooser, g1.on_play], ['seed', null, seededStarter('seed-x', 'seat-a vs seat-b', 'seat-a', 'seat-b')]);
  assert.equal(pend(b)?.kind, 'play_draw');
  assert.equal(pend(a), undefined);
  assert.match(a.status, /your opponent is choosing whether to play or draw in game 2/);
  await b.decide({ decision_id: pend(b)!.id, option: 'draw' });
  // Both sideboard at once: both offers are open before either answers, each with the other's deck as it was.
  assert.equal(pend(a)?.kind, 'sideboard');
  assert.equal(pend(b)?.kind, 'sideboard');
  assert.match(pend(a)!.text, /In game 2 you play first \(your opponent chose to draw\)\./);
  assert.match(pend(b)!.text, /In game 2 your opponent plays first \(you chose to draw\)\./);
  assert.match(pend(a)!.text, /The opponent's deck: 40 cards; their sideboard: 7 cards/);
  assert.match(pend(a)!.text, /\{"seen":1,"name":"Sky Knight"/, 'match memory from game 1');
  const bText = pend(b)!.text;
  const all16 = Array.from({ length: 16 }, (_, i) => i + 1);
  await a.decide({ decision_id: pend(a)!.id, cards: [...all16.slice(0, 14), 21, 22], basics: registered.basics });
  // b's open decision is unchanged by a's answer: it never learns what a changed.
  assert.equal(pend(b)!.text, bText);
  assert.ok(!bText.includes('Plummet for fliers'));
  await b.decide({ decision_id: pend(b)!.id, option: 'keep' });
  await match;
  const g2 = logged.find((x) => x.type === 'play_draw' && x.game_number === 2)!;
  assert.deepEqual([g2.by, g2.chooser, g2.choice, g2.on_play, 'note' in g2], ['agent', 'seat-b', 'draw', 'seat-a', false]);
  const sb = logged.filter((x) => x.type === 'sideboarded');
  assert.deepEqual(sb.map((x) => [x.seat, x.game_number, x.kept]), [['seat-a', 2, false], ['seat-b', 2, true]]);
  assert.deepEqual(sb[0]!.in, [{ name: 'Plummet', qty: 2 }]);
  assert.ok(logged.findIndex((x) => x.type === 'sideboard_offered' && x.seat === 'seat-b') < logged.findIndex((x) => x.type === 'sideboarded'), 'both offered before either settled');
  assert.match(a.done!, /won 2–0/);
});

// --- resume ------------------------------------------------------------------------------------------------------------

test('resume: play/draw and sideboarding come back from the log, and decision ids continue above S and P ids', () => {
  const r = resumeLog([
    { t: 1, type: 'event_start' },
    { t: 2, type: 'play_draw_offered', seat: 'seat-a', id: 'P41', match: 'm', game_number: 2 },
    { t: 3, type: 'play_draw', match: 'm', game_number: 2, on_play: 'seat-b', by: 'agent', chooser: 'seat-a', choice: 'draw' },
    { t: 4, type: 'sideboard_offered', seat: 'seat-b', id: 'S57', match: 'm', game_number: 2 },
    { t: 5, type: 'sideboarded', seat: 'seat-b', match: 'm', game_number: 2, by: 'agent', main: ['Grizzly Bears'] },
  ]);
  assert.equal(r.playDraw.get('m|2')!.on_play, 'seat-b');
  assert.equal(r.sideboards.get('m|2|seat-b')!.by, 'agent');
  assert.equal(r.lastIds.get('seat-a'), 41);
  assert.equal(r.lastIds.get('seat-b'), 57);
  assert.ok(r.active.has('seat-a') && r.active.has('seat-b'));
});

for (const [name, fn] of tests) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}
console.log(`\n${passed} sideboard tests passed`);
process.exit(0);
