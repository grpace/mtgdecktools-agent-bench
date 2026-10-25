/**
 * The tier-score filter for Set Contexts: no tier-score wording survives in any Set Context the bench uses, the filter is
 * idempotent, text without that wording is byte-identical, and loadKnowledge filters every source an agent can get.
 *   npx tsx packages/director/src/set-context-filter.test.ts
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadKnowledge, setContextRefusal } from './knowledge.js';
import { filterSetContext, TIER_SCORE_RE } from './set-context-filter.js';

const root = resolve(import.meta.dirname, '..', '..', '..');
const sets = join(root, 'sets');
let n = 0;
const ok = (name: string) => console.log(`ok   ${++n} ${name}`);

// Every exported Set Context (sets/<SET>/primer.md) is already filtered: no tier-score wording, and filtering again changes nothing.
for (const code of readdirSync(sets).filter((c) => existsSync(join(sets, c, 'primer.md')))) {
  const text = readFileSync(join(sets, code, 'primer.md'), 'utf8');
  assert.equal(TIER_SCORE_RE.test(text.replace(/^<!--.*?-->\s*/s, '')), false, `${code}: tier-score wording in sets/${code}/primer.md`);
  assert.equal(filterSetContext(text), text, `${code}: the repo copy is a fixed point of the filter`);
}
ok('every sets/<SET>/primer.md is free of tier-score wording and a fixed point of the filter');

// The owner's wording as it was exported on 2026-10-22 (one line per context), and what agents read instead.
const cases: Array<[string, string]> = [
  ['**FRA supplement only.** The main deck-building prompt already defines your card pool, tierScores, and pool-only rules. Use **tierScores for raw power** and this section for **lane fit**.',
    '**FRA supplement only.** The main deck-building prompt already defines your card pool and pool-only rules. Use **your own card evaluation for raw power** and this section for **lane fit**.'],
  ['* **tierScore vs this format:** Vacuum scores miss roles. [[Wood Elves]] is strong in GU.',
    '* **Raw power vs this format:** Vacuum card ratings miss roles. [[Wood Elves]] is strong in GU.'],
  ['Your **Available Card Pool** lists every card you may play, each with a **tierScore** (0–10). This section explains SOS format.',
    'Your **Available Card Pool** lists every card you may play. This section explains SOS format.'],
  ['1. **Scan the pool by tierScore and color.** High tierScore (8+) cards are bombs and build-arounds *when castable* in your colors. Synergy can justify a lower tierScore card that fits the plan; do not play low tierScore “signposts” just because they match a college name.',
    '1. **Scan the pool by card quality and color.** The strongest cards are bombs and build-arounds *when castable* in your colors. Synergy can justify a weaker card that fits the plan; do not play weak “signposts” just because they match a college name.'],
  ['The pair with the most castable playables at tier 6+ is usually your base.', 'The pair with the most strong castable playables is usually your base.'],
  ['**Pick the best plan from your actual pool** (tierScores, synergies, mana, interaction)—not from format tier lists.',
    '**Pick the best plan from your actual pool** (card quality, synergies, mana, interaction)—not from format tier lists.'],
  ['prioritize over marginal synergy when tierScores gap is large.', 'prioritize over marginal synergy when the power gap is large.'],
  ['When a rare or mythic in your pool has a high tierScore and fits your mana, treat it as a build-around.', 'When a rare or mythic in your pool is clearly powerful and fits your mana, treat it as a build-around.'],
  ["* Picking a lane from a tier list instead of the pool's best mix of tierScores, synergy, and mana.", "* Picking a lane from a tier list instead of the pool's best mix of card quality, synergy, and mana."],
  ['**Always evaluate your bomb rares/mythics (Tier 8.0+) first.**', '**Always evaluate your bomb rares/mythics first.**'],
  ["5. **Tier Score as Starting Point:** Use tier scores as a baseline, but don't rely on them exclusively. A card with a lower tier score might be better for your specific deck if it:",
    "5. **Raw Power as Starting Point:** Use your read of each card's raw power as a baseline, but don't rely on it exclusively. A card with lower raw power might be better for your specific deck if it:"],
  ["**Remember:** A card's tier score tells you its general power level. A lower tierScore card that fits is often better than an high tierScore card that doesn't.",
    "**Remember:** A card's raw power is its general strength. A weaker card that fits is often better than a stronger card that doesn't."],
];
for (const [from, to] of cases) {
  assert.equal(filterSetContext(from), to);
  assert.equal(filterSetContext(to), to, 'idempotent');
}
ok('the exact rewrites of the current contexts read as plain sentences');

// Wording the exact rules don't know is rewritten generically, and a sentence that still names a tier score is dropped.
const odd = 'Line one stays.\n* Rank cards by tierScore first. Then think about curve.\nWe like Tier 7+ cards. Keep this one.';
const out = filterSetContext(odd);
assert.equal(TIER_SCORE_RE.test(out), false, out);
assert.match(out, /Line one stays\./);
assert.match(out, /Then think about curve\./);
assert.match(out, /Keep this one\./);
assert.equal(filterSetContext(out), out);
ok('unknown wording: generic rewrite, else the sentence is dropped; still idempotent');

// General Limited vocabulary and text without tier scores are untouched, byte for byte.
const plain = '## Lanes\n\n* **Lorehold (RW) — top-tier.** BG and RW are solid mid-tier; B-tier bombs; avoid tier lists.\r\n';
assert.equal(filterSetContext(plain), plain);
ok('no tier-score wording: byte-identical (top-tier, mid-tier, tier lists stay)');

// loadKnowledge filters every source: the repo copy, the cache and a live copy from the site.
const tmp = mkdtempSync(join(tmpdir(), 'mtgdt-scfilter-'));
try {
  const setsDir = join(tmp, 'sets');
  const raw = `${'Intro. '.repeat(40)}\nUse **tierScores for raw power** and this section for lanes.\n`;
  mkdirSync(join(setsDir, 'XYZ'), { recursive: true });
  writeFileSync(join(setsDir, 'XYZ', 'primer.md'), `<!-- header -->\n\n${raw}`);
  const prompts = join(tmp, 'prompts');
  mkdirSync(prompts);
  const repo = await loadKnowledge('primer', 'xyz', setsDir, prompts);
  assert.equal(repo.primerSource?.from, 'repo');
  assert.equal(TIER_SCORE_RE.test(repo.primer!), false);
  const cacheDir = join(tmp, 'cache');
  mkdirSync(cacheDir);
  writeFileSync(join(cacheDir, 'XYZ.md'), raw);
  const cached = await loadKnowledge('primer', 'xyz', setsDir, prompts, { url: '', cacheDir });
  assert.equal(cached.primerSource?.from, 'cache');
  assert.equal(TIER_SCORE_RE.test(cached.primer!), false);
  assert.equal(cached.primerSource!.bytes, cached.primer!.length, 'the logged size (and sha256) is of the filtered text agents read');
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(raw, { status: 200 })) as typeof fetch;
  try {
    const live = await loadKnowledge('primer', 'xyz', setsDir, prompts, { url: 'https://example.invalid/{CODE}.md', cacheDir });
    assert.equal(live.primerSource?.from, 'mtgdecktools.com');
    assert.equal(TIER_SCORE_RE.test(live.primer!), false);
  } finally {
    globalThis.fetch = realFetch;
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
ok('loadKnowledge filters the repo copy, the cache and the live copy');

// E-1: a Set Context level on a set without one is refused, never quietly run at "none"; none, an opt-in or an
// available Set Context pass.
assert.match(setContextRefusal('xyz', 'primer', { available: false, allowDowngrade: false })!, /no Set Context is published for XYZ.*allow_downgrade/);
assert.ok(setContextRefusal('xyz', 'primer+stats', { available: false, allowDowngrade: false }));
assert.equal(setContextRefusal('xyz', 'none', { available: false, allowDowngrade: false }), undefined);
assert.equal(setContextRefusal('xyz', 'primer', { available: false, allowDowngrade: true }), undefined);
assert.equal(setContextRefusal('fra', 'primer', { available: true, allowDowngrade: false }), undefined);
ok('a Set Context level without a Set Context is refused unless allow_downgrade (E-1)');

console.log(`set-context-filter: all ${n} passed`);
