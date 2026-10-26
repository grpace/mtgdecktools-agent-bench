# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html) for the repository as a whole (the packages under `packages/` share its version). See [docs/RELEASING.md](docs/RELEASING.md) for what counts as a breaking change here.

Comparability is versioned separately and doesn't follow the release version: the seat protocol (`docs/PROTOCOL.md`), the prompts (`prompts/`, the released copy in `prompts/archive/v9/`, identified by content hash), the bundle format (`bundle_version`), the export schema (`docs/SITE-DATA.md`), the Swiss pairing (`pairing_version`) and the booster generator (`BOOSTER_GENERATOR`) each carry their own version. Results record all of them.

## [Unreleased]

### Changed

- **Seats answer with their choice only.** The `decide` tool takes each decision's choice; deckbuilding takes the cards, basics, total count, deck name and archetype. A rules-issue report keeps its note. Every public output carries choices only: the JSON export (schema 2.24: no `note` on picks, decks, decisions, play/draw or sideboarding; highlights are moments with their situation), the open data (schema 3: no note columns; event logs carry free text only on rules reports), the Hub index (migration 010), the spectator policy and moderation (deck names, archetypes, rules reports and handles).
- **Draft clocks.** Each draft pick has a 75-second clock (`DRAFT_PICK_MS`): past it the bot policy picks for the seat (a `forfeit` with reason `pick_clock`) and the seat keeps drafting. If any seat hasn't made pack 1 pick 1 within 3 minutes (`FIRST_PICK_MS`), the event stops as `draft_stalled`, naming the seats (`abort_detail` on the status endpoint, `bench status` and `bench play`; `event_abort.detail` in the log; `reason` and `detail` on the live stream's `event_end`). Draft `seat_status` messages carry `limit_ms`; `event_start` logs `draft_pick_ms` and `first_pick_ms`. A pick made past the clock doesn't count against a seat's reliability. Seat protocol 0.4. The seat prompts are set v9, a new comparability group (they also tell seats about the pick clock). When a seat's harness keeps failing, `bench play` prints the harness's last error.
- **One prompt set.** Pre-launch prompt folders v1–v8 are not in the repo. Seats read `prompts/`; `prompts/archive/v9/` is that same set.
- **Weekly dependency check.** A phase-rs candidate that never becomes healthy or fails its smoke event no longer fails the Dependencies workflow. The pin stays and no pull request is opened. A failure of the check itself still fails the run.
- **Public repository.** Deploy and ops scripts no longer name a private host, a dev domain, or a home-directory path. Set `SSH_HOST` (and `DOMAIN` / `HUB_DOMAIN` for a dev or test instance). The public hosts stay bench.mtgdecktools.com and bench-data.mtgdecktools.com.

### Fixed

- A rules report stored in a run folder is cleaned the same way Postgres stores text: NUL bytes are removed and a lone surrogate becomes U+FFFD. Invisible characters were already removed.
- A deploy rewrites only that instance's ops-check cron line. The Hub dump check looks at that instance's database. The volume-backup check reads `BACKUP_DIR` and is skipped when it is unset. An unset `OPS_DIR` or `BACKUP_DIR` is passed through as `-`, because an empty argument would be dropped on the way to the host and the next value would shift into its place.

## [0.1.0] - 2026-10-25

The first public release: the benchmark as it runs on mtgdecktools.com at launch. Versions at this release: seat protocol 0.3, prompts v8, export schema 2.23, open data schema 2, bundle version 1, pairing version 4, `boosters-v2`, phase-rs 0.117.0 (engine protocol 171).

### Added

- **Director** (`packages/director`): runs tables on the phase-rs rules engine (the unmodified upstream `phase-server` image, pinned by digest) and gives every seat its own MCP endpoint.
  - **Tables of 8 agents:** a booster draft of any set with phase-rs booster data, 40-card deckbuilding, then a 3-round Swiss of best-of-3 matches with sideboarding (the loser of a game chooses to play or draw). No bots draft or play at a rated table.
  - **Decisions as text:** every decision is readable text with labeled legal options, including manual mana payment, alternative and optional costs, structured attacks and blocks.
  - **Knowledge levels:** No Set Context, Set Context (the MTG Deck Tools guide to the set) and Set Context + Human Stats (17Lands public-data win rates). Every seat also gets the Limited fundamentals and the MTG Deck Tools deckbuilding guide.
  - **Fresh sessions:** match memory (the opponent's cards seen earlier in the match) and a resume briefing let `bench play` start a fresh harness session for every game.
  - **Card handling:** cards the engine can't run are swapped out of packs and every swap is published; card overrides fix featured cards on top of the pinned data (`docs/CARD-OVERRIDES.md`); engine issues and agents' `report_rules_issue` reports flag the games they may have touched.
  - **Reliability:** an inactivity watchdog, durable events that resume across restarts and engine upgrades, and voided games replayed rather than scored.
  - **Spectating:** a live view of every table under a fairness policy (`docs/SPECTATING.md`).
- **Matchmaking Lobby** (`docs/LOBBY.md`): queues per set and conditions, ready checks with backfill, a per-person seat cap, reliability-based priority, scheduled tables, and filling that keeps tables mixed so most of their games are rated.
- **`bench` CLI** (`scripts/bench`, run from a clone of this repository): guided `setup` (also driven by a coding agent through the setup prompt), a preflight of every harness, a Confirmation of what the leaderboard will record, Keep Playing, and headless seats for Claude Code, Codex CLI, Gemini CLI, OpenCode and Cursor CLI, with seats by hand in any MCP client (`docs/HARNESSES.md`). Self-hosting with `npm run up`, results bundles and `submit`.
- **Hub** (`packages/hub`): GitHub sign-in and contributor tokens, terms acceptance, integrity checks on every result (pack regeneration from the seed, draft and game consistency, pairings, provenance, anomalies), a review queue, moderation and erasure, contributor points and the Contributors Leaderboard, the JSON export the site reads, and the nightly open dataset (`docs/OPEN-DATA.md`, CC BY 4.0).
- **Ratings and reports** (`packages/site`): outcomes-only ratings of each model at an effort level from games between different setups, with ranges and provisional labels; Effort Ladders; diagnostics of how agents draft, build and play; set findings compared with 17Lands human data; replays and highlights (`docs/METHODOLOGY.md`, `docs/SITE-DATA.md`).
- **Registry** (`registry/`): canonical model, harness, launcher and effort names, with prices.
- **Analysis** (`analysis/`): the 17Lands human-reference layer (archetype ratings, an expert pick model, build-quality validation) and the rating calibration.
- **Operations:** git-based deploys through Coolify, local and GitHub CI, monitoring with an external uptime check, backups and runbooks (`docs/OPERATIONS.md`, `docs/RELEASING.md`).
- **Security:** a threat model and the controls for seats, the Director, the Hub and public text, with regression tests (`docs/SECURITY.md`).

### Launch-Day Fixes

#### Added

- **Agents are told which of the set's cards the packs can't contain.** At the Set Context levels, part 1 of the Set Context starts with one line from the Director: "Not in this event's packs (the rules engine can't run them yet), even where the Set Context below mentions them: …", built from the event's own unsupported-card list after card overrides (`BoosterFactory.swappedOut`). The guide text itself is unchanged, and the seat prompts are unchanged (no new comparability group). Lobby queues list the same cards (`not_in_packs` in `GET /api/lobby`; `bench lobby list` prints them).
- **`bench setup --dry-run` works signed out:** for a hosted Private Table or a lobby join it runs every local check and shows the whole Confirmation, then says "Sign in to create this table: `bench login`". No terms acceptance or GitHub sign-in is needed to see what would run.
- **Harness support is said up front.** `bench check`, the seats question and `--help` name Claude Code, Cursor CLI and OpenCode as tested on real tables and Codex CLI and Gemini CLI as supported but untested; the Confirmation warns on each untested seat. The registry marks OpenCode and Cursor CLI `tested`.
- `docs/SECURITY.md` lists what the kit writes on your machine.

- **Three more FRA cards play as printed** (docs/CARD-OVERRIDES.md "Featured Sets", "Engine Gaps: FRA"): card overrides on phase-rs 0.117.0 for Jace's Machinations (the unparsed permission stopped the whole spell; now instant-speed loyalty activations for your Jaces this turn, then empower Jace 8), Hall of Echoes (the legend-rule exemption was unparsed) and Theorist's Sanctum (the optional behold was dropped, so it always entered tapped). Each is tested in scripted games (the bug on upstream data, the printed behavior with the override) and has an upstream report draft. FRA swaps per 24-pack draft: 7.09 (11 cards) → 5.82 (8). Machinations and Hall carry an inert `MayLookAtFaceDown` modification that keeps their this-turn grant live for objects arriving later (CR 611.2c; tested both ways). The one difference left: a "loses all abilities" effect that starts later that turn removes the grant. That can't happen to a Jace in FRA; for Hall it takes two same-named legends you control each losing all abilities that turn. The other FRA cards were re-checked on the 0.117.0 source: Way of the Mind Sculptor, Sanctum Lurker, Loot, Ruric Thar, Command the Stage, Extrapolate the Impossible and Uldaros Theorix still need engine code, and Molten Tide waits on PR #9791. Engine patches 0001 (Way) and 0003 (Lurker) still apply to 0.117.0 and pass their tests after a test-file API update; nothing patched is built or deployed. phase-rs v0.118.0 is tagged (no release data yet): it fixes none of these, and it carries Recursive Recruitment's fix.

#### Changed

- **One way to run the CLI, from any folder:** the docs use `npm --prefix ~/mtgdt-bench run -s bench -- <command>` (`bench <command>` for short). `bench stop` with no id stops the one loop or event running from this machine, or says what to run; `validate` and `submit` find a bundle in the events folder as `bundle` prints its path.
- **Setup refuses a model its harness can't run** ("Claude Code / GPT-6 Astra"), with the harnesses that can. Examples use tested harnesses.
- **"Start the event? [y/N]":** only an explicit yes starts a table (Enter alone no longer does).
- **The setup prompt** shows real git errors in its update step (no `2>/dev/null`, no clone after a failed pull), states macOS and Linux (WSL on Windows), takes "defaults" for recommended answers (never the seats or the terms), and says the sign-in comes after the questions and needs a GitHub account at least 30 days old. README and COMMUNITY.md match.
- **Docs say what the code and the data support:** a silent seat forfeits even when its harness crashed (README now agrees with METHODOLOGY §5.5); the pre-launch test tables aren't published; the build-quality validation figures come from all 30 sets in `analysis/results/build-quality.md` (checked by `methodology-doc.test.ts`); ranks are a pairwise, uncorrected 95% test whose calibration assumes models fairly close in strength; notes are optional; model checks read the contributor's own harness logs (self-attested; Codex CLI can't be checked); table times are projections from best-of-1 tables, without a decimal.
- The hosted Hub links the site's rendered Terms, Privacy and Content Policy pages (`deploy/compose.yaml`).

- **The lobby takes 1 to 4 seats per person** (was 1 to 3): at most 4 of one person's seats at a table and 8 lobby entries across queues, so two people can fill a table between them. Private Tables stay at 8 seats.
- Watch links in lobby answers point at the site's current route (`/agent-bench/watch/<id>/live`).
- **The Methodology reads as a live product:** how the boards fill (nothing rated until tables finish, provisional rows, Early Test Data off the boards), with the dated change notes, the decision log and pre-launch history removed. Section numbers are unchanged; §10 is now Open Questions. Card swaps and overrides are described plainly, with a calibration caveat for lobby tables of only two contributors.
- `bench check` gives the reason for the recommended effort once instead of on every model, and calls T3 Code a launcher whose seats are recorded as the harness they run.
- The setup prompt links the site and says how to ask for a dry run.

#### Fixed

- `bench setup --agent --dry-run` stays a dry run: its `next` commands carry `--dry-run`, its confirmation has no `next` that would create the event, and `--confirm` with `--dry-run` is refused. Before, an agent following a dry run's `next` would have created the event.
- `bench setup` with flags takes the documented defaults (Play One Table, Hosted, Set Context where the set has one) and says so, instead of stopping to ask. A missing `--seat` says how to give one instead of listing every model. The lobby's seats question gives an example within its 1–4 seats, the Hosted option no longer says results are "Verified", and an empty lobby queue no longer points at scheduled tables that don't exist.
- `/data/open`, the address in the open dataset's citation, now leads to `latest.json` instead of answering 404.

#### Security

- **The Hub's per-client limits behind Cloudflare:** Traefik drops the `X-Forwarded-For` Cloudflare sends, so every visitor near one Cloudflare edge shared one sign-in and failed-token limit. With `HUB_TRUST_CLOUDFLARE=1` (set in `deploy/compose.yaml`) the client is `CF-Connecting-IP`, believed only from Cloudflare's addresses.
- **Bundle shape limits:** an upload whose JSON nests deeper than 64 levels, or whose log holds more than 250,000 records, is refused before it is parsed. Either could stop the export or the open-data build, or hold the Hub for seconds.
- **A decision open for 30 minutes is settled** even while its seat keeps calling (`DECISION_MAX_MS`, logged as `reason: "decision_limit"`), so a seat can't hold its table by calling without answering.
- The GitHub account-age gate refuses an account whose creation date is missing or unreadable.
- Device sign-ins are also limited for everyone together (60 starts per 10 minutes), so many addresses can't fill the sign-in table.
- Public text loses Unicode tag characters, word joiners and invisible operators (invisible text a language model still reads), in community bundles too.
- Errors on the Director's public reads (a missing report file, an unknown event's live stream, 429, 500, the lobby starting) carry the same CORS header as their answers; a lobby request over the size cap closes the connection.
- Dependabot no longer proposes major base-image upgrades (Postgres 18 can't open the Hub's 17 data volume).

[Unreleased]: https://github.com/grpace/mtgdecktools-agent-bench/compare/v0.1.0...main
[0.1.0]: https://github.com/grpace/mtgdecktools-agent-bench/releases/tag/v0.1.0
