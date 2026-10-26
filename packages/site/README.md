# @mtgdt/site: Report Site

A static site generator for the benchmark's event logs. Plain TypeScript run with `tsx`, emitting HTML, one CSS file and a small vanilla-JS file. No framework and no CDN. The only network requests the pages make are card images, which load from Scryfall on hover.

## Build and Serve

```bash
npm install                                   # once, at the repo root
npm run site                                  # reads runs/ + sets/ and writes packages/site/dist/
python3 -m http.server -d packages/site/dist  # then open http://localhost:8000
```

Options (all optional; paths default to the repo root):

```bash
npm run site -- --runs <dir> --sets <dir> --cards <card-data.slim.json> --out <dir>
```

- `--runs`: event directories (`runs/<id>/events.jsonl`, plus `summary.json`, `seats.json` and `transcript-<seat>.jsonl` when present). A directory counts as an event only when its `events.jsonl` starts with `event_start`. Older single-game spikes (`match_start`) appear in a small "legacy" list.
- `--sets`: `sets/<SET>/17lands.json` (the human baseline).
- `--cards`: the Director's `data/card-data.slim.json` (mana costs, types and colors). Without it, decks aren't grouped by type and curves and colors are missing. Everything else still works.

The output uses only relative links, so `dist/` can be deployed to any static host. Rebuild any time: events that are still running show as **in progress**, with standings computed from the games finished so far. An event with no new log lines for 30 minutes and no `event_end` shows as **incomplete**.

`npm run typecheck -w @mtgdt/site` type-checks the generator.

## JSON Data Export

```bash
npm run site:data      # same inputs and options as `npm run site`; writes packages/site/dist-data/
```

Writes lazy-loadable JSON for client apps (the mtgdecktools.com/agent-bench pages): `index.json`, `summary.json`, `events/<id>.json`, `events/<id>/draft-<seat>.json`, `events/<id>/game-<n>.json`, `sets/<SET>.json`, `models/<model_id>.json`, `highlights.json` and `methodology.md`. The schema is versioned (`schema_version: 2`, `schema_minor` from `SCHEMA_MINOR`; 2.23 at this writing) and documented in [docs/SITE-DATA.md](../../docs/SITE-DATA.md); the TypeScript types live in `src/schema.ts`. Both renderers share `data.ts`, `metrics.ts` and `replay-data.ts`, so the HTML report and the JSON always agree.

## Pages

| Path | What it shows |
|---|---|
| `index.html` | Pitch, raw scoreboard by model (from the seat metadata; not the rating), events list, smoke tests and legacy runs |
| `events/<id>/index.html` | Standings, matches and games, each agent's deck (by type, with curve), draft quality for all 8 seats, cost and usage from transcripts, card swaps |
| `events/<id>/draft-<seat>.html` | Pick-by-pick draft viewer: pack contents with 17Lands GIH WR and ATA, the pick, the 17Lands-best card, agreement and regret |
| `events/<id>/game-<n>.html` | Game replay: both seats' decisions in time order with choice and latency; the full text the agent saw (collapsible); life-total chart |
| `sets/<SET>.html` | Card table: agent picks, agent pick position vs 17Lands ATA, GIH WR, IWD, win rate of agent decks running the card |
| `about.html` | Method summary and how to seat your own agent |

## Layout

```
src/build.ts        HTML entry point: write pages, copy assets
src/build-data.ts   JSON entry point (npm run site:data)
src/context.ts      shared args and loading for both entry points
src/data.ts         events.jsonl / transcript / 17Lands / card-data loading and normalization
src/metrics.ts      draft agreement and regret, deck summaries and colors, set card stats, play stats, leaderboard rows
src/replay-data.ts  game derivations: sides, life series, active player, decision status, view splitting
src/export.ts       writes the JSON tree (full, or the files one event touches)
src/json.ts         JSON builders (one per output file type)
src/schema.ts       JSON schema types (schema_version 2, SCHEMA_MINOR)
src/scoring.ts      identities, comparability groups, Early Test Data, boards and diagnostics
src/rating.ts       Bradley-Terry ratings, bootstrap intervals, rank ranges
src/diagnostics.ts  headline diagnostics with field medians (descriptive, never ranked)
src/outcomes.ts     records, play/draw splits, Swiss finishes
src/models.ts       model files, activity, set summaries
src/summary.ts      generated board and model summaries
src/cost.ts         reported and estimated cost
src/highlights.ts   curated and automatic highlights
src/live-redact.ts  spectator fairness policy for events still running
src/html.ts         escaping, page layout (header, footer, tooltip data), tables, chips
src/charts.ts       inline SVG: mana curve, life totals, pick-vs-best strip
src/pages/*.ts      one module per page type
assets/style.css    the one stylesheet (dark first, light theme, toggle persisted in localStorage)
assets/site.js      sorting, filtering, theme toggle, card-image tooltips, replay/draft filters
```

Card data © Wizards of the Coast. The human reference (17Lands GIH WR, ATA and archetype data) comes from the 17Lands public datasets (CC BY 4.0). The footer of every page carries the WotC Fan Content Policy notice.
