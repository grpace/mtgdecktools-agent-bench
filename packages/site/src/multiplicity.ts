/**
 * Several comparisons at once (METHODOLOGY §4 "Several comparisons"): an Effort Ladder's steps, a set board's "ranks
 * first". Each comparison has a rating difference with a 95% interval (the wider of the bootstrap and Laplace
 * intervals, rating.ts); its two-sided p-value is read off that interval as if it were normal, and the Holm step-down
 * procedure keeps the chance of any false "credibly ahead" within the family at 5%.
 */

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf; |error| < 1.5e-7). */
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/**
 * Two-sided p-value of a difference from its central interval at level `level` (0.95: ±1.96 standard errors). Null
 * without an interval. An interval that excludes 0 gives p < 1 − level, as the interval itself says.
 */
export function pFromInterval(diff: number, ci: [number, number] | null, level = 0.95): number | null {
  if (!ci) return null;
  const z95 = zOf(level);
  const se = (ci[1] - ci[0]) / (2 * z95);
  if (!(se > 0)) return diff === 0 ? 1 : 0;
  // The interval may be asymmetric (bootstrap): use the half on the side of 0.
  const half = diff >= 0 ? (diff - ci[0]) / z95 : (ci[1] - diff) / z95;
  const s = half > 0 ? half : se;
  return Math.min(1, 2 * (1 - normCdf(Math.abs(diff) / s)));
}

function zOf(level: number): number {
  // Inverse normal by bisection: only a few levels are ever used.
  const target = 1 - (1 - level) / 2;
  let lo = 0, hi = 10;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (normCdf(mid) < target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Holm step-down adjusted p-values (same order as the input; null stays null and doesn't count toward the family).
 * Reject (call it credible) when the adjusted p is below alpha.
 */
export function holm(ps: Array<number | null>): Array<number | null> {
  const idx = ps.map((p, i) => ({ p, i })).filter((x): x is { p: number; i: number } => x.p != null).sort((a, b) => a.p - b.p);
  const m = idx.length;
  const out: Array<number | null> = ps.map(() => null);
  let running = 0;
  idx.forEach(({ p, i }, k) => {
    running = Math.max(running, Math.min(1, (m - k) * p));
    out[i] = running;
  });
  return out;
}
