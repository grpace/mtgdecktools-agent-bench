/**
 * Highlights (SITE-DATA 2.8): moments worth showing, each an agent's decision or pick with its situation and the choice
 * it made. Hand-curated entries (highlights/curated.json) come first, with the curator's `why`; model pages fill up with
 * automatic moments from recent finished events. Automatic moments come from finished events only. A curated entry may
 * point into an event that never finished (stalled), but only at a finished game the export already releases, so nothing
 * withheld from spectators can leak.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASICS, loadRatings, type Decision, type EventData, type Game, type Ratings } from './data.js';
import { lastTurn, sortedDecisions } from './replay-data.js';
import type { Identities } from './scoring.js';
import type { Highlight, SetRef } from './schema.js';

export interface CuratedEntry {
  id: string;
  label: string;
  event_id: string;
  seat: string;
  decision_id?: string;
  game?: number;
  pick?: string;
  why: string;
  featured: boolean;
  added: string;
}

/** highlights/curated.json, or an empty list when absent or unreadable. */
export function readCurated(path: string): CuratedEntry[] {
  if (!existsSync(path)) return [];
  try {
    const o = JSON.parse(readFileSync(path, 'utf8')) as { highlights?: CuratedEntry[] };
    return Array.isArray(o.highlights) ? o.highlights : [];
  } catch {
    return [];
  }
}

const setRef = (ev: EventData): SetRef => ({ code: ev.set.code.toUpperCase(), name: ev.set.name, ...(ev.set.releaseDate ? { release_date: ev.set.releaseDate } : {}) });

function base(ev: EventData, seat: string, ids: Identities): Pick<Highlight, 'event_id' | 'set' | 'seat' | 'identity' | 'model_id' | 'model_display' | 'identity_label'> {
  const s = ev.seats.find((x) => x.name === seat);
  const id = s?.llm ? ids.of(ev, seat) : null;
  const info = id ? ids.info.get(id.key) : undefined;
  return {
    event_id: ev.id,
    set: setRef(ev),
    seat,
    identity: id?.key ?? null,
    model_id: id?.model ?? null,
    model_display: info?.model_display ?? null,
    identity_label: info?.label ?? null,
  };
}

/** A game decision as a highlight, or a reason it can't be one. */
export function gameHighlight(ev: EventData, g: Game, decisionId: string, seat: string, ids: Identities, meta: { id: string; source: Highlight['source']; label: string; why: string | null; featured: boolean }): Highlight | string {
  const ds = sortedDecisions(g);
  const seq = ds.findIndex((d) => d.id === decisionId && d.seat === seat);
  if (seq < 0) return `decision ${decisionId} of ${seat} not found`;
  const d = ds[seq]!;
  const a = d.answer;
  if (!a) return `decision ${decisionId} has no answer`;
  if (a.withheld) return `decision ${decisionId} is withheld (event still running)`;
  const last = lastTurn(g);
  return {
    id: meta.id,
    source: meta.source,
    label: meta.label,
    why: meta.why,
    featured: meta.featured,
    ...base(ev, seat, ids),
    kind: 'game',
    choice: a.choice,
    game: {
      index: g.index,
      label: g.label,
      decision_id: d.id,
      seq,
      turn: d.turn,
      life: d.life ? { you: d.life.you ?? null, opponent: d.life.opponent ?? null } : null,
      won: g.over && g.winner ? g.winner === seat : null,
      turns: g.turns ?? null,
      final_turn: g.over && d.turn === last,
    },
  };
}

/** A draft pick as a highlight, or a reason it can't be one. */
/** The 17Lands file of a set from the repo's sets/ folder, when a caller passes no ratings lookup (cached per set). */
const REPO_SETS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'sets');
const repoRatings = new Map<string, Ratings | null>();
export function repoRatingsFor(code: string): Ratings | null {
  const k = code.toUpperCase();
  if (!repoRatings.has(k)) {
    let r: Ratings | null = null;
    try {
      r = loadRatings(REPO_SETS, k);
    } catch {
      r = null;
    }
    repoRatings.set(k, r);
  }
  return repoRatings.get(k)!;
}

/** 17Lands numbers next to a pick (SITE-DATA 2.8, Highlights): the pick's ATA and GIH WR, and the pack's best card by GIH WR. */
export function humanReference(pack: string[], pick: string, ratings: Ratings | null): NonNullable<Highlight['pick']>['human'] {
  if (!ratings) return null;
  const r = ratings.cards.get(pick);
  let top: { name: string; gih_wr: number } | null = null;
  for (const name of new Set(pack)) {
    if (BASICS.has(name)) continue;
    const g = ratings.cards.get(name)?.gih_wr;
    if (typeof g === 'number' && (!top || g > top.gih_wr)) top = { name, gih_wr: g };
  }
  const ata = typeof r?.ata === 'number' ? r.ata : null;
  const gih = typeof r?.gih_wr === 'number' ? r.gih_wr : null;
  if (ata == null && gih == null && !top) return null;
  return { source: '17Lands', ata, gih_wr: gih, pack_best: top && top.name !== pick ? top : null };
}

export function pickHighlight(
  ev: EventData, seat: string, label: string, ids: Identities, meta: { id: string; source: Highlight['source']; label: string; why: string | null; featured: boolean },
  ratingsFor: (set: string) => Ratings | null = repoRatingsFor,
): Highlight | string {
  const m = /^P(\d)p(\d{1,2})$/.exec(label);
  if (!m) return `bad pick label ${label}`;
  const p = ev.picks.find((x) => x.seat === seat && x.packNumber === Number(m[1]) && x.pickNumber === Number(m[2]));
  if (!p) return `pick ${label} of ${seat} not found`;
  return {
    id: meta.id,
    source: meta.source,
    label: meta.label,
    why: meta.why,
    featured: meta.featured,
    ...base(ev, seat, ids),
    kind: 'pick',
    choice: p.pick,
    pick: { label, pack_number: p.packNumber, pick_number: p.pickNumber, pick: p.pick, human: humanReference(p.contents, p.pick, ratingsFor(ev.set.code)) },
  };
}

/** Resolve curated entries against the exported events. */
export function resolveCurated(
  entries: CuratedEntry[], events: EventData[], ids: Identities, ratingsFor: (set: string) => Ratings | null = repoRatingsFor,
): { highlights: Highlight[]; unresolved: Array<{ id: string; reason: string }> } {
  const highlights: Highlight[] = [];
  const unresolved: Array<{ id: string; reason: string }> = [];
  for (const c of entries) {
    const ev = events.find((e) => e.id === c.event_id);
    const meta = { id: c.id, source: 'curated' as const, label: c.label, why: c.why, featured: c.featured };
    let r: Highlight | string;
    if (!ev) r = 'event not in this export';
    else if (c.pick) r = pickHighlight(ev, c.seat, c.pick, ids, meta, ratingsFor);
    else if (c.decision_id) {
      const games = ev.games.filter((g) => (c.game == null || g.index === c.game) && g.decisions.some((d) => d.id === c.decision_id && d.seat === c.seat));
      r = games.length > 1 ? `decision ${c.decision_id} is in ${games.length} games: add "game"`
        : !games.length ? `decision ${c.decision_id} of ${c.seat} not found`
        : ev.status !== 'complete' && !games[0]!.over ? 'game still running'
        : gameHighlight(ev, games[0]!, c.decision_id, c.seat, ids, meta);
    } else r = 'neither decision_id nor pick';
    if (typeof r === 'string') unresolved.push({ id: c.id, reason: r });
    else highlights.push(r);
  }
  return { highlights, unresolved };
}

/** Decision kinds that carry out a plan rather than make it: never the "Lethal Setup". */
const NOT_DECISIVE_KINDS = /^(ManaPayment|TargetSelection|TriggerTargetSelection|MulliganDecision|OrderTriggers|AssignCombatDamage|ManaColorChoice|ChooseManaColor)$/;
const NOT_DECISIVE_CHOICES = /^(Pass priority|No attack|No blocks|Let the auto-tapper|Tap |Target |Keep this hand|Mulligan|Select:)/;

/**
 * A won game's decisive play on its final turn: the attack, else a spell or ability cast that turn,
 * else another real choice. Passes, targets, payments and mulligans only carry out a plan made earlier (the audit's
 * "No blockers; pass to combat damage" after "Attack with everything for exactly 8"), so they never count. Among
 * equals, the earliest: the decision that set up lethal, not the follow-through. Undefined when there is none.
 */
export function decisivePlay<D extends Pick<Decision, 'kind' | 'turn'> & { answer?: { choice?: string } }>(mine: D[], finalTurn: number): D | undefined {
  const rank = (d: D): number => {
    const choice = d.answer?.choice ?? '';
    if (NOT_DECISIVE_KINDS.test(d.kind) || NOT_DECISIVE_CHOICES.test(choice)) return 0;
    if (d.kind === 'DeclareAttackers' && /^Attack with/.test(choice)) return 3;
    if (/^(Cast|Activate|Crew)\b/.test(choice)) return 2;
    return 1;
  };
  let best: D | undefined;
  for (const d of mine) {
    if (d.turn !== finalTurn) continue;
    const r = rank(d);
    if (r > 0 && (!best || r > rank(best))) best = d;
  }
  return best;
}

/** Choices that are never a highlight on their own: land drops, passes, no attack or block, payments, targets. */
const NOT_A_MOMENT_CHOICES = /^(Play land|Pass priority|No attack|No blocks|Let the auto-tapper|Tap |Target |Keep this hand|Mulligan|Select:)/;

/** A real choice: more than one option offered (a single-option or forced decision is never a moment), and not a land, pass or payment. */
export function isRealChoice(d: Pick<Decision, 'kind'> & { options?: string[]; answer?: { choice?: string } }): boolean {
  if (d.options && d.options.length < 2) return false;
  if (NOT_DECISIVE_KINDS.test(d.kind)) return false;
  return !NOT_A_MOMENT_CHOICES.test(d.answer?.choice ?? '');
}

/** The JSON part of a structured observation, or null for the older text view. */
function observation(text: string): { state?: { battlefield?: Record<string, unknown> } } | null {
  const a = text.indexOf('\n{');
  const b = text.lastIndexOf('\n}');
  if (a < 0 || b < a) return null;
  try {
    return JSON.parse(text.slice(a + 1, b + 2));
  } catch {
    return null;
  }
}

/** One permanent line of a battlefield section in the view the agent saw ("Cadet [#128] 3/2 [summoning sick]"). */
interface BoardLine { id: string | null; power: number | null; tapped: boolean; creature: boolean }
function battlefield(text: string, side: 'Opponent' | 'Your'): BoardLine[] {
  // Structured observations (2026-10-22 on): a JSON object after the header lines, state.battlefield.{you,opponent}.
  const obs = observation(text);
  if (obs) {
    const list = obs.state?.battlefield?.[side === 'Your' ? 'you' : 'opponent'];
    if (!Array.isArray(list)) return [];
    const out: BoardLine[] = [];
    for (const o of list as Array<{ id?: number; ids?: number[]; pt?: string; tapped?: boolean }>) {
      const pt = typeof o.pt === 'string' ? /^(-?\d+)\/(-?\d+)$/.exec(o.pt) : null;
      for (const id of o.ids ?? [o.id]) out.push({ id: id != null ? String(id) : null, power: pt ? Number(pt[1]) : null, tapped: o.tapped === true, creature: !!pt });
    }
    return out;
  }
  const start = text.indexOf(`${side} battlefield:`);
  if (start < 0) return [];
  const out: BoardLine[] = [];
  for (const line of text.slice(start).split('\n').slice(1)) {
    if (!/^\s{2}\S/.test(line)) break;
    if (/^\s*lands\b/.test(line)) continue;
    const pt = /\]\s+(-?\d+)\/(-?\d+)/.exec(line);
    out.push({ id: /\[#(\d+)\]/.exec(line)?.[1] ?? null, power: pt ? Number(pt[1]) : null, tapped: /\[tapped\]/i.test(line), creature: !!pt });
  }
  return out;
}

/**
 * A trivial alpha strike (no highlight): an attack the opponent can't meaningfully answer in combat, judged from the view
 * the agent saw when it declared it. The opponent has no untapped creature to block with, or the attackers' power is at
 * least twice the opponent's life. Unknown board (no view text): not trivial.
 */
export function trivialAttack(d: Pick<Decision, 'kind' | 'text' | 'life'> & { answer?: { choice?: string } }): boolean {
  const choice = d.answer?.choice ?? '';
  if (d.kind !== 'DeclareAttackers' || !/^Attack with/.test(choice) || !d.text) return false;
  if (!d.text.includes('Opponent battlefield:') && !observation(d.text)?.state?.battlefield) return false;
  const opp = battlefield(d.text, 'Opponent');
  if (!opp.some((c) => c.creature && !c.tapped)) return true;
  const mine = new Map(battlefield(d.text, 'Your').filter((c) => c.id).map((c) => [c.id!, c.power ?? 0]));
  const power = [...choice.matchAll(/\[#(\d+)\]/g)].reduce((n, m) => n + (mine.get(m[1]!) ?? 0), 0);
  const life = d.life?.opponent;
  return typeof life === 'number' && life > 0 && power >= 2 * life;
}

/**
 * The "Lethal Setup" of a won game's final turn: its decisive play (decisivePlay among real choices; forced and
 * single-option decisions never count) when that is an attack the opponent could still answer in combat. A trivial
 * alpha strike (trivialAttack) is no moment, and neither is a spell or ability on its own: the choice alone can't show
 * that it set up the kill (a creature cast on the last turn may just be a blocker).
 */
export function lethalSetup<D extends Pick<Decision, 'kind' | 'turn' | 'text' | 'life'> & { options?: string[]; answer?: { choice?: string } }>(mine: D[], finalTurn: number): D | undefined {
  const best = decisivePlay(mine.filter((d) => d.turn === finalTurn && isRealChoice(d)), finalTurn);
  if (!best || best.kind !== 'DeclareAttackers' || !/^Attack with/.test(best.answer?.choice ?? '')) return undefined;
  return trivialAttack(best) ? undefined : best;
}

/**
 * The "Last Stand": a real action (a spell, ability, attack or block; never a land, pass, payment or forced choice) at 3
 * life or less, in a game the seat went on to win. A desperate play followed by a loss on the next turn is not a moment
 * worth showing (the 2026-10-22 review: a land drop at 3 life, and a removal spell while dead to three other attackers).
 */
export function lastStand<D extends Pick<Decision, 'kind' | 'turn' | 'life'> & { options?: string[]; answer?: { choice?: string } }>(mine: D[], lastTurnOfGame: number, won: boolean): D | undefined {
  if (!won) return undefined;
  return mine.find((d) => d.life?.you != null && d.life.you <= 3 && d.turn < lastTurnOfGame && isRealChoice(d)
    && /^(Cast|Activate|Crew|Attack with|Block)/.test(d.answer?.choice ?? ''));
}

/**
 * Automatic highlights for a set of seats (a model's), newest event first: a won game's final-turn attack
 * ("Lethal Setup", lethalSetup: never a trivial alpha strike), a first pick with its 17Lands numbers ("First Pick"), and a
 * real action at 3 life or less in a game the seat came back to win ("Last Stand", lastStand). One of each kind first, then
 * the rest of those, until `n`. Fewer (or none) is fine: no highlight beats a filler one.
 */
export function autoHighlights(seats: Array<{ ev: EventData; seat: string }>, ids: Identities, n: number, ratingsFor: (set: string) => Ratings | null = repoRatingsFor): Highlight[] {
  const done = seats.filter((s) => s.ev.status === 'complete').sort((a, b) => b.ev.startT - a.ev.startT || a.seat.localeCompare(b.seat));
  const lethal: Highlight[] = [];
  const first: Highlight[] = [];
  const stand: Highlight[] = [];
  for (const s of done) {
    const p1 = s.ev.picks.find((p) => p.seat === s.seat && p.packNumber === 1 && p.pickNumber === 1 && p.by === 'agent');
    if (p1) {
      const h = pickHighlight(s.ev, s.seat, 'P1p1', ids, { id: `auto-${s.ev.id}-${s.seat}-p1p1`, source: 'auto', label: 'First Pick', why: null, featured: false }, ratingsFor);
      if (typeof h !== 'string') first.push(h);
    }
    for (const g of s.ev.games) {
      if (!g.over || !g.seats.includes(s.seat) || g.forfeitedBy) continue;
      const mine = sortedDecisions(g).filter((d) => d.seat === s.seat && d.answer?.accepted);
      const last = lastTurn(g);
      const won = g.winner === s.seat;
      if (won) {
        const d = lethalSetup(mine, last);
        if (d) {
          const h = gameHighlight(s.ev, g, d.id, s.seat, ids, { id: `auto-${s.ev.id}-${s.seat}-${d.id}`, source: 'auto', label: 'Lethal Setup', why: null, featured: false });
          if (typeof h !== 'string') lethal.push(h);
        }
      }
      const low = lastStand(mine, last, won);
      if (low) {
        const h = gameHighlight(s.ev, g, low.id, s.seat, ids, { id: `auto-${s.ev.id}-${s.seat}-${low.id}`, source: 'auto', label: 'Last Stand', why: null, featured: false });
        if (typeof h !== 'string') stand.push(h);
      }
    }
  }
  const out: Highlight[] = [];
  const seen = new Set<string>();
  const take = (h: Highlight | undefined) => {
    if (h && out.length < n && !seen.has(h.id)) {
      out.push(h);
      seen.add(h.id);
    }
  };
  take(lethal[0]);
  take(first[0]);
  take(stand[0]);
  const rest = [...lethal.slice(1), ...first.slice(1), ...stand.slice(1)];
  for (const h of rest) take(h);
  return out;
}
