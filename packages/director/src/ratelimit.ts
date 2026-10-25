/**
 * Request limits for the hosted Director: token buckets per key (client IP, seat, contributor), and the client
 * IP behind a trusted proxy. In memory, bounded: idle buckets are dropped.
 */
import type { IncomingMessage } from 'node:http';

export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  /** `perMinute` requests per minute on average, bursts up to `burst`. */
  constructor(readonly perMinute: number, readonly burst = Math.max(1, Math.ceil(perMinute / 4)), private maxKeys = 50_000) {}

  /** Take one token for this key. Returns 0 when allowed, else the seconds until one is available. */
  take(key: string, now = Date.now()): number {
    if (!(this.perMinute > 0)) return 0;
    const rate = this.perMinute / 60_000;
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.sweep(now);
      b = { tokens: this.burst, at: now };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.burst, b.tokens + (now - b.at) * rate);
    b.at = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - b.tokens) / rate / 1000));
  }

  /** Drop buckets that have refilled completely (they behave like new ones). */
  sweep(now = Date.now()): void {
    const full = (this.burst / this.perMinute) * 60_000;
    for (const [k, b] of this.buckets) if (now - b.at > full) this.buckets.delete(k);
    // Still too many (a flood of distinct keys): forget the oldest half.
    if (this.buckets.size >= this.maxKeys) {
      const old = [...this.buckets.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, Math.floor(this.buckets.size / 2));
      for (const [k] of old) this.buckets.delete(k);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}

/**
 * The client, as a rate-limit key: the socket peer, or behind trusted proxies (TRUST_PROXY) the X-Forwarded-For
 * entry added by the outermost of `hops` proxies (TRUST_PROXY_HOPS, default 1: Traefik). IPv6 clients are keyed
 * by their /64 (one subscriber usually holds a whole /64). Only trust the header when the port is reachable
 * through the proxy alone; behind a CDN every client shares the CDN's address unless hops counts it too.
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean, hops = 1): string {
  let ip = req.socket.remoteAddress ?? 'unknown';
  if (trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const i = xff.length - Math.max(1, hops);
    if (xff.length) ip = xff[Math.max(0, i)]!;
  }
  return ipKey(ip);
}

export function ipKey(ip: string): string {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (v4) return v4[1]!;
  if (!ip.includes(':')) return ip;
  // Expand "::" and keep the first four hextets.
  const [head, tail = ''] = ip.split('%')[0]!.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${full.slice(0, 4).map((x) => x.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

export class BodyTooLarge extends Error {}

/**
 * Read a request body up to `max` bytes; BodyTooLarge beyond it, without reading the rest (callers answer 413 with
 * `Connection: close`, see tooLarge()).
 */
export async function readLimited(req: IncomingMessage, max: number): Promise<Buffer> {
  if (Number(req.headers['content-length'] ?? 0) > max) throw new BodyTooLarge(`request body larger than ${max} bytes`);
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > max) {
      // Stop reading at once (DIR-9): the connection is closed.
      req.destroy();
      throw new BodyTooLarge(`request body larger than ${max} bytes`);
    }
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Answer 413 and close the connection (the rest of the body is never read). */
export function tooLarge(res: import('node:http').ServerResponse, message: string, json = true): void {
  if (res.headersSent) return void res.destroy();
  res.writeHead(413, { 'Content-Type': json ? 'application/json' : 'text/plain', Connection: 'close' }).end(json ? JSON.stringify({ error: message }) : message);
  res.on('finish', () => res.socket?.destroy());
}
