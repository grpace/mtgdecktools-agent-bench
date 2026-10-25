/** Test helpers: find a finished run to build bundles from, and rewrite bundles (tampering). */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { packTarGz, unpackTarGz } from '../../director/src/submissions.js';
import { bundleFromRunDir } from '../src/importer.js';
import { regenInputFromLog, regeneratePacks } from '../src/packs.js';
import { sha256 } from '../src/store.js';

export const root = resolve(import.meta.dirname, '../../..');
export const boosters = { defaultDraftPools: join(root, 'data/draft-pools.json'), defaultUnsupported: join(root, 'data/unsupported-cards.json') };
export const haveBoosterData = existsSync(boosters.defaultDraftPools);

/** True when the current generator reproduces the run's packs (skips logs from older/experimental generators). */
export function regenerates(dir: string): boolean {
  if (!haveBoosterData) return true;
  const events = readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const inp = regenInputFromLog(events);
  return !!inp && ['verified', 'partial'].includes(regeneratePacks(inp, boosters).status);
}

/**
 * A finished event folder: HUB_TEST_RUN, else the newest finished run under tmp/smoke-runs or runs/ that
 * matches `want` and that the current booster generator reproduces.
 */
export function findRun(want: (start: any) => boolean = () => true): string | undefined {
  if (process.env.HUB_TEST_RUN) return process.env.HUB_TEST_RUN;
  for (const base of [join(root, 'tmp/smoke-runs'), join(root, 'runs')]) {
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base).sort().reverse()) {
      const dir = join(base, d);
      if (!existsSync(join(dir, 'summary.json')) || !existsSync(join(dir, 'events.jsonl'))) continue;
      const start = JSON.parse(readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n', 1)[0]!);
      if (start.type === 'event_start' && start.provenance && want(start) && regenerates(dir)) return dir;
    }
  }
  return undefined;
}

export function filesOf(dir: string): Map<string, Buffer> {
  const b = bundleFromRunDir(dir);
  if ('skip' in b) throw new Error(b.skip);
  return unpackTarGz(b.gz);
}

export type Rec = Record<string, any> & { type: string };

/** Rewrite events.jsonl (and optionally summary.json) and re-hash the manifest: a "consistent" forgery. */
export function rewrite(files: Map<string, Buffer>, edit: (events: Rec[], summary: any) => void, rehash = true): Map<string, Buffer> {
  const out = new Map(files);
  const events: Rec[] = out.get('events.jsonl')!.toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const summary = JSON.parse(out.get('summary.json')!.toString('utf8'));
  edit(events, summary);
  out.set('events.jsonl', Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n'));
  out.set('summary.json', Buffer.from(JSON.stringify(summary, null, 1)));
  if (rehash) {
    const m = JSON.parse(out.get('bundle.json')!.toString('utf8'));
    m.event_id = events[0]!.id;
    for (const [n, b] of out) if (n !== 'bundle.json') m.files[n] = sha256(b);
    out.set('bundle.json', Buffer.from(JSON.stringify(m, null, 1)));
  }
  return out;
}

export const pack = (files: Map<string, Buffer>) => packTarGz(new Map([['bundle.json', files.get('bundle.json')!], ...[...files].filter(([n]) => n !== 'bundle.json')]), 0);

/**
 * Forge a better first pick: the seat at table position 0 "opened" `to` instead of the card it took first
 * in round 2. Changes packs_opened, that pick record, and the seat's deck, so the draft still replays.
 */
export function forgeFirstPick(events: Rec[], to: string): string {
  const start = events[0]!;
  const opened = events.find((e) => e.type === 'packs_opened' && e.round === 2)!;
  // The first pack-2 pick whose card appears once in its pack: with duplicates, which copy was "forged" is ambiguous
  // and the forgery stops being internally consistent (the test wants a consistent forgery that only regeneration catches).
  const seats = [...start.seats].sort((a: any, b: any) => a.position - b.position);
  let p: Rec | undefined;
  let seat0 = '';
  let position = 0;
  for (const s of seats) {
    const e = events.find((x) => x.type === 'draft_pick' && x.seat === s.name && x.pack_number === 2 && x.pick_number === 1);
    if (e && e.pack.filter((c: string) => c === e.pick).length === 1) {
      p = e;
      seat0 = s.name;
      position = s.position;
      break;
    }
  }
  if (!p) throw new Error('no pack-2 first pick with a unique card to forge');
  const from = p.pick;
  const slot = p.pack.indexOf(from);
  opened.packs[position][slot] = to;
  p.pack[slot] = to;
  p.pick = to;
  const deck = events.find((e) => e.type === 'deck_built' && e.seat === seat0);
  if (deck) {
    for (const k of ['main', 'sideboard']) {
      const i = deck[k].indexOf(from);
      if (i >= 0) {
        deck[k][i] = to;
        break;
      }
    }
  }
  return from;
}

/**
 * A log from before best of 3 with sideboarding (Early Test Data, never rated) as if played with it: event_start
 * declares sideboarding, and every seat "kept" its deck before games 2 and 3 (consistent sideboarded records), so the
 * event is rated and earns points like a current one. No-op for logs that already declare sideboarding.
 */
export function withSideboarding(events: Rec[]): void {
  const start = events[0]!;
  if (start.sideboarding === true) return;
  start.sideboarding = true;
  const decks = new Map(events.filter((e) => e.type === 'deck_built').map((d) => [d.seat as string, d]));
  for (let i = events.length - 1; i >= 0; i--) {
    const g = events[i]!;
    const m = g.type === 'game_start' ? /^(.*?)\s+—\s+game\s+(\d+)$/.exec(String(g.game)) : null;
    if (!m || Number(m[2]) < 2) continue;
    const recs = (g.seats as string[]).map((seat) => {
      const d = decks.get(seat);
      const main = (d?.main as string[]) ?? [];
      const basics: Record<string, number> = {};
      for (const c of main) if (['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes'].includes(c)) basics[c] = (basics[c] ?? 0) + 1;
      return { t: g.t, type: 'sideboarded', seat, match: m[1], game_number: Number(m[2]), by: 'agent', kept: true, in: [], out: [], main, sideboard: (d?.sideboard as string[]) ?? [], basics, main_count: main.length, latency_ms: 0 };
    });
    events.splice(i, 0, ...recs);
  }
}

