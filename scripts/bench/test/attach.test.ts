// bench attach-logs: which seats it scans for, which folders it lists before asking, and the question it asks.
// (The session matcher itself is packages/director/src/harness-logs.ts, tested in harness-logs.test.ts.)
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { handSeated, scanQuestion, storeDirs } from '../attach.js';

test('hand-seated seats: agent seats without a transcript from bench play; scripted seats never', () => {
  const dir = mkdtempSync(join(tmpdir(), 'attach-seats-'));
  try {
    writeFileSync(join(dir, 'transcript-opus-1.jsonl'), '');
    const start = { seats: [{ name: 'opus-1', kind: 'agent' }, { name: 't3-1', kind: 'agent' }, { name: 'rand-3', kind: 'agent' }, { name: 'bot-2', kind: 'bot' }] };
    assert.deepEqual(handSeated(dir, start), ['t3-1']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the folders listed before the scan: only those that exist, including $CLAUDE_CONFIG_DIR and every Claude account', () => {
  const home = mkdtempSync(join(tmpdir(), 'attach-home-'));
  try {
    for (const d of ['.claude/projects', '.claude-accounts/work/projects', '.codex/sessions', '.t3/userdata/logs/provider', 'cfg/projects']) mkdirSync(join(home, d), { recursive: true });
    const got = storeDirs(home, { CLAUDE_CONFIG_DIR: join(home, 'cfg') });
    assert.deepEqual(got, [join(home, 'cfg/projects'), join(home, '.claude/projects'), join(home, '.claude-accounts/work/projects'), join(home, '.codex/sessions'), join(home, '.t3/userdata/logs/provider')]);
    assert.deepEqual(storeDirs(join(home, 'nowhere'), {}), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the question names the seats, the clients and the folders, and says no text is copied', () => {
  const q = scanQuestion(['t3-1'], ['/home/x/.claude/projects'], ['T3 Code (Claude Code)']);
  assert.match(q, /t3-1/);
  assert.match(q, /your T3 Code \(Claude Code\) sessions/);
  assert.match(q, /\/home\/x\/\.claude\/projects/);
  assert.match(q, /no conversation text, title or path is copied/);
});
