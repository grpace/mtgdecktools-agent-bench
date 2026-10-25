/**
 * Observation format v4 (render-v4.ts): hidden-information safety, attachments, stack targets, transformed and
 * face-down permanents, grouping, valid JSON; and the v4 card JSON for packs/pools.
 *   npx tsx packages/director/src/render-v4.test.ts
 * Self-contained: builds a tiny phase-rs card-data.json in a temp dir.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CardDb } from './cards.js';
import { packCardJson, poolSummaryV4 } from './draft.js';
import { poolCovers } from './mana-sources.js';
import { compactJson, groupIdentical, ObserverV4, shownCards } from './render-v4.js';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// --- a tiny card database (phase-rs card-data.json shape) ---------------------------------------------------------
const cost = (generic: number, ...shards: string[]) => ({ type: 'Cost', generic, shards });
const fixed = (v: number) => ({ type: 'Fixed', value: v });
const type = (core: string[], sub: string[] = [], sup: string[] = []) => ({ supertypes: sup, core_types: core, subtypes: sub });
const raw: Record<string, any> = {
  'grizzly bears': { name: 'Grizzly Bears', mana_cost: cost(1, 'Green'), card_type: type(['Creature'], ['Bear']), power: fixed(2), toughness: fixed(2), oracle_text: '', keywords: [], layout: 'normal' },
  'pacifism': { name: 'Pacifism', mana_cost: cost(1, 'White'), card_type: type(['Enchantment'], ['Aura']), oracle_text: "Enchant creature\nEnchanted creature can't attack or block.", keywords: [{ Enchant: { type: 'Typed', type_filters: ['Creature'] } }], layout: 'normal' },
  'shock': { name: 'Shock', mana_cost: cost(0, 'Red'), card_type: type(['Instant']), oracle_text: 'Shock deals 2 damage to any target.', keywords: [], layout: 'normal' },
  'forest': { name: 'Forest', mana_cost: { type: 'NoCost' }, card_type: type(['Land'], ['Forest'], ['Basic']), oracle_text: '({T}: Add {G}.)', keywords: [], layout: 'normal' },
  'mountain': { name: 'Mountain', mana_cost: { type: 'NoCost' }, card_type: type(['Land'], ['Mountain'], ['Basic']), oracle_text: '({T}: Add {R}.)', keywords: [], layout: 'normal' },
  'delver of secrets': { name: 'Delver of Secrets', mana_cost: cost(0, 'Blue'), card_type: type(['Creature'], ['Human', 'Wizard']), power: fixed(1), toughness: fixed(1), oracle_text: 'At the beginning of your upkeep, look at the top card of your library. You may reveal that card. If an instant or sorcery card is revealed this way, transform this creature.', keywords: [], layout: 'transform', scryfall_oracle_id: 'delver', face_index: 0 },
  'insectile aberration': { name: 'Insectile Aberration', mana_cost: { type: 'NoCost' }, card_type: type(['Creature'], ['Human', 'Insect']), power: fixed(3), toughness: fixed(2), oracle_text: 'Flying', keywords: ['Flying'], color_override: ['Blue'], layout: 'transform', scryfall_oracle_id: 'delver', face_index: 1 },
  'secret morph': { name: 'Secret Morph', mana_cost: cost(4, 'Black'), card_type: type(['Creature'], ['Horror']), power: fixed(5), toughness: fixed(5), oracle_text: 'Morph {3}{B}', keywords: [], layout: 'normal' },
  'their secret bomb': { name: 'Their Secret Bomb', mana_cost: cost(5, 'Black'), card_type: type(['Creature'], ['Demon']), power: fixed(7), toughness: fixed(7), oracle_text: 'Flying', keywords: ['Flying'], layout: 'normal' },
  'hidden hand card': { name: 'Hidden Hand Card', mana_cost: cost(2, 'Black'), card_type: type(['Sorcery']), oracle_text: 'Opponent secret.', keywords: [], layout: 'normal' },
  'flashback spell': { name: 'Flashback Spell', mana_cost: cost(1, 'Red'), card_type: type(['Sorcery']), oracle_text: 'Draw a card.\nFlashback {3}{R}', keywords: [{ Flashback: { type: 'Mana', data: cost(3, 'Red') } }], layout: 'normal' },
  'dual grove': { name: 'Dual Grove', mana_cost: { type: 'NoCost' }, card_type: type(['Land']), oracle_text: 'This land enters tapped.\n{T}: Add {G} or {W}.', keywords: [], layout: 'normal' },
  'prism rock': { name: 'Prism Rock', mana_cost: cost(3), card_type: type(['Artifact']), oracle_text: '{T}: Add one mana of any color.', keywords: [], layout: 'normal' },
  'off grove': { name: 'Off Grove', mana_cost: { type: 'NoCost' }, card_type: type(['Land']), oracle_text: '{T}: Add {U} or {B}.', keywords: [], layout: 'normal' },
};
const dir = mkdtempSync(join(tmpdir(), 'mtgdt-v4-'));
writeFileSync(join(dir, 'card-data.json'), JSON.stringify(raw));
const cards = new CardDb(join(dir, 'card-data.json'), dir);

// --- a two-player state as phase-server sends it to player 0 ----------------------------------------------------------
const ME = 0;
const OPP = 1;
function o(id: number, name: string, owner: number, zone: string, extra: Record<string, unknown> = {}): any {
  const info = raw[name.toLowerCase()];
  return {
    id, name, owner, controller: owner, zone, tapped: false, face_down: false, transformed: false, damage_marked: 0,
    attached_to: null, attachments: [], counters: {}, keywords: info?.keywords?.filter((k: unknown) => typeof k === 'string') ?? [],
    card_types: info?.card_type ?? type([]), color: [], mana_cost: info?.mana_cost ?? { type: 'NoCost' },
    power: info?.power?.value ?? null, toughness: info?.toughness?.value ?? null, base_power: info?.power?.value ?? null, base_toughness: info?.toughness?.value ?? null,
    loyalty: null, base_keywords: [], display_visible_to_viewer: zone !== 'Library', ...extra,
  };
}
/** What phase-server sends for a card the viewer can't see (with a stray characteristic, as seen in real states). */
const hidden = (id: number, owner: number, zone: string) => ({
  ...o(id, 'Hidden Card', owner, zone), face_down: true, card_types: type([]), layer_base_power: 7, layer_base_toughness: 7, display_visible_to_viewer: undefined,
});

function baseState(): any {
  const objects: Record<string, any> = {};
  const add = (x: any) => (objects[String(x.id)] = x);
  // My hand: Shock, Forest. Opponent's hand: one hidden card (a "Hidden Hand Card" underneath). Libraries hidden.
  add(o(1, 'Shock', ME, 'Hand'));
  add(o(2, 'Forest', ME, 'Hand'));
  add(hidden(3, OPP, 'Hand'));
  add(hidden(4, ME, 'Library'));
  add(hidden(5, OPP, 'Library'));
  // Battlefield: my Grizzly Bears enchanted by the opponent's Pacifism; two untapped Forests; a tapped Mountain of theirs.
  add(o(10, 'Grizzly Bears', ME, 'Battlefield', { attachments: [{ type: 'Object', data: 11 }], counters: { P1P1: 1 }, power: 3, toughness: 3, damage_marked: 1 }));
  add(o(11, 'Pacifism', OPP, 'Battlefield', { attached_to: { type: 'Object', data: 10 } }));
  add(o(12, 'Forest', ME, 'Battlefield'));
  add(o(13, 'Forest', ME, 'Battlefield'));
  add(o(14, 'Mountain', OPP, 'Battlefield', { tapped: true }));
  add(o(15, 'Mountain', OPP, 'Battlefield'));
  // Transformed Delver (opponent's): name and characteristics are the back face's.
  add(o(16, 'Insectile Aberration', OPP, 'Battlefield', { transformed: true, keywords: ['Flying'], power: 3, toughness: 2, base_power: 3, base_toughness: 2, color: ['Blue'] }));
  // My face-down morph: the engine reveals its identity to me (name = the real card), characteristics 2/2.
  add(o(17, 'Secret Morph', ME, 'Battlefield', { face_down: true, card_types: type(['Creature']), power: 2, toughness: 2, base_power: 2, base_toughness: 2, back_face: { name: 'Secret Morph' } }));
  // The opponent's face-down creature. A well-behaved engine sends "Hidden Card"; this one leaks a name and a back face.
  add(o(18, 'Their Secret Bomb', OPP, 'Battlefield', { face_down: true, card_types: type(['Creature']), power: 2, toughness: 2, base_power: 2, base_toughness: 2, back_face: { name: 'Their Secret Bomb' }, layer_base_power: 7, keywords: [] }));
  // Graveyards: a flashback card (full text) and a plain creature (type only).
  add(o(20, 'Flashback Spell', ME, 'Graveyard'));
  add(o(21, 'Grizzly Bears', OPP, 'Graveyard'));
  // Stack: opponent's Shock targeting my Bears, below my... no: one spell (top) and a trigger beneath.
  add(o(30, 'Shock', OPP, 'Stack'));
  return {
    turn_number: 5, phase: 'PreCombatMain', active_player: ME, priority_player: ME,
    players: [
      { id: 0, life: 18, poison_counters: 0, hand: [1, 2], library: [4], graveyard: [20], lands_played_this_turn: 1, mana_pool: { mana: [] } },
      { id: 1, life: 20, poison_counters: 2, hand: [3], library: [5], graveyard: [21], lands_played_this_turn: 0, mana_pool: { mana: [] } },
    ],
    battlefield: [10, 11, 12, 13, 14, 15, 16, 17, 18],
    exile: [],
    stack: [
      { id: 40, source_id: 16, controller: OPP, kind: { type: 'TriggeredAbility', data: { source_id: 16, description: 'When ~ attacks, target player loses 1 life.', ability: { targets: [{ Player: ME }] } } } },
      { id: 30, source_id: 30, controller: OPP, kind: { type: 'Spell', data: { card_id: 30, casting_variant: 'Normal', ability: { targets: [{ Object: 10 }], sub_ability: { targets: [{ Object: 10 }] } } } } },
    ],
    combat: null,
    waiting_for: { type: 'Priority', data: { player: ME } },
    objects,
  };
}

const obs = new ObserverV4(cards, ME);
const render = (s: any, opts = {}) => obs.render(s, opts);
const parsed = (s: any) => JSON.parse(render(s).json);

test('STATE is valid JSON and CARDS lines are valid card JSON', () => {
  const v = render(baseState());
  const state = JSON.parse(v.json);
  assert.equal(state.turn, 5);
  assert.equal(state.step, 'precombat main');
  assert.equal(state.active, 'you');
  for (const line of v.cards.split('\n')) assert.ok(JSON.parse(line).name);
});

test('hidden information never leaks: opponent hand, libraries, opponent face-down card', () => {
  const v = render(baseState());
  const all = v.summary + v.json + v.cards;
  for (const secret of ['Their Secret Bomb', 'Hidden Hand Card', '"7/7"', 'layer_base', 'back_face']) assert.ok(!all.includes(secret), `leaked ${secret}`);
  const state = JSON.parse(v.json);
  assert.equal(state.opponent.hand, 1);
  assert.equal(state.opponent.library, 1);
  assert.equal(state.opponent.revealed_hand, undefined);
  const theirMorph = state.battlefield.opponent.find((x: any) => x.id === 18);
  assert.deepEqual(theirMorph, { id: 18, face_down: true, pt: '2/2' });
});

test('a revealed card in the opponent\'s hand is shown only when the engine marks it visible', () => {
  const s = baseState();
  s.objects['3'] = o(3, 'Hidden Hand Card', OPP, 'Hand', { display_visible_to_viewer: true });
  const state = parsed(s);
  assert.deepEqual(state.opponent.revealed_hand, [{ id: 3, card: 'Hidden Hand Card' }]);
  // Same card without the visibility flag: hidden.
  s.objects['3'].display_visible_to_viewer = undefined;
  assert.equal(parsed(s).opponent.revealed_hand, undefined);
});

test('own face-down permanent: identity shown to its controller, face-down characteristics on the object', () => {
  const v = render(baseState());
  const mine = JSON.parse(v.json).battlefield.you.find((x: any) => x.id === 17);
  assert.equal(mine.face_down, true);
  assert.equal(mine.your_face_down_card, 'Secret Morph');
  assert.equal(mine.pt, '2/2');
  assert.ok(v.cards.includes('"name":"Secret Morph"'));
});

test('attachments both ways, counters, damage, base P/T', () => {
  const state = parsed(baseState());
  const bears = state.battlefield.you.find((x: any) => x.id === 10);
  assert.deepEqual(bears.attachments, [11]);
  assert.deepEqual(bears.counters, { '+1/+1': 1 });
  assert.equal(bears.damage, 1);
  assert.equal(bears.pt, '3/3');
  assert.equal(bears.base_pt, '2/2');
  const aura = state.battlefield.opponent.find((x: any) => x.id === 11);
  assert.equal(aura.attached_to, 10);
});

test('stack: top first, controller, chosen targets (sub-abilities deduped), trigger text with the source name', () => {
  const state = parsed(baseState());
  assert.equal(state.stack.length, 2);
  const [top, below] = state.stack;
  assert.equal(top.top, true);
  assert.equal(top.kind, 'spell');
  assert.equal(top.card, 'Shock');
  assert.equal(top.controller, 'opponent');
  assert.deepEqual(top.targets, [{ id: 10, card: 'Grizzly Bears', controller: 'you' }]);
  assert.equal(below.kind, 'triggered ability');
  assert.equal(below.source, 16);
  assert.equal(below.text, 'When Insectile Aberration attacks, target player loses 1 life.');
  assert.deepEqual(below.targets, [{ player: 'you' }]);
});

test('a spell being cast shows the targets already chosen (pending cast)', () => {
  const s = baseState();
  s.stack = [{ id: 30, source_id: 30, controller: ME, kind: { type: 'Spell', data: { card_id: 30, casting_variant: 'Normal' } } }];
  s.objects['30'].owner = ME;
  s.objects['30'].controller = ME;
  s.pending_cast = { object_id: 30, ability: { targets: [{ Object: 16 }] }, cost: cost(0, 'Red') };
  const top = parsed(s).stack[0];
  assert.equal(top.being_cast, true);
  assert.deepEqual(top.targets, [{ id: 16, card: 'Insectile Aberration', controller: 'opponent' }]);
});

test('transformed permanent: current face name and stats, its other face in CARDS', () => {
  const v = render(baseState());
  const delver = JSON.parse(v.json).battlefield.opponent.find((x: any) => x.id === 16);
  assert.equal(delver.card, 'Insectile Aberration');
  assert.equal(delver.transformed, true);
  assert.equal(delver.pt, '3/2');
  const line = v.cards.split('\n').map((l) => JSON.parse(l)).find((c) => c.name === 'Insectile Aberration');
  assert.equal(line.faces[0].name, 'Delver of Secrets');
  assert.ok(line.faces[0].text.includes('transform'));
});

test('graveyards: every card gets a full CARDS entry, like the battlefield', () => {
  const v = render(baseState());
  const state = JSON.parse(v.json);
  assert.deepEqual(state.graveyard.you, [{ id: 20, card: 'Flashback Spell' }]);
  assert.ok(v.cards.includes('"name":"Flashback Spell"'));
  assert.deepEqual(state.graveyard.opponent, [{ id: 21, card: 'Grizzly Bears' }]);
  assert.ok(v.cards.includes('"name":"Grizzly Bears"'));
  assert.ok(!v.cards.includes('"name":"Forest"'), 'basic lands have no CARDS entry');
});

test('exile: full CARDS entry, owner; face-down exiled cards stay hidden', () => {
  const s = baseState();
  s.objects['22'] = o(22, 'Pacifism', OPP, 'Exile');
  s.objects['23'] = { ...hidden(23, OPP, 'Exile'), name: 'Their Secret Bomb', face_down: true };
  s.exile = [22, 23];
  const v = render(s);
  assert.deepEqual(JSON.parse(v.json).exile, [{ id: 22, card: 'Pacifism', owner: 'opponent' }, { id: 23, card: 'face-down card', owner: 'opponent' }]);
  assert.ok(v.cards.includes('"name":"Pacifism"'));
  assert.ok(!(v.json + v.cards).includes('Their Secret Bomb'));
});

test('mana: untapped sources by color, exact from legal mana actions for me, derived for the opponent', () => {
  const s = baseState();
  const state = parsed(s);
  assert.deepEqual(state.you.untapped_mana, { total: 2, G: [12, 13] });
  assert.deepEqual(state.opponent.untapped_mana, { total: 1, R: [15] });
  const byObject = { 12: [{ type: 'TapLandForMana', data: { selection: { mana_type: 'Green' } } }] };
  assert.deepEqual(JSON.parse(obs.render(s, { byObject }).json).you.untapped_mana, { total: 1, G: [12] });
  assert.equal(state.you.lands_played_this_turn, 1);
  assert.equal(state.opponent.poison, 2);
});

test('mana creatures, rocks and Treasures (ActivateAbility mana abilities) are untapped mana; a source costing mana is not', () => {
  const s = baseState();
  const ability = (produced: any, cost: any = { type: 'Tap' }) => ({ is_mana_ability: true, cost, effect: { type: 'Mana', produced } });
  const any = { type: 'AnyOneColor', count: { type: 'Fixed', value: 1 }, color_options: ['White', 'Blue', 'Black', 'Red', 'Green'] };
  s.objects['19'] = o(19, 'Noxious Newt', ME, 'Battlefield', { card_types: type(['Creature']), abilities: [ability({ type: 'Fixed', colors: ['Green'] })] });
  s.objects['64'] = o(64, "Potioner's Trove", ME, 'Battlefield', { card_types: type(['Artifact']), abilities: [ability(any), { cost: { type: 'Tap' }, effect: { type: 'GainLife' } }] });
  s.objects['82'] = o(82, 'Treasure', ME, 'Battlefield', { is_token: true, card_types: type(['Artifact']), abilities: [ability(any, { type: 'Composite', costs: [{ type: 'Tap' }, { type: 'Sacrifice', target: { type: 'SelfRef' }, count: 1 }] })] });
  s.objects['85'] = o(85, 'Gruul Signet', ME, 'Battlefield', { card_types: type(['Artifact']), abilities: [ability({ type: 'Fixed', colors: ['Red', 'Green'] }, { type: 'Composite', costs: [{ type: 'Mana', cost: { type: 'Cost', generic: 1, shards: [] } }, { type: 'Tap' }] })] });
  s.objects['86'] = o(86, 'Noxious Newt', OPP, 'Battlefield', { card_types: type(['Creature']), abilities: [ability({ type: 'Fixed', colors: ['Black'] })] });
  s.battlefield.push(19, 64, 82, 85, 86);
  const act = (id: number, i = 0) => ({ type: 'ActivateAbility', data: { source_id: id, ability_index: i } });
  const byObject = { 12: [{ type: 'TapLandForMana', data: { selection: { mana_type: 'Green' } } }], 19: [act(19)], 64: [act(64), act(64, 1)], 82: [act(82)], 85: [act(85)] };
  const v = JSON.parse(obs.render(s, { byObject }).json);
  assert.deepEqual(v.you.untapped_mana, { total: 4, G: [12, 19], any: [64, 82] });
  // The opponent's (no legal actions): derived from the engine's mana-ability flags.
  assert.deepEqual(v.opponent.untapped_mana, { total: 2, R: [15], B: [86] });
  const mine = (id: number) => v.battlefield.you.find((x: any) => x.id === id || x.ids?.includes(id));
  // The Trove's life ability and the Signet's mana ability (it costs mana: not a tap-plan source) stay usable_now.
  assert.equal(mine(64).usable_now?.length, 1);
  assert.equal(mine(85).usable_now?.length, 1);
  assert.equal(mine(19).usable_now, undefined);
  assert.equal(mine(82).usable_now, undefined);
});

test('poolCovers: colored, colorless, generic and hybrid costs; unknown for restricted mana and other shards', () => {
  const pool = (...cs: string[]) => cs.map((color) => ({ color, restrictions: [] }));
  const c = (generic: number, ...shards: string[]) => ({ type: 'Cost', generic, shards });
  assert.equal(poolCovers(c(2, 'Green'), pool('Green', 'Green', 'Red')), true);
  assert.equal(poolCovers(c(2, 'Green'), pool('Green', 'Red')), false);
  assert.equal(poolCovers(c(0, 'Green', 'Green'), pool('Green', 'Red')), false);
  assert.equal(poolCovers(c(1, 'Colorless'), pool('Green', 'Green')), false);
  assert.equal(poolCovers(c(0, 'RedGreen', 'Red'), pool('Green', 'Red')), true);
  assert.equal(poolCovers(c(0, 'RedGreen', 'Red'), pool('Red', 'Blue')), false);
  assert.equal(poolCovers(c(1, 'X'), pool('Green', 'Green')), undefined);
  assert.equal(poolCovers(c(1), [{ color: 'Green', restrictions: ['CreatureSpell'] }]), undefined);
  assert.equal(poolCovers(undefined, pool('Green')), undefined);
});

test('mana rocks count as untapped mana (from their rules text)', () => {
  const s = baseState();
  s.objects['19'] = o(19, 'Prism Rock', OPP, 'Battlefield');
  s.battlefield.push(19);
  assert.deepEqual(parsed(s).opponent.untapped_mana, { total: 2, R: [15], any: [19] });
});

test('identical permanents group into one entry with ids', () => {
  const state = parsed(baseState());
  const forests = state.battlefield.you.filter((x: any) => x.card === 'Forest');
  assert.deepEqual(forests, [{ ids: [12, 13], card: 'Forest' }]);
  assert.deepEqual(groupIdentical([{ id: 1, card: 'A' }, { id: 2, card: 'A', tapped: true }]), [{ id: 1, card: 'A' }, { id: 2, card: 'A', tapped: true }]);
});

test('combat: can_attack / can_block from the engine, attackers with blockers', () => {
  const s = baseState();
  s.waiting_for = { type: 'DeclareBlockers', data: { valid_block_targets: { 10: [16] } } };
  s.combat = { attackers: [{ object_id: 16, attack_target: { type: 'Player', data: ME }, blocked: false }], blocker_assignments: { 16: [10] } };
  const state = parsed(s);
  assert.deepEqual(state.battlefield.you.find((x: any) => x.id === 10).can_block, [16]);
  assert.deepEqual(state.combat.attackers, [{ id: 16, controller: 'opponent', attacking: 'you', blocked_by: [10] }]);
});

test('card table modes: "new" sends each card once per game, "inline" puts the data in the objects', () => {
  const sent = new Set<string>();
  const first = obs.render(baseState(), { cardTable: 'new', sent });
  const second = obs.render(baseState(), { cardTable: 'new', sent });
  assert.ok(first.cards.length > 0);
  assert.equal(second.cards, '');
  const inline = obs.render(baseState(), { cardTable: 'inline' });
  assert.equal(inline.cards, '');
  assert.equal(JSON.parse(inline.json).hand[0].card.text, 'Shock deals 2 damage to any target.');
});

test('compactJson round-trips', () => {
  const v = { a: 1, list: [{ x: 1 }, { y: [1, 2] }], nested: { inner: [{ z: 'q' }] }, empty: [] };
  assert.deepEqual(JSON.parse(compactJson(v)), v);
});

test('card JSON: cost, mana value, colors, keywords; basics without text', () => {
  assert.deepEqual(cards.json('Pacifism'), {
    name: 'Pacifism', cost: '{1}{W}', mv: 2, colors: 'W', type: 'Enchantment — Aura', keywords: ['Enchant creature'],
    text: "Enchant creature\nEnchanted creature can't attack or block.",
  });
  assert.deepEqual(cards.json('Forest'), { name: 'Forest', mv: 0, colors: 'colorless', type: 'Basic Land — Forest' });
  assert.equal(cards.json('Flashback Spell').keywords![0], 'Flashback {3}{R}');
});

test('pack/pool card JSON and pool summary', () => {
  const pc = { name: 'Grizzly Bears', rarity: 'common', colors: ['G'], cmc: 2, typeLine: 'Creature — Bear' };
  assert.deepEqual(packCardJson(pc, 3, cards, '17Lands: GIH WR 55.0%, ATA 4.1'), {
    n: 3, rarity: 'common', name: 'Grizzly Bears', cost: '{1}{G}', mv: 2, colors: 'G', type: 'Creature — Bear', pt: '2/2', '17lands': 'GIH WR 55.0%, ATA 4.1',
  });
  const lines = poolSummaryV4([pc, { name: 'Shock', rarity: 'common', colors: ['R'], cmc: 1, typeLine: 'Instant' }], cards);
  assert.ok(lines.some((l) => l.includes('Green (1): Grizzly Bears {1}{G} Creature 2/2')));
  assert.ok(lines.at(-1)!.includes('1:1 2:1') && lines.at(-1)!.includes('creatures 1, other spells 1'));
});

test('constructed states for mechanics no scripted game reached: case, flip, suspend, emblem, designations, player counters', () => {
  const s = baseState();
  Object.assign(s.objects['10'], { case_state: { is_solved: true }, flipped: true });
  s.objects['24'] = o(24, 'Shock', ME, 'Exile', { counters: { Time: 3 }, casting_permissions: [] });
  s.exile = [24];
  s.objects['25'] = { id: 25, name: 'Emblem', owner: ME, controller: ME, zone: 'Command', is_emblem: true, static_definitions: [{ description: 'Creatures you control get +1/+1.' }] };
  s.command_zone = [25];
  s.monarch = OPP;
  s.initiative = ME;
  s.players[0].player_counters = { Experience: 2 };
  s.players[0].energy = 3;
  s.spells_cast_this_turn_by_player = { 0: [{ name: 'Shock' }] };
  const st = parsed(s);
  const bears = st.battlefield.you.find((x: any) => x.id === 10);
  assert.equal(bears.case_solved, true);
  assert.equal(bears.flipped, true);
  assert.deepEqual(st.exile[0].counters, { time: 3 });
  assert.deepEqual(st.emblems, [{ id: 25, controller: 'you', text: 'Creatures you control get +1/+1.' }]);
  assert.deepEqual(st.opponent.designations, ['monarch']);
  assert.deepEqual(st.you.designations, ['initiative']);
  assert.equal(st.you.experience, 2);
  assert.equal(st.you.energy, 3);
  assert.deepEqual(st.you.spells_cast_this_turn, ['Shock']);
  assert.equal(st.next_turn, 'opponent');
});

test('what a player knows: own decklist, library contents by deduction (never order), sideboard, match so far', () => {
  const ctx = {
    deck: { main: ['Shock', 'Shock', 'Forest', 'Forest', 'Forest', 'Grizzly Bears', 'Flashback Spell'], sideboard: ['Pacifism'] },
    opponentSideboard: 20,
    match: { game: 2, best_of: 3, results: [{ game: 1, winner: 'opponent' as const, turns: 9 }] },
    onPlay: 'you' as const, mulligans: { you: 0, opponent: 1 },
  };
  const st = obs.render(baseState(), { context: ctx, full: true }).state as any;
  const mid = obs.render(baseState(), { context: ctx }).state as any;
  assert.equal(mid.you.decklist, undefined, 'decklist and sideboard only at the start of a game (and in get_view)');
  assert.deepEqual(mid.you.library_contents.cards, { Shock: 1 });
  assert.equal(st.opponent.sideboard_count, 20);
  // Seen elsewhere: Shock (hand), Forest (hand + 2 on the battlefield), Grizzly Bears (battlefield), Flashback Spell (graveyard).
  assert.deepEqual(st.you.library_contents.cards, { Shock: 1 });
  assert.deepEqual(st.you.decklist, { 'Flashback Spell': 1, Forest: 3, 'Grizzly Bears': 1, Shock: 2 });
  assert.deepEqual(st.you.sideboard, ['Pacifism']);
  assert.deepEqual(st.match, { game: 2, best_of: 3, results: [{ game: 1, winner: 'opponent', turns: 9 }], on_the_play: 'you', mulligans: { you: 0, opponent: 1 } });
});

// --- Match memory: the opponent's cards from earlier games of the match ------------------------------------------------

test('match memory (shownCards): public zones and revealed hand cards only; never hidden, face-down, library, token or own hand', () => {
  const s = baseState();
  // A token of theirs, a face-down exiled card of theirs whose name leaks, and their library card leaking a name.
  s.objects['50'] = o(50, 'Grizzly Bears', OPP, 'Battlefield', { is_token: true });
  s.battlefield.push(50);
  s.objects['51'] = o(51, 'Their Secret Bomb', OPP, 'Exile', { face_down: true, display_visible_to_viewer: true });
  s.exile.push(51);
  s.objects['5'] = o(5, 'Hidden Hand Card', OPP, 'Library', { display_visible_to_viewer: false });
  const seen = shownCards(s, OPP, ME);
  assert.deepEqual([...seen].sort((a, b) => a[0] - b[0]), [[11, 'Pacifism'], [14, 'Mountain'], [15, 'Mountain'], [16, 'Insectile Aberration'], [21, 'Grizzly Bears'], [30, 'Shock']]);
  // The opponent's hidden hand card (a stray name without the visibility flag) stays out; revealed, it is in.
  s.objects['3'] = o(3, 'Hidden Hand Card', OPP, 'Hand', { display_visible_to_viewer: false });
  assert.ok(![...shownCards(s, OPP, ME).values()].includes('Hidden Hand Card'));
  s.objects['3'] = o(3, 'Hidden Hand Card', OPP, 'Hand', { display_visible_to_viewer: true });
  assert.equal(shownCards(s, OPP, ME).get(3), 'Hidden Hand Card');
  // A seat's own cards as the opponent saw them: public zones only, never its hand (Shock #1, Forest #2).
  const mine = shownCards(baseState(), ME, ME);
  assert.deepEqual([...mine.keys()].sort((a, b) => a - b), [10, 12, 13, 20]);
  for (const secret of ['Their Secret Bomb', 'Hidden Card']) assert.ok(![...seen.values(), ...mine.values()].includes(secret), `leaked ${secret}`);
});

test('match memory in the decision: names and counts every decision; printed data at the start of a game, only for cards not in the table', () => {
  const ctx = {
    match: { game: 2, best_of: 3, results: [{ game: 1, winner: 'opponent' as const, turns: 9 }] },
    opponentSeen: { Shock: 2, 'Delver of Secrets': 1, Mountain: 7, Pacifism: 1 },
  };
  const v = obs.render(baseState(), { context: ctx, full: true });
  const st = v.state as any;
  assert.deepEqual(st.match.opponent_cards_seen.cards, { 'Delver of Secrets': 1, Mountain: 7, Pacifism: 1, Shock: 2 });
  assert.match(st.match.opponent_cards_seen.note, /earlier games of this match/);
  // Delver isn't in view: its printed data joins the table once; Shock and Pacifism are in view already; basics need none.
  assert.equal(v.cardList.filter((c) => c.name === 'Delver of Secrets').length, 1);
  assert.equal(v.cardList.filter((c) => c.name === 'Shock').length, 1);
  assert.equal(v.cardList.filter((c) => c.name === 'Mountain').length, 0);
  // Mid-game: the same names and counts, no extra printed data (get_card has it; the game's first decision had it).
  const mid = obs.render(baseState(), { context: ctx });
  assert.deepEqual((mid.state as any).match.opponent_cards_seen, st.match.opponent_cards_seen);
  assert.equal(mid.cardList.filter((c) => c.name === 'Delver of Secrets').length, 0);
  // Game 1 (nothing seen yet), or no match context: no field.
  assert.equal((obs.render(baseState(), { context: { match: ctx.match, opponentSeen: {} } }).state as any).match.opponent_cards_seen, undefined);
  assert.equal((obs.render(baseState(), {}).state as any).match, undefined);
});

test('usable now and option ids come from the engine\'s legal actions', () => {
  const byObject = { 1: [{ type: 'CastSpell', data: { object_id: 1 } }], 20: [{ type: 'CastSpell', data: { object_id: 20 } }], 12: [{ type: 'TapLandForMana', data: { selection: { mana_type: 'Green' } } }] };
  const options = [{ id: '1', value: { type: 'PassPriority' } }, { id: '2', value: { type: 'CastSpell', data: { object_id: 1 } } }, { id: '3', value: { type: 'CastSpell', data: { object_id: 20 } } }];
  const st = obs.render(baseState(), { byObject, options }).state as any;
  assert.deepEqual(st.hand.find((x: any) => x.id === 1), { id: 1, card: 'Shock', usable_now: ['cast'], options: ['2'] });
  assert.deepEqual(st.graveyard.you[0], { id: 20, card: 'Flashback Spell', usable_now: ['cast'], options: ['3'] });
});

// --- Real engine states: one per special card layout / zone mechanic -------------------------------------------------
// Captured from scripted games (MTGDT_OBS_DUMP, pruned by obs-fixtures.ts) in HOB, SOS, FRA, TLA, MSH, EOE, TMT, DSK,
// MKM, KHM, OTJ, MID, AKH, NEO, BRO, ZNR, CHK; the card data they need is in the same folder.
{
  const fx = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'observation');
  const states: Record<string, any> = JSON.parse(readFileSync(join(fx, 'states.json'), 'utf8'));
  const cacheDir = mkdtempSync(join(tmpdir(), 'mtgdt-fx-'));
  // CardDb links faces from draft-pools.json next to card-data.json: copy both into the cache dir.
  writeFileSync(join(cacheDir, 'card-data.json'), readFileSync(join(fx, 'card-data.json')));
  writeFileSync(join(cacheDir, 'draft-pools.json'), readFileSync(join(fx, 'draft-pools.json')));
  const realCards = new CardDb(join(cacheDir, 'card-data.json'), cacheDir);
  const run = (key: string) => {
    const f = states[key];
    assert.ok(f, `fixture ${key}`);
    const options = (f.options ?? []).map((x: any, i: number) => ({ id: x.id, value: f.legal[i] }));
    const v = new ObserverV4(realCards, f.me).render(f.state, { byObject: f.byObject, options });
    return { f, v, state: v.state as any, cards: v.cardList, text: v.json + JSON.stringify(v.cardList) + v.summary };
  };
  const all = (v: any): any[] => [...v.state.hand, ...v.state.battlefield.you, ...v.state.battlefield.opponent, ...v.state.graveyard.you, ...v.state.graveyard.opponent, ...v.state.exile, ...v.state.stack];
  const card = (cards: any[], name: string) => cards.find((c) => c.name === name);

  test('real states: valid JSON, no hidden card or redacted field, no id from a hidden zone', () => {
    for (const [key, f] of Object.entries(states)) {
      const { v, text } = run(key);
      JSON.parse(v.json);
      for (const bad of ['Hidden Card', 'layer_base', 'back_face']) assert.ok(!text.includes(bad), `${key}: ${bad}`);
      const s = f.state;
      const hidden = new Set<number>([...s.players[0].library, ...s.players[1].library, ...s.players[1 - f.me].hand.filter((id: number) => s.objects[String(id)]?.display_visible_to_viewer !== true)]);
      const ids = [...v.json.matchAll(/"(?:id|source|attached_to|affects|copy_of_prepared_spell_on)":(\d+)/g), ...v.json.matchAll(/"ids":\[([\d,]+)\]/g)].flatMap((m) => m[1]!.split(',').map(Number));
      for (const id of ids) assert.ok(!hidden.has(id), `${key}: hidden id ${id}`);
    }
  });

  test('real states: match memory holds only cards the decision itself shows (no hidden id or name)', () => {
    for (const [key, f] of Object.entries(states)) {
      const { v } = run(key);
      const s = f.state;
      const hidden = new Set<number>([...s.players[0].library, ...s.players[1].library, ...s.players[1 - f.me].hand.filter((id: number) => s.objects[String(id)]?.display_visible_to_viewer !== true)]);
      for (const [id, name] of shownCards(s, 1 - f.me, f.me)) {
        assert.ok(!hidden.has(id), `${key}: hidden id ${id} (${name}) in match memory`);
        assert.ok(v.json.includes(`"id":${id},`) || v.json.includes(`"source":${id}`) || new RegExp(`"ids":\\[[\\d,]*\\b${id}\\b`).test(v.json), `${key}: #${id} ${name} isn't shown in the decision`);
        assert.ok(v.json.includes(JSON.stringify(name)), `${key}: ${name} isn't named in the decision`);
      }
    }
  });

  test('real states: every identified non-basic card in any zone has a full CARDS entry; multi-face cards carry their faces', () => {
    for (const key of Object.keys(states)) {
      const { v, cards } = run(key);
      for (const x of all(v)) {
        const name = typeof x.card === 'string' && !/^(hidden card|face-down card|face-down spell)$/.test(x.card) ? x.card : x.your_face_down_card;
        if (!name || /^(Plains|Island|Swamp|Mountain|Forest|Wastes|Snow-Covered \w+)$/.test(name)) continue;
        const c = card(cards, name);
        assert.ok(c, `${key}: no CARDS entry for ${name}`);
        if (c.layout && c.layout !== 'prepare') assert.ok(c.faces?.length, `${key}: ${name} (${c.layout}) without faces`);
      }
    }
  });

  test('adventure: in hand both halves; on the stack cast as the adventure; in exile "on an adventure" with the creature castable', () => {
    const hand = run('adventure_hand');
    const adv: any = hand.cards.find((c: any) => c.layout === 'adventure');
    assert.ok(adv && adv.faces[0].text, 'adventure card with its other half');
    const stack = run('stack_adventure').state.stack[0];
    assert.equal(stack.cast_as, 'adventure');
    const ex = run('adventure_on_adventure');
    const onAdv = ex.state.exile.find((x: any) => (x.permissions ?? []).some((p: string) => p.includes('on an adventure')));
    assert.ok(onAdv, 'exiled on an adventure');
    assert.ok(card(ex.cards, onAdv.card).faces.length, 'its adventure half in CARDS');
  });

  test('prepare (SOS/FRA): prepared creature can cast its copy now; the copy in exile names its creature and cost', () => {
    const { state } = run('prepared_bf');
    const prepared = all({ state }).find((x: any) => x.prepared);
    assert.ok(prepared.usable_now.includes('cast prepared copy'));
    assert.ok(prepared.options.length);
    const copy = state.exile.find((x: any) => x.copy_of_prepared_spell_on === prepared.id);
    assert.ok(copy && copy.copy && copy.permissions[0].includes('may cast it for'));
  });

  test('exile permissions: warp, plot, impulse play with duration; foretold (own visible, opponent\'s hidden)', () => {
    assert.ok(run('warp_exile').state.exile.some((x: any) => x.permissions?.some((p: string) => p.includes('warped; may cast it after turn'))));
    assert.ok(run('plotted').state.exile.some((x: any) => x.permissions?.some((p: string) => p.includes('plotted on turn'))));
    const impulse = run('exile_usable').state.exile.find((x: any) => x.usable_now);
    assert.ok(impulse.permissions.some((p: string) => p.includes('until end of your next turn')));
    const own = run('foretold_own').state.exile.find((x: any) => x.foretold);
    assert.ok(own.your_face_down_card && own.permissions[0].includes('foretold on turn'));
    const opp = run('foretold_opp');
    const theirs = opp.state.exile.filter((x: any) => x.card === 'face-down card');
    assert.ok(theirs.length);
    for (const x of theirs) assert.deepEqual(Object.keys(x).sort(), ['card', 'id', 'owner']);
    assert.ok(run('hand_special').state.hand.some((x: any) => x.usable_now?.includes('foretell')));
  });

  test('graveyard: what can be used from there (embalm) comes from the engine', () => {
    assert.ok(run('gy_usable').state.graveyard.you.some((x: any) => x.usable_now?.some((u: string) => /Embalm/.test(u))));
  });

  test('battlefield: transformed with its front face, saga lore, class level, room doors, effects, day/night, exiled with', () => {
    const tr = run('transformed_opp');
    const t = tr.state.battlefield.opponent.find((x: any) => x.transformed);
    assert.ok(card(tr.cards, t.card).faces.length, 'transformed card shows its other face');
    assert.ok(all(run('saga')).some((x: any) => x.counters?.lore));
    assert.ok(all(run('class')).some((x: any) => x.class_level >= 1));
    const doors = all(run('room')).find((x: any) => x.doors);
    assert.ok(Object.values(doors.doors).every((d) => d === 'locked' || d === 'unlocked') && Object.keys(doors.doors).length === 2);
    const eff = run('effects').state.effects[0];
    assert.ok(eff.changes.length && eff.until && eff.affects != null);
    assert.ok(run('day_night').state.day_night);
    assert.ok(run('exile_links').state.exile.some((x: any) => x.exiled_with?.kind));
    const mdfc: any = run('mdfc_hand').cards.find((c: any) => c.layout === 'modal_dfc');
    assert.ok(mdfc.faces[0].type);
    const split: any = run('split_name').cards.find((c: any) => c.name.includes(' // '));
    assert.equal(split.faces.length, 2);
  });

  test('face-down: yours shows the card and can be turned up; the opponent\'s shows only public face-down state', () => {
    const own = all(run('face_down_own_bf')).find((x: any) => x.your_face_down_card);
    assert.ok(own.face_down && own.face_down_as);
    const opp = run('face_down_opp_bf');
    const theirs = opp.state.battlefield.opponent.find((x: any) => x.face_down);
    assert.ok(theirs && !theirs.your_face_down_card && !theirs.card && theirs.pt);
  });

  test('stack: chosen targets; other casting variants (prototype, warp…) named', () => {
    assert.ok(run('stack_targets').state.stack.some((x: any) => x.targets?.length));
    assert.ok(run('stack_variant_other').state.stack.some((x: any) => x.cast_as));
  });
}

console.log(`# ${passed} passed`);
