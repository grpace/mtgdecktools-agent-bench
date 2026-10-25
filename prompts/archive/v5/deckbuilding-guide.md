## How to build your deck (the MTG Deck Tools AI Deck Builder's 40-card Limited rules)

Build the single best 40-card Limited deck your pool allows. All five colors are open: choose the best color combination the pool supports, then build the mana base from the final deck's casting costs. Use ONLY cards from YOUR POOL, plus basic lands, which you add yourself.
{{#set_context}}

**The set context overrides generic heuristics.** The MTG Deck Tools set context for this format (sent at the start of the event; call get_set_context to read it again if it isn't in front of you) describes THIS format's actual speed, curve expectations, land counts, archetypes and card evaluations. Wherever it conflicts with the generic rules below (two-drop minimums, land totals, creature counts, removal priorities, format speed), the set context wins. If it says the format is fast or hyper-aggressive, lower your curve and value 1- and 2-drops over late-game value; if it says the format is slow and grindy, value card advantage, two-for-ones and late-game staying power. The ONE rule it can never override: card names in the set context are examples only. You may only play a card that is in YOUR POOL.
{{#stats}}

**The set context overrides tier scores on build-arounds.** A card's tierScore rates it in an average deck where its synergies exist. If the set context calls a card a conditional build-around (it needs multiple copies, a creature type, or a density of enablers your pool lacks), treat its tierScore as 3 unless your pool actually meets those conditions.
{{/stats}}
{{/set_context}}

### Step 1: Comparative analysis (required)
Compare 2–3 viable approaches (different archetypes, color pairs or plans) before you pick one. Don't take the first cohesive deck you see: the goal is the BEST deck, not a good one.
1. Identify 2–3 viable approaches in your pool.
2. Build each one in your head: key cards, mana curve, synergies, strengths and weaknesses.
3. Compare them on raw power, synergy density, mana consistency, curve, interaction (removal, counterspells, bounce, fight) and completeness.
4. Pick the best only after that comparison.

**Curve and mana consistency (critical):**
- **Curve:** a smooth spread of mana costs; can the deck reliably play spells on turns 1–4? An absolute minimum of 5–6 proactive creatures or spells at mana value 2.
- **Consistency:** enough sources for each color you need, so you rarely hold uncastable cards.
- **Curve vs power:** higher raw power with a poor curve is often worse than slightly less power with an excellent curve and consistent mana. A deck that can't cast its spells is not a good deck, however strong its cards.
- **The Rule of One ("clunk factor"):** a deck survives one structural flaw (bad mana OR a bad curve), never two. If the early curve is already weak, do NOT splash a third color.

**Splashing (strict land math):**
- 1 splashed card (1 pip) needs at least 3 sources of that color; 2 splashed cards need 4; 3 splashed cards need 5–6. Sources are basics, dual lands and search effects (Evolving Wilds and the like). If fetchers or searchers are splash sources, play at least 1 basic of the splash color so they have a target.
- **HARD RULE:** never splash a card with mana value 1 or 2, even premium removal, unless it is an absolute game-winning bomb: you will almost never have splash mana on turns 1–2. Splash only bombs or unconditionally powerful spells costing 3+.
- Avoid splashing double-pipped cards (e.g. {2}{R}{R}).
- **Tap-land tension:** an aggressive deck with 1-drops should strictly limit lands that enter tapped (tap-duals, Evolving Wilds); slower decks can afford several.
- **Greedy-splash exception:** you may break these splash and clunk rules ONLY if your main colors lack win conditions and a greedy splash is your only path to victory.

**Interaction and closing power (critical):**
- **Suite quality:** enough interaction (removal, counterspells, bounce, fight) to answer opposing threats and the bombs that would otherwise win.
- **Quantity and quality:** count your removal. Efficient (cheap) and versatile (hits many threat types) beats narrow; match the format's threat density.
- **Balance:** all threats loses to decks with better answers; all answers can't close. The best deck balances both.
- **Format needs:** answers for this format's common threats (e.g. reach, flyers or removal that hits flyers in a format full of flyers).
- **Parity breakers:** a plan to break board stalls: evasion (flying, menace, can't be blocked), trample, or late-game mana sinks.
- **Timing:** some instant-speed interaction; early interaction against aggressive decks and answers for late-game bombs.

Remember: the best deck is not the one with the most powerful individual cards; it is the one that consistently executes its plan. A good curve, consistent mana and enough interaction usually beat higher card power with a poor curve, shaky mana or too few answers.

### Step 2: Build the deck
- Build the best 40 from your comparison: card synergy, strong combinations, an ideal curve and overall strength.
- **Enablers vs payoffs:** if the archetype relies on synergy (counters, graveyard, a creature type, "whenever you cast…"), count your enablers and payoffs. Don't play a payoff without the enablers to support it.
- **Composition:** there is no strict creature minimum for control: 8–10 creatures can be right if the rest is premium removal and card advantage. Aggro decks still need 15+ creatures, and Auras, Equipment or fight spells need a high creature count. Generally play 17 lands{{#set_context}} (unless the set context says otherwise){{/set_context}}.
- **Interaction:** include a reasonable amount of interaction and removal for your strategy.
{{#stats}}
- **Tier Score Guide (0–10, for 40-card Limited decks):** "tierScore" rates a card's raw power in a vacuum (MTG Deck Tools' scale, from 17Lands GIH WR). It is a strong prior, not the final word: a lower-tier card essential to your deck's synergy can beat a higher-tier card that doesn't fit the plan; but a LARGE tierScore gap should rarely be overridden by marginal synergy.
  - **10: Incredible bombs.** Make a meaningful impact on any game, even from behind. Consider building around them.
  - **9: Great first picks.** Game-winning bombs and the most efficient removal.
  - **8: Above average.** Strong cards, better than the average playable.
  - **7: Solid playables.** The backbone of most Limited decks.
  - **6: Sometimes playable.** Fill a specific role; play as few as you can.
  - **5: Rarely playable.** Maybe a build-around; only for a specific purpose.
  - **4 and below: basically unplayable.** Only as filler to reach 40, and minimize them.
{{/stats}}

### Step 3: Mana base and hybrid audit
This step is the single source of truth for mana colors, hybrid costs and land choices.

**3a. Deck Mana Colors.** All five colors are available so you can choose the best combination; they are NOT automatically your mana base. After locking the non-land spells, compute Deck Mana Colors from their costs:
1. Look at every non-land card in the final deck and its "cost".
2. Start from **hard colored pips only** ({W}, {U}, {B}, {R}, {G}). Those colors must be in the mana base.
3. Hybrid symbols are **OR, not AND**. If a hybrid symbol can already be paid with a color from step 2, don't add its other half.
4. Only if a hybrid card can't be paid by any color from step 2, add **one** of its halves to match your archetype, never both.
5. Never add a color only because it appears in "colorIdentity" (rules text, another face, an activated ability).
{{#hybrid}}

**3b. Hybrid castability** (check every hybrid card while you compare options, not just at the end):
- **Color/color hybrid ({R/G}, {W/B}):** pay with EITHER color. It is a mono-red card AND a mono-green card, NOT a gold card: castable in any deck with red or green. Each symbol is 1 mana value.
- **Number/color hybrid ({2/G}):** pay {2} OR {G}. If G is one of your colors it costs {G}; otherwise {2}.
- **Example (deck colors W, U, R):** {W/B} is castable with white; {G/B} is uncastable; {2/W} costs {W}; {2/G} costs {2}; {2/U}{2/R}{2/W} costs {U}{R}{W}.
- Don't skip a powerful hybrid card because it shows a "wrong" color: if your mana can pay its cost, it is a valid inclusion.
- **Hybrid never expands mana needs:** the unused half of a hybrid symbol never justifies basics, duals or splash sources. A blue-green deck casts a {G/B} card with green alone: no Swamps, no black-green dual.
{{/hybrid}}

**3c. Secondary faces, flashback and activated abilities.** Check BOTH faces ("faces": adventure, prepare, modal double-faced) and any flashback or activated-ability costs in the text. A card belongs in the deck if its main face is castable with Deck Mana Colors; an off-color secondary face or ability is upside, not a requirement. Add that secondary color to Deck Mana Colors only if you can support it for free (on-color duals that also make one of your main colors, or any-color sources already in the deck) without hurting your main colors (never fewer main-color sources for it, and mind the tap-land tension).

**3d. Land audit (hard rules):**
- **On-color duals only:** play a dual land ONLY if EVERY color it can make is among Deck Mana Colors. Sharing one color doesn't make it fixing: in a blue-green deck a green-black dual is WRONG, because a Forest or Island is strictly better. Colorless, any-color and fetch utility lands are fine when appropriate.
- **Both colors must be needed:** even an on-color dual is only worth its drawback (enters tapped, costs life) if you need BOTH its colors.
- **Basics only for Deck Mana Colors.** Never off-color basics "just in case".
- **Fetches (Evolving Wilds etc.):** useful for an intentional hard-pip splash or demanding multi-pip costs; skip them when they only slow a clean aggressive curve.
- Audit every non-basic land against Deck Mana Colors and drop any that fail.

### Best of 3: plan your sideboard
Matches are best of 3. Before games 2 and 3 you may swap cards between your deck and your sideboard (every pool card you don't play) and change your basics. Build the strongest main deck first, then plan the sideboard: which cards come in against which threats or archetypes (e.g. removal for fliers, artifact or enchantment removal, cheap blockers against aggro), and what they replace.

### Rules
- **GOLDEN RULE: only cards from YOUR POOL.** Submit them by pool number, never more copies than their "count". No cards from {{#set_context}}the set context, {{/set_context}}examples or anywhere else. The ONLY exception is basic lands (Plains, Island, Swamp, Mountain, Forest), which you add yourself in `basics`; your pool lists no basics.
- **Copies:** you may play every copy you drafted. One pool number per copy: to play all 3 copies of a card with "n": 12, "count": 3, put 12 in `cards` three times (or list its three "poolNumbers"). Basic lands are unlimited.
- **The 40-card rule is absolute:** the main deck is exactly 40 cards: the pool cards in `cards` (spells and non-basic lands) plus the basics you add. Fewer than 40 is rejected. More than 40 is legal, but the Director flags it: cut your weakest cards.

### Final check before you submit (mandatory)
Run every check on your final deck; if one fails, fix the deck and run them all again.
1. **Pool check:** every number in `cards` is from YOUR POOL, and no card appears more times than its "count".
2. **Card count:** add the copies in `cards` and the basics one at a time, writing the running total (use a tool or script if you have one). Do NOT estimate. The total must be exactly 40. Put it in `total_count`.
3. **Land base:** every land passes the Step 3 audit (Deck Mana Colors only, on-color duals only, no basics or duals for unused hybrid halves){{#set_context}}, and the land count follows any guidance in the set context{{/set_context}}.
4. **Castability:** every non-land card is castable with Deck Mana Colors.

### How to answer
One decide call, with:
- `cards`: pool numbers of the main deck's non-basic cards, one per copy.
- `basics`: e.g. {"Plains": 8, "Island": 9}, exact names.
- `total_count`: your own sum from the final check.
- `deck_name` (creative and thematic) and `archetype` (Aggro, Control, Midrange, Tempo, Combo…).
- `analysis`: your deckbuilding thought process for THIS pool: the options you compared and why this one won, the counts you made (creatures, two-drops, removal, enablers and payoffs), the cuts, the mana audit (Deck Mana Colors, every non-basic land checked), and your sideboard plan (what comes in against what, and what it replaces).
- `note`: the deck's plan in one line.

The Director then shows you the deck exactly as it counted it (JSON: each card with its count, lands, curve, sources against pips per color, and flags for any rule it breaks). Confirm it, or resubmit the whole deck once. Nothing locks until then.
