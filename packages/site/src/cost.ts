/**
 * Cost per game (SITE-DATA 2.8 CostInfo). A seat's cost is what its harness reported (Claude Code's API-equivalent
 * cost, OpenCode's cost) when every one of its sessions reported it, else an estimate from its token counts at the
 * model's list price on the event's start day (registry/prices.json). A seat with a fresh session per game has sessions
 * that were ended from outside and wrote no cost, so a reported sum would cover only some of them: it is estimated.
 * Estimates are labeled: `basis` says which kind a number is.
 *
 * Long-context prices (a model whose requests cost more over a prompt size, e.g. Claude Haiku 5.5 at 5× over 100 k):
 * a transcript with per-request usage prices each request by its own prompt size, and so does a usage file that carries
 * the tokens of its long requests (`long_context`, usage uploads); a usage file with only totals has the share of long
 * requests approximated from the mean prompt per request (registry prices.ts longShareFromTotals). A file with neither
 * a request count nor tool calls falls back to the base prices (`long_context: 'unknown'`). 1-hour cache writes are
 * priced as such where the counts say (cache_write_1h).
 *
 * Cross-checks (LAUNCH-CHECKLIST F-2, E-8): the estimate is always computed when token counts and a price exist. A
 * reported $0 with tokens used, or a reported cost more than COST_GAP away from the estimate, is not trusted: the
 * estimate is used and the seat is flagged (`flag`). A cost from an uploaded usage file is the contributor's own
 * figure, so where the upload carries token counts the estimate wins (`flag: 'upload_repriced'`).
 */
import type { EventData } from './data.js';
import { clusterBootstrap } from './rating.js';
import type { CostInfo } from './schema.js';
import { estimateUsd, longShare, longShareFromTotals, priceFor, shareFromSplit, type LongShare, type PriceEntry, type TokenCounts } from '../../registry/src/prices.js';

/** Relative gap between a reported cost and the estimate beyond which the report isn't trusted. */
export const COST_GAP = 0.35;

export interface SeatCost {
  usd: number;
  basis: 'reported' | 'estimated';
  games: number;
  price?: PriceEntry;
  /** Both figures when both exist (the one not used is a reference). */
  reported_usd?: number;
  estimated_usd?: number;
  /** Why a reported cost wasn't used: $0 with tokens, a gap over COST_GAP, or a self-reported upload re-priced. */
  flag?: 'reported_zero' | 'gap' | 'upload_repriced';
  /** Estimates on a model with long-context prices: how the long share was found (per request, or from totals). */
  long_context?: 'per_request' | 'from_totals' | 'unknown';
}

/** Finished games the seat played (drafting and deckbuilding are part of the seat's cost, so every game counts). */
const gamesOf = (ev: EventData, seat: string): number => ev.games.filter((g) => g.over && g.seats.includes(seat)).length;

/**
 * One seat's cost, or null when there is none to give: the harness didn't report one and either no token counts or no
 * price exist. `modelId` is the seat's canonical model (identity), used for the price.
 */
export function seatCost(ev: EventData, seat: string, modelId: string): SeatCost | null {
  const games = gamesOf(ev, seat);
  const tr = ev.transcripts.get(seat);
  const uf = ev.usage?.get(seat);
  // Reported: a finished transcript's result lines (every session's), else the submitted usage file.
  const fromLog = tr?.done && tr.costUsd != null && !tr.sessionsUnreported ? tr.costUsd : null;
  const fromUpload = fromLog == null && uf?.cost_usd != null && uf.complete !== false && !uf.sessions_unreported ? uf.cost_usd : null;
  const reported = fromLog ?? fromUpload;
  const est = estimateOf(ev, seat, modelId);
  if (reported == null) return est ? { ...est, games, basis: 'estimated' } : null;
  if (!est) return { usd: reported, basis: 'reported', games };
  const both = { reported_usd: reported, estimated_usd: est.usd };
  const flag: SeatCost['flag'] = reported === 0 && est.usd > 0 ? 'reported_zero'
    : fromUpload != null ? 'upload_repriced'
    : est.usd > 0 && Math.abs(reported - est.usd) / est.usd > COST_GAP ? 'gap' : undefined;
  if (flag) return { ...est, games, basis: 'estimated', ...both, flag };
  return { usd: reported, basis: 'reported', games, ...both };
}

/** The token estimate of a seat (transcript tokens, else the usage file's) at the model's list price, or null. */
function estimateOf(ev: EventData, seat: string, modelId: string): Omit<SeatCost, 'games' | 'basis'> | null {
  const tr = ev.transcripts.get(seat);
  const uf = ev.usage?.get(seat);
  // Estimated: token counts from the transcript, else the usage file.
  const fromTr = !!tr && !!(tr.inputTokens || tr.outputTokens);
  const t: TokenCounts | null = fromTr
    ? { input: tr!.inputTokens, output: tr!.outputTokens, cache_read: tr!.cacheReadTokens, cache_write: tr!.cacheCreationTokens, cache_write_1h: tr!.cacheCreation1hTokens ?? 0 }
    : uf && (uf.input_tokens || uf.output_tokens)
      ? { input: uf.input_tokens ?? 0, output: uf.output_tokens ?? 0, cache_read: uf.cache_read_tokens ?? 0, cache_write: uf.cache_creation_tokens ?? 0, cache_write_1h: uf.cache_creation_1h_tokens ?? 0 }
      : null;
  if (!t) return null;
  const price = priceFor(modelId, ev.startT);
  if (!price) return null;
  if (!price.long_context) return { usd: estimateUsd(t, price), price };
  // Long-context prices: per request when the transcript has them, else from the totals and the request count.
  const above = price.long_context.above;
  let share: LongShare | undefined;
  let how: SeatCost['long_context'] = 'unknown';
  const lc = !fromTr ? uf?.long_context : undefined;
  if (fromTr && tr!.calls?.length) (share = longShare(tr!.calls, above), how = 'per_request');
  else if (lc && lc.above === above && uf?.requests) {
    share = shareFromSplit(t, { requests: lc.requests, input: lc.input_tokens, output: lc.output_tokens, cache_read: lc.cache_read_tokens, cache_write: lc.cache_creation_tokens, cache_write_1h: lc.cache_creation_1h_tokens }, uf.requests);
    how = 'per_request';
  } else {
    const toolCalls = fromTr ? Object.values(tr!.toolCalls).reduce((n, v) => n + v, 0) : 0;
    const requests = fromTr ? Math.max(tr!.numTurns ?? 0, toolCalls ? toolCalls + 1 : 0) : uf?.requests;
    if (requests) (share = longShareFromTotals(t, requests, above), how = 'from_totals');
  }
  return { usd: estimateUsd(t, price, share), price, long_context: how };
}

/** Cost per game over a set of seats: total cost of the costed seats over their finished games, with a bootstrap over events. */
export function costInfo(seats: Array<{ ev: EventData; seat: string; modelId: string }>, opts: { replicates: number; seed: number }): CostInfo {
  const costs = seats.map((s) => ({ s, c: seatCost(s.ev, s.seat, s.modelId) }));
  const costed = costs.filter((x): x is { s: (typeof seats)[number]; c: SeatCost } => x.c != null);
  const reported = costed.filter((x) => x.c.basis === 'reported').length;
  const estimated = costed.length - reported;
  const games = costed.reduce((n, x) => n + x.c.games, 0);
  const total = costed.reduce((n, x) => n + x.c.usd, 0);
  const byEvent = new Map<string, Array<[number, number]>>();
  for (const x of costed) {
    if (!x.c.games) continue;
    byEvent.set(x.s.ev.id, [...(byEvent.get(x.s.ev.id) ?? []), [x.c.usd, x.c.games]]);
  }
  const ratio = (xs: Array<[number, number]>) => {
    const g = xs.reduce((n, x) => n + x[1], 0);
    return g ? xs.reduce((n, x) => n + x[0], 0) / g : undefined;
  };
  const r = byEvent.size ? clusterBootstrap([...byEvent.values()], ratio, { replicates: opts.replicates, seed: opts.seed }) : null;
  const prices = new Map<string, CostInfo['prices'][number]>();
  for (const x of costed) if (x.c.price) prices.set(`${x.c.price.model}|${x.c.price.from}`, { model_id: x.c.price.model, from: x.c.price.from, source: x.c.price.source, checked: x.c.price.checked });
  const evAll = new Set(seats.map((x) => x.ev.id));
  const evCovered = new Set(costed.map((x) => x.s.ev.id));
  return {
    per_game_usd: r ? { value: r.value, ci: r.ci, n: games, events: r.clusters } : null,
    // 2.17: what the number covers (never "every table" unless it does).
    seats_total: seats.length,
    seats_covered: costed.length,
    events_total: evAll.size,
    events_covered: evCovered.size,
    coverage_text: !costed.length ? 'No seat has a cost yet.'
      : costed.length === seats.length ? `Based on all ${seats.length} seats at ${evAll.size === 1 ? 'its one table' : `its ${evAll.size} tables`}.`
        : `Based on ${costed.length} of ${seats.length} seats, at ${evCovered.size} of ${evAll.size} tables (the others have no cost or token counts).`,
    basis: !costed.length ? null : !estimated ? 'reported' : !reported ? 'estimated' : 'mixed',
    total_usd: costed.length ? total : null,
    seats_reported: reported,
    seats_estimated: estimated,
    seats_missing: seats.length - costed.length,
    // F-2: seats whose reported cost wasn't used ($0 with tokens, a gap over 35%, an upload re-priced from tokens).
    seats_flagged: costed.filter((x) => x.c.flag).length,
    games,
    prices: [...prices.values()].sort((a, b) => a.model_id.localeCompare(b.model_id) || a.from.localeCompare(b.from)),
  };
}
