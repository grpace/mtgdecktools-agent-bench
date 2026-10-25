import type { Ctx } from '../context.js';
import { type EventData, rating } from '../data.js';
import { pickStrip } from '../charts.js';
import { esc, gihClass, num, Page, pct, pips, secs, statTile } from '../html.js';
import { evaluateDraft, seatColors } from '../metrics.js';

export function renderDraft(ctx: Ctx, ev: EventData, seatName: string): string {
  const ratings = ctx.ratingsFor(ev.set.code);
  const page = new Page(2, ctx.cards, ratings);
  const seat = ev.seats.find((s) => s.name === seatName)!;
  const colors = seatColors(ev, seatName, ctx.cards);
  const ds = evaluateDraft(seatName, ev.picks, ratings, ctx.cards, colors);
  const baseline = ratings?.baseline ?? 0.55;
  const tr = ev.transcripts.get(seatName);
  const forced = ds.evals.filter((e) => e.pick.by === 'forced').length;
  const disagreements = ds.evals.filter((e) => e.rated && !e.matchesBest).length;

  const label = (p: { packNumber: number; pickNumber: number }) => `P${p.packNumber}p${p.pickNumber}`;

  // Color of each pick, for the lane timeline.
  const timeline = ds.evals
    .map((e) => {
      const col = ctx.cards.colors(e.pick.pick);
      const cls = !ctx.cards.loaded ? 'na' : col.length === 0 ? 'c' : col.length > 1 ? 'm' : col.toLowerCase();
      return `<a href="#${label(e.pick).toLowerCase()}" class="tl tl-${cls}${e.pick.packNumber > 1 && e.pick.pickNumber === 1 ? ' tl-break' : ''}" data-tip="${esc(
        `${label(e.pick)}: ${e.pick.pick}${col ? ` (${col})` : ''}`,
      )}"></a>`;
    })
    .join('');

  const picksHtml = ds.evals
    .map((e) => {
      const p = e.pick;
      const sorted = [...p.contents].sort((a, b) => (rating(ratings, b)?.gih_wr ?? -1) - (rating(ratings, a)?.gih_wr ?? -1));
      let pickedShown = false;
      const rows = sorted
        .map((name) => {
          const r = rating(ratings, name);
          const isPick = name === p.pick && !pickedShown;
          if (isPick) pickedShown = true;
          const isBest = e.best?.name === name && e.rated;
          const isLane = e.bestInLane?.name === name && e.bestInLane.name !== e.best?.name && e.rated;
          const col = ctx.cards.colors(name);
          return `<li class="${isPick ? 'picked' : ''}${isBest ? ' best' : ''}">
  <span class="pc-name">${page.card(name)}</span>
  <span class="pc-col">${ctx.cards.loaded ? pips(col) : ''}</span>
  <span class="pc-gih ${gihClass(r?.gih_wr, baseline)}">${r?.gih_wr != null ? (r.gih_wr * 100).toFixed(1) : '—'}</span>
  <span class="pc-ata">${r?.ata != null ? r.ata.toFixed(1) : '—'}</span>
  <span class="pc-tags">${isPick ? '<span class="tag tag-pick">Pick</span>' : ''}${isBest ? '<span class="tag tag-best">17L best</span>' : ''}${isLane ? '<span class="tag tag-lane">best in lane</span>' : ''}</span>
</li>`;
        })
        .join('');
      const verdict =
        p.by === 'forced'
          ? '<span class="tag tag-forced">last card, forced</span>'
          : !e.rated
            ? '<span class="muted">no 17Lands data for this pack</span>'
            : e.matchesBest
              ? '<span class="tag tag-agree">took the 17Lands top card</span>'
              : `<span class="tag tag-disagree">${e.regret != null ? `−${num(e.regret)} pp vs ${esc(e.best!.name)}` : `passed ${esc(e.best!.name)} (pick unrated)`}</span>`;
      return `<article class="pick${e.rated && !e.matchesBest ? ' disagree' : ''}${p.by === 'forced' ? ' forced' : ''}" id="${label(p).toLowerCase()}">
  <header>
    <h3>${label(p)} <span class="muted">· pack ${p.packNumber}, pick ${p.pickNumber} · ${p.contents.length} card${p.contents.length === 1 ? '' : 's'}</span></h3>
    <div class="pick-verdict">${verdict}${p.latencyMs != null ? `<span class="muted"> · ${secs(p.latencyMs)}</span>` : ''}</div>
  </header>
  <p class="pick-line">Took ${page.card(p.pick, 'strong')}${e.pickedGih != null ? ` <span class="${gihClass(e.pickedGih, baseline)} gih-inline">${pct(e.pickedGih)}</span>` : ''}</p>
  ${p.note ? `<blockquote class="note">${esc(p.note)}</blockquote>` : p.by === 'agent' ? '<p class="muted small">No note.</p>' : ''}
  ${
    p.contents.length > 1
      ? `<details class="pack"${e.rated && !e.matchesBest ? ' open' : ''}><summary>Pack contents</summary>
  <ol class="pack-list"><li class="pack-head"><span>Card</span><span></span><span title="17Lands games-in-hand win rate">GIH WR</span><span title="17Lands average taken at (pick number in pack)">ATA</span><span></span></li>${rows}</ol></details>`
      : ''
  }
</article>`;
    })
    .join('');

  const body = `
<header class="page-head">
  <p class="eyebrow">Draft viewer · <a href="index.html">${esc(ev.set.code)} event ${esc(ev.id)}</a></p>
  <h1>${esc(seatName)} ${pips(colors)}</h1>
  <p class="meta"><span>${seat.llm ? 'LLM agent' : seat.kind === 'bot' ? 'Bot' : 'Scripted agent'}${tr?.model ? ` · <code>${esc(tr.model)}</code> in Claude Code` : ''}</span><span>Seat ${seat.position + 1} of ${ev.seats.length}</span><span><a href="index.html#deck-${esc(seatName)}">Final deck →</a></span></p>
</header>

<section class="tiles tiles-wide">
  ${statTile(String(ds.picks), 'picks', forced ? `${forced} forced (last card in pack)` : undefined)}
  ${statTile(pct(ds.agreement, 0), 'took the 17Lands top card', `${ds.rated} rated choices · ${disagreements} disagreements`)}
  ${statTile(ds.avgRegret != null ? `${num(ds.avgRegret)} pp` : '—', 'pick regret', `avg GIH ${pct(ds.avgPickedGih)} picked vs ${pct(ds.avgBestGih)} best`)}
  ${statTile(ds.avgLaneRegret != null ? `${num(ds.avgLaneRegret)} pp` : '—', 'in-lane regret', ds.lanePicks ? `${ds.lanePicks} picks in packs 2–3 vs best ${esc(colors || '?')} card` : 'needs card data')}
  ${statTile(secs(ds.medianLatencyMs), 'median time per pick')}
</section>

<section>
  <h2>Pick by pick vs the 17Lands best</h2>
  ${pickStrip(
    ds.evals.map((e) => ({ label: label(e.pick), picked: e.pickedGih, best: e.rated ? e.best?.gih : undefined, match: e.matchesBest, forced: e.pick.by === 'forced' })),
    baseline,
  )}
  <p class="section-note">Dashed line: the 17Lands baseline win rate for ${esc(ev.set.code)} (${pct(baseline)}). Click a column to jump to that pick. GIH WR is a human-population number: it ignores synergy and the drafter's colors, so some "regret" is deliberate.</p>
  ${ctx.cards.loaded ? `<h3 class="h-small">Color of each pick</h3><div class="timeline" aria-label="Color of each pick">${timeline}</div>` : ''}
</section>

<section>
  <div class="section-row"><h2>Picks</h2>
  <div class="seg" role="group" aria-label="Filter picks"><button type="button" class="seg-btn active" data-filter-picks="all">All ${ds.picks}</button><button type="button" class="seg-btn" data-filter-picks="disagree">Disagreements ${disagreements}</button></div></div>
  <p class="section-note">Each pack is sorted by 17Lands GIH WR. <span class="tag tag-pick">Pick</span> is what ${esc(seatName)} took; <span class="tag tag-best">17L best</span> is the highest GIH WR card in the pack${
    ctx.cards.loaded ? '; <span class="tag tag-lane">best in lane</span> is the best card in the final colors (packs 2–3)' : ''
  }. Hover a card name for its image.</p>
  <div class="picks" id="picks">${picksHtml}</div>
</section>`;
  return page.render({
    title: `${seatName} draft · ${ev.set.code}`,
    description: `Pick-by-pick ${ev.set.name} draft by ${seatName}, compared with 17Lands GIH WR.`,
    nav: ctx.nav,
    active: 'events',
    body,
    crumbs: [['Events', '../../index.html#events'], [ev.id, 'index.html'], [`${seatName} draft`]],
  });
}
