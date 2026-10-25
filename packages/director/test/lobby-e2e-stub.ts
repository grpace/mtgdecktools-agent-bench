/**
 * A stand-in Hub for the lobby end-to-end test (lobby-e2e.sh): token introspection for three fake GitHub-signed
 * contributors, and the Director → Hub hand-off, whose bundle it saves for the checks (lobby-e2e-check.ts).
 *   npx tsx packages/director/test/lobby-e2e-stub.ts <port> <out-dir>
 */
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const port = Number(process.argv[2] ?? 8971);
const out = process.argv[3] ?? 'tmp/lobby-e2e';
mkdirSync(out, { recursive: true });
const SERVICE = 'lobby-e2e-service-token-0123456789';
// Three contributors (tokens ≥ 24 characters), signed in with GitHub; a fourth without GitHub (refused by the lobby).
const contributors: Record<string, { id: number; handle: string; github_login: string | null }> = {
  'tok-alice-0123456789abcdef0123': { id: 101, handle: 'alice', github_login: 'alice-gh' },
  'tok-bob-0123456789abcdef012345': { id: 102, handle: 'bob', github_login: 'bob-gh' },
  'tok-carol-0123456789abcdef0123': { id: 103, handle: 'carol', github_login: 'carol-gh' },
  'tok-nogithub-0123456789abcdef0': { id: 104, handle: 'dave', github_login: null },
};

const body = (req: import('node:http').IncomingMessage) => new Promise<Buffer>((done) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => done(Buffer.concat(chunks)));
});

let handoffs = 0;
createServer(async (req, res) => {
  const json = (code: number, v: unknown) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(v));
  if ((req.headers.authorization ?? '') !== `Bearer ${SERVICE}`) return json(401, { error: 'service token required' });
  if (req.url === '/api/internal/tokens/introspect' && req.method === 'POST') {
    const { token } = JSON.parse((await body(req)).toString('utf8'));
    const c = contributors[token];
    if (!c) return json(200, { active: false });
    // Quotas count lobby tables too (LOB-2): room for a Private Table and a lobby table at once (continuous-e2e.sh).
    return json(200, { active: true, contributor: { ...c, kind: 'person', trust: 'new' }, scopes: ['contributor', 'play', 'submit'], token_id: c.id, quotas: { play_concurrent: 2, play_daily: 20 }, board_visibility: null });
  }
  if (req.url === '/api/internal/contributors/visibility' && req.method === 'POST') {
    await body(req);
    return json(200, { visibility: {} });
  }
  if (req.url === '/api/internal/events' && req.method === 'POST') {
    const gz = await body(req);
    handoffs++;
    writeFileSync(join(out, `handoff-${handoffs}.tar.gz`), gz);
    console.log(`hand-off ${handoffs}: ${gz.length} bytes`);
    return json(201, { status: 'ingested', id: 'stub' });
  }
  json(404, { error: 'not found' });
}).listen(port, '127.0.0.1', () => console.log(`stub hub on ${port}`));
