/**
 * `bench <command> --help` (and -h) prints that command's usage and exits 0 for every command; an option a command
 * doesn't take is a short error with the usage (exit 2), never a stack trace. No network: help returns before anything runs.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

const scratch = mkdtempSync(join(tmpdir(), 'mtgdt-help-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const COMMANDS = [
  'setup', 'check', 'doctor', 'login', 'logout', 'prompt', 'new', 'seats', 'attach-logs', 'play', 'status', 'stop', 'lobby', 'loop',
  'up', 'down', 'pull', 'bundle', 'validate', 'submit',
];

function bench(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', resolve(import.meta.dirname, '../cli.ts'), ...args], {
    encoding: 'utf8', timeout: 60_000,
    // Nowhere to reach: a command that ran instead of printing its help would fail.
    env: { ...process.env, BENCH_RUNS_DIR: join(scratch, 'runs'), XDG_CONFIG_HOME: join(scratch, 'xdg'), BENCH_DIRECTOR: 'http://127.0.0.1:9', BENCH_HUB: 'http://127.0.0.1:9', BENCH_CMD: 'bench' },
  });
}

const noTrace = (r: ReturnType<typeof bench>) => assert.ok(!/\n\s+at .+[:(]\d+:\d+\)?\n/.test(`${r.stdout}\n${r.stderr}`), `a stack trace:\n${r.stderr}`);

for (const c of COMMANDS) {
  test(`bench ${c} --help`, () => {
    for (const flag of ['--help', '-h']) {
      const r = bench([c, flag]);
      assert.equal(r.status, 0, `${c} ${flag}: exit ${r.status}\n${r.stderr}`);
      noTrace(r);
      const name = c === 'doctor' ? 'check' : c === 'loop' ? 'stop' : c;
      assert.match(r.stdout, new RegExp(`(^|\\n)  ${name}\\b`), `${c} ${flag} prints its own usage`);
      assert.ok(r.stdout.length < 3000, `${c}: only that command's help, not the whole list`);
    }
  });
}

test('subcommands and `help <command>` print the usage too', () => {
  for (const args of [['lobby', 'join', '--help'], ['lobby', 'list', '-h'], ['help', 'new'], ['new', '--set', 'fra', '--help']]) {
    const r = bench(args);
    assert.equal(r.status, 0, `${args.join(' ')}: exit ${r.status}\n${r.stderr}`);
    noTrace(r);
    assert.ok(r.stdout.trim(), args.join(' '));
  }
});

test('an unknown option: a short error and the usage, no stack trace', () => {
  for (const c of ['new', 'play', 'status', 'pull', 'bundle', 'login']) {
    const r = bench([c, '--no-such-option']);
    assert.equal(r.status, 2, `${c}: exit ${r.status}\n${r.stderr}`);
    noTrace(r);
    assert.match(r.stderr, /Unknown option '--no-such-option'/);
    assert.match(r.stderr, new RegExp(`\\n  ${c}\\b`), `${c}: the usage follows the error`);
  }
});
