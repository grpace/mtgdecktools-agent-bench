/**
 * Integrity checks on a results bundle (docs/METHODOLOGY.md §3.1). Pure functions over the unpacked files:
 * the pipeline (ingest.ts) adds the database-backed checks (duplicates) and turns results into a status.
 *
 * Every check yields an outcome and a class:
 *   integrity   evidence the log was edited or is internally impossible (draft, games, packs)
 *   provenance  engine build / Director version / prompt version not what the leaderboard expects
 *   anomaly     plausible but suspicious (latencies, usage vs claimed model, duplicate decision streams)
 *   info        recorded for readers, never blocks
 * What a non-pass means depends on how the bundle arrived (see policy() in ingest.ts).
 */
import { createHash } from 'node:crypto';
import { validateBundle, type ValidationResult } from '../../director/src/submissions.js';
import { BASICS, isLlmSeat } from '../../site/src/data.js';
import { regenInputFromLog, regeneratePacks, type BoosterData, type RegenResult } from './packs.js';
import { sanityErrors } from './sanity.js';
import { verifyPairings } from '../../director/src/pairings.js';
import { EFFORT_SOURCE_LABELS, resolveHarness, resolveSeatEffort, verifySeatModel, type ResolvedEffort, type UsageLike, type VerificationResult } from '../../registry/src/index.js';

export type Outcome = 'pass' | 'fail' | 'warn' | 'unverifiable' | 'skip';
/** eligibility: the event isn't a product event at all (bot drafters at the table); always rejected. */
export type CheckClass = 'integrity' | 'provenance' | 'anomaly' | 'info' | 'eligibility';

export interface CheckResult {
  id: string;
  class: CheckClass;
  outcome: Outcome;
  message: string;
  details?: unknown;
}

export interface IntegrityReport {
  /** Structurally valid (schema, hashes, finished event). Structural failures are always rejected. */
  structural: boolean;
  errors: string[];
  eventId?: string;
  llm: boolean;
  checks: CheckResult[];
  regen?: RegenResult;
  /** Per agent seat: sha256 over its picks and decisions (choice + note), for duplicate detection. */
  fingerprints: Record<string, string>;
  validation: Pick<ValidationResult, 'flags' | 'warnings' | 'agents'>;
}

export interface CheckOptions {
  allowedEngineDigests: string[];
  boosters: BoosterData;
  minLatencyMs: number;
  fastShare: number;
  /**
   * Card data this repository vouches for (docs/CARD-OVERRIDES.md): sha256 of the pinned builds' upstream card-data.json
   * (deps/manifest.json phase_rs.data.card_data, plus history) and the fingerprint of a set of override slugs as this
   * repository's engine/overrides/<slug>.json files hash (scripts/card_overrides.py fingerprint(); null if a slug is
   * unknown). Omitted: the check is not run.
   */
  cardData?: { upstream: string[]; fingerprint: (slugs: string[]) => string | null };
}

type Raw = Record<string, any> & { t: number; type: string };

const pass = (id: string, cls: CheckClass, message: string, details?: unknown): CheckResult => ({ id, class: cls, outcome: 'pass', message, ...(details ? { details } : {}) });

function parseLog(buf: Buffer): Raw[] {
  const out: Raw[] = [];
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // validateBundle reports unparsable lines
    }
  }
  return out;
}

function multiset(xs: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
}

/** a − b as a multiset (entries of a not covered by b). */
function minus(a: Map<string, number>, b: Map<string, number>): string[] {
  const out: string[] = [];
  for (const [k, n] of a) for (let i = 0; i < n - (b.get(k) ?? 0); i++) out.push(k);
  return out;
}

// ---------------------------------------------------------------------------

/** Provenance from validateBundle's flags, regrouped into checks. */
function provenanceChecks(v: ValidationResult): CheckResult[] {
  const has = (re: RegExp) => v.flags.filter((f) => re.test(f));
  const engine = has(/^engine_build_/);
  const director = has(/^director_/);
  const prompt = has(/^prompt_version_unknown/);
  return [
    engine.length ? { id: 'provenance.engine', class: 'provenance', outcome: 'warn', message: `engine build not on the allowed list (${engine.join(', ')})` }
      : pass('provenance.engine', 'provenance', 'engine build is on the allowed list'),
    director.length ? { id: 'provenance.director', class: 'provenance', outcome: 'warn', message: `Director version: ${director.join(', ')}` }
      : pass('provenance.director', 'provenance', 'clean Director build'),
    prompt.length ? { id: 'provenance.prompt', class: 'provenance', outcome: 'warn', message: `prompts not known (${prompt.join(', ')}): not a set this Director ships` }
      : pass('provenance.prompt', 'provenance', 'known prompts'),
  ];
}

/**
 * The card data the event ran with (event_start.provenance.card_data, docs/CARD-OVERRIDES.md): upstream phase-rs card data
 * plus the local card overrides listed. Passes when the upstream file is the pinned build's (or a previous pin's) and the
 * listed overrides hash to the same fingerprint as this repository's override files. Logs from before card overrides
 * have no record (skip). A mismatch is a provenance warning, like an unknown engine build: the games ran with card
 * behavior this repository can't vouch for.
 */
export function cardDataCheck(start: Record<string, any>, repo: { upstream: string[]; fingerprint: (slugs: string[]) => string | null }): CheckResult {
  const cd = start?.provenance?.card_data;
  const id = 'provenance.card_data';
  if (!cd || typeof cd !== 'object') return { id, class: 'provenance', outcome: 'skip', message: 'card data not recorded (logs before card overrides)' };
  if (cd.sidecar === 'stale' || !Array.isArray(cd.overrides)) {
    return repo.upstream.includes(cd.sha256)
      ? pass(id, 'provenance', 'upstream card data of a pinned build, no overrides')
      : { id, class: 'provenance', outcome: 'warn', message: `card data ${String(cd.sha256).slice(0, 12)} is not a pinned build's and carries no override record` };
  }
  if (!repo.upstream.includes(cd.upstream_sha256)) {
    return { id, class: 'provenance', outcome: 'warn', message: `upstream card data ${String(cd.upstream_sha256).slice(0, 12)} is not a pinned build's` };
  }
  const want = repo.fingerprint(cd.overrides.map(String));
  return want === cd.overrides_sha256
    ? pass(id, 'provenance', cd.overrides.length ? `card overrides ${cd.overrides.join(', ')} match this repository's` : 'upstream card data, no overrides')
    : { id, class: 'provenance', outcome: 'warn', message: `card overrides (${cd.overrides.join(', ') || 'none'}) differ from this repository's override files` };
}

/** Replay the draft from packs_opened: every pick from the pack the seat actually held, passed correctly. */
export function draftConsistency(events: Raw[]): CheckResult & { pools?: Map<string, string[]> } {
  const id = 'draft.consistency';
  const start = events[0]!;
  const seats = [...(start.seats as Array<{ name: string; kind: string; position: number }>)].sort((a, b) => a.position - b.position);
  const n = seats.length;
  const problems: string[] = [];
  const rounds = events.filter((e) => e.type === 'packs_opened').sort((a, b) => a.round - b.round);
  const picks = events.filter((e) => e.type === 'draft_pick');
  const byKey = new Map<string, Raw[]>();
  for (const p of picks) {
    const k = `${p.seat}|${p.pack_number}|${p.pick_number}`;
    byKey.set(k, [...(byKey.get(k) ?? []), p]);
  }
  const pools = new Map<string, string[]>(seats.map((s) => [s.name, []]));
  let used = 0;
  if (!rounds.length) return { id, class: 'integrity', outcome: 'fail', message: 'no packs_opened records' };
  rounds.forEach((r, ri) => {
    if (r.round !== ri + 1) problems.push(`packs_opened rounds are not 1..${rounds.length}`);
    let packs: string[][] = (r.packs as string[][]).map((p) => [...p]);
    if (packs.length !== n) problems.push(`round ${r.round}: ${packs.length} packs for ${n} seats`);
    const dir = ri % 2 === 0 ? 1 : -1;
    const size = packs[0]?.length ?? 0;
    for (let pk = 1; pk <= size; pk++) {
      seats.forEach((s, i) => {
        const list = byKey.get(`${s.name}|${r.round}|${pk}`) ?? [];
        if (list.length !== 1) {
          problems.push(`${s.name} P${r.round}p${pk}: ${list.length} draft_pick records`);
          return;
        }
        used++;
        const p = list[0]!;
        const held = packs[i] ?? [];
        const shown = (p.pack as string[]) ?? [];
        if (shown.length !== held.length || shown.some((c, j) => c !== held[j])) problems.push(`${s.name} P${r.round}p${pk}: logged pack contents differ from the pack passed to this seat (${JSON.stringify(shown.filter((c, j) => c !== held[j]).slice(0, 3))} vs ${JSON.stringify(held.filter((c, j) => c !== shown[j]).slice(0, 3))})`);
        // The log names the pick, not its slot: with duplicates in the pack, take the copy whose removal
        // leaves the order the next holder logged.
        const slots = held.flatMap((c, j) => (c === p.pick ? [j] : []));
        if (!slots.length) problems.push(`${s.name} P${r.round}p${pk}: picked "${p.pick}", which is not in the pack`);
        else {
          const next = seats[(i + dir + n) % n]!;
          const nextShown = (byKey.get(`${next.name}|${r.round}|${pk + 1}`)?.[0]?.pack as string[] | undefined) ?? undefined;
          const fits = (j: number) => !nextShown || held.filter((_, k) => k !== j).every((c, k) => c === nextShown[k]);
          held.splice(slots.find(fits) ?? slots[0]!, 1);
        }
        pools.get(s.name)!.push(p.pick);
        // Agent picks: the agent's, the last card of a pack (forced), or the bot policy for an inactive seat (forfeit).
        const expectBy = s.kind === 'bot' ? ['bot'] : held.length === 0 ? ['forced', 'agent', 'forfeit'] : ['agent', 'forfeit'];
        if (!expectBy.includes(p.by)) problems.push(`${s.name} P${r.round}p${pk}: pick by "${p.by}" for a ${s.kind} seat`);
        if (p.overall_pick != null && p.overall_pick !== ri * size + pk) problems.push(`${s.name} P${r.round}p${pk}: overall_pick ${p.overall_pick}`);
        if (s.kind === 'agent' && p.by === 'agent' && typeof p.latency_ms === 'number' && p.latency_ms < 0) problems.push(`${s.name} P${r.round}p${pk}: negative latency`);
      });
      packs = seats.map((_, i) => packs[(i - dir + n) % n]!);
    }
    if (packs.some((p) => p.length)) problems.push(`round ${r.round}: cards left in packs after the last pick`);
  });
  if (used !== picks.length) problems.push(`${picks.length - used} draft_pick record(s) that belong to no pick slot`);
  if (problems.length) return { id, class: 'integrity', outcome: 'fail', message: `${problems.length} draft inconsistenc${problems.length === 1 ? 'y' : 'ies'}: ${problems[0]}`, details: problems.slice(0, 20) };
  return { ...pass(id, 'integrity', `${picks.length} picks replayed from the opened packs`), pools };
}

/** Every agent deck comes from its pool plus basic lands. */
export function deckConsistency(events: Raw[], pools: Map<string, string[]> | undefined): CheckResult {
  const id = 'draft.decks';
  if (!pools) return { id, class: 'integrity', outcome: 'skip', message: 'draft did not replay; decks not checked' };
  const start = events[0]!;
  const agents = (start.seats as Array<{ name: string; kind: string }>).filter((s) => s.kind === 'agent').map((s) => s.name);
  const decks = events.filter((e) => e.type === 'deck_built');
  const problems: string[] = [];
  for (const a of agents) {
    const mine = decks.filter((d) => d.seat === a);
    if (mine.length !== 1) {
      problems.push(`${a}: ${mine.length} deck_built records`);
      continue;
    }
    const d = mine[0]!;
    const main = (d.main as string[]) ?? [];
    const side = (d.sideboard as string[]) ?? [];
    if (main.length < 40) problems.push(`${a}: main deck has ${main.length} cards`);
    const pool = multiset(pools.get(a) ?? []);
    const used = multiset([...main, ...side]);
    const extra = minus(used, pool);
    const missing = minus(pool, used);
    const notBasic = extra.filter((c) => !BASICS.has(c));
    if (notBasic.length) problems.push(`${a}: deck uses ${notBasic.length} card(s) not in the pool (${notBasic.slice(0, 3).join(', ')})`);
    if (missing.length) problems.push(`${a}: ${missing.length} pool card(s) neither in the deck nor the sideboard`);
    if (!['agent', 'auto'].includes(d.by)) problems.push(`${a}: deck built by "${d.by}"`);
  }
  for (const d of decks) if (!agents.includes(d.seat)) problems.push(`deck_built for non-agent seat ${d.seat}`);
  if (problems.length) return { id, class: 'integrity', outcome: 'fail', message: `deck problems: ${problems[0]}`, details: problems };
  return pass(id, 'integrity', `${decks.length} deck(s) built from their pools plus basics`);
}

const matchOf = (g: Raw): string => (typeof g.match === 'string' ? g.match : /^(.*?)\s+—\s+game\s+\d+$/.exec(String(g.game))?.[1] ?? String(g.game));

/** Games, matches, standings, summary and turn snapshots agree. */
export function gameConsistency(events: Raw[], summary: any): CheckResult {
  const id = 'games.consistency';
  const start = events[0]!;
  const bestOf = Number(start.best_of ?? 3);
  const need = Math.floor(bestOf / 2) + 1;
  const agents = new Set((start.seats as Array<{ name: string; kind: string }>).filter((s) => s.kind === 'agent').map((s) => s.name));
  const problems: string[] = [];
  type G = { start: Raw; over?: Raw; snaps: Raw[]; failed?: boolean };
  const games = new Map<string, G>();
  // Games the Director voided (lost on the engine, e.g. across a restart) and replayed under the same label:
  // never scored, kept apart from the replay.
  const voided: G[] = [];
  const offered = new Map<string, Raw>();
  // Turn snapshots per label, in log order (the first can precede its game_start); a void starts the label afresh.
  const snaps = new Map<string, Raw[]>();
  for (const e of events) {
    if (e.type === 'game_start') {
      const prev = games.get(e.game);
      if (prev && prev.failed && !prev.over) voided.push(prev);
      else if (prev) problems.push(`duplicate game_start "${e.game}"`);
      games.set(e.game, { start: e, snaps: [] });
      const seats = (e.seats as string[]) ?? [];
      if (seats.length !== 2 || seats.some((s) => !agents.has(s)) || seats[0] === seats[1]) problems.push(`"${e.game}": seats ${JSON.stringify(seats)} are not two agent seats`);
    } else if (e.type === 'game_over') {
      const g = games.get(e.game);
      if (!g) problems.push(`game_over for unknown game "${e.game}"`);
      else if (g.over) problems.push(`two game_over records for "${e.game}"`);
      else g.over = e;
    } else if (e.type === 'game_failed') {
      const g = games.get(e.game);
      if (g) g.failed = true;
      if (e.void) snaps.delete(e.game);
    } else if (e.type === 'turn_snapshot') {
      const list = snaps.get(e.game) ?? [];
      list.push(e); // the Director may log the first snapshot just before game_start
      snaps.set(e.game, list);
    } else if (e.type === 'decision_offered' && e.game) {
      offered.set(`${e.game}|${e.seat}|${e.id}`, e);
    } else if (e.type === 'agent_decision' && e.game) {
      const g = games.get(e.game);
      if (!g) problems.push(`agent_decision for unknown game "${e.game}"`);
      else if (!(g.start.seats as string[]).includes(e.seat)) problems.push(`agent_decision by ${e.seat}, who is not in "${e.game}"`);
      const o = offered.get(`${e.game}|${e.seat}|${e.id}`);
      if (typeof e.latency_ms === 'number') {
        if (e.latency_ms < 0) problems.push(`negative latency in "${e.game}"`);
        else if (o && e.latency_ms > e.t - o.t + 1000) problems.push(`latency ${e.latency_ms} ms exceeds the time since the decision was offered (${e.t - o.t} ms) in "${e.game}"`);
      }
    }
  }
  for (const [label, list] of snaps) {
    const g = games.get(label);
    if (!g) problems.push(`turn_snapshot for unknown game "${label}"`);
    else g.snaps.push(...list);
  }
  if (voided.some((v) => v.over)) problems.push('a voided game has a game_over');
  const wins = new Map<string, Record<string, number>>();
  const played = new Map<string, number>();
  for (const [label, g] of games) {
    const seats = g.start.seats as string[];
    const mk = matchOf(g.start);
    played.set(mk, (played.get(mk) ?? 0) + 1);
    if (!wins.has(mk)) wins.set(mk, Object.fromEntries(seats.map((s) => [s, 0])));
    if (!g.over) {
      if (!g.failed) problems.push(`"${label}" has no game_over`);
      continue;
    }
    const o = g.over;
    if (o.winner != null && !seats.includes(o.winner)) problems.push(`"${label}": winner ${o.winner} did not play`);
    if (o.winner) wins.get(mk)![o.winner] = (wins.get(mk)![o.winner] ?? 0) + 1;
    if (o.end_reason === 'life' && o.final_life && o.winner) {
      const loser = seats.find((s) => s !== o.winner)!;
      if (!(o.final_life[loser] <= 0) || !(o.final_life[o.winner] > 0)) problems.push(`"${label}": ended on life but final life is ${JSON.stringify(o.final_life)}`);
    }
    const turns = Number(o.turns);
    let last = 0;
    for (const s of g.snaps) {
      if (s.turn < last) problems.push(`"${label}": turn snapshots go backwards (${last} → ${s.turn})`);
      last = s.turn;
      const ps = Object.keys(s.players ?? {});
      if (ps.some((p) => !seats.includes(p))) problems.push(`"${label}": turn snapshot for a player not in the game`);
    }
    if (g.snaps.length && (last > turns || turns - last > 1)) problems.push(`"${label}": snapshots reach turn ${last}, game_over says ${turns} turns`);
  }
  // Matches: match_end agrees with the games; best-of respected.
  const ends = events.filter((e) => e.type === 'match_end');
  const failedMatch = new Set([...games.values()].filter((g) => g.failed).map((g) => matchOf(g.start)));
  for (const me of ends) {
    const mk = `${me.a} vs ${me.b}`;
    const w = wins.get(mk);
    if (!w) {
      // A match whose first game the engine never started (voided until it ended with no result) has no games.
      if (me.no_result !== true) problems.push(`match_end for "${mk}" without games`);
      continue;
    }
    for (const s of [me.a, me.b]) if ((me.wins?.[s] ?? 0) !== (w[s] ?? 0)) problems.push(`match "${mk}": match_end says ${s} won ${me.wins?.[s]}, games say ${w[s] ?? 0}`);
    const top = Math.max(w[me.a] ?? 0, w[me.b] ?? 0);
    if ((played.get(mk) ?? 0) > bestOf) problems.push(`match "${mk}": ${played.get(mk)} games in a best-of-${bestOf}`);
    if (top > need) problems.push(`match "${mk}": games continued after a player reached ${need} wins`);
    const draws = [...games.values()].filter((g) => matchOf(g.start) === mk && g.over && g.over.winner == null).length;
    if (top < need && !failedMatch.has(mk) && me.no_result !== true && (played.get(mk) ?? 0) < bestOf && !draws) problems.push(`match "${mk}" ended before anyone reached ${need} wins`);
    if (me.no_result === true && top >= need) problems.push(`match "${mk}": no result, but ${top} wins decided it`);
  }
  for (const mk of wins.keys()) if (!ends.some((me) => `${me.a} vs ${me.b}` === mk)) problems.push(`match "${mk}" has no match_end`);
  // Standings: event_end and summary.json agree with match results.
  const end = events.find((e) => e.type === 'event_end');
  const computed = [...agents].map((name) => {
    const st = { name, matchWins: 0, matchLosses: 0, gameWins: 0, gameLosses: 0 };
    for (const me of ends) {
      if (me.a !== name && me.b !== name) continue;
      const opp = me.a === name ? me.b : me.a;
      st.gameWins += me.wins?.[name] ?? 0;
      st.gameLosses += me.wins?.[opp] ?? 0;
      if (me.no_result === true) continue; // no result: neither won nor lost
      if ((me.wins?.[name] ?? 0) > (me.wins?.[opp] ?? 0)) st.matchWins++;
      else if ((me.wins?.[name] ?? 0) < (me.wins?.[opp] ?? 0)) st.matchLosses++;
    }
    return st;
  });
  const sameStandings = (list: any[] | undefined, what: string) => {
    if (!Array.isArray(list)) {
      problems.push(`${what} has no standings`);
      return;
    }
    for (const c of computed) {
      const s = list.find((x) => x?.name === c.name);
      if (!s) {
        if (ends.some((me) => me.a === c.name || me.b === c.name)) problems.push(`${what}: no standing for ${c.name}`);
        continue;
      }
      for (const k of ['matchWins', 'matchLosses', 'gameWins', 'gameLosses'] as const) {
        if (s[k] !== c[k]) problems.push(`${what}: ${c.name} ${k} ${s[k]}, match results say ${c[k]}`);
      }
    }
  };
  if (end) sameStandings(end.standings, 'event_end');
  if (summary) {
    sameStandings(summary.standings, 'summary.json');
    for (const m of summary.matches ?? []) {
      const me = ends.find((x) => x.a === m.a && x.b === m.b);
      if (!me) problems.push(`summary.json match ${m.a} vs ${m.b} has no match_end`);
      else for (const s of [m.a, m.b]) if ((m.wins?.[s] ?? 0) !== (me.wins?.[s] ?? 0)) problems.push(`summary.json: ${m.a} vs ${m.b} wins differ from match_end`);
    }
  }
  if (problems.length) return { id, class: 'integrity', outcome: 'fail', message: `${problems.length} game/match inconsistenc${problems.length === 1 ? 'y' : 'ies'}: ${problems[0]}`, details: problems.slice(0, 30) };
  const nSnaps = [...games.values()].reduce((n, g) => n + g.snaps.length, 0);
  return pass(id, 'integrity', `${games.size} game(s), ${ends.length} match(es) and the standings agree${nSnaps ? `; ${nSnaps} turn snapshots consistent` : ''}`);
}

const gameNumberOf = (g: Raw): number => Number(/—\s+game\s+(\d+)$/.exec(String(g.game))?.[1] ?? 1);
const sameMultiset = (a: Map<string, number>, b: Map<string, number>): boolean => !minus(a, b).length && !minus(b, a).length;
const counts = (xs: unknown): Map<string, number> => {
  const m = new Map<string, number>();
  if (Array.isArray(xs)) for (const x of xs) if (x && typeof x.name === 'string' && Number.isInteger(x.qty) && x.qty > 0) m.set(x.name, (m.get(x.name) ?? 0) + x.qty);
  return m;
};
const listOf = (m: Map<string, number>): string => [...m].map(([n, q]) => `${q} ${n}`).join(', ');

/** The seats and games of each match from game_start records (a voided and replayed game: its replay). */
function matchesOf(events: Raw[]): Map<string, { seats: string[]; games: Map<number, { start: Raw; over?: Raw }> }> {
  const out = new Map<string, { seats: string[]; games: Map<number, { start: Raw; over?: Raw }> }>();
  const byLabel = new Map<string, { start: Raw; over?: Raw }>();
  for (const e of events) {
    if (e.type === 'game_start') {
      const mk = matchOf(e);
      const m = out.get(mk) ?? { seats: [...((e.seats as string[]) ?? [])], games: new Map() };
      out.set(mk, m);
      const g = { start: e };
      m.games.set(gameNumberOf(e), g);
      byLabel.set(String(e.game), g);
    } else if (e.type === 'game_over') {
      const g = byLabel.get(String(e.game));
      if (g && !g.over) g.over = e;
    }
  }
  return out;
}

/**
 * Sideboarding between games (best of 3 with sideboarding, logs from 2026-10-22 on): every `sideboarded` record is for
 * an agent seat of that match, at most one per seat per game (exactly one before games 2–3 when the event declares
 * sideboarding), its main + sideboard is the seat's pool plus basic lands (only in the main), the main has at least
 * 40 cards, and in / out are the change from the deck the seat played in the previous game of the match (each match
 * starts from the deck_built deck). Older logs without these records skip.
 */
export function sideboardConsistency(events: Raw[], pools: Map<string, string[]> | undefined): CheckResult {
  const id = 'games.sideboarding';
  const start = events[0]!;
  const recs = events.filter((e) => e.type === 'sideboarded');
  if (!recs.length && start.sideboarding !== true) return { id, class: 'integrity', outcome: 'skip', message: 'no sideboarding records (played without sideboarding)' };
  const agents = new Set((start.seats as Array<{ name: string; kind: string }>).filter((s) => s.kind === 'agent').map((s) => s.name));
  const built = new Map<string, Raw>();
  for (const d of events) if (d.type === 'deck_built' && !built.has(d.seat)) built.set(d.seat, d);
  const matches = matchesOf(events);
  const problems: string[] = [];
  const seen = new Set<string>();
  // The deck each seat played last in each match: the registered deck, then each sideboarded main in game order.
  const current = new Map<string, Map<string, number>>();
  const sorted = [...recs].sort((a, b) => String(a.match).localeCompare(String(b.match)) || Number(a.game_number) - Number(b.game_number));
  for (const r of sorted) {
    const at = `${r.seat} before "${r.match}" game ${r.game_number}`;
    const m = matches.get(String(r.match));
    const seats = m?.seats ?? String(r.match).split(' vs ');
    if (!agents.has(r.seat) || !seats.includes(r.seat)) {
      problems.push(`${at}: not an agent seat of that match`);
      continue;
    }
    if (!Number.isInteger(r.game_number) || r.game_number < 2) problems.push(`${at}: sideboarding is only before games 2 and 3`);
    const key = `${r.seat}|${r.match}|${r.game_number}`;
    if (seen.has(key)) {
      problems.push(`${at}: more than one sideboarded record`);
      continue;
    }
    seen.add(key);
    const main = Array.isArray(r.main) ? (r.main as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    const side = Array.isArray(r.sideboard) ? (r.sideboard as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    if (main.length < 40) problems.push(`${at}: main deck has ${main.length} cards`);
    if (r.main_count != null && r.main_count !== main.length) problems.push(`${at}: main_count ${r.main_count}, main has ${main.length} cards`);
    if (!['agent', 'forfeit'].includes(r.by)) problems.push(`${at}: sideboarded by "${r.by}"`);
    // Pool: the replayed draft, else the registered deck (its main and sideboard: the pool plus basics).
    const d = built.get(r.seat);
    const poolList = pools?.get(r.seat) ?? (d ? [...((d.main as string[]) ?? []), ...((d.sideboard as string[]) ?? [])] : undefined);
    if (poolList) {
      const nonBasic = (xs: string[]) => multiset(xs.filter((c) => !BASICS.has(c)));
      const extra = minus(nonBasic([...main, ...side]), nonBasic(poolList));
      const missing = minus(nonBasic(poolList), nonBasic([...main, ...side]));
      if (extra.length) problems.push(`${at}: ${extra.length} card(s) not in the pool (${extra.slice(0, 3).join(', ')})`);
      if (missing.length) problems.push(`${at}: ${missing.length} pool card(s) neither in the main deck nor the sideboard`);
      // Drafted basics may sit in the sideboard; added ones only in the main (known only when the draft replayed).
      const drafted = pools?.get(r.seat);
      const sideBasics = drafted ? minus(multiset(side.filter((c) => BASICS.has(c))), multiset(drafted.filter((c) => BASICS.has(c)))) : [];
      if (sideBasics.length) problems.push(`${at}: basic lands added to the sideboard (${sideBasics.slice(0, 3).join(', ')}); added basics go in the main deck only`);
    }
    if (r.basics && typeof r.basics === 'object') {
      const inMain = multiset(main.filter((c) => BASICS.has(c)));
      for (const [b, n] of Object.entries(r.basics as Record<string, number>)) if ((inMain.get(b) ?? 0) !== n) problems.push(`${at}: basics say ${n} ${b}, the main deck has ${inMain.get(b) ?? 0}`);
    }
    // in / out against the deck played in the previous game of this match.
    const ck = `${r.seat}|${r.match}`;
    const prev = current.get(ck) ?? (d ? multiset((d.main as string[]) ?? []) : undefined);
    const now = multiset(main);
    if (prev) {
      const added = multiset(minus(now, prev));
      const removed = multiset(minus(prev, now));
      if (!sameMultiset(counts(r.in), added) || !sameMultiset(counts(r.out), removed)) {
        problems.push(`${at}: in/out (+${listOf(counts(r.in)) || 'nothing'}; −${listOf(counts(r.out)) || 'nothing'}) don't match the change from the previous deck (+${listOf(added) || 'nothing'}; −${listOf(removed) || 'nothing'})`);
      }
      const unchanged = !added.size && !removed.size;
      if (r.kept === true && !unchanged) problems.push(`${at}: kept, but the deck changed`);
      if (r.kept === false && unchanged) problems.push(`${at}: not kept, but the deck is unchanged`);
      if (r.by === 'forfeit' && !unchanged) problems.push(`${at}: a forfeit keeps the current deck, but the deck changed`);
    }
    current.set(ck, now);
  }
  // Exactly one per seat before every game 2 and 3 that started, when the event declares sideboarding.
  if (start.sideboarding === true) {
    for (const [mk, m] of matches) {
      for (const n of m.games.keys()) {
        if (n < 2) continue;
        for (const s of m.seats) if (!seen.has(`${s}|${mk}|${n}`)) problems.push(`${s} before "${mk}" game ${n}: no sideboarded record`);
      }
    }
  }
  if (problems.length) return { id, class: 'integrity', outcome: 'fail', message: `${problems.length} sideboarding inconsistenc${problems.length === 1 ? 'y' : 'ies'}: ${problems[0]}`, details: problems.slice(0, 20) };
  return pass(id, 'integrity', `${recs.length} sideboarding record(s) consistent with the pools and the previous decks`);
}

/**
 * Play or draw (best of 3 with sideboarding, logs from 2026-10-22 on): one `play_draw` record per game of a match.
 * Game 1 is random from the seed (no chooser); in games 2–3 the chooser is the previous game's loser (after a drawn
 * game, the previous chooser; after a drawn game 1, the seat the seed put on the play), the choice decides who starts
 * (a forfeit defaults to play), and game_over.on_play agrees. Older logs without these records skip.
 */
export function playDrawConsistency(events: Raw[]): CheckResult {
  const id = 'games.play_draw';
  const start = events[0]!;
  const recs = events.filter((e) => e.type === 'play_draw');
  if (!recs.length && !start.play_draw) return { id, class: 'integrity', outcome: 'skip', message: 'no play/draw records (older log)' };
  const matches = matchesOf(events);
  const problems: string[] = [];
  const byGame = new Map<string, Raw>();
  for (const r of recs) {
    const key = `${r.match}|${r.game_number}`;
    if (byGame.has(key)) problems.push(`"${r.match}" game ${r.game_number}: more than one play_draw record`);
    else byGame.set(key, r);
  }
  for (const r of byGame.values()) if (!matches.has(String(r.match))) problems.push(`play_draw for "${r.match}", which has no games`);
  for (const [mk, m] of matches) {
    let prevChooser: string | null = null;
    let prevOnPlay: string | null = null;
    const numbers = [...m.games.keys()].sort((a, b) => a - b);
    for (const n of numbers) {
      const g = m.games.get(n)!;
      const r = byGame.get(`${mk}|${n}`);
      const at = `"${mk}" game ${n}`;
      if (!r) {
        problems.push(`${at}: no play_draw record`);
        break;
      }
      const other = (s: string) => m.seats.find((x) => x !== s);
      if (!m.seats.includes(r.on_play)) problems.push(`${at}: on_play ${r.on_play} is not in the match`);
      if (n === 1) {
        if (r.by !== 'seed' || r.chooser != null || r.choice != null) problems.push(`${at}: game 1 is decided by the seed (by "${r.by}", chooser ${r.chooser ?? 'null'})`);
      } else {
        const prev = m.games.get(n - 1)?.over;
        if (prev) {
          const want = prev.winner != null ? other(prev.winner) : (prevChooser ?? prevOnPlay);
          if (want && r.chooser !== want) problems.push(`${at}: chooser ${r.chooser ?? 'null'}, but ${prev.winner != null ? 'the loser of the previous game' : 'the previous chooser (the previous game was a draw)'} is ${want}`);
        }
        if (!['agent', 'forfeit'].includes(r.by)) problems.push(`${at}: decided by "${r.by}"`);
        if (r.by === 'forfeit' && r.choice != null && r.choice !== 'play') problems.push(`${at}: a forfeit defaults to play, not ${r.choice}`);
        const choice = r.by === 'forfeit' ? 'play' : r.choice;
        if (choice !== 'play' && choice !== 'draw') problems.push(`${at}: choice ${r.choice ?? 'null'}`);
        else if (typeof r.chooser === 'string' && r.on_play !== (choice === 'play' ? r.chooser : other(r.chooser))) problems.push(`${at}: ${r.chooser} chose to ${choice}, but ${r.on_play} was on the play`);
      }
      if (g.over?.on_play && g.over.on_play !== r.on_play) problems.push(`${at}: play_draw puts ${r.on_play} on the play, game_over says ${g.over.on_play}`);
      prevChooser = typeof r.chooser === 'string' ? r.chooser : prevChooser;
      prevOnPlay = prevOnPlay ?? r.on_play;
    }
  }
  if (problems.length) return { id, class: 'integrity', outcome: 'fail', message: `${problems.length} play/draw inconsistenc${problems.length === 1 ? 'y' : 'ies'}: ${problems[0]}`, details: problems.slice(0, 20) };
  return pass(id, 'integrity', `${byGame.size} play/draw decision(s): losers chose, and the games started that way`);
}

/**
 * Decision kinds that legitimately follow an answer within milliseconds (the next step of a mana payment
 * the agent already planned), so they say nothing about whether a model produced the answer.
 */
const CONTINUATIONS = new Set(['ManaPayment']);

/** Impossible or implausibly fast LLM decisions. */
export function latencyAnomalies(events: Raw[], opts: Pick<CheckOptions, 'minLatencyMs' | 'fastShare'>): CheckResult {
  const id = 'anomaly.latency';
  const start = events[0]!;
  const llm = (start.seats as Array<{ name: string; kind: string }>).filter((s) => isLlmSeat(s)).map((s) => s.name);
  if (!llm.length) return { id, class: 'anomaly', outcome: 'skip', message: 'no LLM seats' };
  const flagged: string[] = [];
  const per: Record<string, { n: number; fast: number; median: number | null }> = {};
  for (const seat of llm) {
    const lat = events
      .filter((e) => e.seat === seat && ((e.type === 'draft_pick' && e.by === 'agent') || (e.type === 'agent_decision' && !CONTINUATIONS.has(e.kind)) || (e.type === 'deck_built' && e.by === 'agent')))
      .map((e) => e.latency_ms)
      .filter((x): x is number => typeof x === 'number');
    const fast = lat.filter((x) => x < opts.minLatencyMs).length;
    const sorted = [...lat].sort((a, b) => a - b);
    per[seat] = { n: lat.length, fast, median: sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null };
    if (lat.length && fast / lat.length > opts.fastShare) flagged.push(`${seat}: ${fast} of ${lat.length} answers faster than ${opts.minLatencyMs} ms`);
  }
  if (flagged.length) return { id, class: 'anomaly', outcome: 'warn', message: `implausibly fast decisions for an LLM (${flagged.join('; ')})`, details: per };
  return pass(id, 'anomaly', 'decision latencies are plausible for LLM seats', per);
}

/**
 * Model identity (METHODOLOGY §2.1, registry/README.md): the primary model in each LLM seat's harness usage (most
 * output tokens, helper models ignored) must resolve to the same canonical id as the declared model.
 *   anomaly.usage_model  warn on a Mismatch (the export excludes that seat from rating; a maintainer reviews)
 *   identity.registry    info: Unlisted seats (model or harness not in the registry: unrated until listed),
 *                        Self-Reported seats (no usage, or no model ids), dated snapshots the registry doesn't list
 */
export function usageModelCheck(events: Raw[], files: Map<string, Buffer>): CheckResult {
  return modelChecks(events, files)[0]!;
}

export function modelChecks(events: Raw[], files: Map<string, Buffer>): CheckResult[] {
  const id = 'anomaly.usage_model';
  const start = events[0]!;
  type SeatMeta = { name: string; kind: string; harness?: string; model?: string; model_id?: string; harness_declared?: string; model_declared?: string };
  const per: Record<string, VerificationResult> = {};
  for (const s of (start.seats as SeatMeta[]).filter((x) => isLlmSeat(x))) {
    const f = files.get(`usage-${s.name}.json`);
    let u: UsageLike | null = null;
    if (f) {
      try {
        const o = JSON.parse(f.toString('utf8'));
        u = {
          model_ids: Array.isArray(o?.model_ids) ? o.model_ids.map(String) : [],
          ...(o?.model_output_tokens && typeof o.model_output_tokens === 'object' ? { model_output_tokens: o.model_output_tokens } : {}),
        };
      } catch {
        u = null;
      }
    }
    const harness = s.harness_declared ?? s.harness;
    const model = s.model_declared ?? s.model ?? s.model_id;
    const h = resolveHarness(harness);
    per[s.name] = !h.ok
      ? { status: 'unlisted', reason: `harness "${harness ?? ''}" isn't in the registry` }
      : verifySeatModel({ model, harness: h.id, at: typeof start.t === 'number' ? start.t : undefined }, u);
  }
  const by = (st: string) => Object.entries(per).filter(([, v]) => v.status === st);
  const mism = by('mismatch');
  const out: CheckResult[] = [];
  const seats = Object.keys(per).length;
  if (!seats) out.push({ id, class: 'anomaly', outcome: 'skip', message: 'no LLM seats' });
  else if (mism.length) {
    out.push({
      id, class: 'anomaly', outcome: 'warn', details: per,
      message: `harness usage shows a different model than declared (${mism.map(([n, v]) => `${n}: ${v.reason}`).join('; ')}); these seats are excluded from rating`,
    });
  } else if (by('verified').length) out.push(pass(id, 'anomaly', `${by('verified').length} of ${seats} seat(s): Verified Model (harness usage matches the declared model)`, per));
  else out.push({ id, class: 'anomaly', outcome: 'skip', message: 'no harness usage with model ids: seats are Self-Reported', details: per });
  const notes = [
    ...by('unlisted').map(([n, v]) => `${n}: Unlisted (${v.reason}; unrated until the registry lists it)`),
    ...by('self-reported').map(([n, v]) => `${n}: Self-Reported (${v.reason})`),
    ...Object.entries(per).filter(([, v]) => v.snapshot && v.snapshot_known === false).map(([n, v]) => `${n}: dated snapshot ${v.snapshot} not in the registry`),
  ];
  if (notes.length) out.push({ id: 'identity.registry', class: 'info', outcome: 'warn', message: notes.join('; '), details: per });
  return out;
}

/**
 * Effort (METHODOLOGY §2.1): the level the harness logs show (usage-<seat>.json `effort_reported`) against the
 * declared one, resolved as the export does (registry resolveSeatEffort).
 *   anomaly.usage_effort  warn when the logs show another level, or the level changed during the session
 *   identity.effort       info: seats whose effort is a harness default, self-reported, or Unknown
 */
export function effortChecks(events: Raw[], files: Map<string, Buffer>): CheckResult[] {
  const id = 'anomaly.usage_effort';
  const start = events[0]!;
  type SeatMeta = { name: string; kind: string; harness?: string; model?: string; effort?: string; harness_declared?: string; model_declared?: string; effort_declared?: string; effort_basis?: string };
  const per: Record<string, ResolvedEffort> = {};
  for (const s of (start.seats as SeatMeta[]).filter((x) => isLlmSeat(x))) {
    let u: any;
    try {
      u = files.has(`usage-${s.name}.json`) ? JSON.parse(files.get(`usage-${s.name}.json`)!.toString('utf8')) : undefined;
    } catch {
      u = undefined;
    }
    const er = u?.effort_reported;
    per[s.name] = resolveSeatEffort({
      harness: s.harness_declared ?? s.harness, model: s.model_declared ?? s.model, declared: s.effort_declared ?? s.effort,
      ...(s.effort_basis === 'launch' || s.effort_basis === 'self-report' ? { basis: s.effort_basis } : {}),
      detected: er && typeof er === 'object' && typeof er.source === 'string' ? { level: typeof er.level === 'string' ? er.level : null, counts: er.counts ?? {}, source: er.source } : null,
      harnessVersion: typeof u?.harness_version === 'string' ? u.harness_version : undefined, at: typeof start.t === 'number' ? start.t : undefined,
    });
  }
  const seats = Object.entries(per);
  if (!seats.length) return [{ id, class: 'anomaly', outcome: 'skip', message: 'no LLM seats' }];
  const out: CheckResult[] = [];
  const mism = seats.filter(([, r]) => r.status === 'mismatch');
  const ver = seats.filter(([, r]) => r.status === 'verified');
  if (mism.length) out.push({ id, class: 'anomaly', outcome: 'warn', details: per, message: `effort differs from the declaration (${mism.map(([n, r]) => `${n}: ${r.reason}`).join('; ')}); the seat is rated at the level the logs show, or as Unknown` });
  else if (ver.length) out.push(pass(id, 'anomaly', `${ver.length} of ${seats.length} seat(s): effort confirmed by the harness logs`, per));
  else out.push({ id, class: 'anomaly', outcome: 'skip', message: 'no harness logs with an effort level: effort is as declared', details: per });
  const notes = seats.filter(([, r]) => r.status !== 'mismatch' && r.source !== 'detected').map(([n, r]) => `${n}: ${r.effort} (${EFFORT_SOURCE_LABELS[r.source]})`);
  if (notes.length) out.push({ id: 'identity.effort', class: 'info', outcome: seats.some(([, r]) => r.effort === 'unknown') ? 'warn' : 'pass', message: notes.join('; '), details: per });
  return out;
}

/** Per agent seat: hash of its pick sequence and its decisions (choice + note). */
export function decisionFingerprints(events: Raw[]): Record<string, string> {
  const start = events[0]!;
  const out: Record<string, string> = {};
  for (const s of (start.seats as Array<{ name: string; kind: string }>).filter((x) => x.kind === 'agent')) {
    const stream = events
      .filter((e) => e.seat === s.name && ((e.type === 'draft_pick' && e.by === 'agent') || e.type === 'agent_decision' || e.type === 'deck_built'))
      .map((e) => (e.type === 'draft_pick' ? ['p', e.pick, e.note ?? ''] : e.type === 'deck_built' ? ['d', e.main, e.note ?? ''] : ['g', e.kind, e.choice, e.note ?? '']));
    if (stream.length) out[s.name] = createHash('sha256').update(JSON.stringify(stream)).digest('hex');
  }
  return out;
}

/** Run every file-level check. Never throws for bad input: problems become errors or check results. */
export function checkBundle(files: Map<string, Buffer>, opts: CheckOptions): IntegrityReport {
  const v = validateBundle(files, { allowedEngineDigests: opts.allowedEngineDigests });
  const report: IntegrityReport = {
    structural: v.ok, errors: v.errors, eventId: v.eventId, llm: false, checks: [], fingerprints: {},
    validation: { flags: v.flags, warnings: v.warnings, agents: v.agents },
  };
  if (!v.ok) return report;
  // Types and sizes of everything the export turns into markup, paths and loops (src/sanity.ts).
  const insane = sanityErrors(files);
  if (insane.length) {
    report.structural = false;
    report.errors.push(...insane);
    return report;
  }
  const events = parseLog(files.get('events.jsonl')!);
  let summary: any;
  try {
    summary = JSON.parse(files.get('summary.json')!.toString('utf8'));
  } catch {
    summary = undefined;
  }
  const start = events[0]!;
  report.llm = (start.seats as Array<{ name: string; kind: string }>).some((s) => isLlmSeat(s));
  report.checks.push(...provenanceChecks(v));
  if (opts.cardData) report.checks.push(cardDataCheck(start, opts.cardData));

  const draft = draftConsistency(events);
  const { pools, ...draftResult } = draft;
  report.checks.push(draftResult, deckConsistency(events, pools));

  const input = regenInputFromLog(events);
  const regen: RegenResult = input ? regeneratePacks(input, opts.boosters) : { status: 'unverifiable', message: 'no event_start' };
  report.regen = regen;
  report.checks.push({
    id: 'packs.regeneration', class: 'integrity',
    outcome: regen.status === 'verified' ? 'pass' : regen.status === 'partial' ? 'pass' : regen.status === 'mismatch' ? 'fail' : 'unverifiable',
    message: `${regen.status}: ${regen.message}`,
    details: { mode: regen.mode, missing: regen.missing, diffs: regen.diffs?.slice(0, 10), seat_positions: regen.seat_positions, swap_targets_unproven: regen.swap_targets_unproven },
  });

  report.checks.push(gameConsistency(events, summary));
  report.checks.push(sideboardConsistency(events, pools), playDrawConsistency(events));
  report.checks.push(pairingCheck(events));
  report.checks.push(seatEligibility(events));
  report.checks.push(latencyAnomalies(events, opts));
  report.checks.push(...modelChecks(events, files), ...effortChecks(events, files));
  if (v.flags.includes('timestamps_out_of_order')) report.checks.push({ id: 'anomaly.timestamps', class: 'anomaly', outcome: 'warn', message: 'log timestamps go backwards by more than 5 s' });
  const info = v.flags.filter((f) => /^(seat_metadata_|no_usage_reported|fewer_than_two_agents|summary_game_count_mismatch)/.test(f));
  if (info.length) report.checks.push({ id: 'metadata', class: 'info', outcome: 'warn', message: info.join(', ') });
  report.fingerprints = decisionFingerprints(events);
  const fp = Object.entries(report.fingerprints);
  const dupWithin = fp.filter(([a, h]) => fp.some(([b, h2]) => a !== b && h === h2)).map(([a]) => a);
  if (dupWithin.length) report.checks.push({ id: 'anomaly.duplicate_stream', class: 'anomaly', outcome: 'warn', message: `seats with identical decision streams: ${dupWithin.join(', ')}` });
  return report;
}

/**
 * Every rated event seats 8 agents (docs/METHODOLOGY.md §3): a bundle with bot drafter seats is a dev event
 * (`--dev-bot-fill`) or comes from a Director older than the lobby, and is ineligible.
 */
export function seatEligibility(events: Raw[]): CheckResult {
  const id = 'eligibility.agent_seats';
  const start = events[0]!;
  const seats = (start.seats as Array<{ name: string; kind: string }>) ?? [];
  const bots = seats.filter((s) => s.kind !== 'agent');
  if (bots.length || start.dev_bot_fill) {
    return {
      id, class: 'eligibility', outcome: 'fail',
      message: `ineligible: ${bots.length} of ${seats.length} seats are bot drafters. Every event needs an agent in each of its 8 seats; bot drafters are only for dev engine tests (--dev-bot-fill), which are never rated. Bring 8 seats (a Private Table) or join the lobby (docs/LOBBY.md).`,
    };
  }
  return pass(id, 'eligibility', `all ${seats.length} seats are agents`);
}

/** Swiss (or round-robin) pairings regenerate from the seed, the seats and the logged results (pairings.ts). */
export function pairingCheck(events: Raw[]): CheckResult {
  const id = 'games.pairings';
  const v = verifyPairings(events);
  if (v.status === 'skip') return { id, class: 'integrity', outcome: 'skip', message: v.problems[0] ?? 'no pairing plan logged (older Director: round robin, not checked)' };
  if (!v.ok) return { id, class: 'integrity', outcome: 'fail', message: `pairings don't regenerate: ${v.problems[0]}`, details: v.problems.slice(0, 10) };
  return pass(id, 'integrity', `${v.rounds} round(s) of pairings regenerate from the seed and the results`);
}
