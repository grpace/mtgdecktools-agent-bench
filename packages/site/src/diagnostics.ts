/**
 * Headline diagnostics (METHODOLOGY §5): descriptive numbers about how an agent drafts, builds and plays, with the field
 * median for context. They never feed the rating; a poor deck shows up as lost games. Since 2.9 they are never ranked:
 * `rank` and `rank_label` stay in the schema and are always null.
 */
import { median } from './metrics.js';
import type { BoardRow, CostInfo, DiagnosticDef, DiagnosticValue, Diagnostics, Est } from './schema.js';

export const DIAGNOSTICS: DiagnosticDef[] = [
  { key: 'on_color_rate', stage: 'draft', label: 'Picks Their Deck Could Cast', definition: 'Share of picks in packs 2 and 3 that the final deck’s colors can cast.', unit: 'share', order: 'desc', rank_label: null, path: 'draft.core.on_color_rate' },
  { key: 'conversion', stage: 'draft', label: 'Picks That Made the Deck', definition: 'Share of real picks (not the last card of a pack) that made the final 40.', unit: 'share', order: 'desc', rank_label: null, path: 'draft.core.conversion' },
  { key: 'commitment_pick', stage: 'draft', label: 'Commits to Its Colors', definition: 'Overall pick from which its two main colors never change.', unit: 'pick', order: 'asc', rank_label: null, path: 'draft.core.commitment_pick' },
  { key: 'role_coverage', stage: 'build', label: 'Deck Checks Passed', definition: 'Share of six common Limited checks its decks pass: 16–18 lands, 12+ creatures, 6+ cards at two mana or less, 6 or fewer at five or more, average mana value 2.5–3.5, 2+ interaction.', unit: 'share', order: 'desc', rank_label: null, path: 'draft.core.role_coverage' },
  { key: 'avg_lands', stage: 'build', label: 'Average Lands', definition: 'Lands in its agent-built decks, on average.', unit: 'count', order: null, rank_label: null, path: 'build.avg_lands' },
  { key: 'legal_rate', stage: 'build', label: 'Legal Decks', definition: 'Share of its decks that were legal as submitted (built by the agent, not the reference builder).', unit: 'share', order: 'desc', rank_label: null, path: 'build.legal_rate' },
  { key: 'rejected_per_100', stage: 'play', label: 'Rules Engine Refusals', definition: 'Answers the rules engine rejected, per 100 game decisions.', unit: 'per_100', order: 'asc', rank_label: null, path: 'reliability.rejected_per_100' },
  { key: 'median_latency_ms', stage: 'play', label: 'Median Time per Decision', definition: 'From the decision being offered to the answer, measured by the server.', unit: 'ms', order: 'asc', rank_label: null, path: 'efficiency.median_latency_ms' },
  { key: 'mulligans_per_game', stage: 'play', label: 'Mulligans per Game', definition: 'Mulligans taken per finished game.', unit: 'count', order: null, rank_label: null, path: 'play.mulligans_per_game' },
  { key: 'output_tokens_per_decision', stage: 'cost', label: 'Output Tokens per Decision', definition: 'Output tokens the harness reported, per pick and game decision.', unit: 'tokens', order: 'asc', rank_label: null, path: 'efficiency.output_tokens_per_decision' },
  { key: 'cost_per_game_usd', stage: 'cost', label: 'Cost per Game', definition: 'Seat cost (drafting and deckbuilding included) per finished game: reported by the harness, else estimated from token counts at list prices.', unit: 'usd', order: 'asc', rank_label: null, path: 'cost.per_game_usd' },
];

type Raw = { value: number | null; ci: [number, number] | null; n: number };

const fromEst = (e: Est | null | undefined): Raw => (e ? { value: e.value, ci: e.ci, n: e.n } : { value: null, ci: null, n: 0 });
const fromNum = (v: number | null | undefined, n: number): Raw => ({ value: v ?? null, ci: null, n: v == null ? 0 : n });

/** The raw value of a diagnostic for one row. */
export function diagnosticValue(key: string, d: Diagnostics, cost: CostInfo | null | undefined): Raw {
  switch (key) {
    case 'on_color_rate': return fromEst(d.draft.core?.on_color_rate);
    case 'conversion': return fromEst(d.draft.core?.conversion);
    case 'commitment_pick': return fromEst(d.draft.core?.commitment_pick);
    case 'role_coverage': return fromEst(d.draft.core?.role_coverage);
    case 'avg_lands': return fromNum(d.build.avg_lands, d.build.agent_built);
    case 'legal_rate': return fromNum(d.build.legal_rate, d.build.agent_built);
    case 'rejected_per_100': return fromEst(d.reliability.rejected_per_100);
    case 'median_latency_ms': return fromNum(d.efficiency.median_latency_ms, d.reliability.decisions);
    case 'mulligans_per_game': return fromNum(d.play.mulligans_per_game, d.play.games);
    case 'output_tokens_per_decision': return fromNum(d.efficiency.output_tokens_per_decision, d.reliability.decisions);
    case 'cost_per_game_usd': return fromEst(cost?.per_game_usd);
    default: return { value: null, ci: null, n: 0 };
  }
}

/** Rank of `v` among `values` in `order` (1 = first); ties share the best rank. */
export function rankOf(v: number, values: number[], order: 'desc' | 'asc'): number {
  return 1 + values.filter((x) => (order === 'desc' ? x > v : x < v)).length;
}

/**
 * Field medians and per-row diagnostics with rank-of-N over a board's rows. Rows are any rows of the board (rated or
 * not): behavior is described for every identity that sat down.
 */
export function boardDiagnostics(rows: Array<Pick<BoardRow, 'stages' | 'cost'>>): { field: Record<string, { median: number | null; n: number }>; perRow: Array<Record<string, DiagnosticValue>> } {
  const field: Record<string, { median: number | null; n: number }> = {};
  const perRow: Array<Record<string, DiagnosticValue>> = rows.map(() => ({}));
  for (const def of DIAGNOSTICS) {
    const raws = rows.map((r) => diagnosticValue(def.key, r.stages, r.cost));
    const vals = raws.map((r) => r.value).filter((v): v is number => v != null && Number.isFinite(v));
    const med = vals.length ? median(vals)! : null;
    field[def.key] = { median: med, n: vals.length };
    raws.forEach((r, i) => {
      perRow[i]![def.key] = {
        value: r.value,
        ci: r.ci,
        n: r.n,
        field_median: med,
        // 2.9: behavior metrics are never ranked (the site shows the value against the field median).
        rank: null,
        of: vals.length,
      };
    });
  }
  return { field, perRow };
}
