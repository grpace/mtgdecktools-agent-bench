/**
 * Best of 3 only: the `bench` commands that took a best-of (`new`, `setup`, `lobby join`), the client's event
 * creation and the Director's one-shot flag refuse anything but 3 with one message, before any network call.
 * `--best-of 3` still works (old command lines), and a legacy `-bo3` queue key is still a queue key.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { BO1_REMOVED } from '../../../packages/director/src/best-of.js';
import { ApiError, createEvent } from '../core.js';
import { queueBestOfProblem } from '../lobby.js';

const scratch = mkdtempSync(join(tmpdir(), 'mtgdt-bestof-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function run(script: string, args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', script, ...args], {
    encoding: 'utf8', timeout: 60_000,
    // Nowhere to reach: a refusal must come before any network call.
    env: { ...process.env, BENCH_RUNS_DIR: join(scratch, 'runs'), XDG_CONFIG_HOME: join(scratch, 'xdg'), BENCH_DIRECTOR: 'http://127.0.0.1:9', BENCH_HUB: 'http://127.0.0.1:9', BENCH_CMD: 'bench', BENCH_TOKEN: 'tok-test-0123456789abcdef' },
  });
}
const bench = (args: string[]) => run(resolve(import.meta.dirname, '../cli.ts'), args);

test('bench new, setup and lobby join refuse best of 1 with one message', () => {
  for (const args of [
    ['new', '--set', 'fra', '--seat', '8x script/random', '--best-of', '1'],
    ['setup', '--hosted', '--set', 'fra', '--seat', '8x script/random', '--knowledge', 'none', '--best-of', '1', '--yes'],
    ['setup', '--agent', '--answers', '{"table":"private","play_mode":"once","where":"hosted","set":"fra","seats":["8x script/random"],"knowledge":"primer","best_of":1}'],
    ['lobby', 'join', '--set', 'fra', '--seat', 'script', '--best-of', '1'],
    ['lobby', 'join', '--queue', 'fra-primer-manual-bo1', '--seat', 'script'],
  ]) {
    const r = bench(args);
    assert.equal(r.status, 1, `${args.join(' ')}: exit ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.ok(r.stderr.includes(BO1_REMOVED), `${args.join(' ')}:\n${r.stderr}`);
    assert.doesNotMatch(r.stderr, /cannot reach|ECONNREFUSED/, 'refused before any network call');
  }
  const five = bench(['new', '--set', 'fra', '--seat', '8x script/random', '--best-of', '5']);
  assert.equal(five.status, 1);
  assert.match(five.stderr, /--best-of 5: Best of 5 isn't offered: Agent Bench plays best of 3 with sideboarding\./);
});

test('--best-of 3 is still accepted (old command lines), and no help lists best-of as a choice', () => {
  // No seats: the command gets past the best-of and stops at the seats.
  const r = bench(['new', '--set', 'fra', '--best-of', '3']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /add the seats/);
  for (const args of [['new', '--help'], ['setup', '--help'], ['lobby', 'join', '--help']]) {
    assert.doesNotMatch(bench(args).stdout, /best-of/, args.join(' '));
  }
});

test('createEvent refuses best of 1 without calling the Director', async () => {
  const seats = [{ name: 'a', harness: 'script', model: 'random' }];
  await assert.rejects(
    createEvent({ base: 'http://127.0.0.1:9', set: 'fra', seats, knowledge: 'none', mana: 'auto', bestOf: 1, podSize: 8, hosted: false, throwOnError: true }),
    (e: ApiError) => e instanceof ApiError && e.status === 400 && e.message === BO1_REMOVED,
  );
});

test('legacy queue keys: -bo3 joins (the Director maps it), -bo1 is refused', () => {
  assert.equal(queueBestOfProblem('fra-primer-manual'), undefined);
  assert.equal(queueBestOfProblem('fra-primer-manual-bo3'), undefined);
  assert.equal(queueBestOfProblem('fra-primer-manual-BO1'), BO1_REMOVED);
});

test("the Director's one-shot --best-of: 3 only", () => {
  const r = run(resolve(import.meta.dirname, '../../../packages/director/src/main.ts'), ['--best-of', '1']);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stderr.trim(), `--best-of 1: ${BO1_REMOVED}`);
});
