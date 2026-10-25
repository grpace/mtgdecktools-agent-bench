import { CardDb, CardJson, colorLetters, formatCost, formatTypeLine, keywordText, v4Cost } from './cards.js';
import { isPlanManaAction, makesText, manaActionColors, objectManaColors } from './mana-sources.js';

/**
 * The game observation (current prompts): every game decision carries the whole visible game as structured JSON,
 * with the printed data of every card in view (the same card JSON the MTG Deck Tools deck builder gives its models):
 * everything a player at a real table would know, and nothing they wouldn't.
 *
 * Hidden information: this file reads only what the seat may see. phase-server already redacts the state per
 * seat ("Hidden Card" objects), but some redacted objects still carry stray characteristics (e.g.
 * layer_base_power on cards in a hand or library), so nothing here ever reads an object it can't identify:
 *  - libraries: counts only;
 *  - the opponent's hand: a count, plus cards the engine marks as visible to this seat (revealed);
 *  - face-down permanents/spells: only their face-down characteristics, except the seat's own, whose identity
 *    its controller may look at (CR 708.5);
 *  - every field is copied from an allowlist; raw engine objects are never passed through.
 */

/**
 * The cards of `owner` that `viewer`'s view of the game shows right now (object id → name), for match memory: what a
 * player at the table has seen of a deck. Public zones when face up (battlefield, graveyards, exile, spells on the
 * stack) and, for the viewer's opponent, hand cards the engine marks as revealed to the viewer (the same ones
 * `revealed_hand` shows). Never a library card, a face-down card, a "Hidden Card", a token, a copy or an emblem.
 * Object ids are phase-rs storage ids that a card keeps across zones, so distinct ids are distinct cards.
 */
export function shownCards(state: any, owner: number, viewer: number): Map<number, string> {
  const out = new Map<number, string>();
  const objects = state?.objects ?? {};
  const add = (id: unknown, revealedOnly = false) => {
    const o = objects[String(id)];
    if (!o || o.owner !== owner || o.is_token || o.is_copy || o.is_emblem || o.face_down) return;
    if (!o.name || o.name === 'Hidden Card') return;
    if (revealedOnly && o.display_visible_to_viewer !== true) return;
    out.set(Number(id), String(o.name));
  };
  for (const id of state?.battlefield ?? []) add(id);
  for (const id of state?.exile ?? []) add(id);
  for (const pl of state?.players ?? []) for (const id of pl?.graveyard ?? []) add(id);
  for (const e of state?.stack ?? []) if (e?.kind?.type === 'Spell') add(e.source_id);
  if (owner !== viewer) for (const id of state?.players?.[owner]?.hand ?? []) add(id, true);
  return out;
}

/** Records a card's printed data for the decision and returns what the object's `card` field holds (a name, or the data itself inline). */
type Register = (o: any) => string | CardJson;

/** Which printed-card table a decision carries. 'visible' is the v4 format; the others exist for measurement. */
export type CardTableMode = 'visible' | 'new' | 'inline';

/** What the seat knows from outside the engine state: its own decklist and the match so far. */
export interface V4Context {
  /** This seat's deck (front-face names): a player knows their own 40 and their sideboard. */
  deck?: { main: string[]; sideboard: string[] };
  /** How many cards the opponent has in their sideboard (public between games). */
  opponentSideboard?: number;
  match?: { game: number; best_of: number; results: Array<{ game: number; winner: 'you' | 'opponent' | 'draw'; turns: number }> };
  /**
   * Match memory: the opponent's cards this seat saw in earlier games of this match (`shownCards`), name → the most
   * copies seen in one game. Public information a player at the table remembers; nothing that was only ever hidden.
   * Names and counts at every decision; the printed data of those not in view with `full` (like the decklist).
   */
  opponentSeen?: Record<string, number>;
  onPlay?: 'you' | 'opponent';
  mulligans?: { you: number; opponent: number };
}

export interface V4Options {
  /** Legal actions grouped by object (phase-rs `legal_actions_by_object`): exact mana sources, what each card can do now. */
  byObject?: Record<string, any[]>;
  /** The decision's options (id + engine action): each object lists the option ids that involve it. */
  options?: Array<{ id: string; value: unknown }>;
  context?: V4Context;
  /**
   * Add what doesn't change during a game (your decklist and sideboard, the opponent's sideboard size). Default: at
   * the start of each game (the mulligan decision); get_view always. Mid-game, `library_contents` covers the decklist.
   */
  full?: boolean;
  /** 'visible' (default): every card in view, every decision. 'new': only names not sent earlier this game. 'inline': no table, printed data inside each object. */
  cardTable?: CardTableMode;
  /** For cardTable 'new': names already sent this game (updated in place). */
  sent?: Set<string>;
}

const COUNTER_NAMES: Record<string, string> = { P1P1: '+1/+1', M1M1: '-1/-1' };
const BASIC_COLORS: Record<string, string> = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G', Wastes: 'C' };
const COLOR_LETTER: Record<string, string> = { White: 'W', Blue: 'U', Black: 'B', Red: 'R', Green: 'G', Colorless: 'C' };
/** Engine actions that are about choosing, not about using a card: they don't make a card "usable now". */
const NOT_A_USE = new Set(['PassPriority', 'ChooseTarget', 'SelectCards', 'CancelCast', 'DeclareAttackers', 'DeclareBlockers', 'MulliganDecision', 'TapForConvoke', 'UntapLandForMana', 'SpendPoolMana', 'UnspendPoolMana']);

/** Keyword abilities that are activated (from any zone): named when the engine gives the ability no text. */
const ACTIVATED_KEYWORDS = /^(Embalm|Eternalize|Unearth|Scavenge|Encore|Cycling|.*cycling|Channel|Ninjutsu|Reinforce|Transmute|Forecast|Boast|Craft|Station|Crew|Equip|Reconfigure|Outlast|Level up|Monstrosity|Adapt|Saddle|Fortify|Bloodrush)/i;

export const words = (t: string): string => String(t).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();

/** phase-rs Duration → "until end of turn", "until end of next turn of you"… */
function durationText(d: any, who: (p: unknown) => string, self?: string): string | undefined {
  if (d == null) return undefined;
  if (typeof d === 'string') return words(d);
  const t = d.type ?? Object.keys(d)[0];
  const data = d.type ? d : d[t];
  const player = data?.player ?? data?.data;
  const whose = typeof player === 'number' ? who(player) : player?.type === 'Controller' && self ? self : typeof player?.type === 'string' ? words(player.type) : '';
  return `${words(t)}${whose ? ` ${whose}` : ''}`.replace(/ of$/, '').replace(/next turn of you$/, 'your next turn').replace(/next turn of opponent$/, "the opponent's next turn");
}

/** Ids of the objects an engine action involves (the card it casts or activates, its target, the cards it selects). */
export function actionObjects(a: any): number[] {
  const d = a?.data ?? {};
  const out: number[] = [];
  for (const k of ['object_id', 'source_id', 'source', 'vehicle_id', 'equipment_id', 'mount_id', 'spacecraft_id']) if (typeof d[k] === 'number') out.push(d[k]);
  if (d.target?.Object != null) out.push(d.target.Object);
  for (const k of ['cards', 'creature_ids', 'targets']) if (Array.isArray(d[k])) for (const x of d[k]) if (typeof x === 'number') out.push(x);
  return [...new Set(out)];
}

/** A phase-rs AbilityCost (or ManaCost) as printed: "{2}{G}", "{T}", "[−2]", "{1}, {T}, Sacrifice this", "Pay 2 life". */
export function costText(c: any): string {
  if (c == null) return '';
  if (typeof c === 'string') return words(c);
  if (c.type === 'Cost' || c.type === 'NoCost') return v4Cost(formatCost(c));
  switch (c.type) {
    case 'Mana': return v4Cost(formatCost(c.cost));
    case 'Tap': return '{T}';
    case 'Untap': return '{Q}';
    case 'Loyalty': return `[${c.amount > 0 ? '+' : c.amount < 0 ? '−' : ''}${Math.abs(Number(c.amount ?? 0))}]`;
    case 'Composite': return (c.costs ?? []).map(costText).filter(Boolean).join(', ');
    case 'PayLife': return `Pay ${typeof c.amount === 'number' ? c.amount : c.amount?.value ?? 'X'} life`;
    case 'Discard': return c.self_ref ? 'Discard this card' : `Discard ${c.count?.value ?? 1} card${(c.count?.value ?? 1) === 1 ? '' : 's'}`;
    case 'Sacrifice': return c.self_ref || c.data?.self_ref || c.target?.type === 'SelfRef' ? 'Sacrifice this' : 'Sacrifice a permanent';
    case 'Exile': return c.self_ref ? 'Exile this card' : 'Exile cards';
    default: return words(String(c.type ?? ''));
  }
}

/** The mana part of a cost (a phase-rs ManaCost), if it has one: Mana, or the Mana inside a Composite. */
export function manaPart(c: any): any {
  if (!c || typeof c !== 'object') return undefined;
  if (c.type === 'Cost') return c;
  if (c.type === 'Mana') return c.cost;
  if (c.type === 'ManaDynamic') return { type: 'Cost', shards: [], generic: 0, dynamic: true };
  if (c.type === 'Composite') for (const x of c.costs ?? []) { const m = manaPart(x); if (m) return m; }
  return undefined;
}

/**
 * What an activated ability does, as text: the engine's description, else the line of the card's printed text that
 * starts with the ability's cost ("[−1]: Surveil 1."), else the activated keyword ("Basic landcycling {2}"), else its
 * cost and effect. `printed` is the card's printed text (or a token's rules text).
 */
export function abilityText(o: any, index: number, printed?: string): string | undefined {
  const ab = o?.abilities?.[index];
  const name = String(o?.name ?? 'this');
  const desc = ab?.description;
  if (desc) return String(desc).replace(/~/g, name);
  const cost = costText(ab?.cost);
  const norm = (t: string) => t.replace(/\u2212/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();
  const lines = String(printed ?? o?.token_rules_text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (cost) {
    const line = lines.find((l) => norm(l).startsWith(`${norm(cost)}:`));
    if (line) return line.replace(/~/g, name);
  }
  const kws = (o?.keywords ?? []).map(keywordText).filter((k: string) => ACTIVATED_KEYWORDS.test(k));
  if (kws.length === 1) return kws[0];
  if (kws.length > 1 && cost) {
    const k = kws.find((x: string) => norm(x).endsWith(norm(cost.split(', ')[0]!)));
    if (k) return k;
  }
  const effect = ab?.effect?.type ? words(String(ab.effect.type)) : '';
  if (cost) return `${cost}: ${effect || 'see the card text'}`;
  return undefined;
}

/** Short name of what an action does with its card: "cast", "play land", "activate: {T}: Draw a card.", "foretell"… */
function useName(a: any, o: any, printed?: string): string {
  const t = String(a?.type ?? '');
  if (t === 'CastSpell') return 'cast';
  if (t === 'PlayLand') return 'play land';
  if (t === 'ActivateAbility') {
    const index = Number(a.data?.ability_index ?? 0);
    const text = abilityText(o, index, printed);
    // The same 1-based number as the option label when nothing better is known.
    return text ? `activate: ${text}` : `activate (ability ${index + 1})`;
  }
  return words(t.replace(/^CastSpellAs/, 'CastAs'));
}
const STEP_NAMES: Record<string, string> = {
  Untap: 'untap', Upkeep: 'upkeep', Draw: 'draw', PreCombatMain: 'precombat main', BeginCombat: 'beginning of combat',
  DeclareAttackers: 'declare attackers', DeclareBlockers: 'declare blockers', FirstStrikeDamage: 'first-strike damage',
  CombatDamage: 'combat damage', EndCombat: 'end of combat', PostCombatMain: 'postcombat main', End: 'end step', Cleanup: 'cleanup',
};

export function stepName(phase: unknown): string {
  const p = String(phase ?? '');
  return STEP_NAMES[p] ?? p.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

/**
 * Serialize as valid JSON with one entry per line for arrays of objects (each entry on a single line, however
 * nested), and one key per line for objects that hold such arrays. Compact like JSON.stringify otherwise.
 */
export function compactJson(v: unknown, indent = ''): string {
  const inner = indent + ' ';
  const listOfObjects = (x: unknown) => Array.isArray(x) && x.some((y) => y && typeof y === 'object');
  const holdsLists = (x: unknown): boolean => !!x && typeof x === 'object' && !Array.isArray(x) && Object.values(x).some((y) => listOfObjects(y) || holdsLists(y));
  if (listOfObjects(v)) return `[\n${(v as unknown[]).map((x) => inner + JSON.stringify(x)).join(',\n')}\n${indent}]`;
  if (holdsLists(v)) {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    return `{\n${entries.map(([k, x]) => `${inner}${JSON.stringify(k)}:${compactJson(x, inner)}`).join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(v);
}

/**
 * Identical objects (same card, same state; typically basic lands and tokens) become one entry with `ids`, so a board
 * of nine untapped Mountains is one line. Order is kept (first occurrence).
 */
export function groupIdentical(list: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const byKey = new Map<string, Record<string, unknown>>();
  for (const x of list) {
    const { id, ...rest } = x;
    const key = JSON.stringify(rest);
    const g = byKey.get(key);
    if (g) {
      if (g.id !== undefined) {
        g.ids = [g.id];
        delete g.id;
      }
      (g.ids as unknown[]).push(id);
      continue;
    }
    const entry: Record<string, unknown> = { id, ...rest };
    byKey.set(key, entry);
    out.push(entry);
  }
  // `ids` first, like `id`: {"ids":[…],"card":"Mountain"}.
  return out.map((e) => (e.ids ? { ids: e.ids, ...Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'ids')) } : e));
}

interface ZoneCtx {
  uses: Map<number, any[]>;
  optionIds: Map<number, string[]>;
}

/** An effect's modification, readably: {type: "AddPower", value: 2} → "add power 2", {type:"AddKeyword", keyword:"Flying"} → "add keyword flying". */
function modText(m: any): string {
  if (m == null) return '';
  if (typeof m === 'string') return words(m);
  // Granted abilities carry their own text: use it.
  const desc = findDescription(m);
  if (desc) return `${words(String(m.type ?? 'grant'))}: ${desc}`;
  const { type, ...rest } = m;
  const vals = Object.values(rest).flatMap((v: any) => (v == null ? [] : typeof v === 'object' ? [keywordText(v) !== '[object Object]' ? keywordText(v) : ''] : [String(v)])).filter((x) => x && x !== '[object Object]');
  return [words(String(type ?? '')), ...vals.map((v) => (/^[A-Z][a-z]/.test(v) ? words(v) : v))].join(' ').trim();
}

export function findDescription(x: any, depth = 0): string | undefined {
  if (!x || typeof x !== 'object' || depth > 5) return undefined;
  if (typeof x.description === 'string' && x.description) return x.description;
  for (const v of Object.values(x)) {
    const d = findDescription(v, depth + 1);
    if (d) return d;
  }
  return undefined;
}

/** A target filter as words ("creatures you control"), when an effect doesn't name one object. */
function describeFilter(f: any): string {
  if (!f || typeof f !== 'object') return String(f ?? '');
  const parts: string[] = [];
  if (Array.isArray(f.type_filters)) parts.push(...f.type_filters.filter((x: unknown) => typeof x === 'string').map((x: string) => x.toLowerCase()));
  if (f.controller === 'You') parts.push('you control');
  if (f.controller === 'Opponent') parts.push('an opponent controls');
  return parts.length ? parts.join(' ') : words(String(f.type ?? 'objects'));
}

/** Untapped mana as {"total": n, "W": [ids], "G/W": [ids]}: what each source can make, by object id. */
function manaByColor(list: Array<{ id: number; makes: string }>): Record<string, unknown> {
  const out: Record<string, unknown> = { total: list.length };
  for (const m of list) ((out[m.makes] ??= []) as number[]).push(m.id);
  return out;
}

export class ObserverV4 {
  constructor(private cards: CardDb, private me: number) {}

  private get opp(): number {
    return 1 - this.me;
  }

  private who(player: unknown): string {
    return player === this.me ? 'you' : 'opponent';
  }

  private obj(state: any, id: unknown): any {
    return state?.objects?.[String(id)];
  }

  /** May this seat know the object's identity? (The engine's projection, never guessed.) */
  private identified(o: any): boolean {
    if (!o || !o.name || o.name === 'Hidden Card') return false;
    if (o.face_down) return o.controller === this.me;
    return true;
  }

  /** Printed data for a card in view: CardDb by face name, else (tokens, unknown cards) built from the object. */
  private printed(o: any): CardJson {
    const name = String(o.name);
    if (this.cards.get(name)) {
      const card = this.cards.json(name);
      // The engine knows this object's other face (prepare spells are shared by several creatures, so the card
      // data alone can't say which one this is).
      const back = o.face_down ? undefined : o.back_face?.name;
      if (back && back !== name && !card.faces?.some((f) => f.name === back) && this.cards.get(back)) card.faces = [...(card.faces ?? []), this.cards.json(back, false)];
      return card;
    }
    const kws = (o.keywords ?? []).map(keywordText).filter(Boolean);
    const text = o.token_rules_text
      ?? [...(o.abilities ?? []), ...(o.trigger_definitions ?? []), ...(o.static_definitions ?? [])].map((a: any) => a?.description).filter(Boolean).join('\n').replace(/~/g, name);
    const out: CardJson = { name, mv: 0, colors: colorLetters(o.color) || 'colorless', type: formatTypeLine(o.card_types) };
    const cost = o.mana_cost?.type === 'Cost' ? v4Cost(formatCost(o.mana_cost)) : '';
    if (cost && cost !== '{0}') out.cost = cost;
    if (o.base_power != null && o.base_toughness != null) out.pt = `${o.base_power}/${o.base_toughness}`;
    if (o.loyalty != null) out.loyalty = String(o.loyalty);
    if (kws.length) out.keywords = kws;
    if (text) out.text = text;
    return out;
  }

  private counters(o: any): Record<string, number> | undefined {
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(o.counters ?? {})) {
      if (typeof n !== 'number' || n === 0) continue;
      if (/^loyalty$/i.test(k) && o.loyalty != null) continue;
      if (/^defense$/i.test(k) && o.defense != null) continue;
      out[COUNTER_NAMES[k] ?? k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()] = n;
    }
    return Object.keys(out).length ? out : undefined;
  }

  private attachId(t: any): number | string | undefined {
    if (t == null) return undefined;
    if (typeof t === 'number') return t;
    if (t.type === 'Object') return t.data;
    if (t.type === 'Player') return this.who(t.data);
    return undefined;
  }

  /** Colors an untapped permanent can make, as "G", "W/G", "any"; undefined if it's not a mana source. */
  private manaOf(o: any): string | undefined {
    const pips: any[] = o.available_mana_pips ?? [];
    const letters = new Set<string>();
    for (const p of pips) {
      if (p?.type === 'Color') letters.add(COLOR_LETTER[p.data] ?? p.data);
      else if (p?.type === 'Colorless') letters.add('C');
      else if (Array.isArray(p?.data)) for (const c of p.data) letters.add(COLOR_LETTER[c] ?? c);
    }
    if (!letters.size && (o.card_types?.core_types ?? []).includes('Land')) {
      for (const st of o.card_types?.subtypes ?? []) if (BASIC_COLORS[st]) letters.add(BASIC_COLORS[st]!);
    }
    if (!letters.size) {
      // Mana rocks, dorks, Treasures: the engine's mana abilities (is_mana_ability) and what they make.
      for (const c of objectManaColors(o)) letters.add(COLOR_LETTER[c] ?? c);
    }
    if (!letters.size) {
      // Older card data without the flag: "{T}: Add {G} or {W}." / "{T}: Add one mana of any color."
      const text = this.cards.get(String(o.name))?.oracle ?? '';
      for (const m of text.matchAll(/\{T\}[^:\n]*: Add ([^.\n]+)/g)) {
        if (/one mana of any colou?r/i.test(m[1]!)) return 'any';
        for (const sym of m[1]!.matchAll(/\{([WUBRGC])\}/g)) letters.add(sym[1]!);
      }
    }
    if (!letters.size) return undefined;
    if (['W', 'U', 'B', 'R', 'G'].every((l) => letters.has(l))) return 'any';
    return ['W', 'U', 'B', 'R', 'G', 'C'].filter((l) => letters.has(l)).join('/');
  }

  /**
   * Untapped mana sources a player controls: exact for this seat when known (its legal mana actions: lands, and the
   * mana abilities of creatures, artifacts and tokens that a tap plan can use), else derived.
   */
  private untappedMana(state: any, player: number, byObject?: Record<string, any[]>): Array<{ id: number; card: string; makes: string }> {
    const out: Array<{ id: number; card: string; makes: string }> = [];
    if (player === this.me && byObject) {
      for (const [id, acts] of Object.entries(byObject)) {
        const colors = [...new Set(acts.filter((a) => isPlanManaAction(state, a)).flatMap((a) => manaActionColors(state, a)))];
        const o = this.obj(state, id);
        if (colors.length && o) out.push({ id: Number(id), card: this.identified(o) ? String(o.name) : 'face-down permanent', makes: makesText(colors) });
      }
      if (out.length) return out;
    }
    for (const id of state.battlefield ?? []) {
      const o = this.obj(state, id);
      if (!o || o.controller !== player || o.tapped || !this.identified(o)) continue;
      const isCreature = (o.card_types?.core_types ?? []).includes('Creature');
      if (isCreature && (o.summoning_sick || o.has_summoning_sickness)) continue;
      const makes = this.manaOf(o);
      if (makes) out.push({ id: Number(id), card: String(o.name), makes });
    }
    return out;
  }

  /** Characteristics that differ from the printed card (type-changing, color-changing effects). */
  private changed(o: any, card: CardJson | undefined): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!card) return out;
    const type = formatTypeLine(o.card_types);
    if (type && type !== card.type && !card.type.split(' // ').includes(type)) out.type = type;
    const colors = colorLetters(o.color) || 'colorless';
    if (Array.isArray(o.color) && colors !== card.colors) out.colors = colors;
    return out;
  }

  /** A casting permission (exile, mostly), from the engine: who may do what with the card, and until when. */
  private permission(p: any, o: any): string {
    const t = typeof p === 'string' ? p : p?.type ?? Object.keys(p ?? {})[0] ?? 'permission';
    const d = typeof p === 'object' && p ? (p.type ? p : p[t] ?? {}) : {};
    const who = d.granted_to != null ? this.who(d.granted_to) : this.who(o.owner);
    const until = d.duration ? `, ${durationText(d.duration, (x) => this.who(x), who)}` : '';
    const cost = (c: any) => (c?.type === 'Cost' ? v4Cost(formatCost(c)) : 'its cost');
    switch (t) {
      case 'AdventureCreature': return `${who}: on an adventure; may cast the creature`;
      case 'ExileWithAltCost': return `${who}: may cast it ${d.cost?.type === 'NoCost' ? 'without paying its mana cost' : `for ${cost(d.cost)}`}${d.cast_transformed ? ' (transformed)' : ''}${until}`;
      // CardPlayMode: absent means "Play" (cast it, or play it as a land).
      case 'PlayFromExile': return `${who}: may ${d.mode === 'Cast' ? 'cast' : 'play'} it${until}`;
      case 'ExileWithEnergyCost': return `${who}: may cast it by paying energy`;
      case 'ExileWithAltAbilityCost': return `${who}: may cast it for an alternative cost${until}`;
      case 'WarpExile': return `${who}: warped; may cast it after turn ${d.castable_after_turn}`;
      case 'Plotted': return `${who}: plotted on turn ${d.turn_plotted}; may cast it without paying its mana cost on a later turn, as a sorcery`;
      case 'Foretold': return `${who}: foretold on turn ${d.turn_foretold}; may cast it for ${cost(d.cost)} on a later turn`;
      default: return `${who}: ${words(t)}${until}`;
    }
  }

  /**
   * State a card carries in any zone, from the engine: counters (time, lore…), permissions, how it was exiled, class
   * level, room doors, case, flip, prepared, and what this seat can do with it right now (`usable`, from the engine's
   * legal actions, so new mechanics show up without code) and which of this decision's options involve it.
   */
  private zoneState(state: any, o: any, known: boolean, ctx: ZoneCtx): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const counters = this.counters(o);
    if (counters) out.counters = counters;
    if (o.face_down && o.face_down_cause) out.face_down_as = words(o.face_down_cause);
    const opts = ctx.optionIds.get(o.id);
    // A card this seat can't identify shows only public marks: counters, how it was turned face down, the options
    // that involve it. Nothing about the card underneath (a class level, a permission's cost…).
    if (!known) {
      if (opts?.length) out.options = opts;
      return out;
    }
    if (o.flipped) out.flipped = true;
    if (o.prepared) out.prepared = true;
    if (o.prepared_copy_source != null) out.copy_of_prepared_spell_on = o.prepared_copy_source;
    if (o.class_level != null) out.class_level = o.class_level;
    if (o.room_unlocks) {
      // A Room's name follows its unlocked doors; name both doors from the card data.
      const name = String(o.name);
      const halves = name.includes(' // ') ? name.split(' // ') : [name, ...(this.cards.json(name).faces ?? []).map((f) => f.name)];
      const left = halves[0] ?? 'left door';
      const right = halves[1] ?? 'right door';
      out.doors = { [left]: o.room_unlocks.left_unlocked ? 'unlocked' : 'locked', [right]: o.room_unlocks.right_unlocked ? 'unlocked' : 'locked' };
    }
    if (o.case_state) out.case_solved = !!o.case_state.is_solved;
    if (o.monstrous) out.monstrous = true;
    if (o.is_renowned) out.renowned = true;
    if (o.is_suspected) out.suspected = true;
    if (o.is_saddled) out.saddled = true;
    if (o.echo_due) out.echo_due = true;
    if (o.paired_with != null) out.paired_with = o.paired_with;
    if (Array.isArray(o.goaded_by) && o.goaded_by.length) out.goaded = true;
    if (o.foretold) out.foretold = true;
    if (Array.isArray(o.chosen_attributes) && o.chosen_attributes.length) out.chosen = o.chosen_attributes.map((c: any) => (typeof c === 'object' ? Object.values(c).flat().map(String).join(' ') : String(c)));
    const perms = (o.casting_permissions ?? []).map((p: any) => this.permission(p, o));
    if (perms.length) out.permissions = perms;
    const link = (state.exile_links ?? []).find((l: any) => l?.exiled_id === o.id);
    if (link) {
      const src = this.obj(state, link.source_id);
      out.exiled_with = { id: link.source_id, ...(src && this.identified(src) && !src.face_down ? { card: String(src.name) } : {}), ...(link.kind ? { kind: words(typeof link.kind === 'string' ? link.kind : link.kind.type ?? Object.keys(link.kind)[0]) } : {}) };
    }
    if (o.controller === this.me || o.owner === this.me) {
      // Mana abilities are under untapped_mana; the rest is what this card can do right now.
      const uses = [...new Set((ctx.uses.get(o.id) ?? []).map((a) => useName(a, o, this.cards.get(String(o.name))?.oracle)).filter((u) => !/^activate: \{T\}[^:]*: Add /.test(u)))];
      if (uses.length) out.usable_now = uses;
    }
    if (opts?.length) out.options = opts;
    return out;
  }

  /**
   * One object in view. `card` names its printed data in the CARDS table (or, in 'inline' mode, the data itself).
   * `withState` adds battlefield state (tapped, counters, P/T…).
   */
  private object(state: any, id: number, register: Register, ctx: ZoneCtx, extra: Record<string, unknown> = {}, withState = false): Record<string, unknown> {
    const o = this.obj(state, id);
    const out: Record<string, unknown> = { id };
    if (!o) return { id, card: 'unknown' };
    const known = this.identified(o);
    let card: CardJson | undefined;
    if (o.face_down) {
      out.face_down = true;
      if (known) {
        card = this.printed(o);
        out.your_face_down_card = register(o);
      }
    } else if (known) {
      card = this.printed(o);
      out.card = register(o);
    } else {
      out.card = 'hidden card';
    }
    if (o.controller !== o.owner && o.owner != null) out.owner = this.who(o.owner);
    if (o.is_token) out.token = true;
    if (o.is_copy) out.copy = true;
    if (!withState) return Object.assign(out, this.zoneState(state, o, known, ctx), extra);
    if (!o.face_down) Object.assign(out, this.changed(o, card));
    if (o.power != null && o.toughness != null) {
      out.pt = `${o.power}/${o.toughness}`;
      const base = o.base_power != null && o.base_toughness != null ? `${o.base_power}/${o.base_toughness}` : undefined;
      if (base && base !== out.pt) out.base_pt = base;
    }
    if (o.loyalty != null) out.loyalty = o.loyalty;
    if (o.defense != null) out.defense = o.defense;
    // Face-down permanents show the engine's face-down characteristics, which are public (a disguised creature is a
    // 2/2 with ward {2}); the card underneath is redacted by the engine and never read here.
    const kws: string[] = (o.keywords ?? []).map(keywordText).filter(Boolean);
    if (kws.length) out.keywords = kws;
    const printedKw = new Set((card?.keywords ?? []).map((k) => k.toLowerCase()));
    const baseKw = new Set((o.base_keywords ?? []).map(keywordText).map((k: string) => k.toLowerCase()));
    const granted = kws.filter((k) => !printedKw.has(k.toLowerCase()) && !baseKw.has(k.toLowerCase()));
    if (granted.length && card) out.granted = granted;
    if (o.damage_marked) out.damage = o.damage_marked;
    if (o.tapped) out.tapped = true;
    if ((o.summoning_sick || o.has_summoning_sickness) && (o.card_types?.core_types ?? []).includes('Creature')) out.sick = true;
    if (o.transformed) out.transformed = true;
    if (o.phase_status?.status === 'PhasedOut') out.phased_out = true;
    Object.assign(out, this.zoneState(state, o, known, ctx));
    const at = this.attachId(o.attached_to);
    if (at !== undefined) out.attached_to = at;
    const atts: number[] = (o.attachments ?? []).map((a: any) => this.attachId(a)).filter((a: unknown) => typeof a === 'number');
    if (atts.length) out.attachments = atts;
    return Object.assign(out, extra);
  }

  /** The visible game as JSON (`state`, and compact text `json`), the printed-card table, and a one-line summary. */
  render(state: any, opts: V4Options = {}): { summary: string; json: string; cards: string; state: Record<string, unknown>; cardList: CardJson[] } {
    const mode = opts.cardTable ?? 'visible';
    const table = new Map<string, CardJson>();
    const register: Register = (o: any) => {
      const card = this.printed(o);
      if (mode === 'inline') return card;
      // Basic lands need no table entry: the name says it all (saves ~100 tokens a decision).
      if (!/^Basic Land/.test(card.type)) table.set(card.name, card);
      return String(o.name);
    };
    // What each object can do now (the engine's legal actions) and which of this decision's options involve it.
    const ctx: ZoneCtx = { uses: new Map(), optionIds: new Map() };
    for (const [id, acts] of Object.entries(opts.byObject ?? {})) {
      const useful = acts.filter((a) => !isPlanManaAction(state, a) && !NOT_A_USE.has(a?.type));
      if (useful.length) ctx.uses.set(Number(id), useful);
    }
    for (const opt of opts.options ?? []) {
      for (const id of actionObjects(opt.value)) {
        const list = ctx.optionIds.get(id) ?? [];
        list.push(opt.id);
        ctx.optionIds.set(id, list);
      }
    }
    const wf = state.waiting_for ?? {};
    const canAttack = new Set<number>(wf.type === 'DeclareAttackers' ? wf.data?.valid_attacker_ids ?? [] : []);
    const canBlock: Record<string, number[]> = wf.type === 'DeclareBlockers' ? wf.data?.valid_block_targets ?? {} : {};
    const players = state.players ?? [];
    const me = players[this.me] ?? {};
    const op = players[this.opp] ?? {};

    const perm = (id: number) => {
      const extra: Record<string, unknown> = {};
      if (canAttack.has(id)) extra.can_attack = true;
      if (canBlock[String(id)]?.length) extra.can_block = canBlock[String(id)];
      return this.object(state, id, register, ctx, extra, true);
    };
    const isLand = (id: number) => (this.obj(state, id)?.card_types?.core_types ?? []).includes('Land');
    const side = (player: number) => {
      const ids: number[] = (state.battlefield ?? []).filter((id: number) => this.obj(state, id)?.controller === player);
      // Non-lands first, then lands: the board reads like a table.
      return groupIdentical([...ids.filter((id) => !isLand(id)), ...ids.filter(isLand)].map(perm));
    };

    const exileIds: number[] = state.exile ?? [];
    const exileCount = (player: number) => exileIds.filter((id) => this.obj(state, id)?.owner === player).length;
    const zoneCard = (id: number, extra: Record<string, unknown> = {}) => {
      const o = this.obj(state, id);
      if (!o || !this.identified(o)) {
        // Someone else's hidden card (e.g. the opponent's foretold card): only that it's face down, and public marks.
        return { id, card: o?.face_down ? 'face-down card' : 'hidden card', ...(o?.foretold ? { foretold: true } : {}), ...extra };
      }
      // Graveyards and exile are part of the board: every card gets its full CARDS entry, like the battlefield.
      // Your own face-down cards in exile (foretold…) show what they are, like your face-down permanents.
      const marks = { ...(o.is_token ? { token: true } : {}), ...(o.is_copy ? { copy: true } : {}) };
      if (o.face_down) return Object.assign({ id, face_down: true, your_face_down_card: register(o) }, marks, this.zoneState(state, o, true, ctx), extra);
      return Object.assign({ id, card: register(o) }, marks, this.zoneState(state, o, true, ctx), extra);
    };

    const player = (pl: any, who: number) => {
      const out: Record<string, unknown> = {
        life: pl.life, hand: pl.hand?.length ?? 0, library: pl.library?.length ?? 0, graveyard: pl.graveyard?.length ?? 0, exile: exileCount(who),
      };
      if (pl.poison_counters) out.poison = pl.poison_counters;
      if (pl.energy) out.energy = pl.energy;
      for (const [k, n] of Object.entries(pl.player_counters ?? {})) if (typeof n === 'number' && n && !/^poison$/i.test(k)) out[words(k)] = n;
      if (pl.speed != null) out.speed = pl.speed;
      out.lands_played_this_turn = pl.lands_played_this_turn ?? 0;
      const cast = state.spells_cast_this_turn_by_player?.[String(who)] ?? state.spells_cast_this_turn_by_player?.[who];
      if (Array.isArray(cast) && cast.length) out.spells_cast_this_turn = cast.map((r: any) => r?.name || 'a spell');
      if (pl.life_gained_this_turn) out.life_gained_this_turn = pl.life_gained_this_turn;
      if (pl.life_lost_this_turn) out.life_lost_this_turn = pl.life_lost_this_turn;
      if (pl.cards_drawn_this_turn) out.cards_drawn_this_turn = pl.cards_drawn_this_turn;
      const marks: string[] = [];
      if (state.monarch === who) marks.push('monarch');
      if (state.initiative === who) marks.push('initiative');
      if ((state.city_blessing ?? []).includes?.(who)) marks.push("city's blessing");
      const ring = state.ring_level?.[String(who)];
      if (ring) marks.push(`the Ring level ${ring}`);
      const dungeon = state.dungeon_progress?.[String(who)];
      if (dungeon) marks.push(`dungeon: ${typeof dungeon === 'object' ? Object.values(dungeon).filter((x) => typeof x !== 'object').join(' ') : String(dungeon)}`);
      if (marks.length) out.designations = marks;
      const pool = (pl.mana_pool?.mana ?? []).map((m: any) => `{${COLOR_LETTER[m.color] ?? m.color}}`).join('');
      if (pool) out.mana_pool = pool;
      out.untapped_mana = manaByColor(this.untappedMana(state, who, who === this.me ? opts.byObject : undefined));
      return out;
    };

    const you = player(me, this.me);
    const opponent = player(op, this.opp);
    // The opponent's hand: only cards the engine shows this seat (revealed); never the hidden ones.
    const knownOppHand = (op.hand ?? []).filter((id: number) => {
      const o = this.obj(state, id);
      return o && o.display_visible_to_viewer === true && !o.face_down && o.name !== 'Hidden Card';
    });
    if (knownOppHand.length) opponent.revealed_hand = knownOppHand.map((id: number) => this.object(state, id, register, ctx));
    const full = opts.full ?? state.waiting_for?.type === 'MulliganDecision';
    const known = this.libraryKnowledge(state, opts.context, full);
    if (known) Object.assign(you, known);
    if (full && opts.context?.opponentSideboard != null) opponent.sideboard_count = opts.context.opponentSideboard;

    const stack = [...(state.stack ?? [])].reverse().map((e: any, i: number) => this.stackItem(state, e, i === 0, register, ctx));
    const combat = this.combat(state);
    const extra = (state.extra_turns ?? [])[0];
    const c = opts.context;
    const effects = this.effects(state);
    // "At the beginning of the next end step…": public, waiting to trigger.
    const delayed = (state.delayed_triggers ?? []).map((t: any) => {
      const src = this.obj(state, t.source_id);
      const name = src && this.identified(src) && !src.face_down ? String(src.name) : undefined;
      const text = findDescription(t.ability) ?? undefined;
      return {
        source: t.source_id, ...(name ? { card: name } : {}), controller: this.who(t.controller),
        when: words(typeof t.condition === 'string' ? t.condition : t.condition?.type ?? Object.keys(t.condition ?? {})[0] ?? ''),
        ...(text ? { text: name ? text.replace(/~/g, name) : text } : {}),
      };
    });
    const emblems = (state.command_zone ?? []).map((id: number) => this.obj(state, id)).filter((x: any) => x?.is_emblem).map((x: any) => ({
      id: x.id, controller: this.who(x.controller),
      text: [...(x.abilities ?? []), ...(x.static_definitions ?? []), ...(x.trigger_definitions ?? [])].map((a: any) => a?.description).filter(Boolean).join(' '),
    }));
    const out: Record<string, unknown> = {
      ...(c?.match ? { match: { ...c.match, ...(c.onPlay ? { on_the_play: c.onPlay } : {}), ...(c.mulligans ? { mulligans: c.mulligans } : {}) } } : c?.onPlay ? { on_the_play: c.onPlay } : {}),
      turn: state.turn_number,
      step: stepName(state.phase),
      active: this.who(state.active_player),
      priority: state.priority_player == null ? undefined : this.who(state.priority_player),
      next_turn: extra ? this.who(extra.player) : this.who(state.active_player === this.me ? this.opp : this.me),
      ...(state.day_night ? { day_night: words(typeof state.day_night === 'string' ? state.day_night : state.day_night.type ?? '') } : {}),
      you,
      opponent,
      hand: groupIdentical((me.hand ?? []).map((id: number) => this.object(state, id, register, ctx))),
      battlefield: { opponent: side(this.opp), you: side(this.me) },
      stack,
      ...(combat ? { combat } : {}),
      graveyard: { you: (me.graveyard ?? []).map((id: number) => zoneCard(id)), opponent: (op.graveyard ?? []).map((id: number) => zoneCard(id)) },
      exile: exileIds.map((id) => {
        const o = this.obj(state, id);
        // Who may cast it, how and until when is in `permissions` (from the engine).
        return zoneCard(id, { owner: this.who(o?.owner) });
      }),
      ...(effects.length ? { effects } : {}),
      ...(delayed.length ? { delayed_triggers: delayed } : {}),
      ...(emblems.length ? { emblems } : {}),
    };

    // Match memory: the opponent's cards from earlier games, by name and count, at every decision. Their printed data
    // (each one this decision's table doesn't already hold; basic lands need none) comes with the decklist: at the
    // start of each game and in get_view. On every decision it would add about a third to each one (1 k tokens).
    if (c?.match && c.opponentSeen && Object.keys(c.opponentSeen).length) {
      const seen = Object.fromEntries(Object.entries(c.opponentSeen).sort((a, b) => a[0].localeCompare(b[0])));
      (out.match as Record<string, unknown>).opponent_cards_seen = { note: 'cards your opponent showed in earlier games of this match; most copies seen in one game', cards: seen };
      if (full && mode !== 'inline') {
        for (const name of Object.keys(seen)) {
          if (table.has(name) || !this.cards.get(name)) continue;
          const card = this.cards.json(name);
          if (!/^Basic Land/.test(card.type)) table.set(name, card);
        }
      }
    }

    let cards = [...table.values()];
    if (mode === 'new' && opts.sent) {
      cards = cards.filter((c) => !opts.sent!.has(c.name));
      for (const c of cards) opts.sent.add(c.name);
    }
    return { summary: this.summary(state, you, opponent, stack), json: compactJson(out), cards: cards.map((c) => JSON.stringify(c)).join('\n'), state: out, cardList: cards };
  }

  /**
   * What a player knows about their own library without looking: their decklist minus every card of theirs they can
   * see elsewhere (hand, battlefield, graveyard, exile, stack). Never the order. Also their sideboard.
   */
  private libraryKnowledge(state: any, ctx: V4Context | undefined, full: boolean): Record<string, unknown> | undefined {
    if (!ctx?.deck) return undefined;
    const left = new Map<string, number>();
    for (const n of ctx.deck.main) left.set(n, (left.get(n) ?? 0) + 1);
    const take = (name: string) => {
      const keys = [name, name.split(' // ')[0]!, ...(this.cards.get(name)?.faces ?? [])];
      const k = keys.find((x) => (left.get(x) ?? 0) > 0);
      if (k) left.set(k, left.get(k)! - 1);
    };
    const mine = new Set<number>(state.players?.[this.me]?.library ?? []);
    for (const o of Object.values(state.objects ?? {}) as any[]) {
      if (!o || o.owner !== this.me || mine.has(o.id) || o.is_token || o.is_copy || o.is_emblem || !this.identified(o)) continue;
      if (!['Hand', 'Battlefield', 'Graveyard', 'Exile', 'Stack'].includes(o.zone)) continue;
      take(String(o.name));
    }
    const remaining = Object.fromEntries([...left.entries()].filter(([, n]) => n > 0).sort((a, b) => a[0].localeCompare(b[0])));
    return {
      library_contents: { note: 'your decklist minus your cards seen elsewhere; order unknown', cards: remaining },
      ...(full ? { decklist: Object.fromEntries([...ctx.deck.main.reduce((m, n) => m.set(n, (m.get(n) ?? 0) + 1), new Map<string, number>())].sort((a, b) => a[0].localeCompare(b[0]))) } : {}),
      ...(full && ctx.deck.sideboard.length ? { sideboard: ctx.deck.sideboard } : {}),
    };
  }

  /** Temporary and continuous effects the engine is applying ("until end of turn" pumps, can't-block…), with their source. */
  private effects(state: any): Array<Record<string, unknown>> {
    return (state.transient_continuous_effects ?? []).map((e: any) => {
      const src = this.obj(state, e.source_id);
      const affects = e.affected_recipient?.object_id ?? (typeof e.affected?.id === 'number' ? e.affected.id : undefined);
      return {
        source: e.source_id, ...(src && this.identified(src) && !src.face_down ? { card: String(src.name) } : !src && e.source_name ? { card: String(e.source_name) } : {}), controller: this.who(e.controller),
        ...(affects != null ? { affects } : e.affected ? { affects: describeFilter(e.affected) } : {}),
        changes: (e.modifications ?? []).map(modText),
        ...(e.duration ? { until: durationText(e.duration, (x) => this.who(x)) } : {}),
      };
    });
  }

  private stackItem(state: any, e: any, top: boolean, register: Register, ctx: ZoneCtx): Record<string, unknown> {
    const kindType = String(e.kind?.type ?? 'Ability');
    const d = e.kind?.data ?? {};
    const kind = kindType === 'Spell' ? 'spell' : kindType === 'TriggeredAbility' ? 'triggered ability' : kindType === 'ActivatedAbility' ? 'activated ability' : kindType.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    const src = this.obj(state, e.source_id);
    const out: Record<string, unknown> = { id: e.id ?? e.source_id };
    if (top) out.top = true;
    out.kind = kind;
    out.controller = this.who(e.controller);
    const known = this.identified(src) && !src?.face_down;
    const name = known ? String(src.name) : src?.face_down ? 'face-down spell' : String(d.source_name || 'hidden card');
    if (kindType === 'Spell') {
      out.card = known ? register(src) : name;
      if (d.casting_variant && d.casting_variant !== 'Normal') out.cast_as = String(typeof d.casting_variant === 'string' ? d.casting_variant : d.casting_variant.type ?? JSON.stringify(d.casting_variant)).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    } else {
      out.source = e.source_id;
      // The source's printed text is in the table; the ability's own text is below.
      if (known) register(src);
      out.card = name;
      const desc = d.description ?? d.ability?.description;
      if (desc) out.text = String(desc).replace(/~/g, name);
    }
    // A spell or ability still being cast/activated (costs not paid yet) keeps its chosen targets on pending_cast.
    const pending = state.pending_cast && (state.pending_cast.object_id === e.source_id || state.pending_cast.object_id === e.id) ? state.pending_cast : undefined;
    if (pending) out.being_cast = true;
    const ability = d.ability?.targets?.length || !pending ? d.ability : pending.ability;
    const modes: string[] = ability?.selected_mode_labels ?? [];
    if (modes.length) out.modes = modes;
    const targets = this.targets(state, ability);
    if (targets.length) out.targets = targets;
    if (d.x_value != null) out.x = d.x_value;
    if (known && kindType === 'Spell') {
      if (src.is_copy) out.copy = true;
      if (src.prepared_copy_source != null) out.copy_of_prepared_spell_on = src.prepared_copy_source;
      if (src.cost_x_paid != null) out.x = src.cost_x_paid;
      if (Array.isArray(src.kickers_paid) && src.kickers_paid.length) out.kicked = true;
    }
    const opts = ctx.optionIds.get(e.id) ?? ctx.optionIds.get(e.source_id);
    if (opts?.length) out.options = opts;
    return out;
  }

  /** Chosen targets of a resolved ability and its sub-abilities (phase-rs TargetRef: {Object: id} | {Player: n}). */
  private targets(state: any, ability: any): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    for (let a = ability, depth = 0; a && depth < 8; a = a.sub_ability, depth++) {
      for (const t of a.targets ?? []) {
        const key = JSON.stringify(t);
        if (seen.has(key)) continue;
        seen.add(key);
        if (t?.Player != null) out.push({ player: this.who(t.Player) });
        else if (t?.Object != null) {
          const o = this.obj(state, t.Object);
          const card = o && this.identified(o) && !o.face_down ? String(o.name) : o?.face_down ? 'face-down card' : 'hidden card';
          out.push({ id: t.Object, card, ...(o ? { controller: this.who(o.controller) } : {}) });
        }
      }
    }
    return out;
  }

  private combat(state: any): Record<string, unknown> | undefined {
    const atk: any[] = state.combat?.attackers ?? [];
    if (!atk.length) return undefined;
    const blockersOf = state.combat?.blocker_assignments ?? {};
    return {
      attackers: atk.map((a) => {
        const t = a.attack_target;
        const target = t?.type === 'Player' ? this.who(t.data) : t?.data != null ? { id: t.data } : undefined;
        const blockers: number[] = blockersOf[String(a.object_id)] ?? [];
        return {
          id: a.object_id,
          controller: this.who(this.obj(state, a.object_id)?.controller),
          attacking: target,
          ...(blockers.length ? { blocked_by: blockers } : a.blocked ? { blocked: true } : {}),
        };
      }),
    };
  }

  private summary(state: any, you: any, opponent: any, stack: Array<Record<string, unknown>>): string {
    const mana = (p: any) => {
      const m = p.untapped_mana ?? { total: 0 };
      const parts = Object.entries(m).filter(([k]) => k !== 'total').map(([k, ids]) => `${(ids as unknown[]).length} ${k}`);
      return m.total ? `${m.total} untapped mana source${m.total === 1 ? '' : 's'} (${parts.join(', ')})` : 'no untapped mana';
    };
    const bits = [
      `Turn ${state.turn_number}, ${state.active_player === this.me ? 'YOUR' : "OPPONENT's"} turn, ${stepName(state.phase)}`,
      `You: ${you.life} life, ${you.hand} in hand, ${mana(you)}, land played this turn: ${you.lands_played_this_turn ? 'yes' : 'no'}${you.poison ? `, poison ${you.poison}` : ''}`,
      `Opponent: ${opponent.life} life, ${opponent.hand} in hand, ${mana(opponent)}${opponent.poison ? `, poison ${opponent.poison}` : ''}`,
    ];
    if (stack.length) {
      const top = stack[0]!;
      const card = typeof top.card === 'string' ? top.card : (top.card as CardJson | undefined)?.name ?? 'object';
      bits.push(`Stack: ${stack.length} (top: ${top.controller === 'you' ? 'your' : "opponent's"} ${card}${top.kind === 'spell' ? '' : ` ${top.kind}`})`);
    }
    if (state.combat?.attackers?.length) bits.push(`Combat: ${state.combat.attackers.length} attacker(s)`);
    return bits.join(' | ');
  }
}
