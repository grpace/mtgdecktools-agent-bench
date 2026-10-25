/**
 * End-to-end assertions against a running hub (started by test/e2e.sh, which also provides Postgres, a
 * smoke-event bundle and the tokens). Every step prints PASS or throws.
 *
 * Env: HUB_URL, HUB_E2E_BUNDLE, HUB_ADMIN_TOKEN, HUB_E2E_SERVICE_TOKEN, DATABASE_URL, HUB_DATA_DIR
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { unpackTarGz } from '../../director/src/submissions.js';
import { forgeFirstPick, pack, rewrite, root } from './helpers.js';

const env = process.env;
const base = env.HUB_URL!;
const admin = env.HUB_ADMIN_TOKEN!;
const service = env.HUB_E2E_SERVICE_TOKEN!;
const bundle = readFileSync(env.HUB_E2E_BUNDLE!);
const files = unpackTarGz(bundle);
const eventId = JSON.parse(files.get('bundle.json')!.toString('utf8')).event_id as string;
const setCode = JSON.parse(files.get('events.jsonl')!.toString('utf8').split('\n', 1)[0]!).set.code as string;

const pass = (m: string) => console.log(`PASS ${m}`);
const cli = (...args: string[]) => execFileSync('npx', ['tsx', 'packages/hub/src/cli.ts', ...args], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
async function req(path: string, init: RequestInit = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body, headers: res.headers };
}
const post = (path: string, data: Buffer, token: string) => req(path, { method: 'POST', headers: { ...auth(token), 'Content-Type': 'application/gzip' }, body: new Uint8Array(data) });
async function until<T>(what: string, f: () => Promise<T | undefined>, seconds = 60): Promise<T> {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    const v = await f();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function main() {
  const health = (await req('/health')).body;
  assert.equal(health.ok, true);
  assert.ok(typeof health.version === 'string' && health.version.length > 0, 'health reports the build version');
  pass('health');

  cli('contributor', 'add', 'alice');
  cli('contributor', 'add', 'bob');
  const alice = cli('token', 'issue', 'alice');
  const bob = cli('token', 'issue', 'bob');
  assert.match(alice, /^mtgdt_sub_/);
  pass('CLI: contributors alice and bob, tokens issued (shown once)');

  assert.equal((await post('/api/submissions', bundle, 'not-a-token-not-a-token-x')).status, 401);
  assert.equal((await post('/api/internal/events', bundle, alice)).status, 401, 'a submit token cannot use the director path');
  pass('auth: bad token 401; submit token rejected on the internal path');

  // Terms: uploads are refused until the contributor accepts the current version (what `bench login` does).
  const refused = await post('/api/submissions', bundle, alice);
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /terms/);
  const terms = (await req('/api/terms')).body;
  assert.ok(terms.version && terms.summary.length >= 4 && terms.links.terms, 'the public summary and links');
  assert.equal((await req('/legal/terms')).status, 200);
  for (const t of [alice, bob]) {
    const ok = await req('/api/account/terms', { method: 'POST', headers: { ...auth(t), 'Content-Type': 'application/json' }, body: JSON.stringify({ version: terms.version }) });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.accepted, true);
  }
  pass('terms: uploads refused until accepted; accepted through the API');

  // Submit with the community CLI, exactly as a contributor would.
  const out = execFileSync('npx', ['tsx', 'scripts/bench/cli.ts', 'submit', env.HUB_E2E_BUNDLE!, '--to', base, '--token', alice], { cwd: root, encoding: 'utf8' });
  assert.match(out, /^held: event /m, out);
  assert.match(out, /review\.new_contributor/);
  assert.match(out, /pack regeneration: (verified|partial)/, out);
  pass(`bench submit → held for new-contributor review; ${/pack regeneration: (\w+)/.exec(out)![1]} pack regeneration`);

  const mine = (await req('/api/submissions', { headers: auth(alice) })).body as any[];
  assert.equal(mine.length, 1);
  const s1 = mine[0].submission_id as number;
  const st = (await req(`/api/submissions/${s1}`, { headers: auth(alice) })).body;
  assert.equal(st.status, 'held');
  assert.equal(st.id, eventId);
  assert.equal(st.label, 'smoke');
  for (const id of ['draft.consistency', 'draft.decks', 'games.consistency']) assert.equal(st.checks.find((c: any) => c.id === id)?.outcome, 'pass', id);
  assert.ok(['verified', 'partial'].includes(st.pack_regeneration.status));
  assert.equal((await req(`/api/submissions/${s1}`, { headers: auth(bob) })).status, 404, 'bob cannot see alice\'s submission');
  pass(`status API: submission ${s1} held, integrity checks pass, private to its contributor`);

  const dup = await post('/api/submissions', bundle, alice);
  assert.equal(dup.status, 409);
  pass('duplicate bundle → 409');

  assert.equal((await req(`/data/events/${eventId}.json`)).status, 404);
  pass('held submissions are not exported');

  cli('approve', String(s1), '--note', 'e2e');
  const evFile = await until('the event export', async () => {
    const r = await req(`/data/events/${eventId}.json`);
    return r.status === 200 ? r : undefined;
  });
  assert.equal(evFile.body.schema_version, 2);
  assert.equal(evFile.body.event.source, 'smoke');
  // The export never names the uploader, nor carries the Hub's raw contributor id (PTS-4).
  assert.equal(evFile.body.config.source.submitter, undefined);
  assert.ok(!JSON.stringify(evFile.body).includes('"submitter'), 'no submitter or submitter_id in the export');
  assert.equal(evFile.headers.get('access-control-allow-origin'), '*');
  assert.match(evFile.headers.get('cache-control') ?? '', /max-age=\d+/);
  const index = (await req('/data/index.json')).body;
  assert.ok(index.events.some((e: any) => e.id === eventId), 'index lists the event');
  // summary.json: what Home reads without the index, written with it.
  const summary = (await req('/data/summary.json')).body;
  assert.ok(summary.recent_events.some((e: any) => e.id === eventId), 'summary.json lists the event');
  assert.equal(summary.main_board, index.main_board);
  assert.equal((await req(`/data/sets/${setCode.toUpperCase()}.json`)).status, 200);
  assert.equal((await req(`/data/events/${eventId}/game-1.json`)).status, 200);
  const seat = evFile.body.config.seats[0].name;
  assert.equal((await req(`/data/events/${eventId}/draft-${seat}.json`)).status, 200);
  pass('CLI approve → ingested; server re-exported (event, drafts, games, set, index) via NOTIFY');

  const etag = evFile.headers.get('etag')!;
  assert.equal((await fetch(`${base}/data/events/${eventId}.json`, { headers: { 'If-None-Match': etag } })).status, 304);
  const gz = await fetch(`${base}/data/index.json`, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(gz.headers.get('content-encoding'), 'gzip');
  pass('/data: ETag → 304, gzip, CORS, Cache-Control');

  // Path traversal and malformed paths under /data (fetch would normalize ../, so these are pre-encoded).
  for (const p of ['/data/..%2f..%2fpackage.json', '/data/%2e%2e/%2e%2e/package.json', '/data/events/..%2F..%2F..%2Fetc%2Fpasswd', '/data/%E0%A4%A', '/data/index.json%00.txt']) {
    assert.equal((await req(p)).status, 404, p);
  }
  assert.equal(evFile.headers.get('x-content-type-options'), 'nosniff');
  pass('/data: traversal and malformed paths → 404; nosniff');

  // The open dataset (docs/OPEN-DATA.md): built by a separate process (here the CLI; the server's nightly schedule
  // starts the same job), served as static files with long cache headers and Range support.
  assert.equal((await req('/data/open/latest.json')).status, 404, 'no open data before the first build');
  cli('open-data', 'build');
  const latest = await req('/data/open/latest.json');
  assert.equal(latest.status, 200);
  assert.equal(latest.body.license.id, 'CC-BY-4.0');
  assert.equal(latest.headers.get('cache-control'), 'public, max-age=300');
  assert.match(latest.body.snapshot.file, /^snapshots\/agent-bench-data-\d{4}-\d{2}-\d{2}\.zip$/);
  const zipUrl = `${base}/data/open/${latest.body.snapshot.file}`;
  const head = await fetch(zipUrl, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(latest.body.snapshot.bytes));
  assert.equal(head.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(head.headers.get('accept-ranges'), 'bytes');
  assert.equal(head.headers.get('content-type'), 'application/zip');
  assert.match(head.headers.get('content-disposition') ?? '', /^attachment; filename="agent-bench-data-/);
  const part = await fetch(zipUrl, { headers: { Range: 'bytes=0-3', 'Accept-Encoding': 'gzip' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 0-3/${latest.body.snapshot.bytes}`);
  assert.equal(part.headers.get('content-encoding'), null, 'compressed files are never compressed again');
  assert.deepEqual([...new Uint8Array(await part.arrayBuffer())], [0x50, 0x4b, 0x03, 0x04], 'a zip starts with PK\\x03\\x04');
  const tail = await fetch(zipUrl, { headers: { Range: 'bytes=-22' } });
  assert.equal(tail.status, 206);
  assert.equal((await tail.arrayBuffer()).byteLength, 22);
  assert.equal((await fetch(zipUrl, { headers: { Range: `bytes=${latest.body.snapshot.bytes + 10}-` } })).status, 416);
  const full = await fetch(zipUrl);
  const { createHash } = await import('node:crypto');
  assert.equal(createHash('sha256').update(new Uint8Array(await full.arrayBuffer())).digest('hex'), latest.body.snapshot.sha256, 'the zip matches its checksum');
  assert.equal((await fetch(zipUrl, { headers: { 'If-None-Match': head.headers.get('etag')! } })).status, 304);
  const folder = await fetch(`${base}/data/open`, { redirect: 'manual' });
  assert.equal(folder.status, 302, 'the citation address leads to latest.json');
  assert.equal(folder.headers.get('location'), '/data/open/latest.json');
  const card = await fetch(`${base}/data/open/DATASET.md`);
  assert.match(await card.text(), /Updated nightly/);
  const parquet = await fetch(`${base}/data/open/${latest.body.tables.picks.parquet.path}`, { method: 'HEAD' });
  assert.equal(parquet.headers.get('content-type'), 'application/vnd.apache.parquet');
  assert.equal(cli('open-data', 'build').includes('skipped'), true, 'an unchanged build is skipped');
  pass(`/data/open: CLI build, latest.json, snapshot ${latest.body.snapshot.size} (Range 206/416, HEAD, ETag 304, immutable cache, checksum), unchanged → skipped`);

  const list = (await req('/api/events')).body as any[];
  assert.ok(list.some((e) => e.id === eventId && ['verified', 'partial'].includes(e.pack_regen)));
  const detail = (await req(`/api/events/${eventId}`)).body;
  assert.equal(detail.seats.length, 8);
  assert.ok(detail.games.length >= 1);
  assert.equal(detail.decks.length, detail.seats.filter((s: any) => s.kind === 'agent').length);
  assert.equal(detail.submission.status, 'ingested');
  // US spelling (migration 005), with the old names for one release.
  assert.ok(detail.seats.every((s: any) => 'final_colors' in s && s.final_colours === s.final_colors));
  assert.ok(detail.decks.every((d: any) => 'colors' in d && d.colours === d.colors));
  // The export carries both spellings too (docs/SITE-DATA.md "Deprecated keys").
  const cardInfo = Object.values(evFile.body.cards ?? {})[0] as any;
  if (cardInfo) assert.ok('colors' in cardInfo && cardInfo.colours === cardInfo.colors, 'export: colors and the deprecated colours');
  pass(`read API: /api/events and /api/events/:id from Postgres (${detail.games.length} games, ${detail.decks.length} decks)`);

  // Tampering 1: edit the log without updating the manifest.
  const t1 = pack(rewrite(files, (ev) => void (ev.find((e) => e.type === 'game_over')!.winner = null), false));
  const r1 = await post('/api/submissions', t1, alice);
  assert.equal(r1.status, 400, JSON.stringify(r1.body));
  assert.equal(r1.body.status, 'rejected');
  assert.ok(r1.body.reasons.some((r: any) => /sha256 mismatch/.test(r.message)));
  pass('tampered bundle (hash mismatch) → 400 rejected');

  // Tampering 2: a consistent forgery — a better first pick, re-hashed, under a new event id.
  const t2 = pack(rewrite(files, (ev, summary) => {
    forgeFirstPick(ev, 'Black Lotus');
    ev[0]!.id = `${eventId}-forged`;
    summary.id = ev[0]!.id;
  }));
  const r2 = await post('/api/submissions', t2, alice);
  assert.equal(r2.status, 422, JSON.stringify(r2.body));
  assert.ok(r2.body.reasons.some((r: any) => r.code === 'packs.regeneration' && r.severity === 'reject'), JSON.stringify(r2.body.reasons));
  assert.equal(r2.body.pack_regeneration.status, 'mismatch');
  pass('forged pick (internally consistent, re-hashed) → 422 rejected by pack regeneration');

  // Hosted Director path: verified label, service token. A copy of the same event under a new id has the
  // same decision streams, which must be held as a duplicate.
  const t3 = pack(rewrite(files, (ev, summary) => {
    ev[0]!.id = `${eventId}-copy`;
    summary.id = ev[0]!.id;
  }));
  const r3 = await post('/api/internal/events', t3, service);
  assert.equal(r3.status, 201, JSON.stringify(r3.body));
  assert.equal(r3.body.status, 'held');
  assert.ok(r3.body.reasons.some((r: any) => r.code === 'anomaly.duplicate_stream'));
  pass('internal Director path: same decisions under a new id → held (duplicate decision stream)');

  const held = (await req('/api/admin/submissions?status=held', { headers: auth(admin) })).body as any[];
  assert.ok(held.some((s) => Number(s.id) === r3.body.submission_id));
  assert.equal((await req('/api/admin/submissions?status=held', { headers: auth(alice) })).status, 401);
  const rej = await req(`/api/admin/submissions/${r3.body.submission_id}/reject`, { method: 'POST', headers: { ...auth(admin), 'Content-Type': 'application/json' }, body: JSON.stringify({ note: 'duplicate' }) });
  assert.equal(rej.status, 200);
  assert.equal((await req(`/api/submissions/${r3.body.submission_id}`, { headers: auth(admin) })).body.status, 'rejected');
  pass('admin API: review queue, reject with a note');

  // A different finished run through the Director path is ingested straight away (no review for our Directors).
  if (env.HUB_E2E_BUNDLE2) {
    const b2 = readFileSync(env.HUB_E2E_BUNDLE2);
    const r4 = await post('/api/internal/events', b2, service);
    assert.equal(r4.status, 201, JSON.stringify(r4.body));
    const holds = ((r4.body.reasons ?? []) as Array<{ code: string; severity: string }>).filter((r) => r.severity === 'hold').map((r) => r.code);
    if (r4.body.status === 'held' && holds.length && holds.every((c) => c === 'provenance.director')) {
      // Run from a modified checkout (a -dirty Director): held for review, as it should be. Approve it to test the rest.
      const ap = await req(`/api/admin/submissions/${r4.body.submission_id}/approve`, { method: 'POST', headers: { ...auth(admin), 'Content-Type': 'application/json' }, body: JSON.stringify({ note: 'e2e: dirty test checkout' }) });
      assert.equal(ap.status, 200, JSON.stringify(ap.body));
      pass('internal Director path: a -dirty Director version is held for review (approved here)');
    } else {
      assert.equal(r4.body.status, 'ingested', JSON.stringify(r4.body.reasons));
    }
    const id2 = r4.body.id;
    await until('second event export', async () => ((await req(`/data/events/${id2}.json`)).status === 200 ? true : undefined));
    pass(`internal Director path: ${id2} ingested and exported`);
  }

  // Takedown: gone from the API and the export.
  const td = await req(`/api/admin/events/${eventId}/takedown`, { method: 'POST', headers: { ...auth(admin), 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'e2e takedown' }) });
  assert.equal(td.status, 200);
  await until('takedown export', async () => ((await req(`/data/events/${eventId}.json`)).status === 404 ? true : undefined));
  assert.ok(!(await req('/data/index.json')).body.events.some((e: any) => e.id === eventId));
  assert.equal((await req(`/api/events/${eventId}`)).status, 404);
  assert.equal((await req(`/api/submissions/${s1}`, { headers: auth(alice) })).body.status, 'withdrawn');
  pass('takedown → withdrawn, removed from the index and /data');

  console.log('E2E OK');
}

main().catch((e) => {
  console.error(`FAIL ${(e as Error).stack ?? e}`);
  process.exit(1);
});
