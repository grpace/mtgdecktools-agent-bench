/**
 * Real engine states for observation tests (render-v4.test.ts). The Director dumps every decision's state when
 * MTGDT_OBS_DUMP=<file.jsonl> is set; `pruneState` keeps only what the v4 renderer can read, plus the fields a
 * hidden-information test must see (redacted objects keep their stray `layer_base_*`), so fixtures stay small.
 * Pruning never adds information: every value comes from the seat's own (already redacted) state.
 */

const OBJ_KEYS = [
  'id', 'name', 'base_name', 'owner', 'controller', 'zone', 'display_visible_to_viewer', 'tapped', 'face_down', 'face_down_cause',
  'flipped', 'transformed', 'damage_marked', 'attached_to', 'attachments', 'counters', 'power', 'toughness', 'base_power',
  'base_toughness', 'layer_base_power', 'layer_base_toughness', 'loyalty', 'defense', 'token_rules_text', 'card_types', 'mana_cost',
  'keywords', 'base_keywords', 'color', 'summoning_sick', 'has_summoning_sickness', 'is_token', 'is_copy', 'prepared',
  'prepared_copy_source', 'phase_status', 'casting_permissions', 'foretold', 'exiled_by', 'available_mana_pips', 'has_mana_ability',
  'class_level', 'room_unlocks', 'case_state', 'monstrous', 'is_renowned', 'is_suspected', 'is_saddled', 'chosen_attributes',
  'cast_from_zone', 'modal_back_face', 'fused_split_spell', 'chosen_modes', 'prototype_form', 'bestow_form', 'merged_components',
  'cast_variant_paid', 'unimplemented_mechanics', 'is_emblem', 'emblem_source', 'goaded_by', 'detained_by', 'paired_with', 'echo_due',
  'entered_battlefield_turn', 'kickers_paid', 'cost_x_paid',
];

function pruneAbility(a: any, depth = 0): any {
  if (!a || typeof a !== 'object' || depth > 6) return undefined;
  const out: any = {};
  for (const k of ['targets', 'description', 'selected_mode_labels']) if (a[k] !== undefined) out[k] = a[k];
  if (a.sub_ability) out.sub_ability = pruneAbility(a.sub_ability, depth + 1);
  return out;
}

function pruneObject(o: any): any {
  if (!o || typeof o !== 'object') return o;
  const out: any = {};
  for (const k of OBJ_KEYS) if (o[k] !== undefined) out[k] = o[k];
  // Abilities only for their descriptions (token text); the back face only for what the renderer reads.
  const desc = (list: any) => (Array.isArray(list) ? list.map((x: any) => ({ description: x?.description ?? null })) : undefined);
  if (o.abilities) out.abilities = desc(o.abilities);
  if (o.trigger_definitions) out.trigger_definitions = desc(o.trigger_definitions);
  if (o.static_definitions) out.static_definitions = desc(o.static_definitions);
  if (o.back_face) out.back_face = { name: o.back_face.name, layout_kind: o.back_face.layout_kind, card_types: o.back_face.card_types };
  return out;
}

export function pruneState(s: any): any {
  if (!s) return s;
  const players = (s.players ?? []).map((p: any) => ({
    id: p.id, life: p.life, poison_counters: p.poison_counters, energy: p.energy, hand: p.hand, library: p.library, graveyard: p.graveyard,
    lands_played_this_turn: p.lands_played_this_turn, mana_pool: p.mana_pool, player_counters: p.player_counters, speed: p.speed,
    turns_taken: p.turns_taken, cards_drawn_this_turn: p.cards_drawn_this_turn, life_gained_this_turn: p.life_gained_this_turn,
    life_lost_this_turn: p.life_lost_this_turn,
  }));
  const stack = (s.stack ?? []).map((e: any) => ({
    id: e.id, source_id: e.source_id, controller: e.controller,
    kind: {
      type: e.kind?.type,
      data: e.kind?.data && {
        card_id: e.kind.data.card_id, casting_variant: e.kind.data.casting_variant, description: e.kind.data.description,
        source_name: e.kind.data.source_name, source_id: e.kind.data.source_id, ability: pruneAbility(e.kind.data.ability),
      },
    },
  }));
  return {
    turn_number: s.turn_number, phase: s.phase, active_player: s.active_player, priority_player: s.priority_player,
    players, battlefield: s.battlefield, exile: s.exile, stack,
    combat: s.combat && { attackers: s.combat.attackers, blocker_assignments: s.combat.blocker_assignments },
    waiting_for: s.waiting_for, exile_links: s.exile_links,
    transient_continuous_effects: s.transient_continuous_effects, day_night: s.day_night, monarch: s.monarch, initiative: s.initiative,
    city_blessing: s.city_blessing, ring_level: s.ring_level, dungeon_progress: s.dungeon_progress, command_zone: s.command_zone,
    spells_cast_this_turn_by_player: s.spells_cast_this_turn_by_player, extra_turns: s.extra_turns, revealed_cards: s.revealed_cards,
    public_revealed_cards: s.public_revealed_cards, turn_direction: s.turn_direction, seat_order: s.seat_order,
    delayed_triggers: (s.delayed_triggers ?? []).map((t: any) => ({ condition: t.condition, controller: t.controller, source_id: t.source_id, ability: pruneAbility(t.ability) })),
    pending_cast: s.pending_cast && { object_id: s.pending_cast.object_id, cost: s.pending_cast.cost, ability: pruneAbility(s.pending_cast.ability) },
    objects: Object.fromEntries(Object.entries(s.objects ?? {}).map(([k, o]) => [k, pruneObject(o)])),
  };
}

/** Legal actions grouped by object, without the per-action interaction ids (they're per session). */
export function pruneByObject(byObject: Record<string, any[]>): Record<string, any[]> {
  return Object.fromEntries(Object.entries(byObject ?? {}).map(([k, acts]) => [k, acts.map(({ interactionActionId: _drop, ...a }) => a)]));
}
