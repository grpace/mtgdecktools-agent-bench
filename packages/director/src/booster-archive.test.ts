/**
 * Engine upgrades vs live events (docs/UPGRADING.md): the Director keeps every version of the booster data by hash,
 * and an event resumed after an upgrade regenerates its packs from the data it started on, not the new build's.
 *   npx tsx packages/director/src/booster-archive.test.ts   (the draft test needs data/draft-pools.json and data/card-data.json)
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { adjustForOverrides, archiveBoosterData, BoosterDataMissing, BoosterFactories, findArchived } from './booster-archive.js';
import { BoosterFactory } from './boosters.js';
import { CardDb } from './cards.js';
import { Draft, ResumeMismatch } from './draft.js';
import { resumeLog, type Raw } from './durable.js';
import { boosterProvenance } from './provenance.js';
import { Ratings } from './ratings.js';
import { Rng } from './rng.js';
import { AgentSeat } from './seat.js';

const root = resolve(import.meta.dirname, '../../..');
let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

const data = join(root, 'data');
const haveData = existsSync(join(data, 'draft-pools.json')) && existsSync(join(data, 'card-data.json'));

if (haveData) {
  // Two engine builds' booster data for FRA: the "upgrade" reorders the common sheet, so the same seed opens other packs.
  const dir = mkdtempSync(join(tmpdir(), 'booster-archive-'));
  const all = JSON.parse(readFileSync(join(data, 'draft-pools.json'), 'utf8'));
  const fra = all.fra ?? all.FRA;
  const oldPools = join(dir, 'old-draft-pools.json');
  const newPools = join(dir, 'new-draft-pools.json');
  writeFileSync(oldPools, JSON.stringify({ fra }));
  writeFileSync(newPools, JSON.stringify({ fra: { ...fra, sheets: { ...fra.sheets, common: { ...fra.sheets.common, cards: [...fra.sheets.common.cards].reverse() } } } }));
  const oldUnsupported = join(dir, 'old-unsupported.json');
  writeFileSync(oldUnsupported, JSON.stringify({ generated: 'x', unsupported: ['Some Card'] }));
  const oldProv = boosterProvenance(oldPools, { file: oldUnsupported });
  const newProv = boosterProvenance(newPools, { list: [] });
  const oldFactory = new BoosterFactory(oldPools, ['Some Card']);
  const newFactory = new BoosterFactory(newPools, []);
  const archive = join(dir, 'archive');

  await test('every start keeps its booster data by hash, once', () => {
    assert.deepEqual(archiveBoosterData(archive, oldPools, oldProv, { file: oldUnsupported }).sort(), [`${oldProv.draft_pools_sha256}.json`, `${oldProv.unsupported_sha256}.json`].sort());
    assert.deepEqual(archiveBoosterData(archive, oldPools, oldProv, { file: oldUnsupported }), [], 'already there');
    // A list from the card data's markers is kept as the JSON its hash names.
    archiveBoosterData(archive, newPools, newProv, { list: [] });
    assert.ok(findArchived([archive], newProv.unsupported_sha256), 'markers list archived under its hash');
    assert.equal(readdirSync(archive).filter((f) => f.includes('.tmp-')).length, 0);
    // A damaged copy is never used.
    writeFileSync(join(archive, `${'0'.repeat(64)}.json`), '{}');
    assert.equal(findArchived([archive], '0'.repeat(64)), undefined);
  });

  await test('a resumed event gets the data it started on; current data gives the current factory', () => {
    const f = new BoosterFactories({ factory: newFactory, boosters: newProv }, [archive]);
    assert.equal(f.forEvent(newProv), newFactory);
    assert.equal(f.forEvent(undefined), newFactory, 'events from before booster provenance: the current data');
    const old = f.forEvent(oldProv);
    assert.notEqual(old, newFactory);
    assert.equal(f.forEvent(oldProv), old, 'built once per data version');
    const swaps1: Array<{ from: string; to: string }> = [];
    const swaps2: Array<{ from: string; to: string }> = [];
    assert.deepEqual(old.pack('fra', new Rng('s'), swaps1).map((c) => c.name), oldFactory.pack('fra', new Rng('s'), swaps2).map((c) => c.name));
    assert.notDeepEqual(newFactory.pack('fra', new Rng('s'), []).map((c) => c.name), oldFactory.pack('fra', new Rng('s'), []).map((c) => c.name));
    assert.deepEqual(old.unsupportedNames(), ['some card']);
  });

  await test('booster data missing from the archive: the event fails to resume, with a reason', () => {
    const f = new BoosterFactories({ factory: newFactory, boosters: newProv }, [join(dir, 'empty')]);
    assert.throws(() => f.forEvent(oldProv), BoosterDataMissing);
  });

  await test("a draft resumed after an engine upgrade: the new build's packs differ, the archived data replays exactly", async () => {
    const cards = new CardDb(join(data, 'card-data.json'), data);
    const ratings = new Ratings(join(root, 'sets'), 'fra');
    const knowledge = { level: 'none' as const, stats: false };
    const bots = () => [...Array(8).keys()].map((i) => new AgentSeat(`bot-${i + 1}`, i, 'bot'));
    const records: Raw[] = [];
    await new Draft('fra', oldFactory, cards, ratings, bots(), new Rng('upgrade'), (type, x) => records.push({ t: 1, type, ...x }), knowledge).run();
    const replay = resumeLog(records).draft;
    await assert.rejects(new Draft('fra', newFactory, cards, ratings, bots(), new Rng('upgrade'), () => {}, knowledge, 3, replay).run(), ResumeMismatch);
    const archived = new BoosterFactories({ factory: newFactory, boosters: newProv }, [archive]).forEvent(oldProv);
    const again: Raw[] = [];
    await new Draft('fra', archived, cards, ratings, bots(), new Rng('upgrade'), (type, x) => again.push({ t: 1, type, ...x }), knowledge, 3, replay).run();
    assert.equal(again.filter((r) => r.type === 'packs_opened').length, 0, 'nothing logged twice: every pack matched the log');
  });
} else {
  console.log('skip: no data/draft-pools.json (npm run deps or CONTRIBUTING.md)');
}

{
  // A card override that makes a card supported (docs/CARD-OVERRIDES.md "Supported Cards and Packs"): new events stop
  // swapping it out, while an event that started on the old list regenerates exactly the packs it opened.
  const dir = mkdtempSync(join(tmpdir(), 'booster-overrides-'));
  const card = (name: string) => ({ name, rarity: 'common', weight: 1, colors: [], cmc: 1, type_line: 'Creature' });
  const pools = join(dir, 'draft-pools.json');
  writeFileSync(pools, JSON.stringify({
    tst: {
      code: 'TST', name: 'Test', release_date: '2026-01-01', basic_lands: [],
      pack_variants: [{ weight: 1, contents: [{ slot: 'common', count: 5, choices: [{ sheet: 'common', weight: 1 }] }] }],
      sheets: { common: { cards: ['Fixed Card', 'Still Broken', 'A', 'B', 'C', 'D', 'E', 'F'].map(card), total_weight: 8, allow_duplicates: false, fixed: false } },
    },
  }));
  const listFile = join(dir, 'unsupported-cards.json');
  const before = JSON.stringify({ generated: 'x', card_data_sha256: 'u'.repeat(64), unsupported: ['Still Broken', 'Fixed Card'] });
  writeFileSync(listFile, before);
  const archive = join(dir, 'archive');
  const open = (f: BoosterFactory, seed: string) => {
    const rng = new Rng(seed);
    const swaps: Array<{ from: string; to: string }> = [];
    return { packs: [...Array(8)].map(() => f.pack('tst', rng, swaps).map((c) => c.name)), swaps };
  };
  const oldProv = boosterProvenance(pools, { file: listFile });
  const oldPacks = open(new BoosterFactory(pools, ['Still Broken', 'Fixed Card']), 'ovr');
  assert.ok(oldPacks.swaps.some((s) => s.from === 'Fixed Card'), 'the old list swaps the card out');

  await test('an override that makes a card supported takes it off the list; the old list stays in the archive', () => {
    const adj = adjustForOverrides({ file: listFile }, ['Still Broken', 'Fixed Card'], ['Fixed Card'], archive)!;
    assert.deepEqual(adj.removed, ['Fixed Card']);
    assert.deepEqual(adj.unsupported, ['Still Broken']);
    assert.deepEqual(adj.source, { file: listFile }, 'rewritten in place');
    const doc = JSON.parse(readFileSync(listFile, 'utf8'));
    assert.deepEqual([doc.unsupported, doc.removed_by_overrides, doc.card_data_sha256], [['Still Broken'], ['Fixed Card'], 'u'.repeat(64)]);
    assert.equal(readFileSync(join(archive, `${createHash('sha256').update(before).digest('hex')}.json`), 'utf8'), before);
    assert.equal(adjustForOverrides({ file: listFile }, adj.unsupported, ['Fixed Card'], archive), undefined, 'idempotent');
    const fromMemory = adjustForOverrides({ list: ['Fixed Card', 'X'] }, ['Fixed Card', 'X'], ['Fixed Card'], archive)!;
    assert.deepEqual([fromMemory.unsupported, fromMemory.source], [['X'], { list: ['X'] }], 'a markers list is adjusted in memory');
  });

  await test('new events open the card; an event from before regenerates its own packs from the archived list', () => {
    const newFactory = new BoosterFactory(pools, ['Still Broken']);
    const newProv = boosterProvenance(pools, { file: listFile });
    assert.notEqual(newProv.unsupported_sha256, oldProv.unsupported_sha256, 'events record which list they ran on');
    const fresh = open(newFactory, 'ovr');
    assert.ok(!fresh.swaps.some((s) => s.from === 'Fixed Card') && fresh.packs.flat().includes('Fixed Card'));
    const replay = open(new BoosterFactories({ factory: newFactory, boosters: newProv }, [archive]).forEvent(oldProv), 'ovr');
    assert.deepEqual(replay, oldPacks, 'the same packs and swaps as the event logged');
  });

  await test('a retired or stale override puts its card back on the list', () => {
    const adj = adjustForOverrides({ file: listFile }, ['Still Broken'], [], archive)!;
    assert.deepEqual([adj.removed, adj.unsupported], [[], ['Fixed Card', 'Still Broken']]);
    assert.equal(JSON.parse(readFileSync(listFile, 'utf8')).removed_by_overrides, undefined);
  });
}

console.log(`\n${passed} passed`);
