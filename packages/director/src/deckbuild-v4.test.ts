/**
 * Prompt v4 deckbuilding (deckbuild-v4.ts, build.ts askForDeckV4): copies and the count-based input, the submission
 * errors, the review, the offer per knowledge level, and the decide → review → lock flow.
 *   npx tsx packages/director/src/deckbuild-v4.test.ts
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PackCard } from './boosters.js';
import { askForDeck } from './build.js';
import { CardDb, v4Cost } from './cards.js';
import { costNeeds, deckCardJson, deckOfferV4, deckReview, poolEntries, renderGuide, resolveSubmission } from './deckbuild-v4.js';
import type { Knowledge } from './knowledge.js';
import { Ratings } from './ratings.js';
import { TIER_SCORE_RE } from './set-context-filter.js';
import { AgentSeat } from './seat.js';

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

// --- a tiny card database (phase-rs card-data.json shape) ---------------------------------------------------------
const cost = (generic: number, ...shards: string[]) => ({ type: 'Cost', generic, shards });
const fixed = (v: number) => ({ type: 'Fixed', value: v });
const type = (core: string[], sub: string[] = [], sup: string[] = []) => ({ supertypes: sup, core_types: core, subtypes: sub });
const creature = (name: string, c: object, p = 2, t = 2, text = '') => ({ name, mana_cost: c, card_type: type(['Creature'], ['Bear']), power: fixed(p), toughness: fixed(t), oracle_text: text, keywords: [], layout: 'normal' });
const spell = (name: string, c: object, core = 'Instant', text = 'Deal 3 damage to any target.') => ({ name, mana_cost: c, card_type: type([core]), oracle_text: text, keywords: [], layout: 'normal' });
const land = (name: string, text: string, sub: string[] = [], sup: string[] = []) => ({ name, mana_cost: { type: 'NoCost' }, card_type: type(['Land'], sub, sup), oracle_text: text, keywords: [], layout: 'normal' });
const raw: Record<string, any> = {
  'powerful broker': creature('Powerful Broker', cost(1, 'Green')),
  'river scout': creature('River Scout', cost(1, 'Blue')),
  'sky knight': creature('Sky Knight', cost(2, 'White'), 2, 2, 'Flying'),
  'big bear': creature('Big Bear', cost(3, 'Green', 'Green'), 5, 5),
  'thinker': creature('Thinker', cost(2, 'Blue'), 1, 4),
  'shock': spell('Shock', cost(0, 'Red')),
  'fireball': spell('Fireball', cost(3, 'Red'), 'Sorcery'),
  'hybrid hound': creature('Hybrid Hound', cost(2, 'BlackGreen'), 3, 1),
  'twin cost': spell('Twin Cost', cost(0, 'TwoWhite'), 'Sorcery', 'Draw a card.'),
  'phyrexian bolt': spell('Phyrexian Bolt', cost(0, 'PhyrexianRed')),
  'dual grove': land('Dual Grove', 'This land enters tapped.\n{T}: Add {G} or {U}.'),
  'off grove': land('Off Grove', '{T}: Add {B} or {R}.'),
  'wilds': land('Wilds', '{T}, Sacrifice this land: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle.'),
  'forest': land('Forest', '({T}: Add {G}.)', ['Forest'], ['Basic']),
  // An adventure creature and a spell // land modal double-faced card.
  'beorn': { ...creature('Beorn', cost(4, 'Green'), 5, 5, 'Trample'), layout: 'adventure', scryfall_oracle_id: 'beorn' },
  'till and tend': { name: 'Till and Tend', mana_cost: cost(1, 'Green'), card_type: type(['Sorcery'], ['Adventure']), oracle_text: 'You may play an additional land this turn.', keywords: [], layout: 'adventure', scryfall_oracle_id: 'beorn' },
  'tidal spell': { ...spell('Tidal Spell', cost(1, 'Blue'), 'Sorcery', 'Draw two cards.'), layout: 'modal_dfc', scryfall_oracle_id: 'tidal' },
  'tidal haven': { ...land('Tidal Haven', 'As this land enters, you may pay 3 life. If you don\'t, it enters tapped.\n{T}: Add {U}.'), layout: 'modal_dfc', scryfall_oracle_id: 'tidal' },
};
const dir = mkdtempSync(join(tmpdir(), 'mtgdt-deckv4-'));
writeFileSync(join(dir, 'card-data.json'), JSON.stringify(raw));
const cards = new CardDb(join(dir, 'card-data.json'), dir);
// 17Lands-style data for set "ZZZ" (GIH WR and ATA, shown at Set Context + Human Stats).
mkdirSync(join(dir, 'sets', 'ZZZ'), { recursive: true });
const gih: Record<string, number> = { 'Powerful Broker': 0.6, 'River Scout': 0.55, 'Sky Knight': 0.56, 'Big Bear': 0.58, Thinker: 0.53, Shock: 0.57, Fireball: 0.54, 'Hybrid Hound': 0.5, 'Twin Cost': 0.45, Beorn: 0.62 };
writeFileSync(join(dir, 'sets', 'ZZZ', '17lands.json'), JSON.stringify({ snapshot: 'test', cards: Object.fromEntries(Object.entries(gih).map(([n, g]) => [n, { gih_wr: g, ata: 5 }])) }));
const ratings = new Ratings(join(dir, 'sets'), 'zzz', { cards });

const pc = (name: string, colors: string[], cmc: number, typeLine: string, rarity = 'common'): PackCard => ({ name, rarity, colors, cmc, typeLine });
const BROKER = pc('Powerful Broker', ['G'], 2, 'Creature — Bear');
// The pool: 3 Powerful Broker at 1, 5, 9 (pool numbers), across the other colors, two lands, a drafted Forest.
const pool: PackCard[] = [
  BROKER, pc('River Scout', ['U'], 2, 'Creature — Bear'), pc('Sky Knight', ['W'], 3, 'Creature — Bear'), pc('Big Bear', ['G'], 5, 'Creature — Bear'),
  { ...BROKER }, pc('Thinker', ['U'], 3, 'Creature — Bear'), pc('Shock', ['R'], 1, 'Instant'), pc('Hybrid Hound', ['B', 'G'], 3, 'Creature — Bear'),
  { ...BROKER }, pc('Dual Grove', [], 0, 'Land'), pc('Off Grove', [], 0, 'Land'), pc('Forest', [], 0, 'Basic Land — Forest'),
  pc('Beorn', ['G'], 5, 'Creature — Bear // Sorcery — Adventure'), pc('Tidal Spell', ['U'], 2, 'Sorcery // Land'), pc('Fireball', ['R'], 4, 'Sorcery'),
  pc('Twin Cost', ['W'], 2, 'Sorcery'), pc('Wilds', [], 0, 'Land'),
];
const ok = (r: ReturnType<typeof resolveSubmission>) => {
  if (!r.ok) throw new Error(r.error);
  return r.deck;
};
const err = (r: ReturnType<typeof resolveSubmission>) => (r.ok ? '' : r.error);
const filler = { Island: 20, Forest: 20 };

await test('copies: 3 drafted, asked 3 / 2 / 4 by repeated n, by poolNumbers and mixed', () => {
  for (const form of [[1, 1, 1], [1, 5, 9], [9, 1, 9], [5, 5, 1]]) {
    const d = ok(resolveSubmission(pool, form, filler));
    assert.deepEqual([...d.main].sort((a, b) => a - b), [0, 4, 8], `form ${form}`);
  }
  assert.equal(ok(resolveSubmission(pool, [9, 9], filler)).main.length, 2);
  assert.deepEqual(ok(resolveSubmission(pool, [9, 9], filler)).main.sort(), [0, 8]);
  for (const form of [[1, 1, 1, 1], [1, 5, 9, 9], [5, 5, 5, 5]]) {
    assert.equal(err(resolveSubmission(pool, form, filler)), 'You drafted 3 copies of Powerful Broker (pool numbers 1, 5, 9); your deck asks for 4. Play at most 3.');
  }
});

await test('copies of several cards in one deck, mixed with other colors; basics unlimited', () => {
  const d = ok(resolveSubmission(pool, [2, 1, 6, 1, 3, 9], { Plains: 30, Island: 4 }));
  assert.equal(d.main.length, 6);
  assert.deepEqual(d.main.filter((i) => pool[i]!.name === 'Powerful Broker').sort(), [0, 4, 8]);
  assert.equal(d.basics.Plains, 30);
});

await test('submission errors are specific, all reported at once', () => {
  assert.equal(err(resolveSubmission(pool, [0, 18, 2.5], filler)), 'Pool numbers run from 1 to 17; 0, 18, 2.5 are not in your pool. Use the "n" (or "poolNumbers") values from YOUR POOL.');
  assert.equal(err(resolveSubmission(pool, [12, 12], filler)), 'You drafted 1 copy of Forest (pool number 12); your deck asks for 2. Basic lands are unlimited: add them through basics instead.');
  assert.equal(err(resolveSubmission(pool, [], { Wastes: 40 })), '"Wastes" is not a basic land you can add; basics are Plains, Island, Swamp, Mountain and Forest.');
  assert.equal(err(resolveSubmission(pool, [1, 2], { Island: 20, Forest: 16 })), 'The deck you submitted has 38 cards (2 pool cards + 36 basic lands); a deck needs at least 40. Add 2 cards from your pool or basic lands, then submit the whole deck again.');
  const both = err(resolveSubmission(pool, [99, 1, 1, 1, 1], { swamp: 2.5 }));
  assert.equal(both.split('\n').length, 3);
  // Basic names are case-insensitive; 0 counts are dropped.
  assert.deepEqual(ok(resolveSubmission(pool, [], { ' island ': 40, Plains: 0 })).basics, { Island: 40 });
});

await test('SEC-3: no deck beyond MAX_DECK_SIZE, however the basics are spelled', () => {
  const variants = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`${i % 2 ? 'island' : 'ISLAND'}${' '.repeat(i)}`, 40]));
  assert.match(err(resolveSubmission(pool, [], variants)), /^The deck you submitted has 1200 cards \(0 pool cards \+ 1200 basic lands\); the most this event accepts is 100\./);
  assert.equal(ok(resolveSubmission(pool, [], { Island: 40, island: 40, ' ISLAND ': 20 })).basics.Island, 100);
});

await test('cost notation and needs: hybrid, {2/W}, phyrexian', () => {
  assert.equal(v4Cost('{Two/W}{P/R}{P/G/W}{B/G}'), '{2/W}{R/P}{G/W/P}{B/G}');
  assert.equal(cards.json('Twin Cost').cost, '{2/W}');
  assert.equal(cards.json('Phyrexian Bolt').cost, '{R/P}');
  assert.deepEqual(costNeeds('{2}{B/G}{G}{G}{2/W}{R/P}'), { hard: { G: 2 }, hybrid: [['B', 'G']] });
});

await test('pool card JSON: n, count, every copy\'s number, full printed card with faces, identity; 17Lands stats only with stats, never a tier score', () => {
  const entries = poolEntries(pool);
  const broker = deckCardJson(entries.find((e) => e.name === 'Powerful Broker')!, cards);
  assert.deepEqual([broker.n, broker.count, broker.poolNumbers], [1, 3, [1, 5, 9]]);
  assert.equal(broker.tierScore, undefined);
  assert.equal(broker.colorIdentity, 'G');
  const beorn = deckCardJson(entries.find((e) => e.name === 'Beorn')!, cards);
  assert.equal((beorn.faces as any[])[0].name, 'Till and Tend');
  assert.equal((beorn.faces as any[])[0].cost, '{1}{G}');
  assert.equal(beorn.poolNumbers, undefined);
  const grove = deckCardJson(entries.find((e) => e.name === 'Dual Grove')!, cards);
  assert.equal(grove.colorIdentity, 'UG');
  const withStats = deckCardJson(entries.find((e) => e.name === 'Beorn')!, cards, ratings);
  assert.equal(withStats.tierScore, undefined, 'no MTG Deck Tools tier score at any level (owner decision)');
  assert.match(String(withStats['17lands']), /^GIH WR 62\.0%, ATA 5\.0$/);
});

await test('guide template: blocks per flag, nested', () => {
  const t = 'A{{#set_context}} B{{#stats}} C{{/stats}}{{/set_context}}{{^set_context}} D{{/set_context}}{{#hybrid}} E{{/hybrid}}';
  assert.equal(renderGuide(t, {}), 'A D');
  assert.equal(renderGuide(t, { set_context: true }), 'A B');
  assert.equal(renderGuide(t, { set_context: true, stats: true, hybrid: true }), 'A B C E');
});

const guide = readFileSync(resolve(import.meta.dirname, '../../../prompts/deckbuilding-guide.md'), 'utf8');
const knowledge = (level: 'none' | 'primer' | 'primer+stats'): Knowledge => ({ level, guide, stats: level === 'primer+stats', ...(level === 'none' ? {} : { primer: '# Set context' }) });

await test('offer per knowledge level: set context rules only with set context, 17Lands stats only with stats, no tier scores', () => {
  const none = deckOfferV4('B1', pool, cards, ratings, knowledge('none'));
  const primer = deckOfferV4('B1', pool, cards, ratings, knowledge('primer'));
  const stats = deckOfferV4('B1', pool, cards, ratings, knowledge('primer+stats'));
  for (const t of [none, primer, stats]) {
    assert.match(t, /^DECKBUILDING — build your 40-card deck from the 17 cards you drafted/);
    assert.match(t, /YOUR POOL: 16 cards, 14 different \(the 1 basic land you drafted is left out: basics are unlimited\)/);
    assert.match(t, /"copies":\[\n?\s*\{"name":"Powerful Broker","count":3,"poolNumbers":\[1,5,9\]\}/);
    assert.match(t, /\*\*3b\. Hybrid castability\*\*/); // the pool has hybrid cards
    assert.match(t, /DECISION B1 — submit your deck: decide\(decision_id="B1", cards=\[pool numbers, one per copy\]/);
    assert.doesNotMatch(t, /\{\{/);
    assert.doesNotMatch(t, /"name":"Forest"/);
  }
  assert.doesNotMatch(none, /set context/i);
  assert.match(primer, /The set context overrides generic heuristics/);
  assert.doesNotMatch(primer, /17lands|GIH WR/);
  assert.match(stats, /"17lands":"GIH WR [\d.]+%, ATA [\d.]+"/);
  // No MTG Deck Tools tier scores at any level: no card field, no Tier Score Guide, no tier rules.
  for (const t of [none, primer, stats]) {
    assert.doesNotMatch(t, /"tierScore"|Tier Score Guide|treat its tierScore|tierScore gap|\(0–10\)/);
    assert.doesNotMatch(t, TIER_SCORE_RE, 'no tier-score wording at all (prompts v7)');
  }
  assert.match(primer, /\*\*Card power is yours to judge\.\*\* Judge each card's power yourself, and use the set context/);
  assert.match(stats, /Judge each card's power yourself, with the 17Lands stats as human play data/);
  assert.match(stats, /best23_avg_gih_wr/);
  // Sorted by mana value; the card data is complete (full text, faces).
  const lines = stats.split('\n').filter((l) => l.startsWith('{"n":'));
  const mvs = lines.map((l) => JSON.parse(l).mv as number);
  assert.deepEqual(mvs, [...mvs].sort((a, b) => a - b));
  assert.equal(lines.length, 14);
});

await test('review: exact counts, copies, sources vs pips, and the guide\'s flags', () => {
  // Built by hand (under 40 cards, so not through resolveSubmission). 3 Broker + Big Bear + Beorn + Hybrid Hound (G) + River Scout + Thinker + Tidal Spell (U) + Shock + Fireball (R splash)
  // + Dual Grove + Off Grove + Wilds; basics 6 Forest + 6 Island + 1 Mountain + 2 Plains.
  const d = { main: [0, 4, 8, 3, 12, 7, 1, 5, 13, 6, 14, 9, 10, 16], basics: { Forest: 6, Island: 6, Mountain: 1, Plains: 2 } };
  const r = deckReview(pool, d, cards, { totalCount: 30, archetype: 'Aggro', setContext: true });
  const s = r.summary as any;
  assert.equal(s.total, 29);
  assert.equal(s.lands, 3 + 15);
  assert.deepEqual(s.spells_with_a_land_face, ['Tidal Spell']);
  assert.equal(s.deck_mana_colors, 'URG');
  const col = (c: string) => s.colors.find((x: any) => x.color === c);
  assert.deepEqual(col('G'), { color: 'G', cards: 5, pips: 6, sources: 6 + 1 + 1 }); // Forests, Dual Grove, Wilds
  assert.deepEqual(col('R'), { color: 'R', cards: 2, pips: 2, sources: 1 + 1 + 1, splash: true }); // Mountain, Off Grove, Wilds
  assert.equal(s.main.find((m: any) => m.name === 'Powerful Broker').count, 3);
  assert.deepEqual(s.main.find((m: any) => m.name === 'Powerful Broker').poolNumbers, [1, 5, 9]);
  const f = r.flags.join('\n');
  assert.match(f, /You reported total_count 30; the deck as submitted has 29 cards\./);
  assert.doesNotMatch(f, /Can't be cast/); // {B/G} is castable with green; every pip has a source
});

await test('review flags: splash land math, splashed 1-drop, off-color land and basics, copies left, land count', () => {
  const d = { main: [0, 4, 3, 12, 7, 1, 5, 13, 6, 14, 9, 10], basics: { Forest: 6, Island: 6, Plains: 2, Swamp: 1 } };
  const r = deckReview(pool, d, cards, { totalCount: 27, archetype: 'Aggro', setContext: false });
  const f = r.flags.join('\n');
  assert.doesNotMatch(f, /Can't be cast: Hybrid Hound/); // {B/G} is castable with green
  assert.match(f, /Splash: red has 2 cards \(Shock, Fireball\) and 1 source; the guide asks for at least 4 sources for 2 splashed cards\./);
  assert.match(f, /Splash: Shock \(mana value 1\) is splashed; the guide says never splash mana value 1–2 cards/);
  assert.match(f, /Off-color land: Off Grove makes \{B\} or \{R\}; Deck Mana Colors are U, R, G\./);
  assert.match(f, /Off-color basics: 2 Plains, but no card in the deck has a \{W\} pip\./);
  assert.match(f, /Off-color basics: 1 Swamp/);
  assert.match(f, /Copies: you play 2 of your 3 Powerful Broker; the other stays in your sideboard\./);
  assert.match(f, /creatures in an aggro deck: the guide says aggro decks need 15\+\./);
  assert.doesNotMatch(f, /the guide's default is 17/); // 2 non-basic lands + 15 basics
  const lands = (forests: number) => deckReview(pool, { ...d, basics: { ...d.basics, Forest: forests } }, cards, { setContext: true }).flags.join('\n');
  assert.doesNotMatch(lands(5), /default is 17/); // 16 lands + a spell // land card
  assert.match(lands(4), /15 lands plus 1 spell that can be played as a land: the guide's default is 17 \(unless the set context says otherwise\)\./);
  const over = deckReview(pool, ok(resolveSubmission(pool, [1, 2], { Island: 20, Forest: 20 })), cards, { setContext: false });
  assert.match(over.flags.join('\n'), /42 cards: the rule is exactly 40\. Cut your 2 weakest cards unless you mean to play 42\./);
  assert.match(over.flags.join('\n'), /You didn't report total_count; the deck as submitted has 42 cards\./);
});

// --- the decide → review → lock flow --------------------------------------------------------------------------------
function seatFlow(level: 'none' | 'primer' | 'primer+stats' = 'primer') {
  const seat = new AgentSeat('s1', 0);
  seat.observation = 'v4';
  const logs: Array<Record<string, any>> = [];
  const done = askForDeck(seat, pool, cards, ratings, knowledge(level), (type, rec) => logs.push({ type, ...rec }));
  return { seat, logs, done };
}
const deck40 = { cards: [1, 1, 1, 4, 13, 8, 2, 6, 14, 10, 17], basics: { Forest: 15, Island: 14 }, total_count: 40, deck_name: 'Bears', archetype: 'Midrange', note: 'curve out' };

await test('flow: submit → review (not locked) → confirm locks the deck as submitted', async () => {
  const { seat, logs, done } = seatFlow();
  const b1 = seat.pending!.id;
  const reply = await seat.decide({ decision_id: b1, ...deck40 });
  assert.match(reply, /^Deck received; it is not locked yet\.\n\nDECK REVIEW — your deck is not locked yet\./);
  assert.match(reply, /"total":40/);
  assert.match(reply, /\{"count":3,"name":"Powerful Broker","cost":"\{1\}\{G\}","mv":2,"type":"Creature — Bear","pt":"2\/2","poolNumbers":\[1,5,9\]\}/);
  const b2 = seat.pending!.id;
  assert.notEqual(b1, b2);
  assert.equal(logs.filter((l) => l.type === 'deck_built').length, 0);
  assert.equal(logs.filter((l) => l.type === 'build_offered').length, 2);
  assert.match(await seat.decide({ decision_id: b2, option: 'nope' }), /Not accepted: answer with option "confirm"/);
  assert.match(await seat.decide({ decision_id: b2, option: 'confirm' }), /^Deck locked\./);
  const built = await done;
  assert.equal(built.deck.main_deck.length, 40);
  assert.equal(built.deck.main_deck.filter((n) => n === 'Powerful Broker').length, 3);
  assert.equal(built.deck.sideboard.length, pool.length - 11);
  const rec = logs.find((l) => l.type === 'deck_built')!;
  assert.deepEqual(rec.pool_numbers, [1, 5, 9, 4, 13, 8, 2, 6, 14, 10, 17]);
  assert.equal(rec.review.outcome, 'confirmed');
  assert.equal(rec.deck_name, 'Bears');
  assert.equal(rec.total_count, 40);
  assert.equal('analysis' in rec || 'note' in rec, false, 'the deck is logged without any written reasoning');
});

await test('flow: rejected submissions are logged; a resubmission at review locks at once', async () => {
  const { seat, logs, done } = seatFlow('none');
  const b1 = seat.pending!.id;
  assert.match(await seat.decide({ decision_id: b1, cards: [1, 1, 1, 1], basics: { Forest: 36 } }), /^Not accepted: You drafted 3 copies of Powerful Broker/);
  assert.match(await seat.decide({ decision_id: b1, option: 'confirm' }), /this decision takes a deck/);
  await seat.decide({ decision_id: b1, ...deck40, basics: { Forest: 16, Island: 14 } });
  const b2 = seat.pending!.id;
  const reply = await seat.decide({ decision_id: b2, ...deck40 });
  assert.match(reply, /^Deck locked \(resubmitted\)\. The Director's count of the final deck:\n\{\n "total":40/);
  await done;
  const rec = logs.find((l) => l.type === 'deck_built')!;
  assert.equal(rec.review.outcome, 'resubmitted');
  assert.match(rec.review.flags.join('\n'), /41 cards/);
  assert.equal(rec.rejected.length, 2);
});

await test('flow: an inactive seat at review keeps the deck it submitted; "auto" still delegates', async () => {
  const a = seatFlow();
  await a.seat.decide({ decision_id: a.seat.pending!.id, ...deck40 });
  a.seat.pending!.forfeit!();
  const built = await a.done;
  assert.equal(built.by, 'agent');
  assert.equal(a.logs.find((l) => l.type === 'deck_built')!.review.outcome, 'forfeit');
  const b = seatFlow();
  await b.seat.decide({ decision_id: b.seat.pending!.id, option: 'auto' });
  assert.equal((await b.done).by, 'auto');
});

await test('flow: option "auto" with a deck, or "confirm" with a different deck, is refused; confirm with the same deck locks it', async () => {
  const a = seatFlow();
  assert.match(await a.seat.decide({ decision_id: a.seat.pending!.id, option: 'auto', ...deck40 }), /^Not accepted: option "auto" hands deckbuilding to the reference builder, but you also sent a deck; nothing was built/);
  assert.match(await a.seat.decide({ decision_id: a.seat.pending!.id, ...deck40, attackers: [3] }), /Deckbuilding doesn't take `attackers`/);
  await a.seat.decide({ decision_id: a.seat.pending!.id, ...deck40 });
  const b2 = a.seat.pending!.id;
  assert.match(await a.seat.decide({ decision_id: b2, option: 'confirm', ...deck40, basics: { Forest: 16, Island: 13 } }), /^Not accepted: option "confirm" locks the deck as shown, but you also sent a different deck; nothing was locked/);
  assert.equal(a.logs.filter((l) => l.type === 'deck_built').length, 0);
  // The same deck again (pool numbers in another order) with confirm: locked as confirmed.
  assert.match(await a.seat.decide({ decision_id: b2, option: 'confirm', ...deck40, cards: [...deck40.cards].reverse() }), /^Deck locked\./);
  assert.equal((await a.done).by, 'agent');
  assert.equal(a.logs.find((l) => l.type === 'deck_built')!.review.outcome, 'confirmed');
});

console.log(`# ${passed} passed`);
