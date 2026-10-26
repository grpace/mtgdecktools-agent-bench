/**
 * Table rows for the open dataset (tables.ts), derived with the same code the site export uses (packages/site), so
 * the dataset and the site never disagree. No 17Lands-derived value goes into these rows: the human reference is its
 * own table (humanReferenceRows).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from '../../../site/src/context.js';
import { BASICS, type EventData } from '../../../site/src/data.js';
import type { JsonBuilder } from '../../../site/src/json.js';
import { deckSummary, eventWinner, seatColors } from '../../../site/src/metrics.js';
import { activeFrom, decisionStatus, gameSides, lifeOf, question, sortedDecisions } from '../../../site/src/replay-data.js';
import { seatCost } from '../../../site/src/cost.js';
import { contributorOf, earlyTestData, gameRatingStatus, groupKey } from '../../../site/src/scoring.js';
import type { Board, IdentityInfo } from '../../../site/src/schema.js';
import { HUMAN_REFERENCE_CREDIT } from './license.js';
import type { RedactContext } from './redact.js';
import { scrubText } from './redact.js';
import type { Row } from './tables.js';

const nul = <T>(x: T | undefined | null): T | null => (x === undefined || x === null || (typeof x === 'number' && !Number.isFinite(x)) ? null : x);
const int = (x: number | undefined | null): number | null => (x == null || !Number.isFinite(x) ? null : Math.round(x));
/** Free text from agents and logs: scrubbed (tokens, paths, e-mail, IP addresses). */
const txt = (x: unknown): string | null => (typeof x === 'string' && x !== '' ? scrubText(x) : null);
const counted = (names: string[]): Array<{ name: string; qty: number }> => {
  const m = new Map<string, number>();
  for (const n of names) m.set(n, (m.get(n) ?? 0) + 1);
  return [...m].sort((a, b) => a[0].localeCompare(b[0])).map(([name, qty]) => ({ name, qty }));
};
const qtyList = (xs: Array<{ name: string; qty: number }>) => xs.map((c) => ({ name: c.name, qty: c.qty }));

/** Who may be named: the attribution used both for the log (redact.ts) and for the seats table. */
export function redactContextOf(ev: EventData, ctx: Ctx): RedactContext {
  const seats = new Map<string, { key: string; handle: string | null }>();
  for (const s of ev.seats) {
    if (!s.llm) continue;
    const c = contributorOf(ev, s.name, ctx.contributorPublic);
    seats.set(s.name, { key: c.key, handle: c.handle });
  }
  const org = ev.organizer?.kind === 'contributor' && ev.organizer.contributorId
    ? ev.seats.filter((s) => s.llm).map((s) => contributorOf(ev, s.name, ctx.contributorPublic)).find((c) => c.via === 'organizer')?.key
    : undefined;
  return { seats, ...(org ? { organizerKey: org } : {}) };
}

/** The raw records the normalized model drops: deck names and archetypes, and Swiss rounds. */
export interface LogExtras {
  decks: Map<string, { deck_name?: string; archetype?: string }>;
  /** Sorted pair "a\u0000b" → round. */
  rounds: Map<string, number>;
}

export function logExtras(text: string): LogExtras {
  const decks = new Map<string, { deck_name?: string; archetype?: string }>();
  const rounds = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (!line.includes('"deck_built"') && !line.includes('"round_start"')) continue;
    try {
      const r = JSON.parse(line);
      if (r.type === 'deck_built' && typeof r.seat === 'string') {
        decks.set(r.seat, { ...(typeof r.deck_name === 'string' ? { deck_name: r.deck_name } : {}), ...(typeof r.archetype === 'string' ? { archetype: r.archetype } : {}) });
      } else if (r.type === 'round_start' && Array.isArray(r.pairs)) {
        for (const p of r.pairs) if (Array.isArray(p) && p.length === 2) rounds.set([String(p[0]), String(p[1])].sort().join('\u0000'), Number(r.round));
      }
    } catch {
      // malformed line: skipped
    }
  }
  return { decks, rounds };
}

const roundOf = (x: LogExtras, a: string, b: string): number | null => x.rounds.get([a, b].sort().join('\u0000')) ?? null;

export interface EventRows {
  events: Row[];
  seats: Row[];
  picks: Row[];
  decks: Row[];
  games: Row[];
  matches: Row[];
  decisions: Row[];
  sideboarding: Row[];
  /** Card names this event's packs, decks and sideboarding mention (for the cards table). */
  cardNames: string[];
}

export interface LogInfo { file: string; sha256: string }

/** Every per-event row. `ev` must be a finished event (included() in build.ts). */
export function eventRows(ev: EventData, b: JsonBuilder, ctx: Ctx, x: LogExtras, log: LogInfo): EventRows {
  const sum = b.eventSummary(ev);
  const cards = ctx.cards;
  const src = readSourceJson(ev.dir);
  const gameSums = ev.games.map((g) => b.gameSummary(ev, g));
  const early = earlyTestData(ev);
  const agents = ev.seats.filter((s) => s.kind === 'agent');
  const events: Row = {
    event_id: ev.id,
    set_code: ev.set.code.toUpperCase(),
    set_name: nul(ev.set.name),
    started_at: ev.startT,
    ended_at: ev.lastT,
    status: ev.status,
    stopped_by: nul(ev.stop?.by),
    stop_reason: nul(ev.stop?.reason),
    provenance: sum.provenance === 'community' ? 'community' : 'hosted',
    table_kind: nul(sum.table),
    pairing: sum.format.pairing,
    rounds: int(sum.format.rounds),
    best_of: int(ev.bestOf),
    sideboarding: ev.sideboarding === true,
    play_draw_rule: nul(ev.playDrawRule),
    knowledge: nul(ev.knowledge?.level),
    mana: nul(ev.mana),
    prompt_version: nul(ev.promptVersion),
    prompt_sha256: nul(ev.promptSha256),
    set_context_sha256: nul(sum.conditions.primer_sha256),
    engine_version: nul(ev.provenance?.engine?.server_version),
    engine_build: nul(ev.provenance?.engine?.build_commit),
    engine_protocol: int(ev.provenance?.engine?.protocol_version),
    engine_digest: nul(ev.provenance?.engine?.digest),
    director_version: nul(ev.provenance?.director),
    bot_ratings_snapshot: nul(ev.ratingsSnapshot?.id),
    seed: nul(ev.seed),
    agent_seats: agents.length,
    llm_seats: ev.seats.filter((s) => s.llm).length,
    scripted_seats: ev.seats.filter((s) => !s.llm).length,
    test_table: sum.test_table === true,
    early_test_data: early != null,
    early_test_data_reason: nul(early),
    comparability_group: nul(sum.group),
    rating_status: nul(sum.rating_status),
    rated_games: int(sum.rated_games),
    unrated_reason: txt(sum.rating_reason),
    excluded_reason: txt(ev.source.exclude),
    pack_regeneration: typeof src.pack_regeneration === 'string' ? src.pack_regeneration : null,
    integrity_flags: Array.isArray(src.flags) ? src.flags.filter((f): f is string => typeof f === 'string') : [],
    games: ev.games.filter((g) => g.over).length,
    matches: ev.matches.length,
    engine_flagged_games: gameSums.filter((g) => g.status === 'complete' && g.engine_flags?.flagged).length,
    winner: nul(eventWinner(ev)),
    log_file: log.file,
    log_sha256: log.sha256,
  };

  const standing = new Map(ev.standings.map((st, n) => [st.name, { rank: n + 1, ...st }]));
  const seats: Row[] = [...ev.seats].sort((a, c) => a.position - c.position).map((s) => {
    const ref = b.seatRef(ev, s.name);
    const st = standing.get(s.name);
    const tr = ev.transcripts.get(s.name);
    const uf = ev.usage?.get(s.name);
    const fromTr = !!tr && !!(tr.inputTokens || tr.outputTokens);
    const tokens = fromTr
      ? { input: tr!.inputTokens, output: tr!.outputTokens, cache_read: tr!.cacheReadTokens, cache_creation: tr!.cacheCreationTokens }
      : uf && (uf.input_tokens || uf.output_tokens)
        ? { input: uf.input_tokens ?? 0, output: uf.output_tokens ?? 0, cache_read: uf.cache_read_tokens ?? 0, cache_creation: uf.cache_creation_tokens ?? 0 }
        : null;
    const cost = s.llm && ref.model_id ? seatCost(ev, s.name, ref.model_id) : null;
    return {
      event_id: ev.id,
      seat: s.name,
      position: s.position,
      kind: s.kind,
      drafter: s.llm ? 'llm' : s.kind === 'bot' ? 'bot' : 'scripted',
      llm: s.llm,
      identity: nul(ref.identity),
      model_id: s.llm ? nul(ref.model_id) : null,
      model_display: nul(ref.model_display),
      provider: nul(ref.provider),
      harness_id: nul(ref.harness_id ?? (s.llm ? ref.harness : undefined)),
      harness_display: nul(ref.harness_display),
      effort: s.llm ? nul(ref.effort) : null,
      effort_display: nul(ref.effort_display),
      effort_source: nul(ref.effort_source),
      effort_status: nul(ref.effort_resolution?.status),
      model_declared: txt(ref.model_declared),
      model_verification: nul(ref.model_verification?.status),
      logs_read_by: nul(ref.model_verification?.logs_read_by),
      rated: s.llm ? ref.rated !== false : false,
      context_policy: s.llm ? (ref.context_policy ?? 'harness') : null,
      contributor_key: nul(ref.contributor?.key),
      contributor_handle: nul(ref.contributor?.handle),
      contributor_via: nul(ref.contributor?.via),
      final_colors: seatColors(ev, s.name, cards) || null,
      standing: int(st?.rank),
      match_wins: int(st?.matchWins),
      match_losses: int(st?.matchLosses),
      game_wins: int(st?.gameWins),
      game_losses: int(st?.gameLosses),
      usage_model: s.llm ? nul(ref.model_verification?.reported) : null,
      input_tokens: tokens ? int(tokens.input) : null,
      output_tokens: tokens ? int(tokens.output) : null,
      cache_read_tokens: tokens ? int(tokens.cache_read) : null,
      cache_creation_tokens: tokens ? int(tokens.cache_creation) : null,
      cost_usd: cost ? Math.round(cost.usd * 1e6) / 1e6 : null,
      cost_basis: cost ? cost.basis : null,
    };
  });

  const picks: Row[] = [];
  for (const p of ev.picks) {
    const deck = ev.decks.get(p.seat);
    picks.push({
      event_id: ev.id,
      seat: p.seat,
      pack_number: p.packNumber,
      pick_number: p.pickNumber,
      overall_pick: p.overallPick ?? (p.packNumber - 1) * 14 + p.pickNumber,
      pick: p.pick,
      by: p.by,
      pack_size: p.contents.length,
      pack_contents: [...p.contents],
      pack_rarities: p.rarities ? [...p.rarities] : null,
      latency_ms: int(p.latencyMs),
      made_main_deck: deck ? deck.main.includes(p.pick) : null,
    });
  }

  const decks: Row[] = [];
  for (const s of agents) {
    const d = ev.decks.get(s.name);
    if (!d) continue;
    const ds = deckSummary(d, cards, null, seatColors(ev, s.name, cards));
    const extra = x.decks.get(s.name) ?? {};
    decks.push({
      event_id: ev.id,
      seat: s.name,
      by: d.by,
      colors: ds.colors || null,
      main_count: ds.mainCount,
      land_count: cards.loaded ? ds.landCount : d.main.filter((n) => BASICS.has(n)).length,
      main: counted(d.main),
      sideboard: counted(d.sideboard),
      deck_name: txt(extra.deck_name),
      archetype: txt(extra.archetype),
      latency_ms: int(d.latencyMs),
    });
  }

  const games: Row[] = [];
  const decisions: Row[] = [];
  const group = groupKey(ev);
  const seatRefs = new Map(ev.seats.map((s) => [s.name, b.seatRef(ev, s.name)]));
  for (const [n, g] of ev.games.entries()) {
    const gs = gameSums[n]!;
    if (gs.status === 'live') continue;
    const [A, B] = gameSides(g);
    const flags = gs.engine_flags;
    // The rating's own rule (scoring.ts gameRatingStatus), so a refit from this table matches the boards.
    const rs = gameRatingStatus(ev, g, b.identities);
    const ra = seatRefs.get(A);
    const rb = seatRefs.get(B);
    games.push({
      event_id: ev.id,
      game_index: g.index,
      match_key: g.matchKey,
      round: roundOf(x, A, B),
      game_in_match: g.gameInMatch,
      seat_a: A,
      seat_b: B,
      status: gs.status,
      winner: nul(g.winner),
      turns: int(g.turns),
      on_play: nul(g.onPlay),
      play_draw_by: nul(gs.play_draw?.by),
      play_draw_chooser: nul(gs.play_draw?.chooser),
      play_draw_choice: nul(gs.play_draw?.choice),
      end_reason: nul(gs.end_reason),
      forfeited_by: nul(g.forfeitedBy),
      life_a: int(g.finalLife?.[A]),
      life_b: int(g.finalLife?.[B]),
      mulligans_a: int(g.mulligans?.[A]),
      mulligans_b: int(g.mulligans?.[B]),
      deck_size_a: int(g.deckSizes?.[A]),
      deck_size_b: int(g.deckSizes?.[B]),
      decisions_a: int(gs.decisions[A]),
      decisions_b: int(gs.decisions[B]),
      started_at: g.startT,
      ended_at: nul(g.endT),
      duration_ms: int(gs.duration_ms),
      engine_flagged: flags?.flagged === true,
      engine_flags: flags ? { ...flags.counts } : null,
      rated: rs.rated,
      rating_group: rs.rated ? group : null,
      unrated_reason: rs.reason,
      identity_a: ra?.llm ? nul(ra.identity) : null,
      identity_b: rb?.llm ? nul(rb.identity) : null,
      contributor_a: nul(ra?.contributor?.key),
      contributor_b: nul(rb?.contributor?.key),
      on_play_random: g.gameInMatch <= 1 && g.onPlay != null,
    });
    for (const [seq, dec] of sortedDecisions(g).entries()) {
      const a = dec.answer;
      const life = lifeOf(dec);
      decisions.push({
        event_id: ev.id,
        game_index: g.index,
        seat: dec.seat,
        decision_id: dec.id,
        seq,
        kind: dec.kind,
        turn: int(dec.turn),
        phase: nul(dec.phase),
        active_player: nul(activeFrom(dec, g.seats)),
        life_self: int(life.you),
        life_opponent: int(life.opp),
        hand_self: int(dec.hand?.you),
        hand_opponent: int(dec.hand?.opponent),
        options_count: question(dec).options,
        status: decisionStatus(dec, g),
        choice: a ? txt(a.choice) : null,
        choice_raw: a && a.rawChoice !== undefined ? (scrubJson(a.rawChoice) as Row[string]) : null,
        accepted: a ? a.accepted : null,
        structured: a?.structured ?? null,
        card: nul(a?.card),
        refusal_reason: txt(a?.reason),
        latency_ms: int(a?.latencyMs),
        offered_at: dec.t,
      });
    }
  }

  const matches: Row[] = ev.matches.map((m) => {
    const wa = m.wins[m.a] ?? 0;
    const wb = m.wins[m.b] ?? 0;
    return {
      event_id: ev.id,
      match_key: m.key,
      round: roundOf(x, m.a, m.b),
      seat_a: m.a,
      seat_b: m.b,
      wins_a: wa,
      wins_b: wb,
      games: m.games.filter((g) => g.over).length,
      winner: wa > wb ? m.a : wb > wa ? m.b : null,
    };
  });

  const sideboarding: Row[] = (ev.sideboards ?? []).map((sb) => ({
    event_id: ev.id,
    match_key: sb.match,
    game_in_match: sb.gameNumber,
    seat: sb.seat,
    by: sb.by,
    kept: sb.kept,
    cards_in: qtyList(sb.in),
    cards_out: qtyList(sb.out),
    main_count: int(sb.mainCount),
    latency_ms: int(sb.latencyMs),
  }));

  const cardNames = [
    ...ev.picks.flatMap((p) => p.contents),
    ...[...ev.decks.values()].flatMap((d) => [...d.main, ...d.sideboard]),
    ...ev.packs.flatMap((p) => (p.swaps ?? []).flatMap((s) => [s.from, s.to])),
    ...(ev.sideboards ?? []).flatMap((sb) => [...sb.in, ...sb.out].map((c) => c.name)),
  ];
  return { events: [events], seats, picks, decks, games, matches, decisions, sideboarding, cardNames: [...new Set(cardNames)] };
}

/** Rows of the cards table: one per (set, card) mentioned by the events. */
export function cardRows(b: JsonBuilder, bySet: Map<string, Set<string>>): Row[] {
  const rows: Row[] = [];
  for (const set of [...bySet.keys()].sort()) {
    for (const name of [...bySet.get(set)!].sort()) {
      const c = b.card(name, null);
      rows.push({
        set_code: set,
        card: name,
        mana_cost: c.cost || null,
        type_line: nul(c.type_line),
        colors: c.colors || null,
        mana_value: int(c.mv),
        rarity: nul(c.rarity),
        is_basic: BASICS.has(name),
        scryfall_url: `https://scryfall.com/search?q=${encodeURIComponent(`!"${name.split(' // ')[0]}"`)}`,
      });
    }
  }
  return rows;
}

/** The human reference (17Lands-derived): per card and set, for the cards in the dataset. */
export function humanReferenceRows(ctx: Ctx, bySet: Map<string, Set<string>>): Row[] {
  const rows: Row[] = [];
  for (const set of [...bySet.keys()].sort()) {
    const r = ctx.ratingsFor(set);
    if (!r) continue;
    for (const name of [...bySet.get(set)!].sort()) {
      const c = r.cards.get(name) ?? r.cards.get(name.split(' // ')[0]!);
      if (!c) continue;
      rows.push({
        set_code: set,
        card: name,
        format: nul(r.format),
        gih_wr: nul(c.gih_wr),
        gih_games: int(c.gih_games),
        gp_wr: nul(c.gp_wr),
        oh_wr: nul(c.oh_wr),
        gns_wr: nul(c.gns_wr),
        iwd: nul(c.iwd),
        alsa: nul(c.alsa),
        ata: nul(c.ata),
        snapshot_id: nul(r.snapshot),
        data_first: nul(r.dateRange?.first),
        data_last: nul(r.dateRange?.last),
        source: `${HUMAN_REFERENCE_CREDIT.attribution}: ${HUMAN_REFERENCE_CREDIT.source} (${HUMAN_REFERENCE_CREDIT.url}). ${HUMAN_REFERENCE_CREDIT.note}`,
        license: HUMAN_REFERENCE_CREDIT.license.id,
      });
    }
  }
  return rows;
}

/** Leaderboard rows (outcomes only: diagnostics, which use 17Lands data, stay out). */
export function ratingRows(boards: Board[], identities: IdentityInfo[], groupLabel: (key: string) => string | null): Row[] {
  const info = new Map(identities.map((x) => [x.key, x]));
  const rows: Row[] = [];
  for (const bd of boards) {
    for (const r of bd.rows) {
      const id = info.get(r.identity);
      rows.push({
        board_id: bd.id,
        group_key: bd.group,
        group_label: groupLabel(bd.group),
        set_code: bd.set ?? '*',
        provenance: nul(bd.provenance ?? (bd.source === 'verified' ? 'hosted' : bd.source)),
        role: nul(bd.role),
        identity: r.identity,
        model_id: nul(id?.model_id ?? id?.model),
        model_display: nul(id?.model_display),
        // Schema 2: a rating spans harnesses; each seat's harness is in the seats table.
        harness_id: null,
        effort: nul(id?.effort),
        rating: nul(r.rating),
        ci_low: nul(r.ci?.[0]),
        ci_high: nul(r.ci?.[1]),
        rank_range_best: int(r.rank_range?.[0]),
        rank_range_worst: int(r.rank_range?.[1]),
        rank_of: int(r.rank_of),
        default_ranking: r.default_ranking ?? null,
        provisional: r.provisional,
        provisional_reasons: [...(r.provisional_reasons ?? [])],
        games: int(r.games),
        wins: int(r.wins),
        losses: int(r.losses),
        events: int(r.events),
        opponents: int(r.opponents),
        contributors: int(r.contributors),
        top_contributor_share: nul(r.top_contributor_share),
        contributor_floor_met: r.contributor_floor_met ?? null,
        expected_score: nul(r.expected_score?.value),
        expected_score_low: nul(r.expected_score?.ci?.[0]),
        expected_score_high: nul(r.expected_score?.ci?.[1]),
      });
    }
  }
  return rows;
}

function scrubJson(v: unknown): unknown {
  if (typeof v === 'string') return scrubText(v);
  if (Array.isArray(v)) return v.map(scrubJson);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubJson(x)]));
  return v;
}

function readSourceJson(dir: string): { flags?: unknown[]; pack_regeneration?: unknown } {
  const f = join(dir, 'source.json');
  if (!existsSync(f)) return {};
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return {};
  }
}

/** The boards table (2.17): scope, play advantage and interval settings of every board. */
export function boardRows(boards: Board[], o: { priorSdElo: number; playPriorSdElo: number; center: number; forfeitPolicy: string }): Row[] {
  return boards.map((bd) => ({
    board_id: bd.id,
    group_key: bd.group,
    set_code: bd.set ?? '*',
    provenance: nul(bd.provenance ?? (bd.source === 'verified' ? 'hosted' : bd.source)),
    role: nul(bd.role),
    events: bd.events,
    games: bd.games,
    identities: bd.identities,
    components: int(bd.components),
    play_advantage: nul(bd.play_advantage?.elo),
    play_advantage_low: nul(bd.play_advantage?.ci?.[0]),
    play_advantage_high: nul(bd.play_advantage?.ci?.[1]),
    play_games: int(bd.play_advantage?.games),
    prior_sd_elo: o.priorSdElo,
    play_prior_sd_elo: o.playPriorSdElo,
    center: o.center,
    interval: 'max(bootstrap, laplace)',
    bootstrap_unit: nul(bd.bootstrap_unit),
    clusters: int(bd.clusters),
    replicates: int(bd.replicates),
    seed: int(bd.seed),
    forfeit_policy: o.forfeitPolicy,
  }));
}

/** The rating_pairs table (2.17): every pair's difference interval, per board. */
export function ratingPairRows(boards: Board[]): Row[] {
  return boards.flatMap((bd) => (bd.differences ?? []).map((p) => ({
    board_id: bd.id, set_code: bd.set ?? '*', a: p.a, b: p.b, diff: p.diff, ci_low: nul(p.ci?.[0]), ci_high: nul(p.ci?.[1]), ahead: nul(p.ahead),
  })));
}
