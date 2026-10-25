/**
 * API list prices per model (registry/prices.json): USD per 1M tokens, read on each provider's official pricing page.
 * Used only to estimate a seat's cost when its harness doesn't report one; estimates are always labeled as estimates.
 * Not part of registryVersion(): a price change never changes how names resolve.
 */
import pricesData from '../../../registry/prices.json' with { type: 'json' };

export interface PriceEntry {
  model: string;
  from: string; // YYYY-MM-DD, inclusive
  until?: string; // exclusive
  input: number;
  output: number;
  cache_read: number | null;
  cache_write: number | null;
  /**
   * A cache write kept for 1 hour, where the provider prices it apart from the default (shorter) write: Claude Code
   * writes 1-hour cache entries. Absent: every write pays `cache_write`.
   */
  cache_write_1h?: number | null;
  /**
   * The higher prices a request pays when its prompt is over `above` tokens, as the provider lists them. The whole
   * request is billed at these prices, not only the tokens past the threshold. Absent: one price at every size.
   */
  long_context?: LongContextPrice;
  source: string;
  checked: string;
  note?: string;
}

export interface LongContextPrice {
  /** Prompt tokens (input + cache reads + cache writes) above which a request pays these prices. */
  above: number;
  input: number;
  output: number;
  cache_read: number | null;
  cache_write: number | null;
  cache_write_1h?: number | null;
}

export interface PricesData { currency: 'USD'; unit: 'per_million_tokens'; prices: PriceEntry[] }

export const PRICES: PricesData = pricesData as unknown as PricesData;

const day = (at: number | string | Date): string => new Date(at).toISOString().slice(0, 10);

/** The list price of `model` on the day of `at` (an event's start), or null when none is recorded. */
export function priceFor(model: string, at: number | string | Date, data: PricesData = PRICES): PriceEntry | null {
  const d = day(at);
  const rows = data.prices.filter((p) => p.model === model);
  // Before the first recorded price (an event older than the model's release): use the earliest one.
  return rows.find((p) => p.from <= d && (!p.until || d < p.until)) ?? (rows.length && d < rows[0]!.from ? rows[0]! : null);
}

/** Token counts. `cache_write_1h` is the part of `cache_write` written for 1 hour (absent: none, or not known). */
export interface TokenCounts { input: number; output: number; cache_read: number; cache_write: number; cache_write_1h?: number }

/** The rates of one tier: the base price, or its long-context prices. */
type Rates = Pick<PriceEntry, 'input' | 'output' | 'cache_read' | 'cache_write' | 'cache_write_1h'>;
const usdAt = (t: TokenCounts, r: Rates): number => {
  const w = r.cache_write ?? r.input;
  const w1h = Math.min(t.cache_write_1h ?? 0, t.cache_write);
  return (t.input * r.input + t.output * r.output + t.cache_read * (r.cache_read ?? r.input) + (t.cache_write - w1h) * w + w1h * (r.cache_write_1h ?? w)) / 1e6;
};

/** A request's prompt size: everything it sent, cached or not (how providers count the long-context threshold). */
export const promptTokens = (t: TokenCounts): number => t.input + t.cache_read + t.cache_write;

/** USD of one request at list price: its prompt size picks the tier. */
export function callUsd(t: TokenCounts, p: PriceEntry): number {
  return usdAt(t, p.long_context && promptTokens(t) > p.long_context.above ? p.long_context : p);
}

/** Of each token kind, the share (0 to 1) that was in requests over the long-context threshold. */
export type LongShare = Record<Exclude<keyof TokenCounts, 'cache_write_1h'>, number> & { cache_write_1h?: number };

const KINDS = ['input', 'output', 'cache_read', 'cache_write', 'cache_write_1h'] as const;

/**
 * Estimated USD at list price. Input excludes cache reads (the harness extractors report them separately). `long` says
 * how much of each kind was in requests over the model's long-context threshold (longShare, or longShareFromTotals
 * when only totals exist); without it every token is priced at the base tier.
 */
export function estimateUsd(t: TokenCounts, p: PriceEntry, long?: LongShare): number {
  if (!p.long_context || !long) return usdAt(t, p);
  // The 1-hour writes follow the cache writes' share when their own isn't known.
  const s = (k: keyof TokenCounts) => (k === 'cache_write_1h' ? long.cache_write_1h ?? long.cache_write : long[k]);
  const part = (f: (k: keyof TokenCounts) => number): TokenCounts => ({ input: f('input'), output: f('output'), cache_read: f('cache_read'), cache_write: f('cache_write'), cache_write_1h: f('cache_write_1h') });
  return usdAt(part((k) => (t[k] ?? 0) * (1 - s(k))), p) + usdAt(part((k) => (t[k] ?? 0) * s(k)), p.long_context);
}

const ZERO: LongShare = { input: 0, output: 0, cache_read: 0, cache_write: 0 };

/** The tokens of each kind in requests over `above`, and how many requests those were (longContextSplit). */
export interface LongSplit { above: number; requests: number; input: number; output: number; cache_read: number; cache_write: number; cache_write_1h: number }

/** Sum per-request counts: all of them, and those of the requests whose prompt is over `above`. */
export function longContextSplit(calls: TokenCounts[], above: number): { total: Required<TokenCounts>; long: LongSplit } {
  const total: Required<TokenCounts> = { input: 0, output: 0, cache_read: 0, cache_write: 0, cache_write_1h: 0 };
  const long: LongSplit = { above, requests: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, cache_write_1h: 0 };
  for (const c of calls) {
    const isLong = promptTokens(c) > above;
    if (isLong) long.requests++;
    for (const k of KINDS) (total[k] += c[k] ?? 0, isLong && (long[k] += c[k] ?? 0));
  }
  return { total, long };
}

/**
 * The long-context shares from the tokens in long requests (a usage summary's `long_context`) and the totals they are
 * part of. A kind with no tokens takes the share of requests.
 */
export function shareFromSplit(t: TokenCounts, long: Omit<LongSplit, 'above'>, requests: number): LongShare {
  const r = requests ? Math.min(1, long.requests / requests) : 0;
  const share = (k: (typeof KINDS)[number]) => {
    const all = t[k] ?? 0;
    return all > 0 ? Math.min(1, (long[k] ?? 0) / all) : r;
  };
  return { input: share('input'), output: share('output'), cache_read: share('cache_read'), cache_write: share('cache_write'), cache_write_1h: share('cache_write_1h') };
}

/** The long-context shares from per-request counts (each request's own prompt size decides). */
export function longShare(calls: TokenCounts[], above: number): LongShare {
  if (!calls.length) return { ...ZERO };
  const { total, long } = longContextSplit(calls, above);
  return shareFromSplit(total, long, calls.length);
}

/**
 * The long-context shares when only a seat's totals and its number of requests are known (a usage summary). The
 * approximation: an agent's prompt grows as its conversation does, so the requests' prompt sizes are taken as spread
 * evenly from 0 to twice their mean (the mean is the seat's prompt tokens over its requests). Then the requests over
 * `above` are a share 1 - above / 2m of them, and carry a share 1 - (above / 2m)^2 of the prompt tokens. Output follows
 * the requests; the prompt kinds share one figure. A seat whose mean is over the threshold comes out mostly long, as it
 * should; compaction (a sawtooth instead of a ramp) moves the true figure by a few points either way.
 */
export function longShareFromTotals(t: TokenCounts, requests: number, above: number): LongShare {
  if (!(requests >= 1)) return { ...ZERO };
  const top = (2 * promptTokens(t)) / requests;
  if (top <= above) return { ...ZERO };
  const r = above / top;
  const prompt = 1 - r * r;
  return { input: prompt, output: 1 - r, cache_read: prompt, cache_write: prompt, cache_write_1h: prompt };
}

/** Rules the schema can't express: known model ids, windows that don't overlap. */
export function validatePrices(data: PricesData, modelIds: Set<string>): string[] {
  const errs: string[] = [];
  const by = new Map<string, PriceEntry[]>();
  for (const p of data.prices) {
    if (!modelIds.has(p.model)) errs.push(`prices: unknown model "${p.model}"`);
    if (p.until && p.until <= p.from) errs.push(`prices: ${p.model} from ${p.from} ends before it starts`);
    const lc = p.long_context;
    if (p.cache_write_1h != null && p.cache_write != null && p.cache_write_1h < p.cache_write) errs.push(`prices: ${p.model} from ${p.from} cache_write_1h is cheaper than cache_write`);
    if (lc && (lc.input < p.input || lc.output < p.output)) errs.push(`prices: ${p.model} from ${p.from} long_context is cheaper than the base price`);
    by.set(p.model, [...(by.get(p.model) ?? []), p]);
  }
  for (const [m, rows] of by) {
    const s = [...rows].sort((a, b) => a.from.localeCompare(b.from));
    for (let i = 1; i < s.length; i++) if (!s[i - 1]!.until || s[i - 1]!.until! > s[i]!.from) errs.push(`prices: ${m} windows from ${s[i - 1]!.from} and ${s[i]!.from} overlap (set "until")`);
  }
  return errs;
}
