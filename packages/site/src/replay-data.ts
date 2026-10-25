/** Game replay derivations shared by the HTML replay page and the JSON export. */
import type { Decision, EventData, Game } from './data.js';
import { median } from './metrics.js';

export const KIND_LABEL: Record<string, string> = {
  MulliganDecision: 'Mulligan',
  Priority: 'Priority',
  DeclareAttackers: 'Attack',
  DeclareBlockers: 'Block',
  TargetSelection: 'Target',
  ModeChoice: 'Mode',
  ManaPayment: 'Pay mana',
};

export const kindLabel = (kind: string): string => KIND_LABEL[kind] ?? kind;

/** Life totals from the decision header ("You: life 20 | …"), for logs without the structured `life` field. */
export function lifeFromText(text: string): { you?: number; opp?: number } {
  const you = /^You:\s+life (-?\d+)/m.exec(text);
  const opp = /^Opponent:\s+life (-?\d+)/m.exec(text);
  return { you: you ? Number(you[1]) : undefined, opp: opp ? Number(opp[1]) : undefined };
}

export function lifeOf(d: Decision): { you?: number; opp?: number } {
  if (d.life && (d.life.you != null || d.life.opponent != null)) return { you: d.life.you, opp: d.life.opponent };
  return lifeFromText(d.text);
}

/** The turn number shown in the view header ("Turn 7 — …"), falling back to the logged turn. */
export function turnOf(d: Decision): number {
  const m = /^Turn (\d+) —/m.exec(d.text);
  return m ? Number(m[1]) : d.turn;
}

/** Whose turn it is: the structured `active` field, else the decision header ("Turn 7 — YOUR turn"). */
export function activeFrom(d: Decision, seats: string[]): string | undefined {
  const other = seats.find((s) => s !== d.seat);
  if (d.active) return d.active === 'you' ? d.seat : other;
  const m = /^Turn (\d+) — (YOUR|OPPONENT's) turn/m.exec(d.text);
  if (!m) return undefined;
  return m[2] === 'YOUR' ? d.seat : other;
}

/** Split the agent's view into the "since your last decision" log and the board. */
export function splitView(text: string): { since: string; board: string } {
  const body = text.replace(/^\[[^\]]*\]\n/, '');
  const m = /^Since your last decision:\n([\s\S]*?)\n\n/.exec(body);
  if (!m) return { since: '', board: body };
  return { since: m[1]!, board: body.slice(m[0].length) };
}

/** The question line and the number of options offered. */
export function question(d: Decision): { prompt: string; options: number } {
  const m = /^DECISION \S+ — (.*)$/m.exec(d.text);
  const options = d.options?.length ?? (d.text.match(/^ {2}\[\d+\] /gm) ?? []).length;
  return { prompt: m?.[1] ?? '', options };
}

/** Sides follow the match pairing (not who hosted the game), so a seat keeps its side across games. */
export function gameSides(g: Game): [string, string] {
  const pair = g.matchKey.split(' vs ');
  return pair.length === 2 && g.seats.includes(pair[0]!) && g.seats.includes(pair[1]!) ? [pair[0]!, pair[1]!] : [g.seats[0] ?? 'A', g.seats[1] ?? 'B'];
}

export const sortedDecisions = (g: Game): Decision[] => [...g.decisions].sort((x, y) => x.t - y.t);

export interface LifePoint { turn: number; a?: number; b?: number }

/** Life totals per turn for sides [A, B], as seen in the agents' decision views (last value seen in each turn). */
export function lifeSeries(g: Game, sides: [string, string]): LifePoint[] {
  const [A] = sides;
  const byTurn = new Map<number, LifePoint>();
  for (const d of sortedDecisions(g)) {
    const l = lifeOf(d);
    if (l.you == null && l.opp == null) continue;
    const turn = turnOf(d);
    const p = byTurn.get(turn) ?? { turn };
    const mine = d.seat === A ? 'a' : 'b';
    const theirs = mine === 'a' ? 'b' : 'a';
    if (l.you != null) p[mine] = l.you;
    if (l.opp != null) p[theirs] = l.opp;
    byTurn.set(turn, p);
  }
  // The final life totals from game_over close the series.
  if (g.over && g.finalLife && g.turns != null) {
    const p = byTurn.get(g.turns) ?? { turn: g.turns };
    if (g.finalLife[sides[0]] != null) p.a = g.finalLife[sides[0]];
    if (g.finalLife[sides[1]] != null) p.b = g.finalLife[sides[1]];
    byTurn.set(g.turns, p);
  }
  return [...byTurn.values()].sort((a, b) => a.turn - b.turn);
}

/** Active player per turn (first decision seen in each turn). */
export function activeByTurn(g: Game): Map<number, string> {
  const active = new Map<number, string>();
  for (const d of sortedDecisions(g)) {
    const who = activeFrom(d, g.seats);
    if (who && !active.has(d.turn)) active.set(d.turn, who);
  }
  return active;
}

export type DecisionStatus = 'answered' | 'withdrawn' | 'pending';

/**
 * answered: the agent answered (even if the Director also logged decision_withdrawn for it: that log races the answer).
 * withdrawn: replaced before an answer (a later decision for the same seat exists, or the game is over).
 * pending: the newest open decision of a game in progress.
 */
export function decisionStatus(d: Decision, g: Game): DecisionStatus {
  if (d.answer) return 'answered';
  if (d.withdrawn || g.over || g.decisions.some((x) => x.seat === d.seat && x.t > d.t)) return 'withdrawn';
  return 'pending';
}

export interface SeatGameStats {
  decisions: number;
  medianLatencyMs?: number;
  autoPasses: number;
  forced: number;
  rejected: number;
  notes: number;
  manualPayments?: number;
  autoTapper?: number;
  paymentFailures?: number;
  /** Payments the engine made by itself (newer logs). */
  autoPaid?: number;
  mulligans?: number;
}

export function seatGameStats(g: Game, seat: string): SeatGameStats {
  const answered = g.decisions.filter((d) => d.seat === seat && d.answer);
  const st = g.stats?.[seat];
  return {
    decisions: answered.length,
    medianLatencyMs: median(answered.map((d) => d.answer!.latencyMs).filter((x): x is number => x != null)),
    autoPasses: st?.auto_passes ?? g.autoPasses[seat] ?? 0,
    forced: st?.forced ?? g.forced[seat] ?? 0,
    rejected: st?.rejections ?? answered.filter((d) => !d.answer!.accepted).length,
    notes: answered.filter((d) => d.answer!.note).length,
    manualPayments: st?.manual_payments,
    autoTapper: st?.auto_tapper,
    paymentFailures: st?.payment_failures,
    autoPaid: st?.auto_paid,
    mulligans: g.mulligans?.[seat],
  };
}

/** The highest turn reached so far (for games in progress). */
export const lastTurn = (g: Game): number => g.decisions.reduce((m, d) => (d.turn > m ? d.turn : m), 0);

/** Game wall time: to game_over, or to the last log line of the event while it runs. */
export const gameDuration = (ev: EventData, g: Game): number => (g.endT ?? ev.lastT) - g.startT;

/** Human-readable end reason from game_over.end_reason (a phase-rs event payload), when present. */
export function endReasonText(reason: unknown): string | undefined {
  if (reason == null) return undefined;
  if (typeof reason === 'string') return reason;
  if (typeof reason === 'object') {
    const r = reason as Record<string, unknown>;
    if (typeof r.reason === 'string') return r.reason;
    if (r.reason && typeof r.reason === 'object') {
      const t = (r.reason as Record<string, unknown>).type;
      if (typeof t === 'string') return t;
    }
    if (typeof r.type === 'string') return r.type;
  }
  return undefined;
}
