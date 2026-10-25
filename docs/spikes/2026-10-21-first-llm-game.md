# First LLM vs LLM game (2026-10-21)

**Setup:** phase-server v0.115.0 (build `6485512`, protocol 159), Director at commit `5435a2e`. Two headless Claude Code sessions on the owner's own Claude login (no API keys), each connected to its own seat MCP URL using `prompts/archive/v1/join.md`.

| Seat | Harness / model | Deck |
|---|---|---|
| A | Claude Code / sonnet | `decks/fra-wu.txt` (W/U, generated from cards phase-rs supports) |
| B | Claude Code / haiku | `decks/fra-br.txt` (B/R) |

## Result

**Haiku won on turn 19 (8 life to 4).** Total wall time ≈ 5 minutes.

| | Sonnet (A) | Haiku (B) |
|---|---|---|
| Agent decisions | 43 | 41 (+1 forced) |
| Auto-passed priority stops | 194 | 195 |
| Median time per decision | 1.9 s | 1.9 s (max 30 s) |
| Illegal or rejected answers | 0 | 0 |
| Harness turns (tool calls) | 74 | 58 |
| Thinking tokens | 5.7k | 19.3k |
| Output tokens | 11.9k | 25.6k |
| Notional cost reported by `claude -p` | $0.64 | $0.06 |

## Observations

- **The loop works.** Mulligans, attacks and blocks (structured), targets, modes, surveil, top/bottom and trigger ordering all came up and were answered with no rejections.
- **Haiku's play was coherent and planned.** It held removal until the opponent was tapped out, made Tetsuko unblockable for exact lethal, and removed the lone untapped blocker before an all-in attack.
- **Sonnet played fast and thin.** Many notes were a single word ("Land.", "Pass."), and it thought about a third as much as Haiku. Its own summary names its mistakes: it traded away Thalia and Proft early and had no answer to an unblockable double striker. **Effort and thinking settings clearly matter**, so a leaderboard entry must record them (harness + model + effort).
- **One game is noise.** The decks are auto-generated and not equal in strength, and each side played only one game. Nothing here ranks the models. It shows the pipeline produces readable, scoreable play.
- **Smart stops work.** About 82% of priority stops were auto-passed. Agents still had to pass explicitly to move from the main phase to combat, which is correct (it's a real decision point).

## Next

- Duplicate format (swap decks, same seed) once the fork supports settable seeds.
- Record harness effort settings in the event log; collect `claude -p` usage automatically per seat.
- Run Codex as the second harness (not installed on this machine yet).
