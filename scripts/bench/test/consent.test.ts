/**
 * The terms in the CLI (consent.ts): shown before sign-in, accepted only with an explicit yes or --accept-terms,
 * recorded once the token exists, asked again when the Hub's version changes; Hubs without terms are left alone.
 *   node --import tsx --test scripts/bench/test/consent.test.ts
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const cfg = mkdtempSync(join(tmpdir(), 'bench-consent-'));
process.env.XDG_CONFIG_HOME = cfg;
const { consentBeforeLogin, ensureTerms, finishLogin, hasPendingConsent, termsStep, termsText } = await import('../consent.js');

const TOKEN = 'mtgdt_con_test-token-0123456789abcdef';
let version = '2026-10-22';
let accepted: string | null = null;
const posts: unknown[] = [];
let server: Server;
let hub = '';
let bare = '';
let bareServer: Server;

const info = () => ({ version, summary: ['You pay for your agents.', 'Results are public under CC BY 4.0.'], links: { terms: 'https://h/legal/terms', privacy: 'https://h/legal/privacy', content_policy: 'https://h/legal/content-policy' } });

before(async () => {
  server = createServer((req, res) => {
    const send = (code: number, body: unknown) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    if (req.url === '/api/terms') return send(200, info());
    if (req.url === '/api/account/terms') {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'no' });
      if (req.method === 'GET') return send(200, { current: version, accepted_version: accepted, accepted_at: null, accepted: accepted === version, ...info() });
      let body = '';
      req.on('data', (d) => (body += d)).on('end', () => {
        const b = JSON.parse(body);
        posts.push(b);
        if (b.version !== version) return send(409, info());
        accepted = version;
        send(200, { current: version, accepted_version: version, accepted_at: 'now', accepted: true });
      });
      return;
    }
    send(404, { error: 'not found' });
  });
  bareServer = createServer((_req, res) => res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"not found"}'));
  await Promise.all([new Promise<void>((r) => server.listen(0, '127.0.0.1', r)), new Promise<void>((r) => bareServer.listen(0, '127.0.0.1', r))]);
  hub = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  bare = `http://127.0.0.1:${(bareServer.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  bareServer.close();
  rmSync(cfg, { recursive: true, force: true });
});

test('the summary text names the version, every point and the three links', () => {
  const t = termsText(info());
  for (const s of ['2026-10-22', 'You pay for your agents.', 'CC BY 4.0', 'https://h/legal/terms', 'https://h/legal/privacy', 'https://h/legal/content-policy']) assert.ok(t.includes(s), s);
  assert.match(termsText(info(), true), /changed/);
});

test('no terminal and no --accept-terms: nothing is recorded', async () => {
  assert.equal(await ensureTerms(hub, TOKEN, {}), false);
  assert.equal(posts.length, 0);
  assert.ok(await termsStep(hub, TOKEN), 'setup --agent gets a terms step');
});

test('before sign-in: consent with --accept-terms is remembered, then recorded with the new token', async () => {
  await consentBeforeLogin(hub, { accept: true });
  assert.ok(hasPendingConsent());
  assert.equal(posts.length, 0, 'nothing is sent before there is a token');
  await finishLogin(hub, TOKEN);
  assert.deepEqual(posts, [{ version: '2026-10-22' }]);
  assert.equal(accepted, '2026-10-22');
  assert.ok(!hasPendingConsent());
  assert.equal(await ensureTerms(hub, TOKEN, {}), true, 'accepted: nothing to ask');
  assert.equal(await termsStep(hub, TOKEN), null);
});

test('a new version is asked again, and accepted with --accept', async () => {
  version = '2026-12-01';
  assert.equal(await ensureTerms(hub, TOKEN, {}), false);
  assert.equal(await ensureTerms(hub, TOKEN, { accept: true }), true);
  assert.equal(accepted, '2026-12-01');
});

test('a Hub without terms is left alone', async () => {
  assert.equal(await ensureTerms(bare, TOKEN, {}), true);
  await consentBeforeLogin(bare, {});
  assert.ok(!existsSync(join(cfg, 'mtgdt-bench', 'terms-consent.json')));
});
