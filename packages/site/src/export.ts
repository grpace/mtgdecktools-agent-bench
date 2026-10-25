/**
 * Writing the JSON export (docs/SITE-DATA.md): the full tree for `npm run site:data`, or just the files one
 * event touches, for the Hub's incremental export. Both go through the same functions so the trees match.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, type Ctx } from './context.js';
import type { EventData } from './data.js';
import { readCurated } from './highlights.js';
import { JsonBuilder } from './json.js';

/** Receives each file of the export: a relative path and a value (strings are written as-is). */
export type WriteFn = (path: string, data: unknown) => void;

/**
 * 2.10 renamed every British-spelled key to US spelling (new key → old key). For one release every file also carries
 * the old keys, with the same values, next to the new ones (docs/SITE-DATA.md "Deprecated keys"); they go with
 * schema_version 3.
 */
export const DEPRECATED_KEYS: Readonly<Record<string, string>> = { colors: 'colours', open_colors: 'open_colours' };

/** A copy of an export value with the deprecated keys added next to their new names (JSON values only). */
export function withDeprecatedKeys<T>(data: T): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v === null || typeof v !== 'object') return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      out[k] = walk(x);
      const old = DEPRECATED_KEYS[k];
      if (old && !(old in v)) out[old] = out[k];
    }
    return out;
  };
  return walk(data) as T;
}

/** What a writer puts on disk for a value: strings as-is, everything else as JSON with the deprecated keys. */
export const serialize = (data: unknown): string => (typeof data === 'string' ? data : JSON.stringify(withDeprecatedKeys(data)));

export interface MethodologyDoc { text: string; file: string; sha256: string }

/** docs/METHODOLOGY.md, shipped next to the numbers as methodology.md. */
export function readMethodology(path: string): MethodologyDoc | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  return { text, file: 'methodology.md', sha256: createHash('sha256').update(text).digest('hex') };
}

/** highlights/curated.json at the repo root (2.8): hand-curated highlights. */
export const CURATED_HIGHLIGHTS = join(repoRoot, 'highlights', 'curated.json');

export function builder(ctx: Ctx, methodology: MethodologyDoc | null, curatedPath: string = CURATED_HIGHLIGHTS): JsonBuilder {
  return new JsonBuilder(ctx, methodology ? { file: methodology.file, sha256: methodology.sha256 } : null, readCurated(curatedPath));
}

/** Relative paths of every file that belongs to one event (event file, drafts, games). */
export function eventFilePaths(b: JsonBuilder, ev: EventData): string[] {
  return [`events/${ev.id}.json`, ...b.draftSeats(ev).map((s) => `events/${ev.id}/draft-${s}.json`), ...ev.games.map((g) => `events/${ev.id}/game-${g.index}.json`)];
}

export function writeEvent(b: JsonBuilder, ev: EventData, write: WriteFn): void {
  write(`events/${ev.id}.json`, b.event(ev));
  for (const seat of b.draftSeats(ev)) write(`events/${ev.id}/draft-${seat}.json`, b.draft(ev, seat));
  for (const g of ev.games) write(`events/${ev.id}/game-${g.index}.json`, b.game(ev, g));
}

export function writeSet(b: JsonBuilder, code: string, write: WriteFn): void {
  write(`sets/${code.toUpperCase()}.json`, b.set(code.toUpperCase()));
}

export function writeIndex(b: JsonBuilder, methodology: MethodologyDoc | null, write: WriteFn): void {
  const idx = b.index();
  write('index.json', idx);
  // 2.9: the small file for Home, Watch and Learn (index.json carries every board).
  write('summary.json', b.summaryOf(idx));
  if (methodology) write('methodology.md', methodology.text);
  writeDerived(b, write);
}

/** Relative paths of the files derived from every event (model files, highlights): rewritten with the index. */
export function derivedFilePaths(b: JsonBuilder): string[] {
  return ['highlights.json', ...b.models().map(([id]) => `models/${id}.json`)];
}

/** 2.8: models/<model_id>.json and highlights.json. They depend on every event, so write them whenever index.json is. */
export function writeDerived(b: JsonBuilder, write: WriteFn): void {
  for (const [id, f] of b.models()) write(`models/${id}.json`, f);
  write('highlights.json', b.highlightsFile());
}

/** The whole tree. */
export function writeAll(ctx: Ctx, b: JsonBuilder, methodology: MethodologyDoc | null, write: WriteFn): void {
  writeIndex(b, methodology, write);
  for (const ev of ctx.events) writeEvent(b, ev, write);
  for (const code of ctx.sets) writeSet(b, code, write);
}
