# Contributing

Thanks for helping. This repo is the open-source half of the [MTG Deck Tools](https://www.mtgdecktools.com) Agent Benchmark: the Director (the bridge to the phase-rs rules engine, events and MCP seats), the protocol, prompts, scripts and the results format. The leaderboard, reports and Set Contexts live on mtgdecktools.com.

Ways to contribute:
- **Run events** with your harnesses and models and share them ([docs/COMMUNITY.md](docs/COMMUNITY.md)).
- **Improve harness support**: if `bench play` can't start a seat with your harness, or its usage report looks wrong, fix the launcher in `scripts/bench/harnesses.ts` or the transcript reader in `packages/director/src/usage.ts`, and update [docs/HARNESSES.md](docs/HARNESSES.md). New harnesses are welcome too.
- **Improve the Director**: labels for new mechanics, better decision text, bug fixes.
- **Report engine issues**: cards that behave wrong in phase-rs. Send them upstream to [phase-rs](https://github.com/phase-rs/phase), with a link in our issue.

## Dev setup

```bash
npm install
# Rules engine, pinned build (see engine/phase.lock.json for the digest)
podman run -d --name mtgdt-phase -p 127.0.0.1:9374:9374 -v mtgdt-phase-data:/var/lib/phase-server \
  ghcr.io/phase-rs/phase-server@$(node -p "require('./engine/phase.lock.json').digest")
mkdir -p data
podman cp mtgdt-phase:/var/lib/phase-server/card-data.json data/
podman cp mtgdt-phase:/var/lib/phase-server/draft-pools.json data/
```

`docker` works the same way. The phase-server downloads its card data on first start; wait for it before copying.

Run the Director natively:
- One-shot event: `npm run director -- --set fra --agents a,b,c,d,e,f,g,h`. It prints 8 seat URLs and exits when the event ends. Every event seats 8 agents; for an engine test with fewer, add `--dev-bot-fill` (bot drafters fill the other seats; labeled Smoke, never rated).
- Server mode: `ADMIN_TOKEN_FILE=.bench/admin-token npm run director -- --serve`. Same API as the hosted one; works with `npm run bench -- new`.

Or run the whole stack in containers: `npm run up` ([docs/COMMUNITY.md](docs/COMMUNITY.md)).

## Checks before a pull request

```bash
npm run typecheck                         # all workspaces
scripts/smoke-event.sh                    # full event with 8 scripted random agents: draft → build → 3 Swiss rounds of best of 3 with sideboarding
```

`smoke-event.sh` costs nothing (no LLM) and takes about 8 minutes locally (up to 20 in CI). It must print `SMOKE OK` with `options without a readable label=0`. Options are positional: `scripts/smoke-event.sh [phase-ws-url] [data-dir] [set] [port] [knowledge]`.

Changing the CLI or submissions? Test the whole loop with scripted agents:

```bash
ADMIN_TOKEN_FILE=tmp/t/admin RUNS_DIR=tmp/t/runs-a PORT=8823 npm run director -- --serve &
ADMIN_TOKEN=$(cat tmp/t/admin) npm run bench -- new --director http://127.0.0.1:8823 --set fra --seat "8x script/random"
npm run bench -- play <event>                 # starts the 8 scripted seats (seat URLs from runs/<event>/event.json)
npm run bench -- pull <event> --director http://127.0.0.1:8823 && npm run bench -- bundle <event>
SUBMIT_TOKENS=me:$(openssl rand -hex 20) …   # a second server-mode Director to submit to
```

Debug a live seat with `node scripts/peek-seat.mjs <seat-url> [option]`.

Don't spend model tokens to test plumbing. Use the scripted agent (`scripts/mcp-random-agent.mjs`) for anything that doesn't need an LLM.

Add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md) for anything a user or contributor would notice. CI runs the typecheck and unit tests on every push, and the smoke event, the lobby and Hub end-to-end tests and the image build on pull requests and `main`.

Found a security problem? Report it privately ([docs/SECURITY.md](docs/SECURITY.md)), not in an issue. Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ground rules

- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) is the contract. Change it on purpose, and bump the version.
- **Prompts:** The current prompts are in `prompts/`; every set events ran with stays in `prompts/archive/vN/`. Never edit an archived set. A change to the current prompts starts a new comparability group (groups key on their content hash); archive a released set as the next `vN`. Leaderboard comparability depends on it.
- Agents never talk to phase-server directly, never see hidden information, opponent identity or event names, and never see bot-only hints.
- The server never calls an LLM and holds no API keys.
- Harness or infrastructure failures are never scored as misplays.
- No card images in the repo. Use only 17Lands **public datasets**, never the site's undocumented endpoints.
- Shell scripts wrap their body in `main()`, because bash reads scripts lazily and editing a running script corrupts it. Kill processes by PID, not `pkill -f`.

## Upgrading the engine

phase-rs ships almost daily. We run the upstream image unmodified, pinned by digest in `engine/phase.lock.json`:

```bash
scripts/upgrade-phase.sh                     # pull latest, probe, smoke-test, switch only if it passes
git add engine/phase.lock.json deploy/ && git commit -m "chore(engine): phase-rs <version>"
```

See [docs/UPGRADING.md](docs/UPGRADING.md). The pinned digest is also the default image in `deploy/compose.yaml` and `deploy/compose.local.yaml`. `upgrade-phase.sh` updates both. Results record the engine build they ran on. Submissions from builds other than the pinned one are flagged, not rejected.

## Sets and Set Contexts

- **Any set with phase-rs booster data runs** (`--set <code>`). 17Lands ratings and a Set Context are optional.
- **17Lands ratings**: `python3 -I scripts/build-17lands-ratings.py <SET>` builds `sets/<SET>/17lands.json` from the public datasets (attribution in [sets/README.md](sets/README.md)).
- **Set Contexts come from MTG Deck Tools.** They're written and kept up to date on mtgdecktools.com, published at `https://www.mtgdecktools.com/agent-bench/set-contexts/<SET>.md`, and fetched by the Director at event time (source and sha256 are logged). The copies in `sets/<SET>/primer.md` are fallbacks, refreshed with `npm run deps -- update set-context` ([docs/UPGRADING.md](docs/UPGRADING.md)). Please don't send Set Context rewrites as pull requests. Suggest changes on mtgdecktools.com or in an issue.
- To put a set in rotation: 17Lands ratings (optional), its Set Context (published on mtgdecktools.com, then refreshed here), then add it to `sets/rotation.json`.

## License

By contributing you agree that your contributions are licensed under the Apache License 2.0 ([LICENSE](LICENSE)). Third-party data and attributions are listed in [NOTICE](NOTICE).
