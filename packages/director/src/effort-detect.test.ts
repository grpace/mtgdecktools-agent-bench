// Effort detection from harness logs (effort-detect.ts). Fixture shapes are copied from real files where the
// source is marked tested in registry/harnesses.json: a Claude Code 2.1.306 session file, a Cursor CLI 2026.10.01
// stream-json init line, an OpenCode 2.1.2 session export. The Codex rollout shape is from its source (untested).
//   npx tsx packages/director/src/effort-detect.test.ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeSessionEffort, codexRolloutEffort, cursorTranscriptEffort, detectSeatEffort, opencodeSessionEffort, parseCursorModelName, parseCursorSlug } from './effort-detect.js';

const dir = mkdtempSync(join(tmpdir(), 'mtgdt-effort-'));
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
let failed = 0;
const check = (name: string, f: () => void) => {
  try {
    f();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n     ${(err as Error).message}`);
  }
};

try {
  check('Claude Code session file: effort per assistant record, version', () => {
    const f = join(dir, 'session-a.jsonl');
    writeFileSync(f, jsonl([
      { type: 'user', version: '2.1.306' },
      { type: 'api-request-blob', message: { output_config: { effort: 'high' } } },
      ...Array.from({ length: 30 }, () => ({ type: 'assistant', requestedModel: 'claude-opus-5-5', effort: 'high', perTurnEffort: 'high', version: '2.1.306', message: { model: 'claude-opus-5-5' } })),
      { type: 'assistant', isSidechain: true, effort: 'low', version: '2.1.306' },
    ]));
    const r = claudeSessionEffort(f);
    assert.deepEqual([r.level, r.counts, r.harness_version, r.source, r.status], ['high', { high: 30 }, '2.1.306', 'claude-session', 'tested']);
  });

  check('Cursor model display names carry the level', () => {
    assert.deepEqual(parseCursorModelName('Gemini 3.8 Flash Low'), { model: 'Gemini 3.8 Flash', level: 'low', fast: false });
    assert.deepEqual(parseCursorModelName('Claude Opus 5.5 1M Extra High'), { model: 'Claude Opus 5.5', level: 'xhigh', fast: false });
    assert.deepEqual(parseCursorModelName('Claude Opus 5.5 1M High Fast'), { model: 'Claude Opus 5.5', level: 'high', fast: true });
    assert.deepEqual(parseCursorModelName('Claude Sonnet 5.5  Max'), { model: 'Claude Sonnet 5.5', level: 'max', fast: false });
    assert.deepEqual(parseCursorModelName('Claude Haiku 5.5  Low No Thinking'), { model: 'Claude Haiku 5.5', level: 'none', fast: false });
    assert.deepEqual(parseCursorModelName('Claude Fable 5.1 1M (NO ZDR)'), { model: 'Claude Fable 5.1', level: null, fast: false });
    // Names from `cursor-agent models` 2026.10.19.
    assert.deepEqual(parseCursorModelName('Grok 4.7  Extra High Fast'), { model: 'Grok 4.7', level: 'xhigh', fast: true });
    assert.deepEqual(parseCursorModelName('Muse Wonder  Minimal'), { model: 'Muse Wonder', level: 'minimal', fast: false });
    assert.deepEqual(parseCursorModelName('GPT-5.6 Sol 1M'), { model: 'GPT-5.6 Sol', level: null, fast: false });
    // cursor-agent 2026.10.19 names the variant it ran with its context size (seen on a hosted table, 2026-10-23).
    assert.deepEqual(parseCursorModelName('GPT-5.6 Luna 272K Low'), { model: 'GPT-5.6 Luna', level: 'low', fast: false });
    assert.deepEqual(parseCursorModelName('Kimi K3'), { model: 'Kimi K3', level: null, fast: false });
  });

  check('Cursor slugs: registry launch strings first (cursor-grok-4.6-high, gpt-5.5-extra-high), then the level off the end', () => {
    assert.deepEqual(parseCursorSlug('grok-4.7-xhigh-fast'), { model: 'grok-4.7', level: 'xhigh', fast: true });
    assert.deepEqual(parseCursorSlug('cursor-grok-4.6-low'), { model: 'grok-4.6', level: 'low', fast: false });
    assert.deepEqual(parseCursorSlug('gpt-5.5-extra-high-fast'), { model: 'gpt-5.5', level: 'xhigh', fast: true });
    assert.deepEqual(parseCursorSlug('muse-wonder-1.0-minimal'), { model: 'muse-wonder-1.0', level: 'minimal', fast: false });
    assert.deepEqual(parseCursorSlug('kimi-k3-max'), { model: 'kimi-k3', level: 'max', fast: false });
    assert.deepEqual(parseCursorSlug('composer-2.5-fast'), { model: 'composer-2.5', level: null, fast: true });
  });

  check('Cursor transcript: init model → level; an unlabeled name is the model\'s Cursor default', () => {
    const f = join(dir, 'transcript-c.jsonl');
    writeFileSync(f, jsonl([{ type: 'system', subtype: 'init', apiKeySource: 'login', model: 'Gemini 3.8 Flash Low', permissionMode: 'default' }, { type: 'result', subtype: 'success' }]));
    const r = cursorTranscriptEffort(f);
    assert.deepEqual([r.level, r.model, r.source], ['low', 'gemini-3.8-flash', 'cursor-model-name']);
    writeFileSync(f, jsonl([{ type: 'system', subtype: 'init', model: 'Claude Opus 5.5 1M' }]));
    assert.equal(cursorTranscriptEffort(f).level, 'medium');
    // Names without a level are Cursor's defaults (registry effort_defaults, from `cursor-agent models` 2026.10.19).
    for (const [name, model, level] of [['GPT-5.6 Sol 1M', 'gpt-5.6-sol', 'medium'], ['Grok 4.6', 'grok-4.6', 'high'], ['Kimi K3', 'kimi-k3', 'max'], ['Muse Spark 1.3 1M', 'muse-spark-1.3', 'high']] as const) {
      writeFileSync(f, jsonl([{ type: 'system', subtype: 'init', model: name }]));
      const c = cursorTranscriptEffort(f);
      assert.deepEqual([c.model, c.level], [model, level], name);
    }
  });

  check('OpenCode session export: model.variant on assistant messages', () => {
    const f = join(dir, 'opencode-session-o.json');
    writeFileSync(f, JSON.stringify({
      info: { id: 'ses_x', agent: 'build' },
      messages: [
        { type: 'user', id: 'u1', text: 'hi' },
        { type: 'assistant', id: 'a1', agent: 'build', model: { id: 'claude-opus-5-5', providerID: 'anthropic', variant: 'max' } },
        { type: 'assistant', id: 'a2', agent: 'build', model: { id: 'claude-opus-5-5', providerID: 'anthropic', variant: 'max' } },
      ],
    }));
    const r = opencodeSessionEffort(f);
    assert.deepEqual([r.level, r.counts, r.model, r.status], ['max', { max: 2 }, 'anthropic/claude-opus-5-5', 'tested']);
  });

  check('Codex rollout: turn_context payload effort (untested shape)', () => {
    const f = join(dir, 'rollout-x.jsonl');
    writeFileSync(f, jsonl([
      { type: 'session_meta', payload: { cli_version: '0.163.0' } },
      { type: 'turn_context', payload: { model: 'gpt-6-astra', effort: 'xhigh', summary: 'auto' } },
      { type: 'turn_context', payload: { model: 'gpt-6-astra', effort: 'xhigh' } },
    ]));
    const r = codexRolloutEffort(f);
    assert.deepEqual([r.level, r.model, r.harness_version, r.status], ['xhigh', 'gpt-6-astra', '0.163.0', 'untested']);
    // No effort in turn_context (the default was used): no level.
    writeFileSync(f, jsonl([{ type: 'turn_context', payload: { model: 'gpt-6-astra' } }]));
    assert.equal(codexRolloutEffort(f).level, null);
  });

  check('detectSeatEffort picks the source by harness', () => {
    assert.equal(detectSeatEffort(dir, 'a', 'claude-code')?.source, 'claude-session');
    assert.equal(detectSeatEffort(dir, 'x', 'Codex CLI')?.source, 'codex-rollout');
    assert.equal(detectSeatEffort(dir, 'o', 'opencode')?.source, 'opencode-session');
    assert.equal(detectSeatEffort(dir, 'c', 'cursor')?.source, 'cursor-model-name');
    assert.equal(detectSeatEffort(dir, 'nobody', 'claude-code'), null);
    assert.equal(detectSeatEffort(dir, 'c', 'gemini-cli'), null);
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failed) {
  console.log(`\n${failed} effort detection test(s) failed`);
  process.exit(1);
}
console.log('\neffort detection: all passed');
