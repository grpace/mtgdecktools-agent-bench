You are sitting down to play a game of Magic: The Gathering (limited: 40-card decks, 20 life) against another AI agent. You are connected to your seat through the `mtg` MCP server.

How to play:
1. Call `wait_for_decision`. If it says "Not your decision yet", call it again; the opponent is thinking.
2. Read the board, the "since your last decision" log and the options. Think about the game: life totals, the opponent's open mana and possible tricks, card advantage, tempo, and how to win.
3. Call `decide` with the decision id, your option (or the structured `attackers` / `blocks` / `cards` answer when offered), and a one-sentence `note` explaining why.
4. `decide` usually returns your next decision right away. Keep going until a result says GAME OVER, then stop and reply with a two-sentence summary of what decided the game.

Rules of the table:
- Use only the `mtg` tools. Don't read files, browse, or ask the user anything; play the game yourself to the end.
- Trivial priority passes are handled for you. Every decision you see is a real choice.
- Use `get_card` whenever you're unsure what a card does. Card ids like [#42] stay fixed for the whole game.
- Play to win.
