# Roadmap

_Last updated Oct 22, 2026._ The **method** and the **product** come first. We don't run the full benchmark ourselves: the community runs events on their own harnesses and tokens, and submits results to mtgdecktools.com. Our own runs are tests of the pipeline, not leaderboard data.

## Done

- **Engine:** phase-rs, pinned by digest, with a one-command safe upgrade (`scripts/upgrade-phase.sh`, `docs/UPGRADING.md`).
- **Director:**
  - Runs full events: 8-agent booster draft → deckbuilding → 3 rounds of Swiss, every match best of 3 with sideboarding (the loser of a game chooses play or draw). The first prototype tables (Oct 21, 2026) filled seats with bot drafters and played round robins; they are Early Test Data now.
  - One MCP URL per seat; the server never calls a model.
  - Manual mana payment, smart stops, readable labels for new mechanics, a smoke-test gate.
  - Knowledge levels No Set Context, Set Context and Set Context + Human Stats (`none`, `primer`, `primer+stats`). Set Contexts come from mtgdecktools.com, with source and hash logged.
  - Server mode with a token-protected admin API: hosted Private Tables, the matchmaking lobby, durable events that resume after a restart, drain before deploy.
- **Hub:** the results service (Postgres): hosted hand-offs and Community bundles with integrity checks, contributor sign-in and points, the site export, the nightly open dataset (CC BY 4.0).
- **Reports:**
  - JSON export (`docs/SITE-DATA.md`), served by the Hub; live events from the Director's spectator stream.
  - mtgdecktools.com `/agent-bench` on branch `feature/agent-bench`, flag-gated and not deployed.
  - A standalone viewer for contributors.
- **Test runs:** Claude Code events across FRA, TLA, MSH, HOB and SOS (Opus, Sonnet, Haiku), including two 8-seat hosted tables, plus scripted smoke events on many sets. All of them are pipeline tests (Early Test Data or Test Runs), not leaderboard data.

## Plan of record

**M1: trustworthy core**
- [x] Methodology doc + rating model (Bradley-Terry, bootstrap CIs, provisional thresholds) and diagnostics (then called stage scores).
- [x] Decisions recorded (METHODOLOGY §10): pool engine builds and flag card bugs; no anchor (model vs model only); hosted tables first for integrity; finished events only; thresholds; contributors in the rating; best of 3 with sideboarding.
- [x] Community kit: self-hosting, `bench` CLI, bundles, interim submission endpoint, harness guides, license.
- [x] Context-aware draft analytics (archetype ratings, expert pick model, `draft-eval.json`).
- [x] ~~Deck strength via phase-ai duels~~: built as an experimental tool, then **dropped from the method (model vs model only)**.
- [x] Archetype build delta: deck vs reference build, judged by 17Lands archetype ratings and winning-deck norms (`packages/site/src/build-quality.ts`, METHODOLOGY §5.2).
- [x] Hub + Postgres.
- [x] Spectator mode + engine-issue flags.
- [x] ~~Anchor matches vs phase-ai~~: dropped (model vs model only; no engine-AI opponents).
- [x] Hosted Director → Hub hand-off.

**M2: launch readiness**
- [x] Event durability (resume after a Director restart), admission capacity and queueing, drain-before-deploy.
- [x] Noise-floor study: a simulation calibration of the rating, its ranges and thresholds on 8-seat Swiss tables (`analysis/results/calibration.md`, METHODOLOGY §6), instead of bot-only pods.
- [ ] mtgdecktools.com `/agent-bench` final pass, contributor onboarding pages, launch checklist.
- [x] Legal: Apache-2.0 + NOTICE; Set Contexts CC0 1.0; open dataset CC BY 4.0; 17Lands public data CC BY 4.0, credited (OPEN-QUESTIONS #4–#6).
- [ ] Outreach (17Lands; phase-rs for upstream seed and replay-log changes): only once the project is public.

**M3: research layer**
- [ ] Win-probability model from turn snapshots → decision quality (WPA), key moments in replays.
- [ ] Replay verification once games are deterministic.
- [ ] Season mode (notes across pods), puzzles, a human seat.

## Priority 1: methodology (what the numbers mean, and why they're trustworthy)

- [x] **Rating model.** Bradley-Terry (Elo scale) per comparability group from game outcomes only, play/draw term, event-cluster bootstrap (contributors' events together once a board has enough of them) with a Laplace floor and a contributor variance component, the provisional floors including the contributor floor (2 or more contributors, none above half), leave-one-contributor-out influence flags, rank ranges from difference intervals, no anchor (`packages/site/src/rating.ts`, `scoring.ts`; METHODOLOGY §4). Partial pooling is implemented and off.
- [x] **Diagnostics** (descriptive, never part of the rating, never ranked; METHODOLOGY §5):
  - Draft: core metrics from card data for every set (conversion, commitment, color flow, on-color rate, role coverage); the 17Lands comparison where data exists (archetype regret, expert pick model, naive baselines).
  - Build: legality, sanity checks, archetype build quality vs the reference build.
  - Mana: manual-payment share, payment failures. _Mis-taps not detected yet._
  - Reliability: rejections, withdrawals, abandoned games, forfeits.
  - _Later:_ play decision quality (win probability added).
- [x] ~~**Deck strength** (phase-ai pilots both decks)~~: dropped from the method; the bot-duel tool stays experimental.
- [ ] **Variance controls:** fixed seeds, the same packs for every condition, duplicate format (swap decks and replay). Needs deterministic games, which needs the phase-rs seed + ReplayLog patches upstream.
- [x] **Methodology page:** one source (`docs/METHODOLOGY.md`, shipped in the export as `methodology.md`) rendered on mtgdecktools.com. States what each number means, sample sizes, caveats (agents vs humans, engine card bugs, tiny samples), and which conditions are comparable.
- [x] **Comparability rules:** results are only pooled when the prompt files (by content hash), knowledge level and mana mode match; every rated match is best of 3 with sideboarding; engine build is recorded, not split on (METHODOLOGY §3). Provenance is in `event_start`.
- [x] **Forfeits count as losses** (decided; METHODOLOGY §5.5): `FORFEIT_POLICY` is `loss`. Re-export after the next deploy.

## Priority 2: community kit (anyone can run, seat agents, and share)

- [x] **One-command self-hosting:** `npm run bench -- up` (phase-server + Director with Docker Compose).
- [x] **Seat guides per harness** (docs/HARNESSES.md): Claude Code, Codex, Gemini CLI, OpenCode, Cursor and others via MCP over HTTP, plus "paste into any thread" instructions.
- [x] **Event CLI** (`npm run bench -- <command>`): the setup wizard, Private Tables and the lobby, headless seats with a fresh session per game, Keep Playing, status, pulling results.
- [x] **Results bundle + submission:**
  - `bench bundle` and `bench submit` upload the event log, summary, seat metadata and harness usage to the Hub, which checks them (METHODOLOGY §3.1).
  - Accepted submissions are labeled **Community**; events on the hosted Director are labeled **Hosted**.
  - Later: Replay-Checked once games are deterministic.
- [x] **Contributor docs:** README quickstart, CONTRIBUTING, docs/COMMUNITY.md, licenses (Apache-2.0 for our code), card-data and 17Lands attribution (NOTICE).

## Priority 3: product polish (mtgdecktools.com `/agent-bench`)

- [ ] Leaderboard built on the rating model, with filters (set, harness, model, knowledge, Hosted/Community).
- [ ] Set insight pages: what agents learned about each format, agents vs 17Lands, the Set Context's measured effect.
- [ ] Replays with turn snapshots: board timeline and life chart from `turn_snapshot`; win probability later.
- [ ] Launch checklist: sign-off, then flip `VITE_AGENT_BENCH_ENABLED`, merge, deploy, and turn on Set Context publishing.

## Later

- Upstream phase-rs proposals (seeded games, a server-side replay log, a starting-player option), once the project is public.
- Puzzles (T3), Season mode with notes across pods (T6), a human seat in the web client.
- A second engine backend (Forge) for differential card testing.
