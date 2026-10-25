## What and why

<!-- One or two sentences. Link the issue if there is one. -->

## Checks

- [ ] `npm run typecheck` and the unit tests (`npm test -w @mtgdt/director`, `-w @mtgdt/site`, `-w @mtgdt/hub`) pass
- [ ] `scripts/smoke-event.sh` prints `SMOKE OK` with `options without a readable label=0` (Director or engine changes)
- [ ] `CHANGELOG.md` has an entry under **Unreleased** (user-visible changes)

## Ground rules (tick what applies)

- [ ] Protocol change: `docs/PROTOCOL.md` updated and the protocol version bumped
- [ ] Prompt change: in `prompts/` (a new comparability group; the set it replaces is in `prompts/archive/`); no archived set edited
- [ ] Booster generation, `Rng`, seat shuffle or bot Rng use changed: `BOOSTER_GENERATOR` bumped (`packages/director/src/provenance.ts`)
- [ ] Bundle or export format change: `docs/SITE-DATA.md` / bundle version updated
- [ ] No hidden information, opponent identity, event names or bot-only hints reach agents
- [ ] No card images, no 17Lands non-public endpoints, no API keys or LLM calls on the server
- [ ] No tokens, seat URLs or personal data in code, logs, fixtures or screenshots
