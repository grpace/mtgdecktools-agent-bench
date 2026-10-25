/**
 * The prompts layout: prompts/ (current) and prompts/archive/vN (earlier sets). Old folder names resolve, the hash
 * and prompt_version stay what events logged before the move, and the observation format follows the set.
 *   npx tsx packages/director/src/prompts.test.ts
 */
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observationFormat } from './observation.js';
import { CURRENT_PROMPTS, PROMPTS_ARCHIVE, PROMPTS_DIR, promptsHash, promptVersionOf, resolvePromptsDir } from './prompts.js';
import { TIER_SCORE_RE } from './set-context-filter.js';
import { KNOWN_PROMPT_VERSIONS } from './submissions.js';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

test('old folder names resolve to the archive; "current" and "prompts" to the current prompts', () => {
  for (const v of ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8']) {
    for (const name of [v, `prompts/${v}`, `prompts/${v}/`, `prompts/archive/${v}`]) assert.equal(resolvePromptsDir(name), join(PROMPTS_ARCHIVE, v), name);
  }
  assert.equal(resolvePromptsDir('current'), PROMPTS_DIR);
  assert.equal(resolvePromptsDir('prompts'), PROMPTS_DIR);
  assert.equal(resolvePromptsDir(PROMPTS_DIR), PROMPTS_DIR);
});

test('the current prompts are the v8 set (no tool prohibition); v4 to v7 keep the hashes their events logged', () => {
  // event_start.prompt_sha256 of events run with prompts/v4 (smoke run 2026-10-22-08-55-54-fra-151d).
  const v4 = '16ca4e5d027bbad2dd75095280e3ef9a239ff3f013700871d29d9ff44475c4b0';
  assert.equal(promptsHash(join(PROMPTS_ARCHIVE, 'v4')), v4);
  // v5: the first set that tells seats about sideboarding (2026-10-22).
  const v5 = '98577efe30442371ce16824d9ee3fd5831095e7664d6dfe034e250e127e6cf10';
  assert.equal(promptsHash(join(PROMPTS_ARCHIVE, 'v5')), v5);
  // v6: the deckbuilding guide drops the MTG Deck Tools tier score rules (2026-10-22; owner decision).
  const v6 = '606cd6913dfc3b565a4e8e7be429d6f55f590d2c2239627fd0ec722d8aaef7b3';
  assert.equal(promptsHash(join(PROMPTS_ARCHIVE, 'v6')), v6);
  // v7: the guide no longer mentions tier scores at all (the Set Context filter removes the wording it explained; 2026-10-23).
  const v7 = 'ce47e5dfc6df8c79cab06bdd56d858881b6426050b8f25303bf44f4316efbf4d';
  assert.equal(promptsHash(join(PROMPTS_ARCHIVE, 'v7')), v7);
  // v8: the join prompt no longer tells seats not to use other tools; it says the mtg tools hold everything and to play
  // without the user's help (2026-10-24; owner: don't tell agents they can't use a tool). The harness setup still gives
  // each seat only its mtg server.
  const v8 = 'cecfe75e76d5101a8bfea7d8fe5b2a335b9201fee600d51b26240659877dd2f6';
  assert.equal(promptsHash(PROMPTS_DIR), v8, 'setup.md (for people, not seats) is left out of the hash');
  assert.equal(promptsHash(join(PROMPTS_ARCHIVE, 'v8')), v8);
  assert.equal(promptVersionOf(PROMPTS_DIR), 'v8');
  assert.equal(promptVersionOf(join(PROMPTS_ARCHIVE, 'v3')), 'v3');
  for (const v of ['v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', CURRENT_PROMPTS]) assert.ok(KNOWN_PROMPT_VERSIONS.includes(v), v);
});

test('no prompt a seat reads mentions tier scores (current prompts)', () => {
  for (const f of readdirSync(PROMPTS_DIR).filter((x) => x.endsWith('.md') && x !== 'setup.md')) {
    assert.doesNotMatch(readFileSync(join(PROMPTS_DIR, f), 'utf8'), TIER_SCORE_RE, f);
  }
});

test('prompts refined in place (no archived set matches) are "current"', () => {
  const root = mkdtempSync(join(tmpdir(), 'mtgdt-prompts-'));
  try {
    cpSync(PROMPTS_DIR, root, { recursive: true });
    assert.equal(promptVersionOf(root, root), 'v8');
    writeFileSync(join(root, 'join.md'), 'refined\n');
    assert.equal(promptVersionOf(root, root), CURRENT_PROMPTS);
    const before = promptsHash(root);
    writeFileSync(join(root, 'setup.md'), 'the setup prompt changes nothing for seats\n');
    assert.equal(promptsHash(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the observation format follows the set: current, v4 to v8 → JSON state, v1–v3 → the earlier text', () => {
  assert.equal(observationFormat(PROMPTS_DIR), 'v4');
  assert.equal(observationFormat(resolvePromptsDir('v4')), 'v4');
  assert.equal(observationFormat(resolvePromptsDir('v5')), 'v4');
  assert.equal(observationFormat(resolvePromptsDir('v6')), 'v4');
  assert.equal(observationFormat(resolvePromptsDir('v7')), 'v4');
  assert.equal(observationFormat(resolvePromptsDir('v8')), 'v4');
  for (const v of ['v1', 'v2', 'v3']) assert.equal(observationFormat(resolvePromptsDir(v)), 'v3', v);
});

console.log(`\nprompts: ${passed} passed`);
