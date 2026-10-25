/** Postgres access (the `postgres` client) and plain-SQL migrations run at startup. */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import postgres from 'postgres';

export type Sql = postgres.Sql<Record<string, unknown>>;

export const migrationsDir = resolve(import.meta.dirname, '..', 'migrations');

/** A UTF-16 surrogate without its pair (not valid Unicode text). */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * A value Postgres can store (HUB-22). Postgres refuses NUL in text and jsonb, and lone UTF-16 surrogates in jsonb
 * (JSON.stringify writes them as `\ud800` escapes); agent-written text (notes, deck names, rules reports) from a bundle
 * can carry both, and one such string made a whole event's ingest fail on every retry. Strings lose NUL and get
 * U+FFFD for lone surrogates; arrays and plain objects are cleaned deeply (keys too); anything else is unchanged.
 */
export function pgSafe<T>(v: T): T {
  if (typeof v === 'string') return v.replace(/\u0000/g, '').replace(LONE_SURROGATE, '\ufffd') as T;
  if (Array.isArray(v)) return v.map(pgSafe) as T;
  if (v && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v))) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[pgSafe(k)] = pgSafe(x);
    return out as T;
  }
  return v;
}

export function connect(url: string, max = 5): Sql {
  return postgres(url, {
    max, onnotice: () => {}, idle_timeout: 30, connect_timeout: 15,
    // Every text, varchar and json(b) parameter goes through pgSafe (HUB-22). Serializers only: parsing is unchanged.
    types: {
      safeText: { to: 25, from: [], serialize: (x: unknown) => pgSafe(String(x)), parse: (x: string) => x },
      safeVarchar: { to: 1043, from: [], serialize: (x: unknown) => pgSafe(String(x)), parse: (x: string) => x },
      safeJson: { to: 114, from: [], serialize: (x: unknown) => JSON.stringify(pgSafe(x)), parse: (x: string) => JSON.parse(x) },
      safeJsonb: { to: 3802, from: [], serialize: (x: unknown) => JSON.stringify(pgSafe(x)), parse: (x: string) => JSON.parse(x) },
    },
  }) as unknown as Sql;
}

/**
 * Apply migrations/NNN_name.sql in order, each in its own transaction under an advisory lock, so two hub
 * processes starting together don't race. Applied versions are recorded in schema_migrations.
 */
export async function migrate(sql: Sql, dir = migrationsDir): Promise<string[]> {
  await sql`create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())`;
  const files = readdirSync(dir).filter((f) => /^\d+_[\w-]+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  for (const f of files) {
    const version = f.replace(/\.sql$/, '');
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('mtgdt-hub-migrate'))`;
      const done = await tx`select 1 from schema_migrations where version = ${version}`;
      if (done.length) return;
      await tx.unsafe(readFileSync(join(dir, f), 'utf8'));
      await tx`insert into schema_migrations (version) values (${version})`;
      applied.push(version);
    });
  }
  return applied;
}

/** Wait for the database to accept connections (container start-up). */
export async function waitForDb(sql: Sql, seconds = 60): Promise<void> {
  const until = Date.now() + seconds * 1000;
  for (;;) {
    try {
      await sql`select 1`;
      return;
    } catch (e) {
      if (Date.now() > until) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
