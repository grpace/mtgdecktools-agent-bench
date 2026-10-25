/**
 * The game layer between phase-server and the seats (game.ts) and the seat's delivery rules (seat.ts), driven by
 * scripted engine updates, with no phase-server: whose choices a seat is offered, what a seat may learn about its
 * opponent, decision ids, event lines, ability labels, manual mana for abilities, and the briefing's size.
 *   npx tsx packages/director/src/game.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CardDb } from './cards.js';
import { eventEntry, Game, ownActions } from './game.js';
import { splitSetContext, SET_CONTEXT_PART_CHARS } from './knowledge.js';
import { loggablePath, setContextPart } from './mcp.js';
import type { PhaseUpdate } from './phase.js';
import { AgentSeat, type Offer } from './seat.js';

let passed = 0;
const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

// --- a tiny card database (phase-rs card-data.json shape) ---------------------------------------------------------
const cost = (generic: number, ...shards: string[]) => ({ type: 'Cost', generic, shards });
const type = (core: string[], sub: string[] = [], sup: string[] = []) => ({ supertypes: sup, core_types: core, subtypes: sub });
const raw: Record<string, any> = {
  'grizzly bears': { name: 'Grizzly Bears', mana_cost: cost(1, 'Green'), card_type: type(['Creature'], ['Bear']), power: { type: 'Fixed', value: 2 }, toughness: { type: 'Fixed', value: 2 }, oracle_text: '', keywords: [], layout: 'normal' },
  'forest': { name: 'Forest', mana_cost: { type: 'NoCost' }, card_type: type(['Land'], ['Forest'], ['Basic']), oracle_text: '({T}: Add {G}.)', keywords: [], layout: 'normal' },
  'mountain': { name: 'Mountain', mana_cost: { type: 'NoCost' }, card_type: type(['Land'], ['Mountain'], ['Basic']), oracle_text: '({T}: Add {R}.)', keywords: [], layout: 'normal' },
  'secret morph': { name: 'Secret Morph', mana_cost: cost(4, 'Black'), card_type: type(['Creature'], ['Horror']), power: { type: 'Fixed', value: 5 }, toughness: { type: 'Fixed', value: 5 }, oracle_text: 'Morph {3}{B}', keywords: [], layout: 'normal' },
  "lich's relic": { name: "Lich's Relic", mana_cost: cost(3), card_type: type(['Artifact'], ['Equipment']), oracle_text: 'Equipped creature gets +2/+1.\nEquip {2}', keywords: [], layout: 'normal' },
  'apex witchstalker': { name: 'Apex Witchstalker', mana_cost: cost(4, 'Green'), card_type: type(['Creature'], ['Spider']), power: { type: 'Fixed', value: 5 }, toughness: { type: 'Fixed', value: 4 }, oracle_text: 'Menace\nBasic landcycling {2} ({2}, Discard this card: Search your library for a basic land card, reveal it, put it into your hand, then shuffle.)', keywords: ['Menace', { Typecycling: { cost: cost(2), subtype: 'Basic Land' } }], layout: 'normal' },
};
const dir = mkdtempSync(join(tmpdir(), 'mtgdt-game-'));
writeFileSync(join(dir, 'card-data.json'), JSON.stringify(raw));
const cards = new CardDb(join(dir, 'card-data.json'), dir);

function obj(id: number, name: string, owner: number, zone: string, extra: Record<string, unknown> = {}): any {
  const info = raw[name.toLowerCase()];
  return {
    id, name, owner, controller: owner, zone, tapped: false, face_down: false, counters: {}, keywords: [], attachments: [],
    card_types: info?.card_type ?? type([]), color: [], mana_cost: info?.mana_cost ?? { type: 'NoCost' },
    power: info?.power?.value ?? null, toughness: info?.toughness?.value ?? null, base_power: info?.power?.value ?? null, base_toughness: info?.toughness?.value ?? null,
    display_visible_to_viewer: true, abilities: [], ...extra,
  };
}
const hidden = (id: number, owner: number, zone: string) => ({ ...obj(id, 'Hidden Card', owner, zone), card_types: type([]), display_visible_to_viewer: undefined });

/** The opening hands: seat 0 holds 1–7, seat 1 holds 11–17. Each player's projection hides the other's hand. */
function mulliganState(viewer: number, pending: any[]): any {
  const objects: Record<string, any> = {};
  for (let i = 1; i <= 7; i++) objects[i] = viewer === 0 ? obj(i, i % 2 ? 'Forest' : 'Grizzly Bears', 0, 'Hand') : hidden(i, 0, 'Hand');
  for (let i = 11; i <= 17; i++) objects[i] = viewer === 1 ? obj(i, i % 2 ? 'Mountain' : 'Grizzly Bears', 1, 'Hand') : hidden(i, 1, 'Hand');
  return {
    turn_number: 1, phase: 'Untap', active_player: 0, priority_player: 0,
    players: [
      { id: 0, life: 20, hand: [1, 2, 3, 4, 5, 6, 7], library: [], graveyard: [], mana_pool: { mana: [] } },
      { id: 1, life: 20, hand: [11, 12, 13, 14, 15, 16, 17], library: [], graveyard: [], mana_pool: { mana: [] } },
    ],
    battlefield: [], exile: [], stack: [], objects,
    waiting_for: { type: 'MulliganDecision', data: { pending, free_first_mulligan: false } },
  };
}

/** What phase-server sends every acting seat during a simultaneous mulligan: everyone's choices (seat-agnostic). */
function mulliganLegal(pending: any[]): any[] {
  const out: any[] = [];
  for (const e of pending) {
    if (e.phase.type === 'BottomCards') {
      const hand = e.player === 0 ? [1, 2, 3, 4, 5, 6, 7] : [11, 12, 13, 14, 15, 16, 17];
      for (const id of hand) out.push({ type: 'SelectCards', data: { cards: [id] } });
    } else {
      out.push({ type: 'MulliganDecision', data: { choice: { type: 'Keep' } } }, { type: 'MulliganDecision', data: { choice: { type: 'Mulligan' } } });
    }
  }
  return out;
}

let rev = 0;
const update = (state: any, legal: any[], extra: Partial<PhaseUpdate> = {}): PhaseUpdate => ({
  revision: ++rev, state, legal, autoPassRecommended: false, events: [], logEntries: [], byObject: {}, ...extra,
});

/** A game between two seats with stubbed engine sockets: every action is accepted and recorded. */
function newGame(names: [string, string] = ['claude-opus-5-5-3', 'gpt-6-astra-6']) {
  const seats: [AgentSeat, AgentSeat] = [new AgentSeat(names[0], 0), new AgentSeat(names[1], 1)];
  const logged: Array<Record<string, unknown>> = [];
  const deck = { main_deck: [...Array(20)].map(() => 'Forest').concat([...Array(20)].map(() => 'Grizzly Bears')), sideboard: [] };
  const game = new Game('ws://unused', cards, seats, [deck, deck], (t, d) => logged.push({ type: t, ...d }), `${names[0]} vs ${names[1]} — game 1`, 'manual',
    { match: `${names[0]} vs ${names[1]}`, game_number: 1 }, undefined,
    { observation: 'v4', seatLabel: 'Round 1 of 3, game 1 (best of 1)', match: { game: 1, bestOf: 1, results: [] } });
  const sent: [any[], any[]] = [[], []];
  const players = (game as any).players as any[];
  players.forEach((pl, i) => {
    // Wire the seat's views (get_view, get_game_log) as play() would, without a socket.
    pl.phase.connect = async () => {};
    void (game as any).attach(pl);
    pl.phase.act = async (a: unknown) => {
      sent[i]!.push(a);
      return { ok: true };
    };
  });
  const feed = (slot: number, u: PhaseUpdate) => (game as any).onUpdate(players[slot], u);
  return { game, seats, logged, sent, feed, players };
}

/** The JSON object of a game decision (between the two header lines and the answer line). */
const body = (text: string) => JSON.parse(text.split('\n').slice(2, -1).join('\n'));
const optionValues = (o: Offer | undefined) => (o?.options ?? []).map((x) => x.value as any);

// --- 1. Mulligans: each seat is offered only its own choices ---------------------------------------------------------

test('simultaneous mulligan: each seat gets only its own choice, never the opponent\'s bottom cards', () => {
  const { seats, feed } = newGame();
  // Seat 0 mulliganed once and must bottom a card; seat 1 still decides keep or mulligan.
  const pending = [
    { player: 0, mulligan_count: 1, phase: { type: 'BottomCards', count: 1, then: { type: 'Keep' } } },
    { player: 1, mulligan_count: 0, phase: { type: 'Declare' } },
  ];
  const legal = mulliganLegal(pending);
  feed(0, update(mulliganState(0, pending), legal));
  feed(1, update(mulliganState(1, pending), legal));
  const a = seats[0].pending!;
  const b = seats[1].pending!;
  // Seat 0: its seven bottom choices, all from its own hand; no keep/mulligan (that is seat 1's choice).
  assert.equal(a.options.length, 7);
  assert.ok(optionValues(a).every((v) => v.type === 'SelectCards' && v.data.cards.every((id: number) => id <= 7)));
  assert.match(a.text, /Choose 1 card\(s\) from your hand to put on the bottom/);
  // Seat 1: keep or mulligan only; nothing about seat 0's hand.
  assert.deepEqual(b.options.map((x) => x.label), ['Keep this hand', 'Mulligan']);
  assert.ok(!b.text.includes('Hidden Card'), 'seat 1 was offered the opponent\'s hidden cards');
  for (const id of [1, 2, 3, 4, 5, 6, 7]) assert.ok(!b.text.includes(`[#${id}]`), `seat 1 learned the opponent's hand id #${id}`);
});

test('ownActions: both seats bottoming, or only one seat pending', () => {
  const both = [
    { player: 0, mulligan_count: 1, phase: { type: 'BottomCards', count: 1, then: { type: 'Keep' } } },
    { player: 1, mulligan_count: 2, phase: { type: 'BottomCards', count: 2, then: { type: 'Keep' } } },
  ];
  const legal = mulliganLegal(both);
  assert.deepEqual(ownActions(mulliganState(0, both), 0, legal).map((a) => a.data.cards[0]), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(ownActions(mulliganState(1, both), 1, legal).map((a) => a.data.cards[0]), [11, 12, 13, 14, 15, 16, 17]);
  // Seat 1 already kept: it isn't pending, so it has nothing to decide even if the list says otherwise.
  const one = [both[0]];
  assert.deepEqual(ownActions(mulliganState(1, one), 1, mulliganLegal(one)), []);
  // Other decisions pass through unchanged.
  const prio = [{ type: 'PassPriority' }];
  assert.equal(ownActions({ waiting_for: { type: 'Priority' } }, 0, prio), prio);
});

test('a bottom-cards answer with the opponent\'s card ids is refused', async () => {
  const { seats, feed, sent } = newGame();
  const pending = [{ player: 0, mulligan_count: 1, phase: { type: 'BottomCards', count: 1, then: { type: 'Keep' } } }];
  feed(0, update(mulliganState(0, pending), mulliganLegal(pending)));
  const id = seats[0].pending!.id;
  const reply = await seats[0].decide({ decision_id: id, cards: [12] });
  assert.match(reply, /#12 is not in your hand/);
  assert.equal(sent[0].length, 0);
});

// --- 5. The same decision re-issued keeps its id -------------------------------------------------------------------

test('mulligan decision keeps its id while the opponent mulligans, and an answer to it is accepted', async () => {
  const { seats, feed, sent, logged } = newGame();
  const pending = [{ player: 0, mulligan_count: 0, phase: { type: 'Declare' } }, { player: 1, mulligan_count: 0, phase: { type: 'Declare' } }];
  feed(0, update(mulliganState(0, pending), mulliganLegal(pending)));
  const first = seats[0].pending!.id;
  // The opponent mulligans (a new revision); this seat's choice is the same.
  const after = [{ player: 0, mulligan_count: 0, phase: { type: 'Declare' } }, { player: 1, mulligan_count: 1, phase: { type: 'Declare' } }];
  feed(0, update(mulliganState(0, after), mulliganLegal(after)));
  feed(0, update(mulliganState(0, after), mulliganLegal(after)));
  assert.equal(seats[0].pending!.id, first);
  assert.equal(logged.filter((r) => r.type === 'decision_withdrawn').length, 0);
  assert.equal(logged.filter((r) => r.type === 'decision_offered' && r.seat === seats[0].name).length, 1);
  const reply = await seats[0].decide({ decision_id: first, option: '1' });
  assert.match(reply, /^Accepted\./);
  assert.deepEqual(sent[0], [{ type: 'MulliganDecision', data: { choice: { type: 'Keep' } } }]);
});

// --- 2. No seat names in anything a seat reads -----------------------------------------------------------------------

test('seat-facing texts never name either seat (decision header, get_view, the game log)', async () => {
  const names: [string, string] = ['claude-opus-5-5-3', 'gpt-6-astra-6'];
  const { seats, feed } = newGame(names);
  await new Promise((r) => setTimeout(r, 0));
  const pending = [{ player: 0, mulligan_count: 0, phase: { type: 'Declare' } }, { player: 1, mulligan_count: 0, phase: { type: 'Declare' } }];
  const entry = { turn: 1, phase: 'Untap', segments: [{ type: 'PlayerName', value: { name: names[1], player_id: 1 } }, { type: 'Text', value: ' draws a card' }] };
  feed(0, update(mulliganState(0, pending), mulliganLegal(pending), { logEntries: [entry] }));
  feed(1, update(mulliganState(1, pending), mulliganLegal(pending), { logEntries: [entry] }));
  for (const s of seats) {
    const texts = [s.pending!.text, s.views!.view(), s.views!.log(50)];
    for (const t of texts) for (const n of names) assert.ok(!t.includes(n), `${s.name} read a seat name: ${n}`);
    assert.ok(s.pending!.text.startsWith('[Round 1 of 3, game 1 (best of 1)] '));
  }
});

// --- 8. Event lines: who acted, grammar ------------------------------------------------------------------------------

test('events: the actor of combat lines is the card\'s controller; "You draw", "to you"', () => {
  const state = { objects: { '48': { controller: 0 }, '60': { controller: 1 } } };
  const card = (id: number, name: string) => ({ type: 'CardName', value: { name, object_id: id } });
  const you = { type: 'PlayerName', value: { name: 'x', player_id: 0 } };
  const them = { type: 'PlayerName', value: { name: 'y', player_id: 1 } };
  const text = (value: string) => ({ type: 'Text', value });
  const line = (...segments: any[]) => eventEntry({ turn: 3, phase: 'CombatDamage', segments }, 0, state);
  assert.deepEqual(line(card(48, 'Pia'), text(' deals 2 combat damage to '), them), { turn: 3, step: 'combat damage', text: 'Pia [#48] deals 2 combat damage to Opponent', actor: 'you', cards: [48] });
  assert.equal(line(card(60, 'Bear'), text(' deals 2 combat damage to '), you).text, 'Bear [#60] deals 2 combat damage to you');
  assert.equal(line(card(60, 'Bear'), text(' deals 2 combat damage to '), you).actor, 'opponent');
  assert.equal(line(card(48, 'Pia'), text(' attacks '), them).actor, 'you');
  assert.equal(line(card(48, 'Pia'), text(' is destroyed')).actor, undefined);
  assert.equal(line(you, text(' draws a card')).text, 'You draw a card');
  assert.equal(line(you, text(' shuffles their library')).text, 'You shuffle your library');
  assert.equal(line(you, text(' searches their library')).text, 'You search your library');
  assert.equal(line(you, text(' has no cards')).text, 'You have no cards');
  assert.equal(line(them, text(' draws a card')).text, 'Opponent draws a card');
  assert.equal(line(them, text(' draws a card')).actor, 'opponent');
  assert.equal(line(text('Turn 3 — '), you).text, 'Turn 3 — You');
});

test('events: more than 30 since the last decision are cut, and the decision says how many and where to read them', () => {
  const { seats, feed } = newGame();
  const pending = [{ player: 0, mulligan_count: 0, phase: { type: 'Declare' } }];
  const entries = [...Array(42)].map((_, i) => ({ turn: 1, phase: 'Untap', segments: [{ type: 'Text', value: `event ${i}` }] }));
  feed(0, update(mulliganState(0, pending), mulliganLegal(pending), { logEntries: entries }));
  const b = body(seats[0].pending!.text);
  assert.equal(b.events_since_last.length, 30);
  assert.equal(b.earlier_events, '+12 earlier events since your last decision; call get_game_log to read them');
  assert.equal(b.events_since_last[0].text, 'event 12');
});

// --- 7. Readable options -----------------------------------------------------------------------------------------------

function priorityState(objects: any[], extra: Record<string, unknown> = {}): any {
  const byId: Record<string, any> = {};
  for (const o of objects) byId[o.id] = o;
  return {
    turn_number: 5, phase: 'PreCombatMain', active_player: 0, priority_player: 0,
    players: [
      { id: 0, life: 20, hand: objects.filter((o) => o.zone === 'Hand' && o.owner === 0).map((o) => o.id), library: [], graveyard: [], mana_pool: { mana: [] } },
      { id: 1, life: 20, hand: [], library: [], graveyard: [], mana_pool: { mana: [] } },
    ],
    battlefield: objects.filter((o) => o.zone === 'Battlefield').map((o) => o.id), exile: [], stack: [], objects: byId,
    waiting_for: { type: 'Priority', data: { player: 0 } }, ...extra,
  };
}
const tapFor = (id: number, color: string) => ({ type: 'TapLandForMana', data: { selection: { source: { object_id: id }, mana_type: color } } });

test('ability labels: the printed line for its cost, the keyword, one 1-based number in labels and usable_now', () => {
  const { seats, feed } = newGame();
  // A planeswalker token without ability descriptions (FRA's Jace), its rules text from the engine.
  const jace = obj(84, 'Jace', 0, 'Battlefield', {
    is_token: true, loyalty: 5, card_types: type(['Planeswalker'], ['Jace']), token_rules_text: '[−1]: Surveil 1.\n[−3]: Draw a card.',
    abilities: [{ cost: { type: 'Loyalty', amount: -1 } }, { cost: { type: 'Loyalty', amount: -3 } }],
  });
  const witch = obj(25, 'Apex Witchstalker', 0, 'Hand', {
    keywords: [{ Typecycling: { cost: cost(2), subtype: 'Basic Land' } }],
    abilities: [{ cost: { type: 'Composite', costs: [{ type: 'Mana', cost: cost(2) }, { type: 'Discard', self_ref: true }] } }],
  });
  const heart = obj(83, 'Heartwood', 0, 'Battlefield', { is_token: true, card_types: type(['Artifact']), abilities: [{ cost: { type: 'Composite', costs: [{ type: 'Tap' }, { type: 'Sacrifice', self_ref: true }] }, effect: { type: 'GainLife' } }] });
  const legal = [
    { type: 'PassPriority' },
    { type: 'ActivateAbility', data: { source_id: 84, ability_index: 0 } },
    { type: 'ActivateAbility', data: { source_id: 84, ability_index: 1 } },
    { type: 'ActivateAbility', data: { source_id: 25, ability_index: 0 } },
    { type: 'ActivateAbility', data: { source_id: 83, ability_index: 0 } },
  ];
  const byObject = { '84': legal.slice(1, 3), '25': [legal[3]], '83': [legal[4]] };
  feed(0, update(priorityState([jace, witch, heart]), legal, { byObject }));
  const labels = seats[0].pending!.options.map((x) => x.label);
  assert.deepEqual(labels.slice(1), [
    'Activate Jace [#84]: [−1]: Surveil 1.',
    'Activate Jace [#84]: [−3]: Draw a card.',
    'Activate Apex Witchstalker [#25]: Basic landcycling {2}',
    'Activate Heartwood [#83]: {T}, Sacrifice this: gain life',
  ]);
  const state = body(seats[0].pending!.text).state;
  const j = state.battlefield.you.find((x: any) => x.id === 84);
  assert.deepEqual(j.usable_now, ['activate: [−1]: Surveil 1.', 'activate: [−3]: Draw a card.']);
});

test('X, branches, unless costs, top or bottom, prepared copies: options say what they do', () => {
  const { seats, feed, players } = newGame();
  const fireball = obj(70, 'Fireball', 0, 'Stack', { mana_cost: cost(0, 'X', 'Red') });
  feed(0, update(priorityState([fireball], { waiting_for: { type: 'ChooseXValue', data: { player: 0, min: 0, max: 2, pending_cast: { object_id: 70 }, x_cost_previews: [[0, cost(0, 'Red')], [1, cost(1, 'Red')], [2, cost(2, 'Red')]] } } }),
    [{ type: 'ChooseX', data: { value: 0 } }, { type: 'ChooseX', data: { value: 2 } }]));
  let o = seats[0].pending!;
  assert.match(o.text, /Choose X for Fireball \[#70\] \{X\}\{R\} \(X from 0 to 2\)/);
  assert.deepEqual(o.options.map((x) => x.label), ['X = 0 (total cost {R})', 'X = 2 (total cost {2}{R})']);
  seats[0].clear();
  feed(0, update(priorityState([obj(71, 'Grizzly Bears', 0, 'Battlefield')], { waiting_for: { type: 'ChooseOneOfBranch', data: { player: 0, controller: 0, source_id: 71, branches: [], branch_descriptions: ['Draw a card.', 'Gain 3 life.'] } } }),
    [{ type: 'ChooseBranch', data: { index: 0 } }, { type: 'ChooseBranch', data: { index: 1 } }]));
  o = seats[0].pending!;
  assert.match(o.text, /Grizzly Bears \[#71\]: choose one\./);
  assert.deepEqual(o.options.map((x) => x.label), ['Choose: Draw a card.', 'Choose: Gain 3 life.']);
  seats[0].clear();
  feed(0, update(priorityState([obj(72, 'Grizzly Bears', 1, 'Battlefield')], { waiting_for: { type: 'UnlessPayment', data: { player: 0, cost: { type: 'Mana', cost: cost(3) }, pending_effect: { source_id: 72 }, effect_description: 'Counter target spell unless its controller pays {3}' } } }),
    [{ type: 'PayUnlessCost', data: { pay: false } }, { type: 'PayUnlessCost', data: { pay: true } }]));
  o = seats[0].pending!;
  assert.match(o.text, /Grizzly Bears \[#72\]: Counter target spell unless its controller pays \{3\}\. Pay \{3\}\?/);
  assert.deepEqual(o.options.map((x) => x.label), ["Don't pay", 'Pay {3}']);
  seats[0].clear();
  feed(0, update(priorityState([obj(73, 'Forest', 0, 'Library')], { waiting_for: { type: 'TopOrBottomChoice', data: { player: 0, object_id: 73 } } }),
    [{ type: 'ChooseTopOrBottom', data: { top: false } }, { type: 'ChooseTopOrBottom', data: { top: true } }]));
  assert.deepEqual(seats[0].pending!.options.map((x) => x.label), ['Put Forest [#73] on the bottom', 'Put Forest [#73] on top']);
  seats[0].clear();
  // "As an additional cost, pay {4} or sacrifice a creature": yes pays the first cost, no the second.
  const choice = { type: 'Choice', data: [{ type: 'Mana', cost: cost(4) }, { type: 'Sacrifice', target: { type: 'Typed' } }] };
  feed(0, update(priorityState([obj(74, 'Grizzly Bears', 0, 'Stack')], { waiting_for: { type: 'OptionalCostChoice', data: { player: 0, cost: choice, pending_cast: { object_id: 74 } } } }),
    [{ type: 'DecideOptionalCost', data: { pay: false } }, { type: 'DecideOptionalCost', data: { pay: true } }]));
  assert.match(seats[0].pending!.text, /Pay the optional additional cost \(\{4\} or sacrifice a permanent\) for Grizzly Bears \[#74\]\?/);
  assert.deepEqual(seats[0].pending!.options.map((x) => x.label), ['Sacrifice a permanent instead', 'Pay {4}']);
  seats[0].clear();
  const improviser = obj(69, 'Grizzly Bears', 0, 'Battlefield', { prepared: true, back_face: { name: 'Soul Tether', mana_cost: cost(2, 'RedGreen') } });
  feed(0, update(priorityState([improviser]), [{ type: 'PassPriority' }, { type: 'CastPreparedCopy', data: { source: 69 } }]));
  assert.equal(seats[0].pending!.options[1]!.label, 'Cast Soul Tether {2}{R/G} (prepared copy from Grizzly Bears [#69])');
  void players;
});

test('a named choice with hundreds of values lists the likely ones and takes any value by name', async () => {
  const { seats, feed, sent } = newGame();
  const types = ['Advisor', 'Bear', 'Elf', 'Horror', 'Zombie', ...[...Array(380)].map((_, i) => `Type${i}`)];
  const legal = types.map((t) => ({ type: 'ChooseOption', data: { choice: t } }));
  feed(0, update(priorityState([obj(90, 'Grizzly Bears', 0, 'Battlefield')], { waiting_for: { type: 'NamedChoice', data: { player: 0, choice_type: 'CreatureType', options: types } } }), legal));
  const o = seats[0].pending!;
  assert.ok(o.text.length < 8_000, `named choice text is ${o.text.length} chars`);
  const listed = body(o.text).decision.options.map((x: any) => x.label);
  assert.deepEqual(listed, ['Choose Bear']);
  assert.match(o.text, /any other of the 385 allowed values works too: give its name as the option \(option=list shows them all\)/);
  assert.match(await seats[0].decide({ decision_id: o.id, option: 'Nonsense' }), /not one of the 385 allowed values/);
  assert.match(await seats[0].decide({ decision_id: o.id, option: 'list' }), /Every allowed value \(385\): Advisor, Bear, Elf/);
  assert.match(await seats[0].decide({ decision_id: o.id, option: 'zombie' }), /^Accepted\./);
  assert.deepEqual(sent[0], [{ type: 'ChooseOption', data: { choice: 'Zombie' } }]);
});

// --- 6. Manual mana for abilities ------------------------------------------------------------------------------------

test('an ability with a mana cost: the tap plan is carried out before activating, and logged truthfully', async () => {
  const { seats, feed, sent, logged, players } = newGame();
  const relic = obj(24, "Lich's Relic", 0, 'Battlefield', { abilities: [{ cost: { type: 'Mana', cost: cost(2) }, description: 'Equip {2}' }] });
  const lands = [obj(19, 'Forest', 0, 'Battlefield'), obj(23, 'Forest', 0, 'Battlefield'), obj(27, 'Forest', 0, 'Battlefield')];
  const equip = { type: 'ActivateAbility', data: { source_id: 24, ability_index: 0 } };
  const byObject = { '19': [tapFor(19, 'Green')], '23': [tapFor(23, 'Green')], '27': [tapFor(27, 'Green')], '24': [equip] };
  const s0 = priorityState([relic, ...lands]);
  feed(0, update(s0, [{ type: 'PassPriority' }, equip], { byObject }));
  const o = seats[0].pending!;
  assert.match(o.text, /When activating an ability with a mana cost \(and prepared copies\) take mana=/);
  assert.ok(body(o.text).decision.answer_with.includes('mana'));
  // The stub engine: each tap answers with a state where that land is tapped (an update reaches the game).
  const tapped = new Set<number>();
  players[0].phase.act = async (a: any) => {
    sent[0].push(a);
    if (a.type === 'TapLandForMana') tapped.add(a.data.selection.source.object_id);
    const st = priorityState([relic, ...lands.map((l) => ({ ...l, tapped: tapped.has(l.id) }))]);
    const left = Object.fromEntries(Object.entries(byObject).filter(([id]) => !tapped.has(Number(id))));
    // After the activation the opponent has priority: nothing for this seat to decide.
    feed(0, update(st, a.type === 'TapLandForMana' ? [{ type: 'PassPriority' }, equip] : [], { byObject: left }));
    return { ok: true };
  };
  const reply = await seats[0].decide({ decision_id: o.id, option: '2', mana: ['19', '23'] });
  assert.match(reply, /^Accepted\./);
  assert.deepEqual(sent[0].map((a) => a.type), ['TapLandForMana', 'TapLandForMana', 'ActivateAbility']);
  const d = logged.find((r) => r.type === 'agent_decision' && r.id === o.id)!;
  assert.equal(d.choice, "Activate Lich's Relic [#24]: Equip {2} (tapping Forest [#19], Forest [#23])");
  assert.equal(d.payment, undefined);
  assert.equal(((players[0] as any).manualPayments), 1);
});

test('an ability activated without a plan is recorded as paid by the engine; mana on a land play is refused', async () => {
  const { seats, feed, logged, players } = newGame();
  const relic = obj(24, "Lich's Relic", 0, 'Battlefield', { abilities: [{ cost: { type: 'Mana', cost: cost(2) }, description: 'Equip {2}' }] });
  const land = obj(30, 'Forest', 0, 'Hand');
  const equip = { type: 'ActivateAbility', data: { source_id: 24, ability_index: 0 } };
  const play = { type: 'PlayLand', data: { object_id: 30 } };
  feed(0, update(priorityState([relic, land]), [{ type: 'PassPriority' }, play, equip]));
  const o = seats[0].pending!;
  assert.match(await seats[0].decide({ decision_id: o.id, option: '2', mana: ['19'] }), /has no mana cost to pay/);
  assert.match(await seats[0].decide({ decision_id: o.id, option: '3' }), /^Accepted\./);
  const d = logged.find((r) => r.type === 'agent_decision' && r.id === o.id && r.accepted)!;
  assert.equal(d.choice, "Activate Lich's Relic [#24]: Equip {2}");
  assert.equal(d.payment, 'auto');
  assert.equal((players[0] as any).autoPaid, 1);
  assert.equal((players[0] as any).manualPayments, 0);
});

// --- 6b. Manual mana from creatures, artifacts and Treasures (ActivateAbility mana abilities) -------------------------

const manaAbility = (produced: any, abilityCost: any = { type: 'Tap' }) => ({ is_mana_ability: true, cost: abilityCost, effect: { type: 'Mana', produced } });
const ANY = { type: 'AnyOneColor', count: { type: 'Fixed', value: 1 }, color_options: ['White', 'Blue', 'Black', 'Red', 'Green'] };
const sacSelf = { type: 'Composite', costs: [{ type: 'Tap' }, { type: 'Sacrifice', target: { type: 'SelfRef' }, count: 1 }] };

/**
 * A stub engine for one manual payment, shaped like phase-server 0.115 (checked against a live server): lands tap with
 * TapLandForMana; a mana creature, a mana rock and a Treasure are ActivateAbility actions (the Treasure is sacrificed);
 * an "any color" source asks ChooseManaColor next; the payment stays open with a full pool until PassPriority.
 */
function paymentBench(spellCost: any, spellId = 40) {
  const g = newGame();
  const objects: any[] = [
    obj(17, 'Forest', 0, 'Battlefield'),
    obj(19, 'Noxious Newt', 0, 'Battlefield', { card_types: type(['Creature']), abilities: [manaAbility({ type: 'Fixed', colors: ['Green'] })] }),
    obj(64, "Potioner's Trove", 0, 'Battlefield', { card_types: type(['Artifact']), abilities: [manaAbility(ANY)] }),
    obj(82, 'Treasure', 0, 'Battlefield', { is_token: true, card_types: type(['Artifact'], ['Treasure']), abilities: [manaAbility(ANY, sacSelf)] }),
    obj(85, 'Gruul Signet', 0, 'Battlefield', { card_types: type(['Artifact']), abilities: [manaAbility({ type: 'Fixed', colors: ['Red', 'Green'] }, { type: 'Composite', costs: [{ type: 'Mana', cost: cost(1) }, { type: 'Tap' }] })] }),
    obj(spellId, 'Grizzly Bears', 0, 'Stack'),
  ];
  const pool: Array<{ color: string }> = [];
  let waiting: any = { type: 'ManaPayment', data: { player: 0 } };
  let pendingColor: number | undefined;
  const state = () => {
    const s = priorityState(objects.filter((o) => o.zone !== 'Graveyard'), { waiting_for: waiting, pending_cast: waiting.type === 'Priority' ? undefined : { object_id: spellId, cost: spellCost } });
    s.players[0].mana_pool = { mana: pool.map((m) => ({ ...m, restrictions: [] })) };
    return s;
  };
  const sources = () => objects.filter((o) => o.zone === 'Battlefield' && !o.tapped && o.id !== spellId);
  const byObject = () => Object.fromEntries(sources().map((o) => [String(o.id), o.name === 'Forest' ? [tapFor(o.id, 'Green')] : [{ type: 'ActivateAbility', data: { source_id: o.id, ability_index: 0 } }]]));
  const legal = () => {
    if (waiting.type === 'ChooseManaColor') return ['White', 'Blue', 'Black', 'Red', 'Green'].map((c) => ({ type: 'ChooseManaColor', data: { choice: { type: 'SingleColor', data: c }, count: 1 } }));
    if (waiting.type === 'ManaPayment') return [{ type: 'PassPriority' }, ...sources().filter((o) => o.name !== 'Forest').map((o) => ({ type: 'ActivateAbility', data: { source_id: o.id, ability_index: 0 } })), { type: 'CancelCast' }];
    return [];
  };
  const push = () => g.feed(0, update(state(), legal(), { byObject: waiting.type === 'Priority' ? {} : byObject() }));
  g.players[0].phase.act = async (a: any) => {
    g.sent[0].push(a);
    const o = objects.find((x) => x.id === (a.data?.source_id ?? a.data?.selection?.source?.object_id));
    if (a.type === 'TapLandForMana') {
      o.tapped = true;
      pool.push({ color: a.data.selection.mana_type });
    } else if (a.type === 'ActivateAbility') {
      const ab = o.abilities[0];
      if (ab.cost.type === 'Composite' && ab.cost.costs.some((c: any) => c.type === 'Sacrifice')) o.zone = 'Graveyard';
      else o.tapped = true;
      if (ab.effect.produced.type === 'AnyOneColor') {
        pendingColor = o.id;
        waiting = { type: 'ChooseManaColor', data: { player: 0 } };
      } else pool.push(...ab.effect.produced.colors.map((c: string) => ({ color: c })));
    } else if (a.type === 'ChooseManaColor') {
      pool.push({ color: a.data.choice.data });
      pendingColor = undefined;
      waiting = { type: 'ManaPayment', data: { player: 0 } };
    } else if (a.type === 'PassPriority' && waiting.type === 'ManaPayment') {
      pool.length = 0;
      waiting = { type: 'Priority', data: { player: 1 } };
    }
    push();
    return { ok: true };
  };
  void pendingColor;
  return { ...g, push, pool, objects, state: () => state() };
}

test('a spell paid with mana=[land, mana creature, Treasure:R]: every source is tapped, the color asked for, no failure', async () => {
  const b = paymentBench(cost(2, 'Red'));
  const p0 = b.players[0];
  // The agent's plan from its cast (as answer() sets it), then the engine opens the payment.
  p0.payQueue = ['17', '19', '82:R'];
  p0.manualPayments = 1;
  b.push();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(b.sent[0].map((a: any) => a.type), ['TapLandForMana', 'ActivateAbility', 'ActivateAbility', 'ChooseManaColor', 'PassPriority']);
  assert.equal(b.sent[0][3].data.choice.data, 'Red');
  assert.equal(b.objects.find((o) => o.id === 82).zone, 'Graveyard', 'the Treasure was sacrificed for its mana');
  assert.equal(b.logged.filter((r) => r.type === 'pay_error').length, 0);
  assert.equal(p0.payFailures, 0);
  assert.equal(p0.autoTapper, 0);
  assert.equal(p0.manualPayments, 1);
  assert.equal(b.seats[0].pending, undefined, 'no decision left for the agent');
});

test('an "any color" rock in a plan without a color makes a color the cost still needs', async () => {
  const b = paymentBench(cost(1, 'Blue'));
  b.players[0].payQueue = ['64', '17'];
  b.push();
  await new Promise((r) => setTimeout(r, 20));
  const color = b.sent[0].find((a: any) => a.type === 'ChooseManaColor');
  assert.equal(color.data.choice.data, 'Blue');
  assert.equal(b.sent[0].at(-1).type, 'PassPriority');
  assert.ok(b.logged.some((r) => r.type === 'pay_color' && r.ok === true));
});

test('the ManaPayment decision lists mana creatures, rocks and Treasures as sources; a mana plan given there pays', async () => {
  const b = paymentBench(cost(1, 'Green'));
  b.push();
  const o = b.seats[0].pending!;
  assert.equal(o.kind, 'ManaPayment');
  for (const ref of ['Forest [#17]: G', 'Noxious Newt [#19]: G', "Potioner's Trove [#64]: W or U or B or R or G", 'Treasure [#82]: W or U or B or R or G']) assert.ok(o.text.includes(ref), `listed: ${ref}`);
  assert.ok(!o.text.includes('Gruul Signet [#85]: R'), 'a mana ability that costs mana is not a tap-plan source');
  assert.deepEqual(body(o.text).state.you.untapped_mana, { total: 4, G: [17, 19], any: [64, 82] });
  assert.match(await b.seats[0].decide({ decision_id: o.id, mana: ['19', '17'] }), /^Accepted\./);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(b.sent[0].map((a: any) => a.type), ['ActivateAbility', 'TapLandForMana', 'PassPriority']);
  assert.equal(b.players[0].payFailures, 0);
  assert.equal(b.players[0].autoTapper, 0);
});

test('sources picked one by one as options: once the pool pays the cost the payment finishes, never as the auto-tapper', async () => {
  const b = paymentBench(cost(1, 'Green'));
  b.pool.push({ color: 'Green' });
  b.push();
  const o = b.seats[0].pending!;
  const newt = o.options.find((x) => /Noxious Newt/.test(x.label))!;
  assert.match(await b.seats[0].decide({ decision_id: o.id, option: newt.id }), /^Accepted\./);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(b.sent[0].map((a: any) => a.type), ['ActivateAbility', 'PassPriority']);
  const fin = b.logged.find((r) => r.type === 'pay_finish')!;
  assert.equal(fin.from_pool, true);
  assert.equal(fin.by_hand, true);
  assert.equal(b.players[0].autoTapper, 0);
  assert.equal(b.players[0].manualPayments, 1);
  assert.equal(b.seats[0].pending, undefined);
});

test('a plan naming a mana source with a cost of its own is refused with the reason; the auto-tapper still counts', async () => {
  const b = paymentBench(cost(1, 'Green'));
  b.players[0].payQueue = ['85'];
  b.push();
  const err = b.logged.find((r) => r.type === 'pay_error')!;
  assert.equal(err.entry, '85');
  const o = b.seats[0].pending!;
  assert.match(o.text, /Couldn.t tap \\?"85\\?" as part of a plan: its mana ability has a cost of its own/);
  assert.equal(b.players[0].payFailures, 1);
  assert.match(await b.seats[0].decide({ decision_id: o.id, option: '1' }), /^Accepted\./);
  assert.equal(b.players[0].autoTapper, 1, 'the pool did not cover the cost: the auto-tapper paid');
});

test('an ability paid with a plan through an "any color" Treasure: the color is chosen before activating', async () => {
  const { seats, feed, sent, players } = newGame();
  const relic = obj(24, "Lich's Relic", 0, 'Battlefield', { abilities: [{ cost: { type: 'Mana', cost: cost(0, 'Black') }, description: 'Equip {B}' }] });
  const treasure = obj(82, 'Treasure', 0, 'Battlefield', { is_token: true, card_types: type(['Artifact'], ['Treasure']), abilities: [manaAbility(ANY, sacSelf)] });
  const equip = { type: 'ActivateAbility', data: { source_id: 24, ability_index: 0 } };
  const useTreasure = { type: 'ActivateAbility', data: { source_id: 82, ability_index: 0 } };
  feed(0, update(priorityState([relic, treasure]), [{ type: 'PassPriority' }, equip], { byObject: { '24': [equip], '82': [useTreasure] } }));
  const o = seats[0].pending!;
  players[0].phase.act = async (a: any) => {
    sent[0].push(a);
    if (a.type === 'ActivateAbility' && a.data.source_id === 82) {
      const st = priorityState([relic], { waiting_for: { type: 'ChooseManaColor', data: { player: 0 } } });
      feed(0, update(st, ['White', 'Black'].map((c) => ({ type: 'ChooseManaColor', data: { choice: { type: 'SingleColor', data: c }, count: 1 } }))));
    } else if (a.type === 'ChooseManaColor') {
      const st = priorityState([relic]);
      st.players[0].mana_pool = { mana: [{ color: a.data.choice.data }] };
      feed(0, update(st, [{ type: 'PassPriority' }, equip], { byObject: { '24': [equip] } }));
    } else feed(0, update(priorityState([relic]), []));
    return { ok: true };
  };
  assert.match(await seats[0].decide({ decision_id: o.id, option: '2', mana: ['82'] }), /^Accepted\./);
  assert.deepEqual(sent[0].map((a: any) => a.type), ['ActivateAbility', 'ChooseManaColor', 'ActivateAbility']);
  assert.equal(sent[0][1].data.choice.data, 'Black');
  assert.equal(players[0].payFailures, 0);
  assert.equal(players[0].manualPayments, 1);
});

// --- Structured answers win over `option`; conflicts are refused, never half-applied ------------------------------

/** Seat 0 blocks: three attackers (51–53) against its three creatures (41–43); the options list one block each. */
function blockersState(): { state: any; legal: any[] } {
  const mine = [41, 42, 43].map((id) => obj(id, 'Grizzly Bears', 0, 'Battlefield'));
  const theirs = [51, 52, 53].map((id) => obj(id, 'Grizzly Bears', 1, 'Battlefield', { attacking: true }));
  const targets = { '41': [51, 52, 53], '42': [51, 52, 53], '43': [51, 52, 53] };
  const state = priorityState([...mine, ...theirs], {
    active_player: 1, phase: 'DeclareBlockers', waiting_for: { type: 'DeclareBlockers', data: { player: 0, valid_block_targets: targets } },
  });
  const legal = [
    { type: 'DeclareBlockers', data: { assignments: [] } },
    { type: 'DeclareBlockers', data: { assignments: [[41, 51]] } },
    { type: 'DeclareBlockers', data: { assignments: [[42, 52]] } },
  ];
  return { state, legal };
}

test('blocks with a conflicting option are refused and nothing is sent (G89: option 2 + six blocks was cut to one)', async () => {
  const { seats, feed, sent } = newGame();
  const { state, legal } = blockersState();
  feed(0, update(state, legal));
  const o = seats[0].pending!;
  const blocks = [{ blocker: 41, attacker: 51 }, { blocker: 42, attacker: 52 }, { blocker: 43, attacker: 53 }];
  const reply = await seats[0].decide({ decision_id: o.id, option: '2', blocks });
  assert.match(reply, /^Not accepted: option "2" \(Block: .*\) and your `blocks` \(Block: .*\) disagree; nothing was applied/);
  assert.equal(sent[0].length, 0);
  assert.equal(seats[0].pending?.id, o.id, 'the decision stays open');
  // The same answer without the option: all three blocks go to the engine.
  assert.match(await seats[0].decide({ decision_id: o.id, blocks }), /^Accepted\./);
  assert.deepEqual(sent[0], [{ type: 'DeclareBlockers', data: { assignments: [[41, 51], [42, 52], [43, 53]] } }]);
});

test('blocks and an option that say the same are accepted; the structured list is what is sent', async () => {
  const { seats, feed, sent, logged } = newGame();
  const { state, legal } = blockersState();
  feed(0, update(state, legal));
  const o = seats[0].pending!;
  assert.match(await seats[0].decide({ decision_id: o.id, option: '2', blocks: [{ blocker: 41, attacker: 51 }] }), /^Accepted\./);
  assert.deepEqual(sent[0], [{ type: 'DeclareBlockers', data: { assignments: [[41, 51]] } }]);
  assert.equal(logged.find((r) => r.type === 'agent_decision' && r.id === o.id)!.structured, true);
});

test('attackers win over an option listing more attackers only when they agree; an unknown option with them is refused', async () => {
  const { seats, feed, sent } = newGame();
  const mine = [61, 62].map((id) => obj(id, 'Grizzly Bears', 0, 'Battlefield'));
  const state = priorityState(mine, { phase: 'DeclareAttackers', waiting_for: { type: 'DeclareAttackers', data: { player: 0, valid_attacker_ids: [61, 62], valid_attack_targets: [{ type: 'Player', data: 1 }] } } });
  const target = { type: 'Player', data: 1 };
  const legal = [
    { type: 'DeclareAttackers', data: { attacks: [], bands: [] } },
    { type: 'DeclareAttackers', data: { attacks: [[61, target], [62, target]], bands: [] } },
  ];
  feed(0, update(state, legal));
  const o = seats[0].pending!;
  assert.match(await seats[0].decide({ decision_id: o.id, option: '2', attackers: [61] }), /disagree; nothing was applied/);
  assert.match(await seats[0].decide({ decision_id: o.id, option: 'attackers', attackers: [61] }), /Unknown option "attackers".*leave out `option`/s);
  assert.equal(sent[0].length, 0);
  assert.match(await seats[0].decide({ decision_id: o.id, option: '2', attackers: [62, 61] }), /^Accepted\./);
  assert.deepEqual(sent[0][0].data.attacks.map((a: any) => a[0]), [62, 61]);
});

test('fields a decision does not take are refused: blocks on priority, basics in a game, mana without the option it pays for', async () => {
  const { seats, feed, sent } = newGame();
  const relic = obj(24, "Lich's Relic", 0, 'Battlefield', { abilities: [{ cost: { type: 'Mana', cost: cost(2) }, description: 'Equip {2}' }] });
  const equip = { type: 'ActivateAbility', data: { source_id: 24, ability_index: 0 } };
  feed(0, update(priorityState([relic, obj(19, 'Forest', 0, 'Battlefield')]), [{ type: 'PassPriority' }, equip]));
  const o = seats[0].pending!;
  assert.match(await seats[0].decide({ decision_id: o.id, option: '1', blocks: [{ blocker: 41, attacker: 51 }] }), /This decision doesn't take `blocks`.*nothing was applied/);
  assert.match(await seats[0].decide({ decision_id: o.id, option: '1', basics: { Forest: 2 } }), /doesn't take `basics`/);
  assert.match(await seats[0].decide({ decision_id: o.id, mana: ['19'] }), /`mana` pays for the spell or ability you choose: give its `option` too/);
  assert.equal(sent[0].length, 0);
  // An empty list for a field the decision doesn't take says nothing and is no conflict.
  assert.match(await seats[0].decide({ decision_id: o.id, option: '1', attackers: [] }), /^Accepted\./);
});

test('SEC-8: structured answers are checked against what the engine offered; nothing outside it is sent', async () => {
  const { seats, feed, sent } = newGame();
  // Attackers: 61 and 62 may attack; 71 is the opponent's creature, 30 a land.
  const mine = [61, 62].map((id) => obj(id, 'Grizzly Bears', 0, 'Battlefield'));
  const theirs = obj(71, 'Grizzly Bears', 1, 'Battlefield');
  const target = { type: 'Player', data: 1 };
  feed(0, update(priorityState([...mine, theirs], { phase: 'DeclareAttackers', waiting_for: { type: 'DeclareAttackers', data: { player: 0, valid_attacker_ids: [61, 62], valid_attack_targets: [target] } } }),
    [{ type: 'DeclareAttackers', data: { attacks: [], bands: [] } }, { type: 'DeclareAttackers', data: { attacks: [[61, target]], bands: [] } }]));
  let o = seats[0].pending!;
  assert.match(await seats[0].decide({ decision_id: o.id, attackers: [61, 71] }), /^Not accepted: #71 can't attack now; creatures that can attack: #61, #62/);
  assert.match(await seats[0].decide({ decision_id: o.id, attackers: [61, 61] }), /each attacker once/);
  assert.equal(sent[0].length, 0);
  assert.match(await seats[0].decide({ decision_id: o.id, attackers: [62] }), /^Accepted\./);
  // Blocks: only pairs listed in valid_block_targets.
  const { state, legal } = blockersState();
  feed(0, update(state, legal));
  o = seats[0].pending!;
  assert.match(await seats[0].decide({ decision_id: o.id, blocks: [{ blocker: 51, attacker: 51 }] }), /#51 blocking #51: not a possible block/);
  assert.match(await seats[0].decide({ decision_id: o.id, blocks: [{ blocker: 41, attacker: 99 }] }), /not a possible block/);
  assert.equal(sent[0].length, 1, 'only the accepted attack was sent');
});

test('SEC-8: a selection (discard, scry, effect choice) takes only the offered cards', async () => {
  const { seats, feed, sent } = newGame();
  const hand = [obj(11, 'Shock', 0, 'Hand'), obj(12, 'Shock', 0, 'Hand')];
  const state = priorityState(hand, { waiting_for: { type: 'DiscardChoice', data: { player: 0, count: 1 } } });
  state.players[1].hand = [21];
  feed(0, update(state, [{ type: 'SelectCards', data: { cards: [11] } }, { type: 'SelectCards', data: { cards: [12] } }]));
  const o = seats[0].pending!;
  assert.match(await seats[0].decide({ decision_id: o.id, cards: [21] }), /#21 is not among the cards you can choose \(#11, #12\)/);
  assert.match(await seats[0].decide({ decision_id: o.id, cards: [11, 11] }), /each card once/);
  assert.equal(sent[0].length, 0);
  assert.match(await seats[0].decide({ decision_id: o.id, cards: [12] }), /^Accepted\./);
  assert.deepEqual(sent[0], [{ type: 'SelectCards', data: { cards: [12] } }]);
});

// --- 4. Duplicate delivery -----------------------------------------------------------------------------------------

function offerOn(seat: AgentSeat, id: string, text: string, onAnswer?: () => void): Offer {
  const o: Offer = {
    id, phase: 'game', kind: 'Priority', text, options: [{ id: '1', label: 'Pass priority', value: 1 }], createdAt: Date.now(),
    answer: async () => {
      onAnswer?.();
      return null;
    },
  };
  seat.offer(o);
  return o;
}

test('decide and wait_for_decision in parallel: the next decision arrives once in full, once as a one-line pointer', async () => {
  const seat = new AgentSeat('a', 0);
  const big = (id: string) => `DECISION ${id} ${'x'.repeat(5000)}`;
  offerOn(seat, 'G1', big('G1'));
  assert.equal((await seat.wait(10)).text, big('G1'));
  // The harness sends both at once: decide(G1) and wait_for_decision.
  const [d, w] = await Promise.all([
    seat.decide({ decision_id: 'G1', option: '1' }),
    (async () => {
      const r = seat.wait(2000);
      setTimeout(() => offerOn(seat, 'G2', big('G2')), 20);
      return (await r).text;
    })(),
  ]);
  const full = [d, w].filter((t) => t.includes(big('G2')));
  const short = [d, w].filter((t) => t.includes('Decision G2 is open; its full text is in your'));
  assert.equal(full.length, 1, 'G2 in full exactly once');
  assert.equal(short.length, 1);
  assert.ok(short[0]!.length < 300);
  // A later call gets the full text again (a session that lost it can recover).
  assert.equal((await seat.wait(10)).text, big('G2'));
});

test('a wait racing a decide never returns the decision being answered', async () => {
  const seat = new AgentSeat('a', 0);
  offerOn(seat, 'G1', 'DECISION G1');
  await seat.wait(10);
  let release!: () => void;
  const o = seat.pending!;
  o.answer = () => new Promise((r) => (release = () => r(null)));
  const decided = seat.decide({ decision_id: 'G1', option: '1' });
  const waited = seat.wait(300);
  await new Promise((r) => setTimeout(r, 20));
  release();
  const [, w] = await Promise.all([decided, waited]);
  assert.ok(!w.text.includes('DECISION G1'), 'the wait returned the decision being answered');
});

test('an answer to a stale id gets the open decision in the same reply', async () => {
  const seat = new AgentSeat('a', 0);
  offerOn(seat, 'G7', 'DECISION G7 full text');
  const r = await seat.decide({ decision_id: 'G5', option: '1' });
  assert.match(r, /^Decision G5 is not open; the open decision is G7:\n\nDECISION G7 full text$/);
});

// --- 3. The briefing -----------------------------------------------------------------------------------------------

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');

test('the Set Context comes in parts under the result size limit (TLA: 56 KB), each saying where it is', () => {
  const tla = readFileSync(join(root, 'sets/TLA/primer.md'), 'utf8');
  assert.ok(tla.length > 50_000);
  const parts = splitSetContext(tla);
  assert.ok(parts.length >= 3);
  for (const p of parts) assert.ok(p.length <= SET_CONTEXT_PART_CHARS);
  assert.equal(parts.join('').replace(/\s/g, ''), tla.trim().replace(/\s/g, ''));
  const seat = new AgentSeat('a', 0);
  seat.primer = tla;
  seat.primerParts = parts;
  const first = setContextPart(seat, undefined, 'Set Context', 'get_set_context');
  assert.match(first, /^SET CONTEXT \(MTG Deck Tools\), part 1 of 3\./);
  assert.match(first, /\(End of part 1 of 3\. Next: get_set_context\(part=2\)\.\)$/);
  assert.match(setContextPart(seat, 3, 'Set Context', 'get_set_context'), /\(End of the Set Context: part 3 of 3\.\)$/);
  assert.match(setContextPart(seat, 9, 'Set Context', 'get_set_context'), /part 3 of 3 \(there is no part 9; showing part 3\)/);
  for (let i = 1; i <= parts.length; i++) assert.ok(Buffer.byteLength(setContextPart(seat, i, 'Set Context', 'get_set_context')) < 30_000);
});

test('a new session of a briefed seat starts with the resume briefing; the first session doesn\'t', async () => {
  const seat = new AgentSeat('a', 0);
  seat.resumeBriefing = () => 'RESUME BRIEFING';
  seat.sessionStart();
  seat.brief('WELCOME');
  offerOn(seat, 'G1', 'DECISION G1');
  const first = (await seat.wait(10)).text;
  assert.ok(first.startsWith('>> WELCOME') && !first.includes('RESUME'));
  // The harness is relaunched: a new MCP session.
  seat.sessionStart();
  seat.sessionStart();
  const again = (await seat.wait(10)).text;
  assert.equal(again, '>> RESUME BRIEFING\n\nDECISION G1');
});

// --- SPEC-1: the public per-turn snapshot never names a face-down permanent ---------------------------------------------

test('turn_snapshot (public) names face-down permanents "Face-down card", even the host\'s own', () => {
  const { game } = newGame();
  const s = priorityState([
    obj(54, 'Secret Morph', 0, 'Battlefield', { face_down: true, power: 2, toughness: 2 }),
    obj(55, 'Grizzly Bears', 1, 'Battlefield'),
  ]);
  const snap = (game as any).snapshot(s);
  const all = JSON.stringify(snap);
  assert.ok(!all.includes('Secret Morph'), all);
  assert.deepEqual(Object.values(snap.players).map((p: any) => p.permanents), [['Face-down card 2/2'], ['Grizzly Bears 2/2']]);
});

// --- Match memory: what each seat saw of its opponent's deck, for later games of the match ---------------------------

test('game_over records each seat\'s opponent cards seen: its own views plus the final public zones, never a hidden hand', () => {
  const { feed, logged, seats } = newGame();
  // Mid-game views. Seat 0 sees the opponent's Grizzly Bears #12 on the battlefield; seat 1 sees seat 0's Forest #1
  // on the battlefield and Grizzly Bears #2 in the graveyard. Hands stay hidden ("Hidden Card"; seat 1's #13 leaks
  // its name without the visibility flag, as redacted objects sometimes do).
  const view = (viewer: number, extra: (s: any) => void) => {
    const s = mulliganState(viewer, []);
    s.waiting_for = { type: 'Priority', data: { player: viewer } };
    s.turn_number = 4;
    extra(s);
    return s;
  };
  const mid0 = view(0, (s) => {
    s.objects[12] = obj(12, 'Grizzly Bears', 1, 'Battlefield');
    s.objects[13] = { ...obj(13, 'Mountain', 1, 'Hand'), display_visible_to_viewer: false };
    s.battlefield = [12];
    s.players[1].hand = [13, 14, 15];
  });
  const mid1 = view(1, (s) => {
    s.objects[1] = obj(1, 'Forest', 0, 'Battlefield');
    s.objects[2] = obj(2, 'Grizzly Bears', 0, 'Graveyard');
    s.battlefield = [1];
    s.players[0].hand = [3, 4];
    s.players[0].graveyard = [2];
  });
  feed(0, update(mid0, []));
  feed(1, update(mid1, []));
  // Game over, delivered on seat 0's socket only: seat 0 cast Grizzly Bears #4 at the end (seat 1 never got that
  // update), and the opponent's Mountain #19 went to its graveyard. Seat 0's hand (#3, #5…) is never seen by seat 1.
  const end = view(0, (s) => {
    s.objects[1] = obj(1, 'Forest', 0, 'Battlefield');
    s.objects[2] = obj(2, 'Grizzly Bears', 0, 'Graveyard');
    s.objects[4] = obj(4, 'Grizzly Bears', 0, 'Battlefield');
    s.objects[12] = obj(12, 'Grizzly Bears', 1, 'Battlefield');
    s.objects[19] = obj(19, 'Mountain', 1, 'Graveyard');
    s.battlefield = [1, 4, 12];
    s.players[0].hand = [3, 5, 6, 7];
    s.players[0].graveyard = [2];
    s.players[1].graveyard = [19];
    s.waiting_for = { type: 'GameOver', data: { winner: 0 } };
  });
  feed(0, update(end, []));
  const over = logged.find((r) => r.type === 'game_over') as any;
  assert.ok(over, 'game over logged');
  assert.deepEqual(over.opponent_cards_seen[seats[0].name], { 'Grizzly Bears': 1, Mountain: 1 });
  assert.deepEqual(over.opponent_cards_seen[seats[1].name], { Forest: 1, 'Grizzly Bears': 2 });
  assert.equal(over.opponentCardsSeen, undefined, 'one field in the log');
});

// --- OPS-16: request paths in error logs never carry a whole bearer secret ---------------------------------------------

test('logged request paths keep at most 4 characters of seat tokens, lobby tickets and token parameters', () => {
  assert.equal(loggablePath('/mcp/7bcf6103aef759c775fe1b5831f00d56'), '/mcp/7bcf…');
  assert.equal(loggablePath('/api/lobby/tickets/abcdef0123456789abcdef0123456789/wait?rev=3'), '/api/lobby/tickets/abcd…/wait?rev=3');
  assert.equal(loggablePath('/api/events/x/live?since=4&token=supersecret'), '/api/events/x/live?since=4&token=supe…');
});

for (const [name, fn] of tests) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}
console.log(`# ${passed} passed`);
