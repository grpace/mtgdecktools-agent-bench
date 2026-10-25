/**
 * Methodology layer (docs/METHODOLOGY.md): seat identities, conditions and comparability groups,
 * context-aware and hindsight draft metrics, build checks, diagnostics per identity, and the rating boards with their
 * outcomes (outcomes.ts), cost (cost.ts), diagnostics context (diagnostics.ts) and summary (summary.ts).
 */
import { BASICS, type CardDb, type Deck, type EventData, type Game, type Pick, type Ratings, rating as cardRating } from './data.js';
import { archetypeValue, normPair, type ArchetypeRatings, type ExpertPick } from './inputs.js';
import { seatBuildQuality, type DeckNorms, type SeatBuildQuality } from './build-quality.js';
import { evaluateDraft, median, seatColors } from './metrics.js';
import { colorFlow, deckRoles, flowAlignment, onColorPicks, pairChanges, pairNormOf, type DeckRoles, type Flow } from './core-draft.js';
import { createHash } from 'node:crypto';
import {
  clusterBootstrap, quantile, DEFAULT_RATING_OPTIONS, ELO_CENTER, expectedScore, rankRangesFromPairs, rateGames, seedOf, type PairDiff, type RatingGame, type RatingOptions,
} from './rating.js';
import type {
  Board, BoardRow, BuildStage, Conditions, CoreDraftStage, DraftStage, EfficiencyStage, Est, GroupInfo, IdentityInfo, LogsReadBy, ManaStage, ModelVerification, PlayStage,
  RatingStatus, ReliabilityStage, SeatModelVerification, SourceLabel, Diagnostics, VersionDifference,
} from './schema.js';
import { RATING_STATUS_LABELS } from './schema.js';
import { outcomesOf, pairwise, rankRanges, swissFinishes } from './outcomes.js';
import { costInfo } from './cost.js';
import { boardDiagnostics } from './diagnostics.js';
import { asOfDate, boardSummary, provisionalRule } from './summary.js';
import { holm, pFromInterval } from './multiplicity.js';
import { identityKey, isConcreteEffort, registry, slugOf, type ModelEntry, type Registry, type ResolvedEffort, type UsageLike } from '../../registry/src/index.js';

/** Harness display names (registry/harnesses.json). Kept for older importers; prefer registry.harnessDisplay. */
export const HARNESS_LABELS: Record<string, string> = Object.fromEntries(registry.harnesses.map((h) => [h.id, h.display]));

// ---------------------------------------------------------------------------
// Seat identity: canonical model + canonical effort (METHODOLOGY §2, registry/README.md). The harness is resolved per
// seat (effort detection, the model check, seat details) and never part of the key.

export interface SeatIdentity {
  key: string;
  harness: string;
  model: string;
  /** The model name as declared (raw, from the log). */
  alias: string;
  effort: string;
  /** The harness usage showed the declared model (Checked Against Logs). */
  verified: boolean;
  verification: SeatModelVerification;
  /** Model and harness are in the registry. */
  listed: boolean;
  /** Counts in ratings and diagnostics: listed, not a Mismatch, not a test harness. */
  rated: boolean;
  modelEntry?: ModelEntry;
  /** How the effort part of the key was decided (METHODOLOGY §2.1). */
  effortInfo?: ResolvedEffort;
  /** The app that started the harness (t3-code): seat details only, never part of the key (METHODOLOGY §2.3). */
  launcher?: string;
}

/**
 * Seat identities, resolved at export time from the raw strings in the immutable logs, so a registry fix (a new
 * alias, a newly listed model) merges or rates old rows at the next export. The model a seat declared
 * (`model_declared`, else `model`, else, in the earliest logs, a seat name the registry knows: data.ts seatModel) is resolved with the registry as
 * of the event's start date; the harness usage (usage-<seat>.json, else the transcript) verifies it.
 */
export class Identities {
  readonly info = new Map<string, IdentityInfo>();
  private cache = new Map<string, SeatIdentity>();
  private seen = new Map<string, Set<string>>(); // identity key → "event|seat" already counted in info

  constructor(_events: EventData[] = [], private reg: Registry = registry) {}

  of(ev: EventData, seat: string): SeatIdentity {
    const ck = `${ev.id}|${seat}`;
    const hit = this.cache.get(ck);
    if (hit) return hit;
    const s = ev.seats.find((x) => x.name === seat);
    const at = ev.startT;
    const rawHarness = harnessOf(ev, seat);
    const h = this.reg.resolveHarness(rawHarness);
    const harness = h.ok ? h.id : rawHarness === 'unknown' ? 'unknown' : slugOf(rawHarness);
    const alias = aliasOf(ev, seat);
    const m = this.reg.resolveModel(alias, h.ok ? h.id : undefined, { at });
    const model = m.ok ? m.id : `unlisted:${slugOf(alias)}`;
    // A level in the model name ("gemini-4-argon-high", "#high") fills in for a missing, "default" or "unknown" effort,
    // as at event creation (resolveSeat); a concrete declared level stays (creation refuses one that disagrees).
    const declaredEffort = s?.effortDeclared ?? s?.effort;
    const declaredLevel = declaredEffort ? this.reg.normalizeEffort(declaredEffort) : undefined;
    const rawEffort = m.ok && m.effortHint && !(declaredLevel?.ok && isConcreteEffort(declaredLevel.effort)) && declaredLevel?.ok !== false ? m.effortHint : declaredEffort;
    const e = this.reg.normalizeEffort(rawEffort, m.ok ? m.model : undefined, h.ok ? h.harness : undefined);
    const test = h.ok && h.harness.kind === 'test';
    const listed = h.ok && m.ok && e.ok;
    const usage = usageOf(ev, seat);
    // Effort: detected from the harness logs, else as declared, else the documented harness default, else Unknown.
    const uf = ev.usage?.get(seat);
    const effortInfo = listed && !test
      ? this.reg.resolveSeatEffort({
        // The raw harness keeps a launcher ("t3-code:claude-code"): a level picked in it counts as set explicitly.
        harness: h.ok && h.launcher ? rawHarness : harness, model, at, declared: rawEffort, ...(s?.effortBasis ? { basis: s.effortBasis } : {}),
        detected: uf?.effort_reported ?? null, harnessVersion: uf?.harness_version ?? ev.transcripts.get(seat)?.harnessVersion,
      })
      : undefined;
    const effort = effortInfo ? effortInfo.effort : e.ok ? (test ? 'default' : 'unknown') : `unlisted:${slugOf(rawEffort ?? '')}`;
    let verification: SeatModelVerification;
    if (!listed) {
      const what = !h.ok ? `harness "${rawHarness}"` : !m.ok ? `model "${alias}"` : `effort "${rawEffort}" for ${m.ok ? m.model.display : alias}`;
      verification = { status: 'unlisted', reason: `${what} isn't in the registry (registry/README.md): unrated until it is` };
    } else {
      verification = this.reg.verifySeatModel({ model: alias, harness, at }, usage.usage);
    }
    verification = { ...verification, label: VERIFICATION_LABELS[verification.status], logs_read_by: verification.status === 'unlisted' ? null : usage.readBy };
    const id: SeatIdentity = {
      key: identityKey(model, effort), harness, model, alias, effort, verification, listed,
      verified: verification.status === 'verified',
      rated: listed && !test && verification.status !== 'mismatch',
      ...(m.ok ? { modelEntry: m.model } : {}),
      ...(effortInfo ? { effortInfo } : {}),
      ...(h.ok && h.launcher ? { launcher: h.launcher.id } : {}),
    };
    this.cache.set(ck, id);
    this.note(ev, seat, id);
    return id;
  }

  launcherDisplay(id: string): string {
    return this.reg.launcherDisplay(id);
  }

  /** A seat's harness as shown ("Harness Not Recorded" for logs that never named one). */
  harnessDisplay(id: string): string {
    return harnessDisplay(id, this.reg);
  }

  private note(ev: EventData, seat: string, id: SeatIdentity): void {
    const seen = this.seen.get(id.key) ?? new Set<string>();
    this.seen.set(id.key, seen);
    if (seen.has(`${ev.id}|${seat}`)) return;
    seen.add(`${ev.id}|${seat}`);
    let info = this.info.get(id.key);
    if (!info) {
      const provider = id.modelEntry?.provider ?? null;
      info = {
        key: id.key, model: id.model, model_aliases: [], model_verified: true, effort: id.effort,
        label: `${id.modelEntry?.display ?? id.alias} · ${this.reg.effortDisplay(id.effort)}`,
        model_id: id.model, model_display: id.modelEntry?.display ?? id.alias, provider, provider_display: provider ? this.reg.providerDisplay(provider) : null,
        effort_display: this.reg.effortDisplay(id.effort), harnesses: [],
        verification_counts: {}, rated: false,
      };
      this.info.set(id.key, info);
    }
    // 2.20: the harnesses its seats ran on (most seats first): a seat detail, never a separate row.
    const hs = info.harnesses!;
    const hrow = hs.find((x) => x.id === id.harness);
    if (hrow) hrow.seats++;
    else hs.push({ id: id.harness, display: harnessDisplay(id.harness, this.reg), seats: 1 });
    hs.sort((a, b) => b.seats - a.seats || a.id.localeCompare(b.id));
    if (!info.model_aliases.includes(id.alias)) info.model_aliases.push(id.alias);
    const c = info.verification_counts!;
    c[id.verification.status] = (c[id.verification.status] ?? 0) + 1;
    const statuses = Object.keys(c) as ModelVerification[];
    info.model_verification = statuses.length === 1 ? statuses[0]! : 'mixed';
    info.model_verification_label = VERIFICATION_LABELS[info.model_verification];
    info.model_verified = statuses.length === 1 && statuses[0] === 'verified';
    info.rated ||= id.rated;
    if (id.effortInfo) {
      const es = (info.effort_sources ??= {});
      es[id.effortInfo.source] = (es[id.effortInfo.source] ?? 0) + 1;
      const ev2 = (info.effort_verification_counts ??= {});
      ev2[id.effortInfo.status] = (ev2[id.effortInfo.status] ?? 0) + 1;
    }
    if (id.verification.snapshot) {
      info.snapshots ??= [];
      if (!info.snapshots.includes(id.verification.snapshot)) info.snapshots.push(id.verification.snapshot);
      if (id.verification.snapshot_known === false) info.unknown_snapshot = true;
    }
  }
}

/** Registry display name; logs that never recorded a harness, and give no other sign of one, show "Harness Not Recorded". */
export const HARNESS_NOT_RECORDED = 'Harness Not Recorded';
const harnessDisplay = (id: string, reg: Registry): string => (id === 'unknown' ? HARNESS_NOT_RECORDED : reg.harnessDisplay(id));

/** When the bench CLI (and with it launchers for other harnesses) arrived: commit 445237b. */
const BENCH_CLI_AT = Date.parse('2026-10-21T23:36:07Z');

/**
 * The harness a seat ran on: as the log declares it, else from the logs themselves. A Claude Code transcript next to
 * the log says Claude Code. Before the bench CLI the only launcher was scripts/play-claude-seat.sh, the only writer of
 * transcript-<seat>.jsonl, so then the file alone says it, even empty (the transcripts lost on 2026-10-21, when the
 * launcher was edited mid-run, left empty files). No declaration and no transcript: "unknown".
 */
export function harnessOf(ev: EventData, seat: string): string {
  const s = ev.seats.find((x) => x.name === seat);
  const tr = ev.transcripts.get(seat);
  return s?.harnessDeclared ?? s?.harness ?? (tr && (tr.lines > 0 || ev.startT < BENCH_CLI_AT) ? 'claude-code' : 'unknown');
}

/** The model as declared: the raw string when the Director resolved it, else what the log carries (oldest logs: a registry-checked seat name, seatModel). */
function aliasOf(ev: EventData, seat: string): string {
  const s = ev.seats.find((x) => x.name === seat);
  return (s?.modelDeclared ?? s?.modelHint ?? s?.modelId ?? s?.model ?? seat).trim();
}

/** Display labels of the model check (METHODOLOGY §2.1). The status codes are kept for compatibility. */
export const VERIFICATION_LABELS: Record<ModelVerification | 'mixed', string> = {
  verified: 'Checked Against Logs', 'self-reported': 'Self-Reported', mismatch: 'Mismatch', unlisted: 'Unlisted', mixed: 'Mixed',
};

/**
 * Harness usage for the model check, and who read the harness logs: `contributor-cli` when usage-<seat>.json was
 * written on the contributor's machine (the bench CLI or the bundle tool), `export` when the export read a harness
 * transcript the contributor submitted. Both are contributor-supplied: nothing stronger exists yet.
 */
function usageOf(ev: EventData, seat: string): { usage: UsageLike | null; readBy: LogsReadBy | null } {
  const u = ev.usage?.get(seat);
  if (u && ((u.model_ids?.length ?? 0) > 0 || Object.keys(u.model_output_tokens ?? {}).length > 0)) return { usage: u, readBy: 'contributor-cli' };
  const tr = ev.transcripts.get(seat);
  if (tr && (tr.model || tr.modelOutputTokens)) {
    return {
      usage: { model_ids: [...new Set([...(tr.model ? [tr.model] : []), ...Object.keys(tr.modelOutputTokens ?? {})])], ...(tr.modelOutputTokens ? { model_output_tokens: tr.modelOutputTokens } : {}) },
      readBy: 'export',
    };
  }
  return { usage: u ?? null, readBy: u ? 'contributor-cli' : null };
}

// ---------------------------------------------------------------------------
// Contributors: who seated each seat (METHODOLOGY §3.1)

/** How a seat's contributor was established. */
export type ContributorVia = 'uploader' | 'lobby-seat' | 'organizer' | 'admin' | 'unattributed';

export interface SeatContributor {
  /** Opaque, stable key (a salted hash of the Hub id or the uploader), or "admin" / "unattributed". */
  key: string;
  /** Public handle, only for a contributor known to be public now (`isPublic`); null otherwise. */
  handle: string | null;
  via: ContributorVia;
}

/**
 * Whether a Hub contributor (by Hub id) is public right now. The Hub passes its current setting (account choice, else
 * latest lobby choice) to the export; anywhere else nothing is known to be public. A log keeps the handle a lobby seat
 * showed when it was written, so without this a contributor who hid later would still be named.
 */
export type ContributorPublic = (hubContributorId: string) => boolean;

/** Salted so the export never carries Hub ids (set MTGDT_CONTRIBUTOR_SALT on hosted exports). */
const contributorKey = (raw: string): string => `c-${createHash('sha256').update(`${process.env.MTGDT_CONTRIBUTOR_SALT ?? 'mtgdt'}\u0000${raw}`).digest('hex').slice(0, 12)}`;

/**
 * The contributor behind a seat, from what the logs and the Hub record (the Hub's attribution rule):
 * community uploads → the uploader, whatever the log says; hosted lobby seats → event_start.seats[].contributor_id;
 * a hosted Private Table → event_start.organizer.contributor_id; admin events → "admin"; older logs → "unattributed".
 */
export function contributorOf(ev: EventData, seat: string, isPublic?: ContributorPublic): SeatContributor {
  // A handle from the logs only when the Hub says that contributor is public now (never by default).
  const shown = (id: string | undefined, handle: string | undefined): string | null => (id && handle && isPublic?.(id) ? handle : null);
  if (ev.source.label === 'community' && (ev.source.submitterId || ev.source.submitter)) {
    return { key: contributorKey(ev.source.submitterId ? `hub:${ev.source.submitterId}` : `upload:${ev.source.submitter}`), handle: shown(ev.source.submitterId, ev.source.submitter), via: 'uploader' };
  }
  const s = ev.seats.find((x) => x.name === seat);
  if (s?.contributorId) return { key: contributorKey(`hub:${s.contributorId}`), handle: shown(s.contributorId, s.contributorHandle), via: 'lobby-seat' };
  if (ev.organizer?.kind === 'contributor' && ev.organizer.contributorId) return { key: contributorKey(`hub:${ev.organizer.contributorId}`), handle: null, via: 'organizer' };
  if (ev.organizer?.kind === 'admin') return { key: 'admin', handle: null, via: 'admin' };
  return { key: 'unattributed', handle: null, via: 'unattributed' };
}

// ---------------------------------------------------------------------------
// Conditions and comparability groups

export function conditionsOf(ev: EventData): Conditions {
  const primer = ev.knowledge?.primer;
  return {
    set: ev.set.code.toUpperCase(),
    knowledge: ev.knowledge?.level ?? null,
    mana: ev.mana ?? null,
    best_of: ev.bestOf,
    sideboarding: ev.sideboarding === true,
    prompt_version: ev.promptVersion ?? null,
    prompt_sha256: ev.promptSha256 ?? null,
    prompt_key: promptKey(ev),
    engine: ev.provenance?.engine ?? null,
    director: ev.provenance?.director ?? null,
    primer_sha256: primer && typeof primer === 'object' ? ((primer as { sha256?: string }).sha256 ?? null) : null,
  };
}

/** Display label of early test data (EventSummary.test_data_label). */
export const EARLY_TEST_DATA_LABEL = 'Early Test Data';

/**
 * Early test data: an LLM event played before the benchmark standardized on best of 3 with sideboarding (best of 1,
 * or best of 3 without `event_start.sideboarding`). Visible everywhere (event pages, replays, exports) but never rated,
 * never on a board or diagnostic and never counted as rated games; labeled "Early Test Data". Smoke and dev events
 * keep their own labels (undefined here). Returns the unrated reason.
 */
export function earlyTestData(ev: { devBotFill?: boolean; seats: Array<{ llm: boolean }>; source: { label: string }; bestOf: number; sideboarding?: boolean }): string | undefined {
  if (ev.devBotFill || !ev.seats.some((s) => s.llm) || ev.source.label === 'smoke') return undefined;
  if (ev.bestOf !== 3) return `early test data (best of ${ev.bestOf})`;
  if (!ev.sideboarding) return 'early test data (best of 3 without sideboarding)';
  return undefined;
}

/** Why an event is not pooled into any rating or diagnostic, or undefined when it is. */
export function unratedReason(ev: EventData): string | undefined {
  if (ev.devBotFill) return 'dev event (bot drafters at the table)';
  if (!ev.seats.some((s) => s.llm)) return 'smoke test (no LLM seats)';
  if (ev.source.label === 'smoke') return 'labeled smoke';
  if (ev.source.exclude) return `excluded: ${ev.source.exclude}`;
  // Only best of 3 with sideboarding is rated (from 2026-10-22); earlier tables stay visible as Early Test Data.
  const early = earlyTestData(ev);
  if (early) return early;
  // A table with any scripted or bot seat is a test table (an operator's check), never a product event: no rating
  // group, no rated game, no Swiss finish, whatever its format (critic round 3). Every rated table is 8 LLM seats.
  const scripted = ev.seats.filter((s) => !s.llm).length;
  if (scripted) return `test table (${scripted} scripted ${scripted === 1 ? 'seat' : 'seats'})`;
  // Live events are for spectating. A finished, stopped or stalled event is rated: its finished games are results, so
  // stopping a table can't erase the games already played (METHODOLOGY §3.2 "Stopped events"); unplayed games aren't.
  if (ev.status === 'in-progress') return 'in progress (rated when it finishes)';
  const c = conditionsOf(ev);
  const missing = [c.knowledge == null && 'knowledge level', c.mana == null && 'mana mode', c.prompt_key == null && 'prompt version'].filter(Boolean);
  if (missing.length) return `conditions not logged (${missing.join(', ')})`;
  return undefined;
}

/**
 * The prompts an event ran with, for grouping: a fingerprint of the prompt files' content (`event_start.prompt_sha256`,
 * first 12 hex digits), else, for logs from before the hash was recorded, the prompts folder name. Never shown.
 */
export function promptKey(ev: EventData): string | null {
  if (ev.promptSha256) return `sha256:${ev.promptSha256.slice(0, 12)}`;
  return ev.promptVersion ?? null;
}

/**
 * Comparability group key: `kn=<knowledge>;mana=<mana>;prompt=<prompt key>`. Groups don't split on best-of: only best
 * of 3 with sideboarding is rated at all (earlier keys carried `bo=<n>`; normalizeGroupKey reads them).
 */
export function groupKey(ev: EventData): string | null {
  if (unratedReason(ev)) return null;
  const c = conditionsOf(ev);
  return `kn=${c.knowledge};mana=${c.mana};prompt=${c.prompt_key}`;
}

/** A group key as written today: drops the `bo=<n>` part of keys written before 2.13 (stored rows, old URLs). */
export function normalizeGroupKey(key: string): string {
  return key.split(';').filter((kv) => !/^bo=/.test(kv)).join(';');
}

/** The parts of a group key (old keys with `bo=` included): knowledge, mana and prompt key. */
export function parseGroupKey(key: string): { knowledge: string; mana: string; prompt: string | undefined } {
  const p = Object.fromEntries(key.split(';').map((kv) => { const i = kv.indexOf('='); return i < 0 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)]; }));
  return { knowledge: p.kn ?? '', mana: p.mana ?? '', prompt: p.prompt };
}

/**
 * The main condition (METHODOLOGY §3): Set Context, manual mana, with the current prompts (the newest prompt
 * fingerprint among events under these conditions). Every other group is a side board. Every rated event is best of 3
 * with sideboarding, so best_of (always 3) is descriptive and not tested.
 */
export const MAIN_CONDITION = { knowledge: 'primer', mana: 'manual', best_of: 3, sideboarding: true } as const;

export const isMainCondition = (c: { knowledge: string | null; mana: string | null }): boolean =>
  c.knowledge === MAIN_CONDITION.knowledge && c.mana === MAIN_CONDITION.mana;

/** Display labels for the knowledge levels (the config keys `primer` / `primer+stats` are historical). */
export const KNOWLEDGE_LABEL: Record<string, string> = { none: 'No Set Context', primer: 'Set Context', 'primer+stats': 'Set Context + Human Stats' };

/**
 * Display label of a comparability group: "Set Context · Manual Mana". Labels never carry a prompt version (groups
 * that differ only by prompts get "Earlier Prompt" on all but the newest, buildBoards) or a best-of (every rated event
 * is best of 3 with sideboarding).
 */
export function groupLabel(c: { knowledge: string; mana: string; best_of?: number; prompt_version?: string }): string {
  return `${KNOWLEDGE_LABEL[c.knowledge] ?? c.knowledge} · ${c.mana === 'auto' ? 'Automatic Mana' : c.mana === 'manual' ? 'Manual Mana' : c.mana}`;
}

/** The conditions in a sentence: "Set Context", "No Set Context with automatic mana". */
export function conditionsText(c: { knowledge: string | null; mana: string | null }): string {
  const extra = [c.mana === 'auto' ? 'automatic mana' : null].filter(Boolean);
  return `${KNOWLEDGE_LABEL[c.knowledge ?? ''] ?? c.knowledge ?? 'unknown conditions'}${extra.length ? ` with ${extra.join(', ')}` : ''}`;
}

export function engineLabel(c: Conditions): string | null {
  const e = c.engine;
  if (!e) return null;
  return [e.server_version, e.protocol_version != null ? `protocol ${e.protocol_version}` : undefined].filter(Boolean).join(' / ') || null;
}

// ---------------------------------------------------------------------------
// Draft: context-aware and hindsight metrics for one seat

const OFF_PAIR_QUANTILE = 0.1; // value of a pick with no data in the pair: the pair's 10th-percentile card ("replacement level")
const LOG_P_FLOOR = 1e-4;

export interface PickContext {
  overall: number;
  arch?: { pair: string; picked: number | null; best: { name: string; value: number } | null; regret: number | null };
  archCurrent?: number; // regret vs the pair inferred from picks so far
  expert?: ExpertPick;
}

export interface DraftContext {
  seat: string;
  pair: string; // main color pair of the final deck ("" if unknown)
  conversion: number[]; // 0/1 per non-forced, non-basic pick
  p1Conversion: number[];
  commitmentPick?: number;
  /** Human reference: open colors by 17Lands GIH WR (sets with win-rate data). */
  signalAlignment?: number;
  openColors?: string;
  /** Core (every set): color flow by card quality, its alignment with the final colors, on-color picks, pair changes, deck roles. */
  flow?: Flow;
  flowAlignment?: number;
  onColor: number[];
  pairChanges?: number;
  roles?: DeckRoles;
  archRegret: number[];
  archCurrentRegret: number[];
  expert: ExpertPick[];
  picks: Map<Pick, PickContext>;
}

const overallOf = (p: Pick): number => p.overallPick ?? (p.packNumber - 1) * 14 + p.pickNumber;

/** The deck's two main colors: colors with ≥ 2 non-land cards that need them, the two most common. */
export function mainPair(deck: Deck | undefined, cards: CardDb): string {
  if (!deck || !cards.loaded) return '';
  const count: Record<string, number> = {};
  for (const n of deck.main) {
    if (cards.isLand(n)) continue;
    for (const c of cards.requiredColors(n)) count[c] = (count[c] ?? 0) + 1;
  }
  return normPair(
    Object.entries(count)
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1] || 'WUBRG'.indexOf(a[0]) - 'WUBRG'.indexOf(b[0]))
      .slice(0, 2)
      .map(([c]) => c)
      .join(''),
  );
}

function pairOfPicks(picks: Pick[], cards: CardDb): string {
  const count: Record<string, number> = {};
  for (const p of picks) {
    if (cards.isLand(p.pick)) continue;
    for (const c of cards.requiredColors(p.pick)) count[c] = (count[c] ?? 0) + 1;
  }
  return normPair(
    Object.entries(count)
      .sort((a, b) => b[1] - a[1] || 'WUBRG'.indexOf(a[0]) - 'WUBRG'.indexOf(b[0]))
      .slice(0, 2)
      .map(([c]) => c)
      .join(''),
  );
}

function replacementLevel(arch: ArchetypeRatings, pair: string, cache: Map<string, number | undefined>): number | undefined {
  if (cache.has(pair)) return cache.get(pair);
  const m = arch.pairs.get(pair);
  const vals = m ? [...m.values()].filter((v) => v.games == null || v.games >= arch.minGames).map((v) => v.gih).sort((a, b) => a - b) : [];
  const v = vals.length ? quantile(vals, OFF_PAIR_QUANTILE) : undefined;
  cache.set(pair, v);
  return v;
}

function archRegretFor(p: Pick, pair: string, arch: ArchetypeRatings, cache: Map<string, number | undefined>): PickContext['arch'] {
  let best: { name: string; value: number } | null = null;
  for (const c of p.contents) {
    const v = archetypeValue(arch, pair, c);
    if (v != null && (!best || v > best.value)) best = { name: c, value: v };
  }
  if (!best) return { pair, picked: null, best: null, regret: null };
  const pickedRaw = archetypeValue(arch, pair, p.pick);
  const picked = pickedRaw ?? replacementLevel(arch, pair, cache) ?? null;
  return { pair, picked: pickedRaw ?? null, best, regret: picked == null ? null : Math.max(0, best.value - picked) * 100 };
}

export function draftContext(ev: EventData, seat: string, cards: CardDb, ratings: Ratings | null, arch: ArchetypeRatings | null, norms?: DeckNorms | null): DraftContext {
  const mine = ev.picks.filter((p) => p.seat === seat).sort((a, b) => overallOf(a) - overallOf(b));
  const deck = ev.decks.get(seat);
  const pair = mainPair(deck, cards);
  const finalColors = seatColors(ev, seat, cards);
  const ctx: DraftContext = { seat, pair, conversion: [], p1Conversion: [], onColor: [], archRegret: [], archCurrentRegret: [], expert: [], picks: new Map() };
  for (const p of mine) ctx.picks.set(p, { overall: overallOf(p) });

  // Pick → final-40 conversion (multiset-aware; earlier copies get the credit).
  if (deck) {
    const left = new Map<string, number>();
    for (const n of deck.main) if (!BASICS.has(n)) left.set(n, (left.get(n) ?? 0) + 1);
    for (const p of mine) {
      if (!choseIt(p) || BASICS.has(p.pick)) continue;
      const k = left.get(p.pick) ?? 0;
      const hit = k > 0 ? 1 : 0;
      if (hit) left.set(p.pick, k - 1);
      ctx.conversion.push(hit);
      if (p.packNumber === 1) ctx.p1Conversion.push(hit);
    }
  }

  // Core metrics (card data only, every set): color flow, consistency, deck roles.
  if (cards.loaded) {
    const prefix: Pick[] = [];
    const prefixPairs = mine.map((p) => (prefix.push(p), pairOfPicks(prefix, cards)));
    const pc = pairChanges(prefixPairs);
    if (pc != null) ctx.pairChanges = pc;
    const flow = colorFlow(mine, cards);
    if (flow) ctx.flow = flow;
    const final = pair || finalColors;
    const fa = flowAlignment(flow, final);
    if (fa != null) ctx.flowAlignment = fa;
    ctx.onColor = onColorPicks(mine, cards, final, choseIt);
    const roles = deck ? deckRoles(deck.main, cards, pairNormOf(norms, finalColors)) : null;
    if (roles) ctx.roles = roles;
  }

  if (cards.loaded && finalColors) {
    // Commitment: the pick from which the pool's top two colors equal the final pair and never change again.
    if (pair.length === 2) {
      const prefixPairs: string[] = [];
      const soFarC: Pick[] = [];
      for (const p of mine) {
        soFarC.push(p);
        prefixPairs.push(pairOfPicks(soFarC, cards));
      }
      let k = prefixPairs.length;
      while (k > 0 && prefixPairs[k - 1] === pair) k--;
      if (k < prefixPairs.length) ctx.commitmentPick = overallOf(mine[k]!);
    }

    // Signal reading: which colors were flowing in pack 1, picks 2–9 (what upstream seats passed)?
    if (ratings?.baseline != null) {
      const open: Record<string, number> = {};
      for (const p of mine.filter((x) => x.packNumber === 1 && x.pickNumber >= 2 && x.pickNumber <= 9)) {
        for (const c of p.contents) {
          if (cards.isLand(c)) continue;
          const g = cardRating(ratings, c)?.gih_wr;
          if (g == null) continue;
          for (const col of cards.requiredColors(c)) open[col] = (open[col] ?? 0) + Math.max(0, g - ratings.baseline);
        }
      }
      const top = Object.entries(open).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c]) => c);
      const finals = pair || finalColors;
      if (top.length === 2 && finals) {
        ctx.openColors = normPair(top.join(''));
        ctx.signalAlignment = [...finals].filter((c) => top.includes(c)).length / finals.length;
      }
    }
  }

  // Archetype-conditional value.
  if (arch && cards.loaded) {
    const cache = new Map<string, number | undefined>();
    const soFar: Pick[] = [];
    for (const p of mine) {
      const pc = ctx.picks.get(p)!;
      const real = choseIt(p) && p.contents.length > 1;
      if (real && pair.length === 2) {
        pc.arch = archRegretFor(p, pair, arch, cache);
        if (pc.arch?.regret != null) ctx.archRegret.push(pc.arch.regret);
      }
      if (real && pc.overall >= 6) {
        const cur = pairOfPicks(soFar, cards);
        if (cur.length === 2) {
          const r = archRegretFor(p, cur, arch, cache);
          if (r?.regret != null) {
            pc.archCurrent = r.regret;
            ctx.archCurrentRegret.push(r.regret);
          }
        }
      }
      soFar.push(p);
    }
  }

  // Expert pick model scores (draft-eval.json), matched by pack and pick number.
  const ex = ev.draftEval?.seats.get(seat);
  if (ex) {
    const byKey = new Map(ex.map((e) => [`${e.pack}|${e.pick}`, e] as const));
    for (const p of mine) {
      if (!choseIt(p)) continue;
      const e = byKey.get(`${p.packNumber}|${p.pickNumber}`);
      if (!e) continue;
      ctx.picks.get(p)!.expert = e;
      ctx.expert.push(e);
    }
  }
  return ctx;
}

/** Core draft metrics (METHODOLOGY §5.1): card data and logs only, so every set has them. */
function coreDraftStage(
  seats: SeatRefIn[], ctxOf: (s: SeatRefIn) => DraftContext, byEvent: <T>(f: (s: SeatRefIn) => T[]) => T[][], o: (k: number) => ScoreOpts,
): CoreDraftStage {
  const one = (f: (c: DraftContext) => number | undefined) => byEvent((s) => {
    const v = f(ctxOf(s));
    return v != null ? [v] : [];
  });
  const roleFails: Record<string, number> = {};
  let decks = 0;
  for (const s of seats) {
    const r = ctxOf(s).roles;
    if (!r) continue;
    decks++;
    for (const [k, ok] of Object.entries(r.checks)) if (!ok) roleFails[k] = (roleFails[k] ?? 0) + 1;
  }
  return {
    conversion: est(byEvent((s) => ctxOf(s).conversion), o(30)),
    p1_conversion: est(byEvent((s) => ctxOf(s).p1Conversion), o(31)),
    commitment_pick: est(one((c) => c.commitmentPick), o(32)),
    flow_alignment: est(one((c) => c.flowAlignment), o(33)),
    on_color_rate: est(byEvent((s) => ctxOf(s).onColor), o(34)),
    pair_changes: est(one((c) => c.pairChanges), o(35)),
    role_coverage: est(byEvent((s) => {
      const r = ctxOf(s).roles;
      return r ? Object.values(r.checks).map((ok) => (ok ? 1 : 0)) : [];
    }), o(36)),
    decks,
    role_fails: roleFails,
  };
}

// ---------------------------------------------------------------------------
// Build checks

export interface BuildCheck { legal: boolean; checks: Record<string, boolean>; lands: number; gihGapPp?: number }

const BASIC_COLOR: Record<string, string> = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };

export function buildCheck(ev: EventData, seat: string, cards: CardDb, ratings: Ratings | null): BuildCheck | null {
  const deck = ev.decks.get(seat);
  if (!deck) return null;
  const lands = deck.main.filter((n) => BASICS.has(n) || cards.isLand(n));
  const nonLand = deck.main.filter((n) => !BASICS.has(n) && !cards.isLand(n));
  const legal = deck.main.length >= 40;
  const checks: Record<string, boolean> = {
    size_40_41: deck.main.length >= 40 && deck.main.length <= 41,
    lands_15_18: lands.length >= 15 && lands.length <= 18,
  };
  if (cards.loaded) {
    const sources: Record<string, number> = {};
    for (const l of lands) for (const c of BASIC_COLOR[l] ?? cards.colors(l)) sources[c] = (sources[c] ?? 0) + 1;
    const need: Record<string, number> = {};
    for (const n of nonLand) for (const c of cards.requiredColors(n)) need[c] = (need[c] ?? 0) + 1;
    checks.sources = Object.entries(need).every(([c, k]) => (sources[c] ?? 0) >= (k >= 2 ? 6 : 3));
    checks.castable = Object.keys(need).every((c) => (sources[c] ?? 0) >= 1);
  }
  const out: BuildCheck = { legal, checks, lands: lands.length };
  // Baseline: average GIH WR of the best same-color pool cards vs the deck's non-land cards.
  if (ratings && cards.loaded) {
    const colors = new Set(nonLand.flatMap((n) => [...cards.requiredColors(n)]));
    const deckG = nonLand.map((n) => cardRating(ratings, n)?.gih_wr).filter((g): g is number => g != null);
    const pool = ev.picks.filter((p) => p.seat === seat && !BASICS.has(p.pick) && !cards.isLand(p.pick) && [...cards.requiredColors(p.pick)].every((c) => colors.has(c)));
    const poolG = pool.map((p) => cardRating(ratings, p.pick)?.gih_wr).filter((g): g is number => g != null).sort((a, b) => b - a);
    if (deckG.length && poolG.length >= deckG.length) {
      const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
      out.gihGapPp = (avg(poolG.slice(0, deckG.length)) - avg(deckG)) * 100;
    }
  }
  return out;
}

/**
 * Archetype build quality of a seat's deck (METHODOLOGY §5.2): quality in its own pair, the reference build of the
 * same pool, the best deck the pool could make under the same scoring, structural checks against the norms of
 * winning human decks. Null without archetype ratings for the set or without a deck.
 */
export function buildQualityOf(ev: EventData, seat: string, cards: CardDb, ratings: Ratings | null, arch: ArchetypeRatings | null, norms: DeckNorms | null): SeatBuildQuality | null {
  const deck = ev.decks.get(seat);
  if (!deck || !arch || !cards.loaded) return null;
  const pair = mainPair(deck, cards);
  const picks = ev.picks.filter((p) => p.seat === seat).sort((a, b) => overallOf(a) - overallOf(b));
  const pool = picks.length ? picks.map((p) => p.pick) : [...deck.main.filter((n) => !BASICS.has(n)), ...deck.sideboard];
  const rarity = new Map<string, string>();
  for (const p of picks) p.rarities?.forEach((r, i) => p.contents[i] && rarity.set(p.contents[i]!, r));
  return seatBuildQuality(deck.main, pair, pool, ratings, { cards, arch, norms }, (n) => rarity.get(n));
}

// ---------------------------------------------------------------------------
// Diagnostics (descriptive; never part of the rating)

interface ScoreOpts { replicates: number; seed: number }

const mean = (xs: number[]): number | undefined => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : undefined);
const medianOf = (xs: number[]): number | undefined => median(xs);

function est(clusters: number[][], opts: ScoreOpts, stat: (xs: number[]) => number | undefined = mean, scale = 1): Est | null {
  const r = clusterBootstrap(clusters, stat, { replicates: opts.replicates, seed: opts.seed });
  if (!r) return null;
  return { value: r.value * scale, ci: r.ci ? [r.ci[0] * scale, r.ci[1] * scale] : null, n: r.n, events: r.clusters };
}

export interface SeatRefIn { ev: EventData; seat: string }

/** A pick the drafter actually chose: not the last card of a pack (forced) nor made for an inactive seat (forfeit). */
export const choseIt = (p: { by: string }): boolean => p.by !== 'forced' && p.by !== 'forfeit';

export interface ScopeInputs {
  cards: CardDb;
  ratingsFor: (set: string) => Ratings | null;
  archetypesFor: (set: string) => ArchetypeRatings | null;
  /** sets/<SET>/deck-norms.json (optional: without it build quality has no calibration or structural norms). */
  normsFor?: (set: string) => DeckNorms | null;
}

/** Diagnostics for one identity over its seats in a scope. `games` are the scope's rated LLM-vs-LLM games. */
export function stageScores(seats: SeatRefIn[], games: Array<RatingGame & { seatA: string; seatB: string }>, identity: string, inp: ScopeInputs, opts: ScoreOpts): Diagnostics {
  const byEvent = <T>(f: (s: SeatRefIn) => T[]): T[][] => {
    const m = new Map<string, T[]>();
    for (const s of seats) {
      if (!m.has(s.ev.id)) m.set(s.ev.id, []);
      m.get(s.ev.id)!.push(...f(s));
    }
    return [...m.values()];
  };
  const o = (k: number): ScoreOpts => ({ ...opts, seed: opts.seed + k });

  // Draft
  const drafts = seats.map((s) => {
    const ratings = inp.ratingsFor(s.ev.set.code);
    return {
      s,
      base: evaluateDraft(s.seat, s.ev.picks, ratings, inp.cards, seatColors(s.ev, s.seat, inp.cards)),
      ctx: draftContext(s.ev, s.seat, inp.cards, ratings, inp.archetypesFor(s.ev.set.code), inp.normsFor?.(s.ev.set.code)),
    };
  });
  const dOf = (s: SeatRefIn) => drafts.find((d) => d.s === s)!;
  const ratedEvals = (s: SeatRefIn) => dOf(s).base.evals.filter((e) => e.rated);
  const expertAll = drafts.flatMap((d) => d.ctx.expert);
  const draft: DraftStage = {
    seats: seats.length,
    picks: drafts.reduce((n, d) => n + d.base.choices, 0),
    baseline: {
      rated_picks: drafts.reduce((n, d) => n + d.base.rated, 0),
      top_pick_rate: est(byEvent((s) => ratedEvals(s).map((e) => (e.matchesBest ? 1 : 0))), o(1)),
      regret_pp: est(byEvent((s) => ratedEvals(s).map((e) => e.regret).filter((x): x is number => x != null)), o(2)),
      lane_regret_pp: est(byEvent((s) => dOf(s).base.evals.map((e) => e.laneRegret).filter((x): x is number => x != null)), o(3)),
    },
    archetype: drafts.some((d) => d.ctx.archRegret.length || d.ctx.archCurrentRegret.length)
      ? {
          picks: drafts.reduce((n, d) => n + d.ctx.archRegret.length, 0),
          regret_pp: est(byEvent((s) => dOf(s).ctx.archRegret), o(4)),
          current_regret_pp: est(byEvent((s) => dOf(s).ctx.archCurrentRegret), o(5)),
        }
      : null,
    expert: expertAll.length
      ? {
          picks: expertAll.length,
          mean_log_p: est(byEvent((s) => dOf(s).ctx.expert.filter((e) => e.p != null).map((e) => Math.log(Math.max(LOG_P_FLOOR, e.p!)))), o(6)),
          top1: est(byEvent((s) => dOf(s).ctx.expert.filter((e) => e.rank != null).map((e) => (e.rank === 1 ? 1 : 0))), o(7)),
          top3: est(byEvent((s) => dOf(s).ctx.expert.filter((e) => e.rank != null).map((e) => (e.rank! <= 3 ? 1 : 0))), o(8)),
          ev_regret_pp: est(byEvent((s) => dOf(s).ctx.expert.filter((e) => e.evRegretPp != null).map((e) => e.evRegretPp!)), o(9)),
          by_pack: [1, 2, 3].map((pack) => {
            const xs = expertAll.filter((e) => e.pack === pack);
            const ranked = xs.filter((e) => e.rank != null);
            return {
              pack,
              picks: xs.length,
              top1: ranked.length ? ranked.filter((e) => e.rank === 1).length / ranked.length : null,
              mean_log_p: mean(xs.filter((e) => e.p != null).map((e) => Math.log(Math.max(LOG_P_FLOOR, e.p!)))) ?? null,
              ev_regret_pp: mean(xs.filter((e) => e.evRegretPp != null).map((e) => e.evRegretPp!)) ?? null,
            };
          }),
        }
      : null,
    hindsight: {
      conversion: est(byEvent((s) => dOf(s).ctx.conversion), o(10)),
      p1_conversion: est(byEvent((s) => dOf(s).ctx.p1Conversion), o(11)),
      commitment_pick: est(byEvent((s) => (dOf(s).ctx.commitmentPick != null ? [dOf(s).ctx.commitmentPick!] : [])), o(12)),
      signal_alignment: est(byEvent((s) => (dOf(s).ctx.signalAlignment != null ? [dOf(s).ctx.signalAlignment!] : [])), o(13)),
    },
    core: coreDraftStage(seats, (s) => dOf(s).ctx, byEvent, o),
  };

  // Build
  const builds = seats.map((s) => ({ s, deck: s.ev.decks.get(s.seat), check: buildCheck(s.ev, s.seat, inp.cards, inp.ratingsFor(s.ev.set.code)) }));
  const agentBuilt = builds.filter((b) => b.deck && b.deck.by !== 'auto' && b.check);
  const failed: Record<string, number> = {};
  for (const b of agentBuilt) for (const [k, ok] of Object.entries(b.check!.checks)) if (!ok) failed[k] = (failed[k] ?? 0) + 1;
  const strengthOf = (s: SeatRefIn) => s.ev.strength?.seats.get(s.seat);
  const bq = new Map<SeatRefIn, SeatBuildQuality | null>();
  for (const b of agentBuilt) {
    const code = b.s.ev.set.code;
    bq.set(b.s, buildQualityOf(b.s.ev, b.s.seat, inp.cards, inp.ratingsFor(code), inp.archetypesFor(code), inp.normsFor?.(code) ?? null));
  }
  const bqOf = (s: SeatRefIn) => bq.get(s) ?? null;
  const qVals = (f: (q: SeatBuildQuality) => number | null) => byEvent((s) => {
    const q = bqOf(s);
    const v = q ? f(q) : null;
    return v != null ? [v] : [];
  });
  const structural: Record<string, number> = {};
  for (const q of bq.values()) for (const fl of q?.flags ?? []) structural[fl.check] = (structural[fl.check] ?? 0) + 1;
  const verdicts = new Set([...bq.values()].filter((q): q is SeatBuildQuality => q != null).map((q) => q.verdict));
  const build: BuildStage = {
    decks: builds.filter((b) => b.deck).length,
    agent_built: agentBuilt.length,
    auto_builds: builds.filter((b) => b.deck?.by === 'auto').length,
    legal_rate: agentBuilt.length ? agentBuilt.filter((b) => b.check!.legal).length / agentBuilt.length : null,
    sanity_rate: est(
      byEvent((s) => {
        const b = agentBuilt.find((x) => x.s === s);
        return b ? Object.values(b.check!.checks).map((ok) => (ok ? 1 : 0)) : [];
      }),
      o(14),
    ),
    failed_checks: failed,
    avg_lands: mean(agentBuilt.map((b) => b.check!.lands)) ?? null,
    gih_gap_pp: est(byEvent((s) => {
      const b = agentBuilt.find((x) => x.s === s);
      return b?.check?.gihGapPp != null ? [b.check.gihGapPp] : [];
    }), o(15)),
    strength: est(byEvent((s) => (strengthOf(s)?.agent ? [strengthOf(s)!.agent!.winRate] : [])), o(16)),
    build_delta: est(byEvent((s) => {
      const st = strengthOf(s);
      return st?.agent && st.reference ? [(st.agent.winRate - st.reference.winRate) * 100] : [];
    }), o(17)),
    archetype: bq.size && [...bq.values()].some((q) => q?.build_quality != null)
      ? {
          decks: [...bq.values()].filter((q) => q?.build_quality != null).length,
          quality: est(qVals((q) => q.build_quality), o(21)),
          expected_wr: est(qVals((q) => q.expected_wr), o(22)),
          build_delta_pp: est(qVals((q) => q.build_delta_pp), o(23)),
          build_delta_wr_pp: est(qVals((q) => q.build_delta_wr_pp), o(24)),
          vs_best_pp: est(qVals((q) => q.vs_best_pp), o(25)),
          structural_pass_rate: est(byEvent((s) => {
            const q = bqOf(s);
            if (!q) return [];
            const failed = new Set(q.flags.map((f) => f.check));
            return q.checked.map((c) => (failed.has(c) ? 0 : 1));
          }), o(26)),
          structural_flags: structural,
          validation: verdicts.size === 1 ? [...verdicts][0]! : verdicts.size ? 'mixed' : 'unvalidated',
        }
      : null,
  };

  // Play (LLM-vs-LLM games in this scope)
  const myGames = games.filter((g) => g.a === identity || g.b === identity);
  const winsByEvent = new Map<string, number[]>();
  for (const g of myGames) {
    const won = (g.a === identity && g.winner === 'a') || (g.b === identity && g.winner === 'b') ? 1 : 0;
    if (!winsByEvent.has(g.event)) winsByEvent.set(g.event, []);
    winsByEvent.get(g.event)!.push(won);
  }
  let matchW = 0;
  let matchL = 0;
  const mulls: number[] = [];
  for (const s of seats) {
    for (const m of s.ev.matches) {
      if (!m.done || m.noResult || (m.a !== s.seat && m.b !== s.seat)) continue;
      const opp = m.a === s.seat ? m.b : m.a;
      if (!s.ev.seats.find((x) => x.name === opp)?.llm) continue;
      const w = m.wins[s.seat] ?? 0;
      const l = m.wins[opp] ?? 0;
      if (w > l) matchW++;
      else if (l > w) matchL++;
    }
    for (const g of s.ev.games) if (g.over && g.seats.includes(s.seat) && g.mulligans?.[s.seat] != null) mulls.push(g.mulligans[s.seat]!);
  }
  const wins = myGames.filter((g) => (g.a === identity && g.winner === 'a') || (g.b === identity && g.winner === 'b')).length;
  const play: PlayStage = {
    games: myGames.length, wins, losses: myGames.length - wins,
    win_rate: est([...winsByEvent.values()], o(18)),
    match_w: matchW, match_l: matchL,
    mulligans_per_game: mean(mulls) ?? null,
  };

  // Mana (game_over stats, newer logs). Only payments the agent planned itself count as manual: a plan the engine had
  // to top up ("manual+auto") and payments the engine made with no plan (abilities, prepared copies: auto_paid) are
  // never credited as the agent's own tapping. The share is planned / (planned + chosen auto-tapper).
  let manual = 0;
  let auto = 0;
  let autoPaid = 0;
  let toppedUp = 0;
  let failures = 0;
  let withData = 0;
  const manaItems = byEvent((s) => {
    const xs: number[] = [];
    for (const g of s.ev.games) {
      const st = g.stats?.[s.seat];
      if (!g.over || !st || st.manual_payments == null) continue;
      withData++;
      const partial = g.decisions.filter((d) => d.seat === s.seat && d.answer?.accepted && d.answer.payment === 'manual+auto').length;
      const planned = Math.max(0, st.manual_payments - partial);
      manual += planned;
      toppedUp += partial;
      auto += st.auto_tapper ?? 0;
      autoPaid += st.auto_paid ?? 0;
      failures += st.payment_failures ?? 0;
      for (let i = 0; i < planned; i++) xs.push(1);
      for (let i = 0; i < (st.auto_tapper ?? 0); i++) xs.push(0);
    }
    return xs;
  });
  const mana: ManaStage = {
    games_with_data: withData, manual, auto_tapper: auto, auto_paid: autoPaid, topped_up: toppedUp,
    manual_share: est(manaItems, o(19)),
    failures_per_100: manual + toppedUp ? (failures / (manual + toppedUp)) * 100 : null,
  };

  // Reliability
  let decisions = 0;
  let offered = 0;
  let withdrawn = 0;
  let abandoned = 0;
  const rejItems = byEvent((s) => {
    const xs: number[] = [];
    for (const g of s.ev.games) {
      for (const d of g.decisions) {
        if (d.seat !== s.seat) continue;
        offered++;
        if (d.answer) {
          decisions++;
          xs.push(d.answer.accepted ? 0 : 1);
        } else if (d.withdrawn || g.over) withdrawn++;
      }
      if (!g.over && g.seats.includes(s.seat) && s.ev.status !== 'in-progress') abandoned++;
    }
    return xs;
  });
  const reliability: ReliabilityStage = {
    decisions,
    rejected_per_100: est(rejItems, o(20), mean, 100),
    withdrawn_per_100: offered ? (withdrawn / offered) * 100 : null,
    abandoned_games: abandoned,
    // Decisions the Director settled for an inactive seat (picks, deck, conceded games); null when no event logged them.
    forfeits: seats.some((s) => s.ev.forfeitsLogged) ? seats.reduce((n, s) => n + s.ev.forfeits.filter((f) => f.seat === s.seat).length, 0) : null,
  };

  // Efficiency
  const lat: number[] = [];
  const pickLat: number[] = [];
  let cost = 0;
  let costSeats = 0;
  let costGames = 0;
  let outTokens = 0;
  let tokenDecisions = 0;
  for (const s of seats) {
    for (const g of s.ev.games) for (const d of g.decisions) if (d.seat === s.seat && d.answer?.latencyMs != null) lat.push(d.answer.latencyMs);
    for (const p of s.ev.picks) if (p.seat === s.seat && p.by === 'agent' && p.latencyMs != null) pickLat.push(p.latencyMs);
    const tr = s.ev.transcripts.get(s.seat);
    if (tr?.done && tr.costUsd != null) {
      cost += tr.costUsd;
      costSeats++;
      costGames += s.ev.games.filter((g) => g.over && g.seats.includes(s.seat)).length;
    }
    if (tr?.done && tr.outputTokens) {
      outTokens += tr.outputTokens;
      tokenDecisions += s.ev.games.reduce((n, g) => n + g.decisions.filter((d) => d.seat === s.seat && d.answer).length, 0) + s.ev.picks.filter((p) => p.seat === s.seat && p.by === 'agent').length;
    }
  }
  const efficiency: EfficiencyStage = {
    median_latency_ms: medianOf(lat) ?? null,
    median_pick_latency_ms: medianOf(pickLat) ?? null,
    cost_usd: costSeats ? cost : null,
    cost_seats: costSeats,
    cost_per_game_usd: costSeats && costGames ? cost / costGames : null,
    output_tokens_per_decision: tokenDecisions ? outTokens / tokenDecisions : null,
  };
  return { draft, build, play, mana, reliability, efficiency };
}

// ---------------------------------------------------------------------------
// Boards: one rating table per (group, set or all, source)

export interface BoardInput extends ScopeInputs {
  events: EventData[];
  identities: Identities;
  replicates: number;
  ratingOptions?: Partial<RatingOptions>;
  /** "As of" time for the generated summaries (the export's build time). Defaults to now. */
  asOf?: number;
  /** Experimental partial pooling next to the headline (METHODOLOGY §4). Default: MTGDT_RATING_POOLING=1. */
  pooling?: boolean;
  /** Override FORFEIT_POLICY (tests, sensitivity runs). */
  forfeits?: ForfeitPolicy;
  /**
   * The current prompts' keys (context.ts currentPromptKeys): the main board is the main condition with one of them, or
   * none at all, so a prompt change never leaves an older group as the headline. Absent (direct callers, tests): the
   * newest prompts under the main condition.
   */
  mainPrompts?: string[];
}

/**
 * How games touched by the inactivity watchdog enter the rating and the outcomes (METHODOLOGY §5.5):
 * - `exclude-game`: a game the watchdog conceded for a silent seat is left out; the seat's other games count.
 * - `loss` (current): the conceded game counts as a loss for the seat that went silent and a win for its opponent, as
 *   a player who leaves a tournament forfeits. Voided games (engine failures, void-and-replay) never reach here.
 * - `void-seat-event`: every rated game of a seat that forfeited anything in an event is left out, wins included, so
 *   stopping a harness can't remove only the games it was losing.
 */
export type ForfeitPolicy = 'exclude-game' | 'loss' | 'void-seat-event';

/**
 * The policy in force (owner decision, 2026-10-22): a forfeit is a loss. It closes the "quit to erase a loss" loophole;
 * a harness that crashes is part of the agent system being measured, and the relaunch plus the 10-minute watchdog
 * already absorb short hiccups.
 */
export const FORFEIT_POLICY: ForfeitPolicy = 'loss';

/**
 * Whether one game counts toward ratings, and why not when it doesn't (the open data's games.rated and
 * games.unrated_reason; ratingGamesOf keeps exactly the games this accepts). The event must be pooled (groupKey).
 */
export function gameRatingStatus(ev: EventData, g: Game, ids: Identities, policy: ForfeitPolicy = FORFEIT_POLICY, forfeited = new Set(ev.forfeits.map((f) => f.seat))): { rated: boolean; reason: string | null } {
  const no = (reason: string) => ({ rated: false, reason });
  const ur = unratedReason(ev);
  if (ur) return no(`event not rated: ${ur}`);
  if (!g.over) return no(ev.status === 'in-progress' ? 'still being played' : 'not finished (void)');
  if (!g.winner) return no('no winner');
  if (g.seats.length !== 2) return no('not a two-player game');
  if (g.forfeitedBy && policy !== 'loss') return no('forfeit (excluded by the forfeit policy)');
  if (policy === 'void-seat-event' && g.seats.some((s) => forfeited.has(s))) return no('a seat forfeited in this event (void-seat-event policy)');
  const [sa, sb] = g.seats as [string, string];
  // A seat excluded on its own (a banned contributor at someone else's table): its games are unrated, the rest stand.
  const xs = ev.source.excludeSeats?.[sa] ?? ev.source.excludeSeats?.[sb];
  if (xs) return no(`seat excluded: ${xs}`);
  if (!ev.seats.find((s) => s.name === sa)?.llm || !ev.seats.find((s) => s.name === sb)?.llm) return no('not between two LLM seats');
  const xa = ids.of(ev, sa);
  const xb = ids.of(ev, sb);
  // Mismatch (usage shows another model) and Unlisted seats are not rated (METHODOLOGY §2.1).
  if (!xa.rated || !xb.rated) return no('a seat is Unlisted or a Mismatch');
  if (xa.key === xb.key) return no('mirror (same setup on both sides)');
  return { rated: true, reason: null };
}

export function ratingGamesOf(
  evs: EventData[], ids: Identities, opts: { forfeits?: ForfeitPolicy } = {},
): Array<RatingGame & { seatA: string; seatB: string; noResult?: boolean; onPlayChosen?: 'a' | 'b'; gameIndex: number }> {
  const policy = opts.forfeits ?? FORFEIT_POLICY;
  const out: Array<RatingGame & { seatA: string; seatB: string; noResult?: boolean; onPlayChosen?: 'a' | 'b'; gameIndex: number }> = [];
  for (const ev of evs) {
    const forfeited = new Set(ev.forfeits.map((f) => f.seat));
    // Matches cut short by engine failures (no result): their finished games are rated, never their match.
    const noResult = new Set(ev.matches.filter((m) => m.noResult).map((m) => m.key));
    for (const g of ev.games) {
      if (!g.over || !g.winner || g.seats.length !== 2) continue;
      if (!gameRatingStatus(ev, g, ids, policy, forfeited).rated) continue;
      const [sa, sb] = g.seats as [string, string];
      const xa = ids.of(ev, sa);
      const xb = ids.of(ev, sb);
      const x = deckCovariate(ev, sa, sb);
      const side = (seat: string | undefined): 'a' | 'b' | undefined => (seat === sa ? 'a' : seat === sb ? 'b' : undefined);
      out.push({
        event: ev.id, a: xa.key, b: xb.key, seatA: sa, seatB: sb, gameIndex: g.index,
        ca: contributorOf(ev, sa).key, cb: contributorOf(ev, sb).key, set: ev.set.code.toUpperCase(),
        winner: g.winner === sa ? 'a' : 'b',
        // Game 1's play/draw is random (the event seed); in games 2–3 the previous game's loser chose, so that side is
        // more often the weaker deck and the play advantage measured there is biased toward zero (METHODOLOGY §4).
        ...(side(g.onPlay) ? (g.gameInMatch <= 1 ? { onPlay: side(g.onPlay)! } : { onPlayChosen: side(g.onPlay)! }) : {}),
        ...(x != null ? { x } : {}),
        ...(noResult.has(g.matchKey) ? { noResult: true } : {}),
      });
    }
  }
  return out;
}

const logit = (p: number) => Math.log(Math.min(0.99, Math.max(0.01, p)) / (1 - Math.min(0.99, Math.max(0.01, p))));

function deckCovariate(ev: EventData, a: string, b: string): number | undefined {
  const sa = ev.strength?.seats.get(a)?.agent?.winRate;
  const sb = ev.strength?.seats.get(b)?.agent?.winRate;
  return sa != null && sb != null ? logit(sa) - logit(sb) : undefined;
}

/** Table provenance: the `source` codes are historical ("verified" means a hosted table, never a verified result). */
export const PROVENANCE: Record<SourceLabel | 'all', 'hosted' | 'community' | 'test' | 'all'> = { verified: 'hosted', community: 'community', smoke: 'test', all: 'all' };
export const PROVENANCE_LABELS: Record<'hosted' | 'community' | 'test' | 'all', string> = { hosted: 'Hosted', community: 'Community', test: 'Test Run', all: 'All Tables' };

/** Why a pooled event (or a setup's seats) has no rated game when every finished game it played was against its own setup. */
export const IDENTICAL_SETUPS = 'all games were between identical setups';

/**
 * Why an identity's seats have no rated game: every finished game was against the same setup (a mirror table), or
 * there were no games between LLM agents at all.
 */
function noRatedGamesReason(seats: Array<{ ev: EventData; seat: string }>, ids: Identities, identity: string): string {
  let games = 0;
  let self = 0;
  for (const { ev, seat } of seats) {
    for (const g of ev.games) {
      if (!g.over || !g.winner || g.seats.length !== 2 || !g.seats.includes(seat)) continue;
      const other = g.seats.find((x) => x !== seat)!;
      if (!ev.seats.find((x) => x.name === other)?.llm) continue;
      games++;
      if (ids.of(ev, other).key === identity) self++;
    }
  }
  return games > 0 && self === games ? IDENTICAL_SETUPS : 'no LLM-vs-LLM games';
}

/**
 * An event's rating status (2.11): "rated" with its rated games; "no_rated_games" for a pooled event where no game was
 * between two different rated setups (a mirror table: "all games were between identical setups"); "not_rated" when the
 * event isn't pooled at all (unratedReason).
 */
export function eventRatingStatus(ev: EventData, ids: Identities, opts: { forfeits?: ForfeitPolicy } = {}): { status: RatingStatus; display: string; rated_games: number; reason?: string } {
  const out = (status: RatingStatus, rated: number, reason?: string) => ({ status, display: RATING_STATUS_LABELS[status], rated_games: rated, ...(reason ? { reason } : {}) });
  const unrated = unratedReason(ev);
  if (unrated) return out('not_rated', 0, unrated);
  const rated = ratingGamesOf([ev], ids, opts).length;
  if (rated) return out('rated', rated);
  const llm = ev.seats.filter((s) => s.llm);
  const keys = new Set(llm.map((s) => ids.of(ev, s.name).key));
  if (llm.length > 1 && keys.size === 1) return out('no_rated_games', 0, IDENTICAL_SETUPS);
  const reasons = [...new Set(llm.map((s) => noRatedGamesReason([{ ev, seat: s.name }], ids, ids.of(ev, s.name).key)))];
  if (reasons.length === 1 && reasons[0] === IDENTICAL_SETUPS) return out('no_rated_games', 0, IDENTICAL_SETUPS);
  const unratedSeats = llm.some((s) => !ids.of(ev, s.name).rated);
  return out('no_rated_games', 0, unratedSeats ? 'no games between two rated setups (Mismatch or Unlisted seats are not rated)' : 'no finished games between different setups');
}

/**
 * What kind of table an event was (2.17), for the words around its winner:
 * - scripted: no LLM seat (scripted test players only): a Test Run, a software check, never models;
 * - test: LLM seats with scripted or bot seats (an operator's check table): never rated, never "won";
 * - mirror: every LLM seat the same setup (model and effort, whatever the harness): no rated games, no winner "of N agents";
 * - single_model: one model at several efforts (an effort ladder table): a seat of it finished first;
 * - mixed: at least two models.
 */
export type TableKind = 'scripted' | 'test' | 'mirror' | 'single_model' | 'mixed';

export function tableKind(ev: EventData, ids: Identities): TableKind {
  const llm = ev.seats.filter((s) => s.llm);
  if (!llm.length) return 'scripted';
  if (ev.seats.some((s) => !s.llm)) return 'test';
  const keys = new Set(llm.map((s) => ids.of(ev, s.name).key));
  if (keys.size === 1) return 'mirror';
  return new Set(llm.map((s) => ids.of(ev, s.name).model)).size === 1 ? 'single_model' : 'mixed';
}

const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
const countWord = (n: number) => COUNT_WORDS[n] ?? String(n);
const capFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * One sentence for an event card or What's New (2.17). Only a mixed table has a winner "of N agents"; a mirror or
 * single-model table says whose seats played each other, and a scripted table says it was a software check.
 * `label` turns an identity key into its display label; `winner` is the seat that finished first, if one did.
 */
export function tableSentence(ev: EventData, ids: Identities, label: (key: string) => string, winner?: string): string {
  const kind = tableKind(ev, ids);
  const agents = ev.seats.filter((s) => s.kind === 'agent');
  const llm = ev.seats.filter((s) => s.llm);
  const where = ev.set.name;
  const stopped = ev.status === 'stopped' ? ' It was stopped before it finished; its finished games count.' : '';
  if (kind === 'scripted') return `A Test Run in ${where}: ${countWord(agents.length)} scripted test players, a software check with no models and no rated games.`;
  const first = ids.of(ev, llm[0]!.name);
  const model = first.modelEntry?.display ?? first.alias;
  if (kind === 'test') {
    const names = [...new Set(llm.map((s) => label(ids.of(ev, s.name).key)))].sort();
    const scripted = ev.seats.length - llm.length;
    return `A test table in ${where}: ${names.join(', ')} with ${countWord(scripted)} scripted ${scripted === 1 ? 'player' : 'players'}, a check of the software, not a result.${stopped}`;
  }
  if (kind === 'mirror') {
    return `${capFirst(countWord(llm.length))} identical ${label(first.key)} seats played each other in ${where}: a mirror table, so no game is rated and no setup won it.${stopped}`;
  }
  const wid = winner && ev.seats.find((s) => s.name === winner)?.llm ? ids.of(ev, winner) : undefined;
  if (kind === 'single_model') {
    const setups = [...new Set(llm.map((s) => ids.of(ev, s.name).key))].map((k) => label(k)).sort();
    const w = wid ? ` A ${label(wid.key)} seat finished first.` : ev.status === 'complete' ? ' It finished level at the top.' : '';
    return `${capFirst(countWord(llm.length))} ${model} seats played each other in ${where} (${setups.length} setups: ${setups.join('; ')}).${w}${stopped}`;
  }
  if (ev.status !== 'complete') return `A table of ${agents.length} agents in ${where}.${stopped}`;
  return wid ? `${label(wid.key)} won a table of ${agents.length} agents in ${where}.` : `A table of ${agents.length} agents in ${where} finished level at the top.`;
}

/**
 * Whether the top row of a ranking is ahead of every row connected to it after a Holm correction over those
 * comparisons (METHODOLOGY §4 "Several comparisons"): what a set or single-source board needs before it says "ranks first".
 */
export function topHoldsAfterHolm(ranked: Array<{ identity: string; component: number | null }>, pairs: PairDiff[]): boolean {
  const top = ranked[0];
  if (!top) return false;
  const peers = ranked.filter((r) => r !== top && r.component === top.component);
  if (!peers.length) return false;
  const ps = peers.map((r) => {
    const d = pairs.find((p) => (p.a === top.identity && p.b === r.identity) || (p.b === top.identity && p.a === r.identity));
    if (!d) return 1;
    const diff = d.a === top.identity ? d.diff : -d.diff;
    return diff > 0 ? pFromInterval(diff, d.a === top.identity ? d.ci : d.ci ? [-d.ci[1], -d.ci[0]] : null) ?? 1 : 1;
  });
  return holm(ps).every((p) => p != null && p < 0.05);
}

/** The experimental pooled fit is off unless MTGDT_RATING_POOLING=1 (METHODOLOGY §4, "Partial pooling"). */
export const poolingEnabled = (): boolean => process.env.MTGDT_RATING_POOLING === '1';

/** On the default ranking: identities with a recorded effort. Unknown Effort rows stay in the fit (their games inform their opponents). */
export const onDefaultRanking = (info: IdentityInfo | undefined): boolean => info != null && info.effort !== 'unknown';

export function buildBoards(inp: BoardInput): { boards: Board[]; groups: GroupInfo[] } {
  const rated = inp.events.filter((ev) => groupKey(ev) != null);
  const groupKeys = [...new Set(rated.map((ev) => groupKey(ev)!))].sort();
  const boards: Board[] = [];
  const groups: GroupInfo[] = [];
  const ropts = { ...DEFAULT_RATING_OPTIONS, replicates: inp.replicates, ...inp.ratingOptions };
  const eventsOf = new Map(groupKeys.map((gk) => [gk, rated.filter((ev) => groupKey(ev) === gk)] as const));
  const newest = (gk: string) => Math.max(...eventsOf.get(gk)!.map((ev) => ev.startT));
  // The main board: the main condition with the current prompts. With `mainPrompts` (every export) only those prompts
  // qualify: until the current group has rated games there is no main board ("no rated games yet"), never an older
  // group. Without it, the newest prompt fingerprint under the main condition.
  const current = inp.mainPrompts ? new Set(inp.mainPrompts) : null;
  const mainKey = groupKeys
    .filter((gk) => isMainCondition(conditionsOf(eventsOf.get(gk)![0]!)) && (!current || current.has(conditionsOf(eventsOf.get(gk)![0]!).prompt_key!)))
    .sort((a, b) => newest(b) - newest(a) || a.localeCompare(b))[0] ?? null;
  for (const gk of groupKeys) {
    const gEvents = eventsOf.get(gk)!;
    const c = conditionsOf(gEvents[0]!);
    const sets = [...new Set(gEvents.map((e) => e.set.code.toUpperCase()))].sort();
    const sources: Partial<Record<SourceLabel, number>> = {};
    for (const e of gEvents) sources[e.source.label] = (sources[e.source.label] ?? 0) + 1;
    const idKeys = new Set(gEvents.flatMap((ev) => ev.seats.filter((s) => s.llm && inp.identities.of(ev, s.name).rated).map((s) => inp.identities.of(ev, s.name).key)));
    const contributors = new Set(gEvents.flatMap((ev) => ev.seats.filter((s) => s.llm).map((s) => contributorOf(ev, s.name).key)));
    const role = gk === mainKey ? 'main' : 'side';
    groups.push({
      key: gk,
      label: groupLabel({ knowledge: c.knowledge!, mana: c.mana! }),
      conditions: { knowledge: c.knowledge!, mana: c.mana!, best_of: c.best_of, prompt_version: c.prompt_version ?? c.prompt_key!, prompt_sha256: c.prompt_sha256, prompt_key: c.prompt_key! },
      events: gEvents.length,
      sets,
      sources,
      provenance: Object.fromEntries(Object.entries(sources).map(([k, n]) => [PROVENANCE[k as SourceLabel], n])),
      engines: [...new Set(gEvents.map((e) => engineLabel(conditionsOf(e)) ?? 'not recorded'))].sort(),
      identities: idKeys.size,
      contributors: contributors.size,
      role,
      swiss_finishes: swissFinishes(gEvents, (ev, seat) => inp.identities.of(ev, seat).key),
    });
    for (const set of [null, ...sets]) {
      for (const source of ['all', 'verified', 'community'] as const) {
        const evs = gEvents.filter((e) => (set == null || e.set.code.toUpperCase() === set) && (source === 'all' || e.source.label === source));
        if (!evs.length) continue;
        boards.push(board(gk, role, set, source, evs, inp, ropts));
      }
    }
  }
  // No prompt versions in labels: groups that would share a label get "Earlier Prompt" on all but the newest (with
  // the date of their last event when there are several).
  const byLabel = new Map<string, GroupInfo[]>();
  for (const g of groups) byLabel.set(g.label, [...(byLabel.get(g.label) ?? []), g]);
  for (const gs of byLabel.values()) {
    if (gs.length < 2) continue;
    const sorted = [...gs].sort((a, b) => newest(b.key) - newest(a.key) || a.key.localeCompare(b.key));
    const earlier = sorted.slice(1);
    const used = new Set<string>();
    for (const g of earlier) {
      let label = earlier.length === 1 ? `${g.label} · Earlier Prompt` : `${g.label} · Earlier Prompt (${asOfDate(newest(g.key))})`;
      for (let k = 2; used.has(label); k++) label = `${label.replace(/ \d+$/, '')} ${k}`;
      used.add(label);
      g.label = label;
    }
  }
  return { boards, groups };
}

function board(
  group: string, role: 'main' | 'side', set: string | null, source: Board['source'], evs: EventData[], inp: BoardInput, ropts: RatingOptions,
): Board {
  const id = `${group}|${set ?? '*'}|${source}`;
  // Seeded by the board id, so adding a set or a group never reseeds the others.
  const seed = seedOf(id);
  const games = ratingGamesOf(evs, inp.identities, { forfeits: inp.forfeits });
  // The bot-duel "pilot" rating is not part of the methodology: the headline never uses the deck covariate.
  const noCov = games.map(({ x: _x, ...g }) => g);
  const headline = rateGames(noCov, { ...ropts, seed: (ropts.seed + seed) >>> 0 });
  const infoOf = (k: string) => inp.identities.info.get(k);
  const pooledFit = (inp.pooling ?? poolingEnabled()) && noCov.length
    ? rateGames(noCov, {
        ...ropts, seed: (ropts.seed + seed + 1) >>> 0, influence: false,
        // 2.20: identities no longer differ by harness, so the pooled fit has one harness level.
        pooling: { of: (k) => { const i = infoOf(k); return i ? { model: i.model, harness: 'any', effort: i.effort } : undefined; } },
      })
    : null;

  const seatsById = new Map<string, SeatRefIn[]>();
  for (const ev of evs) {
    for (const s of ev.seats.filter((x) => x.llm)) {
      const sid = inp.identities.of(ev, s.name);
      if (!sid.rated) continue; // Mismatch / Unlisted: shown on the event, never on a board
      const k = sid.key;
      if (!seatsById.has(k)) seatsById.set(k, []);
      seatsById.get(k)!.push({ ev, seat: s.name });
    }
  }
  const sub = (k: number) => (seed + k * 7919) >>> 0;
  const rows: BoardRow[] = [...seatsById.entries()].map(([identity, seats]) => {
    const r = headline.rows.find((x) => x.id === identity);
    const pr = pooledFit?.rows.find((x) => x.id === identity);
    const contributorKeys = new Set(seats.map((s) => contributorOf(s.ev, s.seat).key));
    const row: BoardRow = {
      identity,
      rating: r?.rating ?? null,
      ci: r?.ci ?? null,
      ci_bootstrap: r?.ciBoot ?? null,
      se: r?.se ?? null,
      rank: r?.rank ?? null,
      rank_ci: r?.rankCi ?? null,
      provisional: r ? r.provisional : true,
      provisional_reasons: r ? r.provisionalReasons : [noRatedGamesReason(seats, inp.identities, identity)],
      component: r?.component ?? null,
      games: r?.games ?? 0,
      wins: r?.wins ?? 0,
      losses: r?.losses ?? 0,
      events: new Set(seats.map((s) => s.ev.id)).size,
      opponents: r?.opponents ?? 0,
      pilot: null,
      seats: seats.map((s) => ({ event_id: s.ev.id, seat: s.seat })),
      stages: stageScores(seats, games, identity, inp, { replicates: Math.min(inp.replicates, 500), seed: sub(1) }),
      games_needed: Math.max(0, ropts.minGames - (r?.games ?? 0)),
      outcomes: outcomesOf(games, (x) => x === identity, seats, { replicates: Math.min(inp.replicates, 500), seed: sub(2) }),
      cost: costInfo(seats.map((s) => ({ ...s, modelId: inp.identities.of(s.ev, s.seat).model })), { replicates: Math.min(inp.replicates, 500), seed: sub(3) }),
      // 2.9
      default_ranking: onDefaultRanking(infoOf(identity)),
      rank_range_all: r?.rankRange ?? null,
      contributors: r?.contributors ?? contributorKeys.size,
      top_contributor_share: r?.topContributor ? r.topContributor.share : null,
      contributor_floor_met: r != null && r.contributors >= ropts.minContributors && (r.topContributor?.share ?? 1) <= ropts.maxContributorShare,
      influence: r?.influence ? { contributor: r.influence.contributor, shift: r.influence.shift, flagged: r.influence.flagged } : null,
      expected_score: r
        ? { value: expectedScore(r.rating, ELO_CENTER), ci: r.ci ? [expectedScore(r.ci[0], ELO_CENTER), expectedScore(r.ci[1], ELO_CENTER)] : null }
        : null,
      ...(pooledFit ? { pooled: pr ? { rating: pr.rating, ci: pr.ci } : null } : {}),
    };
    return row;
  });
  rows.sort((a, b) => (b.rating ?? -Infinity) - (a.rating ?? -Infinity) || a.identity.localeCompare(b.identity));
  // Rank ranges from difference intervals within each connected group: the default ranking (recorded effort) and all rows.
  const comp = new Map(rows.map((r) => [r.identity, r.component] as const));
  const ratedIds = rows.filter((r) => r.rating != null).map((r) => r.identity);
  const dflt = headline.replicates > 0 ? rankRangesFromPairs(ratedIds, (k) => comp.get(k), headline.pairs, (k) => rows.find((r) => r.identity === k)!.default_ranking!) : new Map();
  const groupSize = new Map<number, number>();
  for (const r of rows) if (r.rating != null && r.default_ranking && r.component != null) groupSize.set(r.component, (groupSize.get(r.component) ?? 0) + 1);
  const overlap = rankRanges(rows, (r) => (r.rating != null ? r.ci : null));
  rows.forEach((r, i) => {
    r.rank_range = dflt.get(r.identity) ?? null;
    r.rank_of = r.rank_range && r.component != null ? groupSize.get(r.component)! : null;
    r.rank_range_overlap = overlap[i] ?? null;
  });
  const diag = boardDiagnostics(rows);
  rows.forEach((r, i) => (r.diagnostics = diag.perRow[i]!));
  const c = conditionsOf(evs[0]!);
  const labelOf = (k: string) => {
    const info = infoOf(k);
    return info ? `${info.model_display} (${info.effort_display})` : k;
  };
  const connected = [...new Set(rows.filter((r) => r.rating != null).map((r) => r.component!))].sort((a, b) => a - b)
    .map((component) => ({ component, identities: rows.filter((r) => r.component === component && r.rating != null).map((r) => r.identity) }));
  const summary = boardSummary({
    asOf: inp.asOf ?? Date.now(),
    conditions: conditionsText(c),
    set: set ? evs[0]!.set.name : null,
    events: evs.length,
    games: games.length,
    rows: rows.filter((r) => r.default_ranking).map((r) => ({
      label: labelOf(r.identity), rating: r.rating, ci: r.ci, games: r.games, provisional: r.provisional, rankRange: r.rank_range ?? null, group: r.component,
    })),
    minGames: ropts.minGames,
    unknownEffortRows: rows.filter((r) => !r.default_ranking && r.rating != null).length,
    exploratory: set != null || source !== 'all',
    topHolds: topHoldsAfterHolm(rows.filter((r) => r.default_ranking && r.rating != null), headline.pairs),
    provisionalRule: provisionalRule(ropts),
  });
  const out: Board = {
    id,
    group, set, source,
    events: evs.length,
    games: games.length,
    identities: rows.length,
    components: headline.components,
    play_advantage: headline.playAdvantage,
    deck_adjusted: false,
    replicates: headline.replicates,
    rows,
    summary,
    pairwise: pairwise(games),
    version_differences: versionDifferences(headline.pairs, (k) => infoOf(k)?.model),
    // 2.17: every pair's difference interval (what rank ranges are built from) and the bootstrap seed, for the open data.
    differences: versionDifferences(headline.pairs, () => 'any'),
    seed: (ropts.seed + seed) >>> 0,
    field: diag.field,
    // 2.9
    role,
    provenance: source === 'verified' ? 'hosted' : source,
    provenance_display: PROVENANCE_LABELS[PROVENANCE[source]],
    bootstrap_unit: headline.bootstrapUnit,
    clusters: headline.clusters,
    contributors: new Set(games.flatMap((g) => [g.ca!, g.cb!])).size,
    connected_groups: connected,
  };
  if (pooledFit?.pooled) {
    out.pooled = {
      experimental: true,
      models: modelLevel(pooledFit.pooled.model).map((m) => ({ ...m, display: registry.model(m.model)?.display ?? m.model })),
      harnesses: pooledFit.pooled.harness.map((h) => ({ harness: h.id, offset: h.elo, se: h.se })),
      efforts: pooledFit.pooled.effort.map((e) => ({ model: e.id.split('|')[0]!, effort: e.id.split('|')[1]!, offset: e.elo, se: e.se })),
    };
  }
  return out;
}

/**
 * 2.15: rating differences between two versions of one model (same model id, another effort), from the
 * headline fit's pairs within each connected group. Elo to 1 decimal.
 */
export function versionDifferences(pairs: PairDiff[], modelOf: (identity: string) => string | undefined): VersionDifference[] {
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return pairs
    .filter((p) => { const m = modelOf(p.a); return m != null && m !== 'unknown' && m === modelOf(p.b); })
    .map((p) => ({ a: p.a, b: p.b, diff: r1(p.diff), ci: p.ci ? [r1(p.ci[0]), r1(p.ci[1])] as [number, number] : null, ahead: p.ahead }))
    .sort((x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
}

/** Model-level terms of the pooled fit, centered on their mean (display only: differences don't change). */
function modelLevel(ms: Array<{ id: string; elo: number; se: number }>): Array<{ model: string; rating: number; se: number }> {
  const mean = ms.length ? ms.reduce((s, m) => s + m.elo, 0) / ms.length : 0;
  return ms.map((m) => ({ model: m.id, rating: ELO_CENTER + m.elo - mean, se: m.se })).sort((a, b) => b.rating - a.rating || a.model.localeCompare(b.model));
}

export { ELO_CENTER };
