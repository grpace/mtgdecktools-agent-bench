# Protocol

The contract between a seat (an agent) and the table. Draft, build, sideboarding and play all use the same envelope. Seat protocol 0.3 (2026-10-22; the MCP server reports it as its version): matches are best of 3 with sideboarding and the loser's play/draw choice (§3.3). The design draws on sagasti/mtg-bench's decision contract and rs-sdk's two-layer API.

## 1. Core Idea: Legal Options by Construction

At every decision point the engine lists the legal options and the agent picks from them. The agent never has to build a "move" from rules knowledge, so the benchmark measures **judgment**, not syntax.

The cost is that some choices explode combinatorially (mana payment, splitting damage, choosing big subsets of blockers). We break those into a sequence of small choices, or offer a structured answer with validation (§4).

## 2. Decision Envelope

A seat sees one open decision at a time. Every decision has an id, a stage, a kind, a text and its legal options; the seat answers it with the MCP tool `decide` (§6). What the seat reads is the decision **text** (§3); the shapes below are what that text carries and what an answer may contain (`packages/director/src/seat.ts` `Offer`, the `decide` schema in `mcp.ts`).

```ts
// A decision, as the Director holds it. The text a seat reads is built from it (§3).
interface Decision {
  id: string;        // unique per seat; answers must echo it. Prefix by stage: D draft pick, B deck and deck review,
                     // P play or draw, S sideboarding, G game ("D16", "B2", "P3", "S4", "G219")
  phase: "draft" | "build" | "sideboard" | "game";   // "sideboard": the between-games decisions, §3.3
  kind: string;      // see below
  options: Option[]; // legal choices; ids valid for this decision only
}

// A game decision's JSON shows each option as:
interface Option { id: string; action?: string; objects?: number[]; player?: string; attackers?: unknown; blocks?: unknown; label: string }

// The answer: decide(...) (§6). Give the fields the decision takes; anything else is refused, never dropped.
interface Decide {
  decision_id: string;
  option?: string;                         // an option id (draft: the pick's "n"; deck: "auto"; review: "confirm";
                                           // between games: "play" | "draw" | "keep")
  attackers?: number[];                    // game: object ids attacking
  blocks?: { blocker: number; attacker: number }[];
  cards?: number[];                        // deckbuilding and sideboarding: pool numbers, one per copy; games: object ids
  basics?: Record<string, number>;         // deckbuilding and sideboarding: e.g. { "Island": 8 }
  mana?: string[];                         // sources to tap when casting or paying: ["37", "50:U"]
  total_count?: number; deck_name?: string; archetype?: string; analysis?: string;   // deckbuilding only
  note?: string;                           // optional short rationale (at most 600 characters), logged for reports
}
```

There is no per-decision clock, attempt counter or minimum/maximum in the envelope: a refused answer leaves the decision open with the reason (§5), and the inactivity watchdog, with its 30-minute cap on one open decision, is the only time limit today (§5).

**Decision kinds:**
- Draft and deckbuilding: `draft_pick`, `deck_build`, `deck_review` (§3.1, "Deckbuilding").
- Between games (§3.3): `play_draw`, `sideboard`.
- Game decisions: the kind is the engine's own `waiting_for` type, written in words in the decision JSON (`priority`, `mulligan decision`, `declare attackers`, `declare blockers`, `target selection`, `mana payment`, `surveil choice`, `order triggers`, `optional effect choice` and every other type phase-rs asks for) and under its engine name in the log (`decision_offered.kind`: `Priority`, `DeclareAttackers`…). A new engine decision type reaches the seat as is, with the engine's legal actions as options.

**Nothing in a game is delegated to the engine's AI.** Every engine decision with more than one legal action is offered to the seat. A decision with exactly one legal action (other than priority, attackers and blockers) is taken by the Director and logged as `forced`; priority with nothing worth considering is passed and logged as `auto_pass` (§4). Both are counted per seat (`game_over.stats`). In deckbuilding, `option="auto"` lets the reference builder build the deck; it is recorded as delegated (`deck_built.by = "auto"`) and the seat's deck metrics say so.

**Mapping to phase-rs:** the Director reads `waiting_for` + the seat's `legal_actions` from phase-server and turns each `GameAction` into an `Option` with a readable label. A response's option id is turned back into the exact `GameAction`. Attacks and blocks are the exception: they're a structured choice (`attackers: [ids]`, `blocks: [{blocker, attacker}]`), checked by the engine's combat validators, because the engine's own candidate list only offers none / single / all-in.

## 3. The View (What an Agent Sees)

What a decision shows follows the prompts the event runs with (`packages/director/src/observation.ts`): the current prompts in `prompts/`, or an earlier set from `prompts/archive/vN/` (`--prompts prompts/archive/v3`, or just the folder name; old paths such as `prompts/v3` still resolve, `packages/director/src/prompts.ts`). Events record which set (`event_start.prompt_version`: the name of the archived set whose files match the current prompts, or `current` once they differ from every archived set), a content hash of the files seats read (`prompt_sha256`; `setup.md` is left out) and the Director's commit, so nothing is versioned by hand. A change to the current prompts starts a new comparability group; released sets are archived and never edited. Events from before 2026-10-22 ran with the earlier format (§3.2) and keep exactly the texts they had.

### 3.1 Current Format

Every decision is self-contained. It holds everything a player at a real table would know at that moment, and the printed text of every card in view. The agent never has to remember card text from earlier in the game or look it up.

A game decision is a one-line summary, one line saying how to read the JSON, **one JSON object**, and the line saying how to answer. The JSON has four parts:

- **`events_since_last`:** what both players did since your last decision, at most the last 30 (when there were more, `earlier_events` says how many were left out and to call `get_game_log`). Each entry has `turn`, `step`, `text` (the engine's log line, objects as `[#42]`, in the seat's grammar: "You draw a card", "… deals 2 combat damage to you"), `actor` and the object ids it mentions (`cards`). `actor` is the player the line starts with, or the controller of the card that acts in it ("Pia [#48] attacks Opponent", "… deals 2 combat damage …"); lines about something that happens to a card ("… is destroyed") have none.
- **`state`:** the whole game as you can see it.
  - **Match:** game N of best-of-3, earlier results, who was on the play, mulligans. From game 2 on, **match memory** (`opponent_cards_seen`): every card the opponent showed in earlier games of this match (cast or played, on the battlefield, in a graveyard or exile, on the stack, or revealed from its hand to this seat), by name with the most copies seen in any one game. It is public information a player at the table remembers, and nothing that was only ever hidden. Names and counts are on every decision; the printed data of each one that isn't in view is in `cards` at the start of each game (with the decklist) and in `get_view` (mid-game, `get_card` has it).
  - **Turn:** `turn`, `step`, `active`, `priority`, `next_turn`, `day_night`.
  - **`you` / `opponent`:**
    - life and poison;
    - player counters (energy, experience, rad), speed;
    - hand, library, graveyard and exile counts;
    - lands played, spells cast, life gained or lost and cards drawn this turn;
    - designations (monarch, initiative, city's blessing, the Ring, dungeon);
    - mana pool, and `untapped_mana` (`{"total": n, "<color>": [ids]}`: yours exactly what the engine lets you tap for a tap plan, lands and the mana abilities of creatures, artifacts and tokens such as Treasures; the opponent's derived from their untapped lands, rocks and dorks).
  - **Your library:** `library_contents`, your decklist minus your cards seen elsewhere: counts, never the order. At the start of each game (and in `get_view`) also your `decklist`, your `sideboard` and the opponent's `sideboard_count`.
  - **`hand`:** your cards.
  - **`battlefield.you` / `battlefield.opponent`:** every permanent, with its state when it has any: `pt` and `base_pt`, `loyalty`, `defense`, `keywords` (current, with `granted` ones), `counters`, `damage`, `tapped`, `sick`, `attached_to` / `attachments`, `owner` when not the controller, `token`, `copy`, `transformed`, `flipped`, `face_down` (with `face_down_as`: morph, disguise, manifest, cloak), `phased_out`, `prepared`, `class_level`, `doors` (each Room door, locked or unlocked), `case_solved`, `monstrous`, `renowned`, `suspected`, `saddled`, `goaded`, `paired_with`, `chosen` attributes, and changed `type`/`colors`. Identical permanents share one entry with `ids`.
  - **`stack`:** top first, each with `kind`, `controller`, `card`, `source` and `text` for abilities, chosen `targets` and `modes`, `cast_as` (adventure, flashback, warp, prototype…), `x`, `kicked`, `copy`, `copy_of_prepared_spell_on`, and `being_cast` while its costs are paid.
  - **`combat`:** each attacker, what it attacks, and `blocked_by`. Damage order isn't shown: current rules have none.
  - **`graveyard.you` / `graveyard.opponent`, `exile`:** every card, with `owner`, `counters` (time counters…), `permissions` (from the engine: who may cast or play it, for what, until when: on an adventure, foretold, plotted, warped, impulse draws), and `exiled_with` (the card holding it, and whether it returns when that card leaves).
  - **`effects`:** temporary continuous effects in play ("until end of turn" pumps, granted abilities), with source, affected object, changes and duration.
  - **`delayed_triggers`, `emblems`.**
  - **Option links:** any card this seat can use right now says so in `usable_now` ("cast", "play land", "activate: Embalm {3}{U}", "foretell", "turn face up", "cast prepared copy"…). These come from the engine's legal actions, so new mechanics show up without code. The card also lists the `options` of this decision that involve it.
- **`cards`:** the printed data of every card in any visible zone: `name`, `cost`, `mv`, `colors`, `type`, `pt`, `loyalty`, `defense`, `keywords`, `text` (oracle), and for multi-face cards `layout` and every other face in `faces`. That covers both halves of split cards and Rooms, the adventure spell, the other face of transforming and modal DFCs, flip and meld, and a prepare creature's spell. It's printed data; what changed in play is on the object in `state`. Basic lands have no entry.
- **`decision`:** `id`, `kind`, `instruction`, `answer_with`, and `options`, each with `id`, `action`, the object ids it involves (`objects`), the `player` it targets, `attackers`/`blocks` for combat options, and a readable `label`. A card with another castable face is labeled with both ("Cast Beorn, Reluctant Host [#31] {4}{G}, or its adventure Till and Tend {1}{G} (you choose which next)").
  - Activated abilities are labeled with their text: the engine's description, else the line of the printed text (or a token's rules text) that starts with the ability's cost ("Activate Jace [#84]: [−1]: Surveil 1."), else the activated keyword ("Basic landcycling {2}"), else the cost and effect. When nothing is known, "(ability 2)", 1-based, the same number as in `usable_now`.
  - Choices name what they are about: X shows the total cost for each value; "choose one" options show each branch's text; "unless" payments show the cost and what happens if you don't pay; top or bottom names the card; a prepared copy names its spell and cost ("Cast Soul Tether {2}{R/G} (prepared copy from Konstrari Improviser [#69])").
  - A named choice with a long list (a creature type: 381 values) lists only the values among the cards the seat knows of (its deck, everything in view). Any other allowed value is answered by name (`option="Elf"`), checked against the full list; `option="list"` shows the full list.

Object ids (`id`, shown as `[#42]` in labels and events) stay fixed for the whole game.

**Whose choices.** In a simultaneous decision (the London mulligan) phase-server lists every player's choices to every seat that may act, including the other player's bottom cards, and accepts them from either seat. The Director offers each seat only its own: keep or mulligan while it is declaring, and selections of cards from its own hand when it bottoms (`ownActions` in `game.ts`; a `cards` answer naming a card outside the seat's hand is refused).

**Decision ids.** A decision keeps its id while the seat holds it and its options don't change (the opponent mulliganing creates a new engine revision, not a new decision for this seat); the log records the new text as `decision_refreshed`. An answer to an id that is no longer open gets the open decision in the same reply.

**Hidden information.** The Director reads only what the seat may see:
- Libraries are counts, plus your own deduced contents.
- The opponent's hand is a count, plus any card the engine marks as revealed to you (`revealed_hand`).
- The opponent's face-down permanents and exiled cards show only their face-down state: the engine's face-down characteristics (a disguised creature is a 2/2 with ward {2}), counters, tapped, how they were turned face down. Your own show the card underneath as `your_face_down_card` (CR 708.5). That includes your foretold cards, with their foretell cost.
- A card this seat can't identify never shows its class level, permissions or anything else about the card underneath.
- Match memory is built from the same per-seat view, at every engine update of the game (not only at decisions): public zones face up, and hand cards the engine shows this seat. Never a library card, a face-down card, a token, a copy or a "Hidden Card". At game over the other seat's final public zones are added (its socket may close before the last update), never its hand. Recorded per game as `game_over.opponent_cards_seen`.
- Fields are copied from an allowlist; raw engine objects never pass through. phase-server's redacted objects still carry stray characteristics (`layer_base_power` on cards in hands, libraries and face-down exile), and the renderer never reads them.

`render-v4.test.ts` covers this on constructed states and on 25 real engine states from scripted games in 17 sets (`packages/director/test/fixtures/observation/`). In none of them does a hidden id, name or redacted field reach the output.

A real game decision (scripted smoke event; `decision_offered.text` in the event log):

```
[Round 2 of 3, game 3 (best of 3)] Turn 6, YOUR turn, precombat main | You: 20 life, 4 in hand, 3 untapped mana sources (3 U), land played this turn: yes | Opponent: 20 life, 4 in hand, 1 untapped mana source (1 G)
Everything you can see, as JSON: object ids stay fixed for the whole game; "card" names key into "cards" (printed data); "decision" lists your options.
{
 "events_since_last":[
  {"turn":6,"step":"pre combat main","text":"You play Island [#61]","actor":"you","cards":[61]}
 ],
 "state":{
  "match":{
   "game":3,
   "best_of":3,
   "results":[
    {"game":1,"winner":"opponent","turns":26},
    {"game":2,"winner":"you","turns":20}
   ],
   "on_the_play":"opponent",
   "mulligans":{"you":2,"opponent":1}
  },
  "turn":6,
  "step":"precombat main",
  "active":"you",
  "priority":"you",
  "next_turn":"opponent",
  "you":{"life":20,"hand":4,"library":32,"graveyard":0,"exile":1,"lands_played_this_turn":1,"cards_drawn_this_turn":1,"untapped_mana":{"total":3,"U":[47,61,76]},"library_contents":{"note":"your decklist minus your cards seen elsewhere; order unknown","cards":{"Diary of Dreams":1,"Forum Necroscribe":1,"Harmonized Trio":1,"Hydro-Channeler":1,"Island":12,"Orysa, Tide Choreographer":1,"Pensive Professor":1,"Pull from the Grave":1,"Rabid Attack":1,"Scathing Shadelock":1,"Spellbook Seeker":2,"Swamp":9}}},
  "opponent":{"life":20,"hand":4,"library":32,"graveyard":0,"exile":0,"lands_played_this_turn":0,"untapped_mana":{"total":1,"G":[38]}},
  "hand":[
   {"id":70,"card":"Procrastinate","usable_now":["cast"],"options":["2"]},
   {"id":73,"card":"Eternal Student"},
   {"id":63,"card":"Island"},
   {"id":71,"card":"Swamp"}
  ],
  "battlefield":{
   "opponent":[
    {"id":26,"card":"Mage Tower Referee","pt":"2/1","sick":true},
    {"ids":[28,24],"card":"Forest","tapped":true},
    {"id":38,"card":"Forest"}
   ],
   "you":[
    {"id":67,"card":"Landscape Painter","pt":"2/1","prepared":true},
    {"ids":[76,47,61],"card":"Island"}
   ]
  },
  "stack":[],
  "graveyard":{"you":[],"opponent":[]},
  "exile":[
   {"id":81,"card":"Vibrant Idea","copy":true,"copy_of_prepared_spell_on":67,"permissions":["you: may cast it for {4}{U}"],"owner":"you"}
  ]
 },
 "cards":[
  {"name":"Procrastinate","cost":"{X}{U}","mv":1,"colors":"U","type":"Sorcery","text":"Tap target creature. Put twice X stun counters on it. (If a permanent with a stun counter would become untapped, remove one from it instead.)"},
  {"name":"Eternal Student","cost":"{3}{B}","mv":4,"colors":"B","type":"Creature — Zombie Warlock","pt":"4/2","text":"{1}{B}, Exile this card from your graveyard: Create two 1/1 white and black Inkling creature tokens with flying."},
  {"name":"Mage Tower Referee","cost":"{2}","mv":2,"colors":"colorless","type":"Artifact Creature — Construct","pt":"2/1","text":"Whenever you cast a multicolored spell, put a +1/+1 counter on this creature."},
  {"name":"Landscape Painter","cost":"{1}{U}","mv":2,"colors":"U","type":"Creature — Merfolk Wizard","pt":"2/1","text":"This creature enters prepared. (While it's prepared, you may cast a copy of its spell. Doing so unprepares it.)","layout":"prepare","faces":[{"name":"Vibrant Idea","cost":"{4}{U}","mv":5,"colors":"U","type":"Sorcery","text":"Draw two cards."}]},
  {"name":"Vibrant Idea","cost":"{4}{U}","mv":5,"colors":"U","type":"Sorcery","text":"Draw two cards."}
 ],
 "decision":{
  "id":"G219",
  "kind":"priority",
  "instruction":"You have priority. Choose an action, or pass priority.\nWhen casting, you choose which mana sources to tap: add mana=[\"<id>\", …] (e.g. \"50:U\" for a specific color from a multi-color land). Without it you will be asked how to pay.",
  "answer_with":["option","mana"],
  "options":[
   {"id":"1","action":"pass priority","label":"Pass priority"},
   {"id":"2","action":"cast spell","objects":[70],"label":"Cast Procrastinate [#70] {X}{U}"}
  ]
 }
}
DECISION G219 — answer with decide(decision_id="G219", option="<id>" or mana, note="<short reason>").
```

**Special cards and zones.** How each layout and zone state appears, checked against real engine states (scripted games in HOB, SOS, FRA, TLA, MSH, EOE, TMT, DSK, MKM, KHM, OTJ, MID, AKH, NEO, BRO, ZNR and CHK):

| Card or state | Hand | Battlefield | Graveyard / exile | Stack |
|---|---|---|---|---|
| Adventure | `cards` has both halves; cast label names both | creature | exile: permission "on an adventure; may cast the creature" | `cast_as: adventure`, card = the adventure spell |
| Prepare (SOS, FRA) | both faces | `prepared`; `usable_now: cast prepared copy` | exile: the copy, `copy`, `copy_of_prepared_spell_on`, permission with its cost | the copy, `copy_of_prepared_spell_on` |
| Transform / modal DFC | both faces | current face as `card`, `transformed`, the other face in `cards` | both faces | the face being cast |
| Split, Room (DSK) | `"A // B"` with both halves | `doors` locked/unlocked by name | both halves | the half being cast |
| Foretell (KHM, TLA) | `usable_now: foretell` | | yours: `your_face_down_card`, "foretold on turn N; may cast it for {cost}"; theirs: face-down only | |
| Warp, plot, impulse draw | | | permission with who, cost and duration | `cast_as: warp` |
| Flashback, escape, embalm, unearth… | | | `usable_now` from the engine ("activate: Embalm {3}{U}", "cast") | `cast_as: flashback` |
| Morph, disguise, manifest | | yours with the card underneath; theirs face-down state only | | |
| Saga, Class, Case | | `counters.lore`, `class_level`, `case_solved` | | |
| Suspend | | | `counters.time` | |

Not reached by any scripted game, so covered only by constructed states: Case, flip cards, suspend, emblems, monarch and initiative, player counters (energy, experience), meld results.

**Draft picks** show every card in the pack as card JSON (`n` is the option number), with the full text at every pick, and the picks so far by color with costs, types and the curve (each card once, `2×` when you have several copies; the color counts include copies). At Set Context + Human Stats (`primer+stats`), each card also carries `"17lands": "GIH WR …, ATA …"`:

```
DRAFT — Marvel Super Heroes (MSH), 8-player pod. Pack 2 of 3, pick 3 of 14 (passing right).

Your picks so far (16):
  White (3): Red Guardian, Super-Soldier {2}{W} Legendary Creature 2/2; Captain Mar-Vell, Space-Born {4}{W} Legendary Creature 4/4; Patriot, Shield Wielder {1}{W} Legendary Creature 2/2
  Black (1): Stolen Stark Tech {1}{B} Artifact
  Red (7): Hawkeye's Bow {R} Artifact; 2× HULK SMASH! {1}{R} Instant; Machinesmith Automaton {2}{R} Artifact Creature 2/2; Vision of Love {1}{R} Instant; K'un-Lun Warrior {1}{R} Creature 2/2; Lightning Strike {1}{R} Instant
  Green (2): Claim the Kingdom {1}{G} Enchantment; Rapid Rescue {G} Instant
  Multicolor (1): Iron Man, Master of Machines {2}{U}{R} Legendary Artifact Creature 1/4
  Lands (2): Los Diablos Missile Base Land; Plains Basic Land
  Curve (nonland, by mana value): 0:0 1:2 2:8 3:2 4:1 5:1 6+:0 | creatures 6, other spells 8

THIS PACK (one card per line; "n" is the option number):
{"n":1,"rarity":"common","name":"A.I.M. Scientists","cost":"{3}{U}","mv":4,"colors":"U","type":"Creature — Human Scientist Villain","pt":"3/3","keywords":["Typecycling {2}"],"text":"When this creature enters, it connives. (Draw a card, then discard a card. If you discarded a nonland card, put a +1/+1 counter on this creature.)\nBasic landcycling {2} ({2}, Discard this card: Search your library for a basic land card, reveal it, put it into your hand, then shuffle.)"}
{"n":2,"rarity":"common","name":"Ant-Man's Army","cost":"{2}{G}","mv":3,"colors":"G","type":"Creature — Insect","pt":"3/2","text":"When this creature enters, create a Food token or a Treasure token. (A Food token is an artifact with \"{2}, {T}, Sacrifice this token: You gain 3 life.\" A Treasure token is an artifact with \"{T}, Sacrifice this token: Add one mana of any color.\")"}
{"n":3,"rarity":"common","name":"Go Nuts!","cost":"{G}","mv":1,"colors":"G","type":"Sorcery","keywords":["Teamwork 3"],"text":"Teamwork 3 (As an additional cost to cast this spell, you may tap any number of creatures you control with total power 3 or more.)\nChoose one. If this spell was cast using teamwork, choose both instead.\n• Put a +1/+1 counter on target creature.\n• Target creature you control fights target creature an opponent controls."}
…

DECISION D16 — pick one card. Answer with decide(decision_id="D16", option="<n>", note="<short reason>").
```

**Deckbuilding** follows the MTG Deck Tools AI Deck Builder's 40-card Limited path (`packages/director/src/deckbuild-v4.ts`; `deck-parity.test.ts` keeps the two in step):
1. **`YOUR POOL`:** one line of card JSON per card name, sorted by mana value: `n` (the pool number to submit), `count` (copies drafted, the most you may play), `poolNumbers` (every copy's number, when there are several), `rarity`, the full printed card (`name`, `cost`, `mv`, `colors`, `colorIdentity`, `type`, `pt`, `keywords`, full `text`, every other face in `faces`) and `17lands` (Set Context + Human Stats only). Drafted basic lands aren't listed: basics are unlimited.
2. **`POOL FACTS`:** JSON the Director counted: cards, creatures and two-drops per color group (copies included, hybrid cards on their own), the copies, non-basic lands and the colors they make, and castable cards per color pair.
3. **The rules** (`prompts/deckbuilding-guide.md`): comparative analysis, curve and consistency, the Rule of One, splash land math, interaction, enablers and payoffs, composition, the mana base and hybrid audit, the Golden Rule, copies, the 40-card rule, the final check, and how to answer. Set context rules only at the Set Context levels; the hybrid section only when the pool has hybrid costs. No level carries MTG Deck Tools tier scores or the deck builder's Tier Score Guide: agents judge card power themselves, with the `17lands` stats at Set Context + Human Stats.

The answer is `decide(cards=[pool numbers, one per copy], basics={"Plains": 8, …}, total_count, deck_name, archetype, analysis, note)`. Repeating a pool number takes another copy of the same card, so `[12, 12]` and `[12, 31]` are the same. Rejected (decision stays open, every problem listed): a number outside the pool, more copies than drafted ("You drafted 2 copies of Powerful Broker (pool numbers 12, 31); your deck asks for 3."), an unknown basic land, fewer than 40 cards. A valid deck isn't locked yet: the Director answers with a **`DECK REVIEW`** decision, its exact count as JSON (total, basics, lands, creatures, curve, Deck Mana Colors, cards/pips/sources per color, each card once with its count and pool numbers) and `flags` for every way the deck breaks the rules (more than 40 cards, a wrong `total_count`, uncastable cards, splash land math, off-color lands or basics, land count, two-drops, copies left in the sideboard). The agent confirms (`option="confirm"`) or resubmits once; a resubmitted deck locks at once. `deck_built` logs the resolved `pool_numbers`, the review, every rejected answer and the agent's own fields.

`get_view` returns the current `state` and `cards` in full (decklist and sideboards included); `get_card` returns one card's JSON.

**Cost.** The current format spends tokens on context the agent would otherwise have to keep in mind. Measured on the same decisions rendered in each layout (`MTGDT_OBS_COMPARE=<file.jsonl>` on the Director, then `scripts/measure-observation.py`). The sample is 6 scripted events in FRA, TLA, MSH, HOB, DSK and SOS: 2,960 game decisions and 468 picks. Token counts use o200k BPE (tiktoken) as a proxy, since Claude's tokenizer isn't public; chars/4 runs about 20% lower for JSON.

| Per decision | earlier format mean | p95 | current mean | p95 |
|---|---|---|---|---|
| Game decision | 575 | 965 | 2,455 | 3,783 |
| Draft pick | 567 | 934 | 1,146 | 1,736 |

Deckbuilding, measured separately: the current offer (2026-10-22, 9 real pools from FRA, TLA, MSH and HOB, 42 cards each) is 6,844 tokens at No Set Context, 7,048 at Set Context and 8,133 at Set Context + Human Stats on average (largest 8,420), against 5,662 / 5,691 / 6,438 for the first current-format offer; the review adds about 1,100 (18 reviews: mean 1,077, max 1,221). The set context isn't repeated in the offer (6k–14k tokens; every seat has it from the event start and `get_set_context`).

Where a game decision's tokens go (mean): `cards` 1,361, battlefield 306, decision and options 206, header and answer line 141, graveyards 135, events 132, library contents 127, hand 54. Full card text for graveyard and exile cards, rather than name and type, raised the game decision from about 1,520 to 2,275 tokens in the text layout. Per game seat, scripted games ran about 100 decisions (53k earlier vs 227k current). Real LLM games so far average about 54 decisions, which projects to roughly 31k vs 133k.

Layouts compared on the same decisions:
- **One structured JSON object (adopted):** 2,455 tokens per game decision.
- **The earlier text layout** (summary, log lines and numbered options as text around the JSON state and card table): 2,275 tokens, 8% less.

Both read correctly in a check with Claude Haiku: 4 short seats, 73 game decisions, no illegal or rejected answer, and life, turn and hand reported correctly at the end. The structured object makes options machine-checkable (each lists the objects it involves) and was adopted.

Other alternatives:
- **Send each card's text only the first time in a game** (the earlier format): 37% less. Rejected: decisions would again depend on context from long ago, which harnesses compact away.
- **Printed data inline in every object:** 5% more than the table, and no extra information.

### 3.2 Earlier Format (Events Before 2026-10-22)

A text board: life and zone counts, each battlefield, the stack, combat, your hand with costs and types, graveyard names, and a "Card reference" block with the rules text of cards **the first time they're seen in the game** (`get_card` afterwards). Draft picks show rules text the first time a card name is seen in the draft. Options are numbered text lines.

- Card ids (`[#12]`) stay the same for the whole game, so agents can refer to cards across turns.
- The "Since your last decision" section means an agent doesn't have to diff whole states itself. This matters most for agents seeing the board through MCP.

### 3.3 Between Games: Play or Draw, and Sideboarding (Best of 3)

Every match is best of 3 (best of 1 was removed on 2026-10-22). Each match starts from the deck the seat registered at deckbuilding (`deck_built`); between games (`sideboard.ts`):

1. **Play or draw.** Game 1: the event seed picks who plays first (reproducible, secret until the event ends). Before games 2 and 3 the loser of the previous game chooses; after a drawn game, the player who chose for it chooses again (after a drawn game 1, the player who was on the play). The chooser gets a `play_draw` decision (`PLAY OR DRAW — …`, id `P<n>`): `decide(option="play" | "draw", note)`; anything else is refused. The other seat is told the choice. phase-server picks its own starting player (a d20 roll) and has no option for it, so the Director creates the game again until the chosen player is on the play (a new game takes about 50 ms; no update reaches a seat before the right game is found; `game_start.starter.games_created` counts the tries; after 24 tries the game is played as created, with `starter.honored: false` and a `starter_mismatch` record).
2. **Sideboarding.** Then both seats at the same time get a `sideboard` decision (`SIDEBOARDING — …`, id `S<n>`): the score and earlier games, who plays first, **your deck** as card JSON exactly as at deckbuilding (`n`, `count` = copies in the deck, `poolNumbers`, the full printed card, and 17Lands data at Set Context + Human Stats) with your basics, **your sideboard** the same way (drafted basics aren't listed: basics are unlimited), the **match memory** (the opponent's cards you saw, with the most copies seen in one game and their printed data) and the opponent's deck and sideboard sizes before their sideboarding, which are public. The answer is `decide(option="keep", note)` or the whole deck again, `decide(cards=[pool numbers, one per copy], basics={…}, note)`, validated exactly like deckbuilding (`resolveSubmission`: pool numbers only, at most the copies drafted, basics unlimited, at least 40 cards; every problem listed, decision stays open). `keep` with a deck is refused. There is no review round: the accepted answer states the swaps ("Deck for game 2: +2 Plummet, −2 Shock. 40 cards, 17 lands.") and notes any card the new mana can't cast. The decision text ends with the current deck as a ready-made answer.
3. **Hidden information.** Neither seat sees the other's changes, only the resulting deck size (the game-start notice: "Your opponent's deck: 40 cards."; the first game decision's `sideboard_count`). The opponent's sideboard contents stay hidden; only the count is public. Cards an opponent showed are in the match memory.
4. **Forfeits.** The inactivity watchdog applies (§5): an inactive chooser plays first, an inactive seat keeps its current deck (`by: "forfeit"`).
5. **Set Context.** At the Set Context levels a fresh harness session reads it before its first between-games or game decision (§6).

Log records: `play_draw_offered { seat, id, match, game_number, text }`; `play_draw { match, game_number, on_play, by: "seed" | "agent" | "forfeit", chooser, choice, note?, latency_ms? }` (one per game, game 1 included; a voided game is replayed with the same choice); `sideboard_offered { seat, id, match, game_number, text }`; `sideboarded { seat, match, game_number, by: "agent" | "forfeit", kept, in: [{name, qty}], out: [{name, qty}], main, sideboard, basics, main_count, note?, rejected?, latency_ms }` (`in`/`out` against the deck played in the previous game; basic land changes included); `game_start.deck_sizes` and `game_start.starter { seat, games_created }`; `event_start.sideboarding: true` and `play_draw: "loser-chooses"`. A resumed event reuses what the log holds and asks only what it doesn't.

## 4. Priority, Stops and Auto-Pass

A naive engine asks for priority dozens of times per turn. That is the biggest cost and latency risk in the whole project.

- **Smart stops** (`game.ts` `shouldAutoPass`; the only stop policy built). The agent is asked for priority only when it has a legal non-pass action worth considering at that step (its own main phases and declare-blockers step; the opponent's declare-attackers, declare-blockers and end steps), or when the opponent's spell or ability is on top of the stack. Every other priority is passed automatically and logged as `auto_pass`, so reports can audit it. An "ask at every priority" policy for ablations is not built.
- **Agent-set yields** (like Arena's controls, `pass_until(…)`): not built.
- **Mana payment:** default `manual` (`--mana`, `event_start.mana`); `auto` lets the engine's auto-tapper pay everything and is an ablation.
  - Spells: the agent adds `mana=["37", "50:U"]` to the cast, and the Director taps those sources one by one when the engine asks for the payment; without a plan the seat gets a `ManaPayment` decision (tap plan, or the auto-tapper option, counted as `auto_tapper`).
  - Mana sources: phase-server offers a land's mana as `TapLandForMana` and every other mana ability (mana creatures, mana rocks, Treasures) as a plain `ActivateAbility` that it marks `is_mana_ability` (`mana-sources.ts`). Both work in a tap plan. A Treasure is sacrificed by its own activation. For an "any color" source the engine asks the color next (`ChooseManaColor`): the Director answers with the plan's `:U` suffix, else a color the cost still needs (logged `pay_color`). A mana ability with a cost of its own (mana, or another card to choose) can't be in a plan; it is an option in the `ManaPayment` decision.
  - When the mana pool already pays the whole cost (the agent picked its sources as options one at a time, or floated mana), the Director finishes the payment itself (`pay_finish` with `from_pool`, and `by_hand` when the agent's own picks paid it): it counts as a manual payment, never as `auto_tapper`. `auto_tapper` counts only the auto-tapper option chosen while the pool falls short.
  - Activated abilities and prepared copies have no manual payment in the engine, which spends floating mana first. With a plan the Director taps the planned sources into the pool, then activates. Without one the engine's auto-tapper pays: the log says so (`agent_decision.payment: "auto"`), and it counts as `auto_paid` in `game_over.stats`, never as a manual payment. If the engine taps more sources after the plan, the decision is logged `payment: "manual+auto"` with `auto_tapped`. A plan given for an option that costs no mana is refused.

## 5. Clocks and Budgets

Magic needs a chess clock. Without one, slow models just win on patience.

**What is built: an inactivity forfeit, not a clock.** A seat with an open decision that has made no MCP request for 10 minutes (`SEAT_TIMEOUT_MS`) has it settled by the Director: a bot-policy pick, the reference deck, between games the current deck kept and play first, or the game conceded (the match continues). Logged as `forfeit` records and counted under reliability (METHODOLOGY §5.5). A decision still open after 30 minutes (`DECISION_MAX_MS`) is settled the same way even if the seat has kept calling, logged with `reason: "decision_limit"`. Headless launchers relaunch a harness session that exits early, and the seat resumes. The ideas below (per-decision timeouts, banks, censoring) are not built.

- **Per decision:** soft timeout (default 300 s; harnesses differ a lot in speed, so this is generous). On timeout, the engine's AI decides and it's logged as `forfeit_decision`.
- **Per match:** a wall-clock bank plus a token bank (whichever runs out first). An empty bank means every later decision is made by the engine's AI. If more than X% of a match's decisions are forfeited, the match is a loss.
- **Illegal or malformed answers:** (built) the decision stays open with the reason ("Not accepted: …"); an option the engine refused is hidden for the rest of that turn. Every refusal is counted (`rejections`). Nothing is delegated. There is no limit on attempts.
- If a harness dies or disconnects (crash, rate limit, context exhaustion), the seat is held while the runner or the user restarts the thread; the decision clock pauses up to a reconnect grace period. Infrastructure failures are **never counted as misplays**. If a seat can't come back, the match is censored and replayed, not scored (mtg-bench lesson). Today a silent seat is settled by the inactivity watchdog above instead, and a game it concedes is left out of the rating (METHODOLOGY §5.5).

## 6. MCP Tool Surface

The Director serves MCP over Streamable HTTP. Each seat has its own URL (`/mcp/<seat-token>`), so a thread only ever holds its own seat. Long-polls return within ~45 s to stay under harness tool-call timeouts; the agent simply calls again.

**Turn loop (the core)**
| Tool | Purpose |
|---|---|
| `wait_for_decision()` | Long-poll (about 40 s). Returns the next decision (with any notices before it: the briefing, round and game results), or a status line saying what the seat is waiting for and what is still to come, or the final `EVENT COMPLETE` text. |
| `decide(decision_id, option \| attackers \| blocks \| cards [+ basics and the deck fields] \| mana, note)` (between games: `option="play"`/`"draw"`, or `option="keep"` or `cards` + `basics`) | Answer the open decision. Returns `Accepted.` followed by the next decision (or the status line, if none follows within ~2.5 s), or `Not accepted: <reason>` with the decision still open. |

**Answers are applied whole or not at all.** A structured answer (`attackers`, `blocks`, `cards`) is the seat's exact intent and wins over `option`: both may be given when they say the same (the option's attackers, blocks or cards match the list), and if they disagree the answer is refused ("…disagree; nothing was applied") with the decision still open. Fields a decision doesn't take (`blocks` at priority, `cards` in a draft pick, `basics` in a game, `mana` without the option it pays for) are refused the same way, never dropped; an empty list for a field the decision doesn't take is ignored. In deckbuilding, `option="auto"` with a deck is refused, and `option="confirm"` with a deck at the review is accepted only if it is the deck shown. In sideboarding, `option="keep"` with a deck is refused.

**Delivery.** Every decision is delivered in full once. A call that would return the same decision text moments (under 30 s) after another call returned it, which happens when a harness calls `decide` and `wait_for_decision` in parallel, gets one line instead: "Decision G45 is open; its full text is in your decide result from moments ago…". A later call gets the full text again, so a session that lost it can recover. A `wait_for_decision` that runs while an answer is being processed waits for what comes next and never returns the decision being answered.

**The briefing.** The first result of the event starts with the briefing: the format in one sentence, the Limited fundamentals, and, when the event includes the Set Context, how many parts it has. The Set Context is never inline: `get_set_context(part)` returns one part of at most 24,000 characters (split at headings), with "part 1 of 3" and the next call at its end, so no result is too long for a harness to show (Claude Code moves results over about 50 KB to a file the seat can't read). A new harness session for a seat that was already briefed (an MCP `initialize` from a relaunched harness) gets a resume briefing first: where the event stands (in a match: the seat's own score in games so far, never its opponent), the format and fundamentals again, and the Set Context parts. The open decision is then sent in full again, under the same id.

**Reading the Set Context (Set Context levels).** Every harness session reads the Set Context before its first game decision (or play/draw or sideboarding decision, which a fresh session meets first). Until the session has called `get_set_context` (any part), such a decision is answered with a reminder instead ("Before your first game decision in this session, read the Set Context for this format: call get_set_context(part=1), then part=2 and part=3. Then call wait_for_decision…"); the decision stays open, unchanged, and nothing is decided for the seat, and a `decide` on it is refused the same way. Draft and deckbuilding decisions are never held. The rule is the same for every seat and every session, rotated or not: a long session that read it during the draft plays on, a fresh one reads it again. So a fresh session never plays with less knowledge than a long one. Logged once per session as `set_context_reminder`.

**Fresh sessions on purpose (`bench play --fresh-session per-game|per-match|off`; per game is the default for seats `bench new`, `bench setup` and `bench lobby join` launch).** A launcher may end a seat's harness session at a boundary and start a fresh one, so that requests stay small: when the deck is locked, then after every game (`per-game`) or every match (`per-match`). The fresh session gets the resume briefing like any relaunch; every game decision already carries the board, the card text, the decklist and the match so far. The boundary signal is `GET /mcp/<seat-token>/progress`: `{ deck_locked, games_finished, matches_finished, done, deciding, sessions }` for that seat only. It is not an MCP tool, says nothing the seat doesn't know, and is not activity for the inactivity watchdog (a launcher that only polls can't keep a silent seat alive). `bench play` polls it every 3 seconds and ends the session only when no `decide` call is in progress (`deciding: false`), so an answer is never cut off; decision ids are stable, so an answer the old session sent is applied once and a late duplicate is refused ("not open"). The switch takes seconds, far inside the 10-minute inactivity limit. The policy is declared when the event is created and logged per seat (`event_start.seats[].context_policy`: `fresh-per-game` | `fresh-per-match`; absent: one conversation, as for every seat seated by hand). Lobby seats declare it at join (`POST /api/lobby/join`, `seats[].context_policy`, docs/LOBBY.md §5.1), and the fired table logs it the same way. `--fresh-session off` at `bench new` / `bench setup` keeps one session for the launched seats too.

**Looking around (rate-limited: every tool call of a seat shares one limit, by default 600 requests per minute and 4 in flight, `MCP_RATE_PER_MIN` / `MCP_INFLIGHT_PER_SEAT`)**
| Tool | Purpose |
|---|---|
| `get_view()` | The full current game view (state and cards, decklist and sideboards). Outside a game: "You are not in a game right now." |
| `get_card(name)` | One card's printed data, as card JSON (older events: one text line). By name only. |
| `get_set_context(part?)` | The MTG Deck Tools Set Context for the format, in events that include it, one part per call (default part 1). Events run with `prompts/archive/v1`–`v3` have `get_set_primer(part?)` instead (the same parts, under its earlier name). |
| `get_game_log(last_n?)` | The last lines (default 60, at most 300) of the seat's current game log. |
| `report_rules_issue(card, note)` | Flag a card that seems to behave wrong. Feeds the engine-issue flags on games and the set page's engine section. Never affects the game. |

Not built (ideas): `set_yield`, `get_zone`, `search_rules`, `card_stats`, per-seat notes (`notes_read` / `notes_write`), `get_card` by object id.

**Draft, build and between games** use the same `wait_for_decision` / `decide` loop (`draft_pick`, `deck_build` and `deck_review` kinds, §3.1; events in the earlier format had no review; `play_draw` and `sideboard`, §3.3). There are no special tools, so an agent written for the game loop works for the draft unchanged.

### Turn Flow Between Two Agents

```
agent A                 table server                      agent B
   │ wait_for_decision ──▶ (A has priority)                  │ wait_for_decision (blocks)
   │◀── priority request ──│                                  │
   │ decide(cast c40) ────▶│── engine resolves / B gets priority ─▶ priority request (respond?)
   │ wait_for_decision     │◀── decide(pass) ─────────────────│
   │◀── next request ──────│                                  │ wait_for_decision (blocks)
```

The engine thread blocks on whoever holds the decision. The other seat's long-poll simply waits. Nothing is shared between the agents except the server.

## 7. Wire Protocols

- **Director ↔ phase-server:** phase-rs's own JSON-over-WebSocket protocol (`ClientHello` → `CreateGameWithSettings`/`JoinGame` → `StateUpdate{state, legal_actions, events}` → `Action{GameAction}`), pinned to the exact protocol version of our engine image. Only the Director speaks it.
- **Seat ↔ Director:** MCP over Streamable HTTP, one URL per seat (`/mcp/<seat-token>`), using **our** envelope. MCP is the only seat interface today (plus the launcher's `GET /mcp/<seat-token>/progress`, §6); a plain JSON HTTP API with the same operations, for a web UI for humans or custom clients, is an idea, not built.
- **Event log:** one append-only JSONL file per event (`runs/<id>/events.jsonl`). Every pack, pick, deck, decision offered (with the text the seat read), answer, refusal, auto-pass, forced action, forfeit, game and match result, turn snapshot and rules-issue report goes in, with wall time per decision. Harness-reported usage stays in separate files (`usage-<seat>.json`) collected by the runner. These files are the source of truth. Everything in analysis is derived from them. The engine's own replay log (seed, decks and actions, for re-simulating games) is not recorded: phase-server has no settable seed or replay log yet, so game replay verification is future work (METHODOLOGY §3.1).

## 8. Rounds and Pairings: What a Seat Is Told

Every event seats 8 agents and plays a **3-round Swiss** by default (METHODOLOGY §3.2); Private Tables may choose a round robin. The tool surface and the decision envelope don't change. What a seat sees:

- **Welcome notice** (first `wait_for_decision`, the briefing, §6): the format in one sentence, e.g. "This event is an 8-player Reality Fracture booster draft, then deckbuilding, then 3 rounds of best-of-3 matches with sideboarding against other agents (Swiss pairings: round 1 is random, then each round pairs players with similar records, and you never meet the same opponent twice)." The MCP instructions carry the same format.
- **Round start** (a notice with the next decision): "Round 2 of 3: your best-of-3 match against another agent is starting." Each round is paired only when every match of the previous round has finished, so a seat may wait 10–30 minutes between rounds.
- **Game decisions** start with the round and game, never a seat name: `[Round 2 of 3, game 1 (best of 3)] Turn 6, …`. Seat names are for logs and spectators only.
- **While waiting** (the status line `wait_for_decision` returns after ~40 s without a decision): what is left, e.g. "Waiting: 1 more match to play (round 3 of 3 is paired when every match of round 2 has finished; other agents are still playing). Keep calling wait_for_decision until a result says EVENT COMPLETE…". A bye (odd dev tables only) says "You have no match in round 2 of 3 (a bye)."
- **EVENT COMPLETE**: every round with its result and games, opponents lettered in the order met ("another agent (opponent B)"), and the totals.

What a seat is never told: who its opponents are (name, model, harness, contributor), where they sit, other seats' records or the pairing standings, or the seed. Its own record is in the per-game and per-match notices. Seat names never appear in anything a seat reads (decision texts, `get_view`, the game log; `game.test.ts` checks it). Seats are named `seat-<hex>` at every table (lobby, Private Tables, one-shot events), never after their model, and anonymous status shows no live standings (LOBBY.md, SPECTATING.md), so a seat that finds a running event can't tell its opponent from it.

**Log records** (for verifiers; not shown to seats):
- `event_start.pairing`: `{ format: "swiss" | "round-robin", rounds, version }` (`version` is `PAIRING_VERSION` in `packages/director/src/pairings.ts`: 4 from Oct 23, 2026 (version 3's rules with the pairing identity model/effort, so two harnesses of one model and level are a mirror); 3 earlier that day (before the last round, mirror avoidance with the smallest record-group float; the last round strictly by points); 2 briefly before it (strictly by points every round); 1 for earlier logs. A resumed event keeps its logged version, and the Hub verifies each log against its own version).
- `event_start.agent_order`: agent names in request order; agent *i* sits at the seed's shuffled position *i*.
- `event_start.table` (hosted contributor events): `{ kind: "lobby" | "private", queue?, table_id?, schedule?, occurrence? }`; `event_start.seats[]` of lobby tables add `contributor_id` (the Hub's opaque id) and `contributor` (the handle, only when the contributor shows it publicly).
- `round_start`: `{ round, rounds, format, pairs: [[a, b], …], byes: […] }`, logged when the round is paired.
- `event_start.dev_bot_fill: true` marks a dev event with bot drafters (Smoke, never rated).
- `event_start.seats[].context_policy`: `fresh-per-game` or `fresh-per-match` when the seat was declared with a fresh-session policy (§6); absent otherwise.
- `seat_session`: `{ seat, session, resumed, stage, games_finished, matches_finished }`, for every harness session of a seat after its first (a relaunch, or a fresh session at a boundary).
- `set_context_reminder`: `{ seat, session, decision, games_finished }`, when a session was held at a game decision until it read the Set Context (§6), once per session.
- `game_over.opponent_cards_seen`: `{ <seat>: { <card name>: copies } }`, the opponent's cards each seat saw in that game (§3.1, match memory); later games of the match carry the most copies of each name seen in one game.
