/**
 * Tests for the archetype build-quality computation (src/build-quality.ts, METHODOLOGY §5.2).
 *
 *   npm test -w @mtgdt/site          # or: npx tsx packages/site/src/build-quality.test.ts
 *
 * Synthetic cards and ratings only (no data/ files needed). The reference builder is checked against the
 * Director's own autoBuild on random pools.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoBuild } from '../../director/src/build.js';
import { Ratings as DirectorRatings } from '../../director/src/ratings.js';
import type { PackCard } from '../../director/src/boosters.js';
import {
  bestBuild, cardFacts, cardValue, deckQuality, expectedWinRate, readDeckNorms, referenceBuild, seatBuildQuality, structuralFlags,
  type DeckNorms, type QualityInputs,
} from './build-quality.js';
import { CardDb, loadRatings } from './data.js';
import { readArchetypes } from './inputs.js';
import { rng } from './rating.js';

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const near = (a: number | null | undefined, b: number, eps = 1e-9) => a != null && Math.abs(a - b) < eps;

// ---------------------------------------------------------------------------
// Synthetic set: card data, 17Lands ratings, archetype ratings, deck norms

const dir = mkdtempSync(join(tmpdir(), 'bq-test-'));
const setsDir = join(dir, 'sets');
mkdirSync(join(setsDir, 'TST'), { recursive: true });

interface Spec { name: string; cost: string; type: string; oracle?: string }
const specs: Spec[] = [
  { name: 'White Knight', cost: '{1}{W}', type: 'Creature — Human Knight' },
  { name: 'Blue Sage', cost: '{2}{U}', type: 'Creature — Human Wizard' },
  { name: 'Black Shade', cost: '{3}{B}{B}', type: 'Creature — Shade' },
  { name: 'Red Bolt', cost: '{R}', type: 'Instant' },
  { name: 'Azorius Charm', cost: '{W}{U}', type: 'Instant' },
  { name: 'Hybrid Spirit', cost: '{1}{W/U}', type: 'Creature — Spirit' },
  { name: 'Phyrexian Blade', cost: '{2}{W/P}', type: 'Artifact — Equipment' },
  { name: 'Clockwork', cost: '{3}', type: 'Artifact Creature — Construct' },
  { name: 'Big Wurm', cost: '{5}{G}{G}', type: 'Creature — Wurm' },
  { name: 'Tundra Gate', cost: '', type: 'Land', oracle: '{T}: Add {W} or {U}.' },
  { name: 'Prism Field', cost: '', type: 'Land', oracle: '{T}: Add one mana of any color.' },
  { name: 'Plains', cost: '', type: 'Basic Land — Plains', oracle: '({T}: Add {W}.)' },
  { name: 'Island', cost: '', type: 'Basic Land — Island', oracle: '({T}: Add {U}.)' },
  { name: 'Swamp', cost: '', type: 'Basic Land — Swamp', oracle: '({T}: Add {B}.)' },
  { name: 'Mountain', cost: '', type: 'Basic Land — Mountain', oracle: '({T}: Add {R}.)' },
  { name: 'Forest', cost: '', type: 'Basic Land — Forest', oracle: '({T}: Add {G}.)' },
];
// Filler commons for random pools: 12 per color, plus some gold and colorless.
const COLS = 'WUBRG';
for (const c of COLS) for (let i = 0; i < 12; i++) specs.push({ name: `${c} Common ${i}`, cost: `{${(i % 4) + 1}}{${c}}`, type: i % 3 ? 'Creature — Beast' : 'Sorcery' });
for (let i = 0; i < 10; i++) {
  const a = COLS[i % 5]!;
  const b = COLS[(i + 2) % 5]!;
  specs.push({ name: `Gold ${a}${b} ${i}`, cost: `{1}{${a}}{${b}}`, type: 'Creature — Avatar' });
}
for (let i = 0; i < 4; i++) specs.push({ name: `Relic ${i}`, cost: `{${i + 2}}`, type: 'Artifact' });
writeFileSync(join(dir, 'cards.json'), JSON.stringify(specs.map((s) => ({ name: s.name, cost: s.cost, typeLine: s.type, oracle: s.oracle ?? '' }))));
const cards = new CardDb(join(dir, 'cards.json'));

const rand = rng(42);
const gih: Record<string, number> = {};
for (const s of specs) if (!/Basic/.test(s.type)) gih[s.name] = Math.round((0.5 + rand() * 0.12) * 1e4) / 1e4;
gih['White Knight'] = 0.6;
gih['Blue Sage'] = 0.55;
gih['Azorius Charm'] = 0.58;
gih['Black Shade'] = 0.57;
writeFileSync(join(setsDir, 'TST', '17lands.json'), JSON.stringify({ set: 'TST', baseline_win_rate: 0.55, cards: Object.fromEntries(Object.entries(gih).map(([k, v]) => [k, { gih_wr: v }])) }));

// Archetype file: WU base 0.57, UB base 0.53, baseline 0.55. White Knight listed in WU at 0.62 (lift 0.60 on the set scale).
const archetypes = {
  set: 'TST', baseline_win_rate: 0.55,
  by_archetype_fields: ['gih_wr', 'gih_games', 'gp_wr', 'gp_games', 'iwd', 'gih_wr_raw'],
  archetypes: Object.fromEntries([...['WU', 'WB', 'WR', 'WG', 'UB', 'UR', 'UG', 'BR', 'BG', 'RG'].map((p) => [p, { win_rate: p === 'WU' ? 0.57 : p === 'UB' ? 0.53 : 0.55 }]), ['W', { win_rate: 0.55 }]]),
  cards: Object.fromEntries(
    Object.entries(gih).map(([name, g]) => {
      const by: Record<string, number[]> = {};
      if (name === 'White Knight') by.WU = [0.62, 2000, 0.6, 3000, 0.01, 0.63];
      if (name === 'Blue Sage') by.WU = [0.56, 2000, 0.55, 3000, 0.0, 0.56];
      if (name === 'Blue Sage') by.UB = [0.54, 1500, 0.53, 2000, 0.0, 0.54];
      if (name === 'Azorius Charm') by.WU = [0.59, 1500, 0.58, 2000, 0.0, 0.59];
      if (name === 'Clockwork') by.WU = [0.55, 900, 0.55, 1000, 0.0, 0.55];
      for (const [p, base] of [['WU', 0.57], ['UB', 0.53], ['WB', 0.55], ['RG', 0.55]] as const) if (!by[p]) by[p] = [g + base - 0.55, 300, g, 400, 0, g];
      return [name, { overall: { gih_wr: g }, by_archetype: by }];
    }),
  ),
};
writeFileSync(join(setsDir, 'TST', '17lands-archetypes.json'), JSON.stringify(archetypes));
const q5 = (a: number, b: number, c: number, d: number, e: number) => [a, b, c, d, e];
const normsJson = {
  set: 'TST',
  scoring: {
    baseline_win_rate: 0.55, splash_delta: -0.02, archetype_weight: 1, quality_ref: 0.56, slope_logit_per_pp: 0.15, pair_base_logit_per_pp: 0.05,
    validation: { auc_model: 0.56 }, verdict: 'validated',
  },
  pairs: {
    WU: { decks: 500, lands: q5(16, 17, 17, 17, 18), creatures: q5(12, 13, 15, 16, 17), two_minus: q5(5, 6, 7, 8, 9), five_plus: q5(1, 2, 3, 3, 4), avg_mv: q5(2.6, 2.8, 3.0, 3.1, 3.3), src_primary: q5(7, 8, 9, 9, 10), src_secondary: q5(6, 7, 8, 8, 9), src_splash: q5(2, 3, 3, 3, 4), replacement: 0.52 },
  },
};
writeFileSync(join(setsDir, 'TST', 'deck-norms.json'), JSON.stringify(normsJson));

const arch = readArchetypes(setsDir, 'TST')!;
const norms = readDeckNorms(setsDir, 'TST')!;
const ratings = loadRatings(setsDir, 'TST');
const inp: QualityInputs = { cards, arch, norms };

// ---------------------------------------------------------------------------
// 1. Card facts

{
  const h = cardFacts('Hybrid Spirit', cards);
  check('hybrid pips are not hard requirements', h.pips === '' && h.hybrid.length === 1 && h.hybrid[0] === 'WU' && h.colors === 'WU' && h.mv === 2);
  const p = cardFacts('Phyrexian Blade', cards);
  check('Phyrexian pips need no color but show it', p.pips === '' && p.hybrid.length === 0 && p.colors === 'W' && p.mv === 3);
  const g = cardFacts('Tundra Gate', cards);
  check('dual land produces both colors', g.land && g.produces === 'WU' && g.colors === '');
  check('"any color" land produces all five', cardFacts('Prism Field', cards).produces === 'WUBRG');
  check('basics by name', cardFacts('Swamp', cards).produces === 'B' && cardFacts('Swamp', cards).basic);
  check('creature flag and mana value', cardFacts('Black Shade', cards).creature && cardFacts('Black Shade', cards).mv === 5 && cardFacts('Black Shade', cards).pips === 'B');
}

// 2. Card values
{
  check('listed cell → lift on the set scale (0.62 − 0.57 + 0.55)', near(cardValue(inp, 'WU', 'White Knight', false, false), 0.6));
  check('unlisted cell → overall GIH WR', near(cardValue(inp, 'UR', 'Blue Sage', false, false), gih['Blue Sage']!));
  const ovRed = gih['Red Bolt']!;
  // Red Bolt has a WU cell (synthetic), so check the prior on a pair without a cell: UR has none.
  check('splash card without a cell → overall + splash_delta', near(cardValue(inp, 'UR', 'Black Shade', false, true), gih['Black Shade']! - 0.02));
  check('dead card → replacement level from deck-norms', near(cardValue(inp, 'WU', 'Red Bolt', true, true), 0.52), `overall ${ovRed}`);
  const half: QualityInputs = { ...inp, norms: { ...norms, archetypeWeight: 0.5 } };
  check('archetype weight blends lift and overall', near(cardValue(half, 'WU', 'White Knight', false, false), 0.5 * 0.6 + 0.5 * 0.6) && near(cardValue(half, 'WU', 'Blue Sage', false, false), 0.5 * (0.56 - 0.57 + 0.55) + 0.5 * 0.55));
  check('no value without archetype data for the card', cardValue(inp, 'WU', 'Unknown Card', false, false) == null);
}

// 3. Deck quality, dead and splash cards, shape
{
  const main = ['White Knight', 'Blue Sage', 'Azorius Charm', 'Clockwork', 'Red Bolt', 'Black Shade', 'Tundra Gate', 'Prism Field', ...Array(8).fill('Plains'), ...Array(7).fill('Island')];
  const q = deckQuality(main, 'WU', inp);
  // Red Bolt is castable off Prism Field → splash; Black Shade too (B from Prism Field).
  check('splash cards detected (source present, color outside the pair)', q.splash.includes('Red Bolt') && q.splash.includes('Black Shade') && q.dead.length === 0, `splash ${q.splash.join(', ')}`);
  const v = [0.6, 0.56 - 0.57 + 0.55, 0.59 - 0.57 + 0.55, 0.55 - 0.57 + 0.55, cardValue(inp, 'WU', 'Red Bolt', false, true)!, cardValue(inp, 'WU', 'Black Shade', false, true)!];
  check('quality = mean value of the non-land cards', near(q.quality, v.reduce((s, x) => s + x, 0) / v.length) && q.rated === 6);
  check('shape: lands, creatures, sources', q.shape.lands === 17 && q.shape.nonland === 6 && q.shape.creatures === 4 && q.shape.sources.W === 10 && q.shape.sources.U === 9 && q.shape.src_splash === 1);
  const noPrism = main.filter((n) => n !== 'Prism Field');
  const q2 = deckQuality(noPrism, 'WU', inp);
  check('a pip with no source makes the card dead (replacement value)', q2.dead.includes('Red Bolt') && q2.dead.includes('Black Shade'));
  const q3 = deckQuality(['Hybrid Spirit', ...Array(17).fill('Island')], 'WU', inp);
  check('hybrid castable from either color', q3.dead.length === 0 && q3.splash.length === 0);
  const q4 = deckQuality(['Hybrid Spirit', ...Array(17).fill('Swamp')], 'UB', inp);
  check('hybrid with neither color among the lands is dead', q4.dead.length === 1);
}

// 4. Expected win rate
{
  check('expected WR = baseline at the reference quality in a baseline-rate pair', near(expectedWinRate(inp, 'WB', 0.56), 0.55, 1e-12));
  const lo = expectedWinRate(inp, 'WB', 0.55)!;
  const hi = expectedWinRate(inp, 'WB', 0.57)!;
  check('expected WR increases with quality (slope 0.15 logit/pp)', lo < 0.55 && hi > 0.55 && near(Math.log(hi / (1 - hi)) - Math.log(lo / (1 - lo)), 0.3, 1e-9));
  check('archetype base-rate term (WU 0.57 > UB 0.53)', expectedWinRate(inp, 'WU', 0.56)! > expectedWinRate(inp, 'UB', 0.56)!);
  check('no calibration → null', expectedWinRate({ ...inp, norms: null }, 'WU', 0.56) == null);
}

// 5. Structural flags against the winners' norms
{
  const main = ['White Knight', 'Blue Sage', 'Azorius Charm', 'Red Bolt', ...Array(10).fill('Plains'), ...Array(10).fill('Island')];
  const q = deckQuality(main, 'WU', inp);
  const { checked, flags } = structuralFlags(q, norms);
  const f = new Set(flags.map((x) => x.check));
  check('lands above p90 flagged', f.has('lands_high') && !f.has('lands_low'));
  check('creatures and two-drops below p10 flagged', f.has('creatures_low') && f.has('two_drops_low'));
  check('uncastable splash flagged', f.has('uncastable_cards'));
  check('every norm with data is checked', checked.includes('primary_sources_low') && checked.includes('secondary_sources_low') && checked.includes('curve_high'));
  const none = structuralFlags(deckQuality(main, 'BR', inp), norms);
  check('no norms for the pair → only the norm-free checks (castability, ≥ 3 splash sources)', none.checked.every((c) => c === 'uncastable_cards' || c === 'splash_sources_low'), none.checked.join(', '));
}

// 6. Reference builder = the Director's autoBuild, on random pools
{
  const dirRatings = new DirectorRatings(setsDir, 'TST');
  const draftable = specs.filter((s) => !/Basic/.test(s.type));
  const r = rng(7);
  let same = 0;
  const N = 300;
  for (let t = 0; t < N; t++) {
    const pool: PackCard[] = [];
    for (let i = 0; i < 42; i++) {
      const s = r() < 0.03 ? specs.find((x) => x.name === ['Plains', 'Island', 'Forest'][i % 3])! : draftable[Math.floor(r() * draftable.length)]!;
      const f = cardFacts(s.name, cards);
      pool.push({ name: s.name, rarity: ['common', 'uncommon', 'rare'][i % 3]!, colors: f.land ? [] : f.colors.split('').filter(Boolean), cmc: f.mv, typeLine: s.type } as PackCard);
    }
    const a = autoBuild(pool, dirRatings, { get: (n: string) => ({ oracle: cards.get(n)?.oracle ?? '' }) } as any);
    const b = referenceBuild(pool.map((c) => c.name), ratings, cards, (n) => pool.find((c) => c.name === n)?.rarity);
    if ([...a.deck.main_deck].sort().join('|') === [...b.main].sort().join('|')) same++;
  }
  check('referenceBuild reproduces the Director autoBuild exactly', same === N, `${same}/${N} pools`);
}

// 7. Best deck and per-seat summary
{
  const pool = ['White Knight', 'Blue Sage', 'Azorius Charm', 'Clockwork', 'Hybrid Spirit', 'Black Shade', 'Red Bolt', 'Big Wurm', ...Array.from({ length: 12 }, (_, i) => `W Common ${i}`), ...Array.from({ length: 12 }, (_, i) => `U Common ${i}`)];
  const best = bestBuild(pool, inp)!;
  check('best deck is in the pool\'s deepest pair, with the norm\'s land count', best.pair === 'WU' && best.lands === 17 && best.spells.length === 23, `${best.pair} ${best.spells.length} spells`);
  check('best deck excludes uncastable cards', !best.spells.includes('Red Bolt') && !best.spells.includes('Black Shade') && !best.spells.includes('Big Wurm'));
  const ref = referenceBuild(pool, ratings, cards);
  const same = seatBuildQuality(ref.main, 'WU', pool, ratings, inp)!;
  check('a deck identical to the reference build has build_delta 0', near(same.build_delta_pp, 0) && same.reference_pair === 'WU');
  check('vs_best ≤ 0 for a two-color deck without splash', same.vs_best_pp != null && same.vs_best_pp <= 1e-9, `${same.vs_best_pp?.toFixed(3)} pp`);
  const val = (n: string) => cardValue(inp, 'WU', n, false, false) ?? 0;
  const top = [...ref.spells].sort((a, b) => val(b) - val(a))[0]!;
  const spare = pool.filter((n) => !ref.spells.includes(n) && cardFacts(n, cards).pips.split('').every((c) => 'WU'.includes(c))).sort((a, b) => val(a) - val(b))[0]!;
  const i = ref.main.indexOf(top);
  const worse = [...ref.main.slice(0, i), spare, ...ref.main.slice(i + 1)];
  const w = seatBuildQuality(worse, 'WU', pool, ratings, inp)!;
  check('swapping the best card for a worse one gives a negative build_delta', w.build_delta_pp != null && w.build_delta_pp < 0 && w.build_delta_wr_pp! < 0, `${w.build_delta_pp?.toFixed(3)} pp`);
  check('verdict carried from deck-norms.json', w.verdict === 'validated');
  const noNorms = seatBuildQuality(ref.main, 'WU', pool, ratings, { ...inp, norms: null as DeckNorms | null })!;
  check('without deck-norms.json: quality but no calibration, labeled unvalidated', noNorms.build_quality != null && noNorms.expected_wr == null && noNorms.verdict === 'unvalidated');
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
