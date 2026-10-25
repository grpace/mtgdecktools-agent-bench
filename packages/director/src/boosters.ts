import { readFileSync } from 'node:fs';
import { BOOSTER_GENERATOR } from './provenance.js';
import { Rng } from './rng.js';

/**
 * The booster generators this code can run (event_start.boosters.generator). An event regenerates and resumes on its
 * own generator; new events use BOOSTER_GENERATOR.
 *  - boosters-v1: a multi-face card ("Front // Back") is checked by its front face only; a swap's replacement may
 *    repeat a card already drawn in that slot.
 *  - boosters-v2 (2026-10-23): every face is checked (an unsupported back face, adventure, prepare spell or room door
 *    swaps the card out), and on a sheet without duplicates the replacement is never a card already drawn in that slot
 *    (nor drawn again after it).
 */
export const BOOSTER_GENERATORS = ['boosters-v1', 'boosters-v2'] as const;
export type BoosterGeneratorId = (typeof BOOSTER_GENERATORS)[number];

/** A card as printed on a booster sheet (from phase-rs draft-pools.json, which comes from MTGJSON). */
export interface PackCard {
  name: string;
  rarity: string;
  colors: string[];
  cmc: number;
  typeLine: string;
}

interface Sheet {
  cards: Array<{ name: string; rarity: string; weight: number; colors: string[]; cmc: number; type_line: string }>;
  total_weight: number;
  allow_duplicates: boolean;
  fixed: boolean;
}

interface SetPool {
  code: string;
  name: string;
  release_date: string;
  pack_variants: Array<{ contents: Array<{ slot: string; count: number; choices: Array<{ sheet: string; weight: number }> }>; weight: number }>;
  sheets: Record<string, Sheet>;
  basic_lands: string[];
}

/** A card replaced while generating a pack because the engine can't run it. Packs otherwise follow WotC collation exactly (basics included). */
export interface Swap {
  from: string;
  to: string;
  reason?: string;
}

export interface SetInfo {
  code: string;
  name: string;
  releaseDate: string;
}

/**
 * Generates retail-accurate boosters from MTGJSON booster sheets (via phase-rs), including
 * fixed sheets such as FRA's matched Echoed Pairs. Cards the engine can't run yet are swapped
 * for another card of the same rarity from the same sheet, and every swap is reported.
 */
export class BoosterFactory {
  private pools: Record<string, SetPool>;
  private unsupported: Set<string>;
  readonly generator: BoosterGeneratorId;

  /**
   * `unsupported`: card names the engine can't run (see scripts/refresh-phase-data.py / CardDb.unimplemented), whole
   * names or single faces. `generator`: the generator to reproduce (an older event's); new events use the current one.
   */
  constructor(readonly poolsPath: string, unsupported: Iterable<string>, generator: string = BOOSTER_GENERATOR) {
    if (!(BOOSTER_GENERATORS as readonly string[]).includes(generator)) throw new Error(`unknown booster generator "${generator}"`);
    this.generator = generator as BoosterGeneratorId;
    this.pools = JSON.parse(readFileSync(poolsPath, 'utf8'));
    this.unsupported = new Set([...unsupported].map((n) => n.toLowerCase()));
  }

  /** The unsupported card names it was built with (lower case), to build another factory on the same list. */
  unsupportedNames(): string[] {
    return [...this.unsupported];
  }

  sets(): SetInfo[] {
    return Object.values(this.pools)
      .map((p) => ({ code: p.code, name: p.name, releaseDate: p.release_date }))
      .sort((a, b) => b.releaseDate.localeCompare(a.releaseDate));
  }

  set(code: string): SetInfo {
    const p = this.pool(code);
    return { code: p.code, name: p.name, releaseDate: p.release_date };
  }

  /** Every card on the set's booster sheets, by lower-case front-face name (to rebuild pools from logs). */
  cardIndex(code: string): Map<string, PackCard> {
    const out = new Map<string, PackCard>();
    for (const sheet of Object.values(this.pool(code).sheets)) {
      for (const c of sheet.cards) {
        const name = c.name.split(' // ')[0]!;
        if (!out.has(name.toLowerCase())) out.set(name.toLowerCase(), { name, rarity: c.rarity, colors: c.colors, cmc: c.cmc, typeLine: c.type_line });
      }
    }
    return out;
  }

  /** Whether the engine can run this card: its whole name and every face ("Front // Back"; v1: the front face only). */
  isSupported(name: string): boolean {
    if (this.unsupported.has(name.toLowerCase())) return false;
    const faces = name.split(' // ');
    return (this.generator === 'boosters-v1' ? faces.slice(0, 1) : faces).every((f) => !this.unsupported.has(f.trim().toLowerCase()));
  }

  private pool(code: string): SetPool {
    const p = this.pools[code.toLowerCase()];
    if (!p) throw new Error(`No booster data for set "${code}".`);
    return p;
  }

  /** One booster. `swaps` receives every unsupported card that was replaced. */
  pack(code: string, rng: Rng, swaps: Swap[] = []): PackCard[] {
    const pool = this.pool(code);
    const variant = pool.pack_variants[rng.weighted(pool.pack_variants.map((v) => v.weight))]!;
    const out: PackCard[] = [];
    for (const slot of variant.contents) {
      const choice = slot.choices[rng.weighted(slot.choices.map((c) => c.weight))]!;
      const sheet = pool.sheets[choice.sheet];
      if (!sheet) continue;
      if (sheet.fixed) {
        for (const c of sheet.cards) out.push(this.supportedOrSwap(sheet, c, rng, swaps));
        continue;
      }
      const taken = new Set<number>();
      // v2: on a sheet without duplicates, a swap's replacement is never a card already in this slot, and counts as taken.
      const noRepeats = this.generator !== 'boosters-v1' && !sheet.allow_duplicates;
      for (let i = 0; i < slot.count; i++) {
        const weights = sheet.cards.map((c, idx) => (!sheet.allow_duplicates && taken.has(idx) ? 0 : c.weight));
        const idx = rng.weighted(weights);
        taken.add(idx);
        const card = this.supportedOrSwap(sheet, sheet.cards[idx]!, rng, swaps, noRepeats ? new Set([...taken].map((t) => sheet.cards[t]!.name)) : undefined);
        if (noRepeats) {
          const got = sheet.cards.findIndex((x) => x.name.split(' // ')[0] === card.name);
          if (got >= 0) taken.add(got);
        }
        out.push(card);
      }
    }
    return out;
  }


  /**
   * The card itself, or a supported card of the same rarity from the same sheet in its place (one rng.int, recorded in
   * `swaps`). `exclude` (v2, sheets without duplicates): sheet names already in this slot, never the replacement
   * unless nothing else is left.
   */
  private supportedOrSwap(sheet: Sheet, c: Sheet['cards'][number], rng: Rng, swaps: Swap[], exclude?: Set<string>): PackCard {
    let card = c;
    if (!this.isSupported(c.name)) {
      const all = sheet.cards.filter((x) => x.rarity === c.rarity && this.isSupported(x.name));
      const fresh = exclude ? all.filter((x) => !exclude.has(x.name)) : all;
      const alts = fresh.length ? fresh : all;
      const alt = alts.length ? alts[rng.int(alts.length)]! : undefined;
      if (alt) {
        swaps.push({ from: c.name, to: alt.name });
        card = alt;
      }
    }
    // phase-rs resolves multi-face cards by their front face name.
    return { name: card.name.split(' // ')[0]!, rarity: card.rarity, colors: card.colors, cmc: card.cmc, typeLine: card.type_line };
  }
}
