// `bench status` sends the token it has for the event (core.ts statusToken): the admin token for a table created
// with it (the first hosted 8-seat test table was an admin Private Table, and status showed only the public view),
// the contributor token for a hosted contributor table.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'bench-status-'));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = join(home, '.config');
delete process.env.ADMIN_TOKEN;
delete process.env.BENCH_TOKEN;
const { HOSTED_DIRECTOR_URL, statusToken } = await import('../core.js');
const ev = (hosted: boolean) => ({ id: 'e', director: HOSTED_DIRECTOR_URL, hosted, seats: {}, meta: {} });

test('status: the admin token for an admin table, the contributor token for a hosted one, --token over both', () => {
  assert.deepEqual(statusToken(HOSTED_DIRECTOR_URL, ev(false)), {}, 'no tokens on this machine: the public view');
  mkdirSync(join(home, '.config/mtgdt'), { recursive: true });
  writeFileSync(join(home, '.config/mtgdt/admin-token'), 'admin-secret\n');
  mkdirSync(join(home, '.config/mtgdt-bench'), { recursive: true });
  writeFileSync(join(home, '.config/mtgdt-bench/token'), 'contrib-secret\n');
  assert.deepEqual(statusToken(HOSTED_DIRECTOR_URL, ev(false)), { token: 'admin-secret', as: 'admin' });
  assert.deepEqual(statusToken(HOSTED_DIRECTOR_URL, ev(true)), { token: 'contrib-secret', as: 'contributor' });
  assert.deepEqual(statusToken(HOSTED_DIRECTOR_URL, ev(true), 'given'), { token: 'given' });
  // An event this machine has no record of: the contributor token first.
  assert.deepEqual(statusToken(HOSTED_DIRECTOR_URL, undefined), { token: 'contrib-secret', as: 'contributor' });
  // The saved tokens never go to a Director that isn't an official one.
  assert.deepEqual(statusToken('https://other.example', ev(false)), {});
});
