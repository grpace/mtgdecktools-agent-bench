import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FsBundleStore, sha256 } from '../src/store.js';
import { bearer, newToken } from '../src/tokens.js';
import { parsePairs } from '../src/config.js';

test('bundle store: content-addressed, idempotent, verifies on read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-store-'));
  try {
    const s = new FsBundleStore(dir);
    const data = Buffer.from('hello bundle');
    const d = await s.put(data);
    assert.equal(d, sha256(data));
    assert.equal(await s.put(data), d, 'same bytes, same digest');
    assert.ok(await s.has(d));
    assert.deepEqual(await s.get(d), data);
    // Corruption on disk is detected, not served.
    const p = s.locate(d);
    chmodSync(p, 0o644);
    writeFileSync(p, 'tampered');
    await assert.rejects(() => s.get(d), /corruption/);
    assert.throws(() => s.locate('../etc/passwd'), /not a sha256/);
    await s.purge(d);
    assert.equal(await s.has(d), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tokens: random, scoped prefix, bearer parsing', () => {
  const a = newToken('submit');
  const b = newToken('submit');
  assert.match(a, /^mtgdt_sub_[\w-]{40}$/);
  assert.notEqual(a, b);
  assert.match(newToken('ingest'), /^mtgdt_ing_/);
  assert.equal(bearer(`Bearer ${a}`), a);
  assert.equal(bearer(undefined), '');
});

test('service token pairs: name:token, short tokens dropped', () => {
  assert.deepEqual(parsePairs('worker-1:abcdefghijklmnopqrstuvwxyz0123,bad:short'), [{ name: 'worker-1', token: 'abcdefghijklmnopqrstuvwxyz0123' }]);
});
