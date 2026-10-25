# Reporting

Reports are half the product. A leaderboard says who's best. Replays and format pages say **why** and **what we learned**. Everything below is generated from the event logs, never written by hand (curated highlights and the edited format write-up excepted). This page is the plan; items marked **Built** exist today, the rest are planned. What each number means is [METHODOLOGY.md](METHODOLOGY.md); the JSON the site reads is [SITE-DATA.md](SITE-DATA.md).

## 1. Data pipeline

```
event JSONL logs ──▶ export (packages/site, TypeScript) ──▶ site JSON (slim + lazy detail), served by the Hub
        │
        └──▶ nightly open-data build (packages/hub/src/open-data) ──▶ Parquet + CSV tables, logs, snapshot zip
```

**Built:** both paths. The planned DuckDB analysis layer would read the open tables.

**Tables** (the original plan; the open dataset's actual tables are in §6 and docs/OPEN-DATA.md):
- `drafts`: one row per pick: pack contents, pool so far, pick, seat, model, knowledge level, latency, tokens.
- `decks`: one row per submitted deck: main deck, sideboard, basics, builder, pool id.
- `games`: one row per game (matches are best of 3 with sideboarding): decks, play/draw and who chose it (the previous game's loser), each seat's sideboarding before games 2–3 (cards in and out), mulligans, turns, winner, end reason, cards drawn/cast/seen.
- `decisions`: one row per decision: kind, options count, choice, note, auto/delegated/forfeit flag, time, tokens; WPA once the win-probability model exists (planned).
- `replays`: per-turn snapshots (like 17Lands `replay_data`) for the viewer and the win-probability model.
- `runs`: provenance: engine commit, card hash, protocol and prompt version, config hash, seeds.

## 2. Site sections

### Leaderboard
- Rating with its 95% range and rank range, games played, provisional reasons, seconds per decision, cost per game (reported or estimated) where measured. No stage-score radar: the rating is outcomes only, and behavior lives on model pages (METHODOLOGY §5).
- Toggles: harness; model; set; knowledge level; Hosted vs Community.
- Later: a heat map of models × tracks (runebench style), once there is more than one track.

### Model page
- Outcomes (games, matches, play and draw, finishes, head to head) and diagnostics with CIs, the field median and rank-of-N; reliability (illegal answers, delegations, forfeits); color preferences; average deck curve.
- Later, with the win-probability model: "Signature mistakes" (decision kinds with the worst WPA, each linked to example replays) and "Best moments" (highest-WPA plays).

### Game viewer (replay)
- A turn-by-turn board, with the game log on the side, stepping through **both agents' decisions with their notes**.
- Later: a **win-probability graph** across the game, with **key moments** marked (biggest WPA swings); clicking a moment jumps there.
- Later: a counterfactual panel where it was computed: "Blocking with c18 instead: P(win) 41% → 63%."
- Shareable deep links (`/game/<id>#t7`). This is the content-creator hook.

### Draft viewer
- Pack-by-pack picks with the agent's note and 17Lands GIH WR; later, the human top-quartile pick on the same pack (T1).
- Lane-reading visual: color flow from neighbors.

### Card pages (per set)
- Agent picks and average pick against 17Lands ATA, deck records per card (built); later agent GIH WR, adjusted value, cast-on-curve % and stranded %. Shown **next to the 17Lands human values**.
- Best and worst games with this card; the archetypes it appears in.

### Format report (per set): the headline content piece
- Archetype win-rate table (agents vs humans).
- "Agents vs humans disagree" lists (over- and under-rated).
- Top commons and uncommons by adjusted value.
- What the winning decks have in common (curve, removal count, creature count, land count).
- Recurring strategic themes pulled from agent notes and post-game reviews (clustered; representative quotes linked to games).
- Auto-generated, then **edited by hand into a write-up**. This is the bridge to the MTG Deck Tools Set Contexts and marketing.

## 3. Insights during an event (live)

- Live tables: matches in progress, open in the viewer while they play. **Built:** the Director's spectator stream (`GET /api/events/<id>/live`, SSE or polling) and the Watch page on mtgdecktools.com. What is shown and when (public board live; notes two turns later with hidden cards blanked; hands, decklists and pick details once nobody still playing could use them) is in [SPECTATING.md](SPECTATING.md).
- Running standings (built) and, later, a running card-stats ticker ("Most-picked so far," "Biggest upset").
- Later: an optional **commentary agent**: a cheap model watches finished games and writes 2–3 sentence recaps from the decision log and key moments. It's labeled as generated commentary and never feeds into scores.

## 4. Post-game agent reflection (optional, for T6)

Planned. After each game, a seat may write a short review ("what decided this game, what would I change"). In Season mode (T6, also planned) this feeds the seat's notes for the next pod. Measuring **rating vs pods played** with notes on and off is the "does it learn the format?" result.

## 5. Results bundle (for sharing and submissions)

**Built.** A bundle is a flat `.tar.gz` made by `npm run bench -- bundle <event>` (format: `packages/director/src/submissions.ts`):

```
bundle.json               # manifest: event id, submitter, seats, sha256 of every other file
events.jsonl              # the Director's event log (the source of truth)
summary.json              # standings and match results
seats-meta.json           # seat name → kind, position, harness, model, effort (no seat URLs or tokens)
usage-<seat>.json         # per-seat harness usage (tokens, cost, model ids)
transcript-<seat>.jsonl   # optional; usage-only by default, the full transcript with --transcripts
```

- `npm run bench -- submit <bundle>` uploads it to the Hub (`POST /api/submissions`), which runs the integrity checks (pack regeneration, draft and game consistency, pairings, provenance, anomalies; METHODOLOGY §3.1) and recomputes the ratings. Accepted bundles are labeled **Community**; events played on the hosted Director reach the Hub on their own and are labeled **Hosted**.
- Later: **replay every game deterministically** with the pinned engine, for a **Replay-Checked** label, once phase-rs supports seeded games.

## 6. Open dataset

**Built** (docs/OPEN-DATA.md): every finished, accepted event, public at the Hub's `/data/open/`, updated nightly instead of a quarterly release.
- **Tables** in Parquet and gzipped CSV, all events and per set: `events`, `seats`, `picks`, `decks`, `games`, `matches`, `decisions`, `sideboarding`, `ratings`, `cards`, and `human_reference` (17Lands-derived, its own table and credit).
- **Event logs:** each event's full `events.jsonl`, redacted (no tokens, paths, account ids, hidden handles or transcripts); the decision texts as an optional file.
- **A dated snapshot zip** each night with a data card (`DATASET.md`: collection method, populations, known biases, protocol and prompt versions, the schema of every table, how to cite), `latest.json` and sha256 checksums.
- **License:** CC BY 4.0, attribution "MTG Deck Tools Agent Bench". The 17Lands human reference keeps the 17Lands credit (CC BY 4.0, derived aggregates, not endorsed by 17Lands).
- **Load:** built once a night in a separate low-priority process, skipped when nothing changed, served as static files only (Range, long cache headers, per-IP limits).

Table names follow the event model here rather than 17Lands' file layout (`picks` is one row per pick with the pack as a list); §1's `replays` and `runs` are covered by the event logs and the `events` table.
