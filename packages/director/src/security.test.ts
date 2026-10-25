/**
 * Regression tests for the seat-facing security audit (docs/SECURITY-FINDINGS.md, SEC-*): what a hostile seat or an
 * anonymous client can send to the Director's HTTP and MCP surfaces.
 *   npx tsx packages/director/src/security.test.ts
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CardDb } from './cards.js';
import { DEFAULT_LOBBY, Lobby, MemoryLobbyStore, type ViewContext } from './lobby.js';
import { LobbyHttp, MAX_WAITS_PER_TICKET } from './lobby-http.js';
import { capLine } from './log-cap.js';
import { cleanAgentText, cleanDecideInput, MAX_BATCH, startHttp, type ExtraRoutes } from './mcp.js';
import { AgentSeat, MAX_REFUSED_PER_MIN, type DecideInput, type Offer } from './seat.js';
import { SpectateHub } from './spectate-http.js';
import { DEFAULT_SPECTATE_POLICY } from './spectate-policy.js';

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

const listening = async (s: Server) => {
  if (!s.listening) await new Promise((r) => s.once('listening', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};

/** One JSON-RPC POST to a seat URL (as an MCP client sends it). */
async function rpc(url: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}
const call = (id: number, name: string, args: Record<string, unknown>) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const init = (id: number) => ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fuzz', version: '0' } } });

/** A seat with one open decision whose answers are recorded (and refused when `refuse` is set). */
function seatWithOffer(refuse = false): { seat: AgentSeat; answers: DecideInput[] } {
  const seat = new AgentSeat('s', 0);
  const answers: DecideInput[] = [];
  const offer: Offer = {
    id: 'P1', phase: 'draft', kind: 'pick', text: 'DECISION P1', createdAt: Date.now(), options: [{ id: '1', label: 'A', value: 1 }],
    answer: async (input) => {
      answers.push(input);
      return refuse ? 'refused' : null;
    },
  };
  seat.offer(offer);
  return { seat, answers };
}

await test('cleanAgentText: NUL, escape sequences, bidi and invisible characters go; lone surrogates become U+FFFD; text, tabs, newlines and emoji stay', () => {
  assert.equal(cleanAgentText('a\u0000b\u001b[31mred\u001b[0m'), 'ab[31mred[0m');
  assert.equal(cleanAgentText('safe‮txt.exe⁦x⁩'), 'safetxt.exex');
  assert.equal(cleanAgentText('zero​width﻿\r\n'), 'zerowidth\n');
  assert.equal(cleanAgentText('lone \uD800 high'), 'lone � high');
  assert.equal(cleanAgentText('Lightning Bolt\tthen 🧙‍♂️\nok'), 'Lightning Bolt\tthen 🧙‍♂️\nok');
  const cleaned = cleanDecideInput({ decision_id: 'G1\u0000', note: 'x\u001b]0;pwn\u0007', mana: ['37\u0000'], basics: { 'Isl\u0000and': 3 }, cards: [1, 2] });
  assert.deepEqual(cleaned, { decision_id: 'G1', note: 'x]0;pwn', mana: ['37'], basics: { Island: 3 }, cards: [1, 2] });
});

await test('log lines are capped (SEC-9)', () => {
  assert.equal(capLine('short'), 'short');
  const long = capLine('x'.repeat(100_000));
  assert.ok(long.length < 8_300 && /91808 more characters cut/.test(long));
});

await test('MCP: batches over MAX_BATCH are refused; each batched message counts against the seat rate (SEC-2)', async () => {
  const { seat } = seatWithOffer();
  const http = startHttp((t) => (t === seat.token ? seat : undefined), {} as CardDb, 0, '127.0.0.1', undefined, {
    perSeatPerMin: 60, inflightPerSeat: 4, unknownPerIpPerMin: 30, maxBodyBytes: 256 * 1024, trustProxy: false,
  });
  const url = `${await listening(http)}/mcp/${seat.token}`;
  try {
    const big = await rpc(url, Array.from({ length: 100 }, (_, i) => call(i + 1, 'get_view', {})));
    assert.equal(big.status, 400);
    assert.match(big.json.error.message, new RegExp(`1 to ${MAX_BATCH} messages`));
    assert.equal((await rpc(url, [])).status, 400, 'an empty batch');
    // Burst 10 at 60/min: two full batches of 4 fit, the third doesn't.
    assert.equal((await rpc(url, Array.from({ length: MAX_BATCH }, (_, i) => call(i + 1, 'get_view', {})))).status, 200);
    assert.equal((await rpc(url, Array.from({ length: MAX_BATCH }, (_, i) => call(i + 1, 'get_view', {})))).status, 200);
    assert.equal((await rpc(url, Array.from({ length: MAX_BATCH }, (_, i) => call(i + 1, 'get_view', {})))).status, 429);
  } finally {
    http.close();
  }
});

await test('MCP: initialize is rate limited per seat, so session starts can\'t flood the log (SEC-4)', async () => {
  const { seat } = seatWithOffer();
  const http = startHttp((t) => (t === seat.token ? seat : undefined), {} as CardDb, 0, '127.0.0.1');
  const url = `${await listening(http)}/mcp/${seat.token}`;
  try {
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await rpc(url, init(i + 1))).status);
    assert.deepEqual(codes.slice(0, 4), [200, 200, 200, 200]);
    assert.ok(codes.slice(4).every((c) => c === 429), codes.join(','));
    assert.equal(seat.sessions, 4, 'refused initializes are not sessions');
  } finally {
    http.close();
  }
});

await test('MCP decide: ids must be whole non-negative numbers; basics are bounded; strings arrive cleaned (SEC-3, SEC-6, SEC-7)', async () => {
  const { seat, answers } = seatWithOffer();
  const http = startHttp((t) => (t === seat.token ? seat : undefined), {} as CardDb, 0, '127.0.0.1');
  const url = `${await listening(http)}/mcp/${seat.token}`;
  try {
    // tools/list still works (the refinements don't break the JSON Schema the SDK publishes).
    const list = await rpc(url, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    assert.equal(list.status, 200);
    assert.ok(list.json.result.tools.some((t: { name: string }) => t.name === 'decide'));
    const refused = async (args: Record<string, unknown>) => {
      const r = await rpc(url, call(2, 'decide', { decision_id: 'P1', ...args }));
      assert.equal(r.status, 200);
      assert.equal(r.json.result?.isError ?? !!r.json.error, true, JSON.stringify(args));
    };
    await refused({ attackers: [1.5] });
    await refused({ attackers: [-1] });
    await refused({ cards: [1e300] });
    await refused({ blocks: [{ blocker: 1, attacker: 2.5 }] });
    const variants = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`island${' '.repeat(i)}`, 1]));
    await refused({ basics: variants });
    await refused({ basics: { Island: 40, island: 40, ISLAND: 40, Plains: 40 } });
    assert.equal(answers.length, 0, 'nothing invalid reached the decision');
    const ok = await rpc(url, call(3, 'decide', { decision_id: 'P1', option: '1', note: 'pick\u0000 this\u001b[2J', basics: { Island: 40, Plains: 40, Swamp: 40 } }));
    assert.equal(ok.status, 200);
    assert.equal(answers.length, 1);
    assert.equal(answers[0]!.note, 'pick this[2J');
  } finally {
    http.close();
  }
});

await test('MCP: hostile bodies get 4xx and the server keeps serving (deep nesting, bad UTF-8, wrong content type, huge body)', async () => {
  const { seat } = seatWithOffer();
  const http = startHttp((t) => (t === seat.token ? seat : undefined), {} as CardDb, 0, '127.0.0.1');
  const base = await listening(http);
  const url = `${base}/mcp/${seat.token}`;
  try {
    const deep = '['.repeat(100_000) + ']'.repeat(100_000);
    assert.ok([400, 413].includes((await rpc(url, deep)).status));
    const bad = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: Buffer.from([0x7b, 0xff, 0xfe, 0x7d]) });
    assert.equal(bad.status, 400);
    const xml = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/xml', accept: 'application/json, text/event-stream' }, body: JSON.stringify(call(1, 'get_view', {})) });
    assert.ok(xml.status >= 400 && xml.status < 500, String(xml.status));
    const huge = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(300 * 1024) }).catch(() => undefined);
    assert.ok(!huge || huge.status === 413);
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.match(health.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.equal(health.headers.get('x-frame-options'), 'DENY');
  } finally {
    http.close();
  }
});

await test('per-IP in-flight cap on non-seat routes: one client can\'t hold every connection (SEC-5)', async () => {
  const hang: Array<() => void> = [];
  const extra: ExtraRoutes = async (req, res) => {
    if (req.url !== '/hang') return false;
    await new Promise<void>((r) => hang.push(r));
    res.writeHead(200).end('done');
    return true;
  };
  const http = startHttp(() => undefined, {} as CardDb, 0, '127.0.0.1', extra, {
    perSeatPerMin: 600, inflightPerSeat: 4, unknownPerIpPerMin: 30, maxBodyBytes: 1024, trustProxy: false, inflightPerIp: 3,
  });
  const base = await listening(http);
  try {
    const held = [fetch(`${base}/hang`), fetch(`${base}/hang`), fetch(`${base}/hang`)];
    while (hang.length < 3) await new Promise((r) => setTimeout(r, 10));
    const over = await fetch(`${base}/hang`);
    assert.equal(over.status, 429);
    for (const r of hang.splice(0)) r();
    for (const r of await Promise.all(held)) assert.equal(r.status, 200);
    // Freed: the next one is served again.
    const again = fetch(`${base}/hang`);
    while (hang.length < 1) await new Promise((r) => setTimeout(r, 10));
    hang.pop()!();
    assert.equal((await again).status, 200);
  } finally {
    http.close();
  }
});

await test(`seat: after ${MAX_REFUSED_PER_MIN} refused answers in a minute, answers are turned away without reaching the game (SEC-4)`, async () => {
  const { seat, answers } = seatWithOffer(true);
  for (let i = 0; i < MAX_REFUSED_PER_MIN; i++) assert.match(await seat.decide({ decision_id: 'P1', option: '1', note: 'n'.repeat(600) }), /^Not accepted: refused/);
  assert.match(await seat.decide({ decision_id: 'P1', option: '1' }), /^Not applied: 20 answers were refused in the last minute/);
  assert.equal(answers.length, MAX_REFUSED_PER_MIN);
  assert.equal(seat.pending?.id, 'P1', 'the decision stays open');
});

await test('spectator replay: read in chunks, one at a time and a few a minute; the event loop stays responsive (SEC-1)', async () => {
  // Deterministic: an injected wall clock (the per-minute budget, the give-up) that only moves when the test moves it,
  // a slice clock that ticks once per read (a replay yields every REPLAY_SLICE_MS ticks), and a yield the test can hold.
  const runs = mkdtempSync(join(tmpdir(), 'sec-replay-'));
  try {
    // Ten finished events with ~6 MB logs each.
    const line = JSON.stringify({ t: 1, type: 'agent_decision', game: 'r1-a-b-g1', seat: 'a', id: 'G1', kind: 'priority', note: 'x'.repeat(500) });
    const LINES = 11_000;
    const body = `${JSON.stringify({ t: 0, type: 'event_start', set: { code: 'FRA' }, seats: [] })}\n${`${line}\n`.repeat(LINES)}${JSON.stringify({ t: 2, type: 'event_end', standings: [] })}\n`;
    const ids = Array.from({ length: 11 }, (_, i) => `2026-01-01-00-00-${String(i).padStart(2, '0')}-fra-000${i}`);
    for (const id of ids) {
      mkdirSync(join(runs, id));
      writeFileSync(join(runs, id, 'events.jsonl'), body);
    }
    let wall = Date.now();
    let ticks = 0;
    let yields = 0;
    let hold: Promise<void> | null = null;
    let onYield: (() => void) | null = null;
    const hub = new SpectateHub(DEFAULT_SPECTATE_POLICY, {
      runsDir: runs,
      now: () => wall,
      sliceClock: () => ticks++,
      yieldTurn: async () => {
        yields++;
        onYield?.();
        if (hold) await hold;
        await new Promise((r) => setImmediate(r));
      },
    });
    const server = createServer((req, res) => {
      const id = new URL(req.url!, 'http://x').pathname.slice(1);
      void hub.handle(req, res, id, undefined).then((found) => found || res.writeHead(404).end());
    });
    server.listen(0, '127.0.0.1');
    const base = await listening(server);
    const get = (id: string, ip?: string) => fetch(`${base}/${id}`, ip ? { headers: { 'x-forwarded-for': ip } } : {}).then((r) => r.status);
    try {
      // One at a time: the first replay is held at its first yield until every other request has its answer, so the
      // other nine always arrive while it runs (and are answered meanwhile: the event loop is free during a replay).
      let release!: () => void;
      hold = new Promise<void>((r) => (release = r));
      const first = get(ids[0]!, '10.0.0.0');
      while (yields === 0) await new Promise((r) => setTimeout(r, 1));
      const others = await Promise.all(ids.slice(1, 10).map((id, i) => get(id, `10.0.0.${i + 1}`)));
      assert.deepEqual(others, Array(9).fill(503), `one replay at a time: ${others.join(',')}`);
      hold = null;
      release();
      assert.equal(await first, 200);
      // Responsive: the replay yielded at least once every 20 lines it read (each yield lets other work in).
      assert.ok(yields >= LINES / 20, `the replay yielded ${yields} times over ${LINES} lines`);
      // A cached event is free; new ones wait for the per-minute budget (6 a minute: 1 used above, 5 left).
      assert.equal(await get(ids[0]!), 200);
      const later: number[] = [];
      for (const id of ids.slice(0, 10)) later.push(await get(id));
      assert.deepEqual(later, [200, 200, 200, 200, 200, 200, 503, 503, 503, 503], `six replays a minute, cache hits free: ${later.join(',')}`);
      // A minute later the budget is back.
      wall += 60_000;
      assert.equal(await get(ids[6]!), 200);
      // A replay still running after 30 s (wall clock) is given up, and not retried while it stays in the give-up list.
      const slow = ids[10]!;
      wall += 60_000;
      const before = yields;
      onYield = () => void (wall += 31_000);
      assert.equal(await get(slow), 404, 'given up');
      onYield = null;
      assert.equal(yields, before + 1, 'given up at the first yield past 30 s');
      assert.equal(await get(slow), 404, 'not retried within the give-up window');
    } finally {
      hub.close();
      server.close();
    }
  } finally {
    rmSync(runs, { recursive: true, force: true });
  }
});

await test('lobby: malformed percent-encoding is a 404 (no 500, no stack); long-polls are capped per ticket (LOB-6, LOB-12)', async () => {
  const ctx: ViewContext = { publicUrl: 'https://d.test', siteUrl: 'https://s.test', promptVersion: 'v5', setName: () => 'Reality Fracture', capacity: () => ({ capacity: 30, load: 0 }), eventInfo: () => undefined };
  const lobby = new Lobby({ ...DEFAULT_LOBBY, saveDelayMs: 60_000 }, new MemoryLobbyStore(), { paused: () => false, fire: async () => ({ event_id: 'ev-1' }) });
  const http = new LobbyHttp({
    lobby: () => lobby, caller: async () => ({ kind: 'contributor', id: 7, handle: 'p7', github: true }), isAdmin: () => false,
    ctx: () => ctx, setProblem: () => undefined, jsonMaxBytes: 65_536,
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    void http.handle(req, res, url, url.pathname).then((h) => h || res.writeHead(404).end());
  });
  server.listen(0, '127.0.0.1');
  const base = await listening(server);
  try {
    for (const p of ['/api/lobby/contributors/%C0%AF', '/api/lobby/models/%E0%A4%A', '/api/lobby/queues/%']) assert.equal((await fetch(`${base}${p}`)).status, 404, p);
    const join = await fetch(`${base}/api/lobby/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ queue: 'fra-primer-manual', seats: [{ harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high' }] }) });
    assert.equal(join.status, 201);
    const { ticket } = (await join.json()) as { ticket: string };
    const rev = lobby.state.rev;
    const t0 = Date.now();
    const polls = Array.from({ length: MAX_WAITS_PER_TICKET + 3 }, () => fetch(`${base}/api/lobby/tickets/${ticket}?rev=${rev}&wait=2`).then(() => Date.now() - t0));
    const took = (await Promise.all(polls)).sort((a, b) => a - b);
    assert.ok(took.filter((ms) => ms >= 1500).length === MAX_WAITS_PER_TICKET, `held: ${took.join(',')}`);
  } finally {
    lobby.flush?.();
    server.close();
  }
});

console.log(`\n${passed} security tests passed`);
process.exit(0);
