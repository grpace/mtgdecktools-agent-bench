/**
 * Optional per-event and per-set inputs written by other tools, read leniently (the producers are still
 * settling their formats; docs/METHODOLOGY.md §9 lists the fields we consume):
 *
 *   runs/<id>/source.json             provenance label: verified | community | smoke (+ submitter, exclusion)
 *   runs/<id>/strength.json           deck_strength records: bot-piloted win rate of each seat's deck and of the
 *                                     reference build of the same pool, against a fixed gauntlet
 *   runs/<id>/draft-eval.json         expert pick model scores per pick (analysis/)
 *   sets/<SET>/17lands-archetypes.json  per-card GIH WR within each color pair (17Lands game data)
 *
 * Every reader returns null/empty when the file is missing or unreadable; nothing here is required.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function readJson(path: string): any {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

const num = (...xs: unknown[]): number | undefined => {
  for (const x of xs) if (typeof x === 'number' && Number.isFinite(x)) return x;
  return undefined;
};

// ---------------------------------------------------------------------------
// source.json

export type SourceLabel = 'verified' | 'community' | 'smoke';

export interface SourceInfo {
  label: SourceLabel;
  submitter?: string;
  /** The Hub's opaque id of the uploader, when source.json records it (submitter_id or contributor_id). */
  submitterId?: string;
  submittedAt?: string;
  /** Exclusion from ratings and diagnostics (e.g. a Director bug), with the reason. */
  exclude?: string;
  /** Seats whose games are unrated (a banned contributor's seats at someone else's table), seat → reason. */
  excludeSeats?: Record<string, string>;
  note?: string;
  /** True when no source.json exists and the label was inferred. */
  inferred: boolean;
}

export function readSource(dir: string, llmEvent: boolean): SourceInfo {
  const j = readJson(join(dir, 'source.json'));
  const fallback: SourceLabel = llmEvent ? 'verified' : 'smoke';
  if (!j || typeof j !== 'object') return { label: fallback, inferred: true };
  const label = ['verified', 'community', 'smoke'].includes(j.label) ? (j.label as SourceLabel) : fallback;
  const out: SourceInfo = { label: llmEvent ? label : 'smoke', inferred: false };
  if (typeof j.submitter === 'string') out.submitter = j.submitter;
  const sid = j.submitter_id ?? j.contributor_id;
  if ((typeof sid === 'string' && sid) || (typeof sid === 'number' && Number.isFinite(sid))) out.submitterId = String(sid).slice(0, 80);
  if (typeof j.submitted_at === 'string') out.submittedAt = j.submitted_at;
  if (typeof j.exclude === 'string' && j.exclude) out.exclude = j.exclude;
  else if (j.exclude === true) out.exclude = 'excluded from the ratings';
  if (j.exclude_seats && typeof j.exclude_seats === 'object' && !Array.isArray(j.exclude_seats)) {
    const xs = Object.entries(j.exclude_seats as Record<string, unknown>).filter(([k, v]) => k && typeof v === 'string' && v);
    if (xs.length) out.excludeSeats = Object.fromEntries(xs.map(([k, v]) => [k.slice(0, 80), String(v).slice(0, 300)]));
  }
  if (typeof j.note === 'string') out.note = j.note;
  return out;
}

// ---------------------------------------------------------------------------
// strength.json (deck_strength records)

export interface StrengthValue { winRate: number; games?: number; ci?: [number, number] }
export interface SeatStrength { agent?: StrengthValue; reference?: StrengthValue }
export interface StrengthInfo { seats: Map<string, SeatStrength>; meta?: Record<string, unknown> }

function strengthValue(o: any): StrengthValue | undefined {
  if (o == null) return undefined;
  if (typeof o === 'number') return { winRate: o };
  const wr = num(o.win_rate, o.winRate, o.strength, o.wr, o.score);
  if (wr == null) return undefined;
  const v: StrengthValue = { winRate: wr };
  const games = num(o.games, o.n, o.played);
  if (games != null) v.games = games;
  const ci = o.ci95 ?? o.ci ?? o.interval;
  if (Array.isArray(ci) && ci.length === 2 && ci.every((x: unknown) => typeof x === 'number')) v.ci = [ci[0] as number, ci[1] as number];
  return v;
}

const REFERENCE_KINDS = new Set(['reference', 'ref', 'auto', 'reference_build', 'reference-build', 'baseline']);

/**
 * `deck_strength` records as logged in events.jsonl by packages/director/src/strength.ts
 * ({ seat, deck: "submitted" | "reference", games, wins, losses, win_rate, ci95, build_delta, method, … }).
 * Later records replace earlier ones for the same (seat, deck).
 */
export function strengthFromRecords(records: any[]): StrengthInfo | null {
  return parseStrength({ records });
}

/**
 * runs/<id>/strength.json: accepts `{ results|records|decks|deck_strength: [{ seat, deck|builder|kind, win_rate, games, ci95 }] }`
 * or `{ decks|seats: { [seat]: { agent, reference } | {win_rate} } }`.
 */
export function readStrength(dir: string): StrengthInfo | null {
  return parseStrength(readJson(join(dir, 'strength.json')));
}

function parseStrength(j: any): StrengthInfo | null {
  if (!j || typeof j !== 'object') return null;
  const seats = new Map<string, SeatStrength>();
  const put = (seat: string, kind: 'agent' | 'reference', v: StrengthValue | undefined) => {
    if (!v) return;
    const s = seats.get(seat) ?? {};
    s[kind] = v;
    seats.set(seat, s);
  };
  const list = Array.isArray(j) ? j : (j.results ?? j.records ?? j.deck_strength ?? j.decks ?? j.seats);
  if (Array.isArray(list)) {
    for (const r of list) {
      if (!r || typeof r.seat !== 'string') continue;
      const kind = String(r.builder ?? r.deck ?? r.kind ?? r.build ?? 'agent').toLowerCase();
      if (r.agent || r.reference) {
        put(r.seat, 'agent', strengthValue(r.agent));
        put(r.seat, 'reference', strengthValue(r.reference));
      } else {
        put(r.seat, REFERENCE_KINDS.has(kind) ? 'reference' : 'agent', strengthValue(r));
      }
    }
  } else if (list && typeof list === 'object') {
    for (const [seat, r] of Object.entries<any>(list)) {
      if (r && (r.agent || r.reference)) {
        put(seat, 'agent', strengthValue(r.agent));
        put(seat, 'reference', strengthValue(r.reference ?? r.reference_build));
      } else {
        put(seat, 'agent', strengthValue(r));
      }
    }
  }
  if (!seats.size) return null;
  const meta: Record<string, unknown> = {};
  const last = Array.isArray(list) ? list[list.length - 1] : undefined;
  for (const k of ['gauntlet', 'pilots', 'difficulty', 'games_per_deck', 'engine', 'generated_at', 'method', 'version']) {
    const v = j[k] ?? last?.[k];
    if (v != null) meta[k] = v;
  }
  return { seats, meta };
}

// ---------------------------------------------------------------------------
// draft-eval.json (expert pick model)

export interface ExpertPick {
  pack: number;
  pick: number;
  card?: string;
  /** Model probability of the card the seat took. */
  p?: number;
  /** Rank of the taken card under the model (1 = the model's top choice). */
  rank?: number;
  /** Context-aware expected-value regret, percentage points of win rate. */
  evRegretPp?: number;
  inLane?: boolean;
  top?: string;
}

export interface DraftEvalInfo {
  seats: Map<string, ExpertPick[]>;
  model?: Record<string, unknown>;
  /** Held-out human reference scores reported by the producer (e.g. strong human drafters vs the model). */
  reference?: Record<string, unknown>;
}

function expertPick(r: any): ExpertPick | undefined {
  const pack = num(r.pack_number, r.pack);
  const pick = num(r.pick_number, r.pick_no, r.pick_in_pack, typeof r.pick === 'number' ? r.pick : undefined);
  if (pack == null || pick == null) return undefined;
  const out: ExpertPick = { pack, pick };
  const card = typeof r.card === 'string' ? r.card : typeof r.pick === 'string' ? r.pick : typeof r.taken === 'string' ? r.taken : undefined;
  if (card) out.card = card;
  const p = num(r.p_pick, r.p, r.prob, r.probability, r.model_p);
  if (p != null) out.p = p;
  const rank = num(r.rank, r.model_rank);
  if (rank != null) out.rank = rank;
  const ev = num(r.ev_regret_pp, r.ev_regret, r.regret_pp);
  if (ev != null) out.evRegretPp = ev;
  if (typeof r.in_lane === 'boolean') out.inLane = r.in_lane;
  const top = typeof r.top === 'string' ? r.top : typeof r.top_choice === 'string' ? r.top_choice : typeof r.model_top === 'string' ? r.model_top : undefined;
  if (top) out.top = top;
  return out;
}

/** Accepts `{ seats: { [seat]: { picks: [...] } | [...] } }` or `{ picks: [{ seat, ... }] }`. */
export function readDraftEval(dir: string): DraftEvalInfo | null {
  const j = readJson(join(dir, 'draft-eval.json'));
  if (!j || typeof j !== 'object') return null;
  const seats = new Map<string, ExpertPick[]>();
  const add = (seat: string, r: any) => {
    const p = expertPick(r);
    if (!p) return;
    if (!seats.has(seat)) seats.set(seat, []);
    seats.get(seat)!.push(p);
  };
  if (j.seats && typeof j.seats === 'object') {
    for (const [seat, v] of Object.entries<any>(j.seats)) for (const r of Array.isArray(v) ? v : (v?.picks ?? [])) add(seat, r);
  }
  if (Array.isArray(j.picks)) for (const r of j.picks) if (typeof r?.seat === 'string') add(r.seat, r);
  if (!seats.size) return null;
  // Ranks are 1-based (1 = the model's top choice). A file with any rank 0 is 0-based: shift it.
  const all = [...seats.values()].flat();
  const rankBase = j.rank_base === 0 || all.some((p) => p.rank === 0) ? 0 : 1;
  if (rankBase === 0) for (const p of all) if (p.rank != null) p.rank += 1;
  return { seats, model: typeof j.model === 'object' ? j.model : undefined, reference: typeof j.reference === 'object' ? j.reference : undefined };
}

// ---------------------------------------------------------------------------
// sets/<SET>/17lands-archetypes.json

export interface ArchetypeValue { gih: number; games?: number }
export interface ArchetypeRatings {
  set: string;
  /** Color pair (WUBRG order, e.g. "WU") → card → value. */
  pairs: Map<string, Map<string, ArchetypeValue>>;
  /** Minimum games-in-hand we trust a value with (cards below it are treated as unrated in that pair). */
  minGames: number;
  meta?: Record<string, unknown>;
  /** Card → overall (shrunk) GIH WR, when the file carries it (analysis/ format). */
  overall?: Map<string, number>;
  /** Bucket (pair or mono color) → base win rate of its decks, when the file carries it. */
  base?: Map<string, number>;
  /** The set's average game win rate (17Lands population). */
  baseline?: number;
}

export function normPair(s: string): string {
  const up = s.toUpperCase();
  return 'WUBRG'.split('').filter((c) => up.includes(c)).join('');
}

function archValue(v: any): ArchetypeValue | undefined {
  if (typeof v === 'number') return { gih: v };
  const g = num(v?.gih_wr, v?.gih, v?.win_rate, v?.wr);
  if (g == null) return undefined;
  const games = num(v?.gih_games, v?.games, v?.n);
  return games != null ? { gih: g, games } : { gih: g };
}

/**
 * Accepts the analysis/ format `{ by_archetype_fields: [...], cards: { [name]: { by_archetype: { [pair]: [gih_wr, gih_games, …] } } } }`,
 * or `{ archetypes|pairs: { [pair]: { cards: { [name]: {gih_wr, gih_games} } } } }`, or `{ cards: { [name]: { [pair]: {gih_wr} | number } } }`.
 * Mono-color buckets are kept; 3-color buckets are ignored.
 */
export function readArchetypes(setsDir: string, code: string): ArchetypeRatings | null {
  const j = readJson(join(setsDir, code.toUpperCase(), '17lands-archetypes.json'));
  if (!j || typeof j !== 'object') return null;
  const pairs = new Map<string, Map<string, ArchetypeValue>>();
  const put = (pair: string, card: string, v: ArchetypeValue | undefined) => {
    if (!v) return;
    const p = normPair(pair);
    if (p.length < 1 || p.length > 2) return;
    if (!pairs.has(p)) pairs.set(p, new Map());
    pairs.get(p)!.set(card, v);
  };
  const fields: string[] | undefined = Array.isArray(j.by_archetype_fields) ? j.by_archetype_fields : undefined;
  const byPair = j.archetypes ?? j.pairs;
  const hasCardTables = byPair && typeof byPair === 'object' && Object.values<any>(byPair).some((v) => v && typeof v.cards === 'object');
  if (j.cards && typeof j.cards === 'object' && Object.values<any>(j.cards).some((c) => c && typeof c.by_archetype === 'object')) {
    // analysis/draft_eval/archetypes.py: cards[name].by_archetype[pair] = [gih_wr, gih_games, …] per by_archetype_fields.
    const gi = fields?.indexOf('gih_wr') ?? 0;
    const ni = fields?.indexOf('gih_games') ?? 1;
    for (const [card, c] of Object.entries<any>(j.cards)) {
      for (const [pair, cell] of Object.entries<any>(c?.by_archetype ?? {})) {
        if (Array.isArray(cell)) {
          const g = cell[gi >= 0 ? gi : 0];
          const n = cell[ni >= 0 ? ni : 1];
          if (typeof g === 'number') put(pair, card, typeof n === 'number' ? { gih: g, games: n } : { gih: g });
        } else {
          put(pair, card, archValue(cell));
        }
      }
    }
  } else if (hasCardTables) {
    for (const [pair, v] of Object.entries<any>(byPair)) {
      const cards = v?.cards ?? v;
      if (cards && typeof cards === 'object') for (const [card, cv] of Object.entries<any>(cards)) put(pair, card, archValue(cv));
    }
  } else if (j.cards && typeof j.cards === 'object') {
    for (const [card, byP] of Object.entries<any>(j.cards)) {
      if (byP && typeof byP === 'object') for (const [pair, cv] of Object.entries<any>(byP)) put(pair, card, archValue(cv));
    }
  }
  if (!pairs.size) return null;
  const overall = new Map<string, number>();
  if (j.cards && typeof j.cards === 'object') {
    for (const [card, c] of Object.entries<any>(j.cards)) {
      const g = num(c?.overall?.gih_wr);
      if (g != null) overall.set(card, g);
    }
  }
  const base = new Map<string, number>();
  if (j.archetypes && typeof j.archetypes === 'object') {
    for (const [b, a] of Object.entries<any>(j.archetypes)) {
      const wr = num(a?.win_rate);
      const p = normPair(b);
      if (wr != null && p.length >= 1 && p.length <= 2 && p.length === b.length) base.set(p, wr);
    }
  }
  const extra = { ...(overall.size ? { overall } : {}), ...(base.size ? { base } : {}), ...(num(j.baseline_win_rate) != null ? { baseline: num(j.baseline_win_rate)! } : {}) };
  // The producer only lists a card × archetype cell with enough data (and shrinks it); no extra floor unless the file sets one.
  return { set: code.toUpperCase(), pairs, minGames: num(j.min_games) ?? 0, meta: { generated_at: j.generated_at, source: j.source, format: j.format }, ...extra };
}

export function archetypeValue(a: ArchetypeRatings | null | undefined, pair: string, card: string): number | undefined {
  if (!a) return undefined;
  const m = a.pairs.get(pair);
  const v = m?.get(card) ?? m?.get(card.split(' // ')[0]!);
  if (!v) return undefined;
  if (v.games != null && v.games < a.minGames) return undefined;
  return v.gih;
}
