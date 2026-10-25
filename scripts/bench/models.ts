/**
 * Model registry integration: the one place the bench CLI turns what a person typed into the canonical harness,
 * model and effort ids for a seat, and a seat into the command-line strings that start it, using the shared resolver
 * (packages/registry, data in registry/*.json).
 *   setup / new   resolveSeat, effortChoice (levels, the recommended one and why)
 *   setup         modelChoices (the registry's models per harness)
 *   play          launchFor (model string and effort arguments for the harness)
 *
 * The Director resolves the declared strings again with the same registry and logs both (registry/README.md), so
 * the CLI sends what was typed and keeps the canonical ids for launching and display.
 */
import {
  CONCRETE_EFFORTS, launchSpec, modelsForHarness, recommendedEffort, registry, resolveSeat as resolveDeclared,
} from '../../packages/registry/src/index.js';
import type { SeatSpec } from './harnesses.js';

export type SeatResolution =
  | { ok: true; seat: SeatSpec; /** false: not in the registry (unrated, own tables only). */ listed: boolean; test: boolean; warnings: string[] }
  | { ok: false; error: string; suggestions: string[] };

export function resolveSeat(seat: SeatSpec, opts: { allowUnlisted: boolean }): SeatResolution {
  const declared = seat.declared ?? { harness: seat.harness, model: seat.model, effort: seat.effort };
  const r = resolveDeclared(declared, { allowUnlisted: opts.allowUnlisted, at: Date.now() });
  if (!r.ok) return { ok: false, error: r.error, suggestions: r.suggestions };
  return {
    ok: true, listed: r.listed, test: r.test, warnings: r.warnings,
    seat: {
      ...(seat.name ? { name: seat.name } : {}), harness: r.seat.harness, model: r.seat.model, effort: r.seat.effort, declared,
      ...(seat.effortUnknown || r.seat.effort === 'unknown' ? { effortUnknown: true } : {}),
      // A hosted variant (OpenCode Zen) launches by the name as typed; the level in a model name needs no effort.
      ...(r.hosted && declared.model ? { launchModel: declared.model } : {}),
      ...(r.effortFromName ? { effortFromName: true } : {}),
    },
  };
}

/** The registry's models a harness can start (registry `modelsForHarness`: display name + canonical id), for the interview. */
export function modelChoices(harness: string): Array<{ id: string; label: string }> {
  return modelsForHarness(harness).filter((m) => m.status !== 'deprecated').map((m) => ({ id: m.id, label: m.display }));
}

export interface EffortChoice {
  /** The harness can be started at a chosen level (registry `launchSpec`). */
  settable: boolean;
  /** Levels this model can be started at in this harness, lowest first (empty when not settable). */
  levels: string[];
  /** The level to preselect; where not settable, the harness's documented fixed level (or "unknown"). */
  recommended: string;
  /** One line: why the recommendation, or what the harness does without a setting. */
  why: string;
}

/** Effort for a model in a harness, from the registry (`recommendedEffort`, `launchSpec`). */
export function effortChoice(harness: string, model: string | undefined): EffortChoice {
  if (!model) return { settable: false, levels: [], recommended: 'unknown', why: 'no model' };
  const h = registry.resolveHarness(harness);
  if (h.ok && h.harness.kind === 'test') return { settable: false, levels: [], recommended: 'default', why: 'a scripted player has no effort' };
  const rec = recommendedEffort(model, harness);
  const levels = CONCRETE_EFFORTS.filter((l) => launchSpec(harness, model, l).settable);
  return { settable: rec.settable && levels.length > 0, levels: [...levels], recommended: rec.level, why: rec.reason };
}

/** How `bench play` starts a seat: the harness's model string (with the level where it goes there) and effort args. */
export function launchFor(harness: string, model: string | undefined, effort: string | undefined, launchModel?: string): { model?: string; args: string[]; settable: boolean } {
  if (!model) return { model, args: [], settable: false };
  // A hosted variant's own name, only when it still names this model (registry `launchSpec` launches it as given).
  const idOf = (m: string) => {
    const r = registry.resolveModel(m, harness);
    return r.ok ? r.id : undefined;
  };
  const named = launchModel && idOf(launchModel) !== undefined && idOf(launchModel) === idOf(model) ? launchModel : undefined;
  const spec = launchSpec(harness, named ?? model, effort ?? '');
  return { model: spec.model ?? model, args: spec.args, settable: spec.settable };
}

/** "Claude Opus 5.5" for a canonical model id (the id itself when the registry doesn't list it). */
export const modelLabel = (model: string) => registry.modelDisplay(model);
/** "High", "Default Effort", "Unknown". */
export const effortLabel = (effort: string) => registry.effortDisplay(effort);
