/** Hub configuration, from the environment (see packages/hub/README.md). */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const repoRoot = resolve(import.meta.dirname, '../../..');

export interface HubConfig {
  databaseUrl: string;
  /** Root of the hub's files: bundles/, events/ (materialized), site/ (served JSON), cache/. */
  dataDir: string;
  /** Bundle store directory (content-addressed). Defaults to <dataDir>/bundles. */
  bundleDir: string;
  host: string;
  port: number;
  /** Public base URL, for links in responses. */
  publicUrl: string;
  /** Admin API token (review actions over HTTP). Empty: admin API off. */
  adminToken: string;
  /** Hosted Director service tokens, `name:token` pairs, upserted at startup (scope ingest). */
  serviceTokens: Array<{ name: string; token: string }>;
  maxBundleBytes: number;
  /** Bundles waiting for intake behind the one being checked; beyond this, 429 (HUB_INTAKE_QUEUE, HUB-8). */
  intakeQueue: number;
  /** Cap on a bundle's unpacked (gunzipped) size: a small .tar.gz can expand to gigabytes. */
  maxUnpackedBytes: number;
  submissionsPerDay: number;
  /** A new contributor's first N submissions are held for review. */
  reviewFirst: number;
  /** Engine image digests accepted without a hold: the pinned one, earlier pins (deps/manifest.json) and HUB_ALLOWED_ENGINE_DIGESTS. */
  allowedEngineDigests: string[];
  /**
   * The `provenance.card_data` check (docs/CARD-OVERRIDES.md): upstream card-data.json hashes vouched for (pinnedCardData()
   * plus HUB_ALLOWED_CARD_DATA, comma-separated sha256). An event whose card data is neither one of them nor one of them
   * with this repository's override files is held for review. Empty (HUB_CHECK_CARD_DATA=0): the check is off.
   */
  cardDataUpstream: string[];
  /** Booster data for pack regeneration. */
  draftPools: string;
  unsupportedCards: string;
  boosterArchive: string;
  /** More booster archives, read-only (HUB_BOOSTER_ARCHIVE_DIRS, colon-separated): the hosted Director's own archive. */
  boosterArchiveDirs: string[];
  /** phase-rs card data (card-data.json) and the slim index derived from it, for the JSON export. */
  cardData: string;
  setsDir: string;
  methodologyPath: string;
  /** Admin bounties and switched-off computed bounty kinds (points.ts AdminBounties). */
  bountiesFile: string;
  bootstrap: number;
  /** Minimum plausible LLM decision latency (ms) and the share of faster answers that triggers a hold. */
  minLatencyMs: number;
  fastShare: number;
  corsOrigin: string;
  /**
   * Hosted-play quota defaults for contributors without their own: Private Tables (HUB_PLAY_CONCURRENT 1, HUB_PLAY_DAILY
   * 6) and, counted separately, lobby tables (HUB_LOBBY_CONCURRENT 2, HUB_LOBBY_DAILY 12). Owner decision 2026-10-22.
   */
  playConcurrent: number;
  playDaily: number;
  lobbyConcurrent: number;
  lobbyDaily: number;
  /** GitHub self-serve sign-in (empty client id or secret: off). */
  github: {
    clientId: string;
    clientSecret: string;
    /** https://github.com (tests point this at a mock). */
    oauthUrl: string;
    /** https://api.github.com */
    apiUrl: string;
    /** Refuse GitHub accounts younger than this many days (HUB_GITHUB_MIN_ACCOUNT_DAYS, default 30 as hosted; 0 = off). */
    minAccountDays: number;
  };
  /** HMAC key for the sign-in and session cookies (HUB_SESSION_SECRET; else derived from the GitHub client secret). */
  sessionSecret: string;
  /**
   * Behind a reverse proxy: client IP from X-Forwarded-For (HUB_TRUST_PROXY=1), for the rate limits; the client is
   * HUB_TRUST_PROXY_HOPS hops back (default 1: Traefik; 2 with Cloudflare proxied in front). See ratelimit.ts clientIp.
   */
  trustProxy: boolean;
  /** Usage uploads for hosted seats (POST /api/usage) per contributor (or the admin token) per hour (HUB_USAGE_UPLOADS_PER_HOUR). */
  usageUploadsPerHour: number;
  /** The nightly open-data build (docs/OPEN-DATA.md; src/open-data/schedule.ts). */
  openData: OpenDataConfig;
  /**
   * Hold bundles whose notes or deck names the content filter flags, for a reviewer (HUB_MODERATION_HOLD=1). Default
   * off: flagged text is published, never featured automatically, and waits in the review queue.
   */
  moderationHold: boolean;
  /** Hosted play and uploads need the current terms accepted (HUB_TERMS_REQUIRED=0 turns the check off, for tests). */
  termsRequired: boolean;
}

export interface OpenDataConfig {
  /** Build at all (HUB_OPEN_DATA=0 turns the schedule off; the served files stay until removed). */
  enabled: boolean;
  /** Time of the nightly build, "HH:MM" (HUB_OPEN_DATA_AT) in an IANA time zone (HUB_OPEN_DATA_TZ, the server's: America/New_York). */
  at: string;
  tz: string;
  /** The 17Lands-derived human_reference table (HUB_OPEN_DATA_HUMAN_REFERENCE=0 leaves it out). */
  humanReference: boolean;
  /** Snapshots kept: the newest N, the newest of each of M months, and a size cap over all of them. */
  keepDaily: number;
  keepMonthly: number;
  maxBytes: number;
  /** After a takedown or a contributor hiding their handle: rebuild after this delay (coalesces bursts; 0 = wait for the night). */
  privacyDelayMs: number;
  /** /data/open/ requests per IP per minute, and downloads in flight per IP. */
  ratePerMinute: number;
  concurrentPerIp: number;
}

const env = process.env;
const num = (v: string | undefined, d: number) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

/** An IANA time zone name Intl accepts, else undefined. */
export function validTimeZone(tz: string | undefined): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

export function pinnedEngineDigest(): string | undefined {
  try {
    return JSON.parse(readFileSync(join(repoRoot, 'engine/phase.lock.json'), 'utf8')).digest;
  } catch {
    return undefined;
  }
}

/**
 * Upstream card data this repository vouches for (docs/CARD-OVERRIDES.md, the `provenance.card_data` check): the pinned
 * build's card-data.json (deps/manifest.json phase_rs.data.card_data.sha256) and those of earlier pins
 * (phase_rs.history[].card_data_sha256, recorded by `npm run deps -- update phase`).
 */
export function pinnedCardData(): string[] {
  try {
    const m = JSON.parse(readFileSync(join(repoRoot, 'deps/manifest.json'), 'utf8')) as { phase_rs?: { data?: { card_data?: { sha256?: string } }; history?: Array<{ card_data_sha256?: string }> } };
    const all = [m.phase_rs?.data?.card_data?.sha256, ...(m.phase_rs?.history ?? []).map((h) => h.card_data_sha256)];
    return [...new Set(all.filter((x): x is string => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x)))];
  } catch {
    return [];
  }
}

/**
 * Engine builds this repository pinned before the current one (deps/manifest.json → phase_rs.history, appended by
 * `npm run deps -- update phase`). Events that ran on them stay accepted without a hold after an upgrade.
 */
export function previousEngineDigests(): string[] {
  try {
    const m = JSON.parse(readFileSync(join(repoRoot, 'deps/manifest.json'), 'utf8')) as { phase_rs?: { history?: Array<{ digest?: string }> } };
    return (m.phase_rs?.history ?? []).map((h) => h.digest).filter((d): d is string => typeof d === 'string' && d.startsWith('sha256:'));
  } catch {
    return [];
  }
}

export function parsePairs(raw: string | undefined): Array<{ name: string; token: string }> {
  return (raw ?? '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean).map((entry) => {
    const i = entry.indexOf(':');
    return i > 0 ? { name: entry.slice(0, i).trim(), token: entry.slice(i + 1).trim() } : { name: 'director', token: entry };
  }).filter((t) => t.token.length >= 24);
}

export function loadConfig(overrides: Partial<HubConfig> = {}): HubConfig {
  const dataDir = resolve(env.HUB_DATA_DIR ?? join(repoRoot, 'tmp', 'hub-data'));
  const engineData = env.HUB_ENGINE_DATA_DIR ?? join(repoRoot, 'data');
  const port = num(env.PORT ?? env.HUB_PORT, 8840);
  const fileOr = (v: string | undefined, file: string | undefined) => v ?? (file ? readFileSync(file, 'utf8').trim() : undefined);
  const cfg: HubConfig = {
    databaseUrl: env.DATABASE_URL ?? 'postgres://hub:hub@127.0.0.1:5440/hub',
    dataDir,
    bundleDir: resolve(env.HUB_BUNDLE_DIR ?? join(dataDir, 'bundles')),
    host: env.HOST ?? '127.0.0.1',
    port,
    publicUrl: (env.HUB_PUBLIC_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/, ''),
    adminToken: fileOr(env.HUB_ADMIN_TOKEN, env.HUB_ADMIN_TOKEN_FILE) ?? '',
    serviceTokens: parsePairs(fileOr(env.HUB_SERVICE_TOKENS, env.HUB_SERVICE_TOKENS_FILE)),
    maxBundleBytes: num(env.HUB_MAX_BUNDLE_BYTES, 25 * 1024 * 1024),
    intakeQueue: num(env.HUB_INTAKE_QUEUE, 8),
    maxUnpackedBytes: num(env.HUB_MAX_UNPACKED_BYTES, 150 * 1024 * 1024),
    submissionsPerDay: num(env.HUB_SUBMISSIONS_PER_DAY, 30),
    reviewFirst: num(env.HUB_REVIEW_FIRST, 3),
    cardDataUpstream: env.HUB_CHECK_CARD_DATA === '0' ? [] : [...new Set([...pinnedCardData(), ...(env.HUB_ALLOWED_CARD_DATA ?? '').split(',').map((s) => s.trim()).filter((s) => /^[0-9a-f]{64}$/.test(s))])],
    allowedEngineDigests: [...new Set([...(env.HUB_ALLOWED_ENGINE_DIGESTS ?? '').split(',').map((s) => s.trim()).filter(Boolean), pinnedEngineDigest(), ...previousEngineDigests()].filter((x): x is string => !!x))],
    draftPools: env.HUB_DRAFT_POOLS ?? join(engineData, 'draft-pools.json'),
    unsupportedCards: env.HUB_UNSUPPORTED_CARDS ?? join(engineData, 'unsupported-cards.json'),
    boosterArchive: env.HUB_BOOSTER_ARCHIVE ?? join(dataDir, 'booster-data'),
    boosterArchiveDirs: (env.HUB_BOOSTER_ARCHIVE_DIRS ?? '').split(':').filter(Boolean),
    cardData: env.HUB_CARD_DATA ?? join(engineData, 'card-data.json'),
    setsDir: env.HUB_SETS_DIR ?? join(repoRoot, 'sets'),
    methodologyPath: env.HUB_METHODOLOGY ?? join(repoRoot, 'docs', 'METHODOLOGY.md'),
    bountiesFile: env.HUB_BOUNTIES_FILE ?? join(repoRoot, 'packages', 'hub', 'bounties.json'),
    bootstrap: num(env.HUB_BOOTSTRAP, 1000),
    minLatencyMs: num(env.HUB_MIN_LATENCY_MS, 300),
    fastShare: num(env.HUB_FAST_SHARE, 0.1),
    corsOrigin: env.HUB_CORS_ORIGIN ?? '*',
    playConcurrent: num(env.HUB_PLAY_CONCURRENT, 1),
    playDaily: num(env.HUB_PLAY_DAILY, 6),
    lobbyConcurrent: num(env.HUB_LOBBY_CONCURRENT, 2),
    lobbyDaily: num(env.HUB_LOBBY_DAILY, 12),
    github: {
      clientId: fileOr(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_ID_FILE) ?? '',
      clientSecret: fileOr(env.GITHUB_CLIENT_SECRET, env.GITHUB_CLIENT_SECRET_FILE) ?? '',
      oauthUrl: (env.GITHUB_OAUTH_URL ?? 'https://github.com').replace(/\/+$/, ''),
      apiUrl: (env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, ''),
      // HUB-7: the same default as the hosted deployment (throwaway accounts multiply quotas).
      minAccountDays: num(env.HUB_GITHUB_MIN_ACCOUNT_DAYS, 30),
    },
    sessionSecret: fileOr(env.HUB_SESSION_SECRET, env.HUB_SESSION_SECRET_FILE) ?? '',
    trustProxy: env.HUB_TRUST_PROXY === '1' || env.HUB_TRUST_PROXY === 'true',
    usageUploadsPerHour: num(env.HUB_USAGE_UPLOADS_PER_HOUR, 30),
    openData: {
      enabled: env.HUB_OPEN_DATA !== '0' && env.HUB_OPEN_DATA !== 'false',
      at: /^([01]?\d|2[0-3]):[0-5]\d$/.test(env.HUB_OPEN_DATA_AT ?? '') ? env.HUB_OPEN_DATA_AT! : '03:30',
      tz: validTimeZone(env.HUB_OPEN_DATA_TZ) ?? 'America/New_York',
      humanReference: env.HUB_OPEN_DATA_HUMAN_REFERENCE !== '0' && env.HUB_OPEN_DATA_HUMAN_REFERENCE !== 'false',
      keepDaily: num(env.HUB_OPEN_DATA_KEEP_DAILY, 7),
      keepMonthly: num(env.HUB_OPEN_DATA_KEEP_MONTHLY, 12),
      maxBytes: num(env.HUB_OPEN_DATA_MAX_GB, 20) * 1024 ** 3,
      privacyDelayMs: num(env.HUB_OPEN_DATA_PRIVACY_DELAY_MIN, 15) * 60_000,
      ratePerMinute: num(env.HUB_OPEN_DATA_RATE_PER_MIN, 60),
      concurrentPerIp: num(env.HUB_OPEN_DATA_CONCURRENT_PER_IP, 4),
    },
    moderationHold: env.HUB_MODERATION_HOLD === '1' || env.HUB_MODERATION_HOLD === 'true',
    termsRequired: env.HUB_TERMS_REQUIRED !== '0' && env.HUB_TERMS_REQUIRED !== 'false',
    ...overrides,
  };
  return cfg;
}
