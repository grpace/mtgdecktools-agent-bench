import { BoosterFactory, PackCard } from './boosters.js';
import { CardDb, CardJson, v4Cost } from './cards.js';
import type { LogFn } from './game.js';
import type { Knowledge } from './knowledge.js';
import { Ratings, topColors } from './ratings.js';
import { Rng } from './rng.js';
import { appendFileSync } from 'node:fs';
import { AgentSeat, Offer, unexpectedFields } from './seat.js';

/**
 * A draft that was in progress when the Director stopped, read back from its log (durable.ts): the packs each
 * round opened and every pick already made. Replaying them through the same code (same seed, same Rng draws for
 * the bots) puts the draft back at the pick it had reached, without logging anything twice.
 */
export interface DraftReplay {
  /** Round (1-based) → the logged packs_opened (card names) and swaps. */
  packs: Map<number, { packs: string[][]; swaps: unknown[] }>;
  /** `${seat}|${round}|${pick}` (1-based) → the logged pick. */
  picks: Map<string, { pick: string; by: string }>;
}

/** The log and the regenerated draft disagree (other booster data or code): the draft can't be resumed. */
export class ResumeMismatch extends Error {}

const RARITY_LETTER: Record<string, string> = { common: 'C', uncommon: 'U', rare: 'R', mythic: 'M' };

/**
 * An 8-seat booster draft. Agent seats are asked for each pick through their seat queue;
 * bot seats pick instantly. All seats pick in parallel, then packs pass (left, right, left).
 */
export class Draft {
  readonly pools: PackCard[][];
  private seenText: Array<Set<string>>;
  /** MTGDT_OBS_COMPARE only: the v3 "text shown earlier" bookkeeping for seats that see v4. */
  private shadowSeen: Array<Set<string>>;

  constructor(
    private set: string,
    private factory: BoosterFactory,
    private cards: CardDb,
    private ratings: Ratings,
    private seats: AgentSeat[],
    private rng: Rng,
    private log: LogFn,
    private knowledge: Knowledge,
    private packsPerPlayer = 3,
    private replay?: DraftReplay,
  ) {
    this.pools = seats.map(() => []);
    this.seenText = seats.map(() => new Set());
    this.shadowSeen = seats.map(() => new Set());
  }

  async run(): Promise<PackCard[][]> {
    const n = this.seats.length;
    const setName = this.factory.set(this.set).name;
    for (let round = 0; round < this.packsPerPlayer; round++) {
      const swaps: Array<{ from: string; to: string }> = [];
      let packs = this.seats.map(() => this.factory.pack(this.set, this.rng, swaps));
      const opened = { round: round + 1, packs: packs.map((p) => p.map((c) => c.name)), swaps };
      const logged = this.replay?.packs.get(round + 1);
      if (!logged) this.log('packs_opened', opened);
      else if (JSON.stringify(logged.packs) !== JSON.stringify(opened.packs) || JSON.stringify(logged.swaps) !== JSON.stringify(opened.swaps)) {
        throw new ResumeMismatch(`round ${round + 1}: the regenerated packs differ from the logged ones (booster data or generator changed)`);
      }
      const packSize = packs[0]!.length;
      const dir = round % 2 === 0 ? 1 : -1;
      for (let pick = 0; packs[0]!.length > 0; pick++) {
        const picks = await Promise.all(this.seats.map((seat, i) => this.pickFor(seat, i, packs[i]!, round, pick, packSize, dir, setName)));
        packs.forEach((pack, i) => {
          const idx = picks[i]!;
          const [card] = pack.splice(idx, 1);
          this.pools[i]!.push(card!);
        });
        // Pass: seat i receives the pack from seat i - dir.
        packs = this.seats.map((_, i) => packs[(i - dir + n) % n]!);
      }
    }
    return this.pools;
  }

  /**
   * Bot policy. Bots draw one rng.next() per card (the Hub replays that count: changing it means bumping
   * BOOSTER_GENERATOR in provenance.ts). Forfeited agent picks use the same policy without the noise, so they
   * never touch the Rng.
   */
  private botPick(i: number, pack: PackCard[], noise = true): number {
    const pool = this.pools[i]!;
    const commit = Math.min(1, Math.max(0, (pool.length - 4) / 12));
    const lane = pool.length >= 3 ? topColors(pool, this.ratings) : [];
    let best = 0;
    let bestScore = -Infinity;
    pack.forEach((c, idx) => {
      let s = this.ratings.value(c) + (noise ? this.rng.next() * 0.004 : 0);
      if (lane.length && c.colors.length) {
        const inLane = c.colors.every((col) => lane.includes(col));
        s += commit * (inLane ? 0.02 : -0.035 * c.colors.filter((col) => !lane.includes(col)).length);
      }
      if (s > bestScore) {
        bestScore = s;
        best = idx;
      }
    });
    return best;
  }

  private async pickFor(seat: AgentSeat, i: number, pack: PackCard[], round: number, pick: number, packSize: number, dir: number, setName: string): Promise<number> {
    const record = (idx: number, by: string, extra: Record<string, unknown> = {}) => {
      this.log('draft_pick', {
        seat: seat.name, pack_number: round + 1, pick_number: pick + 1, overall_pick: round * packSize + pick + 1,
        pack: pack.map((c) => c.name), pack_rarities: pack.map((c) => c.rarity), pick: pack[idx]!.name, by, ...extra,
      });
      return idx;
    };
    const key = `${seat.name}|${round + 1}|${pick + 1}`;
    const logged = this.replay?.picks.get(key);
    if (logged) {
      this.replay!.picks.delete(key);
      // Bots draw from the Rng exactly as they did the first time; agents' picks come from the log.
      const idx = seat.kind === 'bot' ? this.botPick(i, pack) : pack.findIndex((c) => c.name === logged.pick);
      if (idx < 0 || pack[idx]!.name !== logged.pick) throw new ResumeMismatch(`${key}: logged pick ${logged.pick} is not what the replay gives`);
      return idx;
    }
    if (seat.kind === 'bot') return record(this.botPick(i, pack), 'bot');
    if (pack.length === 1) return record(0, 'forced');

    seat.setStatus(`Draft: waiting for the other drafters to finish pack ${round + 1}, pick ${pick + 1}.`);
    return new Promise<number>((resolve) => {
      const offer: Offer = {
        id: seat.nextId('D'),
        phase: 'draft',
        kind: 'draft_pick',
        text: '',
        options: pack.map((c, idx) => ({ id: String(idx + 1), label: c.name, value: idx })),
        createdAt: Date.now(),
        answer: async (input, o) => {
          const extra = unexpectedFields(input, [], 'A draft pick');
          if (extra) return extra;
          const idx = input.option != null ? Number(input.option) - 1 : NaN;
          if (!(idx >= 0 && idx < pack.length)) return `Pick a card with option="1".."${pack.length}".`;
          record(idx, 'agent', { latency_ms: Date.now() - o.createdAt, note: input.note });
          resolve(idx);
          return null;
        },
        // Inactive seat (watchdog): the bot policy picks for it, logged as by 'forfeit'.
        forfeit: () => {
          const idx = this.botPick(i, pack, false);
          record(idx, 'forfeit');
          seat.clear();
          resolve(idx);
          return { pack_number: round + 1, pick_number: pick + 1, pick: pack[idx]!.name };
        },
      };
      offer.text = this.pickText(seat, i, pack, round, pick, packSize, dir, setName, offer.id);
      seat.offer(offer);
    });
  }

  private pickText(seat: AgentSeat, i: number, pack: PackCard[], round: number, pick: number, packSize: number, dir: number, setName: string, id: string): string {
    const v4 = seat.observation === 'v4';
    const text = v4 ? this.pickTextV4(i, pack, round, pick, packSize, dir, setName, id) : this.pickTextV3(i, pack, round, pick, packSize, dir, setName, id, this.seenText[i]!);
    // Debug measurement (game.ts MTGDT_OBS_COMPARE): the other format for the same pick.
    const cmp = process.env.MTGDT_OBS_COMPARE;
    if (cmp) {
      const v3 = v4 ? this.pickTextV3(i, pack, round, pick, packSize, dir, setName, id, this.shadowSeen[i]!) : text;
      appendFileSync(cmp, JSON.stringify({ seat: seat.name, id, kind: 'draft_pick', v3, v4: v4 ? text : this.pickTextV4(i, pack, round, pick, packSize, dir, setName, id) }) + '\n');
    }
    return text;
  }

  /** Prompt v2/v3: one text line per card, rules text the first time a card name is seen in the draft. */
  private pickTextV3(i: number, pack: PackCard[], round: number, pick: number, packSize: number, dir: number, setName: string, id: string, seen: Set<string>): string {
    const lines: string[] = [];
    lines.push(`DRAFT — ${setName} (${this.set.toUpperCase()}), ${this.seats.length}-player pod. Pack ${round + 1} of ${this.packsPerPlayer}, pick ${pick + 1} of ${packSize} (passing ${dir > 0 ? 'left' : 'right'}).`);
    lines.push('', `Your picks so far (${this.pools[i]!.length}):`);
    lines.push(...poolSummary(this.pools[i]!));
    lines.push('', 'This pack:');
    pack.forEach((c, idx) => {
      const r = RARITY_LETTER[c.rarity] ?? c.rarity;
      const full = !seen.has(c.name);
      seen.add(c.name);
      const info = this.cards.get(c.name);
      const desc = full ? this.cards.describe(c.name) : `${c.name} ${info?.cost ?? ''} — ${info?.typeLine ?? c.typeLine}${info?.pt ? ` ${info.pt}` : ''} (text shown earlier)`;
      const stats = this.knowledge.stats ? this.ratings.statsLabel(c.name) : '';
      lines.push(`  [${idx + 1}] (${r}) ${desc}${stats ? `  [${stats}]` : ''}`);
    });
    lines.push('', `DECISION ${id} — pick one card. Answer with decide(decision_id="${id}", option="<number>", note="<short reason>").`);
    return lines.join('\n');
  }

  /** Prompt v4: every card in the pack as card JSON (full text at every pick), the picks so far compact with costs. */
  private pickTextV4(i: number, pack: PackCard[], round: number, pick: number, packSize: number, dir: number, setName: string, id: string): string {
    const pool = this.pools[i]!;
    const lines: string[] = [];
    lines.push(`DRAFT — ${setName} (${this.set.toUpperCase()}), ${this.seats.length}-player pod. Pack ${round + 1} of ${this.packsPerPlayer}, pick ${pick + 1} of ${packSize} (passing ${dir > 0 ? 'left' : 'right'}).`);
    lines.push('', `Your picks so far (${pool.length}):`, ...poolSummaryV4(pool, this.cards));
    lines.push('', 'THIS PACK (one card per line; "n" is the option number):');
    pack.forEach((c, idx) => lines.push(JSON.stringify(packCardJson(c, idx + 1, this.cards, this.knowledge.stats ? this.ratings.statsLabel(c.name) : ''))));
    lines.push('', `DECISION ${id} — pick one card. Answer with decide(decision_id="${id}", option="<n>", note="<short reason>").`);
    return lines.join('\n');
  }
}

/** A pack or pool card as v4 card JSON: its option/pool number, rarity, printed data, and 17Lands stats when the event shows them. */
export function packCardJson(c: PackCard, n: number, cards: CardDb, stats: string): Record<string, unknown> {
  const printed: CardJson = cards.get(c.name) ? cards.json(c.name) : { name: c.name, mv: c.cmc, colors: c.colors.join(''), type: c.typeLine };
  return { n, rarity: RARITY_NAME[c.rarity] ?? c.rarity, ...printed, ...(stats ? { '17lands': stats.replace(/^17Lands:\s*/, '') } : {}) };
}

const RARITY_NAME: Record<string, string> = { common: 'common', uncommon: 'uncommon', rare: 'rare', mythic: 'mythic' };
const COLOR_GROUP: Record<string, string> = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };

/**
 * Prompt v4 pool summary: by color (card counts include copies), each card once with its cost and type and "3× " when
 * there are several copies, then the curve and creature count.
 */
export function poolSummaryV4(pool: PackCard[], cards: CardDb): string[] {
  if (!pool.length) return ['  (none yet)'];
  const groups = new Map<string, Map<string, { text: string; n: number }>>();
  const curve = [0, 0, 0, 0, 0, 0, 0];
  let creatures = 0;
  let spells = 0;
  for (const c of pool) {
    const key = c.colors.length === 0 ? (/\bLand\b/.test(c.typeLine) ? 'Lands' : 'Colorless') : c.colors.length > 1 ? 'Multicolor' : COLOR_GROUP[c.colors[0]!] ?? c.colors[0]!;
    const info = cards.get(c.name);
    const type = (info?.typeLine ?? c.typeLine).split(' — ')[0]!;
    const pt = info?.pt ? ` ${info.pt}` : '';
    if (!groups.has(key)) groups.set(key, new Map());
    const g = groups.get(key)!;
    const seen = g.get(c.name);
    if (seen) seen.n++;
    else g.set(c.name, { text: `${c.name} ${v4Cost(info?.cost ?? '')} ${type}${pt}`.replace(/\s+/g, ' ').trim(), n: 1 });
    if (!/\bLand\b/.test(c.typeLine)) {
      curve[Math.min(6, Math.max(0, Math.round(info?.mv ?? c.cmc)))]!++;
      if (/Creature/.test(info?.typeLine ?? c.typeLine)) creatures++;
      else spells++;
    }
  }
  const order = ['White', 'Blue', 'Black', 'Red', 'Green', 'Multicolor', 'Colorless', 'Lands'];
  const out = [...groups.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([k, v]) => {
    const list = [...v.values()];
    return `  ${k} (${list.reduce((s, x) => s + x.n, 0)}): ${list.map((x) => `${x.n > 1 ? `${x.n}× ` : ''}${x.text}`).join('; ')}`;
  });
  out.push(`  Curve (nonland, by mana value): ${curve.map((n, mv) => `${mv === 6 ? '6+' : mv}:${n}`).join(' ')} | creatures ${creatures}, other spells ${spells}`);
  return out;
}

export function poolSummary(pool: PackCard[]): string[] {
  if (!pool.length) return ['  (none yet)'];
  const groups = new Map<string, string[]>();
  const names: Record<string, string> = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };
  for (const c of pool) {
    const key = c.colors.length === 0 ? 'Colorless/land' : c.colors.length > 1 ? `Multicolor` : names[c.colors[0]!] ?? c.colors[0]!;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(`${c.name}${c.colors.length > 1 ? ` (${c.colors.join('')})` : ''}`);
  }
  return [...groups.entries()].map(([k, v]) => `  ${k} (${v.length}): ${v.join(', ')}`);
}
