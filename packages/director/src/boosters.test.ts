/**
 * Booster generation (boosters.ts): multi-face cards are checked face by face, a swap never repeats a card already in
 * its slot, and older events keep the generator they ran on (critic round 2, finding 5).
 *   npx tsx packages/director/src/boosters.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoosterFactories } from './booster-archive.js';
import { BoosterFactory } from './boosters.js';
import { BOOSTER_GENERATOR, boosterProvenance } from './provenance.js';
import { Rng } from './rng.js';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

const card = (name: string, rarity = 'common') => ({ name, rarity, weight: 1, colors: [], cmc: 1, type_line: 'Creature' });
const dir = mkdtempSync(join(tmpdir(), 'boosters-'));
const pools = join(dir, 'draft-pools.json');
writeFileSync(pools, JSON.stringify({
  tst: {
    code: 'TST', name: 'Test Set', release_date: '2026-01-01', basic_lands: [],
    pack_variants: [{ weight: 1, contents: [{ slot: 'common', count: 3, choices: [{ sheet: 'common', weight: 1 }] }, { slot: 'rare', count: 1, choices: [{ sheet: 'rare', weight: 1 }] }] }],
    sheets: {
      // One unsupported common, three supported ones: three commons per pack, never two of a kind.
      common: { cards: [card('Broken Common'), card('Alpha'), card('Beta'), card('Gamma')], total_weight: 4, allow_duplicates: false, fixed: false },
      // A prepare card whose spell face the engine can't run, and an adventure card that is fine.
      rare: { cards: [card('Pyre Rhymer // Molten Tide', 'rare'), card('Bonecrusher // Stomp', 'rare')], total_weight: 2, allow_duplicates: false, fixed: false },
    },
  },
}));
const unsupported = ['Molten Tide', 'Broken Common'];

test('the current generator is boosters-v2', () => {
  assert.equal(BOOSTER_GENERATOR, 'boosters-v2');
  assert.equal(new BoosterFactory(pools, unsupported).generator, 'boosters-v2');
  assert.throws(() => new BoosterFactory(pools, unsupported, 'boosters-v9'), /unknown booster generator/);
});

test('every face of a multi-face card is checked (v1 checked the front face only)', () => {
  const v2 = new BoosterFactory(pools, unsupported);
  const v1 = new BoosterFactory(pools, unsupported, 'boosters-v1');
  assert.equal(v2.isSupported('Pyre Rhymer // Molten Tide'), false);
  assert.equal(v1.isSupported('Pyre Rhymer // Molten Tide'), true, 'the old behavior, kept for old events');
  assert.equal(v2.isSupported('Bonecrusher // Stomp'), true);
  assert.equal(v2.isSupported('Molten Tide'), false);
  assert.equal(new BoosterFactory(pools, ['pyre rhymer // molten tide']).isSupported('Pyre Rhymer // Molten Tide'), false, 'the whole name, any case');
  for (let i = 0; i < 200; i++) {
    const swaps: Array<{ from: string; to: string }> = [];
    const pack = v2.pack('tst', new Rng(`face-${i}`), swaps);
    assert.ok(!pack.some((c) => c.name === 'Pyre Rhymer'), `seed face-${i}: an unsupported face reached a pack`);
    for (const s of swaps.filter((x) => x.from.startsWith('Pyre'))) assert.equal(s.to, 'Bonecrusher // Stomp');
  }
});

test('a swap never repeats a card already in its slot on a sheet without duplicates (v1 could)', () => {
  const v2 = new BoosterFactory(pools, unsupported);
  const v1 = new BoosterFactory(pools, unsupported, 'boosters-v1');
  let v1Repeats = 0;
  for (let i = 0; i < 500; i++) {
    const commons = (f: BoosterFactory) => f.pack('tst', new Rng(`dup-${i}`)).slice(0, 3).map((c) => c.name);
    const a = commons(v2);
    assert.equal(new Set(a).size, 3, `seed dup-${i}: v2 pack repeats a common: ${a.join(', ')}`);
    assert.ok(!a.includes('Broken Common'));
    if (new Set(commons(v1)).size < 3) v1Repeats++;
  }
  assert.ok(v1Repeats > 0, 'the fixture shows the v1 repeat');
});

test('an event resumes on the generator it started with (no generator logged: boosters-v1)', () => {
  const unsupportedFile = join(dir, 'unsupported.json');
  writeFileSync(unsupportedFile, JSON.stringify({ unsupported }));
  const prov = boosterProvenance(pools, { file: unsupportedFile });
  const current = new BoosterFactory(pools, unsupported);
  const f = new BoosterFactories({ factory: current, boosters: prov }, [dir]);
  assert.equal(f.forEvent(prov), current);
  const old = f.forEvent({ ...prov, generator: 'boosters-v1' });
  assert.equal(old.generator, 'boosters-v1');
  assert.equal(f.forEvent({ ...prov, generator: undefined }).generator, 'boosters-v1');
  assert.equal(f.forEvent({ ...prov, generator: 'boosters-v1' }), old, 'built once');
  const v1 = new BoosterFactory(pools, unsupported, 'boosters-v1');
  for (let i = 0; i < 20; i++) assert.deepEqual(old.pack('tst', new Rng(`r-${i}`)), v1.pack('tst', new Rng(`r-${i}`)));
});

console.log(`# ${passed} passed`);
