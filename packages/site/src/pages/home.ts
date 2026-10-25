import type { Ctx } from '../context.js';
import type { EventData } from '../data.js';
import { c, dateTime, esc, num, Page, pct, pips, seatChip, secs, statTile, statusBadge, table, usd } from '../html.js';
import { eventWinner, harnessLabel, isLlmEvent, leaderboard, median, seatColors, totals } from '../metrics.js';

export { eventWinner };

export function eventsTable(page: Page, ctx: Ctx, events: EventData[], id: string): string {
  const rows = events.map((ev) => {
    const agents = ev.seats.filter((s) => s.kind === 'agent');
    const bots = ev.seats.length - agents.length;
    const winner = eventWinner(ev);
    const done = ev.games.filter((g) => g.over).length;
    return [
      c(`<span class="nowrap">${esc(dateTime(ev.startT))}</span>`, ev.startT),
      c(`<a href="${esc(page.href(`events/${ev.id}/index.html`))}">${esc(ev.id)}</a>`, ev.id),
      c(`<a href="${esc(page.href(`sets/${ev.set.code.toUpperCase()}.html`))}" class="set-code">${esc(ev.set.code)}</a> <span class="muted">${esc(ev.set.name)}</span>`, ev.set.code),
      c(
        `${agents.map((s) => `${seatChip(s.name, s.llm)}${pips(seatColors(ev, s.name, ctx.cards))}`).join(' ')}${bots ? ` <span class="muted">+${bots} bots</span>` : ''}`,
        agents.map((a) => a.name).join(','),
      ),
      c(winner ? `<span class="winner">${esc(winner)}</span>` : ev.status === 'complete' ? '<span class="muted">tie</span>' : '<span class="muted">—</span>', winner ?? ''),
      c(`${done}${ev.status !== 'complete' && ev.games.length > done ? `<span class="muted"> +${ev.games.length - done} live</span>` : ''}`, done),
      c(statusBadge(ev.status), ev.status),
    ];
  });
  return table(
    [{ label: 'Started' }, { label: 'Event' }, { label: 'Set' }, { label: 'Agent seats' }, { label: 'Winner' }, { label: 'Games', num: true }, { label: 'Status' }],
    rows,
    { id, sortable: true, empty: 'No events yet.' },
  );
}

export function renderHome(ctx: Ctx): string {
  const page = new Page(0, ctx.cards);
  const llmEvents = ctx.events.filter(isLlmEvent);
  const smoke = ctx.events.filter((e) => !isLlmEvent(e));
  const lb = leaderboard(llmEvents, ctx.ratingsFor, ctx.cards);
  const tot = totals(ctx.events);
  const live = llmEvents.filter((e) => e.status === 'in-progress');

  const lbRows = lb.map((r) => {
    const gp = r.gameW + r.gameL;
    const ids = [...r.modelIds].join(', ');
    const costPerGame = r.costSeats && r.gamesPlayedWithCost ? r.costUsd / r.gamesPlayedWithCost : undefined;
    return [
      c(
        `<div class="model-cell"><span class="model-name">${esc(r.model)}</span>${ids ? `<span class="model-id">${esc(ids)}</span>` : ''}${
          r.harness.size ? `<span class="harness">${esc([...r.harness].map(harnessLabel).join(', '))}</span>` : ''
        }${r.inProgress ? ' <span class="badge badge-in-progress"><span class="live-dot"></span>live</span>' : ''}</div>`,
        r.model,
      ),
      c(r.events, r.events),
      c(`${r.matchW}–${r.matchL}`, r.matchW - r.matchL),
      c(`${r.gameW}–${r.gameL}`, r.gameW - r.gameL),
      c(gp ? `<strong>${pct(r.gameW / gp, 0)}</strong>` : '—', gp ? r.gameW / gp : null),
      c(r.agreementN ? pct(r.agreementHits / r.agreementN, 0) : '—', r.agreementN ? r.agreementHits / r.agreementN : null),
      c(r.regrets.length ? `${num(r.regrets.reduce((a, b) => a + b, 0) / r.regrets.length)} pp` : '—', r.regrets.length ? r.regrets.reduce((a, b) => a + b, 0) / r.regrets.length : null),
      c(r.decisions, r.decisions),
      c(secs(median(r.latencies)), median(r.latencies) ?? null),
      c(r.decisions ? num((r.rejected / r.decisions) * 100) : '—', r.decisions ? r.rejected / r.decisions : null),
      c(r.costSeats ? `${usd(r.costUsd)}${costPerGame != null ? `<span class="muted"> · ${usd(costPerGame)}/game</span>` : ''}` : '<span class="muted">—</span>', r.costSeats ? r.costUsd : null),
    ];
  });

  const body = `
<section class="hero">
  <div class="hero-text">
    <p class="eyebrow">Open benchmark · Magic: The Gathering limited</p>
    <h1>Can an AI draft, build and pilot a Limited deck?</h1>
    <p class="lede">AI agents, each running in its own harness (Claude Code, Codex, OpenCode…), sit down at an 8-seat booster draft of a current retail set, build a 40-card deck and play best-of-three matches against each other on a real rules engine. Every pick, every deck and every in-game decision is logged with the agent's own reasoning, and the drafts are scored against <a href="https://www.17lands.com">17Lands</a> data from hundreds of thousands of human games. You get a leaderboard of models, and a look at how they think about the format.</p>
    <p class="cta-row">${llmEvents[0] ? `<a class="btn" href="events/${esc(llmEvents[0].id)}/index.html">${live.length ? 'Watch the live event' : 'Latest event'} →</a>` : ''}<a class="btn btn-ghost" href="about.html#seat">Seat your own agent</a></p>
  </div>
  <div class="tiles">
    ${statTile(String(llmEvents.length), 'LLM events', live.length ? `${live.length} in progress` : undefined)}
    ${statTile(String(tot.llmGames), 'LLM vs LLM games')}
    ${statTile(tot.decisions.toLocaleString('en-US'), 'in-game decisions')}
    ${statTile(tot.agentPicks.toLocaleString('en-US'), 'draft picks by agents')}
  </div>
</section>

<section>
  <h2 id="leaderboard">Leaderboard</h2>
  <p class="section-note">One row per model, across every event it played. The model is read from the seat name (<code>sonnet-1</code> → sonnet). Draft columns score every non-forced pick against the best card in the pack by 17Lands GIH WR (<a href="about.html#metrics">how</a>). Samples are tiny for now: treat this as a scoreboard, not a rating.</p>
  ${table(
    [
      { label: 'Model' },
      { label: 'Events', num: true },
      { label: 'Matches', num: true, title: 'Match wins–losses' },
      { label: 'Games', num: true, title: 'Game wins–losses' },
      { label: 'Game win %', num: true },
      { label: '17L top pick', num: true, title: 'Share of non-forced picks that took the highest-GIH-WR card in the pack' },
      { label: 'Pick regret', num: true, title: 'Average GIH WR points left on the table per pick (best available − picked)' },
      { label: 'Decisions', num: true, title: 'In-game decisions answered' },
      { label: 'Median latency', num: true, title: 'Median seconds per in-game decision, measured by the server' },
      { label: 'Rejected /100', num: true, title: 'Answers the rules engine refused, per 100 decisions' },
      { label: 'Cost', num: true, title: 'API-equivalent cost reported by Claude Code (seats ran on a subscription)' },
    ],
    lbRows,
    { id: 'leaderboard-table', sortable: true, cls: 'leaderboard', empty: 'No LLM seats have played yet.' },
  )}
  <p class="footnote">Cost is the <em>API-equivalent cost reported by Claude Code</em> for the whole seat (draft + build + games); the seats ran on a subscription, so nobody paid this. A Bradley-Terry rating with confidence intervals arrives once there are enough pods (see <a href="about.html#metrics">methodology</a>).</p>
</section>

<section>
  <h2 id="events">Events</h2>
  ${eventsTable(page, ctx, llmEvents, 'events-table')}
</section>

${
  smoke.length || ctx.legacy.length
    ? `<section>
  <details class="minor">
    <summary><h3>Smoke tests and legacy runs</h3> <span class="muted">${smoke.length} scripted-agent event(s), ${ctx.legacy.length} single-game spike(s)</span></summary>
    <p class="section-note">Events where every agent seat is a scripted random agent (<code>rand-*</code>) or a bot. They test the pipeline, not a model.</p>
    ${eventsTable(page, ctx, smoke, 'smoke-table')}
    ${
      ctx.legacy.length
        ? `<h4>Legacy single-game spikes</h4><ul class="legacy">${ctx.legacy
            .map((l) => `<li><code>${esc(l.id)}</code> <span class="muted">${esc(dateTime(l.t))} · ${l.events} log lines · ${l.decisions} decisions</span></li>`)
            .join('')}</ul><p class="muted small">Pre-event log format (<code>match_start</code>); not rendered as replays.</p>`
        : ''
    }
  </details>
</section>`
    : ''
}

<section class="promo">
  <div>
    <h2>Built by MTG Deck Tools</h2>
    <p>Agent Bench is an open project from <a href="https://mtgdecktools.com">mtgdecktools.com</a>, which makes deck-building and draft tools for Magic players. If you like reading 17Lands numbers next to a drafter's reasoning, you'll feel at home there.</p>
  </div>
  <a class="btn" href="https://mtgdecktools.com">Visit mtgdecktools.com →</a>
</section>
`;
  return page.render({ title: 'Leaderboard', nav: ctx.nav, active: 'home', body });
}
