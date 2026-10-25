# SOS Set Context: archetype claims the 17Lands data doesn't support

**Decision (owner, 2026-10-23): the Set Context stays as written, with no caveat.** It's drawn from expert and creator content (videos, guides) written while the format was live. Aggregate 17Lands win rates don't tell the whole story: multicolor decks with payoffs such as Snarl Song could go over the top of other decks, and a color-identity average can't show that. The bench presents Set Context and 17Lands as two independent references and doesn't treat either as ground truth for the other. The table below is kept for the record only.

Note for the owner (2026-10-22). This is not an edit of the Set Context. The text is yours, and the bench exports it as written, except for the tier-score filter (`packages/director/src/set-context-filter.ts`). Several archetype claims in the Secrets of Strixhaven context disagree with the 17Lands numbers the project ships. The bench shows those numbers on the same set page, so a data-literate reader can compare the two. The limited-pro review of 2026-10-22 flagged this as P1-5. You decide whether to change the text, add a dated note to it ("community view at release; 17Lands win rates since then differ"), or leave it.

## The data

Source: `sets/SOS/17lands-archetypes.json`, built from 17Lands public Premier Draft game data (582,914 games, drafts from 2026-04-21 to 2026-06-02, snapshot `SOS.PremierDraft@2026-06-05T22:15:41Z`; CC BY 4.0, credit 17Lands). Win rates are by main-deck color identity and are shrunk toward the mean (empirical Bayes). The baseline, all decks, is **55.4%**. The table lists every identity with at least 1% of games.

| Identity | College | Share of games | Win rate | vs baseline |
|---|---|---|---|---|
| WB | Silverquill | 17.2% | 57.7% | +2.3 pp |
| WR | Lorehold | 20.6% | 57.7% | +2.3 pp |
| UG | Quandrix | 9.6% | 55.1% | −0.3 pp |
| WUR | (three colors) | 3.4% | 54.6% | −0.8 pp |
| BG | Witherbloom | 12.6% | 54.5% | −0.9 pp |
| UR | Prismari | 18.8% | 54.4% | −1.0 pp |
| URG | (three colors) | 8.0% | 53.2% | −2.2 pp |
| 3+ colors, other | | 2.7% | 52.9% | −2.5 pp |
| UBG | (three colors) | 4.0% | 52.7% | −2.7 pp |
| WBR | (three colors) | 1.7% | 50.4% | −5.0 pp |
| WBG | (three colors) | 1.0% | 48.2% | −7.2 pp |

## Claims and what the data says

1. **"Multicolor control (Prismari, Quandrix, or Lorehold with converge splashes)" as one of the format's two broad plans** (line 17), and **"Multicolor control (default converge shell)"** (line 107, "often UR or GU base").
   - Prismari (54.4%) and Quandrix (55.1%) sit at or below the baseline.
   - Every three-color identity is below it: WUR 54.6%, URG 53.2%, UBG 52.7%.
   - Lorehold is top (57.7%), but mostly as a two-color deck: only 17.7% of its games had a splash, against 51% for Prismari and 67% for Quandrix.
   - The data supports "aggressive white" as the strongest plan. It does not support multicolor control as its equal.
2. **"Prismari/Quandrix control + converge is a proven high-end strategy when fixing and payoffs show up"** (line 25).
   - On average, UR is 1.0 points below the baseline, UG 0.3 below, and the Temur converge shell (URG) 2.2 below.
   - "When fixing and payoffs show up" may hold for the best versions. Per-deck data can't confirm or rule that out. But "proven high-end" reads as a format-level claim, and the averages don't back it.
   - One point in the text's favor: within UR, decks with 11 or fewer creatures won 55.3%, against 52.3% at 12–13 creatures. "Few creatures on purpose" (lines 19, 107) holds.
3. **"Witherbloom is often the weakest college at crowded tables"** (line 25) and **"BG is often the weakest lane at balanced tables"** (line 126).
   - Witherbloom (54.5%) is level with Prismari (54.4%). It is above every three-color identity.
   - Among two-color pairs, Prismari is the lowest, not Witherbloom.
   - The "crowded tables" qualifier can't be tested with this data. As a general ranking, though, the claim isn't supported.

What the data does support:
- "Lorehold and Silverquill lead" (line 25), and "Lorehold — top-tier" (line 85): 57.7% each, the two best identities.
- "No real Rakdos (BR) lane": BR is under 0.5% of games.

## Why it matters for the benchmark

The Set Context is the headline condition. Agents read it before every draft and build. If it steers them toward Prismari or Quandrix control, it steers them toward lanes that humans win with less often. Agents vs humans comparisons on the SOS set page would then partly measure the context's advice, not the agents' judgment. Either way it is worth knowing. If the text changes, the primer sha256 in `event_start` changes with it. Comparability groups are keyed on the prompts, not the Set Context, so boards don't split.

Recompute: `python3 -c "import json; d=json.load(open('sets/SOS/17lands-archetypes.json')); [print(k, v['games'], v['win_rate']) for k, v in sorted(d['archetypes'].items(), key=lambda kv: -kv[1]['win_rate']) if v['share'] >= 0.01]"`
