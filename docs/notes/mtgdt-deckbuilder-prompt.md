# The MTG Deck Tools AI Deck Builder prompt, and how the bench mirrors it

Internal note (2026-10-22). Source: `Magic-Deck-Builder/src/pages/DeckBuilderPage.tsx` (`generateAiPromptString`, `prepareCardDataForPrompt`, `handleProcessAiResult`, `handleAutoGenerateAiDeck` and the `format*ForAI` repair messages), `services/card-api/src/gemini-proxy.ts` and `src/utils/aiDeckJson.ts`, read at commit `f2e7357`. The prompt is the owner's own writing and is reused here.

Bench side: `packages/director/src/deckbuild-v4.ts` (offer, submission check, review), `packages/director/src/build.ts` (`askForDeckV4`, the decide → review → lock flow), `prompts/deckbuilding-guide.md` (the rules text), the parity checklist `packages/director/src/deck-parity.test.ts` and its fixtures (`packages/director/test/fixtures/mtgdt-deck-prompt/`, captured by `scripts/capture-mtgdt-deck-prompt.ts`).

## 1. What the deck builder's 40-card path sends

### Settings and defaults

| Setting | Default | Effect on the prompt |
|---|---|---|
| Deck size 40 / 60 | 40 | 40: Limited wording, set context and tier scores possible, EDHREC rank and price dropped from the card JSON, the "Typical 40-Card Composition" rule. |
| Selected colors | the user's picks | The pool sent is filtered to cards castable in those colors, and to lands whose colors are all selected. With all five selected the prompt switches to "AI Color Choice Mode" (Deck Mana Colors derived from the final spells). |
| Set Context | None, but asking for a 40-card prompt with None opens a set context picker once | When on: the set context markdown between `Limited Set Specific Context (START)` / `(END)`, then "Set Context Overrides Generic Heuristics", and the land-count item in the final checklist. Off for 60 cards. A custom set context can be pasted. |
| Ignore Tier Scores | off (tier scores on) | When tier scores are on (40 cards only): `tierScore` on every card, the pool note, the 0–10 Tier Score Guide, and with a set context "Set Context Overrides Static Tier Scores on Build-Arounds" (effective tierScore 3). |
| Include Sideboard | off | A 15-card sideboard field and primer section. |
| Additional Instructions | empty | Appended as "Additional Instructions". |

### Card data (40 cards)

One JSON object per line, sorted by mana value: `name`, `count` ("the maximum number of copies you may use"), `tierScore` (when on), `cmc`, `manaCost` (front face cost if the card has none), `typeLine`, `oracleText`, `power`, `toughness`, `colors`, `colorIdentity`, `keywords`, `set`, `rarity`, and `cardFaces` (every face: name, cost, type, text, P/T, colors, keywords) for multi-face cards. Basic lands, cards that failed lookup, cards not castable in the selected colors and off-color lands are left out. Tier scores come from the site's tier list (`src/data/exampleTierList.ts`): letter grades or 0–10 numbers per card, from 17Lands Card Data σ-banded GIH WR grades (FRA, HOB, MSH via `scripts/apply-17lands-to-*-tier-list.cjs`), 17Lands human tier lists, Draftsim pick orders, or manual scores. Cards without a score get 6.

### Prompt structure (long-context order: data first, hard constraints last)

1. Role and task: the single best 40-card Limited deck, from the pool plus basics.
2. Available Card Pool (the JSON above, with the "count" and ground-truth notes).
3. Set context block and its override rules (when on).
4. Goal. Step 1 Comparative Analysis (2–3 options; criteria; the critical mana curve and consistency rules: 5–6 two-drops, Rule of One, strict splash land math, no MV 1–2 splashes, tap-land tension, double pips, greedy-splash exception; curve vs power; the critical interaction rules; "Remember"); optional alternatives. Step 2 Construct (Enabler vs Payoff). Step 3 Mana Base & Hybrid Audit (3a Deck Mana Colors, 3b hybrid castability when the pool has hybrid costs, 3c secondary faces, 3d land audit).
5. Important Rules: Golden Rule (pool only, never above `count`, basics the only exception), basics required, the 40-card rule is absolute, Tier Score Guide, interaction, typical composition (control 8–10 creatures, aggro 15+, Auras/Equipment/fight need creatures, 17 lands).
6. Primer requirements (a 1,000–2,000-word HTML strategy primer with card-data fidelity and same-turn mana math rules).
7. Output format: one JSON code block with `deckbuildingThoughtProcess` (required, before the list), optional `alternativeDecksConsidered`, `deckName`, `deckList` [{cardName, quantity}], `verification` {verificationScript, totalCount}, `strategyPrimer`, `archetype`; exact pool names ("A // B" for multi-face cards).
8. Final pre-output checklist: pool check, exact names, card count summed one at a time (script if available, never estimated, exactly 40), land base audit (and set context land count), JSON validity, primer fidelity.

### Guards against invented cards and wrong counts

- In the prompt: the Golden Rule (repeated in the output rules and checklist), exact names, `count` as the copy limit, the verification script and `totalCount`, the summing instruction.
- After the answer (`handleProcessAiResult`): extract the JSON (fenced block or brace matching), drop `verification` before parsing (counts are taken from `deckList`, not the model's own total), `jsonrepair` fallbacks, required fields (`deckName`, `strategyPrimer`, `archetype` strings; `deckList` items with a name and a quantity ≥ 1), names matched case-insensitively against the pool, basics fetched, cards not in the pool collected as "missing".
- Repair: if the total (including missing cards) isn't 40 or 60, or cards are missing, a soft error with a repair message ("The JSON Deck list you provided only has 38 cards in it, we need to add 2 cards to meet the 40 cards requirement…"; "You incorrectly added cards that were not in my original card pool: …"; combined). Auto-generate (Gemini 3.8 Flash, thinking MEDIUM, 3.6 Flash fallback) retries once with the error appended under `--- PREVIOUS ATTEMPT FAILED ---`; transient errors resend the clean prompt; after the retry an imperfect deck is accepted with a warning.
- Not checked: a quantity above the pool's `count` is accepted as long as the name is in the pool.

## 2. The bench before this change (prompt v4 as of `b10ddde`)

- Card JSON per physical copy (no `count`; three copies were three unrelated lines), in pick order; a one-line-per-card summary without copy counts; basics listed as pool cards.
- A condensed 33-line guide: missing the set-context override wording (fast/slow formats, names illustrative), the tier score guide, the 3a–3d audit (hybrid examples, "hybrid never expands", fetch rule, audit every land), the interaction sub-rules, the Golden Rule and 40-card rule, the summing instruction, the output contract (thought process, total count, name, archetype) and the final checklist. It said 16–17 lands and 14–17 creatures (the deck builder: 17 lands; control 8–10, aggro 15+).
- Set context only as a pointer to `get_set_context`; tier scores never shown (17Lands GIH WR/ATA at Set Context + Human Stats only).
- Validation: numbers in range, a repeated number rejected ("each pool card can be used once"), which read as "you can't play copies"; basic names exact-case; at least 40. No review, no record of rejected answers.
- `{Two/W}` and `{P/R}` cost notation in v4 card JSON (the deck builder's rules are written for `{2/W}` and `{R/P}`).

## 3. The bench now

- **Rules:** `prompts/deckbuilding-guide.md` carries every rule of §1 that changes the deck except the tier score rules (§5), in the deck builder's terms, rewritten for the decide interface and without repetition; `{{#set_context}}`, `{{#stats}}` and `{{#hybrid}}` blocks are switched by knowledge level and pool, like the deck builder's conditionals.
- **Card data:** the same fields from the same card JSON helper as packs and games (`cards.json`): `n`, `count`, `poolNumbers` (each copy's number when there are several), `rarity`, `name`, `cost`, `mv`, `colors`, `colorIdentity`, `type`, `pt`, `loyalty`, `defense`, `keywords`, full `text`, every other face in `faces`, and `17lands` at Set Context + Human Stats. Sorted by mana value; basics left out (unlimited); `set` left out (one set per event).
- **Computed facts** (JSON, never left for the model to count): cards, creatures and two-drops per color group (Hybrid separate), the copies, non-basic lands and what they make, castable cards per color pair (hybrid for either color).
- **Input:** `cards` takes one pool number per copy; repeating a number takes the card's other copies, so `[12, 12, 12]` and `[12, 30, 41]` mean the same; the old one-number-per-copy form still works. Every problem is reported at once: numbers out of range, too many copies ("You drafted 2 copies of Powerful Broker (pool numbers 12, 31); your deck asks for 3."), a drafted basic asked for twice (use `basics`), unknown basic names (case-insensitive), fewer than 40 cards (the deck builder's repair wording). Optional fields: `total_count`, `deck_name`, `archetype`, `analysis` (the thought process).
- **Review (one round, logged):** after a valid submission the Director replies with its exact count as JSON (total, basics, lands and spell // land cards, creatures, curve, Deck Mana Colors, cards/pips/sources per color, splash colors, each card once with its count and pool numbers) and flags: over 40 (legal, but the rule is exactly 40), `total_count` missing or wrong, uncastable cards (hard pips or hybrid with no source), splash land math, splashed mana value 1–2 and double-pipped cards, off-color lands and basics, land count against 17 (16 + a spell // land card passes), fewer than 5 two-drops, an aggro deck under 15 creatures, copies left in the sideboard. Confirm, or resubmit once (locks at once). An inactive seat keeps the deck it submitted. `deck_built` logs the resolved `pool_numbers`, the review (flags, summary, outcome), every rejected answer, and the agent's count, name, archetype and analysis.
- **Exceeds the deck builder:** copy limits are enforced; names can't be invented; counts are the Director's, shown before the deck locks.

## 4. Knowledge levels ↔ deck builder settings

| Bench level | Deck builder setting | Why |
|---|---|---|
| No Set Context (`none`) | Set Context None, Ignore Tier Scores on | No set-specific knowledge of any kind. |
| Set Context (`primer`) | Set Context on, Ignore Tier Scores on | The set context is the owner's writing, not human play data. |
| Set Context + Human Stats (`primer+stats`) | Set Context on, Ignore Tier Scores on, plus the 17Lands stats | Human play data comes as the 17Lands stats themselves (GIH WR, ATA, and the color pair averages in the pool facts), from the event's pinned snapshot. |

No level sends MTG Deck Tools tier scores (owner decision, 2026-10-22, prompts v6): agents use their own card evaluation, or the 17Lands stats at Set Context + Human Stats, rather than the deck builder's tier score concept. Until v6, Set Context + Human Stats mapped to "tier scores on" (the bench computed them from the 17Lands snapshot with the deck builder's σ-banding). The deck builder's default (tier scores on) therefore has no bench equivalent. The set contexts are written for the deck builder and still mention tierScores; the guide tells agents there are none and to judge card power themselves.

## 5. What isn't mirrored, and why

- **The set context isn't repeated inline** in the deck offer: every seat gets it at the start of the event, and `get_set_context` returns it again; the offer tells the agent to re-read it. Inline it would add 6k–14k tokens to one decision (TLA's is 14k).
- **The strategy primer** and its fact-check rules: documentation for a human reader, not part of the deck.
- **JSON formatting rules, exact-name rules:** the answer is a tool call with pool numbers.
- **Debate/feedback regeneration** (`updatesAndRationale`, deck-name revision rules): the review's single resubmission replaces it.
- **Sideboard and additional instructions:** off by default in the deck builder; unused pool cards are the sideboard.
- **Tier scores:** the `tierScore` card field, the pool note, the Tier Score Guide and "Set Context Overrides Static Tier Scores on Build-Arounds". Owner decision: agents use their own card evaluation, or 17Lands stats at the Human Stats level. The parity test lists these rules in `NOT_PORTED`, checked against the tier-scores-on capture (`set-context-tiers.txt`).

## 6. A/B: old offer vs new (2026-10-22)

Claude Haiku 5.5 (`claude-haiku-5-5`, local `claude -p`, no tools), one-shot with the event briefing (fundamentals, and the set context at the Set Context levels) then the deck offer; the Director's real seat code checked each answer and fed back its reply (rejection or review). 9 real 42-card pools from logged events (FRA ×3, TLA ×2, MSH ×2, HOB ×2), every pool with duplicates (2–6 copies), across all three knowledge levels; 2 runs per pool and variant (36 runs). Harness: `tmp/deck-ab/` (not committed).

| | Old offer | New offer |
|---|---|---|
| Decks locked, 40 cards | 18/18 | 18/18 |
| Valid on the first answer | 17/18 (one 39-card deck rejected) | 18/18 |
| Review | – | 15 confirmed, 3 resubmitted (two added the 17th land the review flagged, one swapped a card) |
| Lands | 17 in all 18 | 17 in 17, 16 in 1 (flagged, kept) |
| Creatures / two-drops (mean) | 14.8 / 7.5 | 14.6 / 6.9 |
| Uncastable cards, splash or off-color land flags | 0 | 0 |
| Duplicated cards played: all copies / only some | 55 / 45 | 73 / 23 |
| `total_count` reported (and correct) | – | 18/18 |
| Build quality (site `build-quality.ts`, mean) | 0.5602 | 0.5606 |
| Expected win rate (mean) | 52.30% | 52.51% |
| vs best build of the same pool / vs reference build | −0.54 / −0.38 pp | −0.50 / −0.33 pp |
| Spend (API-equivalent `total_cost_usd`) | $0.18 | $0.38 |

Both offers already gave Haiku legal, on-color 17-land decks on these pools. The clear change is copies: with the old offer Haiku left a copy of a card it was playing in the sideboard 45 times in 18 decks, with the new one 23 times (some of those are deliberate: the review lists each one). Build quality moved slightly up, within noise for 18 decks. The new offer costs about twice as much per build (a longer offer, the `analysis` field and the review round). Total spend including two plumbing runs: $0.57.

## 7. Keeping the two in step

Now: `scripts/capture-mtgdt-deck-prompt.ts` lifts `generateAiPromptString` out of the page (read-only, types stripped with esbuild) and captures it for the four settings into test fixtures; `--check` exits 1 when the deck builder's prompt has changed. `deck-parity.test.ts` checks a list of 94 critical rules: each must be in the captured deck builder prompt (so a change there is noticed) and in the bench offer at the matching level, and must be absent at levels where it is off in both. It also checks that every deck builder card field has a bench field, and that every rule left out is still in the deck builder prompt with a reason.

Proposed long-term: move the prompt builder out of `DeckBuilderPage.tsx` into a pure module in the site repo (`src/ai/deckPrompt.ts`: rule sections as data, the card JSON mapper, the result checks and repair messages), used by the page, and synced into the bench the way `scripts/export-mtgdt-primers.ts` syncs set contexts (exported at build time, hash recorded in `deps/manifest.json`). Both products would then render the same rule sections, and the checklist would only cover the transport differences.
