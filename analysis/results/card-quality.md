# Card-quality heuristic vs human win rates

The card-quality heuristic (`cardQuality` in `packages/director/src/ratings.ts`, version `cq-1`, METHODOLOGY §5.1) values cards from card data alone. It weighs passed cards for the color-flow metric, makes fallback picks for a seat the inactivity watchdog settles, and builds reference decks in sets without human data. This page checks how well it orders cards compared with 17Lands games-in-hand win rates (GIH WR), in the 9 sets that have them.

Regenerate: `npx tsx packages/director/src/ratings.test.ts --validate` (needs `data/card-data.slim.json` and `data/draft-pools.json`). Cards with a GIH WR (at least 200 games in hand), basics excluded; rarity from the booster sheets.

| Set | Cards | Heuristic ρ | Rarity alone ρ |
|---|---|---|---|
| ECL | 278 | 0.40 | 0.35 |
| EOE | 300 | 0.25 | 0.09 |
| FIN | 352 | 0.34 | 0.13 |
| FRA | 279 | 0.35 | 0.27 |
| HOB | 185 | 0.19 | 0.08 |
| MSH | 295 | 0.36 | 0.32 |
| SOS | 328 | 0.26 | 0.18 |
| TLA | 299 | 0.32 | 0.28 |
| TMT | 195 | 0.34 | 0.30 |

ρ is the Spearman rank correlation with GIH WR. "Rarity alone" is the rarity prior the bots used for every set before `cq-1`.

**Reading it.**
- The heuristic orders cards better than rarity alone in every set, and never worse. It is still a rough guide: it reads rules text with patterns, so synergies, set mechanics and context are invisible to it.
- The weights were set by inspection on these same 9 sets (what kinds of card sit above or below the set average), so this is not a held-out test. The weights are few and generic (rarity, stats for the cost, keywords, removal, card draw, color requirements), which limits overfitting.
- What it learned from the data: removal and sweepers sit well above average; two-color cards are above average (they are played in their own pair); colorless cards and non-creature cards without interaction or card draw sit below; big creatures are not worse than mid-sized ones; mythics are well above everything else.
- Non-basic lands are valued below playable spells on purpose (0.48–0.49: a deck gets its basics anyway, so a land is rarely the right pick or the 23rd card). Human GIH WR puts them near the set average, so this costs about 0.01 of ρ.
- Nothing that ranks agents depends on how well this tracks human win rates: the core draft metrics use it only to decide which passed cards were worth taking (color flow).
