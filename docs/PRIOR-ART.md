# Prior Art

Surveyed 2026-10-21. The field is moving fast: two of the projects below had commits on the day of this survey.

## Closest Relatives

| Project | What it is | Take | Leave |
|---|---|---|---|
| [sagasti/mtg-bench](https://github.com/sagasti/mtg-bench) (GPL-3.0, fork of zachmay/mtg-bench) | 8 LLMs cube-draft, build, and play a Bo3 round robin through Forge. TypeScript harness and Java bridge. Bradley-Terry ratings, cost analytics, decision provenance. | Their Java bridge (driving the human controller headlessly), the decision contract, ideas for reducing variance (duplicate format, common random numbers, noise floor), anti-leak rules, the delegation accounting. | Cube only; harness-driven LLM calls only (no agent/MCP seats); no site, replays or format insights. Status: real Forge runs validated with bots and one cheap model. |
| [gab-25/mtg_forge_engine PR #1](https://github.com/gab-25/mtg_forge_engine/pull/1) (GPL-3.0) | Forge in-process through Python/JPype + FastAPI. A `BridgeController` exposes 9 decision kinds over HTTP. | ThreadLocal seeded `GameRandom`, seeded-replay tests, orphan/timeout fallback to the AI, a timing figure (~33.5k cards boot in ~8 s). | Python/JPype runtime. |
| [GregorStocks/mage-bench](https://github.com/GregorStocks/mage-bench) (67★) | LLMs play XMage through MCP tools; duels and Commander. | Proof that MCP play works; their Show HN feedback (play quality was poor, buggy). | No draft; XMage. |
| [MaxBittker/rs-sdk](https://github.com/MaxBittker/rs-sdk) + [runebench](https://github.com/MaxBittker/runebench) | RuneScape emulator + typed SDK + MCP; Harbor-based benchmark on Modal, results site with synced replays. | Two-layer API with reason codes; generated API docs checked in CI; MCP auto-discovery; per-CLI agent configs; pinned images (never re-push a tag); one pricing file; uniform trajectory format; replays on the site; tamper-proof scoring; Discord + public site. | The scoring metric (XP/min) doesn't apply. |

## Engines

| Engine | License | Coverage of new sets | Headless control | Verdict |
|---|---|---|---|---|
| [phase-rs/phase](https://github.com/phase-rs/phase) | MIT/Apache-2.0 | 88.9% of all cards; 97–99% of recent sets; FRA 92% (19 booster cards unsupported, 2026-10-21). Card behavior comes from parsing Oracle text: about 4,500 suspected misparses across the database | Official Docker server (226 MB image, ~20 s to healthy, 100 games/process); per-seat filtering; `legal_actions` over JSON; `ReplayLog`; MTGJSON boosters incl. FRA's Echoed Pair | **Primary** (DESIGN §4) |
| [Forge](https://github.com/Card-Forge/forge) | GPL-3.0 | 100% scripted for all 9 recent sets (hand-written, battle-tested); FRA Echoed Pair booster slot wrong | No server image; one JVM per match (mtg-bench); 112-method controller | Fallback backend + differential-testing oracle |
| [XMage](https://github.com/magefree/mage) | MIT | 32k+; new sets complete a few weeks after release | Client/server; bridge clients exist | Not planned |
| Arcana, rustmage, mtg-kernel, manabrew | various | Narrow | Gym-style APIs | Not for current-set limited |

## Other

- [MTG Bench (mtgautodeck)](https://mtgautodeck.com/articles/mtg-bench/): LLM-as-judge with no engine. The HN criticism ("use a real engine, count illegal moves") is our argument for using one.
- RL work: MageZero (AlphaZero-style on XMage), MTG-Causal-RL Gymnasium (arXiv 2605.06066), an XMage PPO fork. Useful for the win-probability and blunder-detection ideas later.
- MCP card-lookup servers (mtg-oracle and others): could serve as knowledge tools, but none of them run games.
- 17Lands public datasets (`17lands-public` S3): draft, game and replay data per set and format. FRA PremierDraft draft data is available (checked 2026-10-21).

## Positioning

mtg-bench answers "which LLM plays cube Magic best, under a controlled harness." This benchmark aims to:
1. use **this month's retail set**, checked against 17Lands human data;
2. let **agent systems** connect over MCP as well as raw models;
3. produce **format insights and replays** as a main output;
4. support **community runs that can be verified by replay**.

We use a different engine (phase-rs) from mtg-bench, but borrow their methods for reducing variance and accounting for delegated decisions, and credit them for it. phase-rs's own `phase-llm` crate (LLM opponents in the browser client) is the closest relative on the engine side.
