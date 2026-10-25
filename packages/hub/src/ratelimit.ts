/** In-memory token buckets (sign-in and account rate limits). One process: no shared state needed. */
import type { IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';
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

/**
 * Cloudflare's published edge ranges (https://www.cloudflare.com/ips/, checked 2026-10-25). HUB_CLOUDFLARE_IPS
 * (comma-separated CIDRs) replaces the list if Cloudflare changes it before we do.
 */
export const CLOUDFLARE_RANGES = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];

let cloudflareList: { spec: string; list: BlockList } | undefined;

/** Whether `ip` is a Cloudflare edge address (CLOUDFLARE_RANGES, or HUB_CLOUDFLARE_IPS when set). */
export function isCloudflare(ip: string, spec = process.env.HUB_CLOUDFLARE_IPS ?? ''): boolean {
  if (cloudflareList?.spec !== spec) {
    const list = new BlockList();
    for (const cidr of spec.trim() ? spec.split(',') : CLOUDFLARE_RANGES) {
      const [net = '', bits = ''] = cidr.trim().split('/');
      const family = isIP(net);
      if (family && /^\d{1,3}$/.test(bits)) list.addSubnet(net, Number(bits), family === 6 ? 'ipv6' : 'ipv4');
    }
    cloudflareList = { spec, list };
  }
  const addr = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1] ?? ip;
  const family = isIP(addr);
  return family !== 0 && cloudflareList.list.check(addr, family === 6 ? 'ipv6' : 'ipv4');
}

/**
 * The client, as a rate-limit key: the socket peer, or the last X-Forwarded-For hop behind a trusted proxy; IPv6 by /64 (PTS-8).
 *
 * Behind Cloudflare (HUB_TRUST_CLOUDFLARE=1; HUB-32): Traefik, as Coolify runs it, trusts no forwarded headers, so it
 * drops the X-Forwarded-For Cloudflare sends and the header holds only the edge's address. Every visitor of one
 * Cloudflare location then shared a rate-limit key, so one client could lock everyone near it out of sign-in and token
 * checks. When the address our proxy saw is a Cloudflare edge, the client is Cloudflare's CF-Connecting-IP (which
 * Cloudflare sets itself). From any other address the header is ignored: the origin is reachable without Cloudflare,
 * and a direct client could otherwise pick its own key.
 */
export function clientIp(
  req: IncomingMessage,
  trustProxy: boolean,
  hops = Number(process.env.HUB_TRUST_PROXY_HOPS ?? 1),
  viaCloudflare = /^(1|true)$/.test(process.env.HUB_TRUST_CLOUDFLARE ?? ''),
): string {
  const xff = trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (viaCloudflare) {
    const peer = xff.length ? xff[xff.length - 1]! : req.socket.remoteAddress ?? '';
    const cf = String(req.headers['cf-connecting-ip'] ?? '').trim();
    if (isIP(cf) && isCloudflare(peer)) return ipKey(cf);
  }
  // Each trusted proxy appends the address it saw: with a proxy in front of Traefik that Traefik trusts, the client is
  // 2 hops back (HUB_TRUST_PROXY_HOPS=2).
  const n = Number.isInteger(hops) && hops >= 1 ? hops : 1;
  if (xff.length) return ipKey(xff[Math.max(0, xff.length - n)]!);
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
