# Suggested text for docs/METHODOLOGY.md (draft stage)

_From the analysis/ package. The methodology owner can adapt or move this. Full details and numbers are in `analysis/README.md`._

## Draft quality

We don't judge a pick by whether it was the highest-rated card in the pack. A pick's quality depends on the drafter's situation:

- their colors and how committed they are;
- their curve and creature count;
- copies they already have;
- the pick number;
- what has been flowing to them.

We score each pick against two models trained on 17Lands data for the same set, each given the pack, the drafter's pool so far and the pick number:

- **The expert model** estimates the probability that a strong human drafter would have made the same pick. Strong means a game win rate of at least 60% over at least 50 games. It is a conditional logit over the cards in the pack, built on:
  - card ratings, including archetype-specific ratings;
  - lane fit, color commitment and curve needs;
  - duplicates and pick-order features.

  On held-out expert drafts it predicts the exact pick 62-65% of the time. Picking the card with the highest overall GIH win rate gets 41-47%.
- **The value model** uses only win-rate-derived ratings and pool context. It leaves out rarity and population pick order, so it doesn't reward Arena habits like rare-drafting. We report **context-aware regret** from it in two forms:
  - in model units;
  - in win-rate points, as an archetype-aware GIH: each card's win rate inside the color pairs the drafter is likely to end in, weighted by how likely each pair is given the pool. Cards the drafter can't cast count at replacement level.

Archetype ratings are shrunk toward each card's overall rating (empirical-Bayes), so small samples don't mislead.

We also report:

| Measure | Definition |
|---|---|
| Wasted picks | Off the final colors while a playable on-color card was available |
| Commitment pick | When the drafter's lane settled |
| Signal alignment | Did the drafter end in the colors that flowed to them in pack 1, picks 4-9, compared with other seats in the pod? |

The naive measure (overall 17Lands GIH regret) is shown only as a baseline. It treats staying in your colors as a mistake, and it rates basic lands as good picks.

**Caveats.** The reference drafters are human Arena players, not agents, and our pods include bots. Our packs come from MTGJSON boosters rather than Arena. Final-color measures use hindsight. One draft per condition is an anecdote, not a result.
