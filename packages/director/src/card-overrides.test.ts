/**
 * The JavaScript card-override apply (card-overrides.ts) and the hosted card-data stage (stage-card-data.ts): lossless
 * (64-bit integers, key order, escapes), the same patch semantics as scripts/card_overrides.py, and the same bytes.
 *   npx tsx packages/director/src/card-overrides.test.ts
 *   CARD_DATA_FILE=data/card-data.json npx tsx packages/director/src/card-overrides.test.ts   (also the real card data, byte for byte against Python)
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  adjustUnsupported, applyOverrides, applyPatch, entrySha256, fingerprint, loadOverrides, locateEntries, parseLossless, patchCardData, pristinePath, RawNum,
  serialize, type UnsupportedDoc,
} from './card-overrides.js';
import { cardDataProvenance, overrideSupported, overridesFingerprint } from './cards.js';
import { stage } from './stage-card-data.js';

const REPO = resolve(import.meta.dirname, '../../..');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const tmp = mkdtempSync(join(tmpdir(), 'mtgdt-card-overrides-'));
let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

/** Python's own apply (scripts/card_overrides.py build()) on a data dir, with the override files in `overridesDir`. */
function pythonApply(dataDir: string, overridesDir: string): Record<string, unknown> {
  const out = execFileSync('python3', ['-I', '-c', `
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[3])
import card_overrides as co
co.OVERRIDES = Path(sys.argv[1])
side = co.build(Path(sys.argv[2]), co.load_overrides())
print(json.dumps(side))
`, overridesDir, dataDir, join(REPO, 'scripts')], { encoding: 'utf8', maxBuffer: 1 << 26 });
  return JSON.parse(out.trim().split('\n').pop()!);
}
const comparable = (side: Record<string, unknown>) => {
  const { _comment, ...rest } = side;
  void _comment;
  return rest;
};

// A small card-data.json in phase-rs's own form (compact UTF-8, one trailing newline) with what breaks naive JSON:
// 64-bit integers, a numeric-string key (JavaScript objects would move it first), escapes and braces inside strings,
// non-ASCII text, and the overridden card in the middle.
const ENTRY = {
  name: 'Test Bolt',
  id: 18446744073709551615n,
  abilities: [{ kind: 'Spell', effect: { type: 'DealDamage', amount: { type: 'Fixed', value: 3 }, target: { type: 'Any' } }, sub_ability: null, note: 'quote " brace } é ✓' }],
  by_slot: { 10: 'ten', 2: 'two', z: 1, a: 2 },
};
function rawJson(v: unknown): string {
  // Insertion-ordered, BigInt-aware compact JSON for the fixture (numeric keys written in the order given).
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return `[${v.map(rawJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const entries = v instanceof Map ? [...v] : Object.entries(v);
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${rawJson(x)}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
const slotMap = new Map<string, unknown>([['10', 'ten'], ['2', 'two'], ['z', 1], ['a', 2]]);
const entryText = rawJson({ ...ENTRY, by_slot: slotMap });
const FIXTURE = `{"aardvark":{"name":"Aardvark","id":9223372036854775807,"t":"{\\"x\\":1}"},"test bolt":${entryText},"zebra":{"name":"Zébra","ids":[18446744073709551615,0,-1]}}\n`;

function fixtureOverride(dir: string, patch: unknown[], o: Record<string, unknown> = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'test-bolt.json'), `${JSON.stringify({
    card: 'Test Bolt', status: 'active', kind: 'parser', upstream_issue: null,
    applies_to: { server_version: '0.0.0', build_commit: 'test', card_data_sha256: sha(FIXTURE), entry_sha256: entrySha256(parseLossless(entryText)) },
    rules: { oracle: 'Test Bolt deals 3 damage to any target.', cr: ['120.3'] }, patch,
    tests: [{ name: 'bug', expect: { fixed: { life: [20, 17] }, bug: { life: [20, 18] } } }], ...o,
  }, null, 2)}\n`);
}
const PATCH = [
  { op: 'test', path: '/abilities/0/effect/amount/value', value: 3 },
  { op: 'replace', path: '/abilities/0/effect/amount', value: { type: 'Fixed', value: 4 } },
  { op: 'add', path: '/abilities/0/flags', value: ['fixed', 'by test'] },
  { op: 'remove', path: '/by_slot/2' },
  { op: 'copy', from: '/name', path: '/printed_name' },
  { op: 'move', from: '/by_slot/z', path: '/by_slot/zz' },
];

try {
  await test('lossless parse and serialize: 64-bit integers, key order with numeric keys, escapes, non-ASCII', () => {
    const v = parseLossless(FIXTURE);
    assert.equal(`${serialize(v)}\n`, FIXTURE, 'parse + serialize reproduces the file byte for byte');
    const bolt = (v as Map<string, any>).get('test bolt');
    assert.ok(bolt.get('id') instanceof RawNum);
    assert.equal(bolt.get('id').raw, '18446744073709551615', 'never rounded to 18446744073709552000');
    assert.deepEqual([...bolt.get('by_slot').keys()], ['10', '2', 'z', 'a'], 'numeric keys keep their place');
    assert.equal(serialize(bolt.get('by_slot'), true), '{"10":"ten","2":"two","a":2,"z":1}', 'canonical: sorted by code point');
  });

  await test('locating entries in the raw bytes: braces and quotes inside strings never confuse it', () => {
    const buf = Buffer.from(FIXTURE);
    const spans = locateEntries(buf, new Set(['test bolt', 'zebra', 'missing']));
    assert.equal(buf.toString('utf8', ...spans.get('test bolt')!), entryText);
    assert.equal(buf.toString('utf8', ...spans.get('zebra')!), '{"name":"Zébra","ids":[18446744073709551615,0,-1]}');
    assert.equal(spans.has('missing'), false);
  });

  await test('entry_sha256 is the Python canonical hash', () => {
    const py = execFileSync('python3', ['-I', '-c', 'import json,sys,hashlib; e=json.loads(sys.argv[1]); print(hashlib.sha256(json.dumps(e, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest())', entryText], { encoding: 'utf8' }).trim();
    assert.equal(entrySha256(parseLossless(entryText)), py);
  });

  await test('patch semantics as Python: replace moves an object member last, test guards, integers only', () => {
    const e = parseLossless('{"a":1,"b":{"c":[1,2,3]},"d":4}');
    assert.equal(serialize(applyPatch(e, [{ op: 'replace', path: '/a', value: new RawNum('9') }])), '{"b":{"c":[1,2,3]},"d":4,"a":9}');
    assert.equal(serialize(applyPatch(e, [{ op: 'replace', path: '/b/c/1', value: new RawNum('7') }])), '{"a":1,"b":{"c":[1,7,3]},"d":4}', 'a list item stays in place');
    assert.equal(serialize(applyPatch(e, [{ op: 'add', path: '/b/c/-', value: new RawNum('5') }])), '{"a":1,"b":{"c":[1,2,3,5]},"d":4}');
    assert.equal(serialize(e), '{"a":1,"b":{"c":[1,2,3]},"d":4}', 'the input is never changed');
    assert.throws(() => applyPatch(e, [{ op: 'test', path: '/a', value: new RawNum('2') }]), /test failed at \/a/);
    assert.throws(() => applyPatch(e, [{ op: 'remove', path: '/nope' }]), /not found/);
    assert.throws(() => applyPatch(e, [{ op: 'add', path: '/x', value: new RawNum('1.5') }]), /isn't an integer/);
  });

  await test('apply on the fixture: byte-identical to scripts/card_overrides.py, every other byte untouched', () => {
    const ovr = join(tmp, 'fx-overrides');
    fixtureOverride(ovr, PATCH);
    const js = join(tmp, 'fx-js');
    const py = join(tmp, 'fx-py');
    for (const d of [js, py]) {
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'card-data.json'), FIXTURE);
    }
    const side = applyOverrides(js, loadOverrides(ovr));
    const pySide = pythonApply(py, ovr);
    const out = readFileSync(join(js, 'card-data.json'));
    assert.equal(out.toString('utf8'), readFileSync(join(py, 'card-data.json'), 'utf8'), 'the same card-data.json as Python');
    assert.deepEqual(comparable(side as unknown as Record<string, unknown>), comparable(pySide), 'the same sidecar (but its comment)');
    assert.equal(side.overrides.map((o) => o.slug).join(), 'test-bolt');
    assert.ok(out.toString('utf8').startsWith('{"aardvark":{"name":"Aardvark","id":9223372036854775807,'), 'other cards untouched');
    assert.ok(out.toString('utf8').endsWith('"zebra":{"name":"Zébra","ids":[18446744073709551615,0,-1]}}\n'));
    assert.match(out.toString('utf8'), /"id":18446744073709551615,/);
    assert.equal(readFileSync(join(js, 'card-data.upstream.json'), 'utf8'), FIXTURE, 'the pristine upstream file kept beside it');
    // The Director's record of it: the hash of the file and, from the sidecar, the upstream hash and the fingerprint.
    const prov = cardDataProvenance(join(js, 'card-data.json'));
    assert.deepEqual(prov, { sha256: sha(out), upstream_sha256: sha(FIXTURE), overrides_sha256: side.overrides_sha256, overrides: ['test-bolt'] });
    assert.equal(overridesFingerprint(['test-bolt'], ovr), side.overrides_sha256, 'the Hub-side fingerprint agrees');
    // Again: deterministic, reads the pristine copy (not its own output), rewrites nothing.
    const mtime = statSync(join(js, 'card-data.json')).mtimeMs;
    assert.equal(pristinePath(js), join(js, 'card-data.upstream.json'));
    assert.deepEqual(applyOverrides(js, loadOverrides(ovr)), side);
    assert.equal(statSync(join(js, 'card-data.json')).mtimeMs, mtime);
  });

  await test('marks_supported: the sidecar names the card (as Python), and the unsupported list loses it (as Python)', () => {
    const ovr = join(tmp, 'fx-supported');
    fixtureOverride(ovr, PATCH, { marks_supported: true });
    const js = join(tmp, 'fx-sup-js');
    const py = join(tmp, 'fx-sup-py');
    for (const d of [js, py]) {
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'card-data.json'), FIXTURE);
    }
    const side = applyOverrides(js, loadOverrides(ovr));
    const pySide = pythonApply(py, ovr);
    assert.deepEqual(side.supported, ['Test Bolt']);
    assert.deepEqual(comparable(side as unknown as Record<string, unknown>), comparable(pySide), 'the same sidecar as Python');
    assert.deepEqual(overrideSupported(join(js, 'card-data.json')), ['Test Bolt'], 'the Director reads it from a sidecar for this file');
    writeFileSync(join(js, 'card-overrides.json'), JSON.stringify({ ...side, sha256: '0'.repeat(64) }));
    assert.deepEqual(overrideSupported(join(js, 'card-data.json')), [], 'a sidecar for another file supports nothing');
    // The list adjustment agrees with card_overrides.py adjust_unsupported, both ways.
    const cases: Array<[UnsupportedDoc, string[]]> = [
      [{ generated: 'x', unsupported: ['Zeta', 'alpha', 'Test Bolt', 'Kíli the Resourceful', 'Molten Tide'] }, ['test bolt', 'Kíli the Resourceful', 'Absent']],
      [{ unsupported: ['B', 'a'], removed_by_overrides: ['Test Bolt'] }, []],
      [{ unsupported: ['B', 'a'], removed_by_overrides: ['Test Bolt'] }, ['Test Bolt']],
      [{ unsupported: ['B', 'a'] }, []],
    ];
    for (const [doc, sup] of cases) {
      const py = JSON.parse(execFileSync('python3', ['-I', '-c', `
import json, sys
sys.path.insert(0, sys.argv[3])
import card_overrides as co
print(json.dumps(co.adjust_unsupported(json.loads(sys.argv[1]), json.loads(sys.argv[2]))))
`, JSON.stringify(doc), JSON.stringify(sup), join(REPO, 'scripts')], { encoding: 'utf8' }));
      const js = adjustUnsupported(doc, sup);
      assert.deepEqual([js.doc, js.changed], py, `${JSON.stringify(doc)} with ${JSON.stringify(sup)}`);
    }
  });

  await test('a stale override (upstream changed the card) is skipped and reported, never applied; no override = the upstream bytes', () => {
    const ovr = join(tmp, 'fx-stale');
    fixtureOverride(ovr, PATCH, { applies_to: { server_version: '0.0.0', build_commit: 'test', card_data_sha256: 'x', entry_sha256: '0'.repeat(64) } });
    const r = patchCardData(Buffer.from(FIXTURE), loadOverrides(ovr));
    assert.equal(r.out.toString('utf8'), FIXTURE);
    assert.equal(r.applied.length, 0);
    assert.match(r.skipped[0]!.reason, /^stale: upstream changed Test Bolt/);
    const retired = join(tmp, 'fx-retired');
    fixtureOverride(retired, PATCH, { status: 'retired' });
    assert.equal(patchCardData(Buffer.from(FIXTURE), loadOverrides(retired)).out.toString('utf8'), FIXTURE);
    assert.equal(fingerprint([]), sha(''), 'no overrides: sha256 of nothing, as Python');
  });

  await test('the stage: offline from the volume, pinned hashes checked, overrides applied, idempotent', async () => {
    // A repository with the fixture pinned (lock + manifest) and its override, and a volume holding the pinned files.
    const repo = join(tmp, 'repo');
    mkdirSync(join(repo, 'engine'), { recursive: true });
    mkdirSync(join(repo, 'deps'), { recursive: true });
    fixtureOverride(join(repo, 'engine/overrides'), PATCH);
    const pools = '{"sets":{}}\n';
    writeFileSync(join(repo, 'engine/phase.lock.json'), JSON.stringify({ server_version: '0.0.0' }));
    writeFileSync(join(repo, 'deps/manifest.json'), JSON.stringify({ phase_rs: { data: { card_data: { sha256: sha(FIXTURE) }, booster_data: { sha256: sha(pools) } } } }));
    const vol = join(tmp, 'volume');
    mkdirSync(vol);
    writeFileSync(join(vol, 'card-data.json'), FIXTURE);
    writeFileSync(join(vol, 'draft-pools.json'), pools);
    const r = await stage(vol, { offline: true, repo });
    assert.deepEqual([r.upstream, r.overrides, r.skipped, r.downloaded], [sha(FIXTURE), ['test-bolt'], 0, []]);
    assert.equal(sha(readFileSync(join(vol, 'card-data.json'))), r.sha256);
    const again = await stage(vol, { offline: true, repo });
    assert.equal(again.sha256, r.sha256, 'a restart stages the same file');
    // Wrong booster data in the volume: refused offline (online it would be replaced by the pinned download).
    writeFileSync(join(vol, 'draft-pools.json'), '{"other":1}\n');
    await assert.rejects(stage(vol, { offline: true, repo }), /draft-pools\.json .* forbids a download/);
  });

  const real = process.env.CARD_DATA_FILE;
  if (real) {
    await test(`the real card data (${real}): JavaScript and Python write the same bytes; Heated Argument is patched`, () => {
      const src = pristinePath(resolve(real, '..'));
      const js = join(tmp, 'real-js');
      const py = join(tmp, 'real-py');
      for (const d of [js, py]) {
        mkdirSync(d, { recursive: true });
        copyFileSync(src, join(d, 'card-data.json'));
      }
      const side = applyOverrides(js, loadOverrides(join(REPO, 'engine/overrides')));
      const pySide = pythonApply(py, join(REPO, 'engine/overrides'));
      assert.ok(side.overrides.some((o) => o.slug === 'heated-argument'), `heated-argument applied (skipped: ${JSON.stringify(side.skipped)})`);
      assert.equal(sha(readFileSync(join(js, 'card-data.json'))), sha(readFileSync(join(py, 'card-data.json'))), 'byte for byte');
      assert.deepEqual(comparable(side as unknown as Record<string, unknown>), comparable(pySide));
      console.log(`   upstream ${side.upstream_sha256.slice(0, 12)} -> ${side.sha256.slice(0, 12)} (overrides ${side.overrides_sha256.slice(0, 12)})`);
    });
  } else console.log('skip - the real card data (set CARD_DATA_FILE=data/card-data.json)');

  if (!existsSync(join(REPO, 'engine/overrides'))) throw new Error('engine/overrides is missing');
  console.log(`\n${passed} card-overrides tests passed`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
