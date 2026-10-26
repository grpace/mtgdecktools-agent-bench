import type { Ctx } from '../context.js';
import { type CardDb, type Deck, type EventData, rating } from '../data.js';
import { manaCurve } from '../charts.js';
import { c, dateTime, duration, esc, manaCost, num, Page, pct, pips, seatChip, secs, statusBadge, table, tokens, usd } from '../html.js';
import { deckSummary, evaluateDraft, eventWinner, median, playStats, seatColors } from '../metrics.js';
import { lastTurn } from '../replay-data.js';
import { seatCost } from '../cost.js';
import { EARLY_TEST_DATA_LABEL, earlyTestData } from '../scoring.js';

/** A seat whose sessions didn't all report a cost (a fresh session per game): its list-price estimate, labeled. */
function estimatedCost(ev: EventData, seat: string, modelId: string | undefined): string {
  const c = modelId ? seatCost(ev, seat, modelId) : null;
  return c ? `${usd(c.usd)} <span class="muted">(estimated at list price)</span>` : '—';
}

export function deckBlock(page: Page, deck: Deck, cards: CardDb, colors: string): string {
  const ds = deckSummary(deck, cards, page.ratings, colors);
  const groupHtml = ds.groups
    .map(({ type: t, total, cards: list }) => {
      return `<div class="deck-group"><h5>${t === 'Other' && !cards.loaded ? 'Spells' : t === 'Sorcery' ? 'Sorceries' : `${t}s`} <span class="muted">${total}</span></h5><ul>${list
        .map(([name, n]) => {
          const r = rating(page.ratings, name);
          return `<li><span class="qty">${n}</span>${page.card(name)}${manaCost(cards.get(name)?.cost)}${
            r?.gih_wr != null ? `<span class="gih-mini" title="17Lands GIH WR">${(r.gih_wr * 100).toFixed(1)}</span>` : ''
          }</li>`;
        })
        .join('')}</ul></div>`;
    })
    .join('');
  return `<article class="deck">
  <header class="deck-head">
    <div><h4>${esc(deck.seat)} ${pips(colors)}</h4>
    <p class="muted small">${ds.mainCount} cards · ${ds.landCount} lands · built by ${deck.by === 'auto' ? 'the reference builder (agent delegated)' : esc(deck.by)}${
      deck.latencyMs != null ? ` in ${secs(deck.latencyMs)}` : ''
    }${ds.avgGih != null ? ` · avg GIH WR ${pct(ds.avgGih)}` : ''}</p></div>
    ${ds.mvs.length ? manaCurve(ds.mvs, `${deck.seat} mana curve`) : ''}
  </header>
  <div class="deck-groups">${groupHtml}</div>
  <p class="basics"><strong>Basics:</strong> ${ds.basics.map(([n, k]) => `${k} ${esc(n)}`).join(', ') || '—'}</p>
  <details class="sideboard"><summary>Sideboard (${deck.sideboard.length})</summary><ul class="side-list">${ds.sideboard
    .map(([name, n]) => `<li>${n > 1 ? `<span class="qty">${n}</span>` : ''}${page.card(name)}</li>`)
    .join('')}</ul></details>
</article>`;
}

export function renderEvent(ctx: Ctx, ev: EventData): string {
  const ratings = ctx.ratingsFor(ev.set.code);
  const page = new Page(2, ctx.cards, ratings);
  const agents = ev.seats.filter((s) => s.kind === 'agent');
  const winner = eventWinner(ev);
  const gamesDone = ev.games.filter((g) => g.over).length;
  const expectedMatches = (agents.length * (agents.length - 1)) / 2;

  const stages = [
    ['Draft', ev.picks.length ? `${ev.picks.length} picks` : 'waiting', ev.picks.length > 0],
    ['Build', `${ev.decks.size}/${agents.length} decks`, ev.decks.size >= agents.length && agents.length > 0],
    ['Games', `${gamesDone} played${ev.games.length > gamesDone ? `, ${ev.games.length - gamesDone} live` : ''}`, ev.status === 'complete'],
  ] as const;

  // Standings
  const standRows = ev.standings.map((st, i) => {
    const seat = ev.seats.find((s) => s.name === st.name);
    const ps = playStats(ev.games, st.name);
    return [
      c(String(i + 1), i + 1),
      c(`${seatChip(st.name, seat?.llm ?? false)}${winner === st.name ? ' <span class="winner">winner</span>' : ''}`, st.name),
      c(pips(seatColors(ev, st.name, ctx.cards)), seatColors(ev, st.name, ctx.cards)),
      c(`${st.matchWins}–${st.matchLosses}`, st.matchWins - st.matchLosses),
      c(`${st.gameWins}–${st.gameLosses}`, st.gameWins - st.gameLosses),
      c(String(ps.answered), ps.answered),
      c(secs(median(ps.latencies)), median(ps.latencies) ?? null),
      c(
        `<a href="draft-${esc(st.name)}.html">Draft</a> · <a href="#deck-${esc(st.name)}">Deck</a>`,
      ),
    ];
  });

  // Matches
  const matchHtml = ev.matches.length
    ? ev.matches
        .map((m) => {
          const games = m.games
            .map((g) => {
              const live = !g.over;
              const dec = (s: string) => g.decisions.filter((d) => d.seat === s && d.answer).length;
              return `<li class="game-row${live ? ' live' : ''}">
  <a href="game-${g.index}.html" class="game-link">Game ${g.gameInMatch}</a>
  <span>${live ? statusBadge('in-progress') : g.winner ? `<span class="winner">${esc(g.winner)}</span> wins` : 'draw'}</span>
  <span class="muted">${g.turns != null ? `${g.turns} turns` : `turn ${lastTurn(g)}…`}</span>
  <span class="muted">${g.seats.map((s) => `${esc(s)} ${dec(s)} decisions`).join(' · ')}</span>
  <span class="muted">${duration((g.endT ?? ev.lastT) - g.startT)}</span>
  <a href="game-${g.index}.html" class="btn btn-small">Replay →</a>
</li>`;
            })
            .join('');
          return `<article class="match">
  <header><h4>${seatChip(m.a, true)} <span class="score">${m.wins[m.a] ?? 0} – ${m.wins[m.b] ?? 0}</span> ${seatChip(m.b, true)}</h4>${m.done ? '' : statusBadge('in-progress')}</header>
  <ul class="games">${games}</ul>
</article>`;
        })
        .join('')
    : `<p class="empty">${ev.status === 'in-progress' ? 'Matches start once every agent has submitted a deck.' : 'No matches were played.'}</p>`;

  // Decks
  const deckHtml = agents
    .map((s) => {
      const d = ev.decks.get(s.name);
      return `<div id="deck-${esc(s.name)}">${d ? deckBlock(page, d, ctx.cards, seatColors(ev, s.name, ctx.cards)) : `<p class="empty">${esc(s.name)} has not submitted a deck yet.</p>`}</div>`;
    })
    .join('');

  // Draft comparison across the pod
  const draftRows = ev.seats
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((s) => {
      const ds = evaluateDraft(s.name, ev.picks, ratings, ctx.cards, seatColors(ev, s.name, ctx.cards));
      return [
        c(String(s.position + 1), s.position),
        c(s.kind === 'agent' ? `<a href="draft-${esc(s.name)}.html">${seatChip(s.name, s.llm)}</a>` : seatChip(s.name, false), s.name),
        c(s.kind === 'bot' ? 'GIH bot' : s.llm ? 'LLM agent' : 'scripted', s.kind),
        c(pips(ds.colors), ds.colors),
        c(`${ds.picks}`, ds.picks),
        c(pct(ds.agreement, 0), ds.agreement ?? null),
        c(pct(ds.avgPickedGih), ds.avgPickedGih ?? null),
        c(ds.avgRegret != null ? `${num(ds.avgRegret)} pp` : '—', ds.avgRegret ?? null),
        c(ds.avgLaneRegret != null ? `${num(ds.avgLaneRegret)} pp` : '—', ds.avgLaneRegret ?? null),
      ];
    });

  // Transcripts
  const trHtml = agents
    .map((s) => {
      const tr = ev.transcripts.get(s.name);
      if (!tr) return '';
      if (!tr.lines) {
        return `<article class="usage-card"><header><h4>${seatChip(s.name, s.llm)}</h4></header><p class="muted">The transcript file <code>${esc(`transcript-${s.name}.jsonl`)}</code> is empty, so there is no usage or cost to show.</p></article>`;
      }
      const tools = Object.entries(tr.toolCalls).sort((a, b) => b[1] - a[1]);
      return `<article class="usage-card">
  <header><h4>${seatChip(s.name, s.llm)}</h4><span class="muted">${esc(tr.model ?? 'model unknown')} · Claude Code</span>${tr.done ? '' : statusBadge('in-progress')}</header>
  <dl class="kv">
    <div><dt>API-equivalent cost</dt><dd>${!tr.done ? '<span class="muted">when the seat finishes</span>' : tr.costUsd != null ? usd(tr.costUsd) : estimatedCost(ev, s.name, s.modelId ?? tr.model)}</dd></div>
    <div><dt>Wall time</dt><dd>${duration(tr.durationMs)}</dd></div>
    <div><dt>Assistant turns</dt><dd>${tr.numTurns ?? '—'}</dd></div>
    <div><dt>Output tokens</dt><dd>${tokens(tr.outputTokens)}${tr.thinkingTokens ? ` <span class="muted">(${tokens(tr.thinkingTokens)} thinking)</span>` : ''}</dd></div>
    <div><dt>Input tokens</dt><dd>${tokens(tr.inputTokens + tr.cacheReadTokens + tr.cacheCreationTokens)} <span class="muted">(${tokens(tr.cacheReadTokens)} cache read)</span></dd></div>
    <div><dt>Tool calls</dt><dd>${tools.map(([n, k]) => `<code>${esc(n)}</code> ${k}`).join(' · ') || '—'}${tr.toolErrors ? ` <span class="warn">${tr.toolErrors} errors</span>` : ''}</dd></div>
  </dl>
</article>`;
    })
    .join('');

  const swaps = ev.packs.flatMap((p) => (p.swaps ?? []).map((s) => ({ ...s, round: p.round })));

  const body = `
<header class="page-head">
  <p class="eyebrow"><a href="../../sets/${esc(ev.set.code.toUpperCase())}.html" class="set-code">${esc(ev.set.code)}</a> ${esc(ev.set.name)} · ${ev.seats.length}-seat booster draft · best of ${ev.bestOf}${ev.sideboarding ? ' with sideboarding' : ev.bestOf === 3 ? ' without sideboarding' : ''}${earlyTestData(ev) ? ` · <strong>${EARLY_TEST_DATA_LABEL}</strong> (not rated)` : ''}</p>
  <h1>${agents.map((s) => esc(s.name)).join(' <span class="vs">vs</span> ')}</h1>
  <p class="meta">${statusBadge(ev.status)} <span>Started ${esc(dateTime(ev.startT))}</span> <span>Seed <code>${esc(ev.seed ?? '—')}</code></span> <span>Event <code>${esc(ev.id)}</code></span>${
    winner ? ` <span class="winner">Winner: ${esc(winner)}</span>` : ''
  }</p>
  <ol class="stages">${stages.map(([n, d, ok]) => `<li class="${ok ? 'done' : ''}"><strong>${n}</strong><span>${esc(d)}</span></li>`).join('')}</ol>
  ${ev.status === 'stalled' ? `<p class="warn-box">No new log lines since ${esc(dateTime(ev.lastT))}: this event looks abandoned.</p>` : ''}
</header>

<section>
  <h2>Standings</h2>
  ${table(
    [{ label: '#', num: true }, { label: 'Seat' }, { label: 'Colors' }, { label: 'Matches', num: true }, { label: 'Games', num: true }, { label: 'Decisions', num: true }, { label: 'Median latency', num: true }, { label: '' }],
    standRows,
    { empty: 'No agent seats.' },
  )}
  ${ev.status !== 'complete' && agents.length > 1 ? `<p class="footnote">Standings so far, computed from finished games (${ev.matches.filter((m) => m.done).length}/${expectedMatches} matches complete).</p>` : ''}
</section>

<section>
  <h2>Matches</h2>
  ${matchHtml}
</section>

<section>
  <h2>Decks</h2>
  <div class="decks">${deckHtml}</div>
</section>

<section>
  <h2>Draft quality across the pod</h2>
  <p class="section-note">Every seat is scored the same way: how often it took the pack's highest-GIH-WR card, the average GIH WR of what it took, and the GIH WR points it left on the table. <em>In-lane regret</em> only compares against cards in the seat's final colors, from pack 2 on. The bots draft by GIH WR plus color commitment, so they set a high bar on these numbers by design.</p>
  ${table(
    [
      { label: 'Seat', num: true },
      { label: 'Drafter' },
      { label: 'Type' },
      { label: 'Final colors' },
      { label: 'Picks', num: true },
      { label: '17L top pick', num: true },
      { label: 'Avg pick GIH', num: true },
      { label: 'Regret', num: true },
      { label: 'In-lane regret', num: true },
    ],
    draftRows,
    { sortable: true },
  )}
</section>

${
  trHtml
    ? `<section>
  <h2>Cost and usage</h2>
  <p class="section-note">From each seat's Claude Code transcript. Figures cover the whole event for that seat (draft, build and every game). Cost is the <em>API-equivalent cost reported by Claude Code</em>; these seats ran on a subscription.</p>
  <div class="usage-grid">${trHtml}</div>
</section>`
    : ''
}

${
  swaps.length
    ? `<section><details class="minor"><summary><h3>Card swaps</h3> <span class="muted">${swaps.length} unsupported cards replaced in packs</span></summary>
  <p class="section-note">Cards the rules engine doesn't support yet were swapped for supported cards of the same rarity before the packs were opened.</p>
  <ul class="swap-list">${swaps.map((s) => `<li>Pack ${s.round}: ${page.card(s.from, 'struck')} → ${page.card(s.to)}</li>`).join('')}</ul>
</details></section>`
    : ''
}
`;
  return page.render({
    title: `${ev.set.code} event ${ev.id}`,
    description: `${agents.map((s) => s.name).join(' vs ')} in a ${ev.set.name} booster draft: standings, decks, drafts and replays.`,
    nav: ctx.nav,
    active: 'events',
    body,
    crumbs: [['Events', '../../index.html#events'], [ev.id]],
  });
}
