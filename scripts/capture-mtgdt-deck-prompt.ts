// Capture the MTG Deck Tools AI Deck Builder's 40-card Limited prompt as test fixtures, for the deckbuilding parity
// checklist (packages/director/src/deck-parity.test.ts).
// Usage: npx tsx scripts/capture-mtgdt-deck-prompt.ts [path-to-Magic-Deck-Builder] [--check]
//   --check   write nothing; exit 1 if the deck builder's prompt changed since the fixtures were captured
//
// Reads src/pages/DeckBuilderPage.tsx (never modifies it), lifts generateAiPromptString out of the page component,
// strips its types with esbuild and runs it on a small sample pool under the settings the knowledge levels map to
// (the mapping is in packages/director/src/deck-parity.test.ts): 40 cards, all five colors open (the bench lets the agent choose colors),
// no sideboard, no extra instructions; set context off or on, tier scores off or on. The set context itself is a
// placeholder: its text is checked by scripts/export-mtgdt-primers.ts, not here. Every knowledge level maps to a
// tier-scores-off capture: the bench sends no MTG Deck Tools tier scores (owner decision: agents use their own card
// evaluation, or 17Lands stats at the Human Stats level). The tier-scores-on captures stay so the parity test can check
// that the rules it leaves out (NOT_PORTED) are still the deck builder's.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { transformSync } from 'esbuild';

function main(): void {
  const root = resolve(import.meta.dirname, '..');
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const repo = resolve(args.find((a) => !a.startsWith('--')) ?? process.env.MTGDT_REPO ?? join(root, '..', 'Magic-Deck-Builder'));
  const page = join(repo, 'src', 'pages', 'DeckBuilderPage.tsx');
  const outDir = join(root, 'packages', 'director', 'test', 'fixtures', 'mtgdt-deck-prompt');
  const source = readFileSync(page, 'utf8');

  const start = source.indexOf('const generateAiPromptString = (');
  const endMarker = '\n    return prompt;\n  };';
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`generateAiPromptString not found in ${page}; the capture needs updating.`);
  const fnSource = source.slice(start, end + endMarker.length);
  const js = transformSync(fnSource, { loader: 'ts' }).code;
  // Its only outside dependency: the set context lookup ('none' → '').
  const resolveSetContextMarkdown = (selection: string) => (selection === 'none' ? '' : SET_CONTEXT_PLACEHOLDER);
  const generate = new Function('resolveSetContextMarkdown', `${js}\nreturn generateAiPromptString;`)(resolveSetContextMarkdown) as (...a: unknown[]) => string;

  const settings: Record<string, { context: boolean; tiers: boolean }> = {
    'none': { context: false, tiers: false },
    'set-context': { context: true, tiers: false },
    'set-context-tiers': { context: true, tiers: true },
    'tiers-only': { context: false, tiers: true },
  };
  const out: Record<string, string> = {};
  for (const [name, s] of Object.entries(settings)) {
    const pool = SAMPLE_POOL.map((c) => {
      const { tierScore, ...rest } = c;
      return s.tiers ? { ...rest, tierScore } : rest;
    });
    // generateAiPromptString(targetSize, includeSideboard, selectedSet, pool, analysis, colors, additionalContext, ignoreTierScores, customSetContext)
    out[`${name}.txt`] = generate(40, false, s.context ? 'FRA' : 'none', pool, {}, ['W', 'U', 'B', 'R', 'G'], '', !s.tiers, '') + '\n';
  }
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%H', '--', 'src/pages/DeckBuilderPage.tsx'], { encoding: 'utf8' }).trim();
  } catch {
    // not a git checkout
  }
  const meta = {
    source: 'Magic-Deck-Builder src/pages/DeckBuilderPage.tsx (generateAiPromptString)',
    source_commit: commit,
    function_sha256: createHash('sha256').update(fnSource).digest('hex'),
    settings: Object.fromEntries(Object.entries(settings).map(([k, v]) => [`${k}.txt`, { targetSize: 40, colors: 'WUBRG (AI color choice)', includeSideboard: false, setContext: v.context ? 'on (placeholder)' : 'none', ignoreTierScores: !v.tiers }])),
  };

  if (check) {
    const old = existsSync(join(outDir, 'source.json')) ? JSON.parse(readFileSync(join(outDir, 'source.json'), 'utf8')) : {};
    const changed = Object.entries(out).filter(([f, text]) => !existsSync(join(outDir, f)) || readFileSync(join(outDir, f), 'utf8') !== text).map(([f]) => f);
    console.log(JSON.stringify({ function_sha256: meta.function_sha256, fixture_sha256: old.function_sha256 ?? null, changed }, null, 1));
    process.exit(changed.length ? 1 : 0);
  }
  mkdirSync(outDir, { recursive: true });
  for (const [f, text] of Object.entries(out)) writeFileSync(join(outDir, f), text);
  writeFileSync(join(outDir, 'source.json'), JSON.stringify(meta, null, 1) + '\n');
  console.log(`wrote ${Object.keys(out).length} prompts to ${outDir} (source ${commit.slice(0, 12)})`);
}

const SET_CONTEXT_PLACEHOLDER = '<<SET CONTEXT MARKDOWN (sets/<SET>/primer.md)>>';

/** A small pool in the deck builder's card shape (AiPromptCardData): a hybrid card, an adventure, a dual land, copies. */
const SAMPLE_POOL = [
  { name: 'Budding Insurgent', count: 3, tierScore: 7, cmc: 2, manaCost: '{1}{G}', typeLine: 'Creature — Elf Warrior', oracleText: 'Trample', power: '2', toughness: '2', colors: ['G'], colorIdentity: ['G'], keywords: ['Trample'], edhrecRank: null, set: 'fra', pricesUsd: null, rarity: 'common' },
  { name: 'Duskwatch Hunter', count: 2, tierScore: 7, cmc: 3, manaCost: '{2}{B/G}', typeLine: 'Creature — Wolf', oracleText: "This creature can't be blocked by tokens.\nWhen this creature enters, put a +1/+1 counter on target creature.", power: '3', toughness: '1', colors: ['B', 'G'], colorIdentity: ['B', 'G'], keywords: [], edhrecRank: null, set: 'hob', pricesUsd: null, rarity: 'common' },
  {
    name: 'Beorn, Reluctant Host // Till and Tend', count: 1, tierScore: 8, cmc: 5, manaCost: '{4}{G}', typeLine: 'Legendary Creature — Human Bear Shapeshifter // Sorcery — Adventure', oracleText: 'Trample', power: '5', toughness: '5', colors: ['G'], colorIdentity: ['G'], keywords: ['Trample'], edhrecRank: null, set: 'hob', pricesUsd: null, rarity: 'uncommon',
    cardFaces: [
      { name: 'Beorn, Reluctant Host', manaCost: '{4}{G}', typeLine: 'Legendary Creature — Human Bear Shapeshifter', oracleText: 'Trample', power: '5', toughness: '5', colors: ['G'], keywords: ['Trample'] },
      { name: 'Till and Tend', manaCost: '{1}{G}', typeLine: 'Sorcery — Adventure', oracleText: 'You may play an additional land this turn.', power: null, toughness: null, colors: ['G'], keywords: [] },
    ],
  },
  { name: 'Mirkwood', count: 1, tierScore: 7, cmc: 0, manaCost: null, typeLine: 'Land', oracleText: 'This land enters tapped.\n{T}: Add {B} or {G}.', power: null, toughness: null, colors: [], colorIdentity: ['B', 'G'], keywords: [], edhrecRank: null, set: 'hob', pricesUsd: null, rarity: 'common' },
  { name: "Bilbo's Deadly Slice", count: 1, tierScore: 7, cmc: 3, manaCost: '{1}{B}{B}', typeLine: 'Instant', oracleText: 'Destroy target creature.', power: null, toughness: null, colors: ['B'], colorIdentity: ['B'], keywords: [], edhrecRank: null, set: 'hob', pricesUsd: null, rarity: 'common' },
];

main();
