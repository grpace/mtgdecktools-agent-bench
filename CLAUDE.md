# MTG Deck Tools Agent Benchmark: notes for coding agents

AI agents draft, build and play Magic: The Gathering limited against each other through the phase-rs rules engine; we rate them, and compare their format insights with 17Lands human data. Start with `README.md` and `docs/ARCHITECTURE.md` (it maps the whole system), and the doc for the area you touch. Our own working handoff (what's deployed, what's in flight) is kept privately, outside this repository.

## How it fits together
- **The format:** 8 agent seats per table, no bots at rated tables. A draft, deckbuilding, then a 3-round Swiss of best-of-3 matches with sideboarding (the loser of a game chooses play or draw). Private Tables (bring all 8) or the Matchmaking Lobby (bring 1–4 per person).
- **phase-server** is the unmodified upstream image, pinned by digest in `engine/phase.lock.json` (upgrade with `npm run deps -- update phase`, docs/UPGRADING.md). There is no fork; `engine/` also holds card overrides (docs/CARD-OVERRIDES.md). Only the Director talks to it.
- **`packages/director`:** runs tables (boosters, draft, deckbuilding, Swiss, games), speaks MCP to the seats (docs/PROTOCOL.md is the contract; bump its version on purpose), the lobby, spectating, and hands finished events to the Hub.
- **`packages/hub`:** accounts and tokens (GitHub sign-in, terms acceptance), submission intake and integrity checks, the bundle store, the Postgres index, ratings, contributor points, moderation, the JSON export (`/data`) and the nightly open dataset (CC BY 4.0).
- **`packages/site`:** turns event logs into ratings, outcomes and the JSON export the mtgdecktools.com pages read (docs/SITE-DATA.md); the Hub and the Director run it. The site itself is a separate, closed-source repository.
- **`registry/` + `packages/registry`:** canonical model, harness and effort names. **`scripts/bench`:** the contributor CLI (setup, login, play, lobby, submit).
- **Public text** (agent notes, deck names, handles) goes through one module, `packages/director/src/public-text.ts`: the scrubber, the content filter and the moderation list. Use it for any new public output.

## Rules
- The server never calls a model and holds no API keys. Contributors run their own harnesses and tokens over MCP. Don't spend model tokens to test plumbing: use the scripted agent (`scripts/mcp-random-agent.mjs`).
- The headline rating is LLM vs LLM, outcomes only. Harness or infrastructure failures are never scored as misplays; voided games stay unrated.
- Agents never see hidden information, opponent identity or event names.
- Current prompts are in `prompts/`; released sets stay in `prompts/archive/vN/` and are never edited. A change to the seat prompts starts a new comparability group (content hash; `setup.md` is not hashed).
- Use only 17Lands **public datasets**, with credit. No card images in the repo. Copy nothing from the closed-source Magic Deck Builder app without the owner's approval.
- Production deploys, merges to the site's master, releases, posts and outreach (phase-rs, 17Lands) need the owner's go. The CLI is never published to npm: it runs from a git clone.
- **CI:** GitHub Actions runs on every push and pull request. Run `scripts/ci-local.sh --quick` before every push, and `--full` before a deploy (its stamp is what `deploy/deploy.sh` checks).
- **Deploys go through git:** Coolify builds each instance from its branch (`deploy/dev`, `deploy/prod`), and `deploy/deploy.sh` promotes a commit with a passing full CI stamp to it. Move `deploy/prod` only on the owner's go (docs/OPERATIONS.md "Deploying").
- **Several agents share this working tree:** commit only your own paths, in small commits, fast-forward only on `main`. Never commit or revert another agent's uncommitted changes; when you share a file, stage only your hunks.
- **Writing:** US spelling. Never say "maintainers" (say "we" or "us"). "Set Context" in reader-facing text. Title Case headings in docs and labels in site UI. T3 Code is a launcher, not a harness. Public docs describe the live project: no pre-launch notes, owner-decision logs or private host names (those go in our private ops notes). No prompt version labels in reader-facing text. Never print secrets.
- Update `CHANGELOG.md` and the docs you touched at the end of a work session.
