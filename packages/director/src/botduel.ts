import type { CardDb } from './cards.js';
import { AiDifficulty, DeckData, PhaseSeat, PhaseUpdate } from './phase.js';

/**
 * Bot duels: LLM-free games for the deck-strength yardstick (docs/METRICS.md §3).
 *
 * phase-server cannot run a game with AI on both sides over the WebSocket: AI seats are only
 * accepted at seats 1..n-1 and seat 0 is always the host (server-core ai_seats_wire_guard.rs,
 * seat-reducer lib.rs `apply_set_kind`). So each game is phase-ai (seat 1) against the
 * Director's own scripted "sparring pilot" (seat 0, `SparringPilot` below), which is simpler
 * than phase-ai. By default the two decks swap pilots game by game, so in every pair of games
 * each deck is played once by phase-ai and once by the sparring pilot and pilot skill cancels
 * out of the win rate. See docs/METRICS.md "Deck strength (bot duels)".
 */

export type DeckSide = 'A' | 'B';

export interface BotDuelOptions {
  /** phase-ai difficulty (default Medium). */
  difficulty?: AiDifficulty;
  /** Which deck phase-ai pilots: 'A', 'B', or 'alternate' game by game (default: pilot skill cancels out). */
  aiPilots?: DeckSide | 'alternate';
  /** Games in flight at once (default 4). Each game is one WebSocket to phase-server. */
  concurrency?: number;
  /** Wall-clock budget per game (default 600 s); the host concedes and the game counts as unfinished. */
  gameTimeoutMs?: number;
  /** Card text, used by the sparring pilot to tell removal from pump when choosing targets. */
  cards?: CardDb;
  /** Called after each game (progress reporting). */
  onGame?: (g: BotGame, index: number) => void;
  /** Record card names seen for each side that are not in that side's deck list (sanity check). */
  verifyDecks?: boolean;
}

export interface BotGame {
  /** Winning deck, or null for a draw or an unfinished game. */
  winner: DeckSide | null;
  /** How the game ended: a real result, or why it didn't produce one. */
  end: 'game_over' | 'timeout' | 'ai_fault' | 'stuck' | 'error';
  turns: number;
  ms: number;
  /** Which deck phase-ai piloted (the other had the sparring pilot). */
  aiDeck: DeckSide;
  /** Deck that took the first turn (phase-server decides; Bo1 has no play/draw choice for us). */
  onPlay: DeckSide | null;
  /** Actions the sparring pilot sent. */
  pilotActions: number;
  /** With `verifyDecks`: non-token card names seen for a side that its deck list doesn't contain. */
  offDeck?: Partial<Record<DeckSide, string[]>>;
  /** With `verifyDecks`: how many distinct card names were seen per side. */
  seen?: Record<DeckSide, number>;
  detail?: string;
}

export interface BotDuelResult {
  aWins: number;
  bWins: number;
  draws: number;
  /** Games without a result (timeout, AI fault, pilot stuck, connection error). Not in the win rate. */
  unfinished: number;
  games: BotGame[];
}

/** Play `n` games between deck A and deck B. One side is phase-ai, the other the sparring pilot. */
export async function playBotGames(phaseUrl: string, deckA: DeckData, deckB: DeckData, n: number, opts: BotDuelOptions = {}): Promise<BotDuelResult> {
  const games = await runPool(n, opts.concurrency ?? 4, async (i) => {
    const aiDeck: DeckSide = (opts.aiPilots ?? 'alternate') === 'alternate' ? (i % 2 === 0 ? 'A' : 'B') : (opts.aiPilots as DeckSide);
    const g = await playBotGame(phaseUrl, deckA, deckB, aiDeck, opts);
    opts.onGame?.(g, i);
    return g;
  });
  return summarize(games);
}

export function summarize(games: BotGame[]): BotDuelResult {
  const r: BotDuelResult = { aWins: 0, bWins: 0, draws: 0, unfinished: 0, games };
  for (const g of games) {
    if (g.end !== 'game_over') r.unfinished++;
    else if (g.winner === 'A') r.aWins++;
    else if (g.winner === 'B') r.bWins++;
    else r.draws++;
  }
  return r;
}

/** Run `n` async jobs with at most `limit` in flight; results keep job order. */
export async function runPool<T>(n: number, limit: number, job: (i: number) => Promise<T>): Promise<T[]> {
  const out: T[] = new Array(n);
  let next = 0;
  const worker = async () => {
    while (next < n) {
      const i = next++;
      out[i] = await job(i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, n)) }, worker));
  return out;
}

/**
 * One game: phase-ai pilots `aiDeck`, the sparring pilot the other deck. A game that fails before
 * it starts (phase-server answers "database is locked" under concurrent creates) is retried.
 */
export async function playBotGame(phaseUrl: string, deckA: DeckData, deckB: DeckData, aiDeck: DeckSide, opts: BotDuelOptions = {}): Promise<BotGame> {
  for (let attempt = 1; ; attempt++) {
    const g = await playOnce(phaseUrl, deckA, deckB, aiDeck, opts);
    if (g.end !== 'error' || g.turns > 0 || attempt >= 3) return g;
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
}

function playOnce(phaseUrl: string, deckA: DeckData, deckB: DeckData, aiDeck: DeckSide, opts: BotDuelOptions): Promise<BotGame> {
  const pilotDeck: DeckSide = aiDeck === 'A' ? 'B' : 'A';
  const deckOf = (side: DeckSide) => (side === 'A' ? deckA : deckB);
  // phase-server answers a host action only after phase-ai's reply moves, which can take seconds.
  const seat = new PhaseSeat(phaseUrl, 'Sparring', 30_000);
  const pilot = new SparringPilot(seat, opts.cards);
  const t0 = Date.now();
  return new Promise<BotGame>((resolve) => {
    let settled = false;
    let onPlay: DeckSide | null = null;
    let turns = 0;
    const seen: Record<DeckSide, Set<string>> = { A: new Set(), B: new Set() };
    const verify = (): Pick<BotGame, 'offDeck' | 'seen'> => {
      if (!opts.verifyDecks) return {};
      const offDeck: Partial<Record<DeckSide, string[]>> = {};
      for (const side of ['A', 'B'] as const) {
        const list = new Set(deckOf(side).main_deck.map((n) => n.toLowerCase()));
        const off = [...seen[side]].filter((n) => !list.has(n.toLowerCase()) && !list.has(n.split(' // ')[0]!.toLowerCase()));
        if (off.length) offDeck[side] = off;
      }
      return { offDeck: Object.keys(offDeck).length ? offDeck : undefined, seen: { A: seen.A.size, B: seen.B.size } };
    };
    const finish = (end: BotGame['end'], winner: DeckSide | null, detail?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pilot.stop();
      if (end !== 'game_over') seat.concede();
      setTimeout(() => seat.close(), end === 'game_over' ? 0 : 200);
      resolve({ winner, end, turns, ms: Date.now() - t0, aiDeck, onPlay, pilotActions: pilot.actions, ...verify(), detail });
    };
    const timer = setTimeout(() => finish('timeout', null, `no result after ${opts.gameTimeoutMs ?? 600_000} ms (turn ${turns}; ${pilot.where()})`), opts.gameTimeoutMs ?? 600_000);
    seat.on('update', (u: PhaseUpdate) => {
      const s = u.state;
      if (!s) return;
      turns = s.turn_number ?? turns;
      if (opts.verifyDecks) {
        for (const o of Object.values<any>(s.objects ?? {})) {
          if (!o?.name || o.name === 'Hidden Card' || o.is_token || o.face_down || o.zone === 'Library') continue;
          seen[o.owner === seat.player ? pilotDeck : aiDeck].add(o.base_name ?? o.name);
        }
      }
      if (onPlay === null && s.turn_number === 1 && s.active_player != null) onPlay = s.active_player === seat.player ? pilotDeck : aiDeck;
      const wf = s.waiting_for;
      if (wf?.type === 'GameOver') {
        const w = wf.data?.winner;
        // Use the player phase-server reported for us (GameStarted.your_player; the host is player 0 today).
        finish('game_over', w == null ? null : w === seat.player ? pilotDeck : aiDeck);
        return;
      }
      pilot.onUpdate(u);
    });
    seat.on('ai-fault', (f: unknown) => finish('ai_fault', null, JSON.stringify(f)));
    seat.on('error-message', (e: any) => {
      if (!settled && seat.player === undefined) finish('error', null, e?.message ?? JSON.stringify(e));
    });
    seat.on('closed', () => finish('error', null, 'connection closed'));
    pilot.onStuck = (why) => finish('stuck', null, why);
    seat.connect()
      .then(() => seat.createGame(deckOf(pilotDeck), [{ seatIndex: 1, difficulty: opts.difficulty ?? 'Medium', deckName: null, deck: { type: 'DeckList', data: deckOf(aiDeck) } }]))
      .catch((e) => finish('error', null, String(e?.message ?? e)));
  });
}

// ---------------------------------------------------------------------------------------------
// Sparring pilot: a fixed, simple heuristic player for seat 0. Plays a land, casts its most
// expensive castable spells in its main phases, attacks when no blocker eats the attacker,
// blocks when the block is free or a fair trade (chumps only against lethal), points removal at
// the opponent's best creature and pump at its own. Never responds on the opponent's turn and
// never activates abilities. It exists to give phase-ai a fixed opponent, not to play well.
// ---------------------------------------------------------------------------------------------

const MAX_DECISIONS_PER_TURN = 400;
const HARMFUL = /destroy|exile target|exile up to|deals? (\d+|x|that much) damage|damage to (any|target|each)|-\d+\/-\d+|gets -|tap target|doesn't untap|return target [^.]*to (its|their) owner|fights?|counter target|can't (attack|block)|sacrifices?|loses? \d+ life|discards?/i;

export class SparringPilot {
  actions = 0;
  onStuck?: (why: string) => void;
  private latest?: PhaseUpdate;
  private busy = false;
  private stopped = false;
  private handled = -1;
  /** Actions refused (or abandoned) this turn, by JSON. */
  private refused = new Map<string, number>();
  /** Cast attempts per object this turn: one try each, so a failed payment can't loop. */
  private castTried = new Map<number, number>();
  private landTurn = -1;
  private payments = 0;
  private paymentTurn = -1;
  private turnDecisions = 0;
  private decisionTurn = -1;

  constructor(private seat: PhaseSeat, private cards?: CardDb) {}

  stop(): void {
    this.stopped = true;
  }

  /** Where the game stands, for diagnostics: the last decision and whose it was. */
  where(): string {
    const u = this.latest;
    if (!u) return 'no state yet';
    const wf = u.state.waiting_for;
    return `waiting for ${wf?.type} (player ${wf?.data?.player ?? '?'}), ${u.legal.length} legal for us, revision ${u.revision}, busy ${this.busy}`;
  }

  onUpdate(u: PhaseUpdate): void {
    this.latest = u;
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      while (!this.stopped && this.latest && this.latest.revision !== this.handled) {
        const u = this.latest;
        this.handled = u.revision;
        if (!u.legal.length || !this.mine(u)) continue;
        const turn = u.state.turn_number ?? 0;
        if (turn !== this.decisionTurn) {
          this.decisionTurn = turn;
          this.turnDecisions = 0;
        }
        if (++this.turnDecisions > MAX_DECISIONS_PER_TURN) {
          this.onStuck?.(`more than ${MAX_DECISIONS_PER_TURN} sparring-pilot decisions on turn ${turn} (${u.state.waiting_for?.type})`);
          return;
        }
        let action = this.decide(u);
        let lastReason = '';
        for (let attempt = 0; action && !this.stopped; attempt++) {
          if (attempt >= 6) {
            this.onStuck?.(`sparring pilot found no accepted action for ${u.state.waiting_for?.type} on turn ${turn} (last refusal: ${lastReason})`);
            return;
          }
          this.actions++;
          const r = await this.seat.act(action);
          // wrong_player: the decision moved on to phase-ai; wait for the next update.
          if (r.ok || r.reason === 'superseded by a newer action' || r.reason.startsWith('wrong_player')) break;
          lastReason = r.reason;
          if (r.reason === 'timeout') {
            if (this.latest?.revision !== u.revision) break;
            continue; // no answer and no new state: send the same action again
          }
          this.refused.set(JSON.stringify(action), turn);
          action = this.latest?.revision === u.revision ? this.decide(u) : undefined;
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /** Is the pending decision ours? (Updates can carry legal actions while phase-ai holds priority.) */
  private mine(u: PhaseUpdate): boolean {
    const wf = u.state.waiting_for;
    const owner = wf?.data?.player;
    if (typeof owner === 'number') return owner === this.me();
    if (wf?.type === 'MulliganDecision') return (wf.data?.pending ?? []).some((x: any) => x.player === this.me());
    return true;
  }

  private me(): number {
    return this.seat.player ?? 0;
  }

  private ok(a: any, turn: number): boolean {
    return this.refused.get(JSON.stringify(a)) !== turn;
  }

  decide(u: PhaseUpdate): any {
    const s = u.state;
    const wf = s.waiting_for ?? {};
    const d = wf.data ?? {};
    const turn = s.turn_number ?? 0;
    const legal = u.legal.filter((a) => this.ok(a, turn));
    const me = this.me();
    const first = () => legal.find((a) => a.type !== 'CancelCast') ?? legal[0] ?? u.legal[0];
    const pass = legal.find((a) => a.type === 'PassPriority');
    const cancel = legal.find((a) => a.type === 'CancelCast');
    switch (wf.type) {
      case 'MulliganDecision':
        return this.mulligan(s, d, legal, me) ?? first();
      case 'Priority': {
        const stack: any[] = s.stack ?? [];
        if (stack.length || s.active_player !== me || !/Main/.test(String(s.phase))) return pass ?? first();
        if (this.landTurn !== turn) {
          const land = legal.find((a) => a.type === 'PlayLand');
          if (land) {
            this.landTurn = turn;
            return land;
          }
        }
        const casts = legal
          .filter((a) => a.type === 'CastSpell' && this.castTried.get(a.data?.object_id) !== turn)
          .sort((a, b) => mv(obj(s, b.data.object_id)) - mv(obj(s, a.data.object_id)));
        if (casts.length) {
          this.castTried.set(casts[0].data.object_id, turn);
          return casts[0];
        }
        return pass ?? first();
      }
      case 'ManaPayment':
        // Let phase-server's auto-tapper pay; if it can't (or keeps asking), back out of the spell.
        this.payments = this.paymentTurn === turn ? this.payments + 1 : 1;
        this.paymentTurn = turn;
        return (this.payments > 8 ? cancel : undefined) ?? pass ?? cancel ?? first();
      case 'TargetSelection':
      case 'TriggerTargetSelection':
        return this.target(s, d, legal, me) ?? cancel ?? first();
      case 'DeclareAttackers':
      case 'DeclareBlockers': {
        // Our own plan first; if the engine refuses it (menace, attack requirements…), no
        // attack / no blocks; then whatever the engine lists.
        const plan = wf.type === 'DeclareAttackers' ? this.attack(s, d, me) : this.block(s, d, me);
        const none = wf.type === 'DeclareAttackers'
          ? { type: 'DeclareAttackers', data: { attacks: [], bands: [] } }
          : { type: 'DeclareBlockers', data: { assignments: [] } };
        return [plan, none].find((a) => this.ok(a, turn)) ?? first();
      }
      case 'OptionalEffectChoice':
        return legal.find((a) => a.type === 'DecideOptionalEffect' && a.data?.accept) ?? first();
      case 'OptionalCostChoice':
        return legal.find((a) => a.type === 'DecideOptionalCost' && !a.data?.pay) ?? first();
      case 'AlternativeCastChoice':
        return legal.find((a) => a.data?.choice?.type !== 'Alternative') ?? first();
      default:
        return first();
    }
  }

  private mulligan(s: any, d: any, legal: any[], me: number): any {
    const mine = (d.pending ?? []).find((x: any) => x.player === me);
    const hand: number[] = s.players?.[me]?.hand ?? [];
    const lands = hand.filter((id) => isLand(obj(s, id)));
    if (mine?.phase?.type === 'BottomCards') {
      const count = mine.phase.count ?? 1;
      // Bottom surplus lands when land-heavy, otherwise the most expensive spells.
      const spells = hand.filter((id) => !isLand(obj(s, id))).sort((a, b) => mv(obj(s, b)) - mv(obj(s, a)));
      const order = lands.length > 3 ? [...lands, ...spells] : [...spells, ...lands];
      return { type: 'SelectCards', data: { cards: order.slice(0, count) } };
    }
    const keep = legal.find((a) => a.type === 'MulliganDecision' && a.data?.choice?.type === 'Keep');
    const mull = legal.find((a) => a.type === 'MulliganDecision' && a.data?.choice?.type !== 'Keep');
    if ((mine?.mulligan_count ?? 0) >= 1 || (lands.length >= 2 && lands.length <= 5) || !mull) return keep;
    return mull;
  }

  private target(s: any, d: any, legal: any[], me: number): any {
    const choices = legal.filter((a) => a.type === 'ChooseTarget');
    if (!choices.length) return undefined;
    const srcId = d.pending_cast?.object_id ?? d.trigger_event?.data?.object_id ?? d.source_id;
    const src = srcId != null ? obj(s, srcId) : undefined;
    const text = (src?.name && this.cards?.get(src.name)?.oracle) || JSON.stringify(src?.abilities ?? '');
    const harmful = HARMFUL.test(text) && !/you control.*(gets? \+|\+\d+\/\+\d+)/i.test(text.split('\n')[0] ?? '');
    const score = (a: any) => {
      const t = a.data?.target;
      if (t == null) return harmful ? -50 : -60;
      if (t.Player != null) return (t.Player === me) === harmful ? -100 : 5;
      const o = obj(s, t.Object);
      if (!o) return -90;
      const mine = o.controller === me;
      const v = value(o);
      if (harmful) return mine ? (/fight/i.test(text) ? v : -100 - v) : 10 + v;
      return mine ? 10 + v : -100 - v;
    };
    return choices.sort((a, b) => score(b) - score(a))[0];
  }

  private attack(s: any, d: any, me: number): any {
    const ids: number[] = d.valid_attacker_ids ?? [];
    const opp = 1 - me;
    const oppLife = s.players?.[opp]?.life ?? 20;
    const myLife = s.players?.[me]?.life ?? 20;
    const oppCreatures = creatures(s, opp);
    const blockers = oppCreatures.filter((o) => !o.tapped);
    const mine = ids.map((id) => obj(s, id)).filter(Boolean);
    const total = mine.reduce((n, o) => n + (o.power ?? 0), 0);
    const target = (id: number) => {
      const ts: any[] = d.valid_attack_targets_by_attacker?.[String(id)] ?? d.valid_attack_targets ?? [];
      return ts.find((t) => t.type === 'Player' && t.data === opp) ?? ts[0] ?? { type: 'Player', data: opp };
    };
    let attackers: any[];
    if (mine.length > blockers.length && total >= oppLife) {
      attackers = mine; // likely lethal: everything goes
    } else {
      // Hold back when the opponent's board threatens lethal on the crack-back.
      const threat = oppCreatures.reduce((n, o) => n + (o.power ?? 0), 0);
      attackers = mine.filter((a) => {
        const canBlock = blockers.filter((b) => !hasKw(a, 'Flying') || hasKw(b, 'Flying') || hasKw(b, 'Reach'));
        const eaten = canBlock.some((b) => (b.power ?? 0) >= (a.toughness ?? 0) && (b.toughness ?? 0) > (a.power ?? 0));
        return !eaten && (a.power ?? 0) > 0;
      });
      if (threat >= myLife) attackers = attackers.filter((a) => hasKw(a, 'Vigilance'));
    }
    return { type: 'DeclareAttackers', data: { attacks: attackers.map((a) => [a.id, target(a.id)]), bands: [] } };
  }

  private block(s: any, d: any, me: number): any {
    const canBlock: Record<string, number[]> = d.valid_block_targets ?? {};
    const myLife = s.players?.[me]?.life ?? 20;
    const attackers: any[] = (s.combat?.attackers ?? []).map((a: any) => obj(s, a.object_id)).filter(Boolean)
      .sort((x: any, y: any) => (y.power ?? 0) - (x.power ?? 0));
    const used = new Set<number>();
    const assignments: Array<[number, number]> = [];
    let unblocked = 0;
    for (const a of attackers) {
      if (hasKw(a, 'Menace')) {
        unblocked += a.power ?? 0;
        continue;
      }
      const options = Object.entries(canBlock)
        .filter(([b, as]) => !used.has(Number(b)) && as.includes(a.id))
        .map(([b]) => obj(s, Number(b)))
        .filter(Boolean);
      const kills = (b: any) => (b.power ?? 0) >= (a.toughness ?? 0) || hasKw(b, 'Deathtouch');
      const survives = (b: any) => (b.toughness ?? 0) > (a.power ?? 0) && !hasKw(a, 'Deathtouch');
      const pick = options.find((b) => kills(b) && survives(b))
        ?? options.find((b) => survives(b))
        ?? options.filter((b) => kills(b) && value(b) <= value(a)).sort((x, y) => value(x) - value(y))[0];
      if (pick) {
        used.add(pick.id);
        assignments.push([pick.id, a.id]);
      } else {
        unblocked += a.power ?? 0;
      }
    }
    if (unblocked >= myLife) {
      // Facing lethal: chump the biggest unblocked attackers with the cheapest creatures.
      for (const a of attackers) {
        if (unblocked < myLife) break;
        if (assignments.some(([, x]) => x === a.id) || hasKw(a, 'Menace')) continue;
        const chump = Object.entries(canBlock)
          .filter(([b, as]) => !used.has(Number(b)) && as.includes(a.id))
          .map(([b]) => obj(s, Number(b)))
          .filter(Boolean)
          .sort((x, y) => value(x) - value(y))[0];
        if (chump) {
          used.add(chump.id);
          assignments.push([chump.id, a.id]);
          unblocked -= a.power ?? 0;
        }
      }
    }
    return { type: 'DeclareBlockers', data: { assignments } };
  }
}

function obj(s: any, id: number): any {
  return s.objects?.[String(id)];
}

function isLand(o: any): boolean {
  return (o?.card_types?.core_types ?? []).includes('Land');
}

function mv(o: any): number {
  const c = o?.mana_cost;
  if (!c || c.type !== 'Cost') return 0;
  return (c.generic ?? 0) + (c.shards ?? []).length;
}

function hasKw(o: any, k: string): boolean {
  return (o?.keywords ?? []).some((x: any) => x === k || (x && typeof x === 'object' && k in x));
}

function value(o: any): number {
  return (o.power ?? 0) + (o.toughness ?? 0) + mv(o) + (o.keywords?.length ?? 0);
}

function creatures(s: any, player: number): any[] {
  return (s.battlefield ?? []).map((id: number) => obj(s, id)).filter((o: any) => o && o.controller === player && (o.card_types?.core_types ?? []).includes('Creature'));
}
