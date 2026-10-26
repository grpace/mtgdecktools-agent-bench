/**
 * The prompts layout: prompts/ (current) and prompts/archive/v9 (the same set). The released name resolves, the hash
 * and prompt_version stay "v9" while the files match, and the observation format follows the set.
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

test('the released set resolves to the archive; "current" and "prompts" to the current prompts', () => {
  for (const name of ['v9', 'prompts/v9', 'prompts/v9/', 'prompts/archive/v9']) assert.equal(resolvePromptsDir(name), join(PROMPTS_ARCHIVE, 'v9'), name);
  assert.equal(resolvePromptsDir('current'), PROMPTS_DIR);
  assert.equal(resolvePromptsDir('prompts'), PROMPTS_DIR);
  assert.equal(resolvePromptsDir(PROMPTS_DIR), PROMPTS_DIR);
});

test('the current prompts are the v9 set (choices only, the pick clock)', () => {
  // v9: seats answer with their choice only and are told the draft pick clock (2026-10-26).
  const v9 = '982f93cba2d89e64f55d8cf08b4a9486a800ac055c0305620d794208ccab04ea';
  assert.equal(promptsHash(PROMPTS_DIR), v9, 'setup.md (for people, not seats) is left out of the hash');
  assert.equal(promptsHash(join(PROMPTS_ARCHIVE, 'v9')), v9);
  assert.equal(promptVersionOf(PROMPTS_DIR), 'v9');
  assert.equal(promptVersionOf(join(PROMPTS_ARCHIVE, 'v9')), 'v9');
  for (const v of ['v9', CURRENT_PROMPTS]) assert.ok(KNOWN_PROMPT_VERSIONS.includes(v), v);
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
    assert.equal(promptVersionOf(root, root), 'v9');
    writeFileSync(join(root, 'join.md'), 'refined\n');
    assert.equal(promptVersionOf(root, root), CURRENT_PROMPTS);
    const before = promptsHash(root);
    writeFileSync(join(root, 'setup.md'), 'the setup prompt changes nothing for seats\n');
    assert.equal(promptsHash(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the current prompts use the JSON observation format', () => {
  assert.equal(observationFormat(PROMPTS_DIR), 'v4');
  assert.equal(observationFormat(resolvePromptsDir('v9')), 'v4');
});

console.log(`\nprompts: ${passed} passed`);
