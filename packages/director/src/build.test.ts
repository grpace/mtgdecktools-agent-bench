/**
 * Reference builder (build.ts autoBuild): 23 non-land spells + 17 lands, on-color non-basic lands counted toward
 * the 17, always 40 cards.
 *   npx tsx packages/director/src/build.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PackCard } from './boosters.js';
import { autoBuild, landColors } from './build.js';
import { CardDb } from './cards.js';
import { Ratings } from './ratings.js';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

const land = (name: string, oracle: string) => ({ name, mana_cost: { type: 'NoCost' }, card_type: { supertypes: [], core_types: ['Land'], subtypes: [] }, oracle_text: oracle, keywords: [], layout: 'normal' });
const raw = {
  'gw grove': land('GW Grove', 'This land enters tapped.\n{T}: Add {G} or {W}.'),
  'ub grove': land('UB Grove', '{T}: Add {U} or {B}.'),
  'any grove': land('Any Grove', '{T}: Add one mana of any color.'),
  'g grove': land('G Grove', '{T}: Add {G}.\n{T}, Pay 1 life: Add {W}.'),
  'waste': land('Waste', '{T}: Add {C}.'),
};
const dir = mkdtempSync(join(tmpdir(), 'mtgdt-build-'));
writeFileSync(join(dir, 'card-data.json'), JSON.stringify(raw));
const cards = new CardDb(join(dir, 'card-data.json'), dir);

const pc = (name: string, colors: string[], cmc: number, typeLine: string): PackCard => ({ name, rarity: 'common', colors, cmc, typeLine });
// No 17Lands data for this set code: the card-quality heuristic rates cards (a lookup that knows nothing is fine).
const ratings = new Ratings(join(dir, 'sets'), 'zzz', { cards: { get: () => undefined } });

function pool(nonbasicLands: PackCard[], spellsPerColor = 15): PackCard[] {
  const out: PackCard[] = [];
  for (let i = 0; i < spellsPerColor; i++) out.push(pc(`G spell ${i}`, ['G'], 2 + (i % 4), 'Creature — Bear'));
  for (let i = 0; i < spellsPerColor; i++) out.push(pc(`W spell ${i}`, ['W'], 2 + (i % 4), 'Creature — Soldier'));
  for (let i = 0; i < 3; i++) out.push(pc(`U spell ${i}`, ['U'], 3, 'Instant'));
  return [...out, ...nonbasicLands, pc('Forest', [], 0, 'Basic Land — Forest')];
}

const lands = (deck: string[]) => deck.filter((n) => !/ spell /.test(n));

test('land colors from rules text and basic land types', () => {
  assert.deepEqual(landColors(pc('GW Grove', [], 0, 'Land'), cards).sort(), ['G', 'W']);
  assert.equal(landColors(pc('Any Grove', [], 0, 'Land'), cards).length, 5);
  assert.deepEqual(landColors(pc('Waste', [], 0, 'Land'), cards), []);
  assert.deepEqual(landColors(pc('Unknown Dual', [], 0, 'Land — Forest Plains')).sort(), ['G', 'W']);
});

test('non-basic lands count toward 17 lands: 23 spells + 17 lands = 40', () => {
  const p = pool([pc('GW Grove', [], 0, 'Land'), pc('UB Grove', [], 0, 'Land'), pc('Waste', [], 0, 'Land'), pc('Any Grove', [], 0, 'Land')]);
  const built = autoBuild(p, ratings, cards);
  const deck = built.deck.main_deck;
  assert.equal(deck.length, 40);
  assert.equal(lands(deck).length, 17);
  assert.equal(deck.length - lands(deck).length, 23);
  assert.ok(deck.includes('GW Grove'), 'on-color dual is played');
  assert.ok(deck.includes('Any Grove'), 'any-color land is played');
  assert.ok(!deck.includes('UB Grove'), 'off-color dual is not');
  assert.ok(!deck.includes('Waste'), 'colorless utility land is not');
  const basics = Object.values(built.basics).reduce((s, n) => s + n, 0);
  assert.equal(basics, 15);
});

test('at most three non-basic lands, the rest basics', () => {
  const duals = Array(5).fill(0).map((_, i) => ({ ...pc('GW Grove', [], 0, 'Land'), rarity: i ? 'common' : 'uncommon' }));
  const built = autoBuild(pool(duals), ratings, cards);
  assert.equal(built.deck.main_deck.filter((n) => n === 'GW Grove').length, 3);
  assert.equal(built.deck.main_deck.length, 40);
  assert.equal(lands(built.deck.main_deck).length, 17);
});

test('a thin pool still makes 40 cards (more lands fill the gap)', () => {
  const built = autoBuild(pool([pc('GW Grove', [], 0, 'Land')], 9), ratings, cards);
  assert.equal(built.deck.main_deck.length, 40);
  assert.equal(built.deck.main_deck.length - lands(built.deck.main_deck).length, 18);
});

test('without card data, type-line duals still count and others are left out', () => {
  const built = autoBuild(pool([pc('Typed Dual', [], 0, 'Land — Forest Plains'), pc('Mystery Land', [], 0, 'Land')]), ratings);
  assert.ok(built.deck.main_deck.includes('Typed Dual'));
  assert.ok(!built.deck.main_deck.includes('Mystery Land'));
  assert.equal(built.deck.main_deck.length, 40);
  assert.equal(lands(built.deck.main_deck).length, 17);
});

console.log(`# ${passed} passed`);
