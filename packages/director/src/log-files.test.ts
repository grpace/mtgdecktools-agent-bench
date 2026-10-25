/**
 * Event logs kept gzipped once the Hub has accepted the event (LAUNCH-CHECKLIST H-3), and every reader of a run folder
 * reading both forms.
 *   npx tsx packages/director/src/log-files.test.ts
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compressEventLog, compressHandedOff, eventLogSize, eventLogStream, handedOff, readEventLog, readEventLogTail } from './log-files.js';
import { needsHandoff } from './hub-handoff.js';
import { loadRuns } from '../../site/src/data.js';

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

const runs = mkdtempSync(join(tmpdir(), 'log-files-'));
const seats = [{ name: 'a', kind: 'agent', position: 0 }, { name: 'b', kind: 'agent', position: 1 }];
function run(id: string, handoff: Record<string, unknown> | null): string {
  const dir = join(runs, id);
  const lines = [
    { t: 1, type: 'event_start', id, set: { code: 'FRA', name: 'Final Fantasy' }, seed: 's', seats, boosters: { draft_pools_sha256: 'x' } },
    ...Array.from({ length: 2000 }, (_, i) => ({ t: 2 + i, type: 'decision_offered', seat: 'a', id: `G${i}`, text: 'x'.repeat(40) })),
    { t: 3000, type: 'event_end', standings: [] },
    ...(handoff ? [{ t: 3001, type: 'hub_handoff', ...handoff }] : []),
  ];
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({ id, standings: [] }));
  return dir;
}

await test('an accepted event is compressed; readers get the same bytes', async () => {
  const dir = run('2026-10-23-01-00-00-fra-aaaa', { attempt: 1, ok: true, status: 'ingested', final: true });
  const plain = readEventLog(dir);
  assert.ok(handedOff(dir));
  assert.equal(await compressEventLog(dir), true);
  assert.ok(!existsSync(join(dir, 'events.jsonl')) && existsSync(join(dir, 'events.jsonl.gz')));
  assert.equal(readEventLog(dir), plain);
  assert.equal(eventLogSize(dir), Buffer.byteLength(plain));
  assert.equal(readEventLogTail(dir, 200).split('\n').filter(Boolean).pop(), plain.trim().split('\n').pop());
  let streamed = '';
  for await (const c of eventLogStream(dir)!) streamed += c;
  assert.equal(streamed, plain);
  // Not compressed twice, and never resent to the Hub (it has it).
  assert.equal(await compressEventLog(dir), false);
  assert.equal(needsHandoff(dir), false);
});

await test('events the Hub has not accepted keep their plain log', async () => {
  const retry = run('2026-10-23-02-00-00-fra-bbbb', { attempt: 1, ok: false, status: 'error', final: false });
  const none = run('2026-10-23-03-00-00-fra-cccc', null);
  const rejected = run('2026-10-23-04-00-00-fra-dddd', { attempt: 1, ok: false, status: 'rejected', final: true });
  const done = await compressHandedOff(runs);
  assert.deepEqual(done, []);
  for (const d of [retry, none, rejected]) assert.ok(existsSync(join(d, 'events.jsonl')));
  assert.equal(needsHandoff(none), true, 'still to send');
});

await test("the site's loader (the Director's /data export) reads a gzipped run", () => {
  const { events } = loadRuns(runs, Date.now());
  assert.ok(events.some((e) => e.id === '2026-10-23-01-00-00-fra-aaaa'), 'the compressed run is listed');
  assert.equal(events.length, 4);
});

console.log(`\n${passed} passed`);
