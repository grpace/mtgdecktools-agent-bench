/** Small inline SVG charts. Colors come from CSS custom properties (see assets/style.css). */
import { esc } from './html.js';
import { curveBuckets } from './metrics.js';

/** Mana curve: count of non-land cards per mana value (0..6, 7+). Bars with direct count labels. */
export function manaCurve(mvs: number[], label = 'Mana curve'): string {
  const buckets = curveBuckets(mvs);
  // Drop the 0 bucket if empty to keep it compact.
  const start = buckets[0] ? 0 : 1;
  const shown = buckets.slice(start);
  const max = Math.max(1, ...shown);
  const W = 22, GAP = 4, H = 56, TOP = 14, BOTTOM = 14;
  const width = shown.length * (W + GAP) - GAP;
  const bars = shown
    .map((n, i) => {
      const h = Math.round((n / max) * (H - TOP));
      const x = i * (W + GAP);
      const y = H - h;
      const mv = i + start;
      const lbl = mv === 7 ? '7+' : String(mv);
      return `<g data-tip="${esc(`${n} card${n === 1 ? '' : 's'} at mana value ${lbl}`)}">
  <rect x="${x}" y="0" width="${W}" height="${H + BOTTOM}" fill="transparent"/>
  ${n ? `<path d="M${x},${H} V${y + 3} q0,-3 3,-3 h${W - 6} q3,0 3,3 V${H} Z" class="bar"/>` : ''}
  ${n ? `<text x="${x + W / 2}" y="${y - 3}" class="bar-val">${n}</text>` : ''}
  <text x="${x + W / 2}" y="${H + 11}" class="axis-lbl">${lbl}</text>
</g>`;
    })
    .join('');
  return `<figure class="viz curve"><svg viewBox="0 0 ${width} ${H + BOTTOM}" width="${width}" height="${H + BOTTOM}" role="img" aria-label="${esc(label)}: ${shown
    .map((n, i) => `${n} at ${i + start}`)
    .join(', ')}">
<line x1="0" x2="${width}" y1="${H}" y2="${H}" class="baseline"/>${bars}</svg></figure>`;
}

import type { LifePoint } from './replay-data.js';
export type { LifePoint };

/** Life totals by turn for the two seats. Step lines, legend, a hover column per turn. */
export function lifeChart(points: LifePoint[], names: [string, string]): string {
  if (points.length < 2) return '';
  const W = 640, H = 180, L = 30, R = 12, T = 12, B = 24;
  // Loops, not spreads: a spread of a very long array overflows the stack.
  const turns = points.map((p) => p.turn);
  const vals = points.flatMap((p) => [p.a, p.b]).filter((v): v is number => v != null);
  const maxTurn = turns.reduce((m, v) => (v > m ? v : m), -Infinity);
  const minTurn = turns.reduce((m, v) => (v < m ? v : m), Infinity);
  const maxLife = vals.reduce((m, v) => (v > m ? v : m), 20);
  const minLife = vals.reduce((m, v) => (v < m ? v : m), 0);
  const x = (t: number) => L + ((t - minTurn) / Math.max(1, maxTurn - minTurn)) * (W - L - R);
  const y = (v: number) => T + ((maxLife - v) / Math.max(1, maxLife - minLife)) * (H - T - B);
  const path = (key: 'a' | 'b') => {
    let d = '';
    let last: number | undefined;
    for (const p of points) {
      const v = p[key];
      if (v == null) continue;
      if (last == null) d += `M${x(p.turn).toFixed(1)},${y(v).toFixed(1)}`;
      else d += ` H${x(p.turn).toFixed(1)} V${y(v).toFixed(1)}`;
      last = v;
    }
    return d;
  };
  const ticksY = [0, 5, 10, 15, 20].filter((v) => v >= minLife && v <= maxLife);
  const stepT = maxTurn - minTurn > 16 ? 4 : 2;
  const ticksX: number[] = [];
  for (let t = Math.ceil(minTurn / stepT) * stepT; t <= maxTurn; t += stepT) ticksX.push(t);
  const colW = (W - L - R) / Math.max(1, maxTurn - minTurn);
  const cols = points
    .map(
      (p) =>
        `<rect x="${(x(p.turn) - colW / 2).toFixed(1)}" y="${T}" width="${colW.toFixed(1)}" height="${H - T - B}" fill="transparent" data-tip="${esc(
          `Turn ${p.turn} · ${names[0]}: ${p.a ?? '?'} · ${names[1]}: ${p.b ?? '?'}`,
        )}"/>`,
    )
    .join('');
  const lastA = [...points].reverse().find((p) => p.a != null);
  const lastB = [...points].reverse().find((p) => p.b != null);
  return `<figure class="viz life">
<figcaption><span class="legend"><span class="sw sw-1"></span>${esc(names[0])}</span><span class="legend"><span class="sw sw-2"></span>${esc(names[1])}</span><span class="muted">Life totals by turn, as seen in the agents' decision views</span></figcaption>
<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Life totals by turn">
${ticksY.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 3}" class="axis-lbl" text-anchor="end">${v}</text>`).join('')}
${ticksX.map((t) => `<text x="${x(t)}" y="${H - 6}" class="axis-lbl">T${t}</text>`).join('')}
<path d="${path('a')}" class="line s1"/>
<path d="${path('b')}" class="line s2"/>
${lastA?.a != null ? `<circle cx="${x(lastA.turn)}" cy="${y(lastA.a)}" r="4" class="dot s1"/>` : ''}
${lastB?.b != null ? `<circle cx="${x(lastB.turn)}" cy="${y(lastB.b)}" r="4" class="dot s2"/>` : ''}
${cols}
</svg></figure>`;
}

export interface PickPoint { label: string; picked?: number; best?: number; match: boolean; forced: boolean }

/** Pick-by-pick: picked card's GIH WR (dot) vs best available (tick); the gap is the regret. */
export function pickStrip(points: PickPoint[], baseline: number): string {
  if (!points.length) return '';
  const n = points.length;
  const W = Math.max(640, n * 24), H = 170, L = 34, R = 8, T = 10, B = 22;
  const vals = points.flatMap((p) => [p.picked, p.best]).filter((v): v is number => v != null);
  if (!vals.length) return '';
  const lo = Math.min(baseline - 0.05, ...vals) - 0.005;
  const hi = Math.max(baseline + 0.05, ...vals) + 0.005;
  const step = (W - L - R) / n;
  const x = (i: number) => L + step * (i + 0.5);
  const y = (v: number) => T + ((hi - v) / (hi - lo)) * (H - T - B);
  const ticks: number[] = [];
  for (let v = Math.ceil(lo * 50) / 50; v <= hi; v += 0.02) ticks.push(v);
  const marks = points
    .map((p, i) => {
      const parts: string[] = [];
      if (p.best != null && p.picked != null && p.best - p.picked > 0.0005) {
        parts.push(`<line x1="${x(i)}" x2="${x(i)}" y1="${y(p.best)}" y2="${y(p.picked)}" class="gap"/>`);
      }
      if (p.best != null) parts.push(`<line x1="${x(i) - 5}" x2="${x(i) + 5}" y1="${y(p.best)}" y2="${y(p.best)}" class="best-tick"/>`);
      if (p.picked != null) parts.push(`<circle cx="${x(i)}" cy="${y(p.picked)}" r="4" class="${p.forced ? 'pick-dot forced' : p.match ? 'pick-dot match' : 'pick-dot'}"/>`);
      const tip = `${p.label}: picked ${p.picked != null ? (p.picked * 100).toFixed(1) + '%' : 'unrated'}${p.best != null ? `, best ${(p.best * 100).toFixed(1)}%` : ''}${p.forced ? ' (forced)' : ''}`;
      parts.push(`<rect x="${x(i) - step / 2}" y="${T}" width="${step}" height="${H - T - B}" fill="transparent" data-tip="${esc(tip)}" data-jump="${esc(p.label.toLowerCase())}"/>`);
      return parts.join('');
    })
    .join('');
  const packSep = [14, 28]
    .filter((k) => k < n)
    .map((k) => `<line x1="${L + step * k}" x2="${L + step * k}" y1="${T}" y2="${H - B}" class="pack-sep"/>`)
    .join('');
  const packLbl = [0, 14, 28]
    .filter((k) => k < n)
    .map((k, i) => `<text x="${L + step * k + 4}" y="${H - 6}" class="axis-lbl" text-anchor="start">Pack ${i + 1}</text>`)
    .join('');
  return `<figure class="viz strip">
<figcaption><span class="legend"><span class="sw sw-dot"></span>Picked card</span><span class="legend"><span class="sw sw-tick"></span>Best available (17Lands GIH WR)</span><span class="legend"><span class="sw sw-gap"></span>Regret</span></figcaption>
<div class="strip-scroll"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="GIH win rate of each pick versus the best card available">
${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 5}" y="${y(v) + 3}" class="axis-lbl" text-anchor="end">${Math.round(v * 100)}%</text>`).join('')}
<line x1="${L}" x2="${W - R}" y1="${y(baseline)}" y2="${y(baseline)}" class="ref-line"/>
${packSep}${packLbl}${marks}
</svg></div></figure>`;
}
