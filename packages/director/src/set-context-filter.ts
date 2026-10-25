/**
 * The tier-score filter for Set Contexts (docs/METHODOLOGY.md §3.3, docs/UPGRADING.md "Set Contexts").
 *
 * The MTG Deck Tools set contexts were written for the site's AI Deck Builder, whose card pool lists a tierScore (0–10)
 * per card. Agents here get no tier scores at any knowledge level (prompts v6), so wording that tells them to use
 * tierScores, or claims the pool lists them, is a confound. This filter rewrites that wording deterministically, the same
 * way on every path a Set Context reaches an agent or the repo: `scripts/export-mtgdt-primers.ts` (sets/<SET>/primer.md),
 * the Director's loadKnowledge (live copy from mtgdecktools.com, its cache, the repo copy) and `npm run deps`. The owner's
 * files on the site stay unchanged.
 *
 * Rules, in order: exact rewrites of the sentences the current contexts use (claims that the prompt or the pool provides
 * tier scores are dropped; instructions to use them become the agent's own card evaluation); then generic rewrites of any
 * remaining "tierScore" / "tier score" and numeric tier references ("Tier 8.0+", "tier 6+"); last, a sentence that still
 * mentions one is dropped. General Limited vocabulary ("tier list", "top-tier", "mid-tier") is left alone. The filter is
 * idempotent and leaves text without tier-score wording byte-identical.
 */

/** Tier-score wording: "tierScore(s)", "tier score(s)", or a numeric tier ("Tier 8.0+", "tier 6+"). */
export const TIER_SCORE_RE = /\btier[ -]?scores?\b|\btier \d+(?:\.\d+)?\+?/i;

type Rule = [RegExp, string];

/** Exact rewrites of the sentences the exported contexts use (FRA, HOB, MSH, SOS, TLA as of 2026-10-22). */
const SPECIFIC: Rule[] = [
  // "The main prompt already defines your card pool, tierScores, and pool-only rules." (FRA, HOB, MSH): the prompt here has none.
  [/(defines your card pool), tier ?scores, and (pool-only rules)/gi, '$1 and $2'],
  // "Use **tierScores for raw power** and this section for …" (FRA, HOB)
  [/\*\*tier ?scores for raw power\*\*/gi, '**your own card evaluation for raw power**'],
  // HOB: "* **tierScore vs this format:** Vacuum scores miss roles."
  [/\*\*tier ?score vs this format:\*\* Vacuum scores miss roles\./gi, '**Raw power vs this format:** Vacuum card ratings miss roles.'],
  // SOS: "… lists every card you may play, each with a **tierScore** (0–10)."
  [/(lists every card you may play), each with a \*\*tier ?score\*\* \(0[–-]10\)\./gi, '$1.'],
  // SOS: "**Scan the pool by tierScore and color.** High tierScore (8+) cards are bombs …"
  [/\*\*Scan the pool by tier ?score and color\.\*\*/gi, '**Scan the pool by card quality and color.**'],
  [/High tier ?score \(\d+\+\) cards/gi, 'The strongest cards'],
  [/do not play low tier ?score (“|")signposts(”|")/gi, 'do not play weak $1signposts$2'],
  // SOS: "The pair with the most castable playables at tier 6+ is usually your base"
  [/the most castable playables at tier \d+\+/gi, 'the most strong castable playables'],
  // MSH: "(tierScores, synergies, mana, interaction)"; "Compare viable strategies from tierScores and synergies"
  [/\(tier ?scores, synergies, mana, interaction\)/gi, '(card quality, synergies, mana, interaction)'],
  [/from tier ?scores and synergies/gi, 'from card quality and synergies'],
  // MSH: "prioritize … when tierScores gap is large"
  [/when tier ?scores? gap is large/gi, 'when the power gap is large'],
  // MSH: "When a rare or mythic in your pool has a high tierScore and fits your mana"
  [/has a high tier ?score and fits your mana/gi, 'is clearly powerful and fits your mana'],
  // HOB, MSH: "the pool's best mix of tierScores, synergy, and mana"
  [/best mix of tier ?scores, synergy, and mana/gi, 'best mix of card quality, synergy, and mana'],
  // TLA: "(Tier 8.0+)" after "bomb rares/mythics" and "powerful cards": the bomb label says it already.
  [/ \(Tier \d+(?:\.\d+)?\+\)/gi, ''],
  // TLA §12: "not just by its tier score, but by understanding"
  [/not just by its tier ?score, but/gi, 'not just by its raw power, but'],
  // TLA §12.4: "**Tier Score as Starting Point:** Use tier scores as a baseline, but don't rely on them exclusively. A card
  // with a lower tier score might be better …"
  [/\*\*Tier ?Score as Starting Point:\*\* Use tier ?scores as a baseline, but don't rely on them exclusively\./gi,
    "**Raw Power as Starting Point:** Use your read of each card's raw power as a baseline, but don't rely on it exclusively."],
  [/A card with a lower tier ?score might be better/gi, 'A card with lower raw power might be better'],
  // TLA §12.6: "A card's tier score tells you its general power level, but …"
  [/A card's tier ?score tells you its general power level/gi, "A card's raw power is its general strength"],
];

/** Generic rewrites for wording the exact rules don't cover (a future edit of a context). */
const GENERIC: Rule[] = [
  [/\ban high tier ?score card\b/gi, 'a stronger card'],
  [/\ba high tier ?score card\b/gi, 'a stronger card'],
  [/\b(an?) lower tier ?score card\b/gi, 'a weaker card'],
  [/\bhigh(er)? tier ?scores?\b/gi, 'stronger'],
  [/\blow(er)? tier ?scores?\b/gi, 'weaker'],
  [/\btier ?scores\b/gi, 'card quality'],
  [/\btier ?score\b/gi, 'card quality'],
];

/** Sentences (and list items) that still carry tier-score wording after the rewrites are dropped. */
function dropRemaining(text: string): string {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (!TIER_SCORE_RE.test(line)) {
      out.push(line);
      continue;
    }
    const kept = line.split(/(?<=[.!?])\s+(?=\S)/).filter((s) => !TIER_SCORE_RE.test(s)).join(' ');
    // A list marker or heading left with nothing after it goes too.
    if (kept.replace(/^[\s*#>\d.-]*/, '').trim()) out.push(kept);
  }
  return out.join('\n');
}

/** A Set Context with its tier-score wording rewritten (see the module comment). Deterministic and idempotent. */
export function filterSetContext(text: string): string {
  if (!TIER_SCORE_RE.test(text)) return text;
  let out = text;
  for (const [re, to] of SPECIFIC) out = out.replace(re, to);
  // Generic rewrites keep a capital letter at the start of a sentence ("A lower tierScore card" → "A weaker card").
  for (const [re, to] of GENERIC) out = out.replace(re, (m) => (/^[A-Z]/.test(m) ? to[0]!.toUpperCase() + to.slice(1) : to));
  return TIER_SCORE_RE.test(out) ? dropRemaining(out) : out;
}

/** The line the export adds to the header of sets/<SET>/primer.md when the filter changed the text. */
/** Worded so the note itself never matches TIER_SCORE_RE (the header stays a fixed point of the filter). */
export const FILTER_NOTE = "Wording about the AI Deck Builder's per-card scores was filtered for the benchmark (packages/director/src/set-context-filter.ts); agents get no such scores.";
