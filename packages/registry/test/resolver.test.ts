import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  identityKey, identityLabel, modelsForHarness, normalizeEffort, primaryModelFromUsage, Registry, REGISTRY_DATA, resolveHarness, resolveModel,
  resolveSeat, validateRegistry, verifySeatModel, type RegistryData,
} from '../src/index.js';

const AT = '2026-10-21'; // the maintainers' first events

const id = (raw: string, harness?: string, at: string = AT) => {
  const r = resolveModel(raw, harness, { at });
  return r.ok ? r.id : null;
};

// ---------------------------------------------------------------------------
// resolveModel

test('exact ids, display names and case/spacing variants resolve to one id', () => {
  for (const raw of [
    'claude-sonnet-5-5', 'Claude Sonnet 5.5', 'claude sonnet 5.5', 'CLAUDE-SONNET-5-5', '  claude_sonnet_5_5 ', 'Claude-Sonnet-5.5', 'claudesonnet55',
    'sonnet 5.5', 'Sonnet-5-5',
  ]) assert.equal(id(raw), 'claude-sonnet-5-5', raw);
  assert.equal(id('GPT-6.1 Sol'), 'gpt-6.1-sol');
  assert.equal(id('gpt-6-1-sol'), 'gpt-6.1-sol');
  assert.equal(id('Gemini 3.8 Flash'), 'gemini-3.8-flash');
  assert.equal(id('Gemini 3.1 Pro (Preview)'), 'gemini-3.1-pro-preview');
});

test('provider prefixes (OpenCode, Bedrock, Gemini API) are stripped', () => {
  assert.equal(id('anthropic/claude-sonnet-5-5'), 'claude-sonnet-5-5');
  assert.equal(id('Anthropic/Claude-Opus-5-5'), 'claude-opus-5-5');
  assert.equal(id('anthropic.claude-haiku-5-5'), 'claude-haiku-5-5');
  assert.equal(id('us.anthropic.claude-haiku-5-5'), 'claude-haiku-5-5');
  assert.equal(id('openai/gpt-6-astra'), 'gpt-6-astra');
  assert.equal(id('models/gemini-3.8-flash'), 'gemini-3.8-flash');
  assert.equal(id('google/gemini-4-argon'), 'gemini-4-argon');
  // A prefix alone is not a model.
  assert.equal(id('anthropic/'), null);
});

test('effort hints in the name: OpenCode "#variant", Cursor "[effort=…]", Claude Code "[1m]"', () => {
  const a = resolveModel('anthropic/claude-sonnet-5-5#high', 'opencode', { at: AT });
  assert.ok(a.ok);
  assert.equal(a.id, 'claude-sonnet-5-5');
  assert.equal(a.effortHint, 'high');
  const b = resolveModel('claude-opus-5-5[effort=xhigh]', 'cursor', { at: AT });
  assert.ok(b.ok);
  assert.equal(b.id, 'claude-opus-5-5');
  assert.equal(b.effortHint, 'xhigh');
  const c = resolveModel('sonnet[1m]', 'claude-code', { at: AT });
  assert.ok(c.ok);
  assert.equal(c.id, 'claude-sonnet-5-5');
  assert.equal(c.effortHint, undefined);
});

test('floating aliases ("sonnet") resolve by the event date', () => {
  assert.equal(id('sonnet'), 'claude-sonnet-5-5');
  assert.equal(id('Opus'), 'claude-opus-5-5');
  assert.equal(id('haiku'), 'claude-haiku-5-5');
  assert.equal(id('fable'), 'claude-fable-5-1');
  // Before Claude Haiku 5.5 shipped, "haiku" meant an older model the registry doesn't list: unknown, not guessed.
  const r = resolveModel('haiku', 'claude-code', { at: '2026-10-01' });
  assert.equal(r.ok, false);
  assert.ok(!r.ok && /exact model id/.test(r.error));
  assert.deepEqual(!r.ok && r.suggestions, ['claude-haiku-5-5']);
  // Timestamps work too.
  assert.equal(resolveModel('sonnet', undefined, { at: Date.parse('2026-10-21T21:21:55Z') }).ok, true);
});

test('a successor takes over a floating alias on its date (window boundaries)', () => {
  const data: RegistryData = structuredClone(REGISTRY_DATA);
  const s55 = data.models.find((m) => m.id === 'claude-sonnet-5-5')!;
  s55.floating_aliases = [{ alias: 'sonnet', from: '2026-09-28', until: '2027-03-01' }];
  data.models.push({ ...structuredClone(s55), id: 'claude-sonnet-6', display: 'Claude Sonnet 6', aliases: [], snapshots: [], floating_aliases: [{ alias: 'sonnet', from: '2027-03-01' }], launch: {} });
  assert.deepEqual(validateRegistry(data), []);
  const reg = new Registry(data);
  const at = (d: string) => {
    const r = reg.resolveModel('sonnet', 'claude-code', { at: d });
    return r.ok ? r.id : null;
  };
  assert.equal(at('2026-10-21'), 'claude-sonnet-5-5');
  assert.equal(at('2027-02-28'), 'claude-sonnet-5-5');
  assert.equal(at('2027-03-01'), 'claude-sonnet-6');
  // Overlapping windows are a registry error.
  s55.floating_aliases = [{ alias: 'sonnet', from: '2026-09-28' }];
  assert.ok(validateRegistry(data).some((e) => /overlap/.test(e)));
});

test('dated snapshots map to the canonical id, flagged when unknown', () => {
  const r = resolveModel('claude-sonnet-5-5-20261001', 'claude-code', { at: AT });
  assert.ok(r.ok);
  assert.equal(r.id, 'claude-sonnet-5-5');
  assert.equal(r.via, 'snapshot');
  assert.equal(r.snapshot, 'claude-sonnet-5-5-20261001');
  assert.equal(r.snapshotKnown, false);
  assert.equal(id('claude-opus-5-5@20261001'), 'claude-opus-5-5');
  assert.equal(id('anthropic/claude-haiku-5-5-2026-10-07'), 'claude-haiku-5-5');
  // Known snapshots are listed in the registry.
  const data: RegistryData = structuredClone(REGISTRY_DATA);
  data.models.find((m) => m.id === 'claude-sonnet-5-5')!.snapshots = ['claude-sonnet-5-5-20260928'];
  const reg = new Registry(data);
  const k = reg.resolveModel('claude-sonnet-5-5-20260928');
  assert.ok(k.ok && k.via === 'snapshot' && k.snapshotKnown === true);
  // A date after an unknown model is still unknown.
  assert.equal(id('claude-sonnet-9-20261001'), null);
});

test('typos and unknown names are unknown, with "did you mean" suggestions', () => {
  for (const [raw, want] of [
    ['claude-sonet-5-5', 'claude-sonnet-5-5'],
    ['claude-sonnet-5', 'claude-sonnet-5-5'],
    ['claude-opus-55', null], // squashes to the same key: not a typo
    ['gpt-6-astr', 'gpt-6-astra'],
    ['gemini-3.8-flsh', 'gemini-3.8-flash'],
    ['sonet', 'claude-sonnet-5-5'],
  ] as const) {
    const r = resolveModel(raw, undefined, { at: AT });
    if (want == null) {
      assert.ok(r.ok, raw);
      continue;
    }
    assert.equal(r.ok, false, raw);
    assert.ok(!r.ok && r.suggestions.includes(want), `${raw}: ${!r.ok ? r.suggestions.join(',') : ''}`);
  }
  const far = resolveModel('llama-9-turbo', undefined, { at: AT });
  assert.equal(far.ok, false);
  assert.deepEqual(!far.ok && far.suggestions, []);
  assert.equal(resolveModel('', undefined).ok, false);
  assert.equal(resolveModel(undefined, undefined).ok, false);
});

test('harness launch strings resolve within that harness', () => {
  const data: RegistryData = structuredClone(REGISTRY_DATA);
  data.models.find((m) => m.id === 'claude-sonnet-5-5')!.launch.cursor = 'sonnet-5.5-thinking';
  const reg = new Registry(data);
  const r = reg.resolveModel('sonnet-5.5-thinking', 'cursor');
  assert.ok(r.ok && r.id === 'claude-sonnet-5-5' && r.via === 'launch');
  assert.equal(reg.resolveModel('sonnet-5.5-thinking', 'codex').ok, false);
});

// ---------------------------------------------------------------------------
// resolveHarness

test('harness names', () => {
  for (const [raw, want] of [
    ['claude-code', 'claude-code'], ['Claude Code', 'claude-code'], ['claude', 'claude-code'], ['CLAUDE_CODE', 'claude-code'], ['cc', 'claude-code'],
    ['codex', 'codex'], ['Codex CLI', 'codex'], ['codex-cli', 'codex'],
    ['gemini', 'gemini-cli'], ['Gemini CLI', 'gemini-cli'],
    ['opencode', 'opencode'], ['OpenCode', 'opencode'], ['open-code', 'opencode'],
    ['cursor-agent', 'cursor'], ['Cursor CLI', 'cursor'],
    ['random', 'script'],
  ] as const) {
    const r = resolveHarness(raw);
    assert.ok(r.ok, raw);
    assert.equal(r.ok && r.id, want, raw);
  }
  const typo = resolveHarness('claude-cod');
  assert.equal(typo.ok, false);
  assert.ok(!typo.ok && typo.suggestions.includes('claude-code'));
  assert.equal(resolveHarness('zed-agent').ok, false);
  assert.equal(resolveHarness('').ok, false);
});

// ---------------------------------------------------------------------------
// normalizeEffort

test('effort: canonical scale, synonyms, per-model support, harnesses without a setting', () => {
  const e = (raw: string | undefined, model?: string, harness?: string) => {
    const r = normalizeEffort(raw, model, harness);
    return r.ok ? r.effort : `error:${r.error}`;
  };
  assert.equal(e(undefined), 'default');
  assert.equal(e(''), 'default');
  assert.equal(e('default'), 'default');
  assert.equal(e('auto'), 'default');
  assert.equal(e('HIGH', 'claude-opus-5-5', 'claude-code'), 'high');
  assert.equal(e('x-high', 'claude-opus-5-5', 'claude-code'), 'xhigh');
  assert.equal(e('Extra High', 'claude-opus-5-5', 'claude-code'), 'xhigh');
  assert.equal(e('maximum', 'claude-fable-5-1', 'claude-code'), 'max');
  assert.equal(e('med', 'gpt-6-astra', 'codex'), 'medium');
  // Model support: GPT-6 Luna has "none", Claude Opus 5.5 doesn't; Gemini has no xhigh.
  assert.equal(e('none', 'gpt-6-luna', 'codex'), 'none');
  assert.match(e('none', 'claude-opus-5-5', 'claude-code'), /^error:Claude Opus 5.5 supports effort low, medium, high, xhigh, max/);
  assert.match(e('xhigh', 'gemini-3.8-flash', 'opencode'), /^error:/);
  // No effort setting in the harness: recorded as default, with a warning.
  const g = normalizeEffort('high', 'gemini-3.8-flash', 'gemini-cli');
  assert.ok(g.ok && g.effort === 'default' && /no effort setting/.test(g.warning ?? ''));
  // Unknown words fail.
  assert.match(e('turbo', 'claude-opus-5-5', 'claude-code'), /^error:unknown effort/);
  // Unknown model: any level on the scale.
  assert.equal(e('high', 'some-new-model'), 'high');
});

// ---------------------------------------------------------------------------
// resolveSeat

test('resolveSeat: canonical values plus the raw declared strings', () => {
  const r = resolveSeat({ harness: 'Claude Code', model: 'Sonnet 5.5', effort: 'High' }, { at: AT });
  assert.ok(r.ok);
  assert.deepEqual(r.seat, {
    harness: 'claude-code', model: 'claude-sonnet-5-5', effort: 'high',
    harness_declared: 'Claude Code', model_declared: 'Sonnet 5.5', effort_declared: 'High',
  });
  assert.equal(r.listed, true);
  // Already canonical: no *_declared copies.
  const c = resolveSeat({ harness: 'codex', model: 'gpt-6-astra', effort: 'medium' }, { at: AT });
  assert.ok(c.ok);
  assert.deepEqual(c.seat, { harness: 'codex', model: 'gpt-6-astra', effort: 'medium' });
  // Effort from the name.
  const o = resolveSeat({ harness: 'opencode', model: 'anthropic/claude-opus-5-5#max' }, { at: AT });
  assert.ok(o.ok && o.seat.effort === 'max' && o.seat.model === 'claude-opus-5-5');
  // No effort: "default".
  const d = resolveSeat({ harness: 'claude-code', model: 'opus' }, { at: AT });
  assert.ok(d.ok && d.seat.effort === 'default' && d.seat.model === 'claude-opus-5-5' && d.seat.model_declared === 'opus');
});

test('resolveSeat: unknown models fail with suggestions and the registry hint, unless allowUnlisted', () => {
  const r = resolveSeat({ harness: 'claude-code', model: 'claude-sonet-5-5', effort: 'high' }, { at: AT });
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.field === 'model' && r.suggestions[0] === 'claude-sonnet-5-5');
  assert.ok(!r.ok && /registry\/README\.md/.test(r.error) && /Did you mean claude-sonnet-5-5/.test(r.error));
  const u = resolveSeat({ harness: 'claude-code', model: 'My-Finetune v2', effort: 'high' }, { at: AT, allowUnlisted: true });
  assert.ok(u.ok);
  assert.equal(u.listed, false);
  assert.deepEqual(u.seat, { harness: 'claude-code', model: 'my-finetune-v2', effort: 'high', model_declared: 'My-Finetune v2' });
  // Unknown harness: refused, or Unlisted on a private table.
  const h = resolveSeat({ harness: 'Zed Agent', model: 'claude-opus-5-5' }, { at: AT });
  assert.ok(!h.ok && h.field === 'harness');
  const hu = resolveSeat({ harness: 'Zed Agent', model: 'claude-opus-5-5' }, { at: AT, allowUnlisted: true });
  assert.ok(hu.ok && hu.listed === false && hu.seat.harness === 'zed-agent' && hu.seat.model === 'claude-opus-5-5');
  // Missing pieces.
  assert.ok(!resolveSeat({ model: 'opus' }).ok);
  assert.ok(!resolveSeat({ harness: 'codex' }).ok);
  // Bad effort for the model.
  const be = resolveSeat({ harness: 'claude-code', model: 'claude-haiku-5-5', effort: 'none' }, { at: AT });
  assert.ok(!be.ok && be.field === 'effort');
});

test('resolveSeat: the scripted test player passes through', () => {
  const r = resolveSeat({ harness: 'script', model: 'random' });
  assert.ok(r.ok && r.test && r.seat.harness === 'script' && r.seat.effort === 'default');
});

// ---------------------------------------------------------------------------
// primaryModelFromUsage / verifySeatModel

test('primary model: most output tokens, helper models ignored', () => {
  // Claude Code: a Sonnet seat with the background Haiku (from a real transcript's modelUsage).
  const p = primaryModelFromUsage({ model_output_tokens: { 'claude-haiku-5-5': 19, 'claude-sonnet-5-5': 71465 } }, 'claude-code');
  assert.equal(p.id, 'claude-sonnet-5-5');
  // Even if the helper had more output, the seat's own model wins.
  const h = primaryModelFromUsage({ model_output_tokens: { 'claude-haiku-5-5': 90000, 'claude-opus-5-5': 500 } }, 'claude-code');
  assert.equal(h.id, 'claude-opus-5-5');
  // A Haiku seat: Haiku is the only model, so it is the primary.
  assert.equal(primaryModelFromUsage({ model_output_tokens: { 'claude-haiku-5-5': 86865 } }, 'claude-code').id, 'claude-haiku-5-5');
  // Old usage files: ids only.
  assert.equal(primaryModelFromUsage({ model_ids: ['claude-sonnet-5-5', 'claude-haiku-5-5'] }, 'claude-code').id, 'claude-sonnet-5-5');
  assert.equal(primaryModelFromUsage({ model_ids: ['claude-haiku-5-5'] }, 'claude-code').id, 'claude-haiku-5-5');
  // Two real models, no tokens: ambiguous.
  const amb = primaryModelFromUsage({ model_ids: ['claude-sonnet-5-5', 'claude-opus-5-5'] }, 'claude-code');
  assert.equal(amb.id, null);
  assert.equal(amb.ambiguous, true);
  // Most output tokens decides between real models.
  assert.equal(primaryModelFromUsage({ model_output_tokens: { 'claude-sonnet-5-5': 10, 'claude-opus-5-5': 900 } }, 'claude-code').id, 'claude-opus-5-5');
  // Snapshots and provider prefixes add up under one canonical id.
  const s = primaryModelFromUsage({ model_output_tokens: { 'anthropic/claude-sonnet-5-5': 400, 'claude-sonnet-5-5-20261001': 300, 'claude-opus-5-5': 600 } }, 'opencode');
  assert.equal(s.id, 'claude-sonnet-5-5');
  // Without a harness there are no helpers: Haiku with more tokens wins.
  assert.equal(primaryModelFromUsage({ model_output_tokens: { 'claude-haiku-5-5': 90000, 'claude-opus-5-5': 500 } }).id, 'claude-haiku-5-5');
  // Cursor reports display names.
  assert.equal(primaryModelFromUsage({ model_ids: ['Claude Sonnet 5.5'] }, 'cursor').id, 'claude-sonnet-5-5');
  // Nothing reported.
  assert.equal(primaryModelFromUsage({ model_ids: [] }, 'codex').id, null);
  assert.equal(primaryModelFromUsage(null).id, null);
});

test('verifySeatModel: verified, self-reported, mismatch, unlisted', () => {
  const v = (model: string, usage: Parameters<typeof verifySeatModel>[1], harness = 'claude-code') => verifySeatModel({ model, harness, at: AT }, usage);
  assert.equal(v('sonnet', { model_ids: ['claude-sonnet-5-5', 'claude-haiku-5-5'] }).status, 'verified');
  assert.equal(v('claude-sonnet-5-5', { model_output_tokens: { 'claude-sonnet-5-5': 5 } }).status, 'verified');
  assert.equal(v('haiku', { model_ids: ['claude-haiku-5-5'] }).status, 'verified');
  assert.equal(v('claude-opus-5-5', null).status, 'self-reported');
  assert.equal(v('gpt-6-astra', { model_ids: [] }, 'codex').status, 'self-reported');
  const m = v('claude-opus-5-5', { model_output_tokens: { 'claude-sonnet-5-5': 5000, 'claude-haiku-5-5': 10 } });
  assert.equal(m.status, 'mismatch');
  assert.match(m.reason, /claude-sonnet-5-5/);
  assert.equal(v('claude-opus-5-5', { model_ids: ['claude-opus-5-5', 'claude-sonnet-5-5'] }).status, 'mismatch');
  assert.equal(v('my-model', { model_ids: ['my-model'] }).status, 'unlisted');
  const snap = v('claude-sonnet-5-5', { model_ids: ['claude-sonnet-5-5-20261101'] });
  assert.equal(snap.status, 'verified');
  assert.equal(snap.snapshot, 'claude-sonnet-5-5-20261101');
  assert.equal(snap.snapshot_known, false);
});

// ---------------------------------------------------------------------------
// Labels, pickers, registry validation

test('identity keys and labels use canonical ids and registry display names', () => {
  // The identity is the model and its effort level; the harness is a seat detail (METHODOLOGY §2).
  assert.equal(identityKey('claude-sonnet-5-5', 'high'), 'claude-sonnet-5-5/high');
  assert.equal(identityLabel('claude-sonnet-5-5', 'high'), 'Claude Sonnet 5.5 · High');
  assert.equal(identityLabel('gpt-6-astra', 'xhigh'), 'GPT-6 Astra · Extra High');
  assert.equal(identityLabel('claude-opus-5-5', 'default'), 'Claude Opus 5.5 · Default Effort');
});

test('modelsForHarness lists launchable models', () => {
  const cc = modelsForHarness('Claude Code').map((m) => m.id);
  assert.ok(cc.includes('claude-opus-5-5') && cc.includes('claude-haiku-5-5') && !cc.includes('gpt-6-astra'));
  const gem = modelsForHarness('gemini-cli');
  assert.ok(gem.every((m) => m.efforts.length === 0));
  assert.deepEqual(modelsForHarness('nope'), []);
});

test('the shipped registry is valid, and validation catches collisions', () => {
  assert.deepEqual(validateRegistry(REGISTRY_DATA), []);
  const data: RegistryData = structuredClone(REGISTRY_DATA);
  data.models.find((m) => m.id === 'claude-opus-5-5')!.aliases.push('Sonnet 5.5');
  assert.ok(validateRegistry(data).some((e) => /collides/.test(e)));
  const d2: RegistryData = structuredClone(REGISTRY_DATA);
  d2.models[0]!.launch['no-such-harness'] = 'x';
  d2.models[1]!.efforts.push('turbo' as never);
  d2.harnesses[1]!.aliases.push('claude');
  const errs = validateRegistry(d2);
  assert.ok(errs.some((e) => /unknown harness/.test(e)));
  assert.ok(errs.some((e) => /canonical scale/.test(e)));
  assert.ok(errs.some((e) => /collides with harness claude-code/.test(e)));
  const d3: RegistryData = structuredClone(REGISTRY_DATA);
  d3.models.find((m) => m.id === 'gpt-6-astra')!.aliases.push('opus');
  assert.ok(validateRegistry(d3).some((e) => /floating alias "opus" collides/.test(e)));
});

// ---------------------------------------------------------------------------
// Version and staleness (deps/manifest.json, `npm run deps -- check`)

test('registryVersion is a content hash: stable under formatting, changes with content', async () => {
  const { registryVersion } = await import('../src/index.js');
  const a = registryVersion();
  assert.match(a.version, /^sha256-[0-9a-f]{12}$/);
  const reordered: RegistryData = structuredClone(REGISTRY_DATA);
  reordered.models = reordered.models.map((m) => Object.fromEntries(Object.entries(m).reverse()) as typeof m);
  assert.equal(registryVersion(reordered).sha256, a.sha256);
  const changed: RegistryData = structuredClone(REGISTRY_DATA);
  changed.models[0]!.aliases.push('something-new');
  assert.notEqual(registryVersion(changed).sha256, a.sha256);
});

test('staleness: names used in events that the registry does not know', async () => {
  const { checkObservations } = await import('../src/stale.js');
  const r = checkObservations([
    { model: 'claude-sonnet-5-5', harness: 'claude-code', at: AT, source: 'declared', event: 'e1' },
    { model: 'claude-haiku-5-5', harness: 'claude-code', at: AT, source: 'usage', event: 'e1' },
    { model: 'claude-sonnet-6', harness: 'claude-code', at: AT, source: 'usage', event: 'e2' },
    { model: 'claude-sonnet-6', harness: 'claude-code', at: AT, source: 'usage', event: 'e3' },
    { model: 'claude-opus-5-5-20261201', harness: 'claude-code', at: AT, source: 'usage', event: 'e4' },
    { model: 'x', harness: 'zed', at: AT, source: 'declared', event: 'e5' },
    { model: 'random', harness: 'script', at: AT, source: 'declared', event: 'e6' },
  ]);
  assert.equal(r.stale, true);
  const kinds = r.findings.map((f) => `${f.kind}:${f.name}`);
  assert.ok(kinds.includes('unknown_model:claude-sonnet-6'));
  assert.equal(r.findings.find((f) => f.name === 'claude-sonnet-6')!.seen, 2);
  assert.ok(kinds.includes('unknown_snapshot:claude-opus-5-5-20261201'));
  assert.ok(kinds.includes('unknown_harness:zed'));
  assert.ok(!kinds.some((k) => k.includes('random')));
  assert.equal(checkObservations([{ model: 'sonnet', harness: 'claude-code', at: AT, source: 'declared' }]).stale, false);
});

// ---------------------------------------------------------------------------
// Concrete effort (METHODOLOGY §2.1): launch helpers, harness defaults, resolution order

test('effort at launch: flags, model strings and the recommended level', async () => {
  const { effortFlag, launchSpec, recommendedEffort } = await import('../src/index.js');
  assert.deepEqual(effortFlag('claude-code', 'high'), ['--effort', 'high']);
  assert.deepEqual(effortFlag('codex', 'xhigh'), ['-c', 'model_reasoning_effort="xhigh"']);
  assert.deepEqual(effortFlag('gemini-cli', 'high'), []);
  assert.deepEqual(effortFlag('claude-code', 'default'), []);
  assert.deepEqual(launchSpec('claude-code', 'sonnet', 'high'), { model: 'claude-sonnet-5-5', args: ['--effort', 'high'], settable: true });
  assert.deepEqual(launchSpec('codex', 'gpt-6-luna', 'none'), { model: 'gpt-6-luna', args: ['-c', 'model_reasoning_effort="none"'], settable: true });
  assert.deepEqual(launchSpec('opencode', 'claude-opus-5-5', 'max'), { model: 'anthropic/claude-opus-5-5#max', args: [], settable: true });
  assert.deepEqual(launchSpec('cursor', 'claude-opus-5-5', 'xhigh'), { model: 'claude-opus-5-5-xhigh', args: [], settable: true });
  assert.deepEqual(launchSpec('cursor', 'claude-haiku-5-5', 'low'), { model: 'claude-haiku-5-5-thinking-low', args: [], settable: true });
  assert.deepEqual(launchSpec('gemini-cli', 'gemini-3.8-flash', 'high'), { model: 'gemini-3.8-flash', args: [], settable: false });
  // A level the model doesn't have is not settable.
  assert.equal(launchSpec('claude-code', 'claude-opus-5-5', 'none').settable, false);
  const r = recommendedEffort('claude-opus-5-5', 'claude-code');
  assert.equal(r.level, 'high');
  assert.equal(r.settable, true);
  assert.match(r.reason, /common level/);
  const g = recommendedEffort('gemini-3.8-flash', 'gemini-cli');
  assert.deepEqual([g.level, g.settable], ['high', false]);
  assert.match(g.reason, /no effort setting/);
  assert.equal(recommendedEffort('gemini-4-argon', 'gemini-cli').level, 'unknown');
});

test('harness defaults: per model and version range; unknown version or undocumented → null', async () => {
  const { harnessDefaultEffort } = await import('../src/index.js');
  assert.equal(harnessDefaultEffort('claude-code', 'claude-opus-5-5', '2.1.306 (Claude Code)')?.level, 'medium');
  assert.equal(harnessDefaultEffort('claude-code', 'claude-fable-5-1', '2.1.306')?.level, 'high');
  assert.equal(harnessDefaultEffort('claude-code', 'claude-opus-5-5', '2.1.200'), null, 'before the model was in Claude Code');
  assert.equal(harnessDefaultEffort('claude-code', 'claude-opus-5-5', undefined), null, 'version unknown');
  assert.equal(harnessDefaultEffort('codex', 'gpt-6-astra', 'codex-cli 0.163.0')?.level, 'low');
  assert.equal(harnessDefaultEffort('codex', 'gpt-6-luna', '0.160.0')?.level, 'medium');
  assert.equal(harnessDefaultEffort('gemini-cli', 'gemini-3.8-flash', '0.65.0')?.level, 'high');
  assert.equal(harnessDefaultEffort('gemini-cli', 'gemini-4-argon', '0.65.0'), null);
  assert.equal(harnessDefaultEffort('opencode', 'claude-opus-5-5', '2.1.2'), null);
  // Cursor's unlabeled model names hold for every version.
  assert.equal(harnessDefaultEffort('cursor', 'claude-opus-5-5')?.level, 'medium');
});

test('effort resolution order: detected, declared, harness default, Unknown', async () => {
  const { resolveSeatEffort } = await import('../src/index.js');
  const base = { harness: 'claude-code', model: 'claude-opus-5-5', at: AT };
  const det = (level: string, counts?: Record<string, number>) => ({ level, source: 'claude-session', ...(counts ? { counts } : {}) });
  // Detected and matching → verified.
  let r = resolveSeatEffort({ ...base, declared: 'high', basis: 'launch', detected: det('high', { high: 40 }) });
  assert.deepEqual([r.effort, r.source, r.status], ['high', 'detected', 'verified']);
  // Detected and different → the logs win, flagged.
  r = resolveSeatEffort({ ...base, declared: 'high', basis: 'launch', detected: det('xhigh', { xhigh: 40 }) });
  assert.deepEqual([r.effort, r.source, r.status], ['xhigh', 'detected', 'mismatch']);
  assert.match(r.reason, /declared high/);
  // Changed during the session → Unknown, mismatch.
  r = resolveSeatEffort({ ...base, declared: 'high', detected: det('high', { high: 20, low: 20 }) });
  assert.deepEqual([r.effort, r.source, r.status], ['unknown', 'unknown', 'mismatch']);
  // A small minority of other turns is tolerated.
  r = resolveSeatEffort({ ...base, detected: det('high', { high: 95, medium: 5 }) });
  assert.deepEqual([r.effort, r.source], ['high', 'detected']);
  // No logs: explicit at launch vs self-reported.
  r = resolveSeatEffort({ ...base, declared: 'max', basis: 'launch' });
  assert.deepEqual([r.effort, r.source, r.status], ['max', 'declared-explicit', 'self-reported']);
  r = resolveSeatEffort({ ...base, declared: 'max', basis: 'self-report' });
  assert.deepEqual([r.effort, r.source], ['max', 'self-reported']);
  r = resolveSeatEffort({ ...base, declared: 'max' });
  assert.equal(r.source, 'self-reported', 'older logs without a basis count as self-reported');
  // "default", "I don't know" or nothing → the documented default for that harness version.
  for (const declared of [undefined, 'default', 'unknown', "I don't know"]) {
    r = resolveSeatEffort({ ...base, ...(declared ? { declared } : {}), harnessVersion: '2.1.306' });
    assert.deepEqual([r.effort, r.source, r.harness_version], ['medium', 'harness-default', '2.1.306'], String(declared));
    assert.match(r.default_source ?? '', /^https:\/\/code\.claude\.com/);
  }
  // …or Unknown when the version is unknown or the default undocumented.
  r = resolveSeatEffort({ ...base, declared: 'default' });
  assert.deepEqual([r.effort, r.source], ['unknown', 'unknown']);
  assert.match(r.reason, /version is unknown/);
  r = resolveSeatEffort({ harness: 'opencode', model: 'claude-opus-5-5', declared: 'default', harnessVersion: '2.1.2' });
  assert.deepEqual([r.effort, r.source], ['unknown', 'unknown']);
  assert.match(r.reason, /isn't documented/);
  // Gemini CLI: no control, fixed documented behavior.
  r = resolveSeatEffort({ harness: 'gemini-cli', model: 'gemini-3.8-flash', declared: 'high', harnessVersion: '0.65.0' });
  assert.deepEqual([r.effort, r.source], ['high', 'harness-default']);
});

test('resolveSeat: requireEffort for rated tables; "I don\'t know" declares default', () => {
  const r = resolveSeat({ harness: 'claude-code', model: 'claude-opus-5-5' }, { at: AT, requireEffort: true });
  assert.ok(!r.ok && r.field === 'effort');
  assert.ok(!r.ok && /recommended: high/.test(r.error) && r.suggestions.includes('xhigh'));
  assert.ok(resolveSeat({ harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high' }, { at: AT, requireEffort: true }).ok);
  // Harnesses without an effort control don't need one.
  assert.ok(resolveSeat({ harness: 'gemini-cli', model: 'gemini-3.8-flash' }, { at: AT, requireEffort: true }).ok);
  const u = resolveSeat({ harness: 'claude-code', model: 'claude-opus-5-5', effort: 'unknown' }, { at: AT });
  assert.ok(u.ok && u.seat.effort === 'default' && u.seat.effort_declared === 'unknown');
});

test('hand-seated MCP clients: names, effort words, declared levels count as set explicitly', async () => {
  const { resolveSeatEffort } = await import('../src/index.js');
  for (const [raw, want] of [
    ['Claude Desktop', 'claude-desktop'], ['Cline', 'cline'], ['Continue', 'continue'],
    ['VS Code', 'vscode-copilot'], ['GitHub Copilot', 'vscode-copilot'], ['Windsurf', 'devin-desktop'], ['Devin Desktop', 'devin-desktop'],
  ] as const) {
    const r = resolveHarness(raw);
    assert.equal(r.ok && r.id, want, raw);
  }
  const d = normalizeEffort('Extra high', 'claude-opus-5-5', 'claude-desktop');
  assert.ok(d.ok && d.effort === 'xhigh');
  let r = resolveSeatEffort({ harness: 'claude-desktop', model: 'claude-opus-5-5', declared: 'high' });
  assert.deepEqual([r.effort, r.source, r.status], ['high', 'declared-explicit', 'self-reported']);
  assert.match(r.reason, /picked in Claude Desktop/);
  // An explicit self-report basis still says so.
  r = resolveSeatEffort({ harness: 'claude-desktop', model: 'claude-opus-5-5', declared: 'high', basis: 'self-report' });
  assert.equal(r.source, 'self-reported');
  // No effort control (Cline's extension, Continue): Unknown, and rated tables can't demand a level.
  r = resolveSeatEffort({ harness: 'cline', model: 'claude-sonnet-5-5', declared: 'default' });
  assert.deepEqual([r.effort, r.source], ['unknown', 'unknown']);
  assert.ok(resolveSeat({ harness: 'continue', model: 'claude-sonnet-5-5' }, { at: AT, requireEffort: true }).ok);
  const need = resolveSeat({ harness: 'vscode-copilot', model: 'claude-sonnet-5-5' }, { at: AT, requireEffort: true });
  assert.ok(!need.ok && need.field === 'effort');
});

test('ultra: its own unordered level, Codex only, for the models that offer it', async () => {
  const { launchSpec, recommendedEffort, REGISTRY_DATA: data } = await import('../src/index.js');
  const ultra = data.effort_scale.find((e) => e.id === 'ultra')!;
  assert.equal(ultra.rank, null, 'Codex docs give no order relative to max');
  assert.equal(ultra.display, 'Ultra');
  for (const m of ['gpt-6-astra', 'gpt-6.1-sol']) {
    const e = normalizeEffort('ultra', m, 'codex');
    assert.ok(e.ok && e.effort === 'ultra', m);
  }
  assert.equal(normalizeEffort('ultra', 'gpt-6-luna', 'codex').ok, false, 'Luna goes up to max, not ultra');
  assert.equal(normalizeEffort('ultra', 'claude-opus-5-5', 'claude-code').ok, false);
  // Never mapped onto max: a seat at ultra is its own row.
  const s = resolveSeat({ harness: 'codex', model: 'gpt-6.1-sol', effort: 'Ultra' }, { at: AT });
  assert.ok(s.ok && s.seat.effort === 'ultra');
  assert.deepEqual(launchSpec('codex', 'gpt-6.1-sol', 'ultra'), { model: 'gpt-6.1-sol', args: ['-c', 'model_reasoning_effort="ultra"'], settable: true });
  assert.equal(launchSpec('opencode', 'gpt-6.1-sol', 'ultra').settable, false, 'only Codex takes ultra');
  assert.equal(recommendedEffort('gpt-6.1-sol', 'codex').level, 'high');
});

test('launchers: T3 Code starts a harness; the seat is that harness, with the launcher recorded beside it', async () => {
  const { harnessDefaultEffort, launchSpec, resolveSeatEffort, registry } = await import('../src/index.js');
  for (const raw of ['t3-code:claude-code', 'T3 Code (Claude Code)', 'Claude Code via T3 Code', 't3+claude']) {
    const r = resolveHarness(raw);
    assert.ok(r.ok && r.id === 'claude-code' && r.launcher?.id === 't3-code', raw);
  }
  const p = resolveHarness('T3 Code (OpenCode)');
  assert.ok(p.ok && p.id === 'opencode' && p.harness.display === 'OpenCode' && p.launcher?.display === 'T3 Code');
  assert.equal(resolveHarness('T3 Code (Gemini CLI)').ok, false, 'not a harness T3 Code starts');
  // A bare launcher isn't a harness: the error names the harnesses it starts.
  for (const raw of ['T3 Code', 't3', 't3code']) {
    const r = resolveHarness(raw);
    assert.ok(!r.ok && /not a harness/.test(r.error) && r.suggestions.includes('t3-code:claude-code'), raw);
  }
  const bare = resolveSeat({ harness: 'T3 Code', model: 'claude-opus-5-5', effort: 'high' }, { at: AT });
  assert.ok(!bare.ok && bare.field === 'harness' && bare.suggestions.includes('t3-code:claude-code'));
  // The identity is the harness's; the declared string keeps the launcher, so an export re-derives it.
  const s = resolveSeat({ harness: 'T3 Code (Claude Code)', model: 'opus', effort: 'High' }, { at: AT });
  assert.ok(s.ok);
  assert.deepEqual([s.seat.harness, s.seat.launcher, s.seat.harness_declared, s.seat.model, s.seat.effort], ['claude-code', 't3-code', 'T3 Code (Claude Code)', 'claude-opus-5-5', 'high']);
  const plain = resolveSeat({ harness: 'claude-code', model: 'opus', effort: 'high' }, { at: AT });
  assert.ok(plain.ok && plain.seat.launcher === undefined);
  assert.equal(identityKey(s.seat.model, s.seat.effort), 'claude-opus-5-5/high');
  assert.equal(registry.launcherDisplay('t3-code'), 'T3 Code');
  // The harness's own data: defaults by its version, launch strings, detection.
  assert.equal(harnessDefaultEffort('t3-code:claude-code', 'claude-opus-5-5', '2.1.306')?.level, 'medium');
  assert.deepEqual(launchSpec('t3-code:cursor', 'claude-opus-5-5', 'high'), launchSpec('cursor', 'claude-opus-5-5', 'high'));
  const r = resolveSeatEffort({ harness: 't3-code:claude-code', model: 'claude-opus-5-5', declared: 'high', detected: { level: 'high', counts: { high: 5 }, source: 'claude-session' } });
  assert.deepEqual([r.effort, r.source, r.status], ['high', 'detected', 'verified']);
  // A level picked in the launcher's model picker is set explicitly, not checked (like an app seated by hand).
  const picked = resolveSeatEffort({ harness: 't3-code:claude-code', model: 'claude-opus-5-5', declared: 'high' });
  assert.deepEqual([picked.source, picked.status], ['declared-explicit', 'self-reported']);
  assert.match(picked.reason, /picked in T3 Code/);
});

test('launchers: names never collide with a harness, and only start known harnesses', async () => {
  const { validateRegistry, REGISTRY_DATA } = await import('../src/index.js');
  assert.deepEqual(validateRegistry(REGISTRY_DATA), []);
  const bad = { ...REGISTRY_DATA, launchers: [{ id: 'cc', display: 'Claude Code', vendor: 'x', aliases: [], docs: 'https://x', launches: ['nope'], logs: { where: '', status: 'untested' as const } }] };
  const errs = validateRegistry(bad);
  assert.ok(errs.some((e) => /launcher cc: name "Claude Code" collides with harness claude-code/.test(e)), errs.join('\n'));
  assert.ok(errs.some((e) => /launches unknown harness "nope"/.test(e)), errs.join('\n'));
});

test('Antigravity: the thinking level is part of the model id', async () => {
  const { launchSpec } = await import('../src/index.js');
  const a = resolveHarness('Antigravity');
  assert.ok(a.ok && a.id === 'antigravity');
  assert.deepEqual(launchSpec('antigravity', 'gemini-3.8-flash', 'medium'), { model: 'gemini-3.8-flash-medium', args: [], settable: true });
  assert.equal(launchSpec('antigravity', 'gemini-3.8-flash', 'xhigh').settable, false);
  const m = resolveModel('gemini-3.8-flash-medium', 'antigravity', { at: AT });
  assert.ok(m.ok && m.id === 'gemini-3.8-flash' && m.via === 'launch');
  assert.ok(resolveHarness('T3 Code (Antigravity)').ok);
});

// ---------------------------------------------------------------------------
// Mixed-provider tables through T3 Code (catalog names as T3 Code listed them on 2026-10-22)

test('Antigravity: any registry model followed by its level resolves to the model at that level', async () => {
  // The T3 Code Antigravity catalog.
  for (const [raw, model, level] of [
    ['gemini-4-argon-high', 'gemini-4-argon', 'high'], ['gemini-4-argon-medium', 'gemini-4-argon', 'medium'], ['gemini-4-argon-low', 'gemini-4-argon', 'low'],
    ['gemini-3.8-flash-high', 'gemini-3.8-flash', 'high'], ['gemini-3.8-flash-medium', 'gemini-3.8-flash', 'medium'], ['gemini-3.8-flash-low', 'gemini-3.8-flash', 'low'],
  ] as const) {
    for (const h of ['antigravity', 't3-code:antigravity', 'T3 Code (Antigravity)']) {
      const r = resolveModel(raw, h, { at: AT });
      assert.ok(r.ok && r.id === model && r.effortHint === level, `${raw} in ${h}`);
    }
  }
  // Generic: every model and level, with or without a launch string for Antigravity.
  for (const m of REGISTRY_DATA.models) {
    for (const e of m.efforts) {
      const r = resolveModel(`${m.id}-${e}`, 't3-code:antigravity', { at: AT });
      assert.ok(r.ok && r.id === m.id && r.effortHint === e, `${m.id}-${e}`);
    }
  }
  // Level words the effort scale knows ("extra-high" is xhigh) and case or spacing don't matter.
  const x = resolveModel('GPT-5.6 Sol Extra-High', 'antigravity', { at: AT });
  assert.ok(x.ok && x.id === 'gpt-5.6-sol' && x.effortHint === 'xhigh');
  // A level the model doesn't have is refused with the names it does have.
  const bad = resolveModel('gemini-4-argon-xhigh', 'antigravity', { at: AT });
  assert.ok(!bad.ok && /no xhigh level/.test(bad.error));
  assert.deepEqual(bad.suggestions, ['gemini-4-argon-low', 'gemini-4-argon-medium', 'gemini-4-argon-high']);
  // Without a harness the name isn't resolved, but the error says what it reads as.
  const bare = resolveModel('gemini-4-argon-high', undefined, { at: AT });
  assert.ok(!bare.ok && bare.suggestions[0] === 'gemini-4-argon' && /give the harness/.test(bare.error));
  // Other harnesses don't read levels off names.
  assert.equal(id('gemini-4-argon-high', 'claude-code'), null);
  assert.equal(id('gemini-4-argon-high', 'opencode'), null);
});

test('a level in the model name is the seat\'s level; a separate effort that disagrees is refused', () => {
  const s = resolveSeat({ harness: 't3-code:antigravity', model: 'gemini-4-argon-high' }, { at: AT });
  assert.ok(s.ok && s.effortFromName && s.seat.model === 'gemini-4-argon' && s.seat.effort === 'high' && s.seat.model_declared === 'gemini-4-argon-high');
  const same = resolveSeat({ harness: 'antigravity', model: 'gemini-4-argon-high', effort: 'High' }, { at: AT });
  assert.ok(same.ok && same.seat.effort === 'high' && !same.effortFromName);
  for (const effort of ['default', 'unknown']) {
    const d = resolveSeat({ harness: 'antigravity', model: 'gemini-4-argon-low', effort }, { at: AT });
    assert.ok(d.ok && d.seat.effort === 'low' && d.effortFromName, effort);
  }
  const clash = resolveSeat({ harness: 'antigravity', model: 'gemini-4-argon-high', effort: 'low' }, { at: AT });
  assert.ok(!clash.ok && clash.field === 'effort' && clash.suggestions[0] === 'high' && /sets effort high/.test(clash.error));
  // The same rule for OpenCode's "#variant" and Cursor's launch names.
  assert.ok(!resolveSeat({ harness: 'opencode', model: 'anthropic/claude-opus-5-5#max', effort: 'low' }, { at: AT }).ok);
  assert.ok(!resolveSeat({ harness: 'cursor', model: 'grok-4.7-xhigh', effort: 'low' }, { at: AT }).ok);
  // Rated tables: the name's level counts as declared.
  assert.ok(resolveSeat({ harness: 't3-code:antigravity', model: 'gemini-3.8-flash-medium' }, { at: AT, requireEffort: true }).ok);
  // Two levels in one name.
  assert.ok(!resolveModel('gemini-4-argon-high#low', 'antigravity', { at: AT }).ok);
});

test('T3 Code (Cursor): catalog model ids resolve, with the level as a separate option', () => {
  const catalog: Array<[string, string, string[]]> = [
    ['grok-4.7', 'grok-4.7', ['low', 'medium', 'high', 'xhigh']],
    ['grok-4.6', 'grok-4.6', ['low', 'medium', 'high', 'xhigh']],
    ['grok-4.5', 'grok-4.5', ['low', 'medium', 'high']],
    ['gpt-5.6-sol', 'gpt-5.6-sol', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['gpt-5.6-terra', 'gpt-5.6-terra', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['gpt-5.6-luna', 'gpt-5.6-luna', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['gpt-5.5', 'gpt-5.5', ['none', 'low', 'medium', 'high', 'extra-high']],
    ['kimi-k3', 'kimi-k3', ['low', 'high', 'max']],
    ['glm-5p3', 'glm-5.3', ['low', 'high', 'max']],
    ['glm-5p3-flash', 'glm-5.3-flash', ['low', 'high', 'max']],
    ['composer-2.5', 'composer-2.5', []],
    ['muse-wonder-1.0', 'muse-wonder-1.0', ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['muse-spark-1.3', 'muse-spark-1.3', ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['gemini-4-argon', 'gemini-4-argon', ['low', 'medium', 'high']],
    ['gemini-3.8-flash', 'gemini-3.8-flash', ['low', 'medium', 'high']],
    ['claude-opus-5-5', 'claude-opus-5-5', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-sonnet-5-5', 'claude-sonnet-5-5', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-fable-5-1', 'claude-fable-5-1', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-haiku-5-5', 'claude-haiku-5-5', ['low', 'medium', 'high', 'xhigh', 'max']],
  ];
  for (const [raw, model, levels] of catalog) {
    assert.equal(id(raw, 't3-code:cursor'), model, raw);
    for (const l of levels) {
      const s = resolveSeat({ harness: 't3-code:cursor', model: raw, effort: l }, { at: AT, requireEffort: true });
      assert.ok(s.ok && s.seat.model === model, `${raw} at ${l}: ${s.ok ? '' : s.error}`);
    }
    if (!levels.length) assert.ok(resolveSeat({ harness: 't3-code:cursor', model: raw }, { at: AT, requireEffort: true }).ok, `${raw} has no effort`);
  }
  assert.equal(resolveSeat({ harness: 't3-code:cursor', model: 'gpt-5.5', effort: 'extra-high' }, { at: AT }).ok && 'ok', 'ok');
  const x = resolveSeat({ harness: 't3-code:cursor', model: 'gpt-5.5', effort: 'extra-high' }, { at: AT });
  assert.ok(x.ok && x.seat.effort === 'xhigh');
  // A level the model doesn't have (Grok 4.5 has no xhigh).
  assert.ok(!resolveSeat({ harness: 't3-code:cursor', model: 'grok-4.5', effort: 'xhigh' }, { at: AT }).ok);
});

test('Cursor CLI names: level and fast mode in the name (`cursor-agent models` 2026.10.19)', async () => {
  const { launchSpec } = await import('../src/index.js');
  for (const [raw, model, level, fast] of [
    ['grok-4.7-xhigh-fast', 'grok-4.7', 'xhigh', true], ['grok-4.7-low', 'grok-4.7', 'low', false], ['cursor-grok-4.6-medium-fast', 'grok-4.6', 'medium', true],
    ['cursor-grok-4.5-high', 'grok-4.5', 'high', false], ['gpt-5.5-extra-high', 'gpt-5.5', 'xhigh', false], ['gpt-5.6-terra-none-fast', 'gpt-5.6-terra', 'none', true],
    ['kimi-k3-max', 'kimi-k3', 'max', false], ['muse-spark-1.3-minimal', 'muse-spark-1.3', 'minimal', false], ['claude-opus-5-5-high-fast', 'claude-opus-5-5', 'high', true],
  ] as const) {
    for (const h of ['cursor', 't3-code:cursor']) {
      const r = resolveModel(raw, h, { at: AT });
      assert.ok(r.ok && r.id === model && r.effortHint === level && !!r.fast === fast, `${raw} in ${h}`);
    }
  }
  const c = resolveModel('composer-2.5-fast', 'cursor', { at: AT });
  assert.ok(c.ok && c.id === 'composer-2.5' && c.fast && !c.effortHint);
  assert.deepEqual(launchSpec('cursor', 'gpt-5.5', 'xhigh'), { model: 'gpt-5.5-extra-high', args: [], settable: true });
  assert.deepEqual(launchSpec('cursor', 'grok-4.6', 'low'), { model: 'cursor-grok-4.6-low', args: [], settable: true });
  assert.deepEqual(launchSpec('cursor', 'composer-2.5', 'high'), { model: 'composer-2.5', args: [], settable: false });
  // "-fast" is only Cursor's.
  assert.equal(id('grok-4.7-fast', 'opencode'), null);
});

test('OpenCode Zen: opencode/<id> is the registry model, flagged hosted; <id>-free is flagged a free variant', () => {
  for (const h of ['opencode', 't3-code:opencode']) {
    const f = resolveModel('opencode/glm-5.3-flash-free', h, { at: AT });
    assert.ok(f.ok && f.id === 'glm-5.3-flash');
    assert.deepEqual(f.hosted, { service: 'OpenCode Zen', free: true });
    const d = resolveModel('opencode/deepseek-v4.1-flash-free', h, { at: AT });
    assert.ok(d.ok && d.id === 'deepseek-v4.1-flash' && d.hosted?.free === true);
    const paid = resolveModel('opencode/muse-wonder-1.0', h, { at: AT });
    assert.ok(paid.ok && paid.id === 'muse-wonder-1.0' && paid.hosted?.free === false);
    // The registry's own launch string under Zen is still hosted.
    const l = resolveModel('opencode/deepseek-v4.1-flash', h, { at: AT });
    assert.ok(l.ok && l.id === 'deepseek-v4.1-flash' && l.hosted?.free === false);
    // A Zen model the registry doesn't list (an undisclosed underlying model) stays unknown.
    assert.equal(id('opencode/beam-free', h), null);
  }
  // Direct provider ids aren't hosted.
  const direct = resolveModel('zai/glm-5.3-flash', 'opencode', { at: AT });
  assert.ok(direct.ok && direct.id === 'glm-5.3-flash' && !direct.hosted);
  // Only OpenCode's names: without the harness the Zen form is unknown.
  assert.equal(id('opencode/glm-5.3-flash-free'), null);
  const s = resolveSeat({ harness: 't3-code:opencode', model: 'opencode/glm-5.3-flash-free', effort: 'high' }, { at: AT, requireEffort: true });
  assert.ok(s.ok && s.seat.model === 'glm-5.3-flash' && s.seat.effort === 'high' && s.hosted?.free);
  assert.ok(s.warnings.some((w) => /free variant/.test(w)));
  assert.ok(!resolveSeat({ harness: 't3-code:opencode', model: 'opencode/glm-5.3-flash-free', effort: 'medium' }, { at: AT }).ok, 'GLM-5.3-Flash has no medium');
});

test('OpenCode Zen: a free variant launches as typed, never as the paid launch string', async () => {
  const { launchSpec } = await import('../src/index.js');
  assert.deepEqual(launchSpec('opencode', 'opencode/deepseek-v4.1-flash-free', 'high'), { model: 'opencode/deepseek-v4.1-flash-free#high', args: [], settable: true });
  assert.deepEqual(launchSpec('opencode', 'opencode/glm-5.3-flash-free', 'low'), { model: 'opencode/glm-5.3-flash-free#low', args: [], settable: true });
  // A level after the name is the variant, not part of the name.
  assert.equal(launchSpec('opencode', 'opencode/deepseek-v4.1-flash-free#high', 'high').model, 'opencode/deepseek-v4.1-flash-free#high');
  // The canonical id still launches by the registry's string; a direct provider id is not a Zen name.
  assert.equal(launchSpec('opencode', 'deepseek-v4.1-flash', 'high').model, 'opencode/deepseek-v4.1-flash#high');
  assert.equal(launchSpec('opencode', 'zai/glm-5.3-flash', 'high').model, 'zai/glm-5.3-flash#high');
});

test('usage from these harnesses verifies the declared model', () => {
  assert.equal(verifySeatModel({ model: 'gemini-4-argon-high', harness: 't3-code:antigravity', at: AT }, { model_ids: ['gemini-4-argon-high'] }).status, 'verified');
  assert.equal(verifySeatModel({ model: 'opencode/glm-5.3-flash-free', harness: 't3-code:opencode', at: AT }, { model_ids: ['opencode/glm-5.3-flash-free'] }).status, 'verified');
  assert.equal(verifySeatModel({ model: 'grok-4.7', harness: 't3-code:cursor', at: AT }, { model_ids: ['grok-4.7'] }).status, 'verified');
  assert.equal(verifySeatModel({ model: 'grok-4.7', harness: 't3-code:cursor', at: AT }, { model_ids: ['grok-4.6'] }).status, 'mismatch');
});

test('new providers: prefixes, ids and floating aliases', () => {
  assert.equal(id('xai/grok-4.7'), 'grok-4.7');
  assert.equal(id('moonshotai/kimi-k3'), 'kimi-k3');
  assert.equal(id('zai/glm-5.3'), 'glm-5.3');
  assert.equal(id('meta/muse-wonder-1.0'), 'muse-wonder-1.0');
  assert.equal(id('Muse Wonder'), 'muse-wonder-1.0');
  assert.equal(id('deepseek/deepseek-flash'), 'deepseek-v4.1-flash');
  assert.equal(id('deepseek-flash', undefined, '2026-09-01'), null, 'before V4.1 Flash, deepseek-flash meant another model');
  assert.equal(id('gpt-5.6'), 'gpt-5.6-sol');
  assert.equal(id('gpt-5.5-2026-04-23'), 'gpt-5.5');
  assert.equal(id('grok-4.5-latest'), 'grok-4.5');
  assert.equal(id('GPT-6 Sol'), 'gpt-6-sol');
  assert.equal(id('openai/gpt-6-sol'), 'gpt-6-sol');
  assert.ok(registryVersionOk());
});

const registryVersionOk = () => {
  const m = REGISTRY_DATA.models.find((x) => x.id === 'kimi-k3');
  return !!m && m.released === undefined; // no official release date: left out, never guessed
};

test('validation: a level suffix that would turn one model\'s name into another\'s is caught', () => {
  const data: RegistryData = JSON.parse(JSON.stringify(REGISTRY_DATA));
  data.models.push({ ...data.models.find((m) => m.id === 'gemini-4-argon')!, id: 'gemini-4-argon-high', display: 'Gemini 4 Argon High', aliases: [], launch: {} });
  assert.ok(validateRegistry(data).some((e) => /reads as gemini-4-argon-high/.test(e)));
  const words: RegistryData = JSON.parse(JSON.stringify(REGISTRY_DATA));
  words.models.find((m) => m.id === 'gpt-5.5')!.launch_effort_words = { cursor: { max: 'maximum' } };
  assert.ok(validateRegistry(words).some((e) => /names level "max"/.test(e)));
  assert.deepEqual(validateRegistry(REGISTRY_DATA), []);
});
