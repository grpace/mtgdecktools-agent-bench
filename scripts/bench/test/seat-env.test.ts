// A seat's environment is built from an allowlist (harnesses.ts seatEnv): the variables of the session that runs
// `bench` (a coding agent's own CLAUDE_* and messaging variables) and other tokens never reach a seat's harness.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { LAUNCHABLE, seatEnv } from '../harnesses.js';

/** What a Claude Code session (or another coding agent) running `bench` leaves in its environment, and other secrets. */
const LEAKED: Record<string, string> = {
  CLAUDE_EFFORT: 'max', CLAUDE_CODE_SESSION_ID: 'sess-1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
  CLAUDE_CODE_MESSAGING_SOCKET: '/run/user/1000/cc.sock', CLAUDE_CODE_MESSAGING_TOKEN: 'mtok', CLAUDE_CODE_SESSION_ATTENDED: '1', CLAUDE_PID: '42',
  CLAUDE_AGENT_SDK_VERSION: '1.0', CLAUDE_CODE_EXECPATH: '/x/claude', AI_AGENT: 'claude-code', T3CODE_CLI_PATH: '/x/t3', SSH_AUTH_SOCK: '/tmp/ssh.sock',
  LD_LIBRARY_PATH: '/appimage/lib', LD_PRELOAD: '/x.so', NODE_OPTIONS: '--require /x.js', BENCH_TOKEN: 'b', HUB_ADMIN_TOKEN: 'h', ADMIN_TOKEN: 'a',
  GITHUB_TOKEN: 'g', GH_TOKEN: 'g', NPM_TOKEN: 'n', SOME_SECRET: 's', DB_PASSWORD: 'p',
  // API keys reach a seat only with --use-api-key.
  ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o', GEMINI_API_KEY: 'g', CURSOR_API_KEY: 'c', AWS_SECRET_ACCESS_KEY: 'aws',
};
const NEEDED: Record<string, string> = { PATH: '/usr/bin:/bin', HOME: '/home/u', LANG: 'en_US.UTF-8', LC_ALL: 'C.UTF-8', TERM: 'xterm', HTTPS_PROXY: 'http://p:3128', XDG_CONFIG_HOME: '/home/u/.config' };
const base = { ...NEEDED, ...LEAKED, CLAUDE_CONFIG_DIR: '/home/u/.claude-other', CLAUDE_CODE_OAUTH_TOKEN: 'oauth' };

test('every launchable harness: the parent session\'s variables and other tokens are left out', () => {
  for (const h of LAUNCHABLE) {
    const env = seatEnv(base, {}, { harness: h.id });
    for (const k of Object.keys(LEAKED)) assert.equal(env[k], undefined, `${h.id}: ${k} leaked`);
    for (const [k, v] of Object.entries(NEEDED)) assert.equal(env[k], v, `${h.id}: ${k} missing`);
  }
});

test('Claude Code keeps its sign-in (config folder, OAuth token); other harnesses don\'t get it', () => {
  const cc = seatEnv(base, {}, { harness: 'claude-code' });
  assert.equal(cc.CLAUDE_CONFIG_DIR, '/home/u/.claude-other');
  assert.equal(cc.CLAUDE_CODE_OAUTH_TOKEN, 'oauth');
  assert.equal(seatEnv(base, {}, { harness: 'codex' }).CLAUDE_CONFIG_DIR, undefined);
});

test('API keys only with --use-api-key, and only the harness\'s own', () => {
  assert.equal(seatEnv(base, {}, { harness: 'claude-code', useApiKey: true }).ANTHROPIC_API_KEY, 'sk-a');
  assert.equal(seatEnv(base, {}, { harness: 'claude-code', useApiKey: true }).OPENAI_API_KEY, undefined);
  assert.equal(seatEnv(base, {}, { harness: 'codex', useApiKey: true }).OPENAI_API_KEY, 'sk-o');
  assert.equal(seatEnv(base, {}, { harness: 'cursor', useApiKey: true }).CURSOR_API_KEY, 'c');
  assert.equal(seatEnv(base, {}, { harness: 'gemini-cli', useApiKey: true }).GEMINI_API_KEY, 'g');
  // Still never the parent session's variables.
  assert.equal(seatEnv(base, {}, { harness: 'claude-code', useApiKey: true }).CLAUDE_CODE_SESSION_ID, undefined);
});

test('the launch\'s own changes apply on top (set and unset)', () => {
  const env = seatEnv(base, { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', HOME: '/seat/home', LANG: null }, { harness: 'claude-code' });
  assert.equal(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
  assert.equal(env.HOME, '/seat/home');
  assert.equal(env.LANG, undefined);
});

test('a real child process sees none of the leaked variables', () => {
  const parent = { ...process.env, ...LEAKED, CLAUDE_CONFIG_DIR: '/tmp/cc-config' };
  for (const h of LAUNCHABLE) {
    const env = seatEnv(parent, h.id === 'claude-code' ? { ANTHROPIC_API_KEY: null } : {}, { harness: h.id });
    const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const seen = JSON.parse(r.stdout) as Record<string, string>;
    for (const k of Object.keys(LEAKED)) assert.equal(seen[k], undefined, `${h.id}: ${k} reached the child`);
    if (process.env.PATH) assert.equal(seen.PATH, process.env.PATH);
    if (h.id === 'claude-code') assert.equal(seen.CLAUDE_CONFIG_DIR, '/tmp/cc-config');
  }
});
