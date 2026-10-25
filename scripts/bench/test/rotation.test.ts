// Seat session rotation (`bench play --fresh-session`): boundary detection and the switch (node --import tsx --test).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  boundaryKey, modeOfPolicy, policyOfMode, progressUrl, rotationStep, seatMode, SessionRotation, startKey, type ProgressFetch,
} from '../rotation.js';
import type { SeatProgress } from '../../../packages/director/src/seat.js';

const P = (o: Partial<SeatProgress> = {}): SeatProgress => ({ deck_locked: false, games_finished: 0, matches_finished: 0, done: false, deciding: false, sessions: 1, ...o });

test('boundaries: the deck lock, then each game (per-game) or each match (per-match)', () => {
  assert.equal(boundaryKey(P(), 'off'), null);
  assert.equal(boundaryKey(P(), 'per-game'), '0/0');
  assert.equal(boundaryKey(P({ deck_locked: true }), 'per-game'), '1/0');
  assert.equal(boundaryKey(P({ deck_locked: true, games_finished: 2, matches_finished: 1 }), 'per-game'), '1/2');
  assert.equal(boundaryKey(P({ deck_locked: true, games_finished: 2, matches_finished: 1 }), 'per-match'), '1/1');
  // Game 1 of a best-of-3 ends: a per-game boundary, not a per-match one.
  const start = P({ deck_locked: true });
  const after = P({ deck_locked: true, games_finished: 1 });
  assert.equal(rotationStep(boundaryKey(start, 'per-game'), after, 'per-game'), 'rotate');
  assert.equal(rotationStep(boundaryKey(start, 'per-match'), after, 'per-match'), 'stay');
  assert.equal(rotationStep(boundaryKey(start, 'per-match'), P({ deck_locked: true, games_finished: 2, matches_finished: 1 }), 'per-match'), 'rotate');
  // The draft session ends when the deck is locked.
  assert.equal(rotationStep('0/0', P({ deck_locked: true }), 'per-game'), 'rotate');
});

test('never mid-answer, never after the end, never when off', () => {
  assert.equal(rotationStep('1/0', P({ deck_locked: true, games_finished: 1, deciding: true }), 'per-game'), 'hold');
  assert.equal(rotationStep('1/0', P({ deck_locked: true, games_finished: 1, done: true }), 'per-game'), 'stay', 'a done seat ends on its own');
  assert.equal(rotationStep(null, P({ deck_locked: true, games_finished: 1 }), 'off'), 'stay');
  assert.equal(rotationStep(null, P({ deck_locked: true, games_finished: 1 }), 'per-game'), 'stay', 'no start key (progress unknown): never rotate');
});

test('the mode is the declared policy: the flag may repeat it, never change it', () => {
  assert.equal(policyOfMode('per-game'), 'fresh-per-game');
  assert.equal(policyOfMode('off'), undefined);
  assert.equal(modeOfPolicy('fresh-per-match'), 'per-match');
  assert.equal(modeOfPolicy(undefined), 'off');
  assert.deepEqual(seatMode('fresh-per-game', undefined), { mode: 'per-game' });
  assert.deepEqual(seatMode('fresh-per-game', 'per-game'), { mode: 'per-game' });
  assert.deepEqual(seatMode(undefined, undefined), { mode: 'off' });
  assert.deepEqual(seatMode(undefined, 'off'), { mode: 'off' });
  assert.match((seatMode(undefined, 'per-game') as { error: string }).error, /created without a context policy/);
  assert.match((seatMode('fresh-per-game', 'off') as { error: string }).error, /created with context policy fresh-per-game/);
  assert.match((seatMode(undefined, 'sometimes') as { error: string }).error, /off, per-match, per-game/);
  assert.equal(progressUrl('http://127.0.0.1:8787/mcp/abc/'), 'http://127.0.0.1:8787/mcp/abc/progress');
});

/** A fake Director: returns the queued progress replies in order (the last one repeats). */
function director(replies: Array<SeatProgress | 'unsupported' | null>): ProgressFetch & { calls: number } {
  const f = (async () => {
    f.calls++;
    return replies.length > 1 ? replies.shift()! : replies[0]!;
  }) as ProgressFetch & { calls: number };
  f.calls = 0;
  return f;
}

test('the switch: held while a decide call is in progress, then the session is ended exactly once', async () => {
  const ended: SeatProgress[] = [];
  const fetch = director([
    P({ deck_locked: true }), // still game 1
    P({ deck_locked: true, games_finished: 1, deciding: true }), // game over, but the last answer's reply is going out
    P({ deck_locked: true, games_finished: 1 }),
    P({ deck_locked: true, games_finished: 1 }),
  ]);
  const r = new SessionRotation({ url: 'u', mode: 'per-game', startKey: '1/0', end: (p) => ended.push(p), fetch });
  assert.equal(await r.poll(), 'stay');
  assert.equal(await r.poll(), 'hold');
  assert.equal(ended.length, 0, 'never cut off an answer');
  assert.equal(await r.poll(), 'rotate');
  assert.equal(await r.poll(), 'stay', 'once rotated, it never ends the next session');
  assert.equal(ended.length, 1);
  assert.equal(r.rotated, true);
});

test('the switch on a timer: polls until the boundary, then stops polling', async () => {
  let ended = 0;
  const fetch = director([P({ deck_locked: true }), P({ deck_locked: true }), P({ deck_locked: true, games_finished: 1 })]);
  const r = new SessionRotation({ url: 'u', mode: 'per-game', startKey: '1/0', end: () => ended++, fetch, pollMs: 5 }).start();
  for (let i = 0; i < 100 && !ended; i++) await new Promise((res) => setTimeout(res, 5));
  assert.equal(ended, 1);
  const calls = fetch.calls;
  await new Promise((res) => setTimeout(res, 40));
  assert.equal(fetch.calls, calls, 'no polling after the switch');
  r.stop();
});

test('a Director that is unreachable for a moment changes nothing; one without seat progress turns rotation off', async () => {
  let ended = 0;
  const r = new SessionRotation({ url: 'u', mode: 'per-game', startKey: '1/0', end: () => ended++, fetch: director([null]) });
  assert.equal(await r.poll(), 'unknown');
  assert.equal(ended, 0);
  assert.equal(await startKey('u', 'per-game', director(['unsupported'])), 'unsupported');
  assert.equal(await startKey('u', 'per-game', director([P({ deck_locked: true, games_finished: 3 })])), '1/3');
  assert.equal(await startKey('u', 'off', director([P()])), null);
});

test('the default for seats bench play launches is a fresh session per game', async () => {
  const { DEFAULT_FRESH_SESSION } = await import('../rotation.js');
  assert.equal(DEFAULT_FRESH_SESSION, 'per-game');
});

test('lobby seats: the launched model seats get the mode (per game by default); by hand, not installed or off: none', async () => {
  const { lobbySeatPolicy } = await import('../lobby.js');
  const { freshFlag } = await import('../setup.js');
  const installed = () => true;
  const at = (harness: string, mode: 'off' | 'per-game' | 'per-match', o: { launch?: boolean; explicit?: boolean; installed?: () => boolean } = {}) =>
    lobbySeatPolicy(harness, mode, { launch: o.launch ?? true, explicit: o.explicit ?? false, installed: o.installed ?? installed });
  assert.equal(at('claude-code', 'per-game'), 'fresh-per-game');
  assert.equal(at('codex', 'per-match', { explicit: true }), 'fresh-per-match');
  assert.equal(at('claude-code', 'off', { explicit: true }), undefined);
  // Seated by hand (--no-launch), a harness this machine can't start or hasn't installed: the harness's own session.
  assert.equal(at('claude-code', 'per-game', { launch: false }), undefined);
  assert.equal(at('generic', 'per-game'), undefined);
  assert.equal(at('claude-code', 'per-game', { installed: () => false }), undefined);
  // Scripted players: only when asked for (rotation tests).
  assert.equal(at('script', 'per-game'), undefined);
  assert.equal(at('script', 'per-game', { explicit: true }), 'fresh-per-game');
  // What setup passes on to `lobby join` / Keep Playing: nothing when the default gives the same policies.
  const llm = { harness: 'claude-code', contextPolicy: 'fresh-per-game' as const };
  assert.equal(freshFlag({ fresh: 'per-game', seats: [llm] as never }), undefined);
  assert.equal(freshFlag({ fresh: 'off', seats: [{ harness: 'claude-code' }] as never }), 'off');
  assert.equal(freshFlag({ fresh: 'per-match', seats: [{ ...llm, contextPolicy: 'fresh-per-match' }] as never }), 'per-match');
  assert.equal(freshFlag({ fresh: 'per-game', seats: [llm, { harness: 'script', contextPolicy: 'fresh-per-game' }] as never }), 'per-game', 'explicit for scripted seats');
});

test('a stopped Claude Code session leaves no project folder for its temp working directory', async () => {
  const { mkdtempSync, mkdirSync, existsSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { claudeProjectDir, removeHarnessProject } = await import('../harnesses.js');
  const config = mkdtempSync(join(tmpdir(), 'claude-config-'));
  const env = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    const work = '/tmp/mtgdt-seat-seat-5e55a1-AbC123/work';
    assert.equal(claudeProjectDir(work), join(config, 'projects', '-tmp-mtgdt-seat-seat-5e55a1-AbC123-work'));
    mkdirSync(claudeProjectDir(work), { recursive: true });
    writeFileSync(join(claudeProjectDir(work), 'x.jsonl'), '{}');
    removeHarnessProject('codex', work);
    assert.ok(existsSync(claudeProjectDir(work)), 'other harnesses: not touched');
    removeHarnessProject('claude-code', work);
    assert.ok(!existsSync(claudeProjectDir(work)));
    // Only the seat's own temp folders, never a project of yours.
    const mine = '/home/me/project';
    mkdirSync(claudeProjectDir(mine), { recursive: true });
    removeHarnessProject('claude-code', mine);
    assert.ok(existsSync(claudeProjectDir(mine)));
  } finally {
    if (env == null) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = env;
  }
});

test('endSession: SIGINT first (the harness writes its result line), then SIGTERM, then SIGKILL only while it still runs', async () => {
  const { endSession } = await import('../rotation.js');
  const sent: string[] = [];
  const stubborn = { exitCode: null as number | null, signalCode: null, kill: (s?: NodeJS.Signals | number) => (sent.push(String(s)), true) };
  endSession(stubborn, { graceMs: 10, killMs: 10 });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(sent, ['SIGINT', 'SIGTERM', 'SIGKILL']);
  // A session that exits on SIGINT (Claude Code does, at once) gets nothing more.
  const polite: string[] = [];
  const child = { exitCode: null as number | null, signalCode: null, kill: (s?: NodeJS.Signals | number) => (polite.push(String(s)), s === 'SIGINT' && (child.exitCode = 1), true) };
  endSession(child, { graceMs: 10, killMs: 10 });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(polite, ['SIGINT']);
  // Cancelled when the process closes.
  const late: string[] = [];
  const cancel = endSession({ exitCode: null, signalCode: null, kill: (s?: NodeJS.Signals | number) => (late.push(String(s)), true) }, { graceMs: 20, killMs: 10 });
  cancel();
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(late, ['SIGINT']);
});
