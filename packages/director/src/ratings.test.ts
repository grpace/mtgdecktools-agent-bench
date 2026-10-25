/**
 * Bot ratings: the 17Lands-free card-quality heuristic and the policy switch.
 *   npx tsx packages/director/src/ratings.test.ts            (unit checks)
 *   npx tsx packages/director/src/ratings.test.ts --validate (also: rank correlation with 17Lands GIH WR per set,
 *                                                             needs data/card-data.slim.json + data/draft-pools.json)
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PackCard } from './boosters.js';
import { autoBuild } from './build.js';
import { cardQuality, cardQualityParts, interactionOf, keywordsOf, Ratings, topColors } from './ratings.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

type C = { name: string; cost: string; typeLine: string; pt?: string; oracle: string; rarity?: string };
const card = (name: string, cost: string, typeLine: string, oracle = '', pt?: string, rarity = 'common'): C => ({ name, cost, typeLine, oracle, rarity, ...(pt ? { pt } : {}) });
const q = (c: C) => cardQuality(c);

const bears = card('Grizzly Bears', '{1}{G}', 'Creature — Bear', '', '2/2');
const murder = card('Murder', '{1}{B}{B}', 'Instant', 'Destroy target creature.');
const bolt = card('Lightning Bolt', '{R}', 'Instant', 'Lightning Bolt deals 3 damage to any target.');
const pacifism = card('Pacifism', '{1}{W}', 'Enchantment — Aura', "Enchant creature\nEnchanted creature can't attack or block.");
const serra = card('Serra Angel', '{3}{W}{W}', 'Creature — Angel', "Flying\nVigilance (Attacking doesn't cause this creature to tap.)", '4/4', 'uncommon');
const wall = card('Wall of Wood', '{G}', 'Creature — Wall', 'Defender', '0/3');
const growth = card('Giant Growth', '{G}', 'Instant', 'Target creature gets +3/+3 until end of turn.');
const divination = card('Divination', '{2}{U}', 'Sorcery', 'Draw two cards.');
const golem = card('Bronze Sable', '{2}', 'Artifact Creature — Sable', '', '2/1');
const goldRare = card('Gold Rare', '{1}{W}{U}', 'Creature — Spirit', 'Flying', '2/3', 'rare');
const fatty = card('Big Lump', '{7}{G}', 'Creature — Beast', '', '5/5');
const plains = card('Plains', '', 'Basic Land — Plains');
const dual = card('Tranquil Cove', '', 'Land', 'This land enters tapped.\nWhen this land enters, you gain 1 life.\n{T}: Add {W} or {U}.');
const utility = card('Mutavault', '', 'Land', '{T}: Add {C}.');

test('keywords come from keyword lines only, without reminder text', () => {
  assert.deepEqual(keywordsOf(serra.oracle), ['flying', 'vigilance']);
  assert.deepEqual(keywordsOf('Flying, lifelink\nWard {2}'), ['flying', 'lifelink', 'ward']);
  assert.deepEqual(keywordsOf('Destroy target creature with flying.'), []);
  assert.deepEqual(keywordsOf('Protection from black\nSwampwalk'), ['protection from', 'swampwalk']);
});

test('interaction: removal beats tempo, the strongest match counts', () => {
  assert.equal(interactionOf(murder.oracle)?.kind, 'removal');
  assert.equal(interactionOf(bolt.oracle)?.kind, 'removal');
  assert.equal(interactionOf(pacifism.oracle)?.kind, 'removal');
  assert.equal(interactionOf('Target creature an opponent controls gets -3/-3 until end of turn.')?.kind, 'removal');
  assert.equal(interactionOf('Target creature you control fights target creature you don\'t control.')?.kind, 'removal');
  assert.equal(interactionOf("Return target creature to its owner's hand.")?.kind, 'tempo');
  assert.equal(interactionOf('Counter target spell.')?.kind, 'counter');
  assert.equal(interactionOf(growth.oracle), null);
  assert.equal(interactionOf('Destroy all creatures.')?.kind, 'sweeper');
});

test('orders cards the way Limited players would', () => {
  assert.ok(q(murder) > q(bears), 'removal over a vanilla two-drop');
  assert.ok(q(bolt) > q(growth), 'burn over a combat trick');
  assert.ok(q(serra) > q(bears), 'evasive uncommon over a vanilla common');
  assert.ok(q(bears) > q(wall), 'a two-drop over a defender');
  assert.ok(q(divination) > q(growth) - 0.01, 'card draw is playable');
  assert.ok(q(fatty) < q(bears) + 0.004, 'an overcosted fatty is not a high pick');
  assert.ok(q({ ...goldRare, cost: '{W}{U}{B}' }) < q(goldRare), 'three-color cards pay for being harder to cast');
  assert.ok(q(golem) > 0.53, 'colorless creatures are playable');
});

test('values sit on the win-rate scale: basics lowest, lands below playables, bounded', () => {
  assert.equal(q(plains), 0.3);
  assert.ok(q(dual) < q(bears) && q(dual) > q(utility));
  for (const c of [bears, murder, bolt, pacifism, serra, wall, growth, divination, golem, goldRare, fatty, dual, utility]) {
    const v = q(c);
    assert.ok(v >= 0.47 && v <= 0.63, `${c.name} ${v}`);
  }
  const parts = cardQualityParts(serra);
  assert.ok(parts.keywords > 0 && parts.roles.creature && parts.roles.top_end && !parts.roles.early);
  assert.equal(cardQualityParts(bolt).roles.interaction, 'removal');
});

test('works from booster-sheet facts alone (no card text)', () => {
  const v = cardQuality({ name: 'X', rarity: 'rare', typeLine: 'Creature — Elf', cmc: 3, colors: ['G'] });
  assert.ok(v > cardQuality({ name: 'Y', rarity: 'common', typeLine: 'Creature — Elf', cmc: 3, colors: ['G'] }));
  assert.ok(v >= 0.47 && v <= 0.63);
});

// A tiny set directory: one set with a win-rate file, one without.
const setsDir = mkdtempSync(join(tmpdir(), 'ratings-test-'));
mkdirSync(join(setsDir, 'AAA'));
writeFileSync(join(setsDir, 'AAA', '17lands.json'), JSON.stringify({ cards: { 'Grizzly Bears': { gih_wr: 0.61, ata: 2.5 }, Murder: { gih_wr: 0.52 } } }));
const pc = (c: C, colors: string[], cmc: number): PackCard => ({ name: c.name, rarity: c.rarity ?? 'common', colors, cmc, typeLine: c.typeLine });
const lookup = { get: (n: string) => [bears, murder, bolt, pacifism, serra, wall, growth, divination, golem, goldRare, fatty, dual].find((c) => c.name === n) };

test('policy: win rates when the set has them, the card-quality heuristic otherwise', () => {
  const withStats = new Ratings(setsDir, 'aaa', { cards: lookup });
  assert.equal(withStats.policy, 'win-rates');
  assert.equal(withStats.hasStats, true);
  assert.equal(withStats.value(pc(bears, ['G'], 2)), 0.61);
  assert.equal(withStats.value(pc(murder, ['B'], 3)), 0.52);
  // A card missing from the file keeps the rarity prior (bots and reference builds stay reproducible).
  assert.equal(withStats.value(pc(serra, ['W'], 5)), 0.552 + 0.004);
  assert.match(withStats.statsLabel('Grizzly Bears'), /GIH WR 61\.0%, ATA 2\.5/);

  const none = new Ratings(setsDir, 'bbb', { cards: lookup });
  assert.equal(none.policy, 'card-quality');
  assert.equal(none.hasStats, false);
  assert.match(none.source, /card-quality heuristic cq-1/);
  assert.equal(none.value(pc(murder, ['B'], 3)), q(murder));
  assert.ok(none.value(pc(murder, ['B'], 3)) > none.value(pc(bears, ['G'], 2)));
  assert.equal(none.statsLabel('Murder'), '');
  assert.equal(Ratings.hasStats(setsDir, 'aaa'), true);
  assert.equal(Ratings.hasStats(setsDir, 'bbb'), false);

  const forced = new Ratings(setsDir, 'aaa', { cards: lookup, policy: 'card-quality' });
  assert.equal(forced.value(pc(bears, ['G'], 2)), q(bears));
});

test('pin: an event keeps the 17Lands snapshot it started with across a refresh', () => {
  const sets = mkdtempSync(join(tmpdir(), 'ratings-pin-'));
  mkdirSync(join(sets, 'PIN'));
  const v1 = { snapshot: 'PIN.PremierDraft@2026-01-01T00:00:00Z', date_range: { first: '2026-01-01', last: '2026-01-02' }, cards: { 'Grizzly Bears': { gih_wr: 0.6 } } };
  writeFileSync(join(sets, 'PIN', '17lands.json'), JSON.stringify(v1));
  const pin = join(sets, 'run', 'ratings-17lands.json');
  const first = new Ratings(sets, 'pin', { cards: lookup, pin });
  assert.equal(first.snapshot?.id, v1.snapshot);
  assert.equal(first.snapshot?.from, 'sets');
  assert.equal(first.snapshot?.sha256.length, 64);
  assert.ok(existsSync(pin));
  // A refresh rewrites the set's file; the resumed event still reads its pinned copy.
  writeFileSync(join(sets, 'PIN', '17lands.json'), JSON.stringify({ snapshot: 'PIN.PremierDraft@2026-02-01T00:00:00Z', cards: { 'Grizzly Bears': { gih_wr: 0.5 } } }));
  const resumed = new Ratings(sets, 'pin', { cards: lookup, pin });
  assert.equal(resumed.snapshot?.id, v1.snapshot);
  assert.equal(resumed.snapshot?.from, 'pinned');
  assert.equal(resumed.value(pc(bears, ['G'], 2)), 0.6);
  // A set without data at the start stays on the heuristic even if data appears mid-event.
  const pin2 = join(sets, 'run2', 'ratings-17lands.json');
  const noData = new Ratings(sets, 'zzz', { cards: lookup, pin: pin2 });
  assert.equal(noData.policy, 'card-quality');
  mkdirSync(join(sets, 'ZZZ'));
  writeFileSync(join(sets, 'ZZZ', '17lands.json'), JSON.stringify(v1));
  const later = new Ratings(sets, 'zzz', { cards: lookup, pin: pin2 });
  assert.equal(later.policy, 'card-quality');
  assert.equal(later.snapshot, undefined);
});

test('bots and the reference builder work with the heuristic', () => {
  const r = new Ratings(setsDir, 'bbb', { cards: lookup });
  const pool: PackCard[] = [
    ...Array(8).fill(0).map((_, i) => ({ ...pc(serra, ['W'], 5), name: i ? `Serra Angel` : 'Serra Angel' })),
    ...Array(8).fill(0).map(() => pc(pacifism, ['W'], 2)),
    ...Array(8).fill(0).map(() => pc(bolt, ['R'], 1)),
    ...Array(4).fill(0).map(() => pc(bears, ['G'], 2)),
    ...Array(3).fill(0).map(() => pc(growth, ['G'], 1)),
  ];
  assert.deepEqual(topColors(pool, r).sort(), ['R', 'W']);
  const built = autoBuild(pool, r);
  assert.equal(built.deck.main_deck.length, 40);
  assert.ok(built.mainCards.every((c) => c.colors.every((col) => col === 'W' || col === 'R')));
});

// ---------------------------------------------------------------------------
// Validation against human data (optional): Spearman rank correlation of the heuristic with 17Lands GIH WR,
// per set with a win-rate file, next to the rarity prior the bots used before. Results in
// analysis/results/card-quality.md.

function ranks(xs: number[]): number[] {
  const idx = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(xs.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    for (let k = i; k <= j; k++) r[idx[k]![1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}
function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i]! - ma) * (b[i]! - mb);
    saa += (a[i]! - ma) ** 2;
    sbb += (b[i]! - mb) ** 2;
  }
  return sab / Math.sqrt(saa * sbb);
}
const spearman = (a: number[], b: number[]) => pearson(ranks(a), ranks(b));

const slim = join(root, 'data', 'card-data.slim.json');
const pools = join(root, 'data', 'draft-pools.json');
if (process.argv.includes('--validate') && existsSync(slim) && existsSync(pools)) {
  const text = new Map<string, C>();
  for (const c of JSON.parse(readFileSync(slim, 'utf8')) as C[]) text.set(c.name.toLowerCase(), c);
  const sheets = JSON.parse(readFileSync(pools, 'utf8')) as Record<string, { sheets: Record<string, { cards: Array<{ name: string; rarity: string; type_line: string; cmc: number; colors: string[] }> }> }>;
  const rows: string[] = [];
  const setsRoot = join(root, 'sets');
  for (const code of readdirSync(setsRoot).filter((d) => existsSync(join(setsRoot, d, '17lands.json'))).sort()) {
    const gih = JSON.parse(readFileSync(join(setsRoot, code, '17lands.json'), 'utf8')).cards as Record<string, { gih_wr: number | null }>;
    const sheet = new Map<string, { rarity: string; type_line: string; cmc: number; colors: string[] }>();
    for (const s of Object.values(sheets[code.toLowerCase()]?.sheets ?? {})) for (const c of s.cards) sheet.set(c.name.split(' // ')[0]!.toLowerCase(), c);
    const h: number[] = [], prior: number[] = [], g: number[] = [];
    for (const [name, r] of Object.entries(gih)) {
      if (r.gih_wr == null) continue;
      const key = name.split(' // ')[0]!.toLowerCase();
      const s = sheet.get(key);
      const t = text.get(key) ?? text.get(name.toLowerCase());
      if (!s || /Basic Land/.test(s.type_line)) continue;
      h.push(cardQuality({ name, rarity: s.rarity, typeLine: t?.typeLine ?? s.type_line, cmc: s.cmc, colors: s.colors, ...(t ? { cost: t.cost, pt: t.pt, oracle: t.oracle } : {}) }));
      prior.push(({ mythic: 0.575, rare: 0.565, uncommon: 0.552, common: 0.54 } as Record<string, number>)[s.rarity] ?? 0.54);
      g.push(r.gih_wr);
    }
    if (g.length < 30) continue;
    rows.push(`| ${code} | ${g.length} | ${spearman(h, g).toFixed(2)} | ${spearman(prior, g).toFixed(2)} |`);
  }
  console.log('\n| Set | Cards | Heuristic ρ | Rarity prior ρ |\n|---|---|---|---|');
  console.log(rows.join('\n'));
}

console.log(`\n${passed} passed`);
