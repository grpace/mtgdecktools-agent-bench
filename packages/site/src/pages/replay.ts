import type { Ctx } from '../context.js';
import type { EventData, Game } from '../data.js';
import { lifeChart } from '../charts.js';
import { dateTime, duration, esc, Page, pips, seatChip, secs, statusBadge } from '../html.js';
import { seatColors } from '../metrics.js';
import { activeByTurn, decisionStatus, gameDuration, gameSides, kindLabel, lastTurn, lifeSeries, question, seatGameStats, sortedDecisions, splitView } from '../replay-data.js';

export function renderGame(ctx: Ctx, ev: EventData, g: Game): string {
  const page = new Page(2, ctx.cards, ctx.ratingsFor(ev.set.code));
  const [A, B] = gameSides(g);
  const sideOf = (s: string) => (s === A ? 'a' : 'b');
  const decisions = sortedDecisions(g);
  const known = [...new Set(g.seats.flatMap((s) => ev.decks.get(s)?.main ?? []))].filter((n) => n.length > 3).sort((a, b) => b.length - a.length);
  const linkRe = known.length ? new RegExp(`(${known.map((n) => esc(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g') : null;
  /** Escape, then turn deck card names into tooltip links. */
  const rich = (text: string): string => {
    const e = esc(text);
    return linkRe ? e.replace(linkRe, (m) => page.card(m.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&'))) : e;
  };

  const lifePoints = lifeSeries(g, [A, B]);
  const active = activeByTurn(g);

  // Seat summaries.
  const seatSummary = [A, B]
    .map((s) => {
      const st = seatGameStats(g, s);
      return `<div class="seat-sum side-${sideOf(s)}">
  <h4>${seatChip(s, ev.seats.find((x) => x.name === s)?.llm ?? false)} ${pips(seatColors(ev, s, ctx.cards))}${g.winner === s ? ' <span class="winner">winner</span>' : ''}</h4>
  <dl class="kv kv-inline">
    <div><dt>Decisions</dt><dd>${st.decisions}</dd></div>
    <div><dt>Median latency</dt><dd>${secs(st.medianLatencyMs)}</dd></div>
    <div><dt>Auto-passes</dt><dd>${st.autoPasses}</dd></div>
    <div><dt>Forced</dt><dd>${st.forced}</dd></div>
    <div><dt>Rejected</dt><dd>${st.rejected}</dd></div>${
      st.autoTapper != null ? `\n    <div><dt>Auto-tapper</dt><dd>${st.autoTapper}</dd></div>` : ''
    }
  </dl>
</div>`;
    })
    .join('');

  // Play-by-play.
  let curTurn = -1;
  const items: string[] = [];
  for (const d of decisions) {
    if (d.turn !== curTurn) {
      if (curTurn !== -1) items.push('</div>');
      curTurn = d.turn;
      const who = active.get(d.turn);
      items.push(
        `<div class="turn" id="t${d.turn}"><h3 class="turn-marker"><a href="#t${d.turn}">Turn ${d.turn}</a>${who ? ` <span class="muted">· ${esc(who)}'s turn</span>` : ''}</h3>`,
      );
    }
    const { since, board } = splitView(d.text);
    const q = question(d);
    const a = d.answer;
    const status = decisionStatus(d, g);
    items.push(`<article class="dec side-${sideOf(d.seat)}${a && !a.accepted ? ' rejected' : ''}${status === 'withdrawn' ? ' superseded' : status === 'pending' ? ' pending' : ''}" data-seat="${esc(d.seat)}">
  <header><span class="seat-chip seat-${sideOf(d.seat)}">${esc(d.seat)}</span><span class="kind">${esc(kindLabel(d.kind))}</span><span class="muted small">${esc(d.id)}${q.options ? ` · ${q.options} options` : ''}</span>${
      a?.latencyMs != null ? `<span class="lat">${secs(a.latencyMs)}</span>` : ''
    }</header>
  ${
    a
      ? `<p class="choice">${rich(a.choice)}${a.accepted ? '' : ' <span class="tag tag-disagree">rejected by the engine</span>'}</p>`
      : status === 'withdrawn'
        ? '<p class="choice muted">Withdrawn before an answer: the game state changed (for example the opponent mulliganed) and a new decision replaced it.</p>'
        : `<p class="choice muted">${ev.status === 'in-progress' ? 'Thinking…' : 'No answer recorded'}</p>`
  }
  <details class="view"><summary>What ${esc(d.seat)} saw${q.prompt ? `: <span class="q">${esc(q.prompt)}</span>` : ''}</summary>
    ${since ? `<div class="since"><h5>Since the last decision</h5><pre>${esc(since)}</pre></div>` : ''}
    <pre class="board">${esc(board)}</pre>
  </details>
</article>`);
  }
  if (curTurn !== -1) items.push('</div>');

  const idx = ev.games.indexOf(g);
  const prev = ev.games[idx - 1];
  const next = ev.games[idx + 1];
  const result = g.over
    ? `<div class="result-card"><h3>${g.winner ? `${esc(g.winner)} wins` : 'Draw'}</h3><p>on turn ${g.turns ?? '?'} · ${duration((g.endT ?? g.startT) - g.startT)}</p></div>`
    : `<div class="result-card live">${statusBadge(ev.status === 'in-progress' ? 'in-progress' : 'stalled')}<p>${
        ev.status === 'in-progress' ? 'This game is still being played. Rebuild the site to see new decisions.' : 'This game never finished.'
      }</p></div>`;

  const body = `
<header class="page-head">
  <p class="eyebrow">Game replay · <a href="index.html">${esc(ev.set.code)} event ${esc(ev.id)}</a>${g.code ? ` · table <code>${esc(g.code)}</code>` : ''}</p>
  <h1><span class="side-a-text">${esc(A)}</span> <span class="vs">vs</span> <span class="side-b-text">${esc(B)}</span> <span class="muted">· game ${g.gameInMatch}</span></h1>
  <p class="meta">${g.over ? (g.winner ? `<span class="winner">${esc(g.winner)} wins</span>` : '<span>Draw</span>') : statusBadge(ev.status === 'in-progress' ? 'in-progress' : 'stalled')}<span>${
    g.turns != null ? `${g.turns} turns` : `turn ${lastTurn(g)} so far`
  }</span><span>Started ${esc(dateTime(g.startT))}</span><span>${duration(gameDuration(ev, g))}</span></p>
  <nav class="game-nav">${prev ? `<a href="game-${prev.index}.html">← ${esc(prev.label)}</a>` : '<span></span>'}${next ? `<a href="game-${next.index}.html">${esc(next.label)} →</a>` : '<span></span>'}</nav>
</header>

<section class="seat-sums">${seatSummary}</section>

${lifePoints.length > 1 ? `<section>${lifeChart(lifePoints, [A, B])}</section>` : ''}

<section>
  <div class="section-row"><h2>Play-by-play</h2>
  <div class="seg" role="group" aria-label="Filter decisions">
    <button type="button" class="seg-btn active" data-filter-seat="">Both</button>
    <button type="button" class="seg-btn" data-filter-seat="${esc(A)}">${esc(A)}</button>
    <button type="button" class="seg-btn" data-filter-seat="${esc(B)}">${esc(B)}</button>
    <button type="button" class="seg-btn" data-toggle-views>Expand views</button>
  </div></div>
  <p class="section-note">Every decision the server put to an agent, in time order, with the option it chose and its note. Routine priority passes the server answered automatically (${Object.values(g.autoPasses).reduce((a, b) => a + b, 0)} this game) aren't shown. Open <em>What … saw</em> for the full text the agent was given.</p>
  <div class="pbp">${items.join('\n') || '<p class="empty">No decisions yet.</p>'}</div>
  ${result}
</section>`;
  return page.render({
    title: `${g.label} · ${ev.set.code}`,
    description: `Replay of ${g.label} (${ev.set.name}): every decision with the agent's note.`,
    nav: ctx.nav,
    active: 'events',
    body,
    crumbs: [['Events', '../../index.html#events'], [ev.id, 'index.html'], [`Game ${g.index}`]],
  });
}
