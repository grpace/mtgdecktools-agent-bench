/**
 * Deckbuilding parity with the MTG Deck Tools AI Deck Builder: a checklist of every critical rule and card-data field
 * of its 40-card Limited prompt. Each item names the deck builder's phrase, which must still be in the captured prompt
 * (packages/director/test/fixtures/mtgdt-deck-prompt, from scripts/capture-mtgdt-deck-prompt.ts), and the bench's
 * phrase, which must be in the prompt v4 deck offer at the matching knowledge level. When the deck builder's prompt
 * changes, recapture the fixtures: a rule that moved or changed fails here until the bench follows (or the item is
 * updated, or moved to NOT_PORTED with a reason).
 *   npx tsx packages/director/src/deck-parity.test.ts
 *
 * Settings mapping (scripts/capture-mtgdt-deck-prompt.ts captures the fixtures):
 *   none          ↔ set context "None", Ignore Tier Scores on   (none.txt)
 *   primer        ↔ set context on,     Ignore Tier Scores on   (set-context.txt)
 *   primer+stats  ↔ set context on,     Ignore Tier Scores on   (set-context.txt), plus the 17Lands stats
 * The bench never sends MTG Deck Tools tier scores (owner decision): the deck builder's tier score rules, captured with
 * tier scores on (set-context-tiers.txt), are in NOT_PORTED. Nor does it mention them: the guide says nothing about
 * tier scores (prompts v7), and the Set Context's tier wording is filtered on every path (set-context-filter.ts).
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PackCard } from './boosters.js';
import { CardDb } from './cards.js';
import { deckOfferV4 } from './deckbuild-v4.js';
import type { Knowledge, KnowledgeLevel } from './knowledge.js';
import { Ratings } from './ratings.js';
import { TIER_SCORE_RE } from './set-context-filter.js';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

type When = 'always' | 'context' | 'hybrid';
interface Item { id: string; mtgdt: string; bench: RegExp; when?: When }

/** Every critical rule of the deck builder's 40-card path, and where the bench offer says it. */
const CHECKLIST: Item[] = [
  // Task and scope
  { id: 'task.40-card', mtgdt: 'build the single best possible 40-card Limited deck', bench: /Build the single best 40-card Limited deck/ },
  { id: 'task.color-choice', mtgdt: 'all five colors are available so you choose the optimal color combination from the pool, then build the mana base from the final decklist\'s casting costs', bench: /All five colors are open: choose the best color combination the pool supports, then build the mana base from the final deck's casting costs/ },
  { id: 'task.pool-plus-basics', mtgdt: 'using ONLY cards from the Available Card Pool below, plus basic lands which you add yourself', bench: /Use ONLY cards from YOUR POOL, plus basic lands, which you add yourself/ },
  // Set context
  { id: 'context.overrides', mtgdt: 'Set Context Overrides Generic Heuristics', bench: /The set context overrides generic heuristics/, when: 'context' },
  { id: 'context.what-it-overrides', mtgdt: 'two-drop minimums, land totals, creature counts, removal priorities, format speed', bench: /two-drop minimums, land totals, creature counts, removal priorities, format speed/, when: 'context' },
  { id: 'context.fast', mtgdt: 'If it says the format is fast or hyper-aggressive, you MUST lower your mana curve', bench: /fast or hyper-aggressive, lower your curve/, when: 'context' },
  { id: 'context.slow', mtgdt: 'if it says the format is slow and grindy, prioritize card advantage, two-for-ones, and late-game staying power', bench: /slow and grindy, value card advantage, two-for-ones and late-game staying power/, when: 'context' },
  { id: 'context.names-illustrative', mtgdt: 'card names mentioned in the set context are illustrative examples only', bench: /card names in the set context are examples only/, when: 'context' },
  { id: 'context.land-count-check', mtgdt: 'the land count follows any guidance in the Limited Set Specific Context', bench: /the land count follows any guidance in the set context/, when: 'context' },
  // Step 1: comparative analysis
  { id: 'compare.required', mtgdt: 'Comparative Analysis (REQUIRED)', bench: /Comparative analysis \(required\)/ },
  { id: 'compare.2-3-options', mtgdt: 'minimum 2-3 options', bench: /Compare 2–3 viable approaches/ },
  { id: 'compare.not-first', mtgdt: 'Do NOT immediately pick the first cohesive strategy you see', bench: /Don't take the first cohesive deck you see/ },
  { id: 'compare.construct-each', mtgdt: 'Mentally construct each option', bench: /Build each one in your head/ },
  { id: 'compare.criteria', mtgdt: 'evaluate raw power level, synergy density, **mana consistency**, **curve optimization**, **interaction suite quality**', bench: /raw power, synergy density, mana consistency, curve, interaction/ },
  // Curve and consistency
  { id: 'curve.two-drops', mtgdt: 'Aim for an absolute minimum of 5-6 proactive creatures or spells at Mana Value 2', bench: /absolute minimum of 5–6 proactive creatures or spells at mana value 2/ },
  { id: 'curve.turns-1-4', mtgdt: 'Can it reliably play spells on turns 1-4?', bench: /reliably play spells on turns 1–4/ },
  { id: 'mana.consistency', mtgdt: 'Are there sufficient mana sources for each color needed?', bench: /enough sources for each color you need/ },
  { id: 'rule-of-one', mtgdt: 'The "Clunk Factor" Limit (Rule of One)', bench: /The Rule of One \("clunk factor"\)/ },
  { id: 'rule-of-one.no-splash', mtgdt: 'If your deck already has a weak early-game curve, do NOT splash a third color', bench: /If the early curve is already weak, do NOT splash a third color/ },
  { id: 'curve.vs-power', mtgdt: 'Curve vs. Power Trade-offs', bench: /Curve vs power/ },
  // Splashing
  { id: 'splash.3-sources', mtgdt: 'To splash a third color for a single card (1 pip), you need a minimum of 3 mana sources of that color', bench: /1 splashed card \(1 pip\) needs at least 3 sources/ },
  { id: 'splash.4-and-5-6', mtgdt: 'If you splash 2 cards, you need exactly 4 sources. If you splash 3 cards, you need 5 to 6 sources', bench: /2 splashed cards need 4; 3 splashed cards need 5–6/ },
  { id: 'splash.sources', mtgdt: 'A "source" includes basics, dual lands, or search effects (like Evolving Wilds)', bench: /Sources are basics, dual lands and search effects/ },
  { id: 'splash.basic-target', mtgdt: 'you MUST include at least 1 basic land of the splashed color', bench: /play at least 1 basic of the splash color/ },
  { id: 'splash.no-mv-1-2', mtgdt: 'NEVER splash cards with a Mana Value of 1 or 2, EVEN IF they are premium removal spells, UNLESS the card is an absolute game-winning bomb', bench: /never splash a card with mana value 1 or 2, even premium removal, unless it is an absolute game-winning bomb/ },
  { id: 'splash.3-plus', mtgdt: 'Only splash absolute bombs or unconditionally powerful spells that cost 3+ mana', bench: /Splash only bombs or unconditionally powerful spells costing 3\+/ },
  { id: 'splash.tap-lands', mtgdt: 'Tap-Land Tension', bench: /Tap-land tension/ },
  { id: 'splash.double-pip', mtgdt: 'Generally avoid splashing double-pipped cards', bench: /Avoid splashing double-pipped cards/ },
  { id: 'splash.greedy-exception', mtgdt: 'GREEDY SPLASH EXCEPTION', bench: /Greedy-splash exception/ },
  // Interaction
  { id: 'interaction.suite', mtgdt: 'Interaction Suite Quality', bench: /Suite quality/ },
  { id: 'interaction.removal', mtgdt: 'Removal Quantity and Quality', bench: /Quantity and quality/ },
  { id: 'interaction.balance', mtgdt: 'Interaction vs. Threats Balance', bench: /\*\*Balance:\*\* all threats loses/ },
  { id: 'interaction.format-needs', mtgdt: 'Format-Specific Interaction Needs', bench: /Format needs/ },
  { id: 'interaction.parity-breakers', mtgdt: 'Parity Breakers', bench: /Parity breakers:\*\* a plan to break board stalls: evasion \(flying, menace, can't be blocked\), trample, or late-game mana sinks/ },
  { id: 'interaction.timing', mtgdt: 'Interaction Timing', bench: /\*\*Timing:\*\* some instant-speed interaction/ },
  { id: 'interaction.amount', mtgdt: 'Ensure the deck includes a reasonable amount of interaction/removal relative to its strategy', bench: /reasonable amount of interaction and removal for your strategy/ },
  { id: 'consistency-over-power', mtgdt: 'The best deck is not necessarily the one with the most powerful individual cards', bench: /the best deck is not the one with the most powerful individual cards/ },
  // Step 2
  { id: 'build.enablers-payoffs', mtgdt: 'Enabler vs Payoff Synergy Check', bench: /Enablers vs payoffs/ },
  { id: 'build.control-creatures', mtgdt: 'A control deck can easily run 8-10 creatures', bench: /8–10 creatures can be right/ },
  { id: 'build.aggro-creatures', mtgdt: 'Aggro decks MUST still run 15+ creatures', bench: /Aggro decks still need 15\+ creatures/ },
  { id: 'build.auras-equipment', mtgdt: 'if your deck relies on Auras, Equipment, or Fight spells, you must maintain a high creature count', bench: /Auras, Equipment or fight spells need a high creature count/ },
  { id: 'build.17-lands', mtgdt: 'Generally, aim for 17 lands', bench: /Generally play 17 lands/ },
  // Step 3: mana base
  { id: 'mana.single-source', mtgdt: 'This step is the single source of truth for mana colors, hybrid costs, and land choices', bench: /single source of truth for mana colors, hybrid costs and land choices/ },
  { id: 'mana.3a', mtgdt: 'Deck Mana Colors (AI Color Choice Mode)', bench: /3a\. Deck Mana Colors/ },
  { id: 'mana.not-automatic', mtgdt: 'they are NOT automatically your mana base', bench: /they are NOT automatically your mana base/ },
  { id: 'mana.hard-pips', mtgdt: 'Start from **hard colored pips only**', bench: /Start from \*\*hard colored pips only\*\*/ },
  { id: 'mana.hybrid-or', mtgdt: 'Hybrid symbols are **OR, not AND**', bench: /Hybrid symbols are \*\*OR, not AND\*\*/ },
  { id: 'mana.one-half', mtgdt: 'add **one** of its halves to match your archetype — never both', bench: /add \*\*one\*\* of its halves to match your archetype, never both/ },
  { id: 'mana.identity', mtgdt: 'Never add a color only because it appears in `colorIdentity`', bench: /Never add a color only because it appears in "colorIdentity"/ },
  { id: 'hybrid.castability', mtgdt: '3b. Hybrid Mana Castability', bench: /3b\. Hybrid castability/, when: 'hybrid' },
  { id: 'hybrid.not-gold', mtgdt: 'it is NOT a gold card', bench: /NOT a gold card/, when: 'hybrid' },
  { id: 'hybrid.number', mtgdt: 'Number/Color hybrid', bench: /Number\/color hybrid \(\{2\/G\}\)/, when: 'hybrid' },
  { id: 'hybrid.example', mtgdt: '`{G/B}` is uncastable', bench: /\{G\/B\} is uncastable/, when: 'hybrid' },
  { id: 'hybrid.dont-skip', mtgdt: 'Don\'t skip a powerful hybrid card because it shows a "wrong" color pip', bench: /Don't skip a powerful hybrid card because it shows a "wrong" color/, when: 'hybrid' },
  { id: 'hybrid.never-expands', mtgdt: 'Hybrid NEVER expands mana needs', bench: /Hybrid never expands mana needs/, when: 'hybrid' },
  { id: 'mana.secondary-faces', mtgdt: 'Secondary Faces, Flashback & Activated Abilities', bench: /Secondary faces, flashback and activated abilities/ },
  { id: 'mana.main-face', mtgdt: 'A card belongs in the deck if its main face is castable with Deck Mana Colors', bench: /A card belongs in the deck if its main face is castable with Deck Mana Colors/ },
  { id: 'lands.on-color-duals', mtgdt: 'Include a dual/gainland/shock/check land ONLY if EVERY colored mana it can produce is among Deck Mana Colors', bench: /play a dual land ONLY if EVERY color it can make is among Deck Mana Colors/ },
  { id: 'lands.both-needed', mtgdt: 'Both colors must be needed', bench: /Both colors must be needed/ },
  { id: 'lands.no-off-basics', mtgdt: 'never off-color basics "just in case"', bench: /Never off-color basics "just in case"/ },
  { id: 'lands.fetches', mtgdt: 'Useful for supporting an intentional hard-pip splash or demanding multi-pip costs; skip when they only slow a clean aggressive curve', bench: /useful for an intentional hard-pip splash or demanding multi-pip costs; skip them when they only slow a clean aggressive curve/ },
  { id: 'lands.audit', mtgdt: 'audit every non-basic land against Deck Mana Colors and drop any that fail', bench: /Audit every non-basic land against Deck Mana Colors and drop any that fail/ },
  // Rules
  { id: 'rules.golden', mtgdt: 'GOLDEN RULE - ONLY USE CARDS FROM THE PROVIDED POOL', bench: /GOLDEN RULE: only cards from YOUR POOL/ },
  { id: 'rules.count-limit', mtgdt: 'you cannot exceed the available \'count\' for each card', bench: /never more copies than their "count"/ },
  { id: 'rules.basics-exception', mtgdt: 'The ONLY exception is basic lands (Plains, Island, Swamp, Mountain, Forest), which you must add yourself', bench: /The ONLY exception is basic lands \(Plains, Island, Swamp, Mountain, Forest\), which you add yourself/ },
  { id: 'rules.40-absolute', mtgdt: 'The 40-Card Rule is Absolute', bench: /The 40-card rule is absolute/ },
  { id: 'rules.40-includes-all', mtgdt: 'including all spells, non-basic pool lands, and the basic lands you add, must contain exactly 40 cards', bench: /exactly 40 cards: the pool cards in `cards` \(spells and non-basic lands\) plus the basics you add/ },
  // Card pool presentation
  { id: 'pool.count', mtgdt: 'Each entry\'s "count" is the maximum number of copies you may use', bench: /"count" is how many copies you drafted, the most you may play/ },
  { id: 'pool.sorted', mtgdt: 'Entries are sorted by mana value (ascending), one card per line', bench: /One line of card JSON per card, sorted by mana value/ },
  { id: 'pool.no-basics', mtgdt: 'The pool excludes basic lands', bench: /your pool lists no basics/ },
  // Final checklist and output contract
  { id: 'check.mandatory', mtgdt: 'FINAL PRE-OUTPUT CHECKLIST (MANDATORY)', bench: /Final check before you submit \(mandatory\)/ },
  { id: 'check.rerun', mtgdt: 'If any check fails, fix the deck and re-run the checklist', bench: /if one fails, fix the deck and run them all again/ },
  { id: 'check.pool', mtgdt: '**Pool check:**', bench: /\*\*Pool check:\*\* every number in `cards` is from YOUR POOL, and no card appears more times than its "count"/ },
  { id: 'check.count-running-total', mtgdt: 'otherwise add the quantities one at a time, writing out the running total. Do NOT estimate', bench: /one at a time, writing the running total \(use a tool or script if you have one\)\. Do NOT estimate/ },
  { id: 'check.count-exact', mtgdt: 'The grand total MUST equal exactly 40', bench: /The total must be exactly 40/ },
  { id: 'check.land-base', mtgdt: '**Land base:** Every land passes the Step 3 audit', bench: /\*\*Land base:\*\* every land passes the Step 3 audit/ },
  { id: 'output.thought-process', mtgdt: '"deckbuildingThoughtProcess" is REQUIRED', bench: /`analysis`: your deckbuilding thought process for THIS pool/ },
  { id: 'output.alternatives', mtgdt: '"alternativeDecksConsidered" is OPTIONAL', bench: /the options you compared and why this one won/ },
  { id: 'output.verification', mtgdt: '"totalCount": 40', bench: /`total_count`: your own sum from the final check/ },
  { id: 'output.deck-name', mtgdt: 'The "deckName" field must be a creative, thematic name for the deck', bench: /`deck_name` \(creative and thematic\)/ },
  { id: 'output.archetype', mtgdt: '"archetype": "The primary archetype (e.g., Aggro, Control, Midrange, Combo, Tempo)."', bench: /`archetype` \(Aggro, Control, Midrange, Tempo, Combo…\)/ },
  { id: 'output.exact-names', mtgdt: 'Use Exact Card Names from Card Pool', bench: /cards=\[pool numbers, one per copy\]/ },
];

/** Why the bench carries none of the deck builder's tier score rules. */
const TIER_WHY = 'owner decision: agents use their own card evaluation, or 17Lands stats at the Human Stats level; no prompt mentions tier scores (the Set Context\'s tier wording is filtered).';

/**
 * Deck builder text the bench deliberately doesn't carry, and why. Each phrase must still be in the captured prompt,
 * so this list can't go stale silently.
 */
const NOT_PORTED: Array<{ mtgdt: string; why: string }> = [
  { mtgdt: 'PRIMER REQUIREMENTS - COMPREHENSIVE DECK DOCUMENTATION', why: 'The strategy primer is documentation for a human reader; it doesn\'t change the deck. Its fact-check rules (rarity, same-turn mana math) apply to the primer only.' },
  { mtgdt: 'CRITICAL JSON FORMATTING RULES', why: 'The answer is a decide() tool call, not a JSON code block: the MCP schema does the formatting.' },
  { mtgdt: 'Dual-faced cards:** If a card is listed as "Front Side // Back Side"', why: 'Cards are submitted by pool number, never by name.' },
  { mtgdt: 'UPDATES AND RATIONALE SECTION (Optional)', why: 'Debate/feedback regeneration is a deck builder feature; the bench review allows one resubmission instead.' },
  { mtgdt: 'CRITICAL: Deck Name Rules', why: 'Revision-indicator rules only matter when a deck is regenerated after feedback.' },
  { mtgdt: '"set":"', why: 'Every pool card comes from the event\'s set.' },
  // MTG Deck Tools tier scores: the deck builder's rules with tier scores on (set-context-tiers.txt). Not at any level.
  { mtgdt: 'treat its effective `tierScore` as 3 unless your pool actually meets those conditions', why: TIER_WHY },
  { mtgdt: 'Tier Score Guide (0-10 Scale for 40-Card Limited Decks)', why: TIER_WHY },
  { mtgdt: 'a strong prior, but not the final word', why: TIER_WHY },
  { mtgdt: 'a LARGE tierScore gap should rarely be overridden by marginal synergy', why: TIER_WHY },
  { mtgdt: '**10: Incredible Bombs.**', why: TIER_WHY },
  { mtgdt: '**4 and below: Basically Unplayable.**', why: TIER_WHY },
  { mtgdt: 'Each card\'s "tierScore" (0-10) rates its raw power', why: TIER_WHY },
];

/** Deck builder card fields (40-card path) and the bench field carrying the same data. */
const FIELD_MAP: Record<string, string | null> = {
  name: 'name', count: 'count', cmc: 'mv', manaCost: 'cost', typeLine: 'type', oracleText: 'text',
  power: 'pt', toughness: 'pt', colors: 'colors', colorIdentity: 'colorIdentity', keywords: 'keywords', rarity: 'rarity', cardFaces: 'faces',
  set: null, // one set per event
  tierScore: null, // never sent (TIER_WHY); the 17Lands stats ("17lands") at Set Context + Human Stats instead
};

// --- the bench offer for a small pool with a hybrid card, at each knowledge level ---------------------------------------
const cost = (generic: number, ...shards: string[]) => ({ type: 'Cost', generic, shards });
const fixed = (v: number) => ({ type: 'Fixed', value: v });
const t = (core: string[], sub: string[] = []) => ({ supertypes: [], core_types: core, subtypes: sub });
const raw = {
  'budding insurgent': { name: 'Budding Insurgent', mana_cost: cost(1, 'Green'), card_type: t(['Creature'], ['Elf']), power: fixed(2), toughness: fixed(2), oracle_text: 'Trample', keywords: ['Trample'], layout: 'normal' },
  'duskwatch hunter': { name: 'Duskwatch Hunter', mana_cost: cost(2, 'BlackGreen'), card_type: t(['Creature'], ['Wolf']), power: fixed(3), toughness: fixed(1), oracle_text: "This creature can't be blocked by tokens.", keywords: [], layout: 'normal' },
  'beorn': { name: 'Beorn', mana_cost: cost(4, 'Green'), card_type: t(['Creature'], ['Bear']), power: fixed(5), toughness: fixed(5), oracle_text: 'Trample', keywords: ['Trample'], layout: 'adventure', scryfall_oracle_id: 'beorn' },
  'till and tend': { name: 'Till and Tend', mana_cost: cost(1, 'Green'), card_type: t(['Sorcery'], ['Adventure']), oracle_text: 'You may play an additional land this turn.', keywords: [], layout: 'adventure', scryfall_oracle_id: 'beorn' },
  'mirkwood': { name: 'Mirkwood', mana_cost: { type: 'NoCost' }, card_type: t(['Land']), oracle_text: 'This land enters tapped.\n{T}: Add {B} or {G}.', keywords: [], layout: 'normal' },
};
const dir = mkdtempSync(join(tmpdir(), 'mtgdt-parity-'));
writeFileSync(join(dir, 'card-data.json'), JSON.stringify(raw));
const cards = new CardDb(join(dir, 'card-data.json'), dir);
mkdirSync(join(dir, 'sets', 'ZZZ'), { recursive: true });
writeFileSync(join(dir, 'sets', 'ZZZ', '17lands.json'), JSON.stringify({ cards: { 'Budding Insurgent': { gih_wr: 0.56 }, 'Duskwatch Hunter': { gih_wr: 0.55 }, Beorn: { gih_wr: 0.6 }, Mirkwood: { gih_wr: 0.55 } } }));
const ratings = new Ratings(join(dir, 'sets'), 'zzz', { cards });
const pc = (name: string, colors: string[], cmc: number, typeLine: string): PackCard => ({ name, rarity: 'common', colors, cmc, typeLine });
const pool = [
  pc('Budding Insurgent', ['G'], 2, 'Creature — Elf'), pc('Duskwatch Hunter', ['B', 'G'], 3, 'Creature — Wolf'), pc('Budding Insurgent', ['G'], 2, 'Creature — Elf'),
  pc('Beorn', ['G'], 5, 'Creature — Bear // Sorcery — Adventure'), pc('Mirkwood', [], 0, 'Land'), pc('Budding Insurgent', ['G'], 2, 'Creature — Elf'),
];
const guide = readFileSync(resolve(import.meta.dirname, '../../../prompts/deckbuilding-guide.md'), 'utf8');
const offer = (level: KnowledgeLevel) => {
  const k: Knowledge = { level, guide, stats: level === 'primer+stats', ...(level === 'none' ? {} : { primer: '# Set context' }) };
  return deckOfferV4('B1', pool, cards, ratings, k);
};
const fixtures = resolve(import.meta.dirname, '../test/fixtures/mtgdt-deck-prompt');
const LEVELS: Array<{ level: KnowledgeLevel; fixture: string; context: boolean }> = [
  { level: 'none', fixture: 'none.txt', context: false },
  { level: 'primer', fixture: 'set-context.txt', context: true },
  { level: 'primer+stats', fixture: 'set-context.txt', context: true },
];
/** The deck builder's prompt with tier scores on: only the source of the tier score rules in NOT_PORTED. */
const TIERS_FIXTURE = 'set-context-tiers.txt';
const applies = (when: When | undefined, l: { context: boolean }) =>
  !when || when === 'always' || when === 'hybrid' || (when === 'context' && l.context);

for (const l of LEVELS) {
  const mtgdt = readFileSync(join(fixtures, l.fixture), 'utf8');
  const bench = offer(l.level);
  test(`checklist at ${l.level} (deck builder ${l.fixture})`, () => {
    const missingInMtgdt: string[] = [];
    const missingInBench: string[] = [];
    const leaked: string[] = [];
    for (const item of CHECKLIST) {
      if (applies(item.when, l)) {
        if (!mtgdt.includes(item.mtgdt)) missingInMtgdt.push(item.id);
        if (!item.bench.test(bench)) missingInBench.push(item.id);
      } else {
        // Off at this level in both products.
        if (mtgdt.includes(item.mtgdt)) leaked.push(`${item.id} (deck builder)`);
        if (item.bench.test(bench)) leaked.push(`${item.id} (bench)`);
      }
    }
    assert.deepEqual(missingInMtgdt, [], `deck builder prompt changed (recapture and update the checklist): ${missingInMtgdt.join(', ')}`);
    assert.deepEqual(missingInBench, [], `bench offer is missing: ${missingInBench.join(', ')}`);
    assert.deepEqual(leaked, [], `on at a level where it should be off: ${leaked.join(', ')}`);
  });
}

test('every left-out rule is still in the deck builder prompt, with a reason', () => {
  const all = [...LEVELS.map((l) => l.fixture), TIERS_FIXTURE].map((f) => readFileSync(join(fixtures, f), 'utf8')).join('\n');
  for (const n of NOT_PORTED) assert.ok(all.includes(n.mtgdt), `NOT_PORTED entry no longer in the deck builder prompt: ${n.mtgdt}`);
});

test('card data: every deck builder field has a bench field; no tier scores at any level', () => {
  for (const l of [...LEVELS, { level: 'primer+stats' as KnowledgeLevel, fixture: TIERS_FIXTURE }]) {
    const mtgdt = readFileSync(join(fixtures, l.fixture), 'utf8');
    const fields = new Set<string>();
    for (const line of mtgdt.split('\n')) {
      const s = line.replace(/,$/, '');
      if (!s.startsWith('{"name":')) continue;
      for (const k of Object.keys(JSON.parse(s))) fields.add(k);
    }
    assert.ok(fields.size > 5);
    const unmapped = [...fields].filter((f) => !(f in FIELD_MAP));
    assert.deepEqual(unmapped, [], `deck builder card fields with no bench equivalent: ${unmapped.join(', ')}`);
    assert.equal(fields.has('tierScore'), l.fixture === TIERS_FIXTURE);
    assert.ok(!fields.has('edhrecRank') && !fields.has('pricesUsd'), 'the 40-card path leaves out EDHREC rank and price');
    const benchCards = offer(l.level).split('\n').filter((x) => x.startsWith('{"n":')).map((x) => JSON.parse(x));
    const benchFields = new Set(benchCards.flatMap((c) => Object.keys(c)));
    for (const f of fields) {
      const b = FIELD_MAP[f];
      if (b) assert.ok(benchFields.has(b), `${f} → ${b} missing from the bench card JSON at ${l.level}`);
    }
    assert.ok(!benchFields.has('tierScore'), `no tier score in the bench card JSON at ${l.level}`);
    assert.equal(benchFields.has('17lands'), l.level === 'primer+stats');
  }
});

test('no tier score rule reaches the bench offer at any level', () => {
  for (const l of LEVELS) {
    const bench = offer(l.level);
    for (const n of NOT_PORTED.filter((x) => x.why === TIER_WHY)) assert.ok(!bench.includes(n.mtgdt), `${l.level}: ${n.mtgdt}`);
    assert.doesNotMatch(bench, /"tierScore"|Tier Score Guide|tierScore gap|treat its tierScore/, l.level);
    assert.doesNotMatch(bench, TIER_SCORE_RE, `${l.level}: no tier-score wording at all`);
  }
});

console.log(`# ${passed} passed`);
