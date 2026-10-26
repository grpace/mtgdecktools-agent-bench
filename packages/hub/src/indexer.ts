/**
 * Index rows for one event (Postgres), derived with the same code the JSON export uses (packages/site), so
 * the database and the site never disagree. Per-decision rows stay in the bundle.
 */
import type { Ctx } from '../../site/src/context.js';
import { playDrawOf, sideboardsOf, type EventData } from '../../site/src/data.js';
import { deckSummary, eventWinner, seatColors, setStats } from '../../site/src/metrics.js';
import { seatGameStats } from '../../site/src/replay-data.js';
import { conditionsOf, draftContext, groupKey, unratedReason, type Identities } from '../../site/src/scoring.js';
import type { Board } from '../../site/src/schema.js';
import type postgres from 'postgres';
import type { Sql } from './db.js';

/** The pool or a transaction: both run tagged-template queries. */
export type Tx = Sql | postgres.TransactionSql<Record<string, unknown>>;

const ts = (ms: number | undefined | null) => (ms == null ? null : new Date(ms));
const int = (x: number | undefined | null) => (x == null || !Number.isFinite(x) ? null : Math.round(x));
const real = (x: number | undefined | null) => (x == null || !Number.isFinite(x) ? null : x);

export interface EventRowExtra {
  submissionId: number;
  label: string;
  packRegen: string | null;
  fingerprints: Record<string, string>;
}

/** Replace every index row of one event. Run inside a transaction. */
export async function writeEventRows(tx: Tx, ev: EventData, ctx: Ctx, ids: Identities, x: EventRowExtra): Promise<void> {
  const sql = tx as Sql;
  const c = conditionsOf(ev);
  const agents = ev.seats.filter((s) => s.kind === 'agent');
  const ratings = ctx.ratingsFor(ev.set.code);
  const arch = ctx.archetypesFor(ev.set.code);
  await sql`delete from events where id = ${ev.id}`;
  await sql`
    insert into events ${sql({
      id: ev.id, submission_id: x.submissionId, label: x.label, set_code: ev.set.code.toUpperCase(), set_name: ev.set.name, seed: ev.seed ?? null,
      knowledge: c.knowledge, mana: c.mana, best_of: ev.bestOf, pod_size: ev.seats.length, agents: agents.length, llm: ev.seats.some((s) => s.llm),
      engine_digest: c.engine?.digest ?? null, engine_version: c.engine?.server_version ?? null, protocol_version: c.engine?.protocol_version ?? null,
      director_version: c.director, prompt_version: c.prompt_version, primer_sha256: c.primer_sha256,
      comparability_group: groupKey(ev), unrated_reason: unratedReason(ev) ?? null, pack_regen: x.packRegen, sideboarding: ev.sideboarding === true,
      started_at: ts(ev.startT), ended_at: ts(ev.lastT), winner: eventWinner(ev) ?? null, excluded: ev.source.exclude ?? null,
    })}`;

  const seatRows = ev.seats.map((s) => {
    // LLM seats: canonical harness / model id / effort from the registry (model keeps the name as declared).
    const id = s.llm ? ids.of(ev, s.name) : undefined;
    return {
      event_id: ev.id, name: s.name, kind: s.kind, position: s.position, is_agent: s.kind === 'agent', is_llm: s.llm,
      harness: id?.harness ?? s.harness ?? null, model: s.modelDeclared ?? s.modelHint ?? s.model ?? null,
      model_id: id?.model ?? s.modelId ?? ev.transcripts.get(s.name)?.model ?? null, effort: id?.effort ?? s.effort ?? null,
      identity: id?.key ?? null, final_colors: seatColors(ev, s.name, ctx.cards) || null,
      decision_fingerprint: x.fingerprints[s.name] ?? null,
    };
  });
  if (seatRows.length) await sql`insert into seats ${sql(seatRows)}`;

  const pickRows = [];
  for (const s of ev.seats) {
    const dc = draftContext(ev, s.name, ctx.cards, ratings, arch);
    const deck = ev.decks.get(s.name);
    const main = new Set(deck?.main ?? []);
    for (const p of ev.picks.filter((q) => q.seat === s.name)) {
      const pc = dc.picks.get(p);
      pickRows.push({
        event_id: ev.id, seat: s.name, pack_number: p.packNumber, pick_number: p.pickNumber,
        overall_pick: p.overallPick ?? (p.packNumber - 1) * 14 + p.pickNumber, contents: p.contents, pick: p.pick, by: p.by,
        latency_ms: int(p.latencyMs),
        model_p: real(pc?.expert?.p), model_rank: int(pc?.expert?.rank), ev_regret_pp: real(pc?.expert?.evRegretPp), in_lane: pc?.expert?.inLane ?? null,
        arch_regret_pp: real(pc?.arch?.regret), made_deck: deck ? main.has(p.pick) : null,
      });
    }
  }
  for (let i = 0; i < pickRows.length; i += 500) await sql`insert into picks ${sql(pickRows.slice(i, i + 500))}`;

  const deckRows = [];
  for (const s of agents) {
    const d = ev.decks.get(s.name);
    if (!d) continue;
    const sum = deckSummary(d, ctx.cards, ratings, seatColors(ev, s.name, ctx.cards));
    const st = ev.strength?.seats.get(s.name);
    deckRows.push({
      event_id: ev.id, seat: s.name, by: d.by, main: d.main, sideboard: d.sideboard,
      basics: sql.json(Object.fromEntries(sum.basics)), main_count: d.main.length, colors: sum.colors || null,
      deck_strength: real(st?.agent?.winRate), reference_strength: real(st?.reference?.winRate),
    });
  }
  if (deckRows.length) await sql`insert into decks ${sql(deckRows)}`;

  const gameRows = [];
  const statRows = [];
  for (const g of ev.games) {
    if (!g.over) continue;
    // Migration 007: the play/draw decision and each seat's sideboarding before the game (logs from 2026-10-22 on).
    const pd = playDrawOf(ev, g);
    const sbs = sideboardsOf(ev, g);
    gameRows.push({
      event_id: ev.id, game_index: g.index, match_key: g.matchKey, game_in_match: g.gameInMatch, seat_a: g.seats[0] ?? '', seat_b: g.seats[1] ?? '',
      winner: g.winner, turns: int(g.turns), on_play: g.onPlay ?? null,
      end_reason: g.endReason == null ? null : typeof g.endReason === 'string' ? g.endReason : JSON.stringify(g.endReason),
      final_life: g.finalLife ? sql.json(g.finalLife) : null, mulligans: g.mulligans ? sql.json(g.mulligans) : null,
      started_at: ts(g.startT), ended_at: ts(g.endT),
      play_draw: pd ? sql.json({ on_play: pd.onPlay, chooser: pd.chooser, choice: pd.choice, by: pd.by }) : null,
      sideboarding: sbs.length
        ? sql.json(Object.fromEntries(sbs.map((sb) => [sb.seat, { by: sb.by, kept: sb.kept, in: sb.in.map((c) => ({ ...c })), out: sb.out.map((c) => ({ ...c })), main_count: sb.mainCount }])) as Parameters<Sql['json']>[0])
        : null,
      deck_sizes: g.deckSizes ? sql.json(g.deckSizes) : null,
    });
    for (const seat of g.seats) {
      const st = seatGameStats(g, seat);
      statRows.push({
        event_id: ev.id, game_index: g.index, seat, decisions: st.decisions, auto_passes: st.autoPasses, forced: st.forced, rejections: st.rejected,
        manual_payments: int(st.manualPayments), auto_tapper: int(st.autoTapper), payment_failures: int(st.paymentFailures),
        median_latency_ms: int(st.medianLatencyMs),
      });
    }
  }
  if (gameRows.length) await sql`insert into games ${sql(gameRows)}`;
  if (statRows.length) await sql`insert into seat_game_stats ${sql(statRows)}`;
}

/** Replace the ratings table with the boards of the latest export (one row per board × identity). */
export async function writeRatings(sql: Sql, boards: Board[]): Promise<number> {
  const rows = boards.flatMap((b) => b.rows.map((r) => ({
    board_id: b.id, group_key: b.group, set_code: b.set ?? '*', source: b.source, identity: r.identity,
    rating: real(r.rating), ci_lo: real(r.ci?.[0]), ci_hi: real(r.ci?.[1]), se: real(r.se), rank: int(r.rank),
    games: r.games, wins: r.wins, losses: r.losses, events: r.events, opponents: r.opponents, provisional: r.provisional,
    provisional_reasons: sql.json(r.provisional_reasons), stages: sql.json(r.stages as unknown as Parameters<Sql['json']>[0]),
  })));
  await sql.begin(async (tx) => {
    // The server and the CLI may both refresh at once: serialize, so the delete sees the other's rows.
    await tx`select pg_advisory_xact_lock(hashtext('mtgdt-hub-ratings'))`;
    await tx`delete from ratings`;
    for (let i = 0; i < rows.length; i += 200) await tx`insert into ratings ${tx(rows.slice(i, i + 200))}`;
  });
  return rows.length;
}

/** Refresh card_stats for one set: every comparability group that has events in it, plus '*' (all events). */
export async function writeCardStats(sql: Sql, ctx: Ctx, set: string): Promise<number> {
  const code = set.toUpperCase();
  const ratings = ctx.ratingsFor(code);
  const inSet = ctx.events.filter((e) => e.set.code.toUpperCase() === code);
  const groups = new Map<string, EventData[]>([['*', inSet]]);
  for (const e of inSet) {
    const g = groupKey(e);
    if (g) groups.set(g, [...(groups.get(g) ?? []), e]);
  }
  const rows: Array<Record<string, string | number | null>> = [];
  for (const [g, evs] of groups) {
    for (const c of setStats(evs, code, ratings).cards) {
      if (!c.picked && !c.seen && !c.inDecks) continue;
      rows.push({
        group_key: g, set_code: code, card: c.name, agent_picks: c.picked, avg_pick: real(c.avgPick), seen: c.seen,
        in_decks: c.inDecks, deck_games: c.deckGames, deck_wins: c.deckWins, deck_wr: real(c.deckWr),
      });
    }
  }
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('mtgdt-hub-card-stats'))`;
    await tx`delete from card_stats where set_code = ${code}`;
    for (let i = 0; i < rows.length; i += 500) await tx`insert into card_stats ${tx(rows.slice(i, i + 500))}`;
  });
  return rows.length;
}
