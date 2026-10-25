# Spectating Live Events

Live events are not rated while they run ([METHODOLOGY.md](METHODOLOGY.md)), but they should be watchable: the draft, the decks and the games, with the agents' reasoning. The Director serves a read-only live view of every event, and mtgdecktools.com renders it on the Watch page (`/agent-bench/watch/<id>/live`).

The catch is fairness. Anyone can watch a public event: the person running one of the seats, or an agent with web tools that finds the server it is playing on. Whatever the stream shows, one agent could be fed. So the stream is built around one rule:

> **A viewer only sees what no seat still competing could use.** Public information is live. Reasoning is delayed and stripped of hidden cards. Private information waits until nobody who could benefit from it is still playing.

The policy is implemented once (`packages/director/src/spectate-policy.ts`) and applied twice: to the live stream (`spectate.ts`) and to the report export of any event still in progress (`packages/site/src/live-redact.ts`). The hosted export refreshes every two minutes while events run; without the second application it would publish hands, notes and every pick as they happen.

## What Is Shown, and When

| Information | Default release | Why |
|---|---|---|
| Event setup, seat names, stage | live | Public. Seat names are neutral (`seat-<hex>`) at every table, never a model. |
| Game results, match results, standings, a seat being done | after the broadcast delay | Public, but released with the delayed boards: a result never reaches viewers before the game's last turn does. |
| **Who plays each seat** (harness, model) | when **the seat has no games left** (the `release` message for the seat carries them; `hello.seats` adds them) | An agent with web tools could otherwise find its own table and learn its opponents' models. |
| **Game boards**: battlefields (tapped, counters, P/T), graveyards, exile, stack, combat, life, poison, hand and library *sizes* | after the broadcast delay (default 90 s) | Both players see all of this already. Built from one seat's state, reading only public zones; face-down cards are shown face down. |
| **Game log** (casts, attacks, damage, "draws a card") | after the broadcast delay | phase-rs never logs concealed moves, so the log is identical for both players. |
| **Who is on the clock** (open decision, its broad kind, how long) | after the broadcast delay | See "Residual leaks". |
| **Game decisions: choice and note** | when the game reaches **turn t+2** (t = the decision's turn), or the game ends, plus the broadcast delay (a note never reaches viewers before the board of the turn that released it) | Long enough that a note about this turn's plan is history, short enough to follow the reasoning while watching. Turn-based rather than seconds-based: agents take 2 s or 60 s per decision, so a fixed time delay would be meaningless for one and too long for the other. |
| …card names in them | blanked ("[hidden card]") until the hidden release, unless the card has been seen in a public zone | A note like "holding Shock for their flyer" would hand the opponent the contents of a hand. |
| …choices about hidden cards (bottoming after a mulligan, scry, surveil, library search) | withheld whole until the hidden release | The card may be a basic land, whose name is public, so blanking names isn't enough. |
| **Hidden information**: what each agent saw (its hand), unredacted notes and choices | when **the seat has no games left** in the event | The hands of game 1 reveal much of the deck for games 2 and 3 (sideboarding changes only a few cards), and for that seat's later matches. |
| **Decklists and deck notes** | when the seat has no games left; until then, the cards it has shown in play | Same reason. |
| **Between games: who is deciding** ("Sideboarding…", "Choosing play or draw…") | after the broadcast delay | `seat_status` with `stage: "sideboard"`, `kind: "sideboard"` or `"play_draw"`. |
| **Play or draw** (who plays first, who chose, play or draw) | after the broadcast delay; the chooser's note when the chooser has no games left | Who is on the play is public once the game starts. The note is reasoning about the deck. |
| **Sideboarding: that a seat sideboarded, and its deck size** | after the broadcast delay | Public at the table: the opponent can count the deck. |
| **Sideboarding: what went in and out, and the note** | with the decklist: when the seat has no games left, and never before the broadcast delay | What a seat brought in tells this match's opponent (in game 3) and later opponents what the deck and sideboard hold. We chose this over releasing the swaps after the delay alone: a game takes longer than 90 s, so a viewer could pass the swaps to the opponent before the next game. |
| **Draft picks** (the card, the pack it came from, the drafter's note), and the round's pack swaps | when **every pack of that round is empty** | A pack's contents describe what downstream seats are about to be passed. Once the round is over, no pack it describes can still be picked from. Live, the board shows who has picked and how long they took, not what. |
| The event seed | when the event is over | The seed regenerates every pack. Default seeds carry 32 random bits so they can't be brute-forced from a released round. |
| `report_rules_issue` reports | like decisions (delayed, card names blanked) | They are agent notes. |
| Unimplemented-effect flags | live | The effect resolved on the stack in public. |

### Residual Leaks (Accepted, Documented)

- **Earlier draft rounds during later ones, and pools during games.** With the default `round` release, pack 1 is public during packs 2 and 3, and every pool is public during deckbuilding and the games. That is the price of a watchable draft. It mostly reveals what good drafters infer from signals anyway, but it is more than a real draft table gives. Strict operators: `SPECTATE_DRAFT=draft` (picks after the draft) or `seat` (an agent's picks once it has no games left; bots after the draft).
- **Plans in released notes.** A note released two turns later can still describe a plan that hasn't happened ("keeping a trick up"). Hidden card names are blanked, the gist isn't. Strict: `SPECTATE_NOTES=game` or `seat`.
- **The clock.** The Director only stops a seat for priority when it has something it could do, so "X has priority on the opponent's turn" says X has a playable instant or ability. Arena's opponent timer leaks the same, and agents never see this signal in-game. A broadcast delay (`SPECTATE_DELAY_S`) pushes every live game message back by that many seconds.
- **Identities.** Seat names are neutral (`seat-<hex>`) at every table: the lobby, Private Tables (`bench new`, `bench setup`, and the create-event API for contributors and admins alike, which replaces any other name) and one-shot `--agents` events. A seat's harness and model are released when it has no games left, and the anonymous status endpoints (`/api/events/<id>`, `/api/lobby` `recent[]`) don't show models, per-seat live states or standings of a running event. Agents are never told their opponent's identity in-game.
- **Face-down cards.** The per-turn `turn_snapshot` log record is one seat's projection; logs written before 2026-10-22 name that seat's own face-down permanents in it. Snapshots never make a card name public, and their stream frames (used only when there is no live board, e.g. a log replayed from disk) wait until the game's hidden information is released.
- **Reused seeds.** Ablations deliberately reuse seeds, so their packs are identical. Anyone who saw an earlier event with the same seed knows the packs of the later one. Run such events with `SPECTATE=admin` or `SPECTATE_DRAFT=draft`.

None of this replaces the integrity rules in METHODOLOGY §3.1: a contributor who wants to cheat can already put a human in a seat. The policy keeps the stream from becoming an easy side channel, especially for agents with web access.

## Configuration (Environment)

| Variable | Values (default first) | Effect |
|---|---|---|
| `SPECTATE` | `public`, `admin`, `off` | `admin` needs the admin token or `SPECTATE_TOKEN` in `Authorization: Bearer`, or `SPECTATE_TOKEN` as `?token=` (EventSource can't send headers; the admin token is never accepted in a URL); `off` answers 404. With `admin` or `off`, running events are also left out of the public `/data` export until they finish. |
| `SPECTATE_DRAFT` | `round`, `draft`, `seat` | Draft release (above). |
| `SPECTATE_NOTES` | `2` (turns), any number ≥ 1, `game`, `seat` | Decision choice/note release. |
| `SPECTATE_HIDDEN` | `seat`, `game` | Hidden information release. `game` releases at each game's end (weaker). |
| `SPECTATE_DELAY_S` | `90` | Broadcast delay for live game information (boards, log, clock, game results) and for turn-based note releases. `0` turns it off (local runs); the hosted stack sets 90. |
| `SPECTATE_MAX_PER_IP`, `SPECTATE_MAX_PER_EVENT`, `SPECTATE_MAX_TOTAL` | `4`, `200`, `1000` | Concurrent streams; beyond them a 429 (clients fall back to polling). |
| `SPECTATE_POLLS_PER_MIN` | `60` | JSON polls per IP per minute. |
| `SPECTATE_TOKEN` | unset | A read-only token for `SPECTATE=admin` viewers. |
| `TRUST_PROXY` | unset | `1`: take the client IP from the last `X-Forwarded-For` hop (behind Traefik). |
| `TRUST_PROXY_HOPS` | `1` | Proxies in front of the Director (a CDN in front of Traefik: `2`). IPv6 clients are limited per /64. |

Unknown values fall back to the default. The same variables reach the report export, which the Director runs as a child process with its environment.

## Protocol (Version 1)

`GET /api/events/<id>/live` (also served by a one-shot `npm run director`, for local testing)

- **Server-Sent Events** when the request accepts `text/event-stream` (or `?stream=1`). First `event: hello` (below), then every released message as `id: <seq>` + `data: <json>`, then `event: live` once the backlog is sent. Resume with `Last-Event-ID` (EventSource does it) or `?since=<seq>`. A finished event sends `event: over` after the backlog and closes; the client should stop reconnecting. A `: hb` comment every 15 s keeps proxies from timing out; streams are recycled after 8 minutes (reconnect with `Last-Event-ID`); a reader more than 1 MiB behind is dropped and catches up on reconnect.
- **Epochs.** `hello.epoch` names this numbering of the stream. Send it back as `?epoch=` when resuming: if the Director restarted (or the cursor is ahead of the stream), the server starts again from 0 and the client should discard what it had.
- **JSON polling** otherwise: `?since=<seq>` returns `{ hello, seq, messages, more, poll_ms }`, at most 1,500 messages per call (`more: true`: ask again at once).
- Events not running in this process (finished, or orphaned by a restart) are replayed from `events.jsonl` with everything released.
- CORS: `Access-Control-Allow-Origin: *`.

`hello`: `{ protocol: 1, epoch, server_time, seq, event: { id, stage, over, set, best_of, mana, knowledge, started_at, pod_size, seats[], agents[], seed? }, policy: { draft, notes, hidden, delay_s, text } }`. `policy.text` is the plain-language summary pages show to viewers.

Every message has `seq` (increasing; the order of release) and `t` (when it *happened*: a released note is older than its seq suggests). Messages with the same supersede key replace each other in the backlog, so a reconnect gets the latest state, not every intermediate one.

| type | fields | supersedes |
|---|---|---|
| `stage` | `stage` (`draft`, `build`, `games`, `done`) | previous stage |
| `seat_status` | `seat`, `state` (`thinking`, `waiting`, `done`), `stage` (`draft`, `build`, `sideboard`, `game`), `game?`, `kind?` (`priority`, `attack`, `block`, `mulligan`, `pay`, `target`, `choice`, `pick`, `deck`, `sideboard`, `play_draw`), `turn?`, `pack?`, `pick?`, `since?` | the seat's previous status |
| `draft_round` | `round`, `pack_size`, `packs` | |
| `draft_progress` | `seat`, `pack`, `pick`, `overall`, `by`, `latency_ms` (no card) | |
| `draft_pick` | `seat`, `pack`, `pick`, `overall`, `card`, `contents[{name, rarity}]`, `by`, `note?`, `latency_ms?` | its `draft_progress` |
| `swaps` | `round`, `swaps[{from, to}]` | |
| `release` | `what` (`draft_round`, `draft`, `seat`), `round?`, `seat?` | |
| `deck_submitted` | `seat`, `by`, `main_count`, `latency_ms` | |
| `deck` | `seat`, `by`, `main[]`, `sideboard[]`, `note?` | its `deck_submitted` |
| `play_draw` | `match`, `game_number`, `on_play`, `chooser`, `choice`, `by` (`seed`, `agent`, `forfeit`); later `note`, `full: true` | the public version |
| `sideboarded` | `seat`, `match`, `game_number`, `main_count`; once released also `by`, `kept`, `in[{name, qty}]`, `out[{name, qty}]`, `note?`, `latency_ms`, `full: true` | the public version |
| `game_start` | `game`, `index`, `match`, `game_number`, `seats[2]` | |
| `board` | `game`, `turn`, `phase`, `active`, `priority`, `players{seat: {life, poison?, hand, library, graveyard[], exile[], battlefield[]}}`, `stack[]`, `combat[]` (at most 4 per second per game) | the game's previous board |
| `snapshot` | `game`, `turn`, `active`, `players` (turn summaries, for replays from a log) | the game's previous board |
| `life` | `game`, `turn`, `life{seat: n}` | that turn's earlier value |
| `log` | `game`, `lines[{turn, phase, text}]` | |
| `decision` | `game`, `seat`, `id`, `kind`, `kind_label`, `turn`, `choice`, `note?`, `card?`, `latency_ms`, `accepted`, `structured`, `redacted`, `full` | the redacted version, when the full one is released |
| `flag` | `kind` (`unimplemented_effect`, `rules_issue`), `game`, `seat`, `card`, `turn`, `note?`, `full?` | |
| `game_over` | `game`, `winner`, `turns`, `end_reason`, `final_life`, `on_play`, `mulligans` | |
| `match_end`, `standings`, `notice` | | `standings`: previous |
| `withheld` | `picks`, `decisions`, `decks`, `flags` (how much is held back right now, at most once a second) | previous |
| `event_end` | `aborted`, `standings` | |

## Testing

- `npm test -w @mtgdt/director` runs the fairness tests (`spectate.test.ts`): no pick before its round ends, no decklist while the seat plays, notes after two turns with hidden cards blanked, hidden-zone choices withheld whole, strict draft mode, broadcast delay.
- A scripted event slow enough to watch: `AGENT_DELAY_MS=700 AGENT_REPORT_RATE=0.03 node scripts/mcp-random-agent.mjs <seat-url>` for each seat of a one-shot Director; then `curl -N -H 'Accept: text/event-stream' http://127.0.0.1:<port>/api/events/<id>/live`.
- The Watch page takes `?transport=poll` to force polling (headless screenshots: an open stream keeps Chromium's virtual-time budget from running out).
