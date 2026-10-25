/**
 * Pack regeneration on each event's own booster generator (packages/director/src/boosters.ts BOOSTER_GENERATORS):
 * an event from before boosters-v2 still verifies after the generator change, and a log can't claim the other one.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BoosterFactory } from '../../director/src/boosters.js';
import { boosterProvenance } from '../../director/src/provenance.js';
import { Rng } from '../../director/src/rng.js';
import { regeneratePacks, type RegenInput } from '../src/packs.js';

const card = (name: string, rarity = 'common') => ({ name, rarity, weight: 1, colors: [], cmc: 1, type_line: 'Creature' });
const dir = mkdtempSync(join(tmpdir(), 'hub-packs-'));
const pools = join(dir, 'draft-pools.json');
writeFileSync(pools, JSON.stringify({
  tst: {
    code: 'TST', name: 'Test Set', release_date: '2026-01-01', basic_lands: [],
    pack_variants: [{ weight: 1, contents: [{ slot: 'common', count: 3, choices: [{ sheet: 'common', weight: 1 }] }, { slot: 'rare', count: 1, choices: [{ sheet: 'rare', weight: 1 }] }] }],
    sheets: {
      common: { cards: [card('Broken Common'), card('Alpha'), card('Beta'), card('Gamma')], total_weight: 4, allow_duplicates: false, fixed: false },
      rare: { cards: [card('Pyre Rhymer // Molten Tide', 'rare'), card('Bonecrusher // Stomp', 'rare')], total_weight: 2, allow_duplicates: false, fixed: false },
    },
  },
}));
const unsupportedFile = join(dir, 'unsupported.json');
const unsupported = ['Molten Tide', 'Broken Common'];
writeFileSync(unsupportedFile, JSON.stringify({ unsupported }));

/** An 8-agent event's draft as the Director opens it with this generator (seat shuffle, then 3 rounds of packs). */
function event(seed: string, generator: string): RegenInput {
  const rng = new Rng(seed);
  const positions = rng.shuffle([...Array(8).keys()]);
  const factory = new BoosterFactory(pools, unsupported, generator);
  const rounds = [1, 2, 3].map((round) => {
    const swaps: Array<{ from: string; to: string }> = [];
    const packs = [...Array(8)].map(() => factory.pack('tst', rng, swaps).map((c) => c.name));
    return { round, packs, swaps };
  });
  const names = positions.map((_, i) => `seat-${i + 1}`);
  const prov = boosterProvenance(pools, { file: unsupportedFile });
  return {
    seed, set: 'tst', seats: names.map((name, i) => ({ name, kind: 'agent', position: positions[i]! })), rounds, botDraws: new Map(),
    boosters: { ...prov, generator }, agentOrder: names,
  };
}

const data = { defaultDraftPools: pools, defaultUnsupported: unsupportedFile };

test('events regenerate exactly on their own generator, v1 and v2', () => {
  for (const generator of ['boosters-v1', 'boosters-v2']) {
    for (let i = 0; i < 10; i++) {
      const r = regeneratePacks(event(`seed-${generator}-${i}`, generator), data);
      assert.equal(r.status, 'verified', `${generator} seed ${i}: ${r.message}`);
    }
  }
});

test('a log from before generator ids regenerates as boosters-v1', () => {
  const inp = event('legacy', 'boosters-v1');
  const { generator: _g, ...rest } = inp.boosters!;
  const r = regeneratePacks({ ...inp, boosters: rest }, data);
  assert.equal(r.status, 'verified', r.message);
  assert.ok(r.missing?.includes('event_start.boosters.generator'));
});

test('packs opened by one generator and logged as the other are a mismatch; an unknown generator is unverifiable', () => {
  let mismatches = 0;
  for (let i = 0; i < 10; i++) {
    const inp = event(`swap-${i}`, 'boosters-v1');
    // The v1 packs can hold the unsupported back face and repeats; v2 never does.
    const claimed = regeneratePacks({ ...inp, boosters: { ...inp.boosters!, generator: 'boosters-v2' } }, data);
    if (claimed.status === 'mismatch') mismatches++;
    else assert.equal(claimed.status, 'verified');
  }
  assert.ok(mismatches > 0);
  const inp = event('x', 'boosters-v2');
  assert.equal(regeneratePacks({ ...inp, boosters: { ...inp.boosters!, generator: 'boosters-v9' } }, data).status, 'unverifiable');
});

test('a log from before booster provenance still verifies after the defaults changed: the archived data version is found', () => {
  // The event ran on the list in `unsupportedFile`; since then an engine upgrade (or a card override) changed the
  // hub's default list, and the old one is in the archive under its sha256.
  const archive = mkdtempSync(join(tmpdir(), 'hub-packs-archive-'));
  const oldBytes = readFileSync(unsupportedFile);
  writeFileSync(join(archive, `${createHash('sha256').update(oldBytes).digest('hex')}.json`), oldBytes);
  const newDefault = join(dir, 'unsupported-new.json');
  writeFileSync(newDefault, JSON.stringify({ unsupported: ['Molten Tide'] }));
  let exact = 0;
  for (let i = 0; i < 6; i++) {
    const inp = event(`pre-provenance-${i}`, 'boosters-v1');
    const legacy = { ...inp, boosters: undefined };
    const withoutArchive = regeneratePacks(legacy, { defaultDraftPools: pools, defaultUnsupported: newDefault });
    const r = regeneratePacks(legacy, { defaultDraftPools: pools, defaultUnsupported: newDefault, archiveDir: archive });
    assert.equal(r.status, 'verified', r.message);
    if (withoutArchive.status !== 'verified') exact++;
  }
  assert.ok(exact > 0, 'some of these events need the archived list (their swaps differ under the new default)');
});
