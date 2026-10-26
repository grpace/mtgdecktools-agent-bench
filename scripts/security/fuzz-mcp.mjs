// Hostile traffic against a LOCAL Director (docs/SECURITY.md, SEC-*): malformed HTTP, slow
// clients, oversized and malformed bodies, path tricks, then a hostile seat (batches, session floods, out-of-range ids,
// control characters, refused-answer floods, concurrent decides). After every group the Director must still answer
// /health, and its process must still be alive.
//
//   DIRECTOR_URL=http://127.0.0.1:18880 ADMIN_TOKEN=… [DIRECTOR_PID=…] [RUNS_DIR=…] node scripts/security/fuzz-mcp.mjs
//
// Loopback only: it refuses any other host. Never point it at a hosted Director.
// Exit code 1 when a check fails. Output: one line per check, PASS or FAIL.
import { connect } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const base = (process.env.DIRECTOR_URL ?? 'http://127.0.0.1:18880').replace(/\/+$/, '');
const u = new URL(base);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
  console.error(`refusing ${u.hostname}: this harness only runs against a Director on this machine`);
  process.exit(2);
}
const admin = process.env.ADMIN_TOKEN ?? '';
const pid = Number(process.env.DIRECTOR_PID) || undefined;
const runsDir = process.env.RUNS_DIR;
const port = Number(u.port || 80);
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function alive(group) {
  let ok = false;
  for (let i = 0; i < 10 && !ok; i++) {
    ok = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false);
    if (!ok) await sleep(500);
  }
  let running = true;
  if (pid) {
    try {
      process.kill(pid, 0);
    } catch {
      running = false;
    }
  }
  check(`still serving after: ${group}`, ok && running, ok ? '' : 'no /health answer');
}

/** Send raw bytes on a fresh socket; resolve with what came back and whether the server closed it. */
function raw(bytes, { waitMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const s = connect(port, u.hostname === 'localhost' ? '127.0.0.1' : u.hostname.replace(/[[\]]/g, ''));
    let out = '';
    let closed = false;
    s.on('data', (d) => (out += d.toString('latin1')));
    s.on('close', () => {
      closed = true;
      resolve({ out, closed });
    });
    s.on('error', () => {});
    s.write(bytes);
    setTimeout(() => {
      if (!closed) {
        s.destroy();
        resolve({ out, closed: false });
      }
    }, waitMs);
  });
}
const statusOf = (out) => Number(/^HTTP\/1\.1 (\d{3})/.exec(out)?.[1] ?? 0);

async function rpc(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...headers },
    body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  }).catch((e) => ({ status: 0, text: async () => String(e) }));
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}
/** Seat calls are paced under the per-seat rate (600 a minute, bursts of 60), so a 429 means something else. */
let lastSeatCall = 0;
async function paced(fn) {
  const wait = lastSeatCall + 120 - Date.now();
  if (wait > 0) await sleep(wait);
  lastSeatCall = Date.now();
  return fn();
}
const tool = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const toolText = (r) => r.json?.result?.content?.[0]?.text ?? r.json?.error?.message ?? r.text;

// ---------------------------------------------------------------------------------------------------------------------
console.log(`== fuzzing ${base}${pid ? ` (pid ${pid})` : ''}`);
await alive('start');

console.log('\n-- malformed request targets and headers (anonymous)');
for (const target of ['//a:b', 'http://a:b/', '/%', '/api/lobby/contributors/%C0%AF', `/${'a'.repeat(70_000)}`, '/api/events/../../etc/passwd', '*']) {
  const r = await raw(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
  const code = statusOf(r.out);
  check(`GET ${target.slice(0, 40)}${target.length > 40 ? '…' : ''} → 4xx`, code >= 400 && code < 500, `HTTP ${code}`);
}
{
  const r = await raw(`GET /health HTTP/1.1\r\nHost: x\r\n${'X-Big: ' + 'a'.repeat(100_000)}\r\n\r\n`);
  check('100 KB header → 431 or closed', statusOf(r.out) === 431 || r.closed, `HTTP ${statusOf(r.out)}`);
  const n = await raw('GARBAGE\r\n\r\n');
  check('non-HTTP bytes → 400 or closed', statusOf(n.out) === 400 || n.closed);
  const nul = await raw('GET /he\u0000alth HTTP/1.1\r\nHost: x\r\n\r\n');
  check('NUL in the request line → 400 or closed', statusOf(nul.out) === 400 || nul.closed);
}
await alive('malformed targets');

console.log('\n-- slow and oversized clients (anonymous)');
{
  // Slowloris: 30 sockets that never finish their headers; they must be closed by headersTimeout (20 s).
  const t0 = Date.now();
  const slow = Array.from({ length: 30 }, () => new Promise((resolve) => {
    const s = connect(port, '127.0.0.1');
    s.on('error', () => {});
    s.write('GET /health HTTP/1.1\r\nHost: x\r\n');
    const drip = setInterval(() => s.write('X-a: b\r\n'), 2000);
    s.on('close', () => {
      clearInterval(drip);
      resolve(Date.now() - t0);
    });
    setTimeout(() => {
      clearInterval(drip);
      s.destroy();
      resolve(Infinity);
    }, 45_000);
  }));
  const during = await fetch(`${base}/health`).then((r) => r.status, () => 0);
  check('/health answers while 30 slowloris sockets are open', during === 200);
  const closedAfter = await Promise.all(slow);
  const worst = Math.max(...closedAfter);
  check('slowloris sockets are closed by the server within 30 s', worst <= 30_000, `${Number.isFinite(worst) ? Math.round(worst / 1000) : '∞'} s`);
}
{
  const r = await raw(`POST /api/events HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nAuthorization: Bearer ${admin}\r\nContent-Length: 999999999\r\n\r\n{`, { waitMs: 5000 });
  check('Content-Length 1 GB → 413 and the connection closed', statusOf(r.out) === 413 && r.closed, `HTTP ${statusOf(r.out)}, closed ${r.closed}`);
  // A chunked body that never ends: cut off at the limit.
  const s = connect(port, '127.0.0.1');
  let got = '';
  s.on('data', (d) => (got += d));
  s.on('error', () => {});
  s.write(`POST /api/events HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nAuthorization: Bearer ${admin}\r\nTransfer-Encoding: chunked\r\n\r\n`);
  const chunk = `${(64 * 1024).toString(16)}\r\n${'a'.repeat(64 * 1024)}\r\n`;
  let sent = 0;
  for (let i = 0; i < 64 && !s.destroyed; i++) {
    s.write(chunk);
    sent += 64;
    await sleep(5);
  }
  await sleep(500);
  check('endless chunked body → 413, reading stops', /^HTTP\/1\.1 413/.test(got) || s.destroyed, `${sent} KB sent`);
  s.destroy();
}
await alive('slow and oversized clients');

console.log('\n-- path tricks on /data and /api (anonymous)');
for (const p of ['/data/../../../../etc/passwd', '/data/%2e%2e/%2e%2e/etc/passwd', '/data/..%2f..%2fetc%2fpasswd', '/data/.lobby/state.json', '/data/%00', '/api/events/..%2f..%2fetc/files/events.jsonl', '/api/events/x/files/../../state.json']) {
  const r = await fetch(`${base}${p}`).then(async (x) => ({ s: x.status, b: await x.text() }), () => ({ s: 0, b: '' }));
  check(`${p} → not served`, r.s >= 400 && !/root:x:0:0/.test(r.b), `HTTP ${r.s}`);
}
{
  const r = await fetch(`${base}/api/capacity`);
  check('security headers on API answers', r.headers.get('x-content-type-options') === 'nosniff' && /default-src 'none'/.test(r.headers.get('content-security-policy') ?? ''),
    `nosniff=${r.headers.get('x-content-type-options')} csp=${r.headers.get('content-security-policy') ? 'yes' : 'no'}`);
}
{
  let limited = false;
  for (let i = 0; i < 60 && !limited; i++) {
    const r = await fetch(`${base}/mcp/${i.toString(16).padStart(32, '0')}`, { method: 'POST', body: '{}' });
    limited = r.status === 429;
  }
  check('guessing seat tokens is rate limited (429)', limited);
}
await alive('path tricks');

// ---------------------------------------------------------------------------------------------------------------------
if (!admin) {
  console.log('\n(no ADMIN_TOKEN: skipping the hostile-seat checks)');
} else {
  console.log('\n-- a hostile seat');
  const create = await fetch(`${base}/api/events`, {
    method: 'POST', headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
    body: JSON.stringify({ set: 'fra', agents: Array.from({ length: 8 }, (_, i) => `fuzz-${i + 1}`), force: true }),
  });
  const ev = await create.json();
  check('event created for the hostile seat', create.status === 201 || create.status === 202, `HTTP ${create.status}`);
  const seatUrl = Object.values(ev.seats ?? {})[0];
  if (seatUrl) {
    const init = (id) => ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fuzz', version: '0' } } });
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await rpc(seatUrl, init(i + 1))).status);
    check('initialize flood → 429 after a short burst', codes.slice(-4).every((c) => c === 429), codes.join(','));

    const batch = await rpc(seatUrl, Array.from({ length: 100 }, (_, i) => tool(i + 1, 'get_view', {})));
    check('a batch of 100 tool calls → refused', batch.status === 400, `HTTP ${batch.status}`);

    await sleep(8000); // let the seat's rate bucket refill after the floods above
    const idRe = /(?:DECISION|Decision) ([A-Z]+\d+)/;
    let wait;
    for (let i = 0; i < 30 && !idRe.test(wait ?? ''); i++) wait = toolText(await paced(() => rpc(seatUrl, tool(1, 'wait_for_decision', {}))));
    const decision = idRe.exec(wait ?? '')?.[1];
    check('the seat got its first draft pick', !!decision, (wait ?? '').slice(0, 80).replace(/\n/g, ' '));

    for (const [what, args] of [
      ['float ids', { cards: [1.5] }], ['negative ids', { attackers: [-1] }], ['1e308 ids', { cards: [1e308] }],
      ['13 basics names', { basics: Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`island${' '.repeat(i)}`, 1])) }],
      ['200 basic lands', { basics: { Island: 40, island: 40, ISLAND: 40, Plains: 40, plains: 40 } }],
      ['a 1 MB note', { note: 'n'.repeat(1 << 20) }],
    ]) {
      const r = await paced(() => rpc(seatUrl, tool(2, 'decide', { decision_id: decision ?? 'D1', ...args })));
      const refused = r.status === 413 || r.json?.result?.isError === true || !!r.json?.error;
      check(`decide with ${what} → refused before the game`, refused, `HTTP ${r.status} ${toolText(r).slice(0, 60).replace(/\n/g, ' ')}`);
    }

    const hostile = 'pick\u0000 me\u001b[31m now‮\ud800';
    let last = '';
    for (let i = 0; i < 25; i++) last = toolText(await paced(() => rpc(seatUrl, tool(3, 'decide', { decision_id: decision ?? 'D1', option: '999', note: hostile }))));
    check('refused-answer flood → told to wait, nothing applied', /answers were refused in the last minute/.test(last), last.slice(0, 80));

    const names = ['__proto__', 'constructor', '.*'.repeat(100), '\u0000', 'a'.repeat(200), '<script>alert(1)</script>'];
    const cardAnswers = [];
    for (const n of names) cardAnswers.push(await paced(() => rpc(seatUrl, tool(4, 'get_card', { name: n }))));
    check('get_card with hostile names answers normally', cardAnswers.every((r) => r.status === 200), cardAnswers.map((r) => r.status).join(','));

    let reports = 0;
    for (let i = 0; i < 60; i++) if (/report is logged/.test(toolText(await paced(() => rpc(seatUrl, tool(5, 'report_rules_issue', { card: `X\u001b]0;t\u0007${i}`, note: 'n\u0000'.repeat(100) })))))) reports++;
    check('rules reports stop at the per-seat cap', reports <= 50, `${reports} logged`);

    // 50 concurrent decides for the same decision: at most the in-flight cap get through at once, nothing crashes.
    await sleep(8000);
    const race = await Promise.all(Array.from({ length: 50 }, () => rpc(seatUrl, tool(6, 'decide', { decision_id: decision ?? 'D1', option: '1', note: 'race' }))));
    const accepted = race.filter((r) => /^Accepted/.test(toolText(r))).length;
    check('50 racing decides: one accepted at most, the rest refused or 429', accepted <= 1, `${accepted} accepted; ${race.filter((r) => r.status === 429).length} × 429`);

    if (runsDir && ev.id && existsSync(join(runsDir, ev.id, 'events.jsonl'))) {
      const log = readFileSync(join(runsDir, ev.id, 'events.jsonl'), 'utf8');
      const bad = /\\u0000|\\u001b|\\u202e|\\ud800/i.test(log);
      check('no NUL, escape, bidi or lone surrogate reached the event log', !bad);
      check('the event log stayed small', log.length < 2_000_000, `${log.length} bytes`);
    }
    await fetch(`${base}/api/events/${ev.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${admin}` } });
  }
  await alive('hostile seat');
}

console.log('\n-- spectator and lobby floods (anonymous)');
{
  // A running event (one that is over closes its streams at once): create one when the admin token is given.
  const made = admin ? await fetch(`${base}/api/events`, {
    method: 'POST', headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
    body: JSON.stringify({ set: 'fra', agents: Array.from({ length: 8 }, (_, i) => `watch-${i + 1}`), force: true }),
  }).then((r) => r.json(), () => ({})) : {};
  const ids = await fetch(`${base}/api/events`).then((r) => r.json()).then((l) => l.map((e) => e.id), () => []);
  const id = made.id ?? ids[0] ?? '2026-01-01-00-00-00-fra-0000';
  // Held open together (a stream that closes frees its slot).
  const open = await Promise.all(Array.from({ length: 40 }, () => fetch(`${base}/api/events/${id}/live`, { headers: { accept: 'text/event-stream' } }).catch(() => undefined)));
  const streams = open.map((r) => r?.status ?? 0);
  check('40 spectator streams held from one address → most refused (429)', streams.filter((s) => s === 429).length >= 30, streams.join(','));
  const t0 = Date.now();
  const h = await fetch(`${base}/health`).then((r) => r.status);
  check('/health still fast during the stream flood', h === 200 && Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
  for (const r of open) r?.body?.cancel().catch(() => {});
  if (made.id) await fetch(`${base}/api/events/${made.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${admin}` } });
}
await alive('spectator and lobby floods');

if (runsDir) {
  console.log('\n-- replaying finished events (anonymous; plants 10 synthetic finished logs in RUNS_DIR)');
  const line = JSON.stringify({ t: 1, type: 'agent_decision', game: 'g1', seat: 'a', id: 'G1', kind: 'priority', note: 'x'.repeat(500) });
  const body = `${JSON.stringify({ t: 0, type: 'event_start', set: { code: 'FRA' }, seats: [] })}\n${`${line}\n`.repeat(6_000)}${JSON.stringify({ t: 2, type: 'event_end', standings: [] })}\n`;
  const ids = Array.from({ length: 10 }, (_, i) => `2020-01-01-00-00-0${i}-fra-f${String(i).padStart(3, '0')}`);
  const { mkdirSync, writeFileSync } = await import('node:fs');
  for (const id of ids) {
    mkdirSync(join(runsDir, id), { recursive: true });
    writeFileSync(join(runsDir, id, 'events.jsonl'), body);
  }
  const t0 = Date.now();
  const replays = Promise.all(ids.map((id) => fetch(`${base}/api/events/${id}/live`).then((r) => r.status, () => 0)));
  await sleep(200);
  const h0 = Date.now();
  const h = await fetch(`${base}/health`, { signal: AbortSignal.timeout(60_000) }).then((r) => r.status, () => 0);
  const healthMs = Date.now() - h0;
  const codes = await replays;
  check('/health stays fast while 10 finished events are replayed', h === 200 && healthMs < 1000, `${healthMs} ms; replays ${codes.join(',')} in ${Date.now() - t0} ms`);
  check('replays beyond the budget are refused (503), not queued on the event loop', codes.filter((c) => c === 503).length >= 5, codes.join(','));
  await alive('replays');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
