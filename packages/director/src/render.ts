import { CardDb, formatCost } from './cards.js';

/** Renders phase-rs state into compact text for one seat. Never reads hidden objects. */
export class Renderer {
  constructor(private cards: CardDb, private me: number) {}

  private get opp(): number {
    return 1 - this.me;
  }

  who(player: number): string {
    return player === this.me ? 'you' : 'opponent';
  }

  obj(state: any, id: number): any {
    return state.objects?.[String(id)];
  }

  name(state: any, id: number): string {
    return this.obj(state, id)?.name ?? `object ${id}`;
  }

  ref(state: any, id: number): string {
    return `${this.name(state, id)} [#${id}]`;
  }

  keyword(k: any): string {
    if (typeof k === 'string') return k;
    if (k && typeof k === 'object') {
      const [key, val] = Object.entries(k)[0] ?? ['?', null];
      if (typeof val === 'number') return `${key} ${val}`;
      if (val && typeof val === 'object' && (val as any).type === 'Mana') return `${key} ${formatCost((val as any).data)}`;
      return key;
    }
    return String(k);
  }

  /** phase-rs AttachTarget: {type: 'Object', data: id} | {type: 'Player', data: player}; older builds sent a bare id. */
  attachTarget(state: any, t: any): string {
    if (typeof t === 'number') return this.ref(state, t);
    if (t?.type === 'Object') return this.ref(state, t.data);
    if (t?.type === 'Player') return this.who(t.data);
    return 'something';
  }

  permanent(state: any, id: number): string {
    const o = this.obj(state, id);
    if (!o) return `#${id}`;
    const bits: string[] = [this.ref(state, id)];
    if (o.power != null && o.toughness != null) bits.push(`${o.power}/${o.toughness}`);
    if (o.loyalty != null) bits.push(`loyalty ${o.loyalty}`);
    const kws = (o.keywords ?? []).map((k: any) => this.keyword(k));
    if (kws.length) bits.push(`(${kws.join(', ')})`);
    const counters = Object.entries(o.counters ?? {}).map(([c, n]) => `${c}×${n}`);
    if (counters.length) bits.push(`counters: ${counters.join(', ')}`);
    const flags: string[] = [];
    if (o.tapped) flags.push('tapped');
    if (o.summoning_sick || o.has_summoning_sickness) flags.push('summoning sick');
    if (o.damage_marked) flags.push(`${o.damage_marked} damage`);
    if (o.attached_to != null) flags.push(`attached to ${this.attachTarget(state, o.attached_to)}`);
    if (o.face_down) flags.push('face down');
    if (flags.length) bits.push(`[${flags.join(', ')}]`);
    return bits.join(' ');
  }

  private isLand(o: any): boolean {
    return (o?.card_types?.core_types ?? []).includes('Land');
  }

  battlefield(state: any, player: number): string[] {
    const ids: number[] = (state.battlefield ?? []).filter((id: number) => this.obj(state, id)?.controller === player);
    const lands = ids.filter((id) => this.isLand(this.obj(state, id)));
    const others = ids.filter((id) => !this.isLand(this.obj(state, id)));
    const lines = others.map((id) => `  ${this.permanent(state, id)}`);
    if (lands.length) {
      const untapped = lands.filter((id) => !this.obj(state, id).tapped);
      const tapped = lands.filter((id) => this.obj(state, id).tapped);
      const list = (xs: number[]) => xs.map((id) => this.ref(state, id)).join(', ');
      lines.push(`  lands (${untapped.length} untapped): ${list(untapped) || '—'}${tapped.length ? ` | tapped: ${list(tapped)}` : ''}`);
    }
    return lines.length ? lines : ['  (nothing)'];
  }

  stack(state: any): string[] {
    const stack: any[] = state.stack ?? [];
    if (!stack.length) return [];
    // phase-rs keeps the stack bottom-first; show top first.
    return [...stack].reverse().map((e, i) => {
      const kind = e.kind?.type === 'Spell' ? 'spell' : (e.kind?.type ?? 'ability').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
      const desc = e.kind?.data?.description ? ` — ${e.kind.data.description}` : '';
      return `  ${i === 0 ? 'top → ' : '       '}${this.ref(state, e.source_id)} (${kind}, ${this.who(e.controller)})${desc}`;
    });
  }

  combat(state: any): string[] {
    const atk: any[] = state.combat?.attackers ?? [];
    if (!atk.length) return [];
    const blockersOf = state.combat?.blocker_assignments ?? {};
    return atk.map((a) => {
      const target = a.attack_target?.type === 'Player' ? this.who(a.attack_target.data) : this.ref(state, a.attack_target?.data);
      const blockers: number[] = blockersOf[String(a.object_id)] ?? [];
      const b = blockers.length ? ` — blocked by ${blockers.map((id) => this.ref(state, id)).join(', ')}` : a.blocked ? ' — blocked' : '';
      return `  ${this.ref(state, a.object_id)} (${this.who(this.obj(state, a.object_id)?.controller)}) attacking ${target}${b}`;
    });
  }

  zoneNames(state: any, ids: number[]): string {
    return ids.length ? ids.map((id) => this.name(state, id)).join(', ') : '—';
  }

  /** Full board view for this seat. */
  view(state: any): string {
    const me = state.players[this.me];
    const op = state.players[this.opp];
    const phase = String(state.phase).replace(/([a-z])([A-Z])/g, '$1 $2');
    const lines: string[] = [];
    lines.push(`Turn ${state.turn_number} — ${state.active_player === this.me ? 'YOUR turn' : "OPPONENT's turn"} — ${phase}`);
    lines.push(`You:      life ${me.life} | hand ${me.hand.length} | library ${me.library.length} | graveyard ${me.graveyard.length}${me.poison_counters ? ` | poison ${me.poison_counters}` : ''}`);
    lines.push(`Opponent: life ${op.life} | hand ${op.hand.length} | library ${op.library.length} | graveyard ${op.graveyard.length}${op.poison_counters ? ` | poison ${op.poison_counters}` : ''}`);
    lines.push('', 'Opponent battlefield:', ...this.battlefield(state, this.opp));
    lines.push('', 'Your battlefield:', ...this.battlefield(state, this.me));
    const stack = this.stack(state);
    if (stack.length) lines.push('', 'Stack:', ...stack);
    const combat = this.combat(state);
    if (combat.length) lines.push('', 'Combat:', ...combat);
    lines.push('', 'Your hand:');
    lines.push(...(me.hand.length ? me.hand.map((id: number) => {
      const o = this.obj(state, id);
      const types = (o?.card_types?.core_types ?? []).join(' ');
      const pt = o?.power != null && o?.toughness != null ? ` ${o.power}/${o.toughness}` : '';
      return `  ${this.ref(state, id)} ${formatCost(o?.mana_cost)} — ${types}${pt}`;
    }) : ['  (empty)']));
    lines.push('', `Your graveyard: ${this.zoneNames(state, me.graveyard)}`);
    lines.push(`Opponent graveyard: ${this.zoneNames(state, op.graveyard)}`);
    const exile: number[] = state.exile ?? [];
    if (exile.length) lines.push(`Exile: ${exile.map((id) => `${this.name(state, id)} (${this.who(this.obj(state, id)?.owner)})`).join(', ')}`);
    return lines.join('\n');
  }

  /** Names of every card this seat can currently see, for the "new cards" reference block. */
  visibleNames(state: any): string[] {
    const names = new Set<string>();
    const add = (id: number) => {
      const o = this.obj(state, id);
      if (o && o.name && o.name !== 'Hidden Card' && !o.face_down) names.add(o.base_name ?? o.name);
    };
    for (const id of state.battlefield ?? []) add(id);
    for (const e of state.stack ?? []) add(e.source_id);
    for (const p of state.players ?? []) for (const id of p.graveyard ?? []) add(id);
    for (const id of state.players?.[this.me]?.hand ?? []) add(id);
    for (const id of state.exile ?? []) add(id);
    return [...names];
  }

  /** Flatten a phase-rs log entry (segment list) to plain text. */
  logLine(entry: any): string {
    const text = (entry.segments ?? []).map((s: any) => {
      switch (s.type) {
        case 'PlayerName': return s.value?.player_id === this.me ? 'You' : 'Opponent';
        case 'CardName': return s.value?.object_id != null ? `${s.value.name} [#${s.value.object_id}]` : s.value?.name;
        case 'Text': return s.value;
        default: return typeof s.value === 'object' ? (s.value?.name ?? JSON.stringify(s.value)) : String(s.value);
      }
    }).join('');
    return `T${entry.turn} ${entry.phase}: ${text}`;
  }
}
