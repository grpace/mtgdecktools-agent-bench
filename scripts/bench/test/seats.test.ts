// Seat specs as people type them: `bench setup --seat …`, `bench new --seat …` (node --import tsx --test).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { antigravityFiles, expandSeatSpecs, harnessFor, harnessSupportLine, normalizeHarness, opencodeConfig, opencodeFreeModel, parseSeatSpec as parseWithDeclared, seatNames } from '../harnesses.js';
import { effortChoice, launchFor, pairProblem, resolveSeat } from '../models.js';
import { normalizeKnowledge, seatLineText } from '../setup.js';

/** The parsed seat without the as-typed strings (checked separately). */
const parseSeatSpec = (x: string) => {
  const { declared: _d, ...rest } = parseWithDeclared(x);
  return rest;
};

test('harness/model/effort, with display names and spaces', () => {
  assert.deepEqual(parseSeatSpec('Claude Code / claude-opus-5-5 / high'), { harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high' });
  assert.deepEqual(parseSeatSpec('alice=codex/gpt-5/medium'), { name: 'alice', harness: 'codex', model: 'gpt-5', effort: 'medium' });
  assert.deepEqual(parseSeatSpec('Codex/gpt-5'), { harness: 'codex', model: 'gpt-5' });
  // Every concrete registry level ends a spec, Codex's ultra included.
  assert.deepEqual(parseSeatSpec('codex/gpt-6-astra/ultra'), { harness: 'codex', model: 'gpt-6-astra', effort: 'ultra' });
  assert.deepEqual(parseSeatSpec('cursor agent/sonnet-4/HIGH'), { harness: 'cursor', model: 'sonnet-4', effort: 'high' });
});

test('model ids with slashes (OpenCode provider/model) keep their slashes', () => {
  assert.deepEqual(parseSeatSpec('opencode/anthropic/claude-sonnet-5-5/high'), { harness: 'opencode', model: 'anthropic/claude-sonnet-5-5', effort: 'high' });
  assert.deepEqual(parseSeatSpec('b=opencode/anthropic/claude-sonnet-5-5'), { name: 'b', harness: 'opencode', model: 'anthropic/claude-sonnet-5-5' });
  assert.deepEqual(parseSeatSpec('codex/openrouter/qwen/qwen3-coder/max'), { harness: 'codex', model: 'openrouter/qwen/qwen3-coder', effort: 'max' });
});

test('effort: registry levels, the recommendation, launch strings; "unknown" for a hand-seated seat', () => {
  const cc = effortChoice('claude-code', 'claude-opus-5-5');
  assert.ok(cc.settable && cc.levels.includes('high') && cc.recommended && cc.why);
  assert.deepEqual(launchFor('claude-code', 'claude-opus-5-5', 'high'), { model: 'claude-opus-5-5', args: ['--effort', 'high'], settable: true });
  assert.equal(launchFor('opencode', 'claude-sonnet-5-5', 'high').model, 'anthropic/claude-sonnet-5-5#high');
  const gem = effortChoice('gemini-cli', 'gemini-3.8-flash');
  assert.ok(!gem.settable && gem.why.length > 0, 'Gemini CLI has no effort setting: the registry says what it runs at');
  assert.equal(parseWithDeclared('codex/gpt-6-astra/unknown').effortUnknown, true);
  assert.equal(parseSeatSpec('script/random').effort, undefined);
});

test('an OpenCode Zen free seat keeps its own name for launch; the row is the canonical model', () => {
  const r = resolveSeat(parseWithDeclared('OpenCode / opencode/deepseek-v4.1-flash-free / high'), { allowUnlisted: false });
  assert.ok(r.ok);
  assert.equal(r.seat.model, 'deepseek-v4.1-flash');
  assert.equal(r.seat.launchModel, 'opencode/deepseek-v4.1-flash-free');
  assert.equal(launchFor('opencode', r.seat.model, r.seat.effort, r.seat.launchModel).model, 'opencode/deepseek-v4.1-flash-free#high');
  // Without it (an older event.json), the registry's launch string; a launch name for another model is ignored.
  assert.equal(launchFor('opencode', 'deepseek-v4.1-flash', 'high').model, 'opencode/deepseek-v4.1-flash#high');
  assert.equal(launchFor('opencode', 'deepseek-v4.1-flash', 'high', 'opencode/glm-5.3-flash-free').model, 'opencode/deepseek-v4.1-flash#high');
  // A model the registry launches by its own string needs no launch name.
  const plain = resolveSeat(parseWithDeclared('OpenCode / Claude Sonnet 5.5 / high'), { allowUnlisted: false });
  assert.ok(plain.ok && plain.seat.launchModel === undefined);
});

test('OpenCode Zen free seats keep read, confined to the empty seat folder; every other seat has none', () => {
  assert.ok(opencodeFreeModel('opencode/deepseek-v4.1-flash-free#high') && opencodeFreeModel('opencode/glm-5.3-flash-free'));
  assert.ok(!opencodeFreeModel('opencode/deepseek-v4.1-flash#high') && !opencodeFreeModel('anthropic/claude-sonnet-5-5#high') && !opencodeFreeModel(undefined));
  const free = JSON.parse(opencodeConfig('https://x/mcp/t', 'opencode/deepseek-v4.1-flash-free#high'));
  assert.deepEqual(free.permission, { '*': 'deny', read: 'allow', external_directory: 'deny', execute: 'allow', 'mtg_*': 'allow' });
  assert.equal(free.tools.read, undefined);
  assert.equal(free.tools.bash, false);
  const paid = JSON.parse(opencodeConfig('https://x/mcp/t', 'anthropic/claude-sonnet-5-5#high'));
  assert.deepEqual(paid.permission, { '*': 'deny', execute: 'allow', 'mtg_*': 'allow' });
  // The preflight (no server) allows nothing but what Zen needs.
  assert.deepEqual(JSON.parse(opencodeConfig(undefined, 'anthropic/claude-sonnet-5-5#high')).permission, { '*': 'deny' });
  assert.equal(paid.tools.read, false);
  // The launch carries it: the seat's launch model is the free name.
  const l = harnessFor('opencode')!.launch!({ name: 'seat-a1', url: 'https://x/mcp/t', model: 'opencode/deepseek-v4.1-flash-free#high' }, 'p', {});
  assert.equal(JSON.parse(l.homeFiles!['opencode.json']!).permission.read, 'allow');
  assert.ok(l.args.includes('opencode/deepseek-v4.1-flash-free#high'));
});

test('Antigravity: the level in the model name is the effort; seated by hand from a folder of its own', () => {
  const r = resolveSeat(parseWithDeclared('Antigravity / gemini-4-argon-high'), { allowUnlisted: false });
  assert.ok(r.ok && r.seat.model === 'gemini-4-argon' && r.seat.effort === 'high' && r.seat.effortFromName === true);
  const h = harnessFor('agy');
  assert.equal(h?.id, 'antigravity');
  assert.equal(h?.launch, undefined, 'not started headless');
  const url = 'https://agent-bench.example/mcp/abc_DEF-123';
  const text = h!.snippet({ name: 'seat-a1b2c3', url, harness: 'antigravity', model: 'gemini-4-argon', effort: 'high' });
  assert.match(text, /mkdir -p ~\/mtgdt-seats\/seat-a1b2c3\/\.agents\/plugins\/mtg && cd ~\/mtgdt-seats\/seat-a1b2c3/);
  assert.match(text, /agy --model 'gemini-4-argon-high'/);
  const files = antigravityFiles(url);
  assert.deepEqual(JSON.parse(files['.agents/plugins/mtg/mcp_config.json']!), { mcpServers: { mtg: { url } } });
  assert.deepEqual(JSON.parse(files['.agents/plugins/mtg/plugin.json']!), { name: 'mtg' });
  assert.ok(text.includes(`printf '%s\\n' '${files['.agents/plugins/mtg/mcp_config.json']}' > .agents/plugins/mtg/mcp_config.json`));
});

test('unknown harnesses are kept as a slug (seated by hand)', () => {
  assert.equal(normalizeHarness('T3 Code'), 't3-code', 'a launcher alone: the registry then asks which harness it ran');
  assert.equal(normalizeHarness('My Agent!'), 'my-agent');
  assert.equal(normalizeHarness('claude'), 'claude-code');
});

test('counts fill several seats; names stay unique', () => {
  const specs = expandSeatSpecs(['4x Claude Code/claude-opus-5-5/high', 'codex/gpt-5/medium x3', 'a=script/random, b=script/random']);
  assert.equal(specs.length, 9);
  assert.equal(specs.filter((s) => s.harness === 'claude-code').length, 4);
  assert.equal(specs.filter((s) => s.harness === 'codex').length, 3);
  // Neutral names at every table: never the model (the first hosted 8-seat table was named claude-haiku-5-5-2…).
  const warned: string[] = [];
  const names = seatNames(specs, (m) => warned.push(m));
  assert.equal(names.length, 9);
  assert.equal(new Set(names).size, 9, 'unique');
  assert.ok(names.every((n) => /^seat-[0-9a-f]{6}$/.test(n)), names.join(' '));
  assert.ok(!names.some((n) => /opus|gpt|claude/.test(n)));
  assert.deepEqual(warned.map((m) => m.split('"')[1]), ['a', 'b'], 'given names that would show are replaced, with a note');
  // An already neutral name is kept.
  assert.deepEqual(seatNames(expandSeatSpecs(['seat-0a1b2c=script/random']), () => assert.fail('no note')), ['seat-0a1b2c']);
  assert.throws(() => expandSeatSpecs(['9x codex/gpt-5']), /count from 1 to 8/);
  // A model id ending in "x<digits>" without a space is not a count.
  assert.equal(expandSeatSpecs(['opencode/acme/model-x2']).length, 1);
});

test('knowledge: config values and the set-context names', () => {
  assert.equal(normalizeKnowledge('primer'), 'primer');
  assert.equal(normalizeKnowledge('Set Context'), 'primer');
  assert.equal(normalizeKnowledge('set context'), 'primer');
  assert.equal(normalizeKnowledge('Set Context + Human Stats'), 'primer+stats');
  assert.equal(normalizeKnowledge('context+stats'), 'primer+stats');
  assert.equal(normalizeKnowledge('No set context'), 'none');
  assert.equal(normalizeKnowledge('lots'), undefined);
});

test('the strings as typed are kept for the Director to log', () => {
  assert.deepEqual(parseWithDeclared('Claude Code / Claude Opus 5.5 / High').declared, { harness: 'Claude Code', model: 'Claude Opus 5.5', effort: 'High' });
});

test('the registry gives canonical ids, refuses unknown models with suggestions, and allows them on request', () => {
  const ok = resolveSeat(parseWithDeclared('Claude Code / Claude Opus 5.5 / high'), { allowUnlisted: false });
  assert.ok(ok.ok && ok.seat.harness === 'claude-code' && ok.seat.model === 'claude-opus-5-5' && ok.seat.effort === 'high' && ok.listed);
  const typo = resolveSeat(parseWithDeclared('claude-code/claude-opus-5-6/high'), { allowUnlisted: false });
  assert.ok(!typo.ok);
  const unlisted = resolveSeat(parseWithDeclared('claude-code/my-finetune/high'), { allowUnlisted: true });
  assert.ok(unlisted.ok && !unlisted.listed);
  const script = resolveSeat(parseWithDeclared('script/random'), { allowUnlisted: false });
  assert.ok(script.ok && script.test);
});

test('the Confirmation names every seat as model · harness · effort, scripted seats included', () => {
  const line = (model: string, harness: string, version: string | null, level: string, label: string) =>
    seatLineText({ model: { id: model, label: model }, harness: { id: harness, label: harness, version }, effort: { level, label, established: '' } });
  assert.equal(line('Claude Opus 5.5', 'Claude Code', '2.3.1', 'high', 'High'), 'Claude Opus 5.5 · Claude Code 2.3.1 · High');
  assert.equal(line('GPT-6 Astra', 'Codex', null, 'medium', 'Medium'), 'GPT-6 Astra · Codex · Medium');
  assert.equal(line('random', 'Scripted random player', null, 'default', 'No Effort Setting'), 'random · Scripted random player · No Effort Setting');
  // No label: the registry's name for the level, never an empty effort.
  assert.match(line('M', 'H', null, 'high', ''), /^M · H · \S/);
});

test('a listed model on a harness that can\'t run it is refused at entry, with the harnesses that can', () => {
  const astra = resolveSeat({ harness: 'claude-code', model: 'gpt-6-astra', effort: 'high' }, { allowUnlisted: false });
  assert.equal(astra.ok, false);
  assert.match(!astra.ok ? astra.error : '', /^Claude Code can't run GPT-6 Astra\. Claude Code runs Claude Fable 5\.1, .*Claude Haiku 5\.5\. Did you mean Codex CLI \/ GPT-6 Astra or OpenCode \/ GPT-6 Astra\?$/);
  const argon = resolveSeat({ harness: 'Gemini CLI', model: 'Gemini 4 Argon', effort: 'high' }, { allowUnlisted: false });
  assert.match(!argon.ok ? argon.error : '', /^Gemini CLI can't run Gemini 4 Argon/);
  assert.equal(pairProblem('claude-code', 'claude-opus-5-5'), undefined);
  assert.equal(pairProblem('opencode', 'gpt-6-astra'), undefined);
  assert.equal(pairProblem('claude-desktop', 'gpt-6-astra'), undefined, 'apps seated by hand are not checked');
  assert.equal(pairProblem('script', 'random'), undefined);
  assert.equal(resolveSeat({ harness: 'claude-code', model: 'my-own-model', effort: 'high' }, { allowUnlisted: true }).ok, true, 'unlisted models are not checked');
});

test('harness support is said up front: tested on real tables, or supported but untested', () => {
  assert.equal(harnessFor('claude-code')?.support, 'tested');
  assert.equal(harnessFor('codex')?.support, 'untested');
  assert.equal(harnessFor('gemini-cli')?.support, 'untested');
  const line = harnessSupportLine();
  assert.match(line, /^Tested on real tables: Claude Code, OpenCode, Cursor CLI\. Supported but untested \(not yet run on a real install, so expect problems\): Codex CLI, Gemini CLI\.$/);
});
