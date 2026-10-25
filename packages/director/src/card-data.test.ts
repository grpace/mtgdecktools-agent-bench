/**
 * event_start.provenance.card_data (docs/CARD-OVERRIDES.md): the hash of the card data phase-server runs, and the card
 * overrides applied to it only when the sidecar describes that exact file.
 *   npx tsx packages/director/src/card-data.test.ts
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cardDataProvenance, overridesFingerprint } from './cards.js';
import { provenance } from './provenance.js';

const dir = mkdtempSync(join(tmpdir(), 'mtgdt-card-data-'));
const file = join(dir, 'card-data.json');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`ok - ${name}`);
};

try {
  test('no sidecar: just the file hash', () => {
    writeFileSync(file, '{"a":1}\n');
    assert.deepEqual(cardDataProvenance(file), { sha256: sha('{"a":1}\n') });
  });

  test('a sidecar for this exact file: upstream hash, fingerprint and slugs', () => {
    writeFileSync(file, '{"a":2}\n');
    writeFileSync(join(dir, 'card-overrides.json'), JSON.stringify({
      format: 1, upstream_sha256: sha('{"a":1}\n'), sha256: sha('{"a":2}\n'), overrides_sha256: 'f'.repeat(64),
      overrides: [{ slug: 'heated-argument', card: 'Heated Argument', status: 'active', file_sha256: 'e'.repeat(64) }], skipped: [],
    }));
    assert.deepEqual(cardDataProvenance(file), {
      sha256: sha('{"a":2}\n'), upstream_sha256: sha('{"a":1}\n'), overrides_sha256: 'f'.repeat(64), overrides: ['heated-argument'],
    });
    const p = provenance(cardDataProvenance(file)) as { card_data?: { overrides?: string[] }; engine?: unknown };
    assert.deepEqual(p.card_data?.overrides, ['heated-argument'], 'provenance() carries it into event_start');
    assert.ok(p.engine, 'next to the engine pin');
  });

  test('a sidecar for another file (fresh upstream data copied over): stale, no overrides claimed', () => {
    writeFileSync(file, '{"a":3, "changed": true}\n');
    assert.deepEqual(cardDataProvenance(file), { sha256: sha('{"a":3, "changed": true}\n'), sidecar: 'stale' });
  });

  test("the override fingerprint matches scripts/card_overrides.py's", () => {
    const repo = fileURLToPath(new URL('../../../', import.meta.url));
    const py = execFileSync('python3', ['-I', '-c', [
      'import sys; sys.path.insert(0, "scripts"); import card_overrides as co',
      'print(co.fingerprint([o for o in co.load_overrides() if o["status"] in co.APPLIED]))',
      'print(",".join(o["_slug"] for o in co.load_overrides() if o["status"] in co.APPLIED))',
    ].join('\n')], { cwd: repo, encoding: 'utf8' }).trim().split('\n');
    const slugs = py[1] ? py[1].split(',') : [];
    assert.equal(overridesFingerprint(slugs), py[0]);
    assert.equal(overridesFingerprint([]), sha(''), 'the empty set');
    assert.equal(overridesFingerprint(['no-such-override']), null);
  });

  test('no card data: nothing to record', () => {
    assert.equal(cardDataProvenance(join(dir, 'missing.json')), undefined);
    assert.equal('card_data' in provenance(undefined), false);
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`${passed} passed`);
