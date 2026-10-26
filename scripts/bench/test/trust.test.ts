// What the CLI accepts from a Director it doesn't trust (trust.ts, docs/SECURITY.md): hostile event ids, seat
// names and URLs, a fired lobby table with seats nobody declared, a token sent to the wrong host, and how each
// harness is shut in (harnesses.ts). Nothing here calls a model.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

// The CLI reads where things live when it loads: point it at a scratch folder first.
const scratch = mkdtempSync(join(tmpdir(), 'bench-trust-'));
const runs = join(scratch, 'runs');
const xdg = join(scratch, 'config');
process.env.BENCH_RUNS_DIR = runs;
process.env.XDG_CONFIG_HOME = xdg;
delete process.env.BENCH_TOKEN;
delete process.env.BENCH_DIRECTOR;
delete process.env.BENCH_TOKEN_ORIGINS;
const trust = await import('../trust.js');
const core = await import('../core.js');
const harnesses = await import('../harnesses.js');
after(() => rmSync(scratch, { recursive: true, force: true }));

const BASE = 'https://director.example';
const URL1 = `${BASE}/mcp/0123456789abcdef0123456789abcdef`;

test('event ids and seat names from a Director: plain names only, never a path', () => {
  for (const bad of ['../../../.ssh/x', '..', '.', '', 'a/b', 'x\u0000y', '-x', 42, null]) assert.throws(() => trust.eventIdFrom(bad), trust.UntrustedValue, String(bad));
  assert.equal(trust.eventIdFrom('2026-10-22-17-40-02-fra-1c2d'), '2026-10-22-17-40-02-fra-1c2d');
  for (const bad of ['x/../../../../../../.claude/settings.json', '..', '.', 'a b', 'a/b', 'x'.repeat(41), '', 7]) assert.throws(() => trust.seatNameFrom(bad), trust.UntrustedValue, String(bad));
  assert.equal(trust.seatNameFrom('claude-opus-5-5-2'), 'claude-opus-5-5-2');
});

test('paths built from them stay inside their folder', () => {
  assert.equal(trust.under('/r/runs', 'ev-1', 'event.json'), resolve('/r/runs/ev-1/event.json'));
  assert.throws(() => trust.under('/r/runs', '../x'), trust.UntrustedValue);
  assert.throws(() => trust.under('/r/runs/ev', 'transcript-x/../../../../.claude/settings.json'), trust.UntrustedValue);
  assert.throws(() => trust.under('/r/runs', '/etc/passwd'), trust.UntrustedValue);
});

test("seat URLs must be on the Director's own base, plain characters only", () => {
  assert.equal(trust.seatUrlFrom(URL1, BASE), URL1);
  for (const bad of [
    'https://evil.example/mcp/0123456789abcdef', `${BASE}/other/0123456789abcdef`, `${BASE}/mcp/x`, `${BASE}/mcp/abc"def0123`,
    `${BASE}/mcp/0123456789"\n[mcp_servers.evil]\ncommand = "sh"`, `${BASE}.evil.example/mcp/0123456789abcdef`, `${BASE}/mcp/../../0123456789`, 5,
  ]) assert.throws(() => trust.seatUrlFrom(bad, BASE), trust.UntrustedValue, String(bad));
  // Your own Director on this machine may publish seats under its PUBLIC_URL; still plain, still /mcp/<token>.
  assert.equal(trust.seatUrlFrom('https://bench.lan:8443/mcp/0123456789abcdef', 'http://127.0.0.1:8787'), 'https://bench.lan:8443/mcp/0123456789abcdef');
  assert.throws(() => trust.seatUrlFrom('file:///etc/passwd', 'http://127.0.0.1:8787'), trust.UntrustedValue);
  assert.throws(() => trust.seatUrlFrom('https://bench.lan/mcp/0123456789"x', 'http://127.0.0.1:8787'), trust.UntrustedValue);
});

test('a created event must have exactly the seats asked for', () => {
  const ok = trust.checkCreatedSeats({ a: URL1, b: URL1.replace('0123', '9999') }, BASE, ['b', 'a']);
  assert.deepEqual(Object.keys(ok).sort(), ['a', 'b']);
  assert.throws(() => trust.checkCreatedSeats({ a: URL1 }, BASE, ['a', 'b']), /other seats/);
  assert.throws(() => trust.checkCreatedSeats({ a: URL1, '../../x': URL1 }, BASE, ['a', 'b']), /other seats/);
  assert.throws(() => trust.checkCreatedSeats({ a: URL1, b: 'https://evil.example/mcp/0123456789abcdef' }, BASE, ['a', 'b']), /isn't on/);
  assert.throws(() => trust.checkCreatedSeats([URL1], BASE, ['0']), trust.UntrustedValue);
});

test('a fired lobby table: only seats you declared start, as you declared them', () => {
  const declared = [{ harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high' }, { harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high' }];
  // The Director's account uses display spellings: still the same seat.
  const good = trust.assignSeats({ s1: { url: URL1, harness: 'Claude Code', model: 'claude-opus-5-5', effort: 'High' } }, BASE, declared);
  assert.ok(good.ok);
  assert.deepEqual(good.ok && good.seats.map((x) => [x.name, x.local]), [['s1', declared[0]]]);
  // A swapped harness (one with a shell), model or effort is refused, not launched.
  for (const swap of [{ harness: 'codex' }, { model: 'claude-haiku-5-5' }, { effort: 'max' }]) {
    const r = trust.assignSeats({ s1: { url: URL1, harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high', ...swap } }, BASE, declared);
    assert.equal(r.ok, false, JSON.stringify(swap));
  }
  // More seats than you declared, a hostile name, a URL elsewhere.
  const three = Object.fromEntries(['a', 'b', 'c'].map((n) => [n, { url: URL1, harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high' }]));
  assert.equal(trust.assignSeats(three, BASE, declared).ok, false);
  assert.equal(trust.assignSeats({ '../../../.claude/settings.json': { url: URL1, harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high' } }, BASE, declared).ok, false);
  assert.equal(trust.assignSeats({ s1: { url: 'https://evil.example/mcp/0123456789abcdef', harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high' } }, BASE, declared).ok, false);
  // Across the tables of one ticket, each declared seat is used once.
  const used = new Set<number>();
  const seat = { url: URL1, harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high' };
  assert.ok(trust.assignSeats({ s1: seat }, BASE, declared, used).ok);
  assert.ok(trust.assignSeats({ s2: seat }, BASE, declared, used).ok);
  assert.equal(trust.assignSeats({ s3: seat }, BASE, declared, used).ok, false);
});

test('a fired lobby table: the context policy the event records must be the one this machine starts the seat with', () => {
  const fresh = [{ harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high', context_policy: 'fresh-per-game' as const }];
  const one = [{ harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high' }];
  const at = (context_policy?: unknown) => ({ s1: { url: URL1, harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high', ...(context_policy !== undefined ? { context_policy } : {}) } });
  const r = trust.assignSeats(at('fresh-per-game'), BASE, fresh);
  assert.ok(r.ok);
  assert.equal(r.ok && r.seats[0]!.local.context_policy, 'fresh-per-game', 'what starts is the local declaration');
  // None recorded ("harness", or a Director that doesn't report it) matches a seat declared without one.
  assert.ok(trust.assignSeats(at('harness'), BASE, one).ok);
  assert.ok(trust.assignSeats(at(), BASE, one).ok);
  // A different, missing or unknown policy is refused: the export would label the seat with the wrong one.
  for (const p of ['fresh-per-match', 'harness', undefined, 'fresh-per-turn']) assert.equal(trust.assignSeats(at(p), BASE, fresh).ok, false, String(p));
  assert.equal(trust.assignSeats(at('fresh-per-game'), BASE, one).ok, false);
});

test('server text for a terminal: no escape sequences', () => {
  assert.equal(trust.printable('ok\u001b[2J\u001b]0;pwned\u0007 \u202edone'), 'ok [2J ]0;pwned   done');
});

/** A one-route Director that answers POST /api/events with `body`. */
async function fakeDirector(body: unknown): Promise<{ base: string; server: Server }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(typeof body === 'function' ? (body as (b: string) => unknown)(`http://127.0.0.1:${(server.address() as { port: number }).port}`) : body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server };
}

test('creating an event: a hostile answer writes nothing outside the runs folder', async () => {
  const seats = [{ name: 'a', harness: 'script', model: 'random' }, { name: 'b', harness: 'script', model: 'random' }];
  const hostile: Array<(base: string) => unknown> = [
    (b) => ({ id: '../../../escape', seats: { a: `${b}/mcp/aaaaaaaaaaaa`, b: `${b}/mcp/bbbbbbbbbbbb` } }),
    (b) => ({ id: 'ev-ok', seats: { a: `${b}/mcp/aaaaaaaaaaaa`, 'x/../../../../escape.json': `${b}/mcp/bbbbbbbbbbbb` } }),
    () => ({ id: 'ev-ok', seats: { a: 'file:///etc/passwd', b: 'https://x.example/mcp/bbbb"\n[mcp_servers.evil]' } }),
  ];
  for (const h of hostile) {
    const { base, server } = await fakeDirector(h);
    try {
      process.env.ADMIN_TOKEN = 'local-admin';
      await assert.rejects(core.createEvent({ base, set: 'fra', seats, knowledge: 'none', mana: 'auto', bestOf: 3, podSize: 2, hosted: false, throwOnError: true }), core.ApiError);
    } finally {
      delete process.env.ADMIN_TOKEN;
      server.close();
    }
  }
  assert.ok(!existsSync(join(scratch, 'escape')) && !existsSync(join(runs, 'ev-ok')) && !existsSync(join(scratch, 'escape.json')));
  // A good answer: the plan's own harness, model and effort are what is recorded for launching.
  // An older Director still answered admins with the seed: it never reaches event.json (secret until the event ends).
  const { base, server } = await fakeDirector((b: string) => ({ id: 'ev-good', seed: 'fra-secret-seed', seats: { a: `${b}/mcp/aaaaaaaaaaaa`, b: `${b}/mcp/bbbbbbbbbbbb` }, knowledge: 'none' }));
  try {
    process.env.ADMIN_TOKEN = 'local-admin';
    const c = await core.createEvent({ base, set: 'fra', seats, knowledge: 'none', mana: 'auto', bestOf: 3, podSize: 2, hosted: false, throwOnError: true });
    assert.equal(c.dir, join(runs, 'ev-good'));
    assert.deepEqual(c.ev.meta, { a: { harness: 'script', model: 'random', effort: undefined }, b: { harness: 'script', model: 'random', effort: undefined } });
    assert.equal(statSync(c.dir).mode & 0o777, 0o700);
    assert.equal(c.ev.seed, undefined);
    assert.ok(!readFileSync(join(c.dir, 'event.json'), 'utf8').includes('fra-secret-seed'), 'the seed is not written before the event ends');
  } finally {
    delete process.env.ADMIN_TOKEN;
    server.close();
  }
});

/** Run the CLI (a checkout: tsx) with this test's folders. */
function bench(args: string[], env: Record<string, string> = {}) {
  const cli = resolve(import.meta.dirname, '../cli.ts');
  return spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], {
    encoding: 'utf8', timeout: 60_000, env: { ...process.env, BENCH_RUNS_DIR: runs, XDG_CONFIG_HOME: xdg, ...env },
  });
}

test('bench play starts only what this machine decided', () => {
  // A lobby record from an older CLI (harness and model taken from the Director): refused.
  const old = join(runs, 'ev-lobby-old');
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, 'event.json'), JSON.stringify({ id: 'ev-lobby-old', director: BASE, lobby: { table_id: 't' }, seats: { s1: URL1 }, meta: { s1: { harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high' } } }));
  let r = bench(['play', old, '--dry-run']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /older version/);
  // A seat that isn't what the person confirmed: refused.
  const conf = join(runs, 'ev-confirmed');
  mkdirSync(conf, { recursive: true });
  writeFileSync(join(conf, 'event.json'), JSON.stringify({ id: 'ev-confirmed', director: BASE, seats: { s1: URL1 }, meta: { s1: { harness: 'codex', model: 'gpt-6-astra', effort: 'high' } } }));
  writeFileSync(join(conf, 'confirmation.json'), JSON.stringify({ launch: { s1: { harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high' } } }));
  r = bench(['play', conf, '--dry-run']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /isn't what you confirmed/);
  // A seat name that is a path: refused before anything is written.
  const bad = join(runs, 'ev-badname');
  mkdirSync(bad, { recursive: true });
  writeFileSync(join(bad, 'event.json'), JSON.stringify({ id: 'ev-badname', director: BASE, seats: { '../../x': URL1 }, meta: { '../../x': { harness: 'script', model: 'random' } } }));
  r = bench(['play', bad, '--dry-run']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not a seat name/);
  // What was confirmed starts, with the seat URL only in a config file (not in argv).
  writeFileSync(join(conf, 'event.json'), JSON.stringify({ id: 'ev-confirmed', director: BASE, seats: { s1: URL1 }, meta: { s1: { harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high' } } }));
  r = bench(['play', conf, '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  const cmdLine = r.stdout.split('\n').find((l) => l.startsWith('claude '))!;
  assert.ok(cmdLine && !cmdLine.includes(URL1) && cmdLine.includes("--tools ''") && cmdLine.includes('--strict-mcp-config'));
  assert.match(r.stdout, /<seat-config>\/mcp\.json/);
});

test('the saved contributor token goes only to the hosted Director and Hub', () => {
  mkdirSync(join(xdg, 'mtgdt-bench'), { recursive: true });
  writeFileSync(join(xdg, 'mtgdt-bench', 'token'), 'saved-token\n', { mode: 0o600 });
  try {
    assert.equal(core.contributorToken(undefined, core.HOSTED_DIRECTOR_URL), 'saved-token');
    assert.equal(core.contributorToken(undefined, core.DEFAULT_HUB_URL), 'saved-token');
    assert.equal(core.contributorToken(undefined, 'http://127.0.0.1:8787'), 'saved-token');
    assert.equal(core.contributorToken(undefined, 'https://community-director.example'), undefined);
    assert.equal(core.contributorToken(undefined, 'https://bench.mtgdecktools.com.evil.example'), undefined);
    // A token you give explicitly goes where you send it (with a warning).
    assert.equal(core.contributorToken('their-token', 'https://community-director.example'), 'their-token');
    process.env.BENCH_TOKEN_ORIGINS = 'https://staging.example';
    assert.equal(core.contributorToken(undefined, 'https://staging.example/'), 'saved-token');
  } finally {
    delete process.env.BENCH_TOKEN_ORIGINS;
    rmSync(join(xdg, 'mtgdt-bench', 'token'), { force: true });
  }
});

test('harness launches: only the mtg server, no shell or file tools where the harness allows, URL out of argv', () => {
  const seat = { name: 's1', url: URL1, model: 'm' };
  const ctx = { home: '/h', work: '/w' };
  const get = (id: string) => harnesses.HARNESSES.find((h) => h.id === id)!.launch!(seat, 'PROMPT', { ctx });
  for (const h of harnesses.LAUNCHABLE.filter((x) => !x.test)) {
    const l = h.launch!(seat, 'PROMPT', { ctx });
    assert.ok(!l.args.some((a) => a.includes(URL1)), `${h.id}: the seat URL is in argv`);
    assert.ok(h.isolation, `${h.id}: says how far it is shut in`);
  }
  const codex = get('codex');
  assert.equal(codex.env.CODEX_HOME, '/h/codex');
  assert.match(codex.homeFiles!['codex/config.toml']!, /shell_tool = false/);
  assert.match(codex.homeFiles!['codex/config.toml']!, /web_search = "disabled"/);
  const gemini = get('gemini-cli');
  assert.ok(!gemini.args.includes('yolo'), 'no auto-approve-everything');
  assert.equal(gemini.env.GEMINI_CLI_HOME, '/h/gemini');
  const oc = get('opencode');
  assert.ok(!oc.args.includes('--auto') && oc.args.includes('--standalone'));
  assert.deepEqual(JSON.parse(oc.homeFiles!['opencode.json']!).permission, { '*': 'deny', execute: 'allow', 'mtg_*': 'allow' });
  assert.equal(oc.env.XDG_CONFIG_HOME, '/h/config');
  const cursor = get('cursor');
  assert.equal(cursor.env.HOME, '/h/home');
  assert.ok(JSON.parse(cursor.homeFiles!['home/.cursor/cli-config.json']!).permissions.deny.includes('Shell(*)'));
  assert.ok(!cursor.args.includes('--force') && !cursor.args.includes('--yolo'));
});

test('seat folders: config files private, nothing written outside them; secrets stay out of the environment', () => {
  const ctx = harnesses.seatDirs('s1');
  try {
    harnesses.prepareSeat({ cmd: 'x', args: [], env: {}, files: { 'a/b.json': '{}' }, homeFiles: { 'mcp.json': '{}' } }, ctx);
    assert.equal(statSync(join(ctx.home, 'mcp.json')).mode & 0o777, 0o600);
    assert.equal(statSync(ctx.root).mode & 0o777, 0o700);
    assert.throws(() => harnesses.prepareSeat({ cmd: 'x', args: [], env: {}, files: { '../../escape': 'x' } }, ctx), trust.UntrustedValue);
    assert.deepEqual(readdirSync(ctx.root).sort(), ['config', 'work']);
  } finally {
    harnesses.removeSeatDirs(ctx.root);
  }
  const env = harnesses.seatEnv({ PATH: '/bin', BENCH_TOKEN: 't', ADMIN_TOKEN: 'a', GITHUB_TOKEN: 'g', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 'o', X_SECRET: 's' }, { ANTHROPIC_API_KEY: null, Y: '1' }, { harness: 'claude-code' });
  assert.deepEqual(env, { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'o', Y: '1' });
});

test('no npx instruction for an unpublished package', () => {
  const r = bench(['help']);
  assert.ok(!/npx mtgdt-bench/.test(r.stdout + r.stderr));
  assert.ok(!/npx mtgdt-bench/.test(readFileSync(resolve(import.meta.dirname, '../../../packages/director/src/lobby.ts'), 'utf8')));
});
