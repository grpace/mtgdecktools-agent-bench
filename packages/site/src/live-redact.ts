/**
 * Live redaction: an event that is still running is exported under the same fairness policy as the Director's
 * spectator stream (packages/director/src/spectate-policy.ts, docs/SPECTATING.md). The hosted export refreshes
 * every two minutes while events run, so without this it would publish hands, notes and every pick live.
 *
 * Applied to the loaded EventData before anything is derived from it, so every file (index, event, draft, game,
 * set) only ever sees released information. Finished and aborted events are exported in full.
 */
import { describePolicy, isHiddenChoice, redactCards, type SpectatePolicy } from '../../director/src/spectate-policy.js';
import type { EventData, Game } from './data.js';
import { lastTurn } from './replay-data.js';

export function isLive(ev: EventData): boolean {
  return ev.status !== 'complete' && !ev.aborted;
}

export function redactLive(ev: EventData, policy: SpectatePolicy): void {
  if (!isLive(ev)) return;
  const nSeats = ev.seats.length;
  const packSize = ev.packs[0]?.packs[0]?.length ?? 0;
  const perRound = new Map<number, number>();
  for (const p of ev.picks) perRound.set(p.packNumber, (perRound.get(p.packNumber) ?? 0) + 1);
  const roundDone = (r: number) => ev.draftEnded || (packSize > 0 && (perRound.get(r) ?? 0) >= packSize * nSeats);
  const agents = ev.seats.filter((s) => s.kind === 'agent').map((s) => s.name);
  const ended = new Map<string, number>();
  for (const m of ev.matches) if (m.done) for (const s of [m.a, m.b]) ended.set(s, (ended.get(s) ?? 0) + 1);
  const buildDone = agents.every((a) => ev.decks.has(a)) && ev.games.length > 0;
  // Matches a seat plays: one per Swiss round (a bye in an odd dev event keeps it withheld until the end), or every
  // other agent once (round robin, and logs from before Swiss).
  const perSeat = ev.format?.format === 'swiss' ? ev.format.rounds : agents.length - 1;
  const seatDone = (s: string) => (agents.length < 2 ? buildDone || ev.draftEnded : (ended.get(s) ?? 0) >= perSeat);
  const isBot = (s: string) => !agents.includes(s);

  const pickReleased = (seat: string, round: number) =>
    policy.draft === 'round' ? roundDone(round) : policy.draft === 'draft' ? ev.draftEnded : ev.draftEnded && (isBot(seat) || seatDone(seat));
  const packsReleased = (round: number) =>
    policy.draft === 'round' ? roundDone(round) : policy.draft === 'draft' ? ev.draftEnded : ev.draftEnded && agents.every(seatDone);

  const withheld = { picks: 0, decks: 0, decisions: 0, views: 0, sideboards: 0 };

  // Who plays each seat (harness, model, effort) is released with the seat's hidden information: while it still plays,
  // an agent with web tools could find its table and learn its opponents' models (OBS-1, LOB-5).
  ev.seats = ev.seats.map((s) => (s.kind !== 'agent' || seatDone(s.name) ? s : { name: s.name, kind: s.kind, position: s.position, llm: s.llm, model: s.name }));

  // Draft
  const picks = ev.picks.filter((p) => pickReleased(p.seat, p.packNumber));
  withheld.picks = ev.picks.length - picks.length;
  ev.picks = picks;
  ev.packs = ev.packs.filter((p) => packsReleased(p.round));
  // The seed regenerates every pack.
  ev.seed = undefined;

  // Decks: names kept aside for redacting notes, then hidden until the seat is done.
  const deckNames = new Map<string, string[]>();
  for (const [seat, d] of ev.decks) deckNames.set(seat, [...new Set([...d.main, ...d.sideboard])]);

  // Sideboarding between games is private like the decklist: what went in and out (and the seat's note) waits until
  // the seat has no games left. Whether it changed anything (kept), who decided (by) and the main deck size are public.
  for (const sb of ev.sideboards ?? []) {
    if (seatDone(sb.seat)) continue;
    sb.in = [];
    sb.out = [];
    sb.main = [];
    sb.sideboard = [];
    sb.basics = {};
    sb.note = undefined;
    sb.withheld = true;
    withheld.sideboards++;
  }
  // The play/draw decision is public (who chose, and what); its note has still-hidden card names blanked.
  for (const pd of ev.playDraws ?? []) {
    if (!pd.note || !pd.chooser || seatDone(pd.chooser)) continue;
    const seen = new Set(ev.games.filter((g) => g.matchKey === pd.match).flatMap((g) => [...g.publicNames]));
    const pair = pd.match.split(' vs ');
    const hidden = [...new Set(pair.flatMap((s) => deckNames.get(s) ?? []))].filter((n) => !seen.has(n));
    pd.note = redactCards(pd.note, hidden).text;
  }
  for (const seat of [...ev.decks.keys()]) {
    if (!seatDone(seat)) {
      ev.decks.delete(seat);
      withheld.decks++;
    }
  }

  // Games
  for (const g of ev.games) {
    const turn = lastTurn(g);
    const hidden = hiddenNames(g, deckNames);
    const hiddenOk = (seat: string) => (policy.hidden === 'game' ? g.over : g.over && seatDone(seat));
    const notesOk = (seat: string, t: number) =>
      policy.notes === 'game' ? g.over : policy.notes === 'seat' ? hiddenOk(seat) : g.over || turn >= t + policy.notes.turns;
    for (const d of g.decisions) {
      if (hiddenOk(d.seat)) continue;
      d.text = '';
      d.options = undefined;
      d.textWithheld = true;
      withheld.views++;
      const a = d.answer;
      if (!a) continue;
      if (notesOk(d.seat, d.turn) && isHiddenChoice(d.kind, a.choice)) {
        a.choice = 'A choice about hidden cards';
        a.note = undefined;
        a.card = undefined;
      } else if (notesOk(d.seat, d.turn)) {
        a.choice = redactCards(a.choice, hidden).text;
        if (a.note) a.note = redactCards(a.note, hidden).text;
        if (a.card && hidden.includes(a.card)) a.card = undefined;
      } else {
        a.choice = '';
        a.note = undefined;
        a.card = undefined;
        a.reason = undefined;
        a.withheld = 'note';
        withheld.decisions++;
      }
    }
    g.rulesIssues = g.rulesIssues.flatMap((r) => {
      if (hiddenOk(r.seat)) return [r];
      if (!notesOk(r.seat, r.turn ?? 0)) return [];
      const card = r.card && hidden.includes(r.card) ? null : r.card;
      return [{ ...r, card, note: redactCards(r.note, hidden).text, withheld: true }];
    });
  }
  ev.rulesIssues = ev.rulesIssues.filter((r) => seatDone(r.seat));

  const p = describePolicy(policy);
  ev.withheld = { policy: [p.draft, p.decisions, p.hidden, p.decks].join(' '), ...withheld };
}

/** Card names of the game's decks not yet seen in a public zone. */
function hiddenNames(g: Game, decks: Map<string, string[]>): string[] {
  const out = new Set<string>();
  for (const s of g.seats) for (const n of decks.get(s) ?? []) if (!g.publicNames.has(n)) out.add(n);
  return [...out];
}
