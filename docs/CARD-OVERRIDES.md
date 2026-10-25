# Card Overrides and Known Issues

Sometimes phase-rs scripts a card wrongly. Heated Argument (SOS) is the first example: when you exile a card for its optional 2 damage, the damage hits you instead of the creature's controller. Other cards it can't run at all, and those are swapped out of packs (FRA swapped about 19 cards per 24-pack draft on 0.115.0). This page covers what we do about such cards:

- **Known issues:** a list of cards that misbehave. Games where one was played get flagged.
- **Card overrides:** small local fixes to phase-rs's card data, written by a person, tested in scripted games and recorded with every event. An override can also make a card the engine couldn't run work as printed, and then the card stops being swapped out of packs ("Supported Cards and Packs").
- **Upstream reports:** a path to turn each fix into a report or patch for phase-rs.

Overrides are a thin, fast layer over upstream phase-rs, like a child theme: every override comes with an upstream-quality fix proposal (`draft-upstream`: the parser or engine change and a test case), and it is dropped as soon as upstream ships an equivalent fix (`check` flags that). The table in "Featured Sets" gives each card's upstream status.

Agents can make a card *suspected*. They can never apply a fix: agents can agree with each other and still be wrong.

```bash
npm run overrides -- list                      # overrides and their status
npm run overrides -- test                      # scripted games: the bug on upstream data, fixed with the override
npm run overrides -- install                   # local dev: apply to data/, install into mtgdt-phase, restart, verify
npm run overrides -- check                     # stale overrides (also part of `npm run deps -- check`)
npm run overrides -- triage --write            # agent reports -> suspected cards in engine/known-issues.json
npm run overrides -- draft-upstream <slug>     # a phase-rs bug report draft; never posts
npm run overrides -- upstream [--set FRA]      # swapped cards vs phase-rs PRs, issues, newest release, coverage (read-only)
```

The code is in `scripts/card_overrides.py` (Python standard library only), `scripts/card-scenario.mjs` (the scripted games) and, for the hosted stack, `packages/director/src/card-overrides.ts` (`apply` in TypeScript, byte-identical) with `stage-card-data.ts`. The overrides are in `engine/overrides/<slug>.json`, and the list of known issues is `engine/known-issues.json`.

## How phase-rs Card Data Works

This was researched on phase-server 0.115.0 (build `6485512`) and still holds on the current pin, 0.116.0 (build `3f79456`, card data `c4cfb737…`).

- **Generated, not hand-written.** `card-data.json` is the output of phase-rs's Oracle-text parser (`oracle-gen`, run by `scripts/gen-card-data.sh` from MTGJSON). Every card's `abilities` / `triggers` / `static_abilities` tree is what the parser made of its Oracle text. phase-rs's `data/overrides/` directory exists but is empty.
- **Shipped beside the binary.** Each release publishes a signed data manifest, `https://data.phase-rs.dev/desktop/release-server-v<version>.json` (signed with minisign; the public key is compiled into the binary). It lists `card-data.json` and `draft-pools.json` with their sha256 and download URLs. For 0.115.0, `card-data.json` is `a81ec87f…`, the same hash `deps/manifest.json` records.
- **Loaded once, from the data directory.** phase-server reads `$PHASE_DATA_DIR/card-data.json` (`/var/lib/phase-server` in the image) when it starts. If the file is missing, it downloads it from the manifest and checks the sha256. A file that is already there is **not** checksummed: any file that deserializes is used. So a patched file in the data volume is all it takes, and nothing has to change in the engine. There is no overlay directory and no per-card flag or environment variable.
- **The catch: silent replacement.** If phase-server can't load the file (bad JSON, a field it doesn't know), it sets the file aside as `card-data.json.unusable` and quietly downloads upstream's. Tested: a broken file came back as `a81ec87f…` with only a log warning. Our defenses:
  - start phase-server with `--no-data-download`, so it fails loudly instead (`npm run overrides -- test` does this);
  - `install` reads the file back after the restart and compares hashes;
  - the Director records the hash of the file itself, so an event can never claim overrides it didn't run.
- **What upstream accepts.** All card fixes go through the parser or the engine. Their `CONTRIBUTING.md` requires changes to `crates/engine/` (game logic, the Oracle parser, effects, targeting) to go through their `/engine-implementer` pipeline, with a final `/review-engine-impl`. Recent card-fix PRs (#10170, #10174, #10116, …) change parser or engine code and add an integration test in `crates/engine/tests/integration/`. There are no data PRs: the data is regenerated. Bugs are filed with the "Card or Rules Bug" issue form (`.github/ISSUE_TEMPLATE/card_bug.yml`).

So an override is a **local stopgap**. What upstream wants from us is a precise bug report (a minimal reproduction, the wrong ability chain, a chain that works, rules references), or a parser or engine PR made their way.

- **Which cards count as unsupported.** `data/unsupported-cards.json` (`scripts/refresh-phase-data.py`; the hosted Director builds the same list) is the union of two sources: the cards whose parsed rules in the pinned build's card data hold an `Unimplemented` or `Unknown` node, and the cards phase-rs's published coverage report (`https://data.phase-rs.dev/coverage-data.json`) marks unsupported. The coverage report is built from their main branch (on 2026-10-23 it matched 0.116.0's card data exactly). Besides unparsed nodes it flags parser warnings: `Swallow:…` (the parser silently dropped a clause, so the data can look complete while missing part of the Oracle text), `ParseWarning:target-fallback`, and `ParserMisfire:InvalidSubtype` (a subtype printed on no card's type line, like Blinkmoth). Most of those flags are real; a few are false positives, and a coverage override can mark such a card supported once scripted games show it plays as printed.

## What Data Can Fix

A fix is expressible as data when the engine already has the effect, target, condition and chain shapes the card needs, and the parser just assembled them wrongly. For example:
- wrong order or nesting of instructions;
- a wrong target reference (one existing `TargetFilter` variant instead of another);
- a wrong optional, condition or "if you do" gate;
- a wrong amount, filter, zone or duration;
- a missing or extra keyword.

It needs engine code when:
- the rules logic itself is wrong: how a reference resolves, replacement and layer effects, trigger timing, state-based actions;
- there is no way to represent the effect at all (Unimplemented mechanics);
- the problem is in the protocol, the UI or phase-ai.

Some engine bugs have a data workaround: an encoding that avoids the broken code path. That is the case for Heated Argument, below. Such workarounds lean on engine internals, so they are pinned to one build and re-tested on every upgrade.

**Heated Argument.** The generated chain is:

```
DealDamage 6 → target creature
  └ ChangeZone Graveyard→Exile (optional; target: a card in your graveyard)
      └ DealDamage 2 → ParentTargetController   (if you did)
```

At resolution, a sub-ability inherits its parent's targets. The exile step's chosen card becomes the parent target of the 2-damage step, so `ParentTargetController` is the exiled card's owner: the caster. A card in exile has no controller at all (CR 109.4). No existing target type means "the controller of the first instruction's target":
- `ParentTargetSlot` names the object, not its controller.
- `PlayerFilter::ParentObjectTargetController` and `ControllerRef::ParentTargetController` read the same inherited target.
- `target_choice_timing: Resolution` on the damage step still showed the bug in testing.

What works is reordering the chain:

```
ChangeZone Graveyard→Exile (optional)
  └ DealDamage 6 → target creature              (sibling: happens whether or not you exile)
      └ DealDamage 2 → ParentTargetController   (a step of the 6 damage, if you did)
```

The 2 damage now inherits the creature. Exiling before the damage instead of after can't be observed:
- it all happens in one resolution, with no priority and no state-based actions in between (CR 704.3);
- triggers wait until the spell finishes resolving (CR 603.3b);
- the 6 damage still targets, so an illegal target still stops the whole spell (CR 608.2b).

Two other encodings were tried and failed tests: a sibling link on the 2 damage dealt it even when the exile was declined, and a continuation link on the 6 damage skipped it on a decline.

## The Override File

`engine/overrides/<slug>.json` (slug = card name in lowercase with hyphens):

| Field | What |
| --- | --- |
| `card` | The card's name, as in `card-data.json` (for a multi-face card, the face's own name, e.g. `Molten Tide`) |
| `status` | `active` (applied), `submitted-upstream` (applied; reported or PR open upstream), `retired` (not applied: fixed upstream or obsolete; the file stays as a record) |
| `kind` | Where upstream should fix it: `parser`, `engine` or `card-data`; or `coverage`: the data already plays as printed and only phase-rs's coverage report flags the card (the patch is `test` operations only, and no case shows a bug) |
| `upstream_issue` | Link to the upstream issue or PR for this card, or null until one exists |
| `marks_supported` | `true` when the override makes a card the engine couldn't run play as printed: while it is applied, the card comes off the unsupported-card list ("Supported Cards and Packs"). Default `false` (Heated Argument was never on the list) |
| `applies_to` | `server_version`, `build_commit`, `card_data_sha256` (upstream file) and **`entry_sha256`**: the sha256 of the card's upstream entry, canonical JSON with sorted keys. The override applies only to exactly that entry. |
| `rules` | `oracle` (Oracle text), `cr` (Comprehensive Rules references), and optionally `actual`, `expected`, `diagnosis`, `suggested_fix`, `override_note` |
| `patch` | An RFC 6902 JSON Patch against the card's entry. `test` operations pin the upstream values the fix assumes. |
| `tests` | Scripted cases (below). At least one must reproduce the bug. |
| `history` | Dated notes: written, re-pinned, submitted, retired |

**Tests.** Each case is one sandbox game. phase-rs's debug actions (`format_config.allow_debug_actions`) build the board, so there is no deck luck and no AI, and `scripts/card-scenario.mjs` answers every prompt.

| Field | What |
| --- | --- |
| `setup` | `[{ card, owner, zone, count?, run_etb?, counters?, tapped?, sick?, prepared? }]` (counters such as `{"loyalty": 3, "P1P1": 2}`; `sick: false` lets a creature attack at once) |
| `phase`, `infinite_mana` | Optional: start in a step of a player's turn (`{"phase": "PreCombatMain", "active": 0}`), and let players pay every cost with the engine's debug infinite mana |
| `steps` | What happens, in order: `cast` (a spell, with targets and an optional `respond`), `play` (a land), `sneak` (cast for its sneak cost), `activate` (an ability by index or text: loyalty, equip, …; with `if_offered`, an ability the unpatched card lacks is recorded as not offered and skipped), `advance` (to a step of a player's turn), `attack`, `block`, `resolve`, `offered` (records whether an action is offered right now, without taking it), or a raw `debug` action. A case with `cast` (and `respond`) instead of `steps` is one cast |
| `answers` | `{ optional: [true/false…], select: [selector], targets: [selector…], unless: [true/false…] }` (`targets`: triggered abilities' targets, in order; `unless`: pay an "unless" cost when asked) |
| `expect` | `fixed` (Oracle behavior), and `bug` (what the unfixed card does) on the cases that reproduce the bug. Each checks any of `life`, `zones`, `objects` (loyalty, counters, power/toughness, tapped, keywords), `hand` and `library` sizes, `winner`, and `offered` |

A case with `expect.bug` must show the bug on upstream data and the fix with the override. A case without one is a guard: it must behave correctly either way, so the override doesn't break the paths that already worked. For a card the engine couldn't run, the bug side is what the unparsed clause does upstream (usually nothing). `scripts/card-scenario.mjs` documents every field.

Heated Argument has four cases:
- exile a card: opponent 20 → 18, caster stays at 20 (upstream: the caster goes to 18);
- decline the exile;
- an empty graveyard;
- the target leaves in response: nothing happens and no card is exiled (CR 608.2b and the card's ruling).

`npm run overrides -- test` passes all four.

## Lifecycle

1. **Suspected.** Either agents report the card, or someone notices.
2. **Confirmed.** A person reproduces the bug in a test case, against Oracle text and the Comprehensive Rules, not against the agents' notes.
3. **Written.** A person, or a dev agent whose work a person reviews, writes the override and its tests. `npm run overrides -- test` must pass both ways.
4. **Applied.** `apply` builds `card-data.json` from the pristine upstream file:
   - Before the first apply, `card-data.json` itself is the upstream file. `apply` copies it to `card-data.upstream.json`, and later runs read that copy.
   - It writes `card-data.json` = upstream + active overrides, plus a sidecar, `card-overrides.json`.
   - The output is deterministic. With no overrides it is byte-identical to upstream; with overrides only the patched cards differ. (phase-rs's own serialization round-trips exactly. JavaScript's would not: the data holds 64-bit integers.)
   - An override whose pinned entry no longer matches upstream is **skipped and reported, never applied**.
   - Locally, `install` does the same to `data/`, copies the result into the `mtgdt-phase` container, restarts it and verifies the hash.
5. **Recorded.** At event start, the Director writes `event_start.provenance.card_data`:
   - `sha256`: the hash of `card-data.json`;
   - from the sidecar: `upstream_sha256`, `overrides_sha256` (the fingerprint: sha256 over the applied override files, like `prompt_sha256`) and `overrides` (their slugs).
   - The sidecar counts only when it describes that exact file. Otherwise the record says `sidecar: "stale"` and claims no overrides.
6. **Watched.** `npm run deps -- check` (weekly) flags an override when:
   - the pinned build moved;
   - the card's upstream entry changed, either in `data/` or in the newest phase-rs release (it downloads that release's card data once, by its manifest);
   - or its upstream issue was closed.
7. **Retired, by a person.** First confirm the fix on the new upstream build: run `npm run overrides -- test <slug> --upstream <new card-data.json>`, where every case should now show `fixed` on upstream data. Then set `status: "retired"`, add a `history` line, and set the known issue to `fixed` with `fixed_in`. If upstream changed the card but didn't fix it, re-pin `applies_to` to the new entry and re-test.

**Never mid-event.** phase-server reads card data only at start. The Director records it at event start.
- `install` refuses while an event looks live (a log written in the last 30 minutes and no summary yet). Restarting phase-server drops live games anyway.
- Apply overrides between events, like an engine upgrade.

## Known Issues and Triage

`engine/known-issues.json` lists cards with a status:
- `suspected`: agents reported it; not verified;
- `confirmed`: reproduced;
- `not-a-bug`: reviewed, and the agents were wrong;
- `fixed`: with `fixed_in`, the phase-rs version that fixed it.

Each entry also has an upstream link, the override that fixes it (if any), a summary, and references to the reports.

`npm run overrides -- triage [--write]` reads `rules_issue` records (from `report_rules_issue`) in `runs/`:
- A card becomes **suspected** when at least two different seats reported it in at least two different games. A seat's repeat reports count once.
- Scripted runs are skipped: smoke events, bot-filled dev events and `rand-*` seats, whose random agents file fake reports. Names that aren't cards are ignored.
- Triage only adds new suspected cards and appends report references. It never changes a status a person set.
- It prints agents' notes for the reviewer, but doesn't store them in the file: agent text stays in the run logs.

## Supported Cards and Packs

Cards the engine can't run are swapped out of boosters (`packages/director/src/boosters.ts`: a supported card of the same rarity from the same sheet; each swap is logged in `packs_opened.swaps`). When an override makes such a card play as printed, it sets `marks_supported: true`, and from then on the card stays in packs:

1. **The sidecar** (`card-overrides.json`) lists the applied overrides' cards under `supported`. A skipped override (stale, or its patch no longer applies) supports nothing, so its card goes back on the list.
2. **The list is adjusted, not rebuilt.** `adjust_unsupported` (`scripts/card_overrides.py`, and `adjustUnsupported` in `packages/director/src/card-overrides.ts`, which agree byte for byte in tests) takes the supported cards off `unsupported` and records them in `removed_by_overrides`. The base list is always `unsupported` + `removed_by_overrides`, so a later adjustment (another override, a retired one, none) starts from the base. Locally `npm run overrides -- apply|install` adjusts `data/unsupported-cards.json`, and `refresh-phase-data.py` applies it to a fresh list; the Director adjusts its list at start (`adjustForOverrides`, `packages/director/src/booster-archive.ts`).
3. **Older events keep their packs.** The previous list is archived by its sha256 before it is rewritten (`data/booster-archive/`, and the Director's `booster-archive`, which the hosted Hub also reads through `HUB_BOOSTER_ARCHIVE_DIRS`). Every event records the hash of the list it ran on (`event_start.boosters.unsupported_sha256`) and its generator, so the Hub and a resumed event regenerate exactly the packs it opened from the archived list (`booster-archive.test.ts` and `packs-generators.test.ts` cover it). Logs from before booster provenance don't name their list; the Hub tries every archived version for them.
4. **A coverage override** (`kind: "coverage"`) is for a card phase-rs's coverage report flags although its data already plays as printed (a false positive): its patch only pins the verified values with `test` operations, and its cases show the printed behavior on the upstream data itself. It changes no card behavior; it only marks the card supported.

Swaps per draft are expected values over the booster sheets (`npm run overrides -- upstream` prints them per set).

## Featured Sets

Every card the eight featured sets swap out of packs on phase-rs 0.116.0, and what we did about it (checked 2026-10-23; `npm run overrides -- upstream` shows the live state). Expected swaps per 24-pack draft (the generator's sheet weights; `upstream` prints them):

| Set | 0.115.0 | 0.116.0 | 0.116.0 + overrides |
| --- | --- | --- | --- |
| FRA | 19.06 (23 cards) | 15.82 (20) | 8.59 (13) |
| SOS | 4.06 (5) | 4.06 (5) | 0.66 (2) |
| TLA | 7.41 (9) | 7.41 (9) | 4.30 (7) |
| ECL | 2.50 (7) | 2.50 (7) | 1.73 (5) |
| EOE | 2.69 (7) | 2.69 (7) | 2.08 (3) |
| MSH | 1.39 (5) | 2.35 (6) | 0.99 (3) |
| TMT | 4.06 (7) | 4.06 (7) | 2.21 (5) |
| HOB | 3.52 (5) | 3.52 (5) | 3.52 (5) |

0.116.0 itself fixed Paradox Shaper, Stingerquill Voxmancer and Woodwork Prodigy (FRA) and broke Titania, Rugged Rumbler (MSH).

**Status:** *Fixed* = an override makes it play as printed (`engine/overrides/<slug>.json`; dropped once upstream ships the fix). *Supported* = a coverage override: the data already plays as printed and the coverage report's flag is a false positive. *Upstream* = fixed on phase-rs main after 0.116.0; it arrives with the next upgrade. *Engine* = needs engine code (a data override can't express it exactly; "Engine Gaps" below has the details for the Jace cards). Rarity in brackets; cards in each set are listed most-opened first.

**FRA (Reality Fracture)**

| Card | Status | Why / what's missing | Upstream |
| --- | --- | --- | --- |
| Sphinx's Approach (C) | Fixed | The "four cards named Sphinx's Approach" clause was unparsed and the "may" was offered with any count; now gated on four copies, exactly four exiled | none (same misparse on Dragon's Approach: issue #8356) |
| Fblthp, Impossibly Lost (U) | Fixed | Trigger mode unknown; now the batched "opponent dealt combat damage during your turn" trigger | none |
| Essence Burn (U) | Fixed | Die-replacement unparsed and the target filter wrong; mirrors the open PR | PR #10032 open → drop when merged and released |
| Recursive Recruitment (U) | Fixed | "A counter for every three cards" unparsed; mirrors the open PR | PR #10219 open → drop when merged and released |
| Warrior's Blades (U) | Fixed | The equip discount per +1/+1 counter on its target was dropped | none |
| Violent Echoes (U) | Upstream | "Empower Jace X, where X is that excess damage" unparsed | PR #10206 merged after 0.116.0 → next release |
| Way of the Mind Sculptor (U) | Engine | No trigger condition can read how many loyalty counters the triggering activation removed (the event carries no cost) | none |
| Loot, the Anomaly (U) | Engine | Combat damage always treats negative power as 0; nothing assigns it "as though his power were positive" | none |
| Ruric Thar, Magecrusher (U) | Engine | No per-object "has dealt combat damage" record; the "has dealt damage" condition also counts noncombat damage | none |
| Command the Stage (U) | Engine | Damage records are dropped at the turn boundary, so "an opponent was dealt noncombat damage last turn" can't be checked; the trigger also sits on the wrong zone | none |
| Jace, Reality Sculptor (R) | Fixed | The [0]'s 25-counter "Activate only" sat on an unparsed sub-ability, so the [0] was always available; [+1] and [−3] tested | none |
| Jace's Machinations (R) | Engine | A spell can grant the instant-speed loyalty permission, but only to the Jaces there as it resolves, not the token it then creates or later Jaces | none |
| Sanctum Lurker (R) | Engine | Nothing exempts planeswalkers from the 0-loyalty state-based action; the granted [+2] already works | issue #9936 (granted ability timing) fixed; the exemption has none |
| Theorist's Sanctum (R) | Engine | Behold can't be paid in an as-enters replacement, so it always enters tapped; the near-exact reveal-land shape takes away the choice to enter tapped | none |
| Pyre Rhymer // Molten Tide (R) | Engine | The delayed "whenever you tap a Mountain for mana" trigger is unknown; High Tide's shape works with manual mana but the bonus mana isn't counted during automatic payment in 0.116.0 | PR #9791 open → wait for it |
| Hall of Echoes (R) | Engine | The temporary "legend rule doesn't apply" effect is locked to the permanents there at resolution | none |
| Tam, the Possibility (R) | Upstream | "Proliferate X times, X = planeswalker types" | PR #10007 merged after 0.116.0 (issue #10135) → next release |
| Extrapolate the Impossible (R) | Engine | No effect has an opponent choose among cards revealed from outside the game | none |
| Seasoned Cryomancer (M) | Fixed | The reflexive "tap up to that many target creatures" was rejected; now counts the nonland discards | none |
| Uldaros Theorix (M) | Engine | No "one target of each card type" constraint, no total mana value budget for casting copies, no "if you cast him" | none |

**SOS (Secrets of Strixhaven)**

| Card | Status | Why / what's missing | Upstream |
| --- | --- | --- | --- |
| Page, Loose Leaf (C) | Fixed | The Grandeur cost was split at the comma in the card's name, so it could never be activated (also Baru, Korlash, Linessa, Oriss, Skoa) | issue #9600 |
| Ennis, Debate Moderator (U) | Fixed | "If one or more cards were put into exile this turn" unparsed | none |
| Nita, Forum Conciliator (R) | Engine | A play-from-exile permission has no "if it would go to a graveyard, exile it instead" rider (also Dire Fleet Daredevil, Mission Briefing) | none |
| Suspend Aggression (R) | Supported | The coverage report's DynamicQty warning is a false positive: each owner may play their card until the end of their next turn | none |
| Ral Zarek, Guest Lecturer (M) | Engine | The [−7]'s target opponent isn't chosen on activation | none |

**TLA (Avatar: The Last Airbender)**

| Card | Status | Why / what's missing | Upstream |
| --- | --- | --- | --- |
| Earth Rumble Wrestlers (C) | Fixed | The "land creature or a land entered this turn" condition was unrecognized (always on) | none |
| Waterbending Lesson (C) | Engine | A waterbend "unless" cost can't be paid during resolution | none |
| Combustion Man (U) | Fixed | "Unless its controller has ~ deal damage to them equal to his power" unparsed | none |
| Hama, the Bloodbender (U) | Engine | No waterbend {X} cost from the card's mana value on a cast permission, no "during your turn" limit | none |
| Diligent Zookeeper (R) | Engine | No per-creature count of its creature types with a maximum | none |
| Firebender Ascension (R) | Engine | Its trigger ("an attacking creature's triggered ability triggers") never fires | PR #10027 (empty draft) |
| The Legend of Yangchen (M) | Engine | Each player chooses (doesn't target) a permanent to exile | none |
| Mirrorwing Dragon (M) | Engine | Spell copies for the casting player, one per other creature | none |
| Scout's Warning (M) | Engine | The flash grant doesn't cover land creature cards | none |

**ECL (Lorwyn Eclipsed)**

| Card | Status | Why / what's missing | Upstream |
| --- | --- | --- | --- |
| Mirrormind Crown (R) | Fixed | The equipped "first token creation each turn" copy replacement was unparsed | issue #7736 |
| Shadow Urchin (R) | Fixed | The "creature with counters dies" trigger was unknown | none |
| Deepway Navigator (R) | Engine | "Attacked with three or more Merfolk this turn" can be counted, but P/T isn't refreshed after the attack declarations are recorded (`game/combat.rs`), so the first combat damage misses the bonus; the workaround isn't exact with extra combats | none |
| Dawnhand Dissident (R) | Engine | A cast permission with a "remove three counters" additional cost | none |
| Grub, Storied Matriarch // Grub, Notorious Auntie (R) | Engine | The token copy doesn't look up "the blighted creature" | none |
| Spry and Mighty (R) | Engine | X = the difference between two chosen creatures' powers | none |
| Mistbind Clique (M) | Engine | The "championed" trigger never fires | none |

**EOE (Edge of Eternities)**

| Card | Status | Why / what's missing | Upstream |
| --- | --- | --- | --- |
| Close Encounter (U) | Engine | The choose-an-object additional cost can't reach exile, and there's no "warped card" filter | none |
| Timeline Culler (U) | Engine | Warp costs can only be mana ("Pay 2 life"), and warp can't be cast from the graveyard | none |
| Requiem Monolith (R) | Fixed | The granted "draw that many cards and lose that much life" was unparsed | none |
| Weftwalking (M) | Engine | "The first spell each player casts each turn" free-cast permission | none |
| Blinkmoth Nexus (R) | Supported | The coverage report rejects the Blinkmoth subtype (printed on no card's type line); the data plays as printed | none |
| Meteor Crater (R) | Fixed | "Choose a color of a permanent you control" unparsed; now one mana of any color among your permanents | none |
| Inkmoth Nexus (M) | Supported | As Blinkmoth Nexus | none |

**MSH (Marvel Super Heroes)**

| Card | Status | Why / what's missing | Upstream |
| --- | --- | --- | --- |
| Iron Fist, Living Weapon (U) | Fixed | The trigger was dropped because the granted ability names Iron Fist; now he gains it himself until end of turn (a card's name in its own text means "this object", CR 201.5) | none |
| Titania, Rugged Rumbler (U) | Engine | New on 0.116.0: "Ward—Discard a card or pay {2}" is unimplemented; a plain triggered ability would work in play but lack the Ward keyword | issue #10096 (ward with non-mana costs) |
| Ms. Marvel, Kamala Khan (R) | Fixed | The granted "base power equal to the cards in your hand" was dropped; now a granted static until end of turn, so it tracks the hand | none |
| Black Panther, Wakandan King (M) | Engine | Moving counters doesn't record how many moved, so "if one or more were moved this way, gain that much life and draw" can't be gated (the draw always happens) | none |
| Concerted Effort (M) | Engine | The landwalk and protection grants are unknown keywords | none |
| Ravenous Tyrannosaurus (M) | Supported | The excess-damage redirect is carried by `DealDamage.excess`, which the coverage report's "instead" check doesn't recognize (also Flame Spill, Pigment Storm) | none |

**TMT (Teenage Mutant Ninja Turtles)**

| Card | Status | Why / what's missing | Upstream |
| --- | --- | --- | --- |
| Karai, Future of the Foot (U) | Supported | "If her sneak cost was paid this turn" is carried by her `CastVariantPaidInstead` condition, which the engine checks against the current turn; the coverage report's check misses it | none |
| Bebop & Rocksteady (R) | Engine | The block trigger can be expressed, but an "unless" cost paid by "you" is offered to the active player (`TargetFilter::Controller` resolves to the active player in `game/effects/mod.rs`), so on a block the opponent is asked. About 300 cards with a controller-paid "unless" cost share this when they resolve on an opponent's turn (Rotting Giant shows it on upstream data) | none |
| Mikey & Don, Party Planners (R) | Engine | The cast-from-the-top permission can't add "enters with an additional +1/+1 counter" | none |
| Ninja Teen (R) | Engine | Casting from the graveyard with an alternative cost works only for blitz and bestow, not sneak | none |
| Turtle Van (R) | Supported | "Target creature that crewed it this turn" (`CrewedThisTurn`) is missed by the coverage report's check; the data plays as printed | none |
| Turtles Forever (R) | Engine | Searching outside the game for exactly four legendary creatures with different names, an opponent choosing two | none |
| Plague of Vermin (M) | Engine | The repeated "each player may pay any amount of life" loop | none |

**HOB (The Hobbit)**

| Card | Status | Why / what's missing | Upstream |
| --- | --- | --- | --- |
| Old Fat Spider Can't See Me (U) | Engine | Prevention shields can't last "for as long as this Saga remains", and "prevent all damage dealt by target creature" collides with the one-shot shield (about 20 cards share it) | none |
| Kíli the Resourceful (R) | Engine | "Pay {0} rather than the equip cost of the first equip ability each turn" | none |
| Riddles in the Dark (R) | Engine | A face-down pile hidden from the opponent who chooses | none |
| Supper for Spiders (R) | Engine | The cards can't enter as Food artifacts in a mass return | none |
| Tom, Bert, and William (R) | Engine | The data shape returns them as creatures that become artifacts just after entering, so "creature enters" triggers would see a creature | none |

## Engine Gaps: the FRA Jace Cards

Empower Jace itself works on 0.116.0; these are the gaps the FRA Jace cards hit, for whoever patches the engine (from the v0.116.0 source):

- **Way of the Mind Sculptor** ("whenever you activate a loyalty ability, if you removed two or more loyalty counters to activate it, draw a card"). `GameEvent::AbilityActivated` (`types/events.rs`) carries the player, source, kind, LKI, trigger state and stack entry, but no cost; `match_loyalty_ability_activated` (`game/trigger_matchers.rs`) checks only kind, actor and card; no `TriggerCondition`, `QuantityRef` or filter property reads an activation's cost, and the fixed `[−N]` path (`planeswalker::finalize_loyalty_activation`) doesn't record the counters removed. Fix: carry `loyalty_counters_removed` on `AbilityActivated` (set in `planeswalker.rs` for `Loyalty { amount < 0 }` and in `casting::record_activated_ability_placed` for taxed and `[−X]` costs), add a `TriggerCondition` (e.g. `LoyaltyCountersRemovedToActivate { minimum }`) evaluated beside `ActivatedAbilityIsNonMana` in `game/triggers.rs`, and parse the phrase in `parser/oracle_trigger.rs`. The data is then `Draw 1` with that condition on `triggers[1]`. No other card has this phrasing.
- **Jace's Machinations** ("until end of turn, you may activate loyalty abilities of Jace planeswalkers you control on any player's turn any time you could cast an instant"). The permission exists: The Wandering Emperor's static `ActivateAsInstant { cost_category: PaysLoyalty }`, checked by `has_activate_as_instant_permission` (`game/restrictions.rs`), lifts the sorcery-speed gate (any turn, non-empty stack) and keeps once per turn; a spell can graft it with `GenericEffect` + `AddStaticMode` until end of turn. But `register_transient_effect` (`game/effects/effect.rs`) binds a broadcast `affected` filter to the objects there at resolution, except for a short list of modes (`MayLookAtFaceDown`, `CastFromHandFree`, `ReduceAbilityCost`, `MustAttackAwayFromSource`). So the Jace token that "Empower Jace 8" creates right after doesn't get it, nor does a Jace that arrives later (CR 611.2c: a rules-modifying effect applies to them). Fix: add `ActivateAsInstant` to that list; the data is then that `GenericEffect` on `abilities[0]`. Related: the Teferi emblems need the permission check to scan the command zone too.
- **Sanctum Lurker** ("planeswalkers you control aren't put into their owners' graveyards for having 0 loyalty"). `game/sba.rs` `check_zero_loyalty` always applies CR 704.5i; no `StaticMode` exempts from it. Fix: a new static mode (e.g. `IgnoreZeroLoyaltySba`, or `SbaExemption { rule: ZeroLoyalty }`) with an `affected` filter, checked in `check_zero_loyalty` like `legend_rule_exempt`, and parsed in `parser/oracle_static`. The granted [+2] already works (on Jace tokens too). No other card has this phrasing.
- **Theorist's Sanctum** ("as this land enters, you may behold a Jace; if you don't, it enters tapped"). The natural shape, an as-enters `MayCost` replacement with `AbilityCost::Behold`, fails at runtime: `pay_replacement_may_cost` (`game/replacement.rs`) has no Behold arm and `supported_at_resolution` (`game/costs.rs`) lists Behold as unsupported, so it always enters tapped. Fix: a Behold arm (choose a Jace you control or reveal one from hand), as for Discard and Exile there.
- **Violent Echoes** is fixed upstream (PR #10206): `EmpowerJace { count: PreviousEffectAmount { channel: Excess } }`, the shape Bolg of the North uses.

## Results Integrity

- **Engine flag `known_issue_card`** (METHODOLOGY §5.6, export 2.14). A game is flagged when a suspected or confirmed card was played in it and the event's card data had no active override for it. The flag also applies to a `fixed` card on a build older than `fixed_in`. It joins the other engine flags in the flagged-versus-unflagged impact test. Games that ran with the override are not flagged: the card behaved as printed.
- **Provenance.** Card overrides change card behavior. They are recorded like the engine build (§3 of METHODOLOGY), and pooled the same way: they make the engine more faithful to the printed cards, and they apply to both players alike.
- **The Hub.** The Hub never re-simulates games, so overrides don't affect its replay or pack checks:
  - packs come from `draft-pools.json` and the unsupported-card list, both recorded by hash in `event_start.boosters`;
  - the base unsupported-card list is computed from the **upstream** file (`refresh-phase-data.py` and `deps manifest` read `card-data.upstream.json` when overrides are applied); an override with `marks_supported` takes its card off it, which changes the list's hash, so the event records which list it ran on ("Supported Cards and Packs").

  The Hub checks the card data an event claims (`provenance.card_data`): it passes when the upstream hash is a pinned build's and the listed overrides hash to this repository's fingerprint (`overridesFingerprint` in `packages/director/src/cards.ts` mirrors the Python one); otherwise the bundle is held for review ("Running It in Production").

## Upstream

**What upstream is doing.** `npm run overrides -- upstream [--set FRA] [--refresh] [--json]` (read-only) lists every card the featured sets swap out of packs (most opened first, with expected swaps per 24-pack draft), our override for it if any, whether the newest phase-rs release's card data parses it without `Unimplemented`/`Unknown` nodes, whether the coverage report (their main branch) lists it as supported, and the phase-rs PRs and issues that name it (`gh search prs|issues --repo phase-rs/phase "<card>"`, spaced for the search rate limit and cached for a day in `tmp/upstream-search.json`; results whose title doesn't name the card are shown as "mentioned in"). Run it before an engine upgrade (UPGRADING.md).

**When upstream fixes a card.** `npm run overrides -- check` (and `npm run deps -- check`) flags an override when its upstream PR is merged or its issue closed, when the newest release parses its card without `Unimplemented` nodes, or when the coverage report lists it as supported. Then: upgrade the pin when that release is out, run `npm run overrides -- test <slug> --upstream <the new card-data.json>`, and retire the override when every case is `fixed` without it ("Lifecycle", step 7).

**Bug report drafts.** `npm run overrides -- draft-upstream <slug>` writes `tmp/upstream-drafts/<slug>.md` in the shape of phase-rs's card-bug form:
- Card(s), build, game mode;
- actual and expected behavior, with Oracle text and CR references;
- the test case as reproduction steps;
- the generated ability chain, a chain that works, and a JSON diff;
- the layer we think should be fixed.

When an issue already exists (Heated Argument: #10205), the draft is a comment for that issue.

The draft **never** names this project. The script refuses to write text that mentions it. **Nothing is posted** by any tool: the owner reads the draft and decides.

A parser or engine PR needs phase-rs's own toolchain and their `/engine-implementer` pipeline, so it is a separate, deliberate piece of work. A good override and its test case are the starting point: the test case maps directly onto one of their integration tests.

## Running It in Production

On the hosted stack (`deploy/compose.yaml`) the overrides reach every game through one more service, `card-data`, which runs before phase-server on the same `phase-data` volume:

1. **Pinned upstream files.** It keeps the volume's `card-data.json` (or its pristine copy, `card-data.upstream.json`) and `draft-pools.json` when they hash to the pinned build's (`deps/manifest.json`); otherwise it downloads them from the pinned release's data manifest (`https://data.phase-rs.dev/desktop/release-server-v<version>.json`) and checks both hashes. A fresh volume downloads about 145 MB once; an engine upgrade replaces the old upstream files the same way.
2. **Apply.** `card-data.json` = upstream + the active overrides, with the sidecar `card-overrides.json`, exactly as `npm run overrides -- apply` writes it. The stage is TypeScript (`packages/director/src/card-overrides.ts`, run by `stage-card-data.ts`), because the Director image has no Python. It is lossless: a byte scanner locates each overridden card's entry, only that entry is parsed (numbers keep their source text, so the 64-bit ids such as `18446744073709551615` survive; objects keep their key order), patched with the same RFC 6902 semantics, serialized as Python does and spliced back. Every other byte is copied. `card-overrides.test.ts` checks a fixture against the Python tool, and with `CARD_DATA_FILE` the real card data (the local CI's integration job runs it): the two write the same bytes.
3. **phase-server starts with `--no-data-download`** once `card-data` is healthy (`depends_on: service_healthy`): a file it can't load stops it, loudly, instead of being swapped for upstream's.
4. **The record.** The Director reads the same volume (read-only), so `event_start.provenance.card_data` names the file phase-server loaded (its `sha256`) and, from the sidecar, the upstream hash, the overrides fingerprint and their slugs. Its unsupported-card list is keyed by the upstream hash; the sidecar's `supported` cards come off it at start ("Supported Cards and Packs").

The stage is idempotent: a restart rewrites nothing when nothing changed. After staging it idles (`sleep`) and reports healthy, so Coolify shows it running; it gets no secrets (`env -i`), runs as uid 999 with a read-only root and only the volume writable. A stale override (upstream changed the card) is skipped and logged (`card-data: SKIPPED override …` in its log), and the event record then claims no override for that card, so its games get the `known_issue_card` flag.

**Deploys.** Adding, changing or retiring an override changes the card data phase-server loads, and it loads card data only at start: `deploy/deploy.sh` treats it like an engine change and refuses while events are live, unless `--drain-events` waits them out (or `--force`). It compares the fingerprint of the active override files in the commit it deploys with the one in the running volume's sidecar. A bare push to the deploy branch doesn't check: look at `/api/capacity` first. A stale override shows as a change at every deploy until it is retired or re-pinned.

**Checking it.** `scripts/image-check.sh` (part of `scripts/ci-local.sh --quick`) boots the stack on fresh volumes and checks that phase-server runs the staged file with `--no-data-download`, that the Director's provenance record names it and the overrides, and plays every active override's scripted games (`scripts/card-scenario.mjs`) on the stack's own phase-server: all cases must come out fixed. On a running host: OPERATIONS.md, "Card data".

**The Hub's check.** Every bundle's `event_start.provenance.card_data` is checked (`provenance.card_data`): it passes when the upstream file is a pinned build's (current or earlier pins: `deps update phase` records the outgoing card-data hash in `phase_rs.history`) with no overrides, or with overrides that hash to this repository's fingerprint (`overridesFingerprint`, the same as the Python tool's). Logs from before card overrides are skipped. Anything else is a provenance warning, which holds the bundle for a reviewer (imports keep a flag). `HUB_ALLOWED_CARD_DATA` adds upstream hashes; `HUB_CHECK_CARD_DATA=0` turns the check off.
