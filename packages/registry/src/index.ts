/**
 * Model and harness identity: the one place a declared or harness-reported name ("Sonnet 5.5", "sonnet",
 * "anthropic/claude-sonnet-5-5", "Claude Code") becomes a canonical id. Used by the Director (create-event API,
 * lobby), the bench CLI, the Hub checks and the site export, so every path agrees.
 *
 * Data: registry/models.json and registry/harnesses.json (community-editable; registry/README.md). harnesses.json also
 * lists launchers: apps that start harness sessions without being one (T3 Code). A seat started in one ranks as the
 * harness it ran; the launcher is recorded beside it (METHODOLOGY §2.3).
 *
 *   resolveModel(raw, harness?, { at })     canonical model id, or unknown with "did you mean" suggestions
 *   resolveHarness(raw)                     canonical harness id (and the launcher, for "t3-code:claude-code"), or unknown with suggestions
 *   normalizeEffort(raw, model?, harness?)  canonical effort ("none" … "max", or "default")
 *   resolveSeat(declared, { allowUnlisted }) all three at once, plus the record to log in event_start
 *   primaryModelFromUsage(usage, harness?)  the model that did the work (most output tokens, helpers ignored)
 *   verifySeatModel(...)                    Verified / Self-Reported / Mismatch / Unlisted (METHODOLOGY §2.1)
 *   identityKey / identityLabel             "claude-sonnet-5-5/high", "Claude Sonnet 5.5 · High" (model and effort: the
 *                                           harness is recorded per seat, never part of the identity; METHODOLOGY §2)
 *
 * Matching rules (registry/README.md "How names are matched"): case, spaces, dots, dashes and underscores never
 * matter; known provider prefixes ("anthropic/", "openai/", Bedrock's "anthropic.") are stripped; a trailing
 * "#variant" (OpenCode) or "[effort=…]" (Cursor) is read as an effort hint; a trailing date (-20261001, @20261001)
 * is a snapshot of the model it follows. With a harness, its own name forms apply too: a level suffix where every
 * model name carries one (Antigravity "gemini-4-argon-high"), a fast-mode suffix (Cursor "-fast"), and the harness's
 * own model service (OpenCode Zen "opencode/<id>", free variants "<id>-free"). Anything else that isn't an exact id,
 * display name or alias is unknown: typos are never corrected silently, only suggested.
 */
import { createHash } from 'node:crypto';
import modelsData from '../../../registry/models.json' with { type: 'json' };
import harnessesData from '../../../registry/harnesses.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// Data shapes (registry/schema/*.schema.json)

/**
 * Canonical effort. The concrete levels run `none` … `max`. `default` is only ever *declared* ("whatever the harness
 * does"); resolution turns it into a concrete level (the documented harness default) or `unknown` (METHODOLOGY §2.1).
 */
export type Effort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | 'default' | 'unknown';
export const EFFORT_IDS: readonly Effort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'default', 'unknown'];
/** Concrete levels. `ultra` (Codex: subagents in parallel) is its own level, unordered: Codex's docs don't place it relative to `max`. */
export const CONCRETE_EFFORTS: readonly Effort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const isConcreteEffort = (e: string | null | undefined): e is Effort => !!e && (CONCRETE_EFFORTS as readonly string[]).includes(e);

export interface ProviderEntry { display: string; prefixes: string[] }
export interface EffortEntry { id: Effort; display: string; rank: number | null; aliases: string[] }
export interface FloatingAlias { alias: string; from: string; until?: string }
export interface ModelEntry {
  id: string;
  display: string;
  provider: string;
  family: string;
  /** From an official page; absent when none gives one. */
  released?: string;
  status: 'active' | 'preview' | 'deprecated' | 'retired';
  deprecated?: string;
  source: string;
  aliases: string[];
  floating_aliases: FloatingAlias[];
  snapshots: string[];
  efforts: Effort[];
  default_effort?: Effort;
  launch: Record<string, string>;
  /** Where a harness spells a level differently in this model's launch string: harness → level → word (Cursor gpt-5.5-extra-high). */
  launch_effort_words?: Record<string, Partial<Record<Effort, string>>>;
  notes?: string;
}

/** A harness's own model service (OpenCode Zen): "<prefix><model id>" is that registry model; "<free_suffix>" marks a free variant. */
export interface HostedService { prefix: string; free_suffix?: string; display: string; source: string }
export interface HarnessEntry {
  id: string;
  display: string;
  vendor: string;
  kind: 'agent' | 'test';
  /** headless: the bench CLI launches it; by-hand: a person seats it in the app; test: the scripted player. */
  seated: 'headless' | 'by-hand' | 'test';
  status: 'tested' | 'untested';
  aliases: string[];
  cli: string | null;
  docs: string;
  model_flag: string | null;
  /** The harness vendor's own model service, whose ids wrap registry models (OpenCode Zen). */
  hosted?: HostedService;
  /**
   * How effort is set at launch; null when the harness has no control for it. `args` is the flag with an `{effort}`
   * placeholder; `model_template` puts the level into the model string instead (OpenCode `{model}#{effort}`);
   * Cursor's launch strings carry `{effort}` themselves. `name_suffix` says every model name carries its level
   * (Antigravity "-{effort}"), so any registry model with it resolves; `fast_suffix` marks fast serving mode (Cursor "-fast").
   */
  effort: { flag: string; args?: string[]; model_template?: string; name_suffix?: string; fast_suffix?: string; values: Record<string, Effort> } | null;
  /** Documented default effort when none is set, per model and harness version range (METHODOLOGY §2.1). */
  effort_defaults: EffortDefault[];
  /** Where the harness records the effort actually used, and whether that has been checked on real files. */
  effort_detection: { where: string; status: 'tested' | 'untested' | 'not-reported'; tested_version?: string; source?: string };
  reports: { format: string; version: string; model: string };
  helper_models: string[];
  notes?: string;
}
/**
 * An app that starts harness sessions without being a harness (T3 Code): the harness runs the model loop, the
 * launcher only starts it (and may add its own MCP server and instructions). Never a leaderboard row of its own.
 */
export interface LauncherEntry {
  id: string;
  display: string;
  vendor: string;
  aliases: string[];
  docs: string;
  /** The harness ids it can start. */
  launches: string[];
  /** Where it logs the model and effort each session opened with: a fallback after the harness's own record. */
  logs: { where: string; status: 'tested' | 'untested'; tested_version?: string; source?: string };
  notes?: string;
}
export interface EffortDefault {
  /** Model ids (or prefix globs ending in *). */
  models: string[];
  level: Effort;
  /** Inclusive lower / exclusive upper harness version; omit both when it holds for every version. */
  since?: string;
  until?: string;
  source: string;
  note?: string;
}

export type EffortSource = 'declared-explicit' | 'detected' | 'harness-default' | 'self-reported' | 'unknown';
export const EFFORT_SOURCE_LABELS: Record<EffortSource, string> = {
  'declared-explicit': 'Set at Launch',
  detected: 'Detected from Logs',
  'harness-default': 'Harness Default',
  'self-reported': 'Self-Reported',
  unknown: 'Unknown',
};

/** Effort the harness logs showed for a seat (usage-<seat>.json `effort_reported`). */
export interface DetectedEffort {
  /** Canonical level, or null when the logs had none. */
  level: string | null;
  /** Assistant turns per level, when the logs are per turn. */
  counts?: Record<string, number>;
  /** Where it came from: claude-session, codex-rollout, cursor-model-name, opencode-session, opencode-db, antigravity-db, t3-log (a launcher's log). */
  source: string;
  /** Fast serving mode (Cursor "-fast" names): recorded, not part of the identity (METHODOLOGY §2.2). */
  fast?: boolean;
}

export interface EffortEvidence {
  harness?: string;
  model?: string;
  /** Effort as declared ("high", "default", "unknown"; absent in older logs). */
  declared?: string;
  /** How it was declared: `launch` (the bench CLI started the seat with this level) or `self-report` (seated by hand). */
  basis?: 'launch' | 'self-report';
  detected?: DetectedEffort | null;
  harnessVersion?: string;
  at?: number | string | Date;
}

export interface ResolvedEffort {
  /** Concrete level, or `unknown`. This goes into the identity key. */
  effort: Effort;
  source: EffortSource;
  /** Verified: the logs show the level. Self-Reported: nobody checked it. Mismatch: the logs disagree with the declaration. */
  status: 'verified' | 'self-reported' | 'mismatch';
  reason: string;
  declared?: string;
  detected?: string | null;
  harness_version?: string;
  /** The documentation behind a harness default. */
  default_source?: string;
  /** The logs showed fast serving mode (recorded; not part of the identity key). */
  fast?: boolean;
}

export interface RegistryData {
  providers: Record<string, ProviderEntry>;
  effort_scale: EffortEntry[];
  models: ModelEntry[];
  harnesses: HarnessEntry[];
  launchers?: LauncherEntry[];
}

/** One line for error messages: how to get a missing model or harness listed. */
export const REGISTRY_PR_HINT =
  'Not listed yet? Add it to registry/models.json (or registry/harnesses.json) in a pull request: see registry/README.md.';

// ---------------------------------------------------------------------------
// Results

export type MatchVia = 'id' | 'display' | 'alias' | 'floating' | 'snapshot' | 'launch' | 'level-suffix';

/** A model served by a harness vendor's own service (OpenCode Zen): the same registry model and row, flagged. */
export interface HostedVariant { service: string; free: boolean }

export type ModelResolution =
  | {
    ok: true;
    id: string;
    model: ModelEntry;
    raw: string;
    via: MatchVia;
    /** The dated snapshot id when the name was one (known or not). */
    snapshot?: string;
    /** false: a dated snapshot the registry doesn't list (still the same row; recorded and flagged). */
    snapshotKnown?: boolean;
    /** Effort carried in the name: OpenCode "#high", Cursor "[effort=high]", a level in a launch name or suffix ("gemini-4-argon-high"). */
    effortHint?: string;
    /** The name asked for fast serving mode (Cursor "-fast"): recorded, not part of the identity. */
    fast?: boolean;
    /** Served by the harness vendor's own service (OpenCode Zen), and whether as a free variant. */
    hosted?: HostedVariant;
  }
  | { ok: false; raw: string; error: string; suggestions: string[]; effortHint?: string };

export type HarnessResolution =
  | { ok: true; id: string; harness: HarnessEntry; raw: string; launcher?: LauncherEntry }
  | { ok: false; raw: string; error: string; suggestions: string[] };

export type EffortResolution =
  | { ok: true; effort: Effort; raw: string; warning?: string }
  | { ok: false; raw: string; error: string; allowed: Effort[] };

/** What a seat declared, as typed. */
export interface DeclaredSeat { harness?: string; model?: string; effort?: string }

/**
 * What event_start records for a seat: canonical values plus the raw declared strings (immutable; re-resolved at
 * export, so a registry fix applies to old events). Whether the seat is listed is not stored: the export decides
 * it from the raw strings with the registry of the day (`SeatResolution.listed` says it at creation time).
 */
export interface SeatMetaRecord {
  harness: string;
  model: string;
  effort: Effort;
  /** The app that started the harness (t3-code), when the seat declared one: seat details, never the identity. */
  launcher?: string;
  harness_declared?: string;
  model_declared?: string;
  effort_declared?: string;
}

export type SeatResolution =
  | {
    ok: true; seat: SeatMetaRecord; listed: boolean; test: boolean; warnings: string[]; model?: ModelEntry; harness?: HarnessEntry;
    /** The level came from the model name (Antigravity "gemini-4-argon-high", OpenCode "#high"), not a separate effort. */
    effortFromName?: boolean;
    fast?: boolean;
    hosted?: HostedVariant;
  }
  | { ok: false; field: 'harness' | 'model' | 'effort'; error: string; suggestions: string[] };

/** Harness usage as the bundles carry it (usage-<seat>.json) or the site reads it from a transcript. */
export interface UsageLike {
  model_ids?: string[];
  /** Output tokens per reported model id (newer usage files; Claude Code's modelUsage). */
  model_output_tokens?: Record<string, number>;
}

export interface PrimaryModel {
  /** Canonical id of the model that did the work; null when the usage doesn't say (no ids, or a tie without tokens). */
  id: string | null;
  /** The id as the harness reported it (a dated snapshot shows here). */
  raw: string | null;
  listed: boolean;
  ambiguous?: boolean;
  candidates: Array<{ id: string; raw: string; listed: boolean; output_tokens: number | null; helper: boolean }>;
}

export type ModelVerification = 'verified' | 'self-reported' | 'mismatch' | 'unlisted';

export interface VerificationResult {
  status: ModelVerification;
  reason: string;
  /** Canonical id of the primary model in the usage, when there was one. */
  reported?: string;
  reported_raw?: string;
  /** The usage named a dated snapshot of the declared model. */
  snapshot?: string;
  snapshot_known?: boolean;
}

// ---------------------------------------------------------------------------
// Matching helpers

/** The key names are compared by: lowercase letters and digits only. */
export const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** A display-safe slug for names the registry doesn't know (identity keys of Unlisted seats). */
export const slugOf = (s: string): string =>
  s.trim().toLowerCase().replace(/[^a-z0-9.@+_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'unknown';

const DATE_SUFFIX = /^(.+?)[-@_]?((?:19|20)\d{2}-?[01]\d-?[0-3]\d)$/;

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/** YYYY-MM-DD (UTC) of a timestamp, Date or date string; today when absent. */
export function dayOf(at?: number | string | Date): string {
  if (typeof at === 'string' && /^\d{4}-\d{2}-\d{2}/.test(at)) return at.slice(0, 10);
  const d = at == null ? new Date() : new Date(at);
  return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
}

/** Numeric parts of a version string ("2.1.306 (Claude Code)" → [2, 1, 306]; "2026.10.01-e373342" → [2026, 10, 1]). */
export function parseVersion(v: string | null | undefined): number[] | null {
  const m = /(\d+(?:\.\d+)+|\d+)/.exec(String(v ?? ''));
  return m ? m[1]!.split('.').map(Number) : null;
}

export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// The registry

export class Registry {
  readonly providers: Record<string, ProviderEntry>;
  readonly efforts: EffortEntry[];
  readonly models: ModelEntry[];
  readonly harnesses: HarnessEntry[];
  readonly launchers: LauncherEntry[];
  private byKey = new Map<string, { model: ModelEntry; via: MatchVia }>();
  private floating = new Map<string, Array<{ model: ModelEntry; from: string; until?: string }>>();
  private launchKeys = new Map<string, Map<string, { model: ModelEntry; effort?: string }>>(); // harness → squash(launch string) → model (+ level)
  private harnessByKey = new Map<string, HarnessEntry>();
  private launcherByKey = new Map<string, LauncherEntry>();
  private effortByKey = new Map<string, Effort>();
  private prefixes: string[];

  constructor(data: RegistryData) {
    this.providers = data.providers;
    this.efforts = data.effort_scale;
    this.models = data.models;
    this.harnesses = data.harnesses;
    this.launchers = data.launchers ?? [];
    this.prefixes = Object.values(data.providers).flatMap((p) => p.prefixes).sort((a, b) => b.length - a.length);
    // First writer wins, so a collision (caught by validateRegistry in CI) never changes an existing mapping.
    const put = (name: string, model: ModelEntry, via: MatchVia) => {
      const k = squash(name);
      if (k && !this.byKey.has(k)) this.byKey.set(k, { model, via });
    };
    for (const m of data.models) put(m.id, m, 'id');
    for (const m of data.models) put(m.display, m, 'display');
    for (const m of data.models) for (const a of m.aliases) put(a, m, 'alias');
    for (const m of data.models) for (const s of m.snapshots) put(s, m, 'snapshot');
    for (const m of data.models) {
      for (const f of m.floating_aliases) {
        const k = squash(f.alias);
        if (!this.floating.has(k)) this.floating.set(k, []);
        this.floating.get(k)!.push({ model: m, from: f.from, ...(f.until ? { until: f.until } : {}) });
      }
      for (const [h, s] of Object.entries(m.launch)) {
        if (!this.launchKeys.has(h)) this.launchKeys.set(h, new Map());
        const keys = this.launchKeys.get(h)!;
        // A launch string with {effort} stands for one name per level (claude-opus-5-5-high, gemini-3.8-flash-medium).
        if (s.includes('{effort}')) for (const e of m.efforts) keys.set(squash(this.stripPrefixes(s.replaceAll('{effort}', m.launch_effort_words?.[h]?.[e] ?? e).toLowerCase()).text), { model: m, effort: e });
        else keys.set(squash(this.stripPrefixes(s.toLowerCase()).text), { model: m });
      }
    }
    for (const h of data.harnesses) for (const n of [h.id, h.display, ...h.aliases]) if (!this.harnessByKey.has(squash(n))) this.harnessByKey.set(squash(n), h);
    for (const l of this.launchers) for (const n of [l.id, l.display, ...l.aliases]) if (!this.launcherByKey.has(squash(n))) this.launcherByKey.set(squash(n), l);
    for (const e of data.effort_scale) for (const n of [e.id, ...e.aliases]) this.effortByKey.set(squash(n), e.id);
  }

  /**
   * A launcher starting a harness: "t3-code:claude-code", "T3 Code (Claude Code)", "Claude Code via T3 Code". The
   * seat is the harness (its effort scale, defaults, launch strings and detection); the launcher is recorded beside it.
   */
  private resolveLaunched(raw: string): { harness: HarnessEntry; launcher: LauncherEntry } | undefined {
    const t = raw.trim();
    const forms: Array<[string, string]> = [];
    let m = /^(.+?)\s*\((.+)\)$/.exec(t);
    if (m) forms.push([m[1]!, m[2]!]);
    m = /^(.+?)\s*[:+]\s*(.+)$/.exec(t);
    if (m) forms.push([m[1]!, m[2]!]);
    m = /^(.+?)\s+via\s+(.+)$/i.exec(t);
    if (m) forms.push([m[2]!, m[1]!]);
    for (const [a, b] of forms) {
      const l = this.launcherByKey.get(squash(a));
      const h = this.harnessByKey.get(squash(b));
      if (l && h && l.launches.includes(h.id)) return { harness: h, launcher: l };
    }
    return undefined;
  }

  launcher(id: string): LauncherEntry | undefined {
    return this.launcherByKey.get(squash(id));
  }

  /** The harness whose launch strings and defaults apply (kept as a seam: every harness is its own). */
  launchKey(h: HarnessEntry): string {
    return h.id;
  }

  model(id: string): ModelEntry | undefined {
    return this.models.find((m) => m.id === id);
  }

  harness(id: string): HarnessEntry | undefined {
    const h = this.harnesses.find((x) => x.id === id);
    if (h) return h;
    const r = this.resolveHarness(id);
    return r.ok ? r.harness : undefined;
  }

  private stripPrefixes(s: string): { text: string; provider?: string } {
    let text = s;
    let provider: string | undefined;
    for (let changed = true; changed;) {
      changed = false;
      for (const p of this.prefixes) {
        if (text.startsWith(p) && text.length > p.length) {
          text = text.slice(p.length);
          provider ??= Object.entries(this.providers).find(([, v]) => v.prefixes.includes(p))?.[0];
          changed = true;
          break;
        }
      }
    }
    return { text, provider };
  }

  /** Lowercase, trimmed, with an effort hint ("#high", "[effort=high]") and provider prefixes taken off. */
  private clean(raw: string): { text: string; effortHint?: string } {
    let s = raw.trim().toLowerCase();
    let effortHint: string | undefined;
    const br = /^(.*?)\s*\[([^\]]*)\]\s*$/.exec(s);
    if (br) {
      s = br[1]!;
      for (const part of br[2]!.split(',')) {
        const [k, v] = part.split('=').map((x) => x.trim());
        if (v && /^(effort|reasoning|reasoning[_-]?effort|thinking)$/.test(k ?? '')) effortHint = v;
      }
    }
    const hash = s.indexOf('#');
    if (hash > 0) {
      effortHint ??= s.slice(hash + 1).trim() || undefined;
      s = s.slice(0, hash);
    }
    s = s.replace(/^(?:[a-z0-9-]+:)?\/\//, ''); // no URLs
    return { text: this.stripPrefixes(s.trim()).text, ...(effortHint ? { effortHint } : {}) };
  }

  /**
   * A declared or reported model name → its canonical id. `at` (event start) picks what a floating alias such as
   * "sonnet" meant on that day; `harness` adds that harness's own launch strings (Cursor names, for example).
   */
  resolveModel(raw: string | undefined | null, harness?: string, opts: { at?: number | string | Date } = {}): ModelResolution {
    const input = String(raw ?? '');
    const { text, effortHint } = this.clean(input);
    const hint = effortHint ? { effortHint } : {};
    if (!squash(text)) return { ok: false, raw: input, error: 'no model given', suggestions: [], ...hint };
    const hr = harness ? this.resolveHarness(harness) : undefined;
    // A level in the name itself (a launch string or level suffix) and one after it ("#low") must agree.
    const twoLevels = (named: string | undefined, id: string): ModelResolution | undefined => {
      const a = effortHint ? this.normalizeEffort(effortHint) : undefined;
      const b = named ? this.normalizeEffort(named) : undefined;
      return a?.ok && b?.ok && a.effort !== b.effort
        ? { ok: false, raw: input, suggestions: [id], error: `"${input.trim()}" names two effort levels (${b.effort} in the name, ${a.effort} after it)`, ...hint }
        : undefined;
    };
    const exact = this.lookup(text, harness, opts.at);
    if (exact) {
      // A launch string under the harness's own service (OpenCode Zen's opencode/<id>) is still a hosted seat.
      const host = hr?.ok ? hr.harness.hosted : undefined;
      const hosted = host && text.startsWith(host.prefix) ? { hosted: { service: host.display, free: !!host.free_suffix && text.endsWith(host.free_suffix) } } : {};
      return twoLevels(exact.effortHint, exact.id) ?? { ok: true, raw: input, ...hint, ...exact, ...hosted };
    }
    // The harness's own name forms: a level suffix (Antigravity), fast mode (Cursor), its model service (OpenCode Zen).
    const form = hr?.ok ? this.harnessForm(text, hr.harness, opts.at) : undefined;
    if (form && !form.ok) return { ok: false, raw: input, error: form.error, suggestions: form.suggestions, ...hint };
    if (form) return twoLevels(form.hit.effortHint, form.hit.id) ?? { ok: true, raw: input, ...hint, ...form.hit };
    // A dated snapshot of a known model: same row, recorded and flagged.
    const d = DATE_SUFFIX.exec(text);
    if (d) {
      const base = this.lookup(d[1]!, harness, opts.at, false);
      if (base) return { ok: true, raw: input, id: base.id, model: base.model, via: 'snapshot', snapshot: text, snapshotKnown: false, ...hint };
    }
    const k = squash(text);
    const fl = this.floating.get(k);
    if (fl) {
      const when = fl.map((f) => `${f.model.id} from ${f.from}${f.until ? ` until ${f.until}` : ''}`).join('; ');
      return {
        ok: false, raw: input, suggestions: fl.map((f) => f.model.id),
        error: `"${input.trim()}" names whichever model was current at the time, and the registry has none for ${dayOf(opts.at)} (${when}). Use the exact model id.`,
        ...hint,
      };
    }
    // Without a harness, a harness-specific name ("gemini-4-argon-high", "claude-opus-5-5-high") isn't resolved, but
    // the error says what it would be.
    const guess = hr?.ok ? undefined : this.guessHarnessForm(text, opts.at);
    if (guess) {
      return {
        ok: false, raw: input, suggestions: [guess.id], ...hint,
        error: `unknown model "${input.trim()}" without a harness: it reads as ${guess.id} at effort ${guess.level}, the way ${guess.harnesses.join(' and ')} name${guess.harnesses.length > 1 ? '' : 's'} models; give the harness (e.g. ${guess.ids[0]}) to resolve it`,
      };
    }
    return { ok: false, raw: input, error: `unknown model "${input.trim()}"`, suggestions: this.suggestModels(k), ...hint };
  }

  /** Words for the levels in a harness's model names, squashed, longest first (so "xhigh" is tried before "high"). */
  private levelWords(h: HarnessEntry): Array<[string, Effort]> {
    const words = new Map<string, Effort>();
    for (const e of this.efforts) if (isConcreteEffort(e.id)) for (const n of [e.id, ...e.aliases]) words.set(squash(n), e.id);
    for (const [n, e] of Object.entries(h.effort?.values ?? {})) if (isConcreteEffort(e)) words.set(squash(n), e);
    return [...words.entries()].filter(([w]) => w).sort((a, b) => b[0].length - a[0].length);
  }

  /**
   * A name in one of the harness's own forms → the registry model:
   *   hosted        "opencode/glm-5.3-flash-free": the harness vendor's model service (OpenCode Zen), free variant flagged
   *   fast_suffix   "grok-4.7-xhigh-fast": fast serving mode (Cursor), recorded, not part of the identity
   *   name_suffix   "gemini-4-argon-high": every model name carries its level (Antigravity), for every registry model
   * Undefined when none applies; an error when the model is known but doesn't have the level the name gives.
   */
  private harnessForm(text: string, h: HarnessEntry, at: number | string | Date | undefined):
    | { ok: true; hit: { id: string; model: ModelEntry; via: MatchVia; effortHint?: string; fast?: boolean; hosted?: HostedVariant; snapshot?: string; snapshotKnown?: boolean } }
    | { ok: false; error: string; suggestions: string[] }
    | undefined {
    let t = text;
    const extra: { fast?: boolean; hosted?: HostedVariant } = {};
    const host = h.hosted;
    if (host && t.startsWith(host.prefix) && t.length > host.prefix.length) {
      t = this.stripPrefixes(t.slice(host.prefix.length)).text;
      const free = !!host.free_suffix && t.endsWith(host.free_suffix) && t.length > host.free_suffix.length;
      if (free) t = t.slice(0, -host.free_suffix!.length);
      extra.hosted = { service: host.display, free };
    }
    const fs = h.effort?.fast_suffix;
    if (fs && t.endsWith(fs) && t.length > fs.length) {
      t = t.slice(0, -fs.length);
      extra.fast = true;
    }
    if (t !== text) {
      const hit = this.lookup(t, h.id, at);
      if (hit) return { ok: true, hit: { ...hit, ...extra } };
    }
    const tpl = h.effort?.name_suffix;
    if (!tpl) return undefined;
    const [pre = '', post = ''] = tpl.split('{effort}');
    const k = squash(t);
    for (const [w, e] of this.levelWords(h)) {
      const tail = squash(pre) + w + squash(post);
      if (!k.endsWith(tail) || k.length === tail.length) continue;
      const hit = this.lookup(k.slice(0, -tail.length), h.id, at);
      if (!hit || (hit.effortHint && hit.effortHint !== e)) continue;
      if (!hit.model.efforts.includes(e)) {
        const levels = this.launchableEfforts(hit.model, h);
        return {
          ok: false, suggestions: levels.map((l) => `${hit.model.id}${tpl.replaceAll('{effort}', l)}`),
          error: `${hit.model.display} has no ${e} level in ${h.display}${levels.length ? `; it has ${levels.join(', ')}` : ''}`,
        };
      }
      return { ok: true, hit: { id: hit.model.id, model: hit.model, via: 'level-suffix', effortHint: e, ...extra } };
    }
    return undefined;
  }

  /** A name that only a harness's own forms resolve (no harness given): which model and level it would be, for the error. */
  private guessHarnessForm(text: string, at: number | string | Date | undefined): { id: string; level: string; harnesses: string[]; ids: string[] } | undefined {
    const k = squash(text);
    const found = new Map<string, { id: string; level: string; harnesses: string[]; ids: string[] }>();
    const add = (id: string, level: string, h: HarnessEntry) => {
      const key = `${id}|${level}`;
      const g = found.get(key) ?? { id, level, harnesses: [], ids: [] };
      if (!g.ids.includes(h.id)) (g.harnesses.push(h.display), g.ids.push(h.id));
      found.set(key, g);
    };
    for (const h of this.harnesses) {
      const l = this.launchKeys.get(h.id)?.get(k);
      if (l?.effort) add(l.model.id, l.effort, h);
      const f = h.effort?.name_suffix ? this.harnessForm(text, h, at) : undefined;
      if (f?.ok && f.hit.effortHint) add(f.hit.id, f.hit.effortHint, h);
    }
    return found.size === 1 ? [...found.values()][0] : undefined;
  }

  private lookup(text: string, harness: string | undefined, at: number | string | Date | undefined, allowFloating = true): { id: string; model: ModelEntry; via: MatchVia; snapshot?: string; snapshotKnown?: boolean; effortHint?: string } | undefined {
    const k = squash(text);
    const hit = this.byKey.get(k);
    if (hit) return { id: hit.model.id, model: hit.model, via: hit.via, ...(hit.via === 'snapshot' ? { snapshot: text, snapshotKnown: true } : {}) };
    const h = harness ? this.resolveHarness(harness) : undefined;
    const launched = h?.ok ? this.launchKeys.get(this.launchKey(h.harness))?.get(k) : undefined;
    if (launched) return { id: launched.model.id, model: launched.model, via: 'launch', ...(launched.effort ? { effortHint: launched.effort } : {}) };
    if (!allowFloating) return undefined;
    const day = dayOf(at);
    const f = this.floating.get(k)?.find((x) => x.from <= day && (!x.until || day < x.until));
    return f ? { id: f.model.id, model: f.model, via: 'floating' } : undefined;
  }

  private suggestModels(k: string): string[] {
    const scored: Array<{ id: string; d: number }> = [];
    const names = (m: ModelEntry) => [m.id, m.display, ...m.aliases, ...m.snapshots, ...m.floating_aliases.map((f) => f.alias)];
    for (const m of this.models) {
      let best = Infinity;
      for (const n of names(m)) {
        const s = squash(n);
        best = Math.min(best, levenshtein(k, s), s.length >= 4 && k.length >= 4 && (s.includes(k) || k.includes(s)) ? 1.5 : Infinity);
      }
      if (best <= Math.max(2, Math.floor(k.length / 4))) scored.push({ id: m.id, d: best });
    }
    return scored.sort((a, b) => a.d - b.d || a.id.localeCompare(b.id)).slice(0, 3).map((x) => x.id);
  }

  /** "Claude Code", "claude", "codex-cli" → the canonical harness id. */
  resolveHarness(raw: string | undefined | null): HarnessResolution {
    const input = String(raw ?? '');
    const k = squash(input);
    if (!k) return { ok: false, raw: input, error: 'no harness given', suggestions: [] };
    const h = this.harnessByKey.get(k);
    if (h) return { ok: true, id: h.id, harness: h, raw: input };
    const launched = this.resolveLaunched(input);
    if (launched) return { ok: true, id: launched.harness.id, harness: launched.harness, raw: input, launcher: launched.launcher };
    const l = this.launcherByKey.get(k);
    if (l) {
      const opts = l.launches.map((h) => `${l.id}:${h}`);
      return { ok: false, raw: input, error: `${l.display} is an app that starts harnesses, not a harness: declare the harness it runs, e.g. ${opts.join(', ')}`, suggestions: opts };
    }
    const sugg = this.harnesses
      .map((x) => ({ id: x.id, d: Math.min(...[x.id, x.display, ...x.aliases].map((n) => levenshtein(k, squash(n)))) }))
      .filter((x) => x.d <= Math.max(2, Math.floor(k.length / 4)))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3)
      .map((x) => x.id);
    return { ok: false, raw: input, error: `unknown harness "${input.trim()}"`, suggestions: sugg };
  }

  /**
   * A declared effort → the canonical scale. A harness without an effort setting records "default" (with a warning
   * when something else was given); a model that doesn't support the level is an error.
   */
  normalizeEffort(raw: string | undefined | null, model?: string | ModelEntry, harness?: string | HarnessEntry): EffortResolution {
    const input = String(raw ?? '');
    const r = input.trim().toLowerCase();
    const h = typeof harness === 'string' ? (this.resolveHarness(harness).ok ? (this.resolveHarness(harness) as { harness: HarnessEntry }).harness : undefined) : harness;
    const m = typeof model === 'string' ? (() => {
      const x = this.resolveModel(model, h?.id);
      return x.ok ? x.model : undefined;
    })() : model;
    const scale = this.efforts.map((e) => e.id);
    if (!r) return { ok: true, effort: 'default', raw: input };
    const effort = h?.effort?.values[r] ?? this.effortByKey.get(squash(r));
    if (!effort) {
      return { ok: false, raw: input, error: `unknown effort "${input.trim()}": use one of ${scale.join(', ')}`, allowed: m?.efforts.length ? [...m.efforts, 'default'] : scale };
    }
    // "unknown" / "I don't know" is a declaration that resolves like "default" (the documented harness default, else Unknown).
    if (effort === 'default' || effort === 'unknown') return { ok: true, effort: 'default', raw: input };
    if (h && h.kind === 'test') return { ok: true, effort: 'default', raw: input };
    if (h && !h.effort) return { ok: true, effort: 'default', raw: input, warning: `${h.display} has no effort setting; recorded as "default"` };
    if (m && !m.efforts.length) return { ok: true, effort: 'default', raw: input, warning: `${m.display} has no effort setting; recorded as "default"` };
    if (m && !m.efforts.includes(effort)) {
      return { ok: false, raw: input, error: `${m.display} supports effort ${m.efforts.join(', ')} (or default), not "${input.trim()}"`, allowed: [...m.efforts, 'default'] };
    }
    return { ok: true, effort, raw: input };
  }

  /**
   * Resolve a declared seat (harness / model / effort) for event creation, the lobby and the CLI. Unknown models
   * and harnesses fail with suggestions, unless `allowUnlisted` (private tables): then the seat is recorded with
   * `listed: false` and stays unrated until the registry knows the name. Test harnesses (the scripted player)
   * pass their model through.
   */
  resolveSeat(d: DeclaredSeat, opts: { allowUnlisted?: boolean; at?: number | string | Date; requireEffort?: boolean } = {}): SeatResolution {
    const warnings: string[] = [];
    const declared = (v?: string) => (v != null && v.trim() ? v.trim() : undefined);
    const rawH = declared(d.harness);
    const rawM = declared(d.model);
    const rawE = declared(d.effort);
    if (!rawH) return { ok: false, field: 'harness', error: 'which harness? e.g. "claude-code", "codex", "gemini-cli", "opencode", "cursor"', suggestions: [] };
    const h = this.resolveHarness(rawH);
    let listed = true;
    let harnessId: string;
    if (h.ok) harnessId = h.id;
    else if (opts.allowUnlisted) {
      harnessId = slugOf(rawH);
      listed = false;
      warnings.push(`harness "${rawH}" isn't in the registry: the seat is Unlisted and unrated until it is`);
    } else {
      return { ok: false, field: 'harness', error: `${h.error}${h.suggestions.length ? ` (did you mean ${h.suggestions.join(', ')}?)` : ''}. ${REGISTRY_PR_HINT}`, suggestions: h.suggestions };
    }
    const keepRaw = (canon: string, raw: string | undefined, key: 'harness_declared' | 'model_declared' | 'effort_declared') => (raw != null && raw !== canon ? { [key]: raw } : {});
    if (h.ok && h.harness.kind === 'test') {
      const model = slugOf(rawM ?? 'random');
      return {
        ok: true, listed: true, test: true, warnings, harness: h.harness,
        seat: { harness: harnessId, model, effort: 'default', ...keepRaw(harnessId, rawH, 'harness_declared'), ...keepRaw(model, rawM, 'model_declared'), ...keepRaw('default', rawE, 'effort_declared') },
      };
    }
    if (!rawM) return { ok: false, field: 'model', error: `which model? e.g. "${h.ok ? harnessId : 'claude-code'}/claude-opus-5-5/high"`, suggestions: [] };
    const m = this.resolveModel(rawM, h.ok ? harnessId : undefined, { at: opts.at });
    let modelId: string;
    if (m.ok) {
      modelId = m.id;
      if (m.via === 'snapshot' && m.snapshotKnown === false) warnings.push(`"${rawM}" is a dated snapshot the registry doesn't list; it counts as ${m.id} and is flagged`);
      if (m.model.status === 'deprecated' || m.model.status === 'retired') warnings.push(`${m.model.display} is ${m.model.status}`);
    } else if (opts.allowUnlisted) {
      modelId = slugOf(this.clean(rawM).text || rawM);
      listed = false;
      warnings.push(`model "${rawM}" isn't in the registry: the seat is Unlisted and unrated until it is`);
    } else {
      const sugg = m.suggestions.length ? ` Did you mean ${m.suggestions.join(', ')}?` : '';
      return { ok: false, field: 'model', error: `${m.error}.${sugg} ${REGISTRY_PR_HINT}`, suggestions: m.suggestions };
    }
    // A level in the model name ("gemini-4-argon-high", "#high") is the seat's level. A separate effort may repeat it;
    // one that names another level is refused (which one ran can't be told), and "default" or "unknown" defers to it.
    let effortRaw = rawE ?? m.effortHint;
    let effortFromName = !rawE && !!m.effortHint;
    if (m.ok && m.effortHint && rawE) {
      const named = this.normalizeEffort(m.effortHint, m.model, h.ok ? h.harness : undefined);
      const given = this.normalizeEffort(rawE, m.model, h.ok ? h.harness : undefined);
      if (named.ok && isConcreteEffort(named.effort) && given.ok) {
        if (isConcreteEffort(given.effort) && given.effort !== named.effort) {
          return {
            ok: false, field: 'effort', suggestions: [named.effort],
            error: `the model name "${rawM}" sets effort ${named.effort}, but effort "${rawE}" was declared: declare ${named.effort}, or use the model name for ${given.effort}`,
          };
        }
        if (!isConcreteEffort(given.effort)) (effortRaw = m.effortHint, effortFromName = true);
      }
    }
    const e = this.normalizeEffort(effortRaw, m.ok ? m.model : undefined, h.ok ? h.harness : undefined);
    if (!e.ok) return { ok: false, field: 'effort', error: e.error, suggestions: e.allowed };
    if (e.warning) warnings.push(e.warning);
    if (m.ok && m.hosted) {
      warnings.push(`"${rawM}" is ${m.model.display} served by ${m.hosted.service}${m.hosted.free ? ' as a free variant' : ''}: it counts as ${m.id} (the same row) and is flagged as ${m.hosted.free ? 'a hosted free variant' : 'hosted'}`);
    }
    // Rated tables need a concrete level wherever the harness can set one (METHODOLOGY §2.1).
    if (opts.requireEffort && e.effort === 'default' && h.ok && h.harness.effort && m.ok && m.model.efforts.length) {
      const levels = this.launchableEfforts(m.model, h.harness);
      const rec = this.recommendedEffort(m.model.id, h.id);
      return {
        ok: false, field: 'effort', suggestions: levels,
        error: `choose an effort level for ${m.model.display} on ${h.harness.display}: ${levels.join(', ')} (recommended: ${rec.level}; ${rec.reason})`,
      };
    }
    return {
      ok: true, listed, test: false, warnings, ...(m.ok ? { model: m.model } : {}), ...(h.ok ? { harness: h.harness } : {}),
      ...(effortFromName && isConcreteEffort(e.effort) ? { effortFromName: true } : {}),
      ...(m.ok && m.fast ? { fast: true } : {}), ...(m.ok && m.hosted ? { hosted: m.hosted } : {}),
      seat: {
        harness: harnessId, model: modelId, effort: e.effort, ...(h.ok && h.launcher ? { launcher: h.launcher.id } : {}),
        ...keepRaw(harnessId, rawH, 'harness_declared'), ...keepRaw(modelId, rawM, 'model_declared'), ...keepRaw(e.effort, rawE, 'effort_declared'),
      },
    };
  }

  private isHelper(id: string, raw: string, h?: HarnessEntry): boolean {
    return !!h?.helper_models.some((p) => {
      const test = (s: string) => (p.endsWith('*') ? s.startsWith(p.slice(0, -1)) : s === p);
      return test(id) || test(raw.toLowerCase());
    });
  }

  /**
   * The model that played a seat, from harness usage: the one with the most output tokens, ignoring the harness's
   * helper models (Claude Code's background Haiku) unless nothing else ran. Ids are canonicalized first, so a
   * snapshot and its canonical id add up. Without per-model tokens, a single non-helper id decides; several are
   * ambiguous (`id: null`).
   */
  primaryModelFromUsage(usage: UsageLike | null | undefined, harness?: string, opts: { at?: number | string | Date } = {}): PrimaryModel {
    const none: PrimaryModel = { id: null, raw: null, listed: false, candidates: [] };
    if (!usage) return none;
    const h = harness ? this.resolveHarness(harness) : undefined;
    const he = h?.ok ? h.harness : undefined;
    const tokens = usage.model_output_tokens && Object.keys(usage.model_output_tokens).length ? usage.model_output_tokens : undefined;
    const raws = tokens ? Object.keys(tokens) : (usage.model_ids ?? []).filter((x) => typeof x === 'string' && x.trim());
    const agg = new Map<string, PrimaryModel['candidates'][number]>();
    for (const raw of raws) {
      const r = this.resolveModel(raw, he?.id, opts);
      const id = r.ok ? r.id : slugOf(this.clean(raw).text || raw);
      const n = tokens ? Number(tokens[raw]) || 0 : null;
      const prev = agg.get(id);
      if (prev) {
        if (n != null) prev.output_tokens = (prev.output_tokens ?? 0) + n;
        // Keep the raw id that carried the most tokens (it's the one that shows the snapshot).
        if (n != null && n > (Number(tokens?.[prev.raw]) || 0)) prev.raw = raw;
      } else agg.set(id, { id, raw, listed: r.ok, output_tokens: n, helper: this.isHelper(id, raw, he) });
    }
    const candidates = [...agg.values()];
    if (!candidates.length) return none;
    const main = candidates.filter((c) => !c.helper);
    const pool = main.length ? main : candidates;
    if (tokens) {
      const sorted = [...pool].sort((a, b) => (b.output_tokens ?? 0) - (a.output_tokens ?? 0) || a.id.localeCompare(b.id));
      const top = sorted[0]!;
      if (sorted.length > 1 && sorted[1]!.output_tokens === top.output_tokens) return { ...none, ambiguous: true, candidates };
      return { id: top.id, raw: top.raw, listed: top.listed, candidates };
    }
    if (pool.length === 1) return { id: pool[0]!.id, raw: pool[0]!.raw, listed: pool[0]!.listed, candidates };
    return { ...none, ambiguous: true, candidates };
  }

  /**
   * Does the harness usage confirm the declared model? (METHODOLOGY §2.1)
   *   verified       the primary model in the usage is the declared model (same canonical id)
   *   self-reported  no usage, or usage without model ids (the harness doesn't report it): rated, labeled
   *   mismatch       the usage shows another model, or several without saying which did the work: not rated
   *   unlisted       the declared model isn't in the registry: not rated until it is
   */
  verifySeatModel(declared: { model?: string; harness?: string; at?: number | string | Date }, usage: UsageLike | null | undefined): VerificationResult {
    const d = this.resolveModel(declared.model, declared.harness, { at: declared.at });
    if (!d.ok) return { status: 'unlisted', reason: `declared model "${declared.model ?? ''}" isn't in the registry` };
    if (!usage) return { status: 'self-reported', reason: 'no harness usage was submitted for this seat' };
    const p = this.primaryModelFromUsage(usage, declared.harness, { at: declared.at });
    if (!p.candidates.length) return { status: 'self-reported', reason: 'the harness usage has no model ids' };
    if (p.ambiguous || !p.id) {
      return { status: 'mismatch', reason: `the harness reported several models (${p.candidates.map((c) => c.raw).join(', ')}) without saying which did the work` };
    }
    const r = this.resolveModel(p.raw, declared.harness, { at: declared.at });
    const snap = r.ok && r.snapshot ? { snapshot: r.snapshot, snapshot_known: r.snapshotKnown ?? false } : {};
    if (p.id === d.id) return { status: 'verified', reason: `harness usage shows ${p.raw}`, reported: p.id, reported_raw: p.raw!, ...snap };
    return { status: 'mismatch', reason: `declared ${d.id}, but the harness usage shows ${p.raw} doing the work`, reported: p.id, reported_raw: p.raw!, ...snap };
  }

  /** Levels a harness can start a model at: the model's levels the harness takes (and that have a launch string). */
  launchableEfforts(model: ModelEntry, h: HarnessEntry): Effort[] {
    if (!h.effort) return [];
    const takes = new Set(Object.values(h.effort.values));
    return model.efforts.filter((e) => takes.has(e) && isConcreteEffort(e));
  }

  /**
   * The documented default effort of a harness for a model at a harness version. Entries bounded by versions need
   * the version; null when it isn't documented or the version is unknown (then the effort is Unknown).
   */
  harnessDefaultEffort(harness: string, model: string, version?: string | null, opts: { current?: boolean } = {}): (EffortDefault & { level: Effort }) | null {
    const h = this.resolveHarness(harness);
    if (!h.ok) return null;
    const m = this.resolveModel(model, h.id);
    const id = m.ok ? m.id : model;
    const v = version ? parseVersion(version) : null;
    for (const d of h.harness.effort_defaults ?? []) {
      if (!d.models.some((p) => (p.endsWith('*') ? id.startsWith(p.slice(0, -1)) : id === p))) continue;
      if (d.since || d.until) {
        // `current`: the harness as installed today (an open-ended range), for recommendations rather than records.
        if (!v && opts.current && !d.until) return d;
        if (!v) continue;
        if (d.since && compareVersions(v, parseVersion(d.since)!) < 0) continue;
        if (d.until && compareVersions(v, parseVersion(d.until)!) >= 0) continue;
      }
      return d;
    }
    return null;
  }

  /**
   * The level the bench CLI preselects: where the harness can set effort, `high` when the model has it (one common
   * level makes rows compare across providers), else the model's API default, else its highest level; where it
   * can't, the harness's documented fixed behavior.
   */
  recommendedEffort(model: string, harness: string): { level: Effort; reason: string; settable: boolean } {
    const h = this.resolveHarness(harness);
    const m = this.resolveModel(model, h.ok ? h.id : undefined);
    if (!h.ok || !m.ok) return { level: 'high', reason: 'High is the common level on the leaderboard', settable: true };
    if (!h.harness.effort) {
      const d = this.harnessDefaultEffort(h.id, m.id, undefined, { current: true });
      return d
        ? { level: d.level, settable: false, reason: `${h.harness.display} has no effort setting; it runs ${m.model.display} at ${this.effortDisplay(d.level)} (documented default)` }
        : { level: 'unknown', settable: false, reason: `${h.harness.display} has no effort setting and its default for ${m.model.display} isn't documented, so the effort is recorded as Unknown` };
    }
    const levels = this.launchableEfforts(m.model, h.harness);
    if (levels.includes('high')) return { level: 'high', settable: true, reason: 'High is the common level on the leaderboard, so this seat compares directly with other models' };
    const def = m.model.default_effort && levels.includes(m.model.default_effort) ? m.model.default_effort : undefined;
    if (def) return { level: def, settable: true, reason: `${m.model.display} has no High level; ${this.effortDisplay(def)} is its default` };
    const top = levels.filter((l) => this.efforts.find((e) => e.id === l)?.rank != null).pop(); // never an unordered level (ultra)
    return top ? { level: top, settable: true, reason: `the highest level ${m.model.display} supports in ${h.harness.display}` } : { level: 'unknown', settable: false, reason: 'no effort levels are listed for this model and harness' };
  }

  /** Command-line arguments that set the level ([] when the level travels in the model string, or can't be set). */
  effortFlag(harness: string, level: string): string[] {
    const h = this.resolveHarness(harness);
    if (!h.ok || !h.harness.effort?.args || !isConcreteEffort(level)) return [];
    const native = Object.entries(h.harness.effort.values).find(([, c]) => c === level)?.[0] ?? level;
    return h.harness.effort.args.map((a) => a.replaceAll('{effort}', native));
  }

  /**
   * How to start a model at a level in a harness: the model string for its model flag (with the level in it where
   * the harness wants it there) and the effort arguments. `model` is null when the registry has no launch string.
   */
  launchSpec(harness: string, model: string, level: string): { model: string | null; args: string[]; settable: boolean } {
    const h = this.resolveHarness(harness);
    const m = this.resolveModel(model, h.ok ? h.id : undefined);
    if (!h.ok || !m.ok) return { model: null, args: [], settable: false };
    // A name under the harness's own model service (OpenCode Zen's opencode/<id>-free) launches as given: the
    // registry's launch string names the model's usual route, which for a free variant is a different (paid) one.
    const named = m.hosted && h.harness.hosted ? this.clean(model).text : undefined;
    const raw = named && named.startsWith(h.harness.hosted!.prefix) ? named : m.model.launch[this.launchKey(h.harness)];
    const settable = !!h.harness.effort && isConcreteEffort(level) && this.launchableEfforts(m.model, h.harness).includes(level as Effort);
    const native = Object.entries(h.harness.effort?.values ?? {}).find(([, c]) => c === level)?.[0] ?? level;
    if (!raw) return { model: null, args: [], settable };
    const word = m.model.launch_effort_words?.[this.launchKey(h.harness)]?.[level as Effort] ?? native;
    if (raw.includes('{effort}')) return { model: settable ? raw.replaceAll('{effort}', word) : null, args: [], settable };
    const tpl = h.harness.effort?.model_template;
    if (tpl && settable) return { model: tpl.replaceAll('{model}', raw).replaceAll('{effort}', native), args: [], settable };
    return { model: raw, args: settable ? this.effortFlag(h.id, level) : [], settable };
  }

  /**
   * The effort that goes into a seat's identity (METHODOLOGY §2.1), in order of evidence:
   *   detected          the harness logs show the level (a different declared level is a Mismatch; the logs win)
   *   declared-explicit the bench CLI started the seat with this level (basis "launch")
   *   self-reported     a person declared this level for a seat they seated by hand
   *   harness-default   "default" / "I don't know": the documented default for that harness version
   *   unknown           none of the above
   */
  resolveSeatEffort(ev: EffortEvidence): ResolvedEffort {
    const h = ev.harness ? this.resolveHarness(ev.harness) : undefined;
    const m = ev.model ? this.resolveModel(ev.model, h?.ok ? h.id : undefined, { at: ev.at }) : undefined;
    const d = this.normalizeEffort(ev.declared, m?.ok ? m.model : undefined, h?.ok ? h.harness : undefined);
    const declared = d.ok && isConcreteEffort(d.effort) ? d.effort : undefined;
    const version = ev.harnessVersion ? { harness_version: ev.harnessVersion } : {};
    const det = ev.detected;
    if (det && det.level != null) {
      const counts = det.counts ?? {};
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      const levels = Object.keys(counts).filter((k) => counts[k]! > 0);
      if (levels.length > 1 && total > 0 && (counts[det.level] ?? 0) / total < 0.9) {
        return {
          effort: 'unknown', source: 'unknown', status: 'mismatch', detected: det.level, ...(declared ? { declared } : {}), ...version,
          reason: `the effort changed during the session (${levels.map((l) => `${l} ×${counts[l]}`).join(', ')}, from ${det.source})`,
        };
      }
      const lv = this.normalizeEffort(det.level);
      if (lv.ok && isConcreteEffort(lv.effort)) {
        const status = declared && declared !== lv.effort ? 'mismatch' : 'verified';
        return {
          effort: lv.effort, source: 'detected', status, detected: lv.effort, ...(declared ? { declared } : {}), ...version, ...(det.fast ? { fast: true } : {}),
          reason: status === 'mismatch' ? `declared ${declared}, but the harness logs (${det.source}) show ${lv.effort}` : `the harness logs (${det.source}) show ${lv.effort}`,
        };
      }
    }
    if (declared) {
      // Set explicitly: started by the bench CLI with the level, or picked in an app seated by hand (Claude Desktop,
      // VS Code…) or a launcher's model picker (T3 Code), whose level is an explicit setting nobody can read back
      // (verification Self-Reported).
      const app = h?.ok ? (h.launcher?.display ?? (h.harness.seated === 'by-hand' ? h.harness.display : undefined)) : undefined;
      const launched = ev.basis === 'launch' || (!!app && ev.basis !== 'self-report');
      return {
        effort: declared, source: launched ? 'declared-explicit' : 'self-reported', status: 'self-reported', declared, ...version,
        reason: launched
          ? !app || ev.basis === 'launch' ? 'set at launch by the bench CLI; the harness logs did not report it'
            : h?.ok && h.launcher ? `picked in ${app}; the logs did not show the level, so it isn't checked`
            : `picked in ${app}, which records no usage logs; not checked`
          : 'declared by the person who seated it; not checked against the harness logs',
      };
    }
    if (h?.ok && m?.ok) {
      const def = this.harnessDefaultEffort(h.id, m.id, ev.harnessVersion);
      if (def) {
        return {
          effort: def.level, source: 'harness-default', status: 'self-reported', ...version, default_source: def.source,
          reason: `no level was set; ${h.harness.display}${ev.harnessVersion ? ` ${ev.harnessVersion}` : ''} defaults ${m.model.display} to ${def.level} (documented)${def.note ? `; ${def.note}` : ''}`,
        };
      }
    }
    const why = !h?.ok ? 'the harness is unknown' : !m?.ok ? 'the model is unknown'
      : (h.harness.effort_defaults ?? []).some((x) => x.models.some((p) => (p.endsWith('*') ? m.id.startsWith(p.slice(0, -1)) : m.id === p))) && !ev.harnessVersion
        ? 'the harness version is unknown, and its default depends on the version'
        : `${h.harness.display}'s default for ${m.model.display} isn't documented`;
    return { effort: 'unknown', source: 'unknown', status: 'self-reported', ...version, reason: `no level was set and ${why}` };
  }

  effortDisplay(e: string): string {
    return this.efforts.find((x) => x.id === e)?.display ?? e;
  }

  modelDisplay(id: string): string {
    return this.model(id)?.display ?? id;
  }

  harnessDisplay(id: string): string {
    return this.harness(id)?.display ?? id;
  }

  /** A declared harness as people read it: "Claude Code", or "Claude Code via T3 Code" when a launcher started it. */
  harnessLabel(raw: string): string {
    const r = this.resolveHarness(raw);
    if (!r.ok) return raw;
    return r.launcher ? `${r.harness.display} via ${r.launcher.display}` : r.harness.display;
  }

  /** "T3 Code" for t3-code; unknown ids show as themselves. */
  launcherDisplay(id: string): string {
    return this.launcher(id)?.display ?? id;
  }

  providerDisplay(id: string): string {
    return this.providers[id]?.display ?? id;
  }
}

/** Identity key (METHODOLOGY §2): canonical harness / canonical model / canonical effort. */
/** A leaderboard identity: the model and its effort level. The harness (and launcher) are seat details (METHODOLOGY §2). */
export const identityKey = (model: string, effort: string): string => `${model}/${effort}`;

// ---------------------------------------------------------------------------
// Validation (CI: npm test -w @mtgdt/registry; the JSON Schema check runs in src/check.ts)

/** Rules the JSON Schema can't express: unique names across models, consistent references, date windows. */
export function validateRegistry(data: RegistryData): string[] {
  const errs: string[] = [];
  const owner = new Map<string, string>(); // squash(name) → "model id (field)"
  const claim = (name: string, who: string, what: string) => {
    const k = squash(name);
    if (!k) return errs.push(`${who}: empty ${what}`);
    const prev = owner.get(k);
    if (prev && !prev.startsWith(`${who} `)) errs.push(`${who}: ${what} "${name}" collides with ${prev} (names are compared without case, spaces, dots or dashes)`);
    else if (!prev) owner.set(k, `${who} (${what} "${name}")`);
  };
  const ids = new Set<string>();
  const scale = new Set(data.effort_scale.map((e) => e.id));
  const harnessIds = new Set(data.harnesses.map((h) => h.id));
  for (const id of EFFORT_IDS) if (!scale.has(id)) errs.push(`effort_scale: missing "${id}"`);
  for (const m of data.models) {
    if (ids.has(m.id)) errs.push(`${m.id}: duplicate model id`);
    ids.add(m.id);
    if (!data.providers[m.provider]) errs.push(`${m.id}: unknown provider "${m.provider}"`);
    claim(m.id, m.id, 'id');
    claim(m.display, m.id, 'display name');
    for (const a of m.aliases) claim(a, m.id, 'alias');
    for (const s of m.snapshots) {
      claim(s, m.id, 'snapshot');
      if (!DATE_SUFFIX.test(s)) errs.push(`${m.id}: snapshot "${s}" doesn't end in a date`);
    }
    for (const e of m.efforts) if (!isConcreteEffort(e)) errs.push(`${m.id}: effort "${e}" is not a level on the canonical scale`);
    if (m.default_effort && !m.efforts.includes(m.default_effort)) errs.push(`${m.id}: default_effort "${m.default_effort}" isn't in its efforts`);
    for (const h of Object.keys(m.launch)) if (!harnessIds.has(h)) errs.push(`${m.id}: launch string for unknown harness "${h}"`);
    for (const [h, words] of Object.entries(m.launch_effort_words ?? {})) {
      if (!m.launch[h]?.includes('{effort}')) errs.push(`${m.id}: launch_effort_words for "${h}", which has no launch string with {effort}`);
      for (const l of Object.keys(words)) if (!m.efforts.includes(l as Effort)) errs.push(`${m.id}: launch_effort_words for "${h}" names level "${l}", which it doesn't list`);
    }
    for (const f of m.floating_aliases) if (f.until && f.until <= f.from) errs.push(`${m.id}: floating alias "${f.alias}" ends before it starts`);
  }
  // Floating aliases: never the same as a fixed name; windows of one alias never overlap.
  const windows = new Map<string, Array<{ id: string; from: string; until?: string }>>();
  for (const m of data.models) {
    for (const f of m.floating_aliases) {
      const k = squash(f.alias);
      if (owner.has(k)) errs.push(`${m.id}: floating alias "${f.alias}" collides with ${owner.get(k)}`);
      if (!windows.has(k)) windows.set(k, []);
      windows.get(k)!.push({ id: m.id, from: f.from, ...(f.until ? { until: f.until } : {}) });
    }
  }
  for (const [k, ws] of windows) {
    const s = [...ws].sort((a, b) => a.from.localeCompare(b.from));
    for (let i = 1; i < s.length; i++) {
      if (!s[i - 1]!.until || s[i - 1]!.until! > s[i]!.from) errs.push(`floating alias "${k}": ${s[i - 1]!.id} and ${s[i]!.id} overlap (set "until" on ${s[i - 1]!.id})`);
    }
  }
  // Model names vs effort names would make "#high" style parsing ambiguous only if a model were called "high".
  for (const e of data.effort_scale) for (const n of [e.id, ...e.aliases]) if (owner.has(squash(n))) errs.push(`effort "${n}" collides with ${owner.get(squash(n))}`);
  // A harness whose names carry the level (Antigravity "<model>-high") must not turn one model's name into another's.
  for (const h of data.harnesses) {
    const tpl = h.effort?.name_suffix;
    if (!tpl) continue;
    for (const m of data.models) {
      for (const l of m.efforts) {
        const k = squash(`${m.id}${tpl.replaceAll('{effort}', l)}`);
        const o = owner.get(k);
        if (o && !o.startsWith(`${m.id} `)) errs.push(`harness ${h.id}: "${m.id}" at ${l} reads as ${o}`);
      }
    }
  }
  const hOwner = new Map<string, string>();
  for (const h of data.harnesses) {
    for (const n of [h.id, h.display, ...h.aliases]) {
      const k = squash(n);
      const prev = hOwner.get(k);
      if (prev && prev !== h.id) errs.push(`harness ${h.id}: name "${n}" collides with harness ${prev}`);
      hOwner.set(k, h.id);
    }
    for (const [v, e] of Object.entries(h.effort?.values ?? {})) if (!scale.has(e)) errs.push(`harness ${h.id}: effort value "${v}" maps to unknown "${e}"`);
    for (const d of h.effort_defaults ?? []) {
      if (!isConcreteEffort(d.level)) errs.push(`harness ${h.id}: default effort "${d.level}" is not a concrete level`);
      if ((d.since && !parseVersion(d.since)) || (d.until && !parseVersion(d.until))) errs.push(`harness ${h.id}: default for ${d.models.join(',')} has an unparsable version bound`);
      for (const p of d.models) if (!p.endsWith('*') && !ids.has(p)) errs.push(`harness ${h.id}: default effort for unknown model "${p}"`);
    }
  }
  for (const l of data.launchers ?? []) {
    for (const n of [l.id, l.display, ...l.aliases]) {
      const prev = hOwner.get(squash(n));
      if (prev && prev !== `launcher ${l.id}`) errs.push(`launcher ${l.id}: name "${n}" collides with ${prev.startsWith('launcher ') ? prev : `harness ${prev}`}`);
      else hOwner.set(squash(n), `launcher ${l.id}`);
    }
    for (const h of l.launches) if (!harnessIds.has(h)) errs.push(`launcher ${l.id}: launches unknown harness "${h}"`);
  }
  return errs;
}

// ---------------------------------------------------------------------------
// The shared instance and convenience functions

export const REGISTRY_DATA: RegistryData = {
  providers: (modelsData as unknown as RegistryData).providers,
  effort_scale: (modelsData as unknown as RegistryData).effort_scale,
  models: (modelsData as unknown as RegistryData).models,
  harnesses: (harnessesData as unknown as { harnesses: HarnessEntry[] }).harnesses,
  launchers: (harnessesData as unknown as { launchers?: LauncherEntry[] }).launchers ?? [],
};

export const registry = new Registry(REGISTRY_DATA);

/** JSON with sorted keys, so the content hash doesn't depend on key order or formatting. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/**
 * The registry's version: a content hash of models.json + harnesses.json (key order and formatting don't matter),
 * so it changes exactly when a name, alias, effort or launch string does. deps/manifest.json points at it; exports
 * can record it to say which registry resolved their identities.
 */
export function registryVersion(data: RegistryData = REGISTRY_DATA): { version: string; sha256: string; models: number; harnesses: number; latest_release: string | null } {
  const sha256 = createHash('sha256').update(canonicalJson({ providers: data.providers, effort_scale: data.effort_scale, models: data.models, harnesses: data.harnesses, launchers: data.launchers ?? [] })).digest('hex');
  const latest = data.models.map((m) => m.released).filter((d): d is string => !!d).sort().pop() ?? null;
  return { version: `sha256-${sha256.slice(0, 12)}`, sha256, models: data.models.length, harnesses: data.harnesses.length, latest_release: latest };
}

export const resolveModel = (raw: string | undefined | null, harness?: string, opts?: { at?: number | string | Date }) => registry.resolveModel(raw, harness, opts);
export const resolveHarness = (raw: string | undefined | null) => registry.resolveHarness(raw);
export const normalizeEffort = (raw: string | undefined | null, model?: string | ModelEntry, harness?: string | HarnessEntry) => registry.normalizeEffort(raw, model, harness);
export const resolveSeat = (d: DeclaredSeat, opts?: { allowUnlisted?: boolean; at?: number | string | Date; requireEffort?: boolean }) => registry.resolveSeat(d, opts);
export const primaryModelFromUsage = (usage: UsageLike | null | undefined, harness?: string, opts?: { at?: number | string | Date }) => registry.primaryModelFromUsage(usage, harness, opts);
export const resolveSeatEffort = (ev: EffortEvidence) => registry.resolveSeatEffort(ev);
export const recommendedEffort = (model: string, harness: string) => registry.recommendedEffort(model, harness);
export const effortFlag = (harness: string, level: string) => registry.effortFlag(harness, level);
export const launchSpec = (harness: string, model: string, level: string) => registry.launchSpec(harness, model, level);
export const harnessDefaultEffort = (harness: string, model: string, version?: string | null) => registry.harnessDefaultEffort(harness, model, version);
export const verifySeatModel = (declared: { model?: string; harness?: string; at?: number | string | Date }, usage: UsageLike | null | undefined) => registry.verifySeatModel(declared, usage);

/** "Claude Sonnet 5.5 · High" (registry display names; raw text for names it doesn't know). */
export function identityLabel(model: string, effort: string, reg: Registry = registry): string {
  return `${reg.modelDisplay(model)} · ${reg.effortDisplay(effort)}`;
}

/** The registry's models a harness can launch (display name + the string to pass), for pickers and docs. */
export function modelsForHarness(harness: string, reg: Registry = registry): Array<{ id: string; display: string; launch: string; efforts: Effort[]; status: ModelEntry['status'] }> {
  const h = reg.resolveHarness(harness);
  if (!h.ok) return [];
  return reg.models
    .filter((m) => m.launch[reg.launchKey(h.harness)] && m.status !== 'retired')
    .map((m) => ({ id: m.id, display: m.display, launch: m.launch[reg.launchKey(h.harness)]!, efforts: reg.launchableEfforts(m, h.harness), status: m.status }));
}
