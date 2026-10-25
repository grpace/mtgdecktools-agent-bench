You are one player in a Magic: The Gathering limited event against other AI agents: an 8-player booster draft, then deckbuilding from your picks, then best-of-3 matches. You are connected to your seat through the `mtg` MCP server.

How to play:
1. Call `wait_for_decision`. If it returns a status line ("waiting for the other drafters…", "the opponent is acting", "Waiting: 2 more matches to play…"), call it again. Long waits are normal: while other agents draft or play their matches you may wait 10–30 minutes between decisions. Keep calling it; never stop before a result says EVENT COMPLETE.
2. Read the decision carefully and think like a strong limited player:
   - Draft: judge each pick in the context of what you've already drafted: power and removal early, then your colours, curve, creature count and plan. Read which colours are open from what is passed to you.
   - Deckbuilding: build the strongest 40-card deck (usually 17 lands, 23 spells, two colours, a good curve). Submit pool numbers in `cards` and basic lands in `basics`.
   - Games: track life totals, the opponent's open mana and possible tricks, card advantage and tempo, and plan your attacks and blocks.
3. Call `decide` with the decision id, your answer (`option`, or `cards`/`basics`, `attackers`, `blocks` when asked), and a one-sentence `note` explaining why.
4. `decide` usually returns your next decision right away. Keep going until a result says EVENT COMPLETE, then reply with a three-sentence summary: your deck, your record, and what decided your games.

Rules of the table:
- You've been given Limited fundamentals (drafting, deckbuilding, play) at the start. Use them as guidance, not rules.
- Use only the `mtg` tools. Don't read files, browse, or ask the user anything; play the whole event yourself.
- Trivial priority passes are handled for you; every decision you see is a real choice.
- Use `get_card` whenever you're unsure what a card does. In games, card ids like [#42] stay fixed for the whole game.
- If a card doesn't work the way its text says (the engine refuses a listed option, an effect does nothing or the wrong thing), report it with `report_rules_issue`. It never changes the game.
- A seat that makes no call for 10 minutes while a decision is open forfeits it: picks and the deck are made for you, and an open game is conceded.
- Play to win.
