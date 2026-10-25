/**
 * The Effort Ladder on model pages (SITE-DATA 2.15 and 2.20, METHODOLOGY "Effort comparisons"): a model's rated
 * versions on one board, its effort levels in order (none … max, then ultra, which has no order). Since 2.20 an
 * identity is a model at an effort level, whatever harness ran it, so there is one ladder per model and no Harness
 * Comparison (the harness split on the model page is descriptive, never rated: models.ts harnessSplit).
 * Every version stays its own identity, rated in the same fit as everything else on the board: these are views of the
 * board's rows, the board's head to head and the fit's difference intervals, never a separate rating.
 */
import { wilson } from './outcomes.js';
import { holm, pFromInterval } from './multiplicity.js';
import { CONCRETE_EFFORTS } from '../../registry/src/index.js';
import type { Identities } from './scoring.js';
import type { Board, BoardRow, EffortLadder, Est, VersionHeadToHead, VersionRung, VersionStep } from './schema.js';

const MINUS = '−';
/** Provisional rows in a ladder: the contributor floor usually binds, so one person's ladder is never a firm answer. */
const PROVISIONAL_NOTE = 'Some of these ratings are provisional (they need more games, events, opponents or contributors), so no step here is a firm answer yet; a firm answer needs ladders from several contributors.';
const order = (effort: string) => {
  const i = (CONCRETE_EFFORTS as readonly string[]).indexOf(effort);
  return i < 0 ? 99 : i;
};
const round2 = (x: number) => Math.round(x * 100) / 100;
const elo = (x: number) => `${Math.round(Math.abs(x))} Elo`;
const signed = (x: number) => `${x < 0 ? MINUS : '+'}${Math.round(Math.abs(x))}`;
const usd = (x: number) => (x >= 10 ? `$${Math.round(x)}` : `$${x.toFixed(2)}`);
const list = (xs: string[]) => (xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

function rungOf(r: BoardRow, ids: Identities): VersionRung {
  const info = ids.info.get(r.identity);
  const fromOutcomes = r.outcomes?.games.win_rate ?? null;
  const games = r.games;
  const ci = wilson(r.wins, games);
  const gw: Est | null = fromOutcomes ?? (games ? { value: r.wins / games, ci, n: games, events: r.events } : null);
  return {
    identity: r.identity,
    label: info?.label ?? r.identity,
    effort: info?.effort ?? r.identity.split('/')[1]!,
    effort_display: info?.effort_display ?? r.identity.split('/')[1]!,
    rating: r.rating,
    ci: r.ci,
    expected_score: r.expected_score ?? null,
    provisional: r.provisional,
    provisional_reasons: r.provisional_reasons,
    games, wins: r.wins, losses: r.losses, events: r.events,
    game_win_rate: gw,
    cost_per_game_usd: r.cost?.per_game_usd ?? null,
    cost_basis: r.cost?.basis ?? null,
  };
}

/** The fit's difference to − from (oriented), from Board.version_differences. */
function difference(b: Board, to: string, from: string): { diff: number; ci: [number, number] | null; ahead: 'a' | 'b' | null } | null {
  for (const d of b.version_differences ?? []) {
    if (d.a === to && d.b === from) return { diff: d.diff, ci: d.ci, ahead: d.ahead };
    if (d.a === from && d.b === to) return { diff: -d.diff, ci: d.ci ? [-d.ci[1], -d.ci[0]] : null, ahead: d.ahead === 'a' ? 'b' : d.ahead === 'b' ? 'a' : null };
  }
  return null;
}

function step(b: Board, from: VersionRung, to: VersionRung): VersionStep {
  const d = difference(b, to.identity, from.identity);
  const cf = from.cost_per_game_usd?.value;
  const ct = to.cost_per_game_usd?.value;
  return {
    from: from.identity,
    to: to.identity,
    rating_change: d ? d.diff : from.rating != null && to.rating != null ? Math.round((to.rating - from.rating) * 10) / 10 : null,
    ci: d?.ci ?? null,
    // "a" is `to` after orientation.
    credible: d?.ahead === 'a' ? 'up' : d?.ahead === 'b' ? 'down' : null,
    cost_change_per_game_usd: cf != null && ct != null ? round2(ct - cf) : null,
    p_value: d ? pFromInterval(d.diff, d.ci) : null,
    p_holm: null,
    comparisons: 0,
    provisional: from.provisional || to.provisional,
    verdict: 'open',
  };
}

/**
 * The verdict of each step within one ladder or comparison (METHODOLOGY §2.3, "Several comparisons"): Holm-adjusted
 * over the family's steps, and never firm while either row is provisional (the contributor floor included).
 *   higher / lower   both rows firm and the difference holds after the Holm correction
 *   provisional      the interval excludes 0, but a row is provisional
 *   unadjusted       the interval excludes 0, both rows firm, but not after the correction
 *   open             the interval includes 0 (or no interval)
 */
export function judge(steps: VersionStep[]): VersionStep[] {
  const adj = holm(steps.map((s) => s.p_value ?? null));
  return steps.map((s, i) => {
    const p = adj[i] ?? null;
    const verdict: VersionStep['verdict'] = !s.credible ? 'open'
      : s.provisional ? 'provisional'
        : p != null && p < 0.05 ? (s.credible === 'up' ? 'higher' : 'lower')
          : 'unadjusted';
    return { ...s, p_holm: p, comparisons: steps.length, verdict };
  });
}

function headToHead(b: Board, rungs: VersionRung[]): VersionHeadToHead[] {
  const label = new Map(rungs.map((r) => [r.identity, r.label]));
  return (b.pairwise ?? [])
    .filter((p) => label.has(p.a) && label.has(p.b))
    .map((p) => ({
      a: p.a, b: p.b, a_label: label.get(p.a)!, b_label: label.get(p.b)!,
      games: p.games, a_wins: p.a_wins, matches: p.matches, a_match_wins: p.a_match_wins,
      a_win_rate: p.games ? { value: p.a_wins / p.games, ci: wilson(p.a_wins, p.games) } : null,
      difference: (() => { const d = difference(b, p.a, p.b); return d ? { diff: d.diff, ci: d.ci, ahead: d.ahead } : null; })(),
    }));
}

/**
 * One step in words: "High is rated 42 Elo above Low (95% range −30 to +115): too early to say …". Never causal ("more
 * thinking helped") and never a "clear gain": a firm verdict says "rated higher", after the correction for the ladder's
 * comparisons, and only when neither row is provisional.
 */
export function stepText(s: VersionStep, name: (id: string) => string, open: string): string {
  if (s.rating_change == null) return `${name(s.to)} and ${name(s.from)} aren't both rated yet.`;
  const where = Math.round(s.rating_change) === 0 ? `level with ${name(s.from)}` : `${elo(s.rating_change)} ${s.rating_change > 0 ? 'above' : 'below'} ${name(s.from)}`;
  const range = s.ci ? ` (95% range ${signed(s.ci[0])} to ${signed(s.ci[1])})` : '';
  const fam = (s.comparisons ?? 1) > 1 ? `the ${s.comparisons} comparisons here` : 'this comparison';
  const dir = s.credible === 'up' ? 'higher' : 'lower';
  const v = s.verdict === 'higher' || s.verdict === 'lower'
    ? `rated ${dir} in these games, and the difference holds after correcting for ${fam}`
    : s.verdict === 'provisional'
      ? `it looks ${dir} in these games, but a rating here is provisional, so it's too early to call`
      : s.verdict === 'unadjusted'
        ? `${dir} on its own range, but not after correcting for ${fam}, so it's too early to call`
        : open;
  return `${name(s.to)} is rated ${where}${range}: ${v}.`;
}

function costText(rungs: VersionRung[], name: (r: VersionRung) => string): string {
  const priced = rungs.filter((r) => r.cost_per_game_usd);
  if (priced.length < 2) return '';
  return ` A game cost about ${list(priced.map((r) => `${usd(r.cost_per_game_usd!.value)} ${name(r)}`))}.`;
}

/** The effort ladder of one model on its page board (rows of that model with a rating). */
export function versionViews(o: { board: Board; modelId: string; modelDisplay: string; groupLabel: string; ids: Identities }): {
  effort_ladder: EffortLadder[]; effort_levels: number;
} {
  const { board: b, ids } = o;
  const mine = b.rows.filter((r) => ids.info.get(r.identity)?.model === o.modelId);
  const rated = mine.filter((r) => r.rating != null);
  const concrete = rated.filter((r) => ids.info.get(r.identity)?.effort !== 'unknown');
  const rs = concrete.map((r) => rungOf(r, ids)).sort((x, y) => order(x.effort) - order(y.effort));
  const effort_ladder: EffortLadder[] = [];
  if (rs.length >= 2) {
    const steps = judge(rs.slice(1).map((r, i) => step(b, rs[i]!, r)));
    const byId = new Map(rs.map((r) => [r.identity, r.effort_display]));
    const lines = steps.map((s) => stepText(s, (id) => byId.get(id)!, 'too early to say whether the higher effort is rated differently'));
    const provisional = rs.some((r) => r.provisional);
    effort_ladder.push({
      board: b.id, group: b.group, group_label: o.groupLabel,
      rungs: rs, steps, head_to_head: headToHead(b, rs), provisional,
      unknown_effort_rows: mine.filter((r) => ids.info.get(r.identity)?.effort === 'unknown').length,
      summary: `${o.modelDisplay} is rated at ${rs.length} effort levels (${list(rs.map((r) => r.effort_display))}). ${lines.join(' ')}`
        + costText(rs, (r) => `at ${r.effort_display}`) + (provisional ? ` ${PROVISIONAL_NOTE}` : ''),
    });
  }
  return { effort_ladder, effort_levels: rs.length };
}
