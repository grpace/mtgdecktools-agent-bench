import type { Ctx } from '../context.js';
import { rating } from '../data.js';
import { type PickGapRow, setStats } from '../metrics.js';
import { c, esc, gihClass, num, Page, pct, pips, signed, statTile, table } from '../html.js';
import { eventsTable } from './home.js';

export function renderSet(ctx: Ctx, code: string): string {
  const ratings = ctx.ratingsFor(code);
  const page = new Page(1, ctx.cards, ratings);
  const st = setStats(ctx.events, code, ratings);
  const { events, llmEvents, llmPicks, llmDecks } = st;
  const setName = st.name;
  const baseline = ratings?.baseline ?? 0.55;

  const rows = st.cards.map((a) => {
    const r = rating(ratings, a.name);
    const col = ctx.cards.colors(a.name);
    return [
      c(page.card(a.name), a.name),
      c(ctx.cards.loaded ? pips(col) : '', col || 'Z'),
      c(a.picked || '<span class="muted">0</span>', a.picked),
      c(num(a.avgPick), a.avgPick ?? null),
      c(r?.ata != null ? num(r.ata) : '—', r?.ata ?? null),
      c(a.delta != null ? `<span class="${a.delta < -1 ? 'delta-early' : a.delta > 1 ? 'delta-late' : ''}">${signed(a.delta)}</span>` : '—', a.delta ?? null),
      c(`<span class="${gihClass(r?.gih_wr, baseline)} gih-cell">${pct(r?.gih_wr)}</span>`, r?.gih_wr ?? null),
      c(r?.iwd != null ? signed(r.iwd * 100) : '—', r?.iwd ?? null),
      c(a.inDecks || '<span class="muted">0</span>', a.inDecks),
      c(a.deckWr != null ? `${pct(a.deckWr, 0)} <span class="muted small">(${a.deckWins}/${a.deckGames})</span>` : '—', a.deckWr ?? null),
    ];
  });

  const dl = (xs: PickGapRow[], cls: string) =>
    xs.length
      ? `<ol class="dl-list">${xs
          .map((x) => `<li>${page.card(x.card.name)} <span class="${cls}">${signed(x.agentPick - x.ata)}</span> <span class="muted small">agents ${num(x.agentPick)} vs humans ${num(x.ata)} · ${x.picks} picks from ${x.pods} drafts</span></li>`)
          .join('')}</ol>`
      : '<p class="empty">Not enough agent picks yet.</p>';

  const body = `
<header class="page-head">
  <p class="eyebrow">Set report</p>
  <h1><span class="set-code big">${esc(code)}</span> ${esc(setName)}</h1>
  <p class="meta">${
    ratings
      ? `<span>17Lands ${esc(ratings.format ?? 'PremierDraft')}: ${(ratings.games ?? 0).toLocaleString('en-US')} games, ${(ratings.drafts ?? 0).toLocaleString('en-US')} drafts, baseline win rate ${pct(ratings.baseline)}</span><span>ratings built ${esc((ratings.generatedAt ?? '').slice(0, 10))}</span>`
      : '<span class="warn">No 17Lands ratings file for this set.</span>'
  }</p>
</header>

<section class="tiles tiles-wide">
  ${statTile(String(llmEvents.length), 'LLM events')}
  ${statTile(String(llmPicks), 'agent picks', 'non-forced picks by LLM seats')}
  ${statTile(String(llmDecks), 'agent decks')}
  ${statTile(String(st.cards.filter((a) => a.picked > 0).length), 'distinct cards picked')}
</section>

<section class="two-col">
  <div><h2 class="h-mid">Agents take earlier than humans</h2><p class="section-note">From all-agent tables only, picks 1–9 of a pack (where the agent had a real choice), at least 5 picks from 3 different drafts, against 17Lands ATA.</p>${dl(st.gaps.filter((g) => g.gap > 0).slice(0, 8), 'delta-early')}</div>
  <div><h2 class="h-mid">Agents take later than humans</h2><p class="section-note">Same rule: agents let it go later than human drafters do.</p>${dl(st.gaps.filter((g) => g.gap < 0).slice(0, 8), 'delta-late')}</div>
</section>

<section>
  <h2>Cards</h2>
  <p class="section-note"><strong>Agent pick</strong> is the average in-pack pick number when an LLM seat took the card; <strong>Δ</strong> compares it with 17Lands ATA. <strong>Deck WR</strong> is the game win rate of LLM decks that ran the card (tiny samples: read it as anecdotes). Click a header to sort.</p>
  ${table(
    [
      { label: 'Card' },
      { label: 'Col' },
      { label: 'Agent picks', num: true },
      { label: 'Agent pick', num: true, title: 'Average pick number in pack when taken by an LLM agent' },
      { label: '17L ATA', num: true, title: '17Lands average taken at' },
      { label: 'Δ', num: true, title: 'Agent pick − 17Lands ATA (negative = agents take it earlier)' },
      { label: '17L GIH WR', num: true },
      { label: '17L IWD', num: true, title: 'Improvement when drawn, in points' },
      { label: 'In decks', num: true, title: 'LLM decks that ran it' },
      { label: 'Deck WR', num: true, title: 'Game win rate of LLM decks running the card' },
    ],
    rows,
    { id: 'cards-table', sortable: true, filter: 'Filter cards…', cls: 'cards-table' },
  )}
</section>

<section>
  <h2>Events in ${esc(code)}</h2>
  ${eventsTable(page, ctx, events, 'set-events')}
</section>`;
  return page.render({
    title: `${code} · ${setName}`,
    description: `${setName} (${code}): how AI agents draft and play the set, next to 17Lands human data.`,
    nav: ctx.nav,
    active: `set-${code}`,
    body,
    crumbs: [['Sets'], [code]],
  });
}
