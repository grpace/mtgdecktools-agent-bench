/** HTML helpers: escaping, page layout, shared components. */
import type { CardDb, Ratings } from './data.js';
import { rating } from './data.js';

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Safe JSON for an inline <script type="application/json">. */
export function jsonScript(id: string, data: unknown): string {
  return `<script type="application/json" id="${id}">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ---------------------------------------------------------------------------
// Formatting

export const pct = (x: number | undefined | null, digits = 1): string => (x == null || Number.isNaN(x) ? '—' : `${(x * 100).toFixed(digits)}%`);
export const num = (x: number | undefined | null, digits = 1): string => (x == null || Number.isNaN(x) ? '—' : x.toFixed(digits));
export const signed = (x: number | undefined | null, digits = 1): string =>
  x == null || Number.isNaN(x) ? '—' : `${x > 0 ? '+' : x < 0 ? '−' : '±'}${Math.abs(x).toFixed(digits)}`;
export const secs = (ms: number | undefined | null): string => (ms == null ? '—' : ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);
export const usd = (x: number | undefined | null): string => (x == null ? '—' : `$${x < 10 ? x.toFixed(2) : x.toFixed(0)}`);
export function duration(ms: number | undefined): string {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
export function tokens(n: number | undefined): string {
  if (n == null) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
export function dateTime(t: number): string {
  const d = new Date(t);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}
export const date = (t: number): string => new Date(t).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Components

export function pips(colors: string, title?: string): string {
  if (!colors) return '<span class="pips pips-none" title="colorless / unknown">◇</span>';
  return `<span class="pips" title="${esc(title ?? colors)}">${colors
    .split('')
    .map((c) => `<span class="pip pip-${c.toLowerCase()}" aria-label="${c}">${c}</span>`)
    .join('')}</span>`;
}

/** Render a "{2}{W}{U/B}" cost as small mana symbols. */
export function manaCost(cost: string | undefined): string {
  if (!cost) return '';
  const syms = [...cost.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
  return `<span class="cost">${syms
    .map((s) => {
      const c = s.length === 1 && 'WUBRG'.includes(s) ? s.toLowerCase() : s.includes('/') ? 'h' : 'c';
      return `<span class="ms ms-${c}">${esc(s.replace('/', ''))}</span>`;
    })
    .join('')}</span>`;
}

export function statusBadge(status: string): string {
  const label = status === 'complete' ? 'Complete' : status === 'in-progress' ? 'In progress' : 'Incomplete';
  return `<span class="badge badge-${status}">${status === 'in-progress' ? '<span class="live-dot"></span>' : ''}${label}</span>`;
}

export function seatChip(name: string, llm: boolean, href?: string): string {
  const inner = `<span class="seat-chip ${llm ? 'seat-llm' : 'seat-bot'}">${esc(name)}</span>`;
  return href ? `<a href="${esc(href)}">${inner}</a>` : inner;
}

export function gihClass(g: number | null | undefined, baseline = 0.55): string {
  if (g == null) return 'gih-na';
  const d = g - baseline;
  if (d >= 0.04) return 'gih-a';
  if (d >= 0.015) return 'gih-b';
  if (d >= -0.015) return 'gih-c';
  if (d >= -0.04) return 'gih-d';
  return 'gih-f';
}

// ---------------------------------------------------------------------------
// Page: tracks depth for relative links and the cards that need tooltip data.

export interface SiteNav {
  sets: string[];
}

export class Page {
  readonly cardNames = new Set<string>();

  constructor(
    readonly depth: number,
    readonly cards: CardDb,
    readonly ratings: Ratings | null = null,
  ) {}

  get root(): string {
    return this.depth === 0 ? './' : '../'.repeat(this.depth);
  }

  href(path: string): string {
    return this.root + path;
  }

  /** A card name with a lazy image tooltip. */
  card(name: string, extraClass = ''): string {
    this.cardNames.add(name);
    return `<span class="card-ref ${extraClass}" data-card="${esc(name)}" tabindex="0">${esc(name)}</span>`;
  }

  cardData(): Record<string, [string, string, string, string, number | null, number | null]> {
    const out: Record<string, [string, string, string, string, number | null, number | null]> = {};
    for (const n of this.cardNames) {
      const c = this.cards.get(n);
      const r = rating(this.ratings, n);
      out[n] = [c?.cost ?? '', c?.typeLine ?? '', c?.pt ?? (c?.loyalty ? `Loyalty ${c.loyalty}` : ''), c?.oracle ?? '', r?.gih_wr ?? null, r?.ata ?? null];
    }
    return out;
  }

  render(opts: { title: string; description?: string; nav: SiteNav; active?: string; body: string; crumbs?: Array<[string, string?]> }): string {
    const { title, nav, body } = opts;
    const desc = opts.description ?? 'AI agents booster-draft, build and play Magic: The Gathering limited against each other. Open benchmark by MTG Deck Tools.';
    const link = (path: string, label: string, key: string) =>
      `<a href="${esc(this.href(path))}"${opts.active === key ? ' aria-current="page"' : ''}>${esc(label)}</a>`;
    const crumbs = opts.crumbs?.length
      ? `<nav class="crumbs" aria-label="Breadcrumb">${opts.crumbs
          .map(([label, href]) => (href ? `<a href="${esc(href)}">${esc(label)}</a>` : `<span>${esc(label)}</span>`))
          .join('<span class="sep">/</span>')}</nav>`
      : '';
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · MTG Deck Tools Agent Bench</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:title" content="${esc(title)} · MTG Deck Tools Agent Bench">
<meta property="og:description" content="${esc(desc)}">
<meta name="color-scheme" content="dark light">
<script>try{var t=localStorage.getItem('theme');if(t)document.documentElement.dataset.theme=t;}catch(e){}</script>
<link rel="stylesheet" href="${this.href('assets/style.css')}">
</head>
<body>
<header class="site-header">
  <div class="wrap header-row">
    <a class="brand" href="${this.href('index.html')}" aria-label="Agent Bench home">
      <span class="brand-mark" aria-hidden="true"><span class="pip pip-w"></span><span class="pip pip-u"></span><span class="pip pip-b"></span><span class="pip pip-r"></span><span class="pip pip-g"></span></span>
      <span class="brand-text"><strong>Agent Bench</strong><small>by MTG Deck Tools</small></span>
    </a>
    <nav class="main-nav">
      ${link('index.html', 'Leaderboard', 'home')}
      ${link('index.html#events', 'Events', 'events')}
      ${nav.sets.map((s) => link(`sets/${s}.html`, s, `set-${s}`)).join('\n      ')}
      ${link('about.html', 'About', 'about')}
      <button class="theme-toggle" type="button" aria-label="Toggle light/dark theme" title="Toggle light/dark theme">◐</button>
    </nav>
  </div>
</header>
<main class="wrap">
${crumbs}
${body}
</main>
<footer class="site-footer">
  <div class="wrap">
    <p><strong>MTG Deck Tools Agent Bench</strong> is an open benchmark from <a href="https://mtgdecktools.com">mtgdecktools.com</a>. Every number on this site is generated from the event logs.</p>
    <p class="legal">MTG Deck Tools Agent Bench is unofficial Fan Content permitted under the <a href="https://company.wizards.com/en/legal/fancontentpolicy">Fan Content Policy</a>. Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC.</p>
    <p class="legal">Card data © Wizards of the Coast; ratings from 17Lands public datasets (<a href="https://www.17lands.com">17lands.com</a>, CC BY 4.0; derived aggregates, not endorsed by 17Lands). Card images via <a href="https://scryfall.com">Scryfall</a>.</p>
  </div>
</footer>
<div id="card-tip" class="card-tip" hidden></div>
${jsonScript('card-data', this.cardData())}
<script src="${this.href('assets/site.js')}" defer></script>
</body>
</html>
`;
  }
}

/** A sortable table. Cells are pre-rendered HTML; `sort` values make numeric sorting work. */
export interface Col { label: string; title?: string; num?: boolean; cls?: string }
export interface Cell { html: string; sort?: string | number | null; cls?: string }

export function table(cols: Col[], rows: Cell[][], opts: { id?: string; cls?: string; sortable?: boolean; filter?: string; empty?: string } = {}): string {
  if (!rows.length) return `<p class="empty">${esc(opts.empty ?? 'Nothing here yet.')}</p>`;
  const head = cols
    .map((c) => `<th${c.num ? ' class="num"' : ''}${c.title ? ` title="${esc(c.title)}"` : ''}${opts.sortable ? ` data-sort="${c.num ? 'num' : 'text'}" tabindex="0"` : ''}>${c.label}</th>`)
    .join('');
  const body = rows
    .map(
      (r) =>
        `<tr>${r
          .map((cell, i) => {
            const col = cols[i];
            const cls = [col?.num ? 'num' : '', col?.cls ?? '', cell.cls ?? ''].filter(Boolean).join(' ');
            const sv = cell.sort === undefined ? '' : ` data-v="${esc(cell.sort ?? '')}"`;
            return `<td${cls ? ` class="${cls}"` : ''}${sv}>${cell.html}</td>`;
          })
          .join('')}</tr>`,
    )
    .join('\n');
  const filter = opts.filter
    ? `<div class="table-tools"><input type="search" class="table-filter" placeholder="${esc(opts.filter)}" aria-label="${esc(opts.filter)}" data-for="${esc(opts.id ?? '')}"></div>`
    : '';
  return `${filter}<div class="table-wrap"><table${opts.id ? ` id="${esc(opts.id)}"` : ''} class="data ${opts.sortable ? 'sortable ' : ''}${opts.cls ?? ''}"><thead><tr>${head}</tr></thead><tbody>
${body}
</tbody></table></div>`;
}

export const c = (html: string | number, sort?: string | number | null, cls?: string): Cell => ({ html: String(html), sort, cls });

export function statTile(value: string, label: string, sub?: string): string {
  return `<div class="tile"><div class="tile-value">${value}</div><div class="tile-label">${esc(label)}</div>${sub ? `<div class="tile-sub">${sub}</div>` : ''}</div>`;
}
