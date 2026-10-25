/** Contributor and service tokens: random, shown once, stored as sha256 only. */
import { randomBytes } from 'node:crypto';
import type { Sql } from './db.js';
import { sha256 } from './store.js';
import { asksTerms, TERMS_VERSION } from './terms.js';

/**
 * Token kinds. `submit`: POST /api/submissions; `ingest`: hosted Directors (hand-off, introspection);
 * `play`: create events on a hosted Director; `contributor`: issued at GitHub sign-in, scopes {submit, play}.
 */
export type Scope = 'submit' | 'ingest' | 'play' | 'contributor';
/** What a token can be used for (authenticate checks these). */
export type Permission = 'submit' | 'ingest' | 'play';

export const SCOPES: Scope[] = ['submit', 'ingest', 'play', 'contributor'];
const PREFIX: Record<Scope, string> = { submit: 'sub', ingest: 'ing', play: 'ply', contributor: 'con' };

/** The permissions a token kind carries. */
export function scopesOf(scope: Scope): Permission[] {
  return scope === 'contributor' ? ['submit', 'play'] : [scope];
}

export function newToken(scope: Scope): string {
  return `mtgdt_${PREFIX[scope]}_${randomBytes(30).toString('base64url')}`;
}

export interface Principal {
  contributorId: number;
  handle: string;
  kind: string;
  trust: string;
  tokenId: number;
}

export function bearer(header: string | undefined): string {
  return (header ?? '').replace(/^Bearer\s+/i, '').trim();
}

/** Resolve a bearer token carrying the given permission to an active contributor, or null. */
export async function authenticate(sql: Sql, token: string, scope: Permission): Promise<Principal | null> {
  if (!token || token.length < 24 || token.length > 200) return null;
  const rows = await sql`
    select t.id as token_id, c.id, c.handle, c.kind, c.trust
    from tokens t join contributors c on c.id = t.contributor_id
    where t.token_sha256 = ${sha256(token)} and ${scope} = any(t.scopes) and t.revoked_at is null and c.status = 'active'`;
  const r = rows[0];
  if (!r) return null;
  await sql`update tokens set last_used_at = now() where id = ${r.token_id as number}`;
  return { contributorId: Number(r.id), handle: String(r.handle), kind: String(r.kind), trust: String(r.trust), tokenId: Number(r.token_id) };
}

export async function createContributor(sql: Sql, handle: string, opts: { kind?: string; trust?: string; note?: string } = {}): Promise<number> {
  const [r] = await sql`
    insert into contributors (handle, kind, trust, note) values (${handle}, ${opts.kind ?? 'person'}, ${opts.trust ?? 'new'}, ${opts.note ?? null})
    returning id`;
  return Number(r!.id);
}

export async function issueToken(sql: Sql, contributorId: number, scope: Scope, label?: string, token = newToken(scope)): Promise<{ id: number; token: string }> {
  const [r] = await sql`
    insert into tokens (contributor_id, scope, scopes, token_sha256, prefix, label)
    values (${contributorId}, ${scope}, ${scopesOf(scope)}, ${sha256(token)}, ${token.slice(0, 14)}, ${label ?? null})
    returning id`;
  return { id: Number(r!.id), token };
}

/** Make sure the configured hosted-Director service tokens exist (idempotent; hashes only). */
export async function ensureServiceTokens(sql: Sql, tokens: Array<{ name: string; token: string }>): Promise<void> {
  for (const t of tokens) {
    const handle = `director-${t.name}`.toLowerCase().replace(/[^a-z0-9_.-]/g, '-').slice(0, 40);
    const [c] = await sql`
      insert into contributors (handle, kind, trust, note) values (${handle}, 'director', 'trusted', 'hosted Director (HUB_SERVICE_TOKENS)')
      on conflict (handle) do update set kind = 'director' where contributors.github_id is null returning id`;
    // A GitHub account holding this handle must never receive a service token.
    if (!c) throw new Error(`handle ${handle} belongs to a GitHub account; rename the service token (HUB_SERVICE_TOKENS)`);
    const exists = await sql`select 1 from tokens where token_sha256 = ${sha256(t.token)}`;
    if (!exists.length) await issueToken(sql, Number(c!.id), 'ingest', 'HUB_SERVICE_TOKENS', t.token);
  }
}

/** The account imports and admin runs are filed under (created on demand; never shown publicly). */
export async function maintainersId(sql: Sql): Promise<number> {
  const [c] = await sql`
    insert into contributors (handle, kind, trust, note) values ('maintainers', 'maintainers', 'trusted', 'imports and maintainer runs')
    on conflict (handle) do update set kind = 'maintainers' where contributors.github_id is null returning id`;
  if (!c) throw new Error('the handle "maintainers" belongs to a GitHub account');
  return Number(c.id);
}

export interface PlayQuotaDefaults {
  /** Private Tables. */
  concurrent: number;
  daily: number;
  /** Lobby tables, counted separately (absent: the same as Private Tables, for older callers). */
  lobbyConcurrent?: number;
  lobbyDaily?: number;
}

export type Introspection =
  | { active: false }
  | {
    active: true;
    contributor: { id: number; handle: string; kind: string; trust: string; github_login: string | null };
    /** The contributor's leaderboard setting (null: follow their lobby choice); the Director's lobby honors it (LOB-3). */
    board_visibility: 'public' | 'hidden' | null;
    scopes: string[];
    token_id: number;
    token_prefix: string;
    /** play_*: Private Tables; lobby_*: lobby tables, counted separately (a hosted Director enforces both). */
    quotas: { play_concurrent: number; play_daily: number; lobby_concurrent: number; lobby_daily: number };
    /**
     * The contributor's acceptance of the current terms (src/terms.ts). A hosted Director refuses new tables while
     * `accepted` is false, with `message`. Admin and service accounts are never asked (accepted: true).
     */
    terms: { current: string; accepted_version: string | null; accepted: boolean; message?: string };
  };

/**
 * What a hosted Director needs to know about a contributor token (POST /api/internal/tokens/introspect): who it
 * belongs to, what it may do, the contributor's hosted-play quotas and leaderboard visibility. Unknown, revoked or
 * suspended tokens, and tokens without the required permission (`play` unless asked otherwise), are inactive (HUB-17).
 */
export async function introspect(sql: Sql, token: string, defaults: PlayQuotaDefaults, required: Permission = 'play', terms: { required: boolean; message?: (accepted: string | null) => string } = { required: true }): Promise<Introspection> {
  if (!token || token.length < 24 || token.length > 200) return { active: false };
  const [r] = await sql`
    select t.id as token_id, t.prefix, t.scopes, c.id, c.handle, c.kind, c.trust, c.github_login, c.play_concurrent, c.play_daily, c.lobby_concurrent, c.lobby_daily, c.board_visibility,
           c.moderation_hidden, c.terms_version
    from tokens t join contributors c on c.id = t.contributor_id
    where t.token_sha256 = ${sha256(token)} and t.revoked_at is null and c.status = 'active' and ${required} = any(t.scopes)`;
  if (!r) return { active: false };
  await sql`update tokens set last_used_at = now() where id = ${r.token_id as number}`;
  const acceptedVersion = (r.terms_version as string | null) ?? null;
  const accepted = !terms.required || !asksTerms(String(r.kind)) || acceptedVersion === TERMS_VERSION;
  return {
    active: true,
    contributor: { id: Number(r.id), handle: String(r.handle), kind: String(r.kind), trust: String(r.trust), github_login: (r.github_login as string | null) ?? null },
    // A handle moderators hid is hidden whatever the contributor chose (moderation.ts setHandleHidden).
    board_visibility: r.moderation_hidden != null ? 'hidden' : r.board_visibility === 'public' || r.board_visibility === 'hidden' ? r.board_visibility : null,
    scopes: (r.scopes as string[]) ?? [],
    token_id: Number(r.token_id),
    token_prefix: String(r.prefix),
    quotas: {
      play_concurrent: r.play_concurrent == null ? defaults.concurrent : Number(r.play_concurrent),
      play_daily: r.play_daily == null ? defaults.daily : Number(r.play_daily),
      lobby_concurrent: r.lobby_concurrent == null ? defaults.lobbyConcurrent ?? defaults.concurrent : Number(r.lobby_concurrent),
      lobby_daily: r.lobby_daily == null ? defaults.lobbyDaily ?? defaults.daily : Number(r.lobby_daily),
    },
    terms: { current: TERMS_VERSION, accepted_version: acceptedVersion, accepted, ...(!accepted && terms.message ? { message: terms.message(acceptedVersion) } : {}) },
  };
}

/**
 * Leaderboard visibility of contributors, for a hosted Director's lobby (POST /api/internal/contributors/visibility):
 * id → 'public' | 'hidden' | null (null: follow the lobby choice). Unknown ids are left out. Suspended and erased
 * contributors, and handles moderators hid, are 'hidden' (they have no public presence).
 */
export async function visibilityOf(sql: Sql, ids: number[]): Promise<Record<string, 'public' | 'hidden' | null>> {
  const want = [...new Set(ids.filter((x) => Number.isSafeInteger(x) && x > 0))].slice(0, 5000);
  if (!want.length) return {};
  const rows = await sql`select id, status, board_visibility, moderation_hidden from contributors where id in ${sql(want)}`;
  return Object.fromEntries(rows.map((r) => [String(r.id), r.status !== 'active' || r.moderation_hidden != null ? 'hidden' : r.board_visibility === 'public' || r.board_visibility === 'hidden' ? r.board_visibility : null]));
}
