import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The slice of phase-rs card data we show to agents. */
export interface CardInfo {
  name: string;
  cost: string;
  typeLine: string;
  pt?: string;
  loyalty?: string;
  oracle: string;
  /** Mana value (slim cache format 2+). */
  mv?: number;
  /** Color letters in WUBRG order, '' for colorless. */
  colors?: string;
  /** Printed keywords. */
  keywords?: string[];
  defense?: string;
  /** phase-rs layout (transform, modal_dfc, adventure, prepare, …) for multi-face cards. */
  layout?: string;
  /** The card's other face(s), for multi-face cards. */
  faces?: string[];
}

/**
 * One card as agents see it from prompt v4 on (game state, packs, pools, get_card): the same fields the
 * MTG Deck Tools deck builder gives its models. Static, printed data only; game state lives on the object.
 */
export interface CardJson {
  name: string;
  cost?: string;
  mv: number;
  colors: string;
  type: string;
  pt?: string;
  loyalty?: string;
  defense?: string;
  keywords?: string[];
  text?: string;
  /** For multi-face cards: phase-rs/Scryfall layout (transform, modal_dfc, adventure, split, flip, meld, prepare). */
  layout?: string;
  /** Other faces of a multi-face card (or both halves of a split card / room), same fields. */
  faces?: Array<Omit<CardJson, 'faces'>>;
}

/** Bump when the slim cache gains fields, so old caches are rebuilt. */
const SLIM_FORMAT = 4;
const WUBRG = ['W', 'U', 'B', 'R', 'G'];
const LETTER_COLOR: Record<string, string> = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };

/** Mana value of a phase-rs ManaCost: generic + one per shard (X counts 0). */
export function manaValue(cost: any): number {
  if (!cost || cost.type !== 'Cost') return 0;
  return (cost.generic ?? 0) + (cost.shards ?? []).filter((s: unknown) => s !== 'X').length;
}

/** Color letters of a list like ['White', 'Green'] (or of a cost's shards), WUBRG order. */
export function colorLetters(colors: string[] | undefined): string {
  const set = new Set<string>();
  for (const c of colors ?? []) for (const part of String(c).match(/[A-Z][a-z]+/g) ?? []) if (SHARD[part] && WUBRG.includes(SHARD[part]!)) set.add(SHARD[part]!);
  return WUBRG.filter((l) => set.has(l)).join('');
}

const SHARD: Record<string, string> = {
  White: 'W', Blue: 'U', Black: 'B', Red: 'R', Green: 'G', Colorless: 'C', Snow: 'S', X: 'X',
};

export function formatCost(cost: any): string {
  if (!cost || cost.type !== 'Cost') return '';
  const generic = cost.generic ? `{${cost.generic}}` : '';
  const shards = (cost.shards ?? []).map((s: unknown) => {
    if (typeof s !== 'string') return `{${JSON.stringify(s)}}`;
    if (SHARD[s]) return `{${SHARD[s]}}`;
    // Hybrid / phyrexian shards are named like "WhiteBlue" or "PhyrexianRed".
    const parts = s.match(/[A-Z][a-z]+/g) ?? [s];
    return `{${parts.map((p) => SHARD[p] ?? (p === 'Phyrexian' ? 'P' : p)).join('/')}}`;
  });
  const out = generic + shards.join('');
  return out || '{0}';
}

/**
 * Prompt v4 cost notation (Scryfall's, which the MTG Deck Tools deck builder's rules use): "{Two/G}" → "{2/G}",
 * phyrexian "{P/R}" → "{R/P}", "{P/G/W}" → "{G/W/P}". Prompts v1–v3 keep formatCost's output unchanged.
 */
export function v4Cost(cost: string): string {
  return cost.replace(/\{([^}]+)\}/g, (m, sym: string) => {
    const parts = sym.split('/').map((p) => (p === 'Two' ? '2' : p));
    if (parts.length < 2) return m;
    const phy = parts.includes('P');
    return `{${[...parts.filter((p) => p !== 'P'), ...(phy ? ['P'] : [])].join('/')}}`;
  });
}

export function formatTypeLine(t: any): string {
  if (!t) return '';
  const left = [...(t.supertypes ?? []), ...(t.core_types ?? [])].join(' ');
  const sub = (t.subtypes ?? []).join(' ');
  return sub ? `${left} — ${sub}` : left;
}

/** phase-rs keyword → text: "Flying", {Ward: {Mana cost}} → "Ward {2}", {Toxic: 1} → "Toxic 1". */
export function keywordText(k: any): string {
  if (typeof k === 'string') return k.replace(/([a-z])([A-Z])/g, '$1 $2');
  if (k && typeof k === 'object') {
    const [key, val] = Object.entries(k)[0] ?? ['?', null];
    const name = String(key).replace(/([a-z])([A-Z])/g, '$1 $2');
    if (typeof val === 'number' || typeof val === 'string') return `${name} ${val}`;
    const v = val as any;
    if (!v || typeof v !== 'object') return name;
    if (v.type === 'Mana' && v.data) return `${name} ${formatCost(v.data)}`;
    if (v.type === 'Mana' && v.cost) return `${name} ${formatCost(v.cost)}`;
    if (v.type === 'Cost') return `${name} ${formatCost(v)}`;
    // Typecycling {cost, subtype: "Basic Land"} → "Basic landcycling {2}".
    if (key === 'Typecycling' && typeof v.subtype === 'string' && v.cost?.type === 'Cost') {
      const t = `${v.subtype.toLowerCase()}cycling`;
      return `${t.charAt(0).toUpperCase()}${t.slice(1)} ${formatCost(v.cost)}`;
    }
    if (v.cost?.type === 'Cost') return `${name} ${formatCost(v.cost)}`;
    if (typeof v.power === 'number') return `${name} ${v.power}`;
    if (typeof v.Color === 'string') return `${name} from ${v.Color.toLowerCase()}`;
    if (v.type === 'Typed' && Array.isArray(v.type_filters)) {
      const words = v.type_filters.filter((f: unknown) => typeof f === 'string').map((f: string) => f.toLowerCase());
      return words.length ? `${name} ${words.join(' ')}` : name;
    }
    if (v.type === 'Player') return `${name} player`;
    return name;
  }
  return String(k);
}

function ptValue(v: any): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'number') return String(v);
  if (v.type === 'Fixed') return String(v.value);
  return '*';
}

/**
 * Card lookup by name. Built from phase-server's card-data.json (≈100 MB) once, then cached as a
 * slim index in `cacheDir` (which may differ from the read-only engine data dir). The cache is
 * rebuilt whenever card-data.json changes (e.g. after a phase-rs upgrade).
 */
export class CardDb {
  private byName = new Map<string, CardInfo>();
  /** Cards whose parsed rules in this build contain Unimplemented/Unknown nodes. */
  unimplemented: string[] = [];

  constructor(private cardDataPath: string, cacheDir: string = dirname(cardDataPath)) {
    const slimPath = join(cacheDir, 'card-data.slim.json');
    const metaPath = join(cacheDir, 'card-data.slim.meta.json');
    const st = statSync(cardDataPath);
    // Booster data next to the card data names multi-face cards in full ("Front // Back"): the reliable face links.
    const poolsPath = join(dirname(cardDataPath), 'draft-pools.json');
    const pools = existsSync(poolsPath) ? statSync(poolsPath).size : 0;
    const stamp = { size: st.size, mtimeMs: Math.floor(st.mtimeMs), pools };
    const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : null;
    if (existsSync(slimPath) && meta && meta.size === stamp.size && meta.mtimeMs === stamp.mtimeMs && meta.pools === stamp.pools && meta.format === SLIM_FORMAT) {
      for (const c of JSON.parse(readFileSync(slimPath, 'utf8')) as CardInfo[]) this.byName.set(c.name.toLowerCase(), c);
      this.unimplemented = meta.unimplemented ?? [];
      return;
    }
    const raw = JSON.parse(readFileSync(cardDataPath, 'utf8')) as Record<string, any>;
    // Faces of one card: "Front // Back" names in the booster data (split halves and rooms, adventures, prepare,
    // transform, modal DFC, flip, meld), else a shared Scryfall oracle id (transform, modal DFC, adventure). Links go
    // both ways, except from a prepare spell back to its creature: several creatures share one prepare spell, so
    // only the object in play knows which one it belongs to (render-v4 reads the engine's back_face).
    const linked = new Map<string, Set<string>>();
    const link = (a: string, b: string) => {
      if (!linked.has(a)) linked.set(a, new Set());
      linked.get(a)!.add(b);
    };
    if (pools) {
      try {
        for (const m of readFileSync(poolsPath, 'utf8').matchAll(/"name":\s*"((?:[^"\\]|\\.)+? \/\/ (?:[^"\\]|\\.)+?)"/g)) {
          const parts: string[] = JSON.parse(`"${m[1]}"`).split(' // ');
          for (const a of parts) {
            for (const b of parts) {
              if (a === b) continue;
              const fromShared = raw[a.toLowerCase()]?.layout === 'prepare' && raw[a.toLowerCase()]?.face_index === 1;
              if (!fromShared) link(a, b);
            }
          }
        }
      } catch {
        // unreadable booster data: oracle ids only
      }
    }
    const byOracle = new Map<string, string[]>();
    for (const c of Object.values(raw)) {
      if (c.layout && c.layout !== 'normal' && c.layout !== 'prepare' && c.scryfall_oracle_id) {
        const list = byOracle.get(c.scryfall_oracle_id) ?? [];
        list.push(c.name);
        byOracle.set(c.scryfall_oracle_id, list);
      }
    }
    for (const list of byOracle.values()) for (const a of list) for (const b of list) if (a !== b) link(a, b);
    for (const [key, c] of Object.entries(raw)) {
      const p = ptValue(c.power);
      const t = ptValue(c.toughness);
      const keywords = (c.keywords ?? []).map((k: any) => keywordText(k)).filter(Boolean);
      const faces = [...(linked.get(c.name) ?? [])];
      this.byName.set(key, {
        name: c.name,
        cost: formatCost(c.mana_cost),
        typeLine: formatTypeLine(c.card_type),
        pt: p !== undefined && t !== undefined ? `${p}/${t}` : undefined,
        loyalty: ptValue(c.loyalty),
        oracle: c.oracle_text ?? '',
        mv: manaValue(c.mana_cost),
        colors: colorLetters(c.color_override ?? (c.mana_cost?.shards ?? []).filter((x: unknown) => typeof x === 'string')),
        ...(keywords.length ? { keywords } : {}),
        ...(ptValue(c.defense) !== undefined ? { defense: ptValue(c.defense) } : {}),
        ...(faces.length ? { layout: c.layout ?? (raw[[...faces][0]!.toLowerCase()]?.layout) ?? 'multi-face', faces } : {}),
      });
      const blob = JSON.stringify(c);
      if (blob.includes('Unimplemented') || blob.includes('"Unknown"')) this.unimplemented.push(c.name);
    }
    try {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(slimPath, JSON.stringify([...this.byName.values()]));
      writeFileSync(metaPath, JSON.stringify({ ...stamp, format: SLIM_FORMAT, unimplemented: this.unimplemented }));
    } catch {
      // read-only cache dir: just rebuild next start
    }
  }

  /** Which card data this is, for event_start.provenance.card_data (read again whenever the file changes). */
  provenance(): CardDataProvenance | undefined {
    return cardDataProvenance(this.cardDataPath);
  }

  get(name: string): CardInfo | undefined {
    return this.byName.get(name.toLowerCase()) ?? this.byName.get(name.split(' // ')[0]!.toLowerCase());
  }

  /**
   * The v4 card JSON for one card name (printed data). Basic lands get only name/type: their text adds nothing.
   * `withFaces` adds the other faces of multi-face cards.
   */
  json(name: string, withFaces = true): CardJson {
    // A split card or room in a hand, graveyard or library is one object named "Left // Right": both halves.
    const halves = name.split(' // ');
    if (halves.length > 1 && withFaces && halves.every((h) => this.get(h))) {
      const parts = halves.map((h) => this.json(h, false));
      return {
        name, cost: parts.map((x) => x.cost ?? '').join(' // '), mv: parts.reduce((t, x) => t + x.mv, 0),
        colors: colorLetters(parts.flatMap((x) => (x.colors === 'colorless' ? [] : x.colors.split('').map((l) => LETTER_COLOR[l]!)))) || 'colorless',
        type: parts.map((x) => x.type).join(' // '), layout: this.get(halves[0]!)?.layout ?? 'split', faces: parts,
      };
    }
    const c = this.get(name);
    if (!c) return { name, mv: 0, colors: '', type: '?' };
    // Key order matters for readability: name, cost, mana value, colors, type, stats, keywords, text.
    const out = { name: c.name } as CardJson;
    if (c.cost && !/^Basic Land/.test(c.typeLine)) out.cost = v4Cost(c.cost);
    out.mv = c.mv ?? 0;
    out.colors = c.colors || 'colorless';
    out.type = c.typeLine;
    if (c.pt) out.pt = c.pt;
    if (c.loyalty) out.loyalty = c.loyalty;
    if (c.defense) out.defense = c.defense;
    if (c.keywords?.length) out.keywords = c.keywords;
    if (c.oracle && !/^Basic Land/.test(c.typeLine)) out.text = c.oracle;
    if (withFaces && c.faces?.length) {
      out.layout = c.layout;
      out.faces = c.faces.map((f) => this.json(f, false));
    }
    return out;
  }

  /** One-line reference: "Name {2}{W} — Creature — Cat 2/1 — oracle text". */
  describe(name: string): string {
    const c = this.get(name);
    if (!c) return name;
    const stats = c.pt ?? (c.loyalty ? `loyalty ${c.loyalty}` : '');
    const oracle = c.oracle.replace(/\n/g, ' / ');
    return [`${c.name} ${c.cost}`.trim(), c.typeLine, stats, oracle].filter(Boolean).join(' — ');
  }
}

/**
 * The card data phase-server runs (docs/CARD-OVERRIDES.md), logged in event_start.provenance.card_data so results,
 * replays and the Hub know which card behavior an event had. `sha256` is the file itself. When
 * scripts/card_overrides.py wrote it (its sidecar, card-overrides.json, names this exact file), the upstream file's hash,
 * the fingerprint of the applied overrides and their slugs come with it. A sidecar for another file is reported as stale
 * and its overrides are not claimed. In production the Director reads the same volume phase-server loads.
 */
export interface CardDataProvenance {
  sha256: string;
  upstream_sha256?: string;
  /** sha256 over the applied override files (slug + file hash), like prompt_sha256 for prompts. */
  overrides_sha256?: string;
  /** Slugs of the applied overrides (engine/overrides/<slug>.json); [] = upstream card data. */
  overrides?: string[];
  sidecar?: 'stale';
}

const provenanceCache = new Map<string, { stamp: string; value: CardDataProvenance }>();

export function cardDataProvenance(cardDataPath: string): CardDataProvenance | undefined {
  if (!existsSync(cardDataPath)) return undefined;
  const sidecarPath = join(dirname(cardDataPath), 'card-overrides.json');
  const st = statSync(cardDataPath);
  const side = existsSync(sidecarPath) ? statSync(sidecarPath) : undefined;
  const stamp = `${st.size}:${st.mtimeMs}:${side ? `${side.size}:${side.mtimeMs}` : '-'}`;
  const hit = provenanceCache.get(cardDataPath);
  if (hit?.stamp === stamp) return hit.value;
  const sha256 = createHash('sha256').update(readFileSync(cardDataPath)).digest('hex');
  let value: CardDataProvenance = { sha256 };
  if (side) {
    try {
      const s = JSON.parse(readFileSync(sidecarPath, 'utf8'));
      if (s?.sha256 === sha256 && typeof s.upstream_sha256 === 'string' && typeof s.overrides_sha256 === 'string' && Array.isArray(s.overrides)) {
        value = { sha256, upstream_sha256: s.upstream_sha256, overrides_sha256: s.overrides_sha256, overrides: s.overrides.map((o: { slug: string }) => String(o.slug)) };
      } else value = { sha256, sidecar: 'stale' };
    } catch {
      value = { sha256, sidecar: 'stale' };
    }
  }
  provenanceCache.set(cardDataPath, { stamp, value });
  return value;
}

/**
 * The cards the card overrides applied to this file make supported (the sidecar's `supported`, written by
 * scripts/card_overrides.py / card-overrides.ts): they come off the unsupported-card list. [] without a sidecar that
 * describes this exact file.
 */
export function overrideSupported(cardDataPath: string): string[] {
  const prov = cardDataProvenance(cardDataPath);
  if (!prov?.overrides_sha256) return [];
  try {
    const s = JSON.parse(readFileSync(join(dirname(cardDataPath), 'card-overrides.json'), 'utf8'));
    return s?.sha256 === prov.sha256 && Array.isArray(s.supported) ? s.supported.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * The fingerprint a set of card overrides has with this repository's files (engine/overrides/<slug>.json), computed as
 * scripts/card_overrides.py fingerprint() does: sha256 over the sorted slugs, each `slug \0 sha256(file bytes) \0`.
 * null when a slug has no file here. The Hub compares it with event_start.provenance.card_data.overrides_sha256.
 */
export function overridesFingerprint(slugs: string[], dir = fileURLToPath(new URL('../../../engine/overrides/', import.meta.url))): string | null {
  const h = createHash('sha256');
  for (const slug of [...slugs].sort()) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null;
    const path = join(dir, `${slug}.json`);
    if (!existsSync(path)) return null;
    h.update(Buffer.concat([Buffer.from(slug), Buffer.from([0]), createHash('sha256').update(readFileSync(path)).digest(), Buffer.from([0])]));
  }
  return h.digest('hex');
}
