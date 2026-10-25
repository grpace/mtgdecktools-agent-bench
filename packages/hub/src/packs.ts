/**
 * Pack regeneration (METHODOLOGY §3.1): re-generate every round's boosters from the event seed and set
 * with the Director's own BoosterFactory and Rng (read-only reuse of packages/director) and compare them
 * with the packs the log says were opened.
 *
 * How the Director draws randomness (packages/director/src/event.ts, draft.ts, boosters.ts), all from ONE
 * Rng seeded with event_start.seed:
 *   1. seat positions: rng.shuffle([0..pod-1]); agent i sits at positions[i] (agents in request order, logged as
 *      event_start.agent_order from 2026-10-22: with 8 agents and no bots, only that order makes the check exact)
 *   2. per round: pod × factory.pack(set, rng, swaps)            → logged as packs_opened {round, packs, swaps}
 *   3. per round: every bot pick calls rng.next() once per card in the pack it picks from
 *      (bots pick synchronously, so only the count matters, and the count is in the log: one draft_pick per
 *      bot pick, with the pack contents)
 * Nothing else draws from that Rng before the last round's packs are opened.
 *
 * What else the generator depends on:
 *   - draft-pools.json (MTGJSON booster sheets, shipped inside the phase-server image). Logs since
 *     2026-10-22 name its sha256 (event_start.boosters.draft_pools_sha256): we use a content-addressed
 *     archive copy, or the hub's copy for the pinned engine when the hashes agree. Older logs don't.
 *   - the unsupported-card list (cards swapped out of packs): event_start.boosters.unsupported_sha256 on
 *     newer logs. Older logs only have the swaps, so we can still replay the random stream exactly: every logged `from` is an unsupported card that was
 *     drawn, and the swap consumes exactly one rng.int() whatever the replacement. Only the replacement's
 *     identity depends on the full list. Without it, replacements are checked for plausibility (same sheet,
 *     same rarity, not itself swapped out) and the result is `partial`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BOOSTER_GENERATORS, BoosterFactory, type PackCard } from '../../director/src/boosters.js';
import { BOOSTER_GENERATOR } from '../../director/src/provenance.js';
import { Rng } from '../../director/src/rng.js';

export type RegenStatus = 'verified' | 'partial' | 'mismatch' | 'unverifiable';

export interface RegenResult {
  status: RegenStatus;
  /** Human-readable summary. */
  message: string;
  /** Which mode produced the result: the full unsupported list, or swaps reconstructed from the log. */
  mode?: 'exact' | 'swaps-from-log';
  draft_pools_sha256?: string;
  draft_pools_source?: 'logged' | 'default';
  unsupported_sha256?: string;
  rounds?: number;
  packs_checked?: number;
  /** Swaps whose replacement card could only be checked for plausibility (mode swaps-from-log). */
  swap_targets_unproven?: number;
  seat_positions?: 'verified' | 'mismatch';
  /** First differences found (round, seat, slot, expected, logged). */
  diffs?: Array<{ round: number; seat: number; slot?: number; expected?: string; logged?: string; note?: string }>;
  /** What the log is missing for a full verification. */
  missing?: string[];
}

interface LoggedRound { round: number; packs: string[][]; swaps: Array<{ from: string; to: string }> }

export interface RegenInput {
  seed: string;
  set: string;
  /** Seats in table order (event_start.seats). */
  seats: Array<{ name: string; kind: string; position: number }>;
  rounds: LoggedRound[];
  /** Bot rng draws per round: sum of pack sizes over that round's bot picks. */
  botDraws: Map<number, number>;
  /** Booster provenance (event_start.boosters; absent from logs before 2026-10-22). */
  boosters?: { draft_pools_sha256?: string; unsupported_sha256?: string; generator?: string };
  /** Agent names in request order (event_start.agent_order): agent i must sit at positions[i]. */
  agentOrder?: string[];
}

/** Where the hub finds booster data: a default (pinned engine) plus content-addressed archives. */
export interface BoosterData {
  /** draft-pools.json for the pinned engine build. */
  defaultDraftPools?: string;
  /** unsupported-cards.json ({ unsupported: string[] }) as used by the hosted Director, if known. */
  defaultUnsupported?: string;
  /** Directory of archived files named <sha256>.json (draft pools or unsupported lists). */
  archiveDir?: string;
}

/** The generator id new events use (bumped in the Director with any generator change). */
export const GENERATOR_VERSION = BOOSTER_GENERATOR;
/** Every generator this hub's copy of the Director code can reproduce (older events keep theirs). */
export const KNOWN_GENERATORS: readonly string[] = BOOSTER_GENERATORS;
/** Round-1 slot agreement above which the hub's booster data is taken to be the data the event used. */
export const SAME_DATA_THRESHOLD = 0.9;

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

const fileCache = new Map<string, { sha: string; text: string }>();
/** A file's text and sha256, read once per version (size and mtime: the Director rewrites its unsupported list). */
function readCached(path: string): { sha: string; text: string } {
  const st = statSync(path);
  const key = `${path}\0${st.size}:${st.mtimeMs}`;
  let v = fileCache.get(key);
  if (!v) {
    const text = readFileSync(path, 'utf8');
    v = { sha: sha(text), text };
    for (const k of fileCache.keys()) if (k.startsWith(`${path}\0`)) fileCache.delete(k);
    fileCache.set(key, v);
  }
  return v;
}

function findArchived(dir: string | undefined, digest: string | undefined): string | undefined {
  if (!dir || !digest || !/^[0-9a-f]{64}$/.test(digest)) return undefined;
  const p = join(dir, `${digest}.json`);
  return existsSync(p) ? p : undefined;
}

/**
 * The archive's files by kind, for logs that predate booster provenance (2026-10-22): such a log names neither its
 * draft pools nor its unsupported list, and after an engine upgrade the hub's defaults are the new build's. Every
 * archived version is tried (a few files, cached by size and mtime), so the event still regenerates exactly on the data
 * it ran on. Unsupported lists hold `{"unsupported": [...]}`; anything else is a draft-pools file.
 */
const archiveKinds = new Map<string, { stamp: string; kind: 'pools' | 'unsupported' }>();
export function archivedByKind(dir: string | undefined): { pools: string[]; unsupported: string[] } {
  const out = { pools: [] as string[], unsupported: [] as string[] };
  if (!dir || !existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => /^[0-9a-f]{64}\.json$/.test(x)).sort()) {
    const p = join(dir, f);
    const st = statSync(p);
    const stamp = `${st.size}:${st.mtimeMs}`;
    let hit = archiveKinds.get(p);
    if (hit?.stamp !== stamp) {
      let kind: 'pools' | 'unsupported' = 'pools';
      try {
        kind = Array.isArray((JSON.parse(readCached(p).text) as { unsupported?: unknown }).unsupported) ? 'unsupported' : 'pools';
      } catch {
        continue;
      }
      hit = { stamp, kind };
      archiveKinds.set(p, hit);
    }
    out[hit.kind].push(p);
  }
  return out;
}

/** Every archived file's sha256 (for listing in the README / status endpoint). */
export function archivedDigests(dir: string | undefined): string[] {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^[0-9a-f]{64}\.json$/.test(f)).map((f) => f.slice(0, 64));
}

type SwapFn = (sheet: { cards: Array<{ name: string; rarity: string }> }, c: { name: string; rarity: string }, rng: Rng, swaps: Array<{ from: string; to: string }>, ...rest: unknown[]) => PackCard;

/** Generate one round's packs. In swaps-from-log mode, replacements are forced to the logged ones. */
function generateRound(
  factory: BoosterFactory, set: string, rng: Rng, pod: number, forced: Array<{ from: string; to: string }> | null,
  unproven: { n: number; bad: string[] },
): { packs: string[][]; swaps: Array<{ from: string; to: string }> } {
  const swaps: Array<{ from: string; to: string }> = [];
  const packs: string[][] = [];
  const f = factory as unknown as { supportedOrSwap?: SwapFn };
  const orig = f.supportedOrSwap;
  if (forced) {
    if (typeof orig !== 'function') throw new Error('BoosterFactory internals changed (supportedOrSwap): update packages/hub/src/packs.ts');
    let k = 0;
    f.supportedOrSwap = function (this: BoosterFactory, sheet, c, r, sw, ...rest) {
      const before = sw.length;
      const out = orig.call(this, sheet, c, r, sw, ...rest);
      if (sw.length === before) return out;
      // A swap happened (one rng.int consumed). Use the logged replacement if it is plausible.
      const want = forced[k++];
      if (!want || want.from !== c.name) {
        unproven.bad.push(`swap ${k}: generator swapped out "${c.name}", log says "${want?.from ?? '(none)'}"`);
        return out;
      }
      const alt = sheet.cards.find((x) => x.name === want.to || x.name.split(' // ')[0] === want.to);
      if (!alt || alt.rarity !== c.rarity || forced.some((s) => s.from === alt.name)) {
        unproven.bad.push(`swap ${k}: "${want.to}" is not a ${c.rarity} on the same sheet as "${c.name}" (or is itself unsupported)`);
        return out;
      }
      unproven.n++;
      sw[sw.length - 1] = { from: c.name, to: alt.name };
      return { ...out, name: alt.name.split(' // ')[0]! };
    };
  }
  try {
    for (let i = 0; i < pod; i++) packs.push(factory.pack(set, rng, swaps).map((c) => c.name));
  } finally {
    if (forced) delete f.supportedOrSwap; // back to the prototype method
  }
  return { packs, swaps };
}

function comparePacks(round: number, gen: string[][], logged: string[][], diffs: NonNullable<RegenResult['diffs']>, tally: { same: number; total: number }): boolean {
  let ok = gen.length === logged.length;
  if (!ok) diffs.push({ round, seat: -1, note: `generated ${gen.length} packs, log has ${logged.length}` });
  for (let s = 0; s < Math.min(gen.length, logged.length); s++) {
    const a = gen[s]!;
    const b = logged[s]!;
    if (a.length !== b.length) {
      ok = false;
      diffs.push({ round, seat: s, note: `pack size ${b.length}, expected ${a.length}` });
      continue;
    }
    for (let j = 0; j < a.length; j++) {
      tally.total++;
      if (a[j] === b[j]) tally.same++;
      if (a[j] !== b[j]) {
        ok = false;
        if (diffs.length < 20) diffs.push({ round, seat: s, slot: j, expected: a[j], logged: b[j] });
      }
    }
  }
  return ok;
}

function sameSwaps(a: Array<{ from: string; to: string }>, b: Array<{ from: string; to: string }>): boolean {
  return a.length === b.length && a.every((x, i) => x.from === b[i]!.from && x.to.split(' // ')[0] === b[i]!.to.split(' // ')[0]);
}

function run(inp: RegenInput, factory: BoosterFactory, forcedMode: boolean): {
  ok: boolean; diffs: NonNullable<RegenResult['diffs']>; unproven: number; bad: string[]; positions: 'verified' | 'mismatch';
  /** Share of round-1 slots that regenerated identically (round 1 depends only on seed, seats and sheets). */
  firstRoundMatch: number;
} {
  const pod = inp.seats.length;
  const rng = new Rng(inp.seed);
  const positions = rng.shuffle([...Array(pod).keys()]);
  const agentPositions = inp.seats.filter((s) => s.kind === 'agent').map((s) => s.position).sort((a, b) => a - b);
  const expected = positions.slice(0, agentPositions.length).sort((a, b) => a - b);
  const at = new Map(inp.seats.filter((s) => s.kind === 'agent').map((s) => [s.name, s.position]));
  const order = inp.agentOrder && inp.agentOrder.length === at.size && inp.agentOrder.every((n) => at.has(n)) ? inp.agentOrder : undefined;
  // With the request order logged, each agent's exact seat is checked; without it only the set of agent seats
  // (which says nothing when every seat is an agent).
  const posOk = order
    ? order.every((name, i) => at.get(name) === positions[i])
    : agentPositions.length === expected.length && agentPositions.every((p, i) => p === expected[i]);
  const diffs: NonNullable<RegenResult['diffs']> = [];
  const unproven = { n: 0, bad: [] as string[] };
  let ok = true;
  let firstRoundMatch = 0;
  const rounds = [...inp.rounds].sort((a, b) => a.round - b.round);
  for (const r of rounds) {
    const gen = generateRound(factory, inp.set, rng, pod, forcedMode ? r.swaps : null, unproven);
    const tally = { same: 0, total: 0 };
    if (!comparePacks(r.round, gen.packs, r.packs, diffs, tally)) ok = false;
    if (r === rounds[0]) firstRoundMatch = tally.total ? tally.same / tally.total : 0;
    if (!sameSwaps(gen.swaps, r.swaps)) {
      ok = false;
      if (diffs.length < 20) diffs.push({ round: r.round, seat: -1, note: `swaps differ: generated ${gen.swaps.length}, logged ${r.swaps.length}` });
    }
    // Bots' tie-break noise between this round's packs and the next.
    const draws = inp.botDraws.get(r.round) ?? 0;
    for (let i = 0; i < draws; i++) rng.next();
  }
  if (unproven.bad.length) ok = false;
  return { ok, diffs, unproven: unproven.n, bad: unproven.bad, positions: posOk ? 'verified' : 'mismatch', firstRoundMatch };
}

/**
 * Regenerate and compare. Never throws: anything that prevents a verdict is `unverifiable` with a reason.
 */
export function regeneratePacks(inp: RegenInput, data: BoosterData): RegenResult {
  const missing: string[] = [];
  if (!inp.seed) return { status: 'unverifiable', message: 'event_start has no seed', missing: ['event_start.seed'] };
  if (!inp.rounds.length) return { status: 'unverifiable', message: 'no packs_opened records', missing: ['packs_opened'] };
  if (inp.boosters?.generator && !KNOWN_GENERATORS.includes(inp.boosters.generator)) {
    return { status: 'unverifiable', message: `unknown booster generator "${inp.boosters.generator}" (hub knows ${KNOWN_GENERATORS.join(', ')})` };
  }
  if (!inp.boosters?.generator) missing.push('event_start.boosters.generator');
  // Logs before generator ids ran the first one.
  const generator = inp.boosters?.generator ?? 'boosters-v1';

  // Booster sheets.
  let poolsPath: string | undefined;
  let poolsSource: 'logged' | 'default' = 'default';
  const loggedPools = inp.boosters?.draft_pools_sha256;
  if (loggedPools) {
    poolsPath = findArchived(data.archiveDir, loggedPools);
    if (!poolsPath && data.defaultDraftPools && existsSync(data.defaultDraftPools) && readCached(data.defaultDraftPools).sha === loggedPools) poolsPath = data.defaultDraftPools;
    if (!poolsPath) {
      return { status: 'unverifiable', message: `booster data ${loggedPools.slice(0, 12)} is not in the hub's archive`, draft_pools_sha256: loggedPools, draft_pools_source: 'logged' };
    }
    poolsSource = 'logged';
  } else {
    missing.push('event_start.boosters.draft_pools_sha256');
    poolsPath = data.defaultDraftPools && existsSync(data.defaultDraftPools) ? data.defaultDraftPools : undefined;
    if (!poolsPath) return { status: 'unverifiable', message: 'the hub has no booster data (HUB_DRAFT_POOLS)', missing };
  }
  const poolsSha = readCached(poolsPath).sha;

  // Unsupported list: exact when known (logged sha found, or the hub's default reproduces the log).
  const loggedUnsupported = inp.boosters?.unsupported_sha256;
  if (!loggedUnsupported) missing.push('event_start.boosters.unsupported_sha256');
  const unsupportedPath = loggedUnsupported
    ? findArchived(data.archiveDir, loggedUnsupported) ?? (data.defaultUnsupported && existsSync(data.defaultUnsupported) && readCached(data.defaultUnsupported).sha === loggedUnsupported ? data.defaultUnsupported : undefined)
    : data.defaultUnsupported && existsSync(data.defaultUnsupported) ? data.defaultUnsupported : undefined;

  const base: RegenResult = {
    status: 'unverifiable', message: '', draft_pools_sha256: poolsSha, draft_pools_source: poolsSource, rounds: inp.rounds.length,
    packs_checked: inp.rounds.reduce((n, r) => n + r.packs.length, 0), ...(missing.length ? { missing } : {}),
  };

  try {
    if (!loggedPools || !loggedUnsupported) {
      // A log from before booster provenance: try every archived data version too (the defaults first), and take
      // the one that regenerates every pack and swap exactly.
      const arch = archivedByKind(data.archiveDir);
      const poolsTry = loggedPools ? [poolsPath] : [...new Set([poolsPath, ...arch.pools])];
      const unsupTry = loggedUnsupported ? (unsupportedPath ? [unsupportedPath] : []) : [...new Set([...(unsupportedPath ? [unsupportedPath] : []), ...arch.unsupported])];
      for (const pp of poolsTry) {
        for (const up of unsupTry) {
          if (pp === poolsPath && up === unsupportedPath) continue; // tried below, with its own messages
          const list = (JSON.parse(readCached(up).text) as { unsupported?: string[] }).unsupported ?? [];
          let hit: ReturnType<typeof run>;
          try {
            hit = run(inp, new BoosterFactory(pp, list, generator), false);
          } catch {
            continue;
          }
          if (hit.ok && hit.positions === 'verified') {
            return { ...base, status: 'verified', mode: 'exact', draft_pools_sha256: readCached(pp).sha, unsupported_sha256: readCached(up).sha, seat_positions: hit.positions,
              message: 'every pack and swap regenerated exactly (booster data matched in the archive: the log predates booster provenance)' };
          }
        }
      }
    }
    if (unsupportedPath) {
      const list = (JSON.parse(readCached(unsupportedPath).text) as { unsupported?: string[] }).unsupported ?? [];
      const exact = run(inp, new BoosterFactory(poolsPath, list, generator), false);
      if (exact.ok) {
        return { ...base, status: exact.positions === 'verified' ? 'verified' : 'mismatch', mode: 'exact', unsupported_sha256: readCached(unsupportedPath).sha, seat_positions: exact.positions,
          message: exact.positions === 'verified' ? 'every pack and swap regenerated exactly' : 'packs match but agent seat positions do not follow the seed' };
      }
      if (loggedUnsupported) {
        // The log named this exact list, so a difference is real.
        return { ...base, status: 'mismatch', mode: 'exact', unsupported_sha256: loggedUnsupported, seat_positions: exact.positions, diffs: exact.diffs, message: 'regenerated packs differ from the log' };
      }
    }
    const fromLog = [...new Set(inp.rounds.flatMap((r) => r.swaps.map((s) => s.from)))];
    const rec = run(inp, new BoosterFactory(poolsPath, fromLog, generator), true);
    const swapsTotal = inp.rounds.reduce((n, r) => n + r.swaps.length, 0);
    if (rec.ok && rec.positions === 'verified') {
      return {
        ...base, status: swapsTotal ? 'partial' : 'verified', mode: 'swaps-from-log', seat_positions: rec.positions, swap_targets_unproven: rec.unproven,
        message: swapsTotal
          ? `every pack regenerated; ${rec.unproven} replacement(s) for unsupported cards are plausible but unproven (unsupported-card list not logged)`
          : 'every pack regenerated exactly (no unsupported-card swaps)',
      };
    }
    const why = rec.bad.length ? rec.bad.slice(0, 5) : [];
    if (poolsSource === 'logged' && rec.positions === 'verified' && !rec.bad.length) {
      return { ...base, status: 'mismatch', mode: 'swaps-from-log', seat_positions: rec.positions, diffs: rec.diffs, message: 'regenerated packs differ from the log (booster data matched by sha256)' };
    }
    if (rec.positions === 'mismatch' && poolsSource === 'logged') {
      return { ...base, status: 'mismatch', mode: 'swaps-from-log', seat_positions: rec.positions, diffs: rec.diffs, message: 'agent seat positions do not follow the seed' };
    }
    // The booster data version isn't logged. If round 1 (seed + seats + sheets only) regenerates almost
    // entirely, the hub evidently has the right sheets, so the remaining differences are edits.
    if (rec.firstRoundMatch >= SAME_DATA_THRESHOLD && rec.positions === 'verified') {
      return {
        ...base, status: 'mismatch', mode: 'swaps-from-log', seat_positions: rec.positions, diffs: rec.diffs,
        message: `regenerated packs differ from the log (${Math.round(rec.firstRoundMatch * 100)}% of round 1 regenerates, so the booster data is the same)${why.length ? `: ${why.join('; ')}` : ''}`,
      };
    }
    // Otherwise a difference may be tampering or a different engine build's sheets.
    return {
      ...base, status: 'unverifiable', mode: 'swaps-from-log', seat_positions: rec.positions, diffs: rec.diffs,
      message: `regenerated packs differ from the log, but the log does not say which booster data was used (hub has ${poolsSha.slice(0, 12)})${why.length ? `: ${why.join('; ')}` : ''}`,
    };
  } catch (e) {
    return { ...base, status: 'unverifiable', message: `regeneration failed: ${(e as Error).message}` };
  }
}

/** Build the regeneration input from parsed log records. */
export function regenInputFromLog(events: Array<Record<string, unknown> & { type: string }>): RegenInput | null {
  const start = events.find((e) => e.type === 'event_start');
  if (!start) return null;
  const set = (start.set as { code?: string } | undefined)?.code ?? '';
  const rounds: LoggedRound[] = events.filter((e) => e.type === 'packs_opened').map((e) => ({
    round: Number(e.round), packs: (e.packs as string[][]) ?? [], swaps: (e.swaps as Array<{ from: string; to: string }>) ?? [],
  }));
  const botDraws = new Map<number, number>();
  for (const e of events) {
    if (e.type !== 'draft_pick' || e.by !== 'bot') continue;
    const r = Number(e.pack_number);
    botDraws.set(r, (botDraws.get(r) ?? 0) + ((e.pack as unknown[]) ?? []).length);
  }
  return {
    seed: typeof start.seed === 'string' ? start.seed : '',
    set: set.toLowerCase(),
    seats: ((start.seats as Array<{ name: string; kind: string; position: number }>) ?? []).map((s) => ({ name: s.name, kind: s.kind, position: s.position })),
    rounds,
    botDraws,
    boosters: start.boosters as RegenInput['boosters'],
    ...(Array.isArray(start.agent_order) ? { agentOrder: (start.agent_order as unknown[]).map(String) } : {}),
  };
}
