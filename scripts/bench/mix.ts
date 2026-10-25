/**
 * Make Your Table Count: how many rated games a planned table can produce, and mixes that produce more, built from
 * what this person can actually run (docs/MULTI-PROVIDER.md, METHODOLOGY §2 and §3.2).
 *
 * Only games between two different seat identities (harness + model + effort) are rated. The Swiss pairs two seats of
 * the same identity only when it can't avoid it (packages/director/src/pairings.ts), so the number of rated matches
 * follows from the table's mix. packages/director/src/rated-estimate.ts runs the real pairing function over simulated
 * results (seeded, so the answer is stable; cached per composition) and counts the matches between different setups;
 * the lobby's `needs` reads the same estimate.
 *
 * Nothing here blocks a table: a mirror table is allowed and still adds format data (METHODOLOGY §2, "Mirror games").
 * Setup warns and suggests (setup.ts: the seats question, the Confirmation).
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GAMES_PER_MATCH, ratedGamesOf, ratedMatchesOfSeats } from '../../packages/director/src/rated-estimate.js';
import { registry } from '../../packages/registry/src/index.js';
import { SWISS_ROUNDS, TABLE_SEATS } from './core.js';
import { seatUsd } from './estimate.js';
import { LAUNCHABLE, harnessFor, type SeatSpec } from './harnesses.js';
import { effortChoice, effortLabel, modelChoices, modelLabel } from './models.js';

export { GAMES_PER_MATCH };
/**
 * Below this share of rated matches, a table is "few": setup warns and suggests a mix. Swiss pairing version 3 floats
 * a seat to the adjacent record group to avoid a same-setup pairing before the last round, and pairs the last round
 * strictly by points, so a 4 + 4 Effort Ladder rates a median 10 of 12 matches ("most"); 6 + 2 rates 6 ("few").
 */
export const FEW_RATED_SHARE = 0.75;

// ---------------------------------------------------------------------------
// Rated games for a table

export interface TableRating {
  seats: number;
  /** Matches the table plays (4 per round at 8 seats). */
  matches: number;
  /** Matches between two different setups (the median over the simulated pairings), and the fewest seen. */
  rated_matches: number;
  rated_matches_min: number;
  /** Games, at GAMES_PER_MATCH per match (rounded). */
  games: number;
  rated_games: number;
  /** Distinct setups among the model seats, and the largest group of identical seats. */
  setups: number;
  largest: number;
  /** none: no rated game; few: under FEW_RATED_SHARE of the matches; most: some lost to mirror pairings; full: every match in every simulated pod. */
  level: 'none' | 'few' | 'most' | 'full';
}

/**
 * Rated games a table of these identities can produce. `identities[i]` is seat i's identity key, or null for a seat
 * whose games are never rated (a scripted test player). Seats of one identity are one setup.
 */
export function ratedTable(identities: Array<string | null>, rounds = SWISS_ROUNDS): TableRating {
  const n = identities.length;
  const est = ratedMatchesOfSeats(identities, rounds);
  const matches = est.matches;
  const ratedMatches = est.rated;
  const llm = identities.filter((x): x is string => x != null);
  const groups = new Map<string, number>();
  for (const id of llm) groups.set(id, (groups.get(id) ?? 0) + 1);
  const level = est.max === 0 ? 'none' : est.min === matches ? 'full' : ratedMatches / matches < FEW_RATED_SHARE ? 'few' : 'most';
  return {
    seats: n, matches, rated_matches: ratedMatches, rated_matches_min: est.min,
    games: Math.round(matches * GAMES_PER_MATCH), rated_games: ratedGamesOf(est),
    setups: groups.size, largest: Math.max(0, ...groups.values()), level,
  };
}

/**
 * A seat's identity for pairing purposes: model/effort (the harness is never part of it: METHODOLOGY §2). Setup asks
 * the effort once per harness and model, so seats whose level is still to be asked share a placeholder per harness
 * ("?:<harness>"), which never matches another harness's. Scripted players: null (never rated).
 */
export function seatIdentity(s: Pick<SeatSpec, 'harness' | 'model' | 'effort' | 'effortUnknown' | 'declared'>, efforts?: Record<string, string>): string | null {
  if (!s.harness || harnessFor(s.harness)?.test) return null;
  // The efforts asked so far are keyed by harness and model (a launcher's seats, t3-code:claude-code, are its harness).
  const asked = `${canonHarness(s.harness)}/${s.model}`;
  const given = efforts?.[asked] ?? (s.effortUnknown ? 'unknown' : s.declared?.effort ? s.effort : undefined);
  return `${s.model}/${given ?? `?:${canonHarness(s.harness)}`}`;
}

/** The harness id a declared harness counts as: "t3-code:claude-code" is claude-code (a launcher isn't a harness). */
export function canonHarness(h: string): string {
  const r = registry.resolveHarness(h);
  return r.ok ? r.id : h;
}

// ---------------------------------------------------------------------------
// What this person can run

export interface CapabilityModel { id: string; label: string; levels: string[]; recommended: string; settable: boolean }

export interface Capability {
  harness: string;
  label: string;
  /** here: a CLI `bench play` starts on this machine; by-hand: an app found here whose seats you start yourself. */
  starts: 'here' | 'by-hand';
  version: string | null;
  models: CapabilityModel[];
}

/** Apps found on this machine that seat agents by hand: T3 Code (one app over several engines), the Antigravity CLI. */
export interface AppFound { app: 't3-code' | 'antigravity'; label: string; harnesses: string[] }

/**
 * Apps found on this machine (cheap file checks, nothing is run). T3 Code keeps its data in ~/.t3. It launches
 * harnesses without being one (registry/harnesses.json `launchers`): its seats are declared `t3-code:<harness>`, shown
 * "<harness> via T3 Code", and rank as that harness.
 */
export function detectApps(home: string = homedir()): AppFound[] {
  const out: AppFound[] = [];
  if (existsSync(join(home, '.t3'))) {
    const t3 = registry.launcher('t3-code');
    out.push({ app: 't3-code', label: t3?.display ?? 'T3 Code', harnesses: (t3?.launches ?? []).map((h) => `t3-code:${h}`).filter((h) => registry.resolveHarness(h).ok) });
  }
  // The Antigravity CLI (agy) keeps its state in ~/.gemini/antigravity-cli; its seats are seated by hand, each from a
  // folder of its own (docs/HARNESSES.md "Antigravity").
  if (existsSync(join(home, '.gemini', 'antigravity-cli'))) out.push({ app: 'antigravity', label: 'Antigravity CLI', harnesses: ['antigravity'] });
  return out;
}

const modelsOf = (harness: string): CapabilityModel[] => modelChoices(harness).map((m) => {
  const e = effortChoice(harness, m.id);
  return { id: m.id, label: m.label, levels: e.levels, recommended: e.recommended, settable: e.settable };
});

/** The harnesses and models this person can seat: CLIs installed here (started here), then apps found here (by hand). */
export function capabilities(installed: Map<string, string | undefined>, apps: AppFound[] = []): Capability[] {
  const out: Capability[] = [];
  for (const h of LAUNCHABLE) {
    if (h.test || !installed.get(h.id)) continue;
    out.push({ harness: h.id, label: registry.harnessDisplay(h.id), starts: 'here', version: installed.get(h.id) ?? null, models: modelsOf(h.id) });
  }
  for (const a of apps) for (const h of a.harnesses) out.push({ harness: h, label: registry.harnessLabel(h), starts: 'by-hand', version: null, models: modelsOf(h) });
  return out.filter((c) => c.models.length);
}

// ---------------------------------------------------------------------------
// Suggestions

export interface MixSuggestion {
  kind: 'effort-ladder' | 'model-mix' | 'provider-mix' | 'lobby';
  /** Title Case name: "Effort Ladder", "Model Mix", "Provider Mix", "Join the Lobby". */
  label: string;
  /** One plain sentence: what it compares. */
  why: string;
  /** Seat lines for setup's seats answer ("4x Claude Code / Claude Haiku 5.5 / low"); empty for the lobby. */
  seats: string[];
  /** Rated games the suggested table can produce (the lobby: null, it depends on who joins). */
  rated_games: number | null;
  /** Some of its seats are started by hand (an app such as T3 Code): Play One Table only. */
  by_hand: boolean;
}

export interface TableAdvice extends TableRating {
  /** A plain warning when the table produces few or no rated games; null when it is fine. */
  warning: string | null;
  /** "Rated games this table can produce: N (of up to M)". */
  line: string;
  suggestions: MixSuggestion[];
}

const lineOf = (n: number, harness: string, model: string, effort?: string) =>
  `${n}x ${registry.harnessLabel(harness)} / ${modelLabel(model)}${effort ? ` / ${effort}` : ''}`;
const levelFor = (m: CapabilityModel | undefined, want?: string) => (!m?.settable ? undefined : want && m.levels.includes(want) ? want : m.recommended);
const split = (total: number, parts: number) => Array.from({ length: parts }, (_, i) => Math.floor(total / parts) + (i < total % parts ? 1 : 0));

/** Ladder levels: low and high where the model has both, else its lowest and highest. */
function ladderLevels(levels: string[]): [string, string] | null {
  const ordered = levels.filter((l) => l !== 'ultra');
  if (ordered.length < 2) return null;
  if (ordered.includes('low') && ordered.includes('high')) return ['low', 'high'];
  return [ordered[0]!, ordered[ordered.length - 1]!];
}

const identitiesOfLines = (lines: Array<{ n: number; harness: string; model: string; effort?: string }>) =>
  lines.flatMap((l) => Array<string>(l.n).fill(`${l.harness}/${l.model}/${l.effort ?? 'default'}`));

/**
 * Advice for a planned table: its rated games, a warning when they are few, and mixes built from what the person can
 * run (`caps`) and the seats they chose. `table`: private (8 seats) or lobby (1–3 of yours). `continuous`: Keep
 * Playing starts every seat here, so by-hand harnesses aren't suggested.
 */
export function tableAdvice(seats: Array<Pick<SeatSpec, 'harness' | 'model' | 'effort' | 'effortUnknown' | 'declared'>>, o: {
  caps: Capability[]; table: 'private' | 'lobby'; continuous?: boolean; efforts?: Record<string, string>;
}): TableAdvice | null {
  const ids = seats.map((s) => seatIdentity(s, o.efforts));
  if (!ids.some((x) => x != null)) return null; // a scripted test table: nothing is ever rated, on purpose
  if (o.table === 'lobby') {
    // Other people's agents fill the table, and the Swiss keeps your seats and identical setups apart.
    return {
      ...ratedTable([...ids, ...Array.from({ length: Math.max(0, TABLE_SEATS - ids.length) }, (_, i) => `\u0000someone-else-${i}`)]), warning: null, suggestions: [],
      line: "Rated games: decided by who joins. The Swiss avoids pairing two identical setups (moving a seat to the next record group if it must, except in the last round) and, among equal records, your seats with each other, so most games at a lobby table are rated.",
    };
  }
  const r = ratedTable(ids);
  const line = `Rated games this table can produce: ${r.rated_games} (of up to ${r.games})`;
  const llm = seats.filter((s, i) => ids[i] != null);
  const counts = new Map<string, number>();
  for (const id of ids) if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  const [topId] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!;
  const base = llm[ids.filter((x) => x != null).indexOf(topId)]!;
  const label = (id: string) => {
    const [m, e] = id.split('/') as [string, string];
    return `${modelLabel(m)}${e.startsWith('?') ? '' : ` · ${effortLabel(e)}`}`;
  };
  let warning: string | null = null;
  if (r.level === 'none') {
    warning = counts.size === 1 && llm.length === seats.length
      ? `All ${seats.length} seats are the same setup, so no games will be rated (they still add format data).`
      : 'No two model seats here are different setups, so no games will be rated (they still add format data).';
  } else if (r.level === 'few') {
    warning = `${counts.get(topId)} of the ${seats.length} seats are the same setup (${label(topId)}), so only about ${r.rated_games} of this table's ${r.games} games will be rated (the rest still add format data).`;
  }
  if (!warning) return { ...r, line, warning, suggestions: [] };

  // Mixes from what this person can run, around the setup they chose.
  const suggestions: MixSuggestion[] = [];
  const total = seats.length;
  const usable = o.caps.filter((c) => !o.continuous || c.starts === 'here');
  const capOf = (h: string) => usable.find((c) => c.harness === h);
  const baseHarness = base.harness!;
  const baseModel = base.model!;
  const chosenEffort = topId.split('/')[1]!.startsWith('?') ? undefined : topId.split('/')[1];
  // The chosen harness counts as runnable even when it isn't installed here (they declared it; they start it by hand).
  const baseCap: CapabilityModel | undefined = capOf(baseHarness)?.models.find((m) => m.id === baseModel)
    ?? (() => { const e = effortChoice(baseHarness, baseModel); return { id: baseModel, label: modelLabel(baseModel), levels: e.levels, recommended: e.recommended, settable: e.settable }; })();
  const byHand = (h: string) => capOf(h)?.starts !== 'here';
  const push = (s: Omit<MixSuggestion, 'rated_games'>, lines: Array<{ n: number; harness: string; model: string; effort?: string }>) => {
    suggestions.push({ ...s, rated_games: ratedTable(identitiesOfLines(lines)).rated_games });
  };

  // 1. Effort Ladder: the same model at two effort levels.
  const ladder = ladderLevels(baseCap.levels);
  if (ladder) {
    const [lo, hi] = ladder;
    const [a, b] = split(total, 2) as [number, number];
    const lines = [{ n: a, harness: baseHarness, model: baseModel, effort: lo }, { n: b, harness: baseHarness, model: baseModel, effort: hi }];
    push({
      kind: 'effort-ladder', label: 'Effort Ladder', by_hand: byHand(baseHarness),
      why: `${modelLabel(baseModel)} at ${effortLabel(lo)} and at ${effortLabel(hi)}: does more thinking win more games, and what does it cost?`,
      seats: lines.map((l) => lineOf(l.n, l.harness, l.model, l.effort)),
    }, lines);
  }

  // 2. Model Mix: other models from the same provider in the same harness, cheapest first.
  const provider = registry.model(baseModel)?.provider;
  const sameProvider = (capOf(baseHarness)?.models ?? modelChoices(baseHarness).map((m) => ({ id: m.id, label: m.label, levels: [], recommended: 'high', settable: false })))
    .filter((m) => m.id !== baseModel && registry.model(m.id)?.provider === provider && registry.model(m.id)?.status !== 'deprecated');
  const usd = (id: string) => seatUsd(id, Date.now(), 'per-game', 'low')?.[0] ?? Infinity;
  const others = [...sameProvider].sort((x, y) => usd(x.id) - usd(y.id) || x.id.localeCompare(y.id)).slice(0, 2);
  if (others.length) {
    const models = [baseCap, ...others];
    const ns = split(total, models.length);
    const lines = models.map((m, i) => ({ n: ns[i]!, harness: baseHarness, model: m.id, effort: levelFor(capOf(baseHarness)?.models.find((x) => x.id === m.id) ?? m, chosenEffort) }));
    push({
      kind: 'model-mix', label: 'Model Mix', by_hand: byHand(baseHarness),
      why: `${models.map((m) => modelLabel(m.id)).join(', ')} from one ${registry.providerDisplay(provider ?? '')} sign-in: how much do the bigger models win by?`,
      seats: lines.map((l) => lineOf(l.n, l.harness, l.model, l.effort)),
    }, lines);
  }

  // 3. Provider Mix: another provider's model this person can run (CLIs here first, then apps), at the same level.
  // A harness alone is never a different setup (METHODOLOGY §2), so the comparison is across models.
  const otherProvider = usable
    .flatMap((c) => c.models.filter((m) => { const p2 = registry.model(m.id)?.provider; return p2 && p2 !== provider && registry.model(m.id)?.status !== 'deprecated'; }).map((m) => ({ c, m })))
    .sort((x, y) => Number(x.c.starts !== 'here') - Number(y.c.starts !== 'here') || usd(x.m.id) - usd(y.m.id) || x.m.id.localeCompare(y.m.id))[0];
  if (otherProvider) {
    const { c: second, m: m2 } = otherProvider;
    const e1 = levelFor(baseCap, chosenEffort);
    const e2 = levelFor(m2, e1);
    const [a, b] = split(total, 2) as [number, number];
    const lines = [{ n: a, harness: baseHarness, model: baseModel, effort: e1 }, { n: b, harness: second.harness, model: m2.id, effort: e2 }];
    push({
      kind: 'provider-mix', label: 'Provider Mix', by_hand: second.starts !== 'here' || byHand(baseHarness),
      why: `${modelLabel(baseModel)} against ${modelLabel(m2.id)} (${second.label}): two providers at one table.${second.starts === 'here' ? '' : ` You start the ${second.label} seats yourself, so this is for Play One Table.`}`,
      seats: lines.map((l) => lineOf(l.n, l.harness, l.model, l.effort)),
    }, lines);
  }

  // 4. The lobby: bring 1–3 seats and other people's agents fill the table.
  suggestions.push({
    kind: 'lobby', label: 'Join the Lobby', rated_games: null, by_hand: false, seats: [],
    why: `bring up to 3 seats of ${label(topId)} and other people's agents fill the table, so most of its games are rated. Good when you have one provider.`,
  });
  return { ...r, line, warning, suggestions };
}

/** The advice as plain lines (the wizard, the Confirmation text). */
export function adviceText(a: TableAdvice, indent = '  '): string[] {
  if (!a.warning) return [];
  return [
    `${indent}⚠ ${a.warning}`,
    `${indent}To make it count, mix setups you can run:`,
    ...a.suggestions.map((s, i) => `${indent}  ${i + 1}) ${s.label}: ${s.seats.length ? `${s.seats.join(' + ')} (${s.rated_games} rated games). ` : ''}${s.why}`),
  ];
}
