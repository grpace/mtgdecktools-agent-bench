/**
 * Canonical seat identity for the lobby (docs/LOBBY.md §8): declared harness, model and effort → canonical ids
 * plus display names, through the shared model registry (registry/*.json, packages/registry). The lobby refuses
 * unknown or unlisted models and harnesses, and its public API only ever shows these canonical values, never
 * free text. This module is the lobby's single integration point with the registry.
 */
import { identityKey, identityLabel, isConcreteEffort, recommendedEffort, REGISTRY_DATA, registry, resolveSeat, type Effort } from '../../registry/src/index.js';

export type EffortId = Effort;

export interface SeatIdentity {
  harness_id: string;
  harness_display: string;
  model_id: string;
  model_display: string;
  effort: EffortId;
  /** A test harness (the scripted random player): never an LLM, never rated. */
  test: boolean;
  /**
   * How the effort was declared (METHODOLOGY §2.2): "launch" when the bench CLI starts the seat with that level,
   * "self-report" when the person seats it by hand. Optional; passed through to the event's seat metadata.
   */
  effort_basis?: 'launch' | 'self-report';
}

export type IdentityResult = ({ ok: true } & SeatIdentity) | { ok: false; field: 'harness' | 'model' | 'effort'; error: string };

/** The scripted player's pseudo-model. */
const TEST_MODEL_DISPLAY = 'Random Player';

/** Accepted model ids (for error messages and `bench lobby` help). */
export function listedModels(): Array<{ id: string; display: string }> {
  return REGISTRY_DATA.models.filter((m) => m.status !== 'retired').map(({ id, display }) => ({ id, display }));
}

export function listedHarnesses(): Array<{ id: string; display: string }> {
  return REGISTRY_DATA.harnesses.map(({ id, display }) => ({ id, display }));
}

/**
 * Resolve a declared seat to canonical ids. Unknown or unlisted harnesses and models are refused. With
 * `requireEffort` (the public lobby), an LLM seat must declare a concrete reasoning effort (separately, or in the
 * model name where the harness puts it there): missing, "default" and "unknown" are refused, so every lobby seat's identity is exact. Test harnesses (the scripted player) have none.
 */
export function resolveSeatIdentity(d: { harness?: unknown; model?: unknown; effort?: unknown; effort_basis?: unknown }, opts: { requireEffort?: boolean } = {}): IdentityResult {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : undefined);
  const rawEffort = str(d.effort);
  const r = resolveSeat({ harness: str(d.harness), model: str(d.model), effort: rawEffort }, { allowUnlisted: false, requireEffort: opts.requireEffort });
  if (!r.ok) return { ok: false, field: r.field, error: r.error };
  // The lobby is stricter than a private table: an LLM seat always declares a concrete level itself (a missing,
  // "default" or "unknown" effort is refused even where the harness can't set one: declare the level it runs at).
  // A level in the model name (Antigravity "gemini-4-argon-high", OpenCode "#high") is a declared level. A model with
  // no effort setting at all (Composer 2.5: `efforts: []`) has no level to declare.
  if (opts.requireEffort && !r.test && r.model?.efforts.length !== 0 && ((!rawEffort && !r.effortFromName) || !isConcreteEffort(r.seat.effort))) {
    const rec = recommendedEffort(r.seat.model, r.seat.harness);
    const levels = (r.model?.efforts ?? []).join(', ') || 'low, medium, high';
    return { ok: false, field: 'effort', error: `declare the reasoning effort explicitly (${levels}; recommended ${rec.level}: ${rec.reason}), e.g. ${r.seat.harness}/${r.seat.model}/${rec.level}; "default", "unknown" and missing efforts aren't accepted in the lobby` };
  }
  if (!r.listed) return { ok: false, field: 'model', error: `${r.seat.model} is not listed in the model registry (registry/models.json); the lobby only seats listed models` };
  const { harness, model, effort } = r.seat;
  return {
    ok: true, harness_id: harness, harness_display: registry.harnessDisplay(harness), model_id: model,
    model_display: r.test ? TEST_MODEL_DISPLAY : registry.modelDisplay(model), effort, test: r.test,
    ...(!r.test && (d.effort_basis === 'launch' || d.effort_basis === 'self-report') ? { effort_basis: d.effort_basis } : {}),
  };
}

/** Display names for canonical ids (stats rows recorded earlier; unknown ids show as themselves). */
export function displayOf(kind: 'model' | 'harness', id: string): string {
  if (kind === 'harness') return registry.harnessDisplay(id);
  return registry.model(id) ? registry.modelDisplay(id) : id === 'random' ? TEST_MODEL_DISPLAY : id;
}

/** Display and key of a seat identity: "Claude Opus 5.5 · High", "claude-opus-5-5/high" (the harness is never part of it). */
export function identityOf(s: SeatIdentity): { effort_display: string; identity_key: string; identity_label: string } {
  const effort_display = registry.effortDisplay(s.effort);
  if (s.test) return { effort_display, identity_key: identityKey(s.model_id, s.effort), identity_label: s.model_display };
  return { effort_display, identity_key: identityKey(s.model_id, s.effort), identity_label: identityLabel(s.model_id, s.effort) };
}
