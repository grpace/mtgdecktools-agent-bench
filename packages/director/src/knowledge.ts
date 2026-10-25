import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PackCard } from './boosters.js';
import { Ratings } from './ratings.js';
import { filterSetContext } from './set-context-filter.js';

/**
 * What agents are allowed to know, set per event and identical for every seat.
 *  - none:          card text only.
 *  - primer:        + the MTG Deck Tools set primer and deckbuilding guide, and a pool analysis at deckbuilding.
 *  - primer+stats:  + 17Lands public-data GIH WR / ATA next to cards in packs and pools.
 */
export type KnowledgeLevel = 'none' | 'primer' | 'primer+stats';
export const KNOWLEDGE_LEVELS: KnowledgeLevel[] = ['none', 'primer', 'primer+stats'];

/** Where set primers are published: MTG Deck Tools exports its set contexts at build time. */
export const DEFAULT_PRIMER_URL = 'https://www.mtgdecktools.com/agent-bench/set-contexts/{CODE}.md';

export interface Knowledge {
  level: KnowledgeLevel;
  /** General Limited fundamentals (drafting, building, play): every seat gets these, at every level. */
  fundamentals?: string;
  primer?: string;
  /** Where the primer came from and its hash, so results can be tied to an exact primer version. */
  primerSource?: { from: 'mtgdecktools.com' | 'cache' | 'repo'; url?: string; sha256: string; bytes: number };
  guide?: string;
  stats: boolean;
  /** Why the effective level differs from the requested one, if it does. */
  warning?: string;
  /** The level asked for, when the set couldn't support it and the event fell back (`primer` → `none`). */
  requested?: KnowledgeLevel;
}

/** The set can't support the requested knowledge level (a 400 for the API; the CLI prints the message). */
export class KnowledgeUnavailable extends Error {}

/** `primer+stats` needs human play statistics for the set (sets/<SET>/17lands.json). */
export function statsUnavailable(level: KnowledgeLevel, set: string, setsDir: string): string | undefined {
  if (level !== 'primer+stats' || Ratings.hasStats(setsDir, set)) return undefined;
  return `Knowledge level "primer+stats" needs human play statistics for the set, and ${set.toUpperCase()} has none. Use "primer" (set context) or "none".`;
}

export interface PrimerSources {
  /** URL template with {CODE}; empty string disables fetching. */
  url: string;
  /** Directory for the last successfully fetched copy of each primer (offline fallback). */
  cacheDir: string;
}

/**
 * Load what agents may know. Primers come straight from mtgdecktools.com (so edits there reach the
 * next event), falling back to the last fetched copy, then to the exported copy in sets/<SET>/primer.md.
 * Every copy goes through the tier-score filter (set-context-filter.ts) before an agent sees it; the logged sha256 and
 * size are of the filtered text, the text agents read.
 */
/**
 * Why a table may not run a Set Context level, or undefined: a set without a Set Context would
 * quietly run at "none" and pool there. Contributors' tables and lobby queues are refused unless the request says so
 * (`allow_downgrade`); admin tables keep running with the warning.
 */
export function setContextRefusal(code: string, knowledge: KnowledgeLevel, o: { available: boolean; allowDowngrade: boolean }): string | undefined {
  if (knowledge === 'none' || o.allowDowngrade || o.available) return undefined;
  return `no Set Context is published for ${code.toUpperCase()} yet, so knowledge "${knowledge}" can't be given: choose knowledge "none", or pass allow_downgrade (bench: --allow-downgrade) to run at "none" knowingly`;
}

export async function loadKnowledge(level: KnowledgeLevel, set: string, setsDir: string, promptsDir: string, sources?: PrimerSources): Promise<Knowledge> {
  if (!KNOWLEDGE_LEVELS.includes(level)) throw new Error(`Unknown knowledge level "${level}" (use ${KNOWLEDGE_LEVELS.join(', ')}).`);
  const noStats = statsUnavailable(level, set, setsDir);
  if (noStats) throw new KnowledgeUnavailable(noStats);
  const k: Knowledge = { level, stats: level === 'primer+stats' };
  // Standard for every seat (prompt v3+): general fundamentals and the deckbuilding guide.
  const fundamentalsPath = join(promptsDir, 'fundamentals.md');
  if (existsSync(fundamentalsPath)) k.fundamentals = readFileSync(fundamentalsPath, 'utf8');
  const standardGuide = join(promptsDir, 'deckbuilding-guide.md');
  if (existsSync(standardGuide)) k.guide = readFileSync(standardGuide, 'utf8');
  if (level === 'none') return k;
  const code = set.toUpperCase();
  const hash = (t: string) => createHash('sha256').update(t).digest('hex');
  const cachePath = sources ? join(sources.cacheDir, `${code}.md`) : undefined;
  if (sources?.url) {
    const url = sources.url.replace('{CODE}', code);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const text = res.ok ? await res.text() : '';
      // Guard against SPA fallbacks serving index.html for a missing file.
      if (text.length > 200 && !/^\s*<!doctype html/i.test(text)) {
        k.primer = filterSetContext(text);
        k.primerSource = { from: 'mtgdecktools.com', url, sha256: hash(k.primer), bytes: k.primer.length };
        mkdirSync(sources.cacheDir, { recursive: true });
        writeFileSync(cachePath!, text);
      }
    } catch {
      // offline or not published yet: fall through
    }
  }
  if (!k.primer && cachePath && existsSync(cachePath)) {
    k.primer = filterSetContext(readFileSync(cachePath, 'utf8'));
    k.primerSource = { from: 'cache', sha256: hash(k.primer), bytes: k.primer.length };
  }
  const primerPath = join(setsDir, code, 'primer.md');
  if (!k.primer && existsSync(primerPath)) {
    k.primer = filterSetContext(readFileSync(primerPath, 'utf8').replace(/^<!--.*?-->\s*/s, ''));
    k.primerSource = { from: 'repo', sha256: hash(k.primer), bytes: k.primer.length };
  }
  if (!k.primer) {
    if (level === 'primer+stats') throw new KnowledgeUnavailable(`Knowledge level "primer+stats" needs a set context for ${code}, and none is published yet. Use "none".`);
    // No set context: the event runs at "none" (what the agents actually get), so it pools with other "none" events.
    k.requested = level;
    k.level = 'none';
    k.warning = `No set context is published for ${code} yet, so this event runs at knowledge level "none" (requested "${level}"): agents get the standard briefing only.`;
    return k;
  }
  const guidePath = join(promptsDir, 'deckbuilding-guide.md');
  if (existsSync(guidePath)) k.guide = readFileSync(guidePath, 'utf8');
  return k;
}

const PAIRS = ['WU', 'UB', 'BR', 'RG', 'GW', 'WB', 'UR', 'BG', 'RW', 'GU'];
const PAIR_NAMES: Record<string, string> = {
  WU: 'Azorius (WU)', UB: 'Dimir (UB)', BR: 'Rakdos (BR)', RG: 'Gruul (RG)', GW: 'Selesnya (GW)',
  WB: 'Orzhov (WB)', UR: 'Izzet (UR)', BG: 'Golgari (BG)', RW: 'Boros (RW)', GU: 'Simic (GU)',
};

/**
 * MTG Deck Tools-style pool analysis: for each color pair, how many playables, creatures and
 * two-drops the pool offers (and, with stats, the average 17Lands GIH WR of its best 23).
 */
export function poolAnalysis(pool: PackCard[], ratings: Ratings, withStats: boolean): string[] {
  const nonland = pool.filter((c) => !/\bLand\b/.test(c.typeLine));
  const rows = PAIRS.map((pair) => {
    const fits = nonland.filter((c) => c.colors.every((col) => pair.includes(col)));
    const creatures = fits.filter((c) => /Creature/.test(c.typeLine)).length;
    const twoDrops = fits.filter((c) => c.cmc === 2).length;
    const gold = fits.filter((c) => c.colors.length === 2).length;
    const best = [...fits].sort((a, b) => ratings.value(b) - ratings.value(a)).slice(0, 23);
    // Empty slots count as replacement-level filler, so a thin color pair can't rank on a few good cards.
    const REPLACEMENT = 0.48;
    const avg = (best.reduce((s, c) => s + ratings.value(c), 0) + (23 - best.length) * REPLACEMENT) / 23;
    return { pair, playables: fits.length, creatures, twoDrops, gold, avg };
  });
  rows.sort((a, b) => (withStats ? b.avg - a.avg : 0) || b.playables - a.playables || b.creatures - a.creatures);
  const lines = ['Pool analysis (MTG Deck Tools): playables per color pair (colorless cards count for every pair):'];
  for (const r of rows.slice(0, 5)) {
    const stats = withStats ? `, best-23 avg GIH WR ${(r.avg * 100).toFixed(1)}%` : '';
    lines.push(`  ${PAIR_NAMES[r.pair]}: ${r.playables} playables (${r.creatures} creatures, ${r.twoDrops} two-drops, ${r.gold} gold)${stats}`);
  }
  const lands = pool.filter((c) => /\bLand\b/.test(c.typeLine) && !/^Basic Land/.test(c.typeLine));
  if (lands.length) lines.push(`  Non-basic lands in pool: ${lands.map((c) => c.name).join(', ')}`);
  return lines;
}

/** The largest part of the Set Context one tool result carries (about 6k tokens; harnesses cut results near 50 KB). */
export const SET_CONTEXT_PART_CHARS = 24_000;

/**
 * Split the Set Context into parts that each fit one tool result: at headings where possible, then at blank lines,
 * then at line ends, then anywhere. Parts are about equal in size, and none is longer than `max`.
 */
export function splitSetContext(text: string, max = SET_CONTEXT_PART_CHARS): string[] {
  const doc = text.trim();
  if (doc.length <= max) return [doc];
  // Smallest pieces we may cut between: sections (a line starting with #), split further when one is too long.
  const pieces: string[] = [];
  const cut = (block: string, seps: RegExp[]): void => {
    if (block.length <= max || !seps.length) {
      for (let i = 0; i < block.length; i += max) pieces.push(block.slice(i, i + max));
      return;
    }
    const [sep, ...rest] = seps;
    const parts = block.split(sep!).filter((x) => x.length);
    if (parts.length < 2) return cut(block, rest);
    for (const p of parts) (p.length > max ? cut(p, rest) : pieces.push(p));
  };
  cut(doc, [/(?=^#{1,6} )/m, /(?<=\n\n)/, /(?<=\n)/]);
  // Pack the pieces greedily toward an even size.
  const n = Math.ceil(doc.length / max);
  const target = Math.ceil(doc.length / n);
  const out: string[] = [];
  let cur = '';
  for (const p of pieces) {
    if (cur && (cur.length + p.length > max || cur.length >= target)) {
      out.push(cur);
      cur = '';
    }
    cur += p;
  }
  if (cur) out.push(cur);
  return out.map((p) => p.trim());
}
