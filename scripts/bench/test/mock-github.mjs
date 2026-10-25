// A stand-in for GitHub's device flow and user API, for scripts/bench/test/setup-e2e.sh:
// the first poll of each device code answers authorization_pending, the next one approves it.
//   node scripts/bench/test/mock-github.mjs <port>
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 8891);
const polls = new Map();
let seq = 0;
const send = (res, code, body) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/login/device/code' && req.method === 'POST') {
    const code = `dc-${++seq}`;
    polls.set(code, 0);
    return send(res, body.client_id === 'cid' ? 200 : 400, { device_code: code, user_code: 'BNCH-TEST', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 });
  }
  if (url.pathname === '/login/oauth/access_token' && req.method === 'POST') {
    const n = polls.get(body.device_code);
    if (n === undefined) return send(res, 200, { error: 'bad_verification_code' });
    polls.set(body.device_code, n + 1);
    return send(res, 200, n === 0 ? { error: 'authorization_pending' } : { access_token: 'gho_setup_e2e', token_type: 'bearer' });
  }
  if (url.pathname === '/user') {
    if (req.headers.authorization !== 'Bearer gho_setup_e2e') return send(res, 401, { message: 'Bad credentials' });
    return send(res, 200, { id: 777001, login: 'setup-tester', created_at: '2015-01-01T00:00:00Z' });
  }
  res.writeHead(404).end();
}).listen(port, '127.0.0.1', () => console.log(`mock github on :${port}`));
