# Model and harness registry

Every leaderboard row is a **seat identity**: canonical model + canonical effort, for example `claude-sonnet-5-5/high`, shown as "Claude Sonnet 5.5 · High" (docs/METHODOLOGY.md §2). The harness each seat ran on is recorded per seat, not part of the row. This folder is the single list of the names a seat's harness, model and effort may take:

| File | What |
|---|---|
| `models.json` | Models: canonical id, display name, provider, family, release date, status, aliases, per-harness launch strings, supported efforts. Also the providers (with the prefixes harnesses put on ids) and the canonical effort scale. |
| `harnesses.json` | Harnesses: canonical id, display name, aliases, how each reports its version and model ids, its effort flag, and its helper models. |
| `schema/*.schema.json` | JSON Schemas for both files (editors pick them up through `$schema`). |

The resolver that reads them is `packages/registry` (`resolveModel`, `resolveHarness`, `normalizeEffort`, `resolveSeat`, `primaryModelFromUsage`, `verifySeatModel`). The Director's create-event API, the lobby, the `bench` CLI, the Hub's checks and the site export all use it, so a name means the same thing everywhere.

## Why this matters

Without a registry, "Sonnet 5.5", "sonnet", "claude-sonnet-5-5", "anthropic/claude-sonnet-5-5" and a typo would each become their own leaderboard row, splitting one model's games across several ratings. With it:
- **Entry:** `bench new`, `bench setup`, lobby join and `POST /api/events` resolve every seat to canonical values and refuse unknown models with suggestions. Your own table (not the hosted one or the lobby) can pass `--unlisted-model`: those seats are labeled **Unlisted** and are unrated until the registry knows the name.
- **Logs keep both:** `event_start` records the canonical values (`harness`, `model`, `effort`) and the strings as typed (`harness_declared`, `model_declared`, `effort_declared`).
- **Export re-resolves:** the site export resolves the raw strings again every time it runs. A registry fix (a new alias, a newly listed model) therefore merges or rates old rows at the next export, without touching any stored log.

## How names are matched

`resolveModel(raw, harness, { at })`:
1. **Case, spaces, dots, dashes and underscores never matter.** "Claude Sonnet 5.5", "claude_sonnet_5_5" and "claude-sonnet-5-5" are the same name.
2. **Provider prefixes are stripped:** `anthropic/`, `openai/`, `google/`, `models/`, `xai/`, `moonshotai/`, `zai/`, `zhipuai/`, `deepseek/`, `meta/`, and Bedrock's `anthropic.` (and its regional forms). They are listed per provider in `models.json → providers`.
3. **Effort hints are read off the name:** OpenCode's `#high` and Cursor's `[effort=high]`. A `[1m]` context suffix is ignored.
4. **The name must then equal** a model's id, display name, alias, known snapshot, or (for that harness) launch string.
5. **The harness's own name forms** (only when the harness is given, including when T3 Code starts it):
   - `effort.name_suffix` (Antigravity `-{effort}`): every model name carries its level, so any registry model followed by a level it has resolves to that model at that level (`gemini-4-argon-high`). A level it doesn't have is an error listing the ones it has.
   - `effort.fast_suffix` (Cursor `-fast`): fast serving mode, stripped and recorded (`fast: true`), not part of the identity.
   - `hosted` (OpenCode Zen `opencode/`, free variants `-free`): the registry model, served by the harness vendor, flagged `hosted: { service, free }`.

   Without a harness these forms aren't applied (a name such as `gpt-5.1-codex-max` must never quietly become another model at max); the error says which model and level the name reads as and asks for the harness.
6. **Floating aliases** such as Claude Code's `sonnet` or `opus` always point at the newest model of a line. Each has a date window, and the event's start date decides which model it meant.
7. **Dated snapshots:** a known model id followed by a date (`-20261001`, `@20261001`) resolves to that model as a snapshot. Unknown snapshots are flagged (see Snapshots below).
8. **Anything else is unknown.** Typos are never corrected silently. The error lists the closest names ("did you mean claude-sonnet-5-5?") and points here.

## Effort

Every harness's reasoning setting maps onto one canonical scale. "Default" is never recorded as a level: a seat that ran at its harness's default gets the level that default is, or **Unknown** (METHODOLOGY §2.2).

| Canonical | Display | Claude Code `--effort` | Codex `model_reasoning_effort` | OpenCode `#variant` | Cursor model name | Antigravity model id | Gemini CLI |
|---|---|---|---|---|---|---|---|
| `none` | No Reasoning | | `none` | `none` | `…-none`; Haiku "No Thinking" names | | |
| `minimal` | Minimal | | `minimal` | `minimal` | `…-minimal` (Muse) | | |
| `low` | Low | `low` | `low` | `low` | `…-low` | `…-low` | |
| `medium` | Medium | `medium` | `medium` | `medium` | `…-medium` | `…-medium` | |
| `high` | High | `high` | `high` | `high` | `…-high` | `…-high` | default (fixed) |
| `xhigh` | Extra High | `xhigh` | `xhigh` | `xhigh` | `…-xhigh` (GPT-5.5: `…-extra-high`) | | |
| `max` | Max | `max` | `max` | `max` | `…-max` | | |
| `ultra` | Ultra (unordered) | | `ultra` (GPT-6 Astra, GPT-6.1 Sol) | | | | |
| `unknown` | Unknown Effort | | | | | | |

T3 Code shows each harness's levels as a separate option: Cursor models take `reasoning_effort`, `reasoning` or `effort` (by model; GPT-5.5 calls Extra High `extra-high`), OpenCode its variant; Antigravity names keep the level in the id.

Per harness, `harnesses.json` records three things:
- **`effort`:** how to set the level at launch: `args` (a flag with `{effort}`), `model_template` (OpenCode's `{model}#{effort}`), or `{effort}` inside the model's `launch` string (Cursor). It is `null` when the harness has no control (Gemini CLI). `name_suffix` says every model name carries its level (Antigravity), `fast_suffix` names fast mode (Cursor).
- **`effort_defaults`:** the documented default per model, with a `source` link and the harness version range it applies to (`since` inclusive, `until` exclusive).
- **`effort_detection`:** where the harness logs the level it used, and whether that was `tested` on real files, is `untested`, or is `not-reported`.

Resolver helpers:
- `recommendedEffort(model, harness)`: the preselected level with a one-line reason. It's `high` where the model has it, so rows compare across providers. Where the harness can't set effort, it's the harness's fixed default.
- `effortFlag(harness, level)` and `launchSpec(harness, model, level)`: the exact arguments and model string to launch with.
- `harnessDefaultEffort(harness, model, version)`.
- `resolveSeatEffort(evidence)`: the level that goes into the identity. It checks, in order, the logs, a level set at launch, a self-reported level, the harness default, then Unknown. It also returns `effort_source`.

Rules:
- A level the model doesn't support is refused (for example `none` on Claude Opus 5.5). The error lists what it does support.
- **A level in the model name is the seat's level** (`gemini-4-argon-high`, Cursor's `grok-4.7-xhigh`, OpenCode's `#high`). A separate effort may repeat it; one that names another level is refused (`resolveSeat`: the logs record the name, and nothing could tell which level ran). `default`, `unknown` or no effort defer to the name, and the lobby counts it as declared. The export applies the same rule.
- Synonyms live in `effort_scale[].aliases` (`x-high` → `xhigh`, `maximum` → `max`). `default`, `auto`, `unknown` and "I don't know" all declare "the harness default", which resolves as above.
- Models without an effort setting have `"efforts": []`.
- **Fast serving mode** (Cursor's `-fast` names) is recorded per seat, but it isn't an effort level and isn't part of the identity.
- **`ultra` is its own level, not a higher `max`.** Codex describes it as subagents working on parts of a task in parallel, and its docs give no order relative to `max`, so it has no rank. It is never mapped onto another level, and only Codex accepts it, for the models whose catalog lists it.

## Helper models and verification

Some harnesses run a second model for their own side tasks. Claude Code, for example, runs a small Haiku model in the background, so a Sonnet seat's usage also lists `claude-haiku-5-5`. `helper_models` in `harnesses.json` (ids or prefix globs ending in `*`) lists them. `primaryModelFromUsage` takes the model with the most output tokens, ignoring helpers unless nothing else ran (so a Haiku seat is still Haiku).

The Hub and the export compare that primary model with the declared one (METHODOLOGY §2.1):
- **Checked Against Logs:** they match (the code value is `verified`).
- **Self-Reported:** no usage was submitted, or the harness doesn't report its model (Codex today). The seat is still rated and labeled.
- **Mismatch:** another model did the work. The seat is excluded from rating, with the reason.
- **Unlisted:** the declared model isn't in the registry. The seat is unrated until it is.

## Snapshots

Providers sometimes serve dated snapshots behind one id. **A snapshot is the same leaderboard row as its canonical id.** List known snapshots in `snapshots`. The export records which snapshot a seat's usage showed and flags snapshots the registry doesn't list, so a silent model change is visible on the site without splitting the row. If a provider ever ships a materially different model under an existing id, it can be split off by giving the new snapshot its own entry. Treat that as a methodology change (METHODOLOGY §9).

## Adding a model

1. Find the **exact API id on the provider's official model page** (not a blog post, not a third-party router).
2. Add an entry to `models.json → models`:
   ```json
   {
     "id": "provider-exact-id",
     "display": "Exact Product Name",
     "provider": "anthropic | openai | google | …",
     "family": "line-slug",
     "released": "YYYY-MM-DD (leave out when no official page gives one)",
     "status": "active",
     "source": "https://official.page/listing/the/id",
     "aliases": [],
     "floating_aliases": [],
     "snapshots": [],
     "efforts": ["low", "medium", "high"],
     "launch": { "codex": "provider-exact-id", "opencode": "provider/provider-exact-id" }
   }
   ```
3. **Aliases:** only names that unambiguously mean this model ("sonnet 5.5"). Don't add case, spacing or `provider/` variants: they already match. A name that moves to each new release ("sonnet") is a **floating alias** with a `from` date. When a successor ships, set `until` on the old entry and give the successor `from` on the same date.
4. **Efforts:** the levels the provider documents for this model, on the canonical scale. Use `[]` if the model has none.
5. **Launch strings:** only harnesses whose docs or model list (`cursor-agent models`, `opencode models`) confirm the string. Leave the others out. Where a harness spells a level differently for one model, add `launch_effort_words` (`{ "cursor": { "xhigh": "extra-high" } }` for GPT-5.5). Antigravity needs no launch string to resolve (its names follow `name_suffix`), only to appear in setup's model list.
6. Run `npm test -w @mtgdt/registry`.
   - The schema check and the uniqueness check must pass: no name may match two models, even after case and punctuation are dropped.
   - Then run `npm run site:data`. Any rows that merge or become rated are expected.

### Pull request checklist

- [ ] Official source link for the exact id (`source`)
- [ ] Display name exactly as the provider writes it
- [ ] Release date from an official page (or left out, with a note) and status (`active`, `preview`, `deprecated`, `retired`)
- [ ] Aliases: unambiguous ones only; floating aliases with dates; any older floating alias given `until`
- [ ] Known dated snapshots, if the provider publishes them
- [ ] Effort mapping: supported levels from the provider's docs
- [ ] For each harness: the documented default effort for the new model (`effort_defaults`, with source and version range), and the launch string per level
- [ ] Launch strings only for harnesses whose docs confirm them
- [ ] `npm test -w @mtgdt/registry` passes

## Prices

`prices.json` (schema `schema/prices.schema.json`) holds API list prices, USD per 1M tokens, standard tier. The export uses them only to **estimate** cost for harnesses that don't report one, and labels those numbers as estimates (docs/SITE-DATA.md, `CostInfo`; METHODOLOGY §5.7). Prices aren't part of the registry version: a price change never changes how a name resolves.
- One entry per price window: `from` (inclusive) and `until` (exclusive), so launch promotions and scheduled changes are both recorded. Windows of one model never overlap (checked).
- `input`, `output`, `cache_read`, `cache_write` (the shortest-lived cache write; `null` when the provider lists no per-token write price: writes billed as input, or cache storage billed by time; estimates then price writes at the input rate), optional `cache_write_1h` (a 1-hour cache write where the provider prices it apart; Claude Code writes those), `source` (the provider's own pricing page), `checked` (the day you read it) and an optional `note`.
- `long_context`, where the provider lists higher prices for long prompts: `above` (the prompt size in tokens, counting cache reads and writes, over which a request pays them) and the rates over it (with `cache_write_1h` where the base has one). The whole request pays the higher prices. Leave it out for models with one price at every size (Claude Opus, Sonnet and Fable: full 1M context at the same rate).
- Only prices you read on the provider's official page (for Cursor's own Composer, Cursor's published rate). Leave a model out rather than guess; its costs then show as not reported. A price with no known start date uses the day it was read as `from`, with a note (Kimi K3).
- Free hosted variants (OpenCode Zen `-free`) have no price row of their own: they cost nothing while free, and projections use the underlying model's price.

## Adding a harness

Add an entry to `harnesses.json`:
- **Effort:** how to set it (`effort`), its documented defaults per model and version (`effort_defaults`), and where it logs the level it used (`effort_detection`). Mark that `untested` until you've checked real files.
- **Identity:** `id` (lowercase slug), the product's `display` name, `vendor` and `aliases`. Set `kind: "agent"`, and `status: "untested"` until a full event completes with it.
- **`seated`:** `headless` when the bench CLI can launch it, or `by-hand` for apps a person seats (Claude Desktop, VS Code). In a `by-hand` app the declared level was picked explicitly, so it counts as Set at Launch, with Self-Reported verification.
- **Model:** `model_flag`, the flag that sets the model. `hosted`, where the harness vendor serves models itself (OpenCode Zen): its id `prefix`, the `free_suffix` of free variants, a `display` name and a `source`.
- **Effort:** `effort.flag` and `effort.values`, which map the harness's own words onto the canonical scale. Use `"effort": null` if the harness has no setting.
- **`reports`:** how the harness reports its version and model ids in its transcript. The usage extractor in `packages/director/src/usage.ts` must understand that format.
- **`helper_models`:** any models the harness runs for its own side tasks.

Then add its launch command to `scripts/bench/harnesses.ts` and a section to docs/HARNESSES.md.


## Launchers

An app that starts harness sessions without running the model loop itself is a **launcher**, listed under `launchers` in `harnesses.json` (today T3 Code). It is never a harness and never a leaderboard row: a seat started from T3 Code ranks as the harness it ran.
- **`launches`:** the harness ids it can start. Seats declare `<launcher>:<harness>` (`t3-code:claude-code`; "T3 Code (Claude Code)" and "Claude Code via T3 Code" also resolve). `resolveHarness` returns the harness with `launcher` beside it, and `resolveSeat` records `launcher` on the seat. A launcher alone ("T3 Code") is refused with the harnesses it starts.
- **`logs`:** where it records the model and effort each session opened with. Effort detection reads the harness's own record first and the launcher's log as a fallback.
- Names of launchers and harnesses never collide (`validateRegistry`).

## Left out on purpose (2026-10-22)

These were left out because their ids or settings couldn't be verified from official docs at the time:
- **Older models** (Claude Opus 5, Claude Sonnet 5, Claude Fable 5, the 4.x line; GPT-5.4 and earlier; Gemini 3.7 and 3.6 Flash; GLM 5.2; Kimi K2.7 Code; Muse Spark 1.2): no event has used them.
- **Cursor CLI model names for the GPT-6 models:** they aren't in `cursor-agent models` (2026.10.19), and Cursor's docs don't list GPT-6. The other Cursor names (one per level, e.g. `claude-opus-5-5-high`, `grok-4.7-xhigh`) are taken from that list; it depends on the account. GLM-5.3 isn't in the CLI list either (only in T3 Code's Cursor catalog, as `glm-5p3`), so it has no Cursor launch string.
- **Gemini 4 Argon** is not yet in Gemini CLI's docs, so it has no `gemini-cli` launch string.
- **Gemini CLI's `pro`/`flash` aliases:** the CLI's own docs disagree on what they mean.
- **Kimi K3's release date:** no official page gives one (the K3 blog post is undated), so `released` is left out and its price starts on the day it was read.
- **GPT-6 Astra's API default effort** isn't documented, so it has no `default_effort`.
- **GPT-5.6 Sol's regular price:** only the promotional price is listed ("at least through November 21, 2026"), so its price row has no end date.
- **Grok 4.5 xhigh:** xAI's model page lists it, but its reasoning guide says xhigh is treated as high on grok-4.5; it is left out.
- **OpenCode Zen free models without a disclosed or listed underlying model** (Beam, Flint 40B, MiMo-V2.6-Flash, Nemotron 3.5 Super VL) and Meta's `muse-spark-1.3-contributor` (a separate, cheaper id that may train on your content).
