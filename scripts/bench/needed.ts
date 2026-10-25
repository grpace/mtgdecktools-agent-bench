/**
 * Needed data: the Hub's bounties ("Most Needed", `GET <hub>/api/bounties`, packages/hub/src/contributors.ts
 * openBounties) matched against what this person can run (mix.ts capabilities), so `bench check` and setup's seats
 * question can say which seats are worth most right now ("Your Gemini access is the most needed right now: no Gemini
 * 3.8 Flash games yet").
 *
 * Cheap on purpose: one call, cached for an hour in the config folder (a failed call is remembered for ten minutes),
 * a short timeout, and nothing breaks without it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registry } from '../../packages/registry/src/index.js';
import { CONFIG_DIR, tryJson } from './core.js';
import { effortLabel, modelLabel } from './models.js';
import { printable } from './trust.js';
import type { Capability } from './mix.js';

/** A bounty as `GET /api/bounties` lists it (docs/SITE-DATA.md "Contributors", interface Bounty). */
export interface Bounty {
  id: string;
  kind: 'first_games' | 'provisional' | 'new_set' | 'admin';
  label: string;
  bonus: number;
  text: string;
  model_id?: string;
  model_display?: string;
  identity?: string;
  identity_label?: string;
  group?: string;
  group_label?: string;
  set?: string;
  progress?: { games: number; games_needed: number };
}

export interface Needed {
  id: string;
  kind: Bounty['kind'];
  /** "First Games", "Needs Games" or an admin label. */
  label: string;
  /** Points per seat that qualifies (docs/COMMUNITY.md "Points"). */
  bonus: number;
  /** One plain line: "No Gemini 3.8 Flash games yet". */
  text: string;
  /** A seat line for setup that brings it: "Gemini CLI / Gemini 3.8 Flash", "Claude Code / Claude Sonnet 5.5 / high". */
  seat: string;
  /** Harnesses here that can seat it (display names), the suggested one first. */
  harnesses: string[];
  model_id: string;
}

const CACHE_MS = 3600_000;
const FAIL_CACHE_MS = 600_000;
const TIMEOUT_MS = 4000;

/** The provider as a person's access is usually called: "Claude", "OpenAI", "Gemini". */
const ACCESS: Record<string, string> = { anthropic: 'Claude', openai: 'OpenAI', google: 'Gemini' };
export const accessOf = (modelId: string): string => {
  const p = registry.model(modelId)?.provider ?? '';
  return ACCESS[p] ?? registry.providerDisplay(p) ?? p;
};

/** Bounties from the Hub (cached), or null when it can't be reached. `fetchJson` is for tests. */
export async function loadBounties(hub: string, o: { cacheFile?: string; now?: number; fetchJson?: (url: string) => Promise<any> } = {}): Promise<Bounty[] | null> {
  const file = o.cacheFile ?? join(CONFIG_DIR, 'needed-cache.json');
  const now = o.now ?? Date.now();
  try {
    if (existsSync(file)) {
      const c = JSON.parse(readFileSync(file, 'utf8'));
      if (c?.hub === hub && typeof c.at === 'number' && now - c.at < (c.ok ? CACHE_MS : FAIL_CACHE_MS) && now >= c.at) return c.ok ? sanitize(c.bounties) : null;
    }
  } catch {
    // a broken cache is fetched again
  }
  const body = await (o.fetchJson ?? ((u: string) => tryJson(u, TIMEOUT_MS)))(`${hub}/api/bounties`);
  const ok = Array.isArray(body?.bounties);
  const bounties = ok ? sanitize(body.bounties) : null;
  try {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ hub, at: now, ok, bounties: bounties ?? [] }), { mode: 0o600 });
  } catch {
    // no cache: the next run asks again
  }
  return bounties;
}

/** The Hub's text reaches a coding agent with a shell: plain, short strings and known kinds only. */
function sanitize(xs: unknown[]): Bounty[] {
  const kinds = new Set(['first_games', 'provisional', 'new_set', 'admin']);
  const str = (v: unknown, n = 160) => (typeof v === 'string' ? printable(v, n) : undefined);
  return xs.filter((x): x is Record<string, any> => !!x && typeof x === 'object' && kinds.has((x as any).kind)).slice(0, 200).map((x) => ({
    id: str(x.id, 200) ?? '', kind: x.kind, label: str(x.label, 60) ?? '', bonus: Number.isFinite(x.bonus) ? Math.max(0, Math.min(100, Number(x.bonus))) : 0, text: str(x.text) ?? '',
    ...(str(x.model_id, 80) ? { model_id: str(x.model_id, 80) } : {}), ...(str(x.model_display, 80) ? { model_display: str(x.model_display, 80) } : {}),
    ...(str(x.identity, 200) ? { identity: str(x.identity, 200) } : {}), ...(str(x.identity_label) ? { identity_label: str(x.identity_label) } : {}),
    ...(str(x.group, 200) ? { group: str(x.group, 200) } : {}), ...(str(x.group_label) ? { group_label: str(x.group_label) } : {}),
    ...(str(x.set, 8) ? { set: str(x.set, 8) } : {}),
    ...(x.progress && Number.isFinite(x.progress.games) ? { progress: { games: Number(x.progress.games), games_needed: Number(x.progress.games_needed) || 30 } } : {}),
  }));
}

/** "kn=primer;mana=manual;prompt=…" → { knowledge, mana }. */
function groupConditions(group: string | undefined): { kn?: string; mana?: string } {
  const out: Record<string, string> = {};
  for (const part of String(group ?? '').split(';')) {
    const [k, v] = part.split('=');
    if (k && v) out[k] = v;
  }
  return { kn: out.kn, mana: out.mana };
}

/**
 * The bounties this person can bring seats for, most valuable first: First Games (a model with no rated games yet),
 * bounties set by hand for a model, then Needs Games (a setup short of a firm rating, closest to it first, in the
 * knowledge and mana mode the table will play: the main condition until they choose). New Set bounties are about sets,
 * not seats, and aren't listed here.
 */
export function neededForYou(bounties: Bounty[] | null, caps: Capability[], o: { knowledge?: string; mana?: string; limit?: number } = {}): Needed[] {
  if (!bounties?.length || !caps.length) return [];
  const kn = o.knowledge ?? 'primer';
  const mana = o.mana ?? 'manual';
  const out: Array<Needed & { rank: number }> = [];
  const runners = (model: string) => caps.filter((c) => c.models.some((m) => m.id === model));
  const lineFor = (c: Capability, model: string, effort?: string) => {
    const m = c.models.find((x) => x.id === model)!;
    const level = !m.settable ? undefined : effort && m.levels.includes(effort) ? effort : m.recommended;
    return `${c.label} / ${modelLabel(model)}${level ? ` / ${level}` : ''}`;
  };
  bounties.forEach((b, i) => {
    if ((b.kind === 'first_games' || b.kind === 'admin') && b.model_id) {
      const rs = runners(b.model_id);
      if (!rs.length) return;
      const name = b.model_display ?? modelLabel(b.model_id);
      out.push({
        id: b.id, kind: b.kind, label: b.label, bonus: b.bonus, rank: (b.kind === 'first_games' ? 0 : 1000) + i,
        text: b.kind === 'first_games' ? `No ${name} games yet` : b.text || `${b.label}: ${name}`,
        seat: lineFor(rs[0]!, b.model_id), harnesses: rs.map((c) => c.label), model_id: b.model_id,
      });
    } else if (b.kind === 'provisional' && b.identity) {
      const c = groupConditions(b.group);
      if ((c.kn && c.kn !== kn) || (c.mana && c.mana !== mana)) return;
      // An identity is model/effort: any harness here that runs the model at that level will do; one started here first.
      const [model, effort] = b.identity.split('/') as [string, string];
      const cap = caps.filter((x) => x.models.some((m) => m.id === model && (!m.settable || m.levels.includes(effort))))
        .sort((x, y) => Number(x.starts !== 'here') - Number(y.starts !== 'here'))[0];
      if (!cap) return;
      const left = b.progress ? Math.max(0, b.progress.games_needed - b.progress.games) : null;
      out.push({
        id: b.id, kind: b.kind, label: b.label, bonus: b.bonus, rank: 2000 + i,
        text: `${b.identity_label ?? `${modelLabel(model)} · ${effortLabel(effort)}`} needs ${left != null ? `${left} more rated games` : 'more rated games'} for a firm rating`,
        seat: lineFor(cap, model, effort), harnesses: [cap.label], model_id: model,
      });
    }
  });
  return out.sort((a, b) => a.rank - b.rank).slice(0, o.limit ?? 3).map(({ rank: _r, ...x }) => x);
}

/** The lead sentence for the most needed item: "Your Gemini access is the most needed right now: no Gemini 3.8 Flash games yet." */
export function neededHeadline(n: Needed[]): string | null {
  const top = n[0];
  if (!top) return null;
  const what = /^No /.test(top.text) ? `n${top.text.slice(1)}` : top.text;
  return `Your ${accessOf(top.model_id)} access is the most needed right now: ${what}.`;
}
