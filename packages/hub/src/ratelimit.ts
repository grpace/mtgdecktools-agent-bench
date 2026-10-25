/** In-memory token buckets (sign-in and account rate limits). One process: no shared state needed. */
import type { IncomingMessage } from 'node:http';
import { ipKey } from '../../director/src/ratelimit.js';

export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  /** `capacity` requests, refilled evenly over `perMs`. */
  constructor(private capacity: number, private perMs: number) {}

  /** Take one token for `key`; false when the bucket is empty. */
  take(key: string, now = Date.now()): boolean {
    const rate = this.capacity / this.perMs;
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    b.tokens = Math.min(this.capacity, b.tokens + (now - b.at) * rate);
    b.at = now;
    if (this.buckets.size > 50_000) this.prune(now);
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    return true;
  }

  /** Seconds until `key` has a token again (for Retry-After). */
  retryAfter(key: string, now = Date.now()): number {
    const b = this.buckets.get(key);
    if (!b) return 0;
    const rate = this.capacity / this.perMs;
    const have = Math.min(this.capacity, b.tokens + (now - b.at) * rate);
    return have >= 1 ? 0 : Math.ceil((1 - have) / rate / 1000);
  }

  private prune(now: number): void {
    for (const [k, b] of this.buckets) if (now - b.at > this.perMs) this.buckets.delete(k);
  }
}

/** The client, as a rate-limit key: the socket peer, or the last X-Forwarded-For hop behind a trusted proxy; IPv6 by /64 (PTS-8). */
export function clientIp(req: IncomingMessage, trustProxy: boolean, hops = Number(process.env.HUB_TRUST_PROXY_HOPS ?? 1)): string {
  if (trustProxy) {
    // Each trusted proxy appends the address it saw: with Cloudflare in front of Traefik the client is 2 hops back
    // (HUB_TRUST_PROXY_HOPS=2); counting only 1 would key every visitor by Cloudflare's address.
    const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const n = Number.isInteger(hops) && hops >= 1 ? hops : 1;
    if (xff.length) return ipKey(xff[Math.max(0, xff.length - n)]!);
  }
  return ipKey(req.socket.remoteAddress ?? 'unknown');
}

/**
 * One at a time, with a short waiting line (HUB-8): intake (unpacking, checks, pack regeneration) runs on the event
 * loop, so bundles are processed one by one and `/data` serving gets the loop back between them. Beyond `maxWaiting`
 * callers, run() answers undefined at once (the HTTP layer says 429, Retry-After).
 */
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = 0;

  constructor(private maxWaiting: number) {}

  get busy(): number {
    return this.waiting;
  }

  async run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (this.waiting > this.maxWaiting) return undefined;
    this.waiting++;
    const turn = this.tail.then(fn, fn);
    this.tail = turn.catch(() => undefined);
    try {
      return await turn;
    } finally {
      this.waiting--;
    }
  }
}
