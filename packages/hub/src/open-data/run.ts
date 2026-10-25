/**
 * The open-data build job: what the nightly child process (schedule.ts) and `npm run hub -- open-data build` run.
 * It reads the Hub's database and data folder like the server does, but in its own process at low priority.
 *
 *   node --import tsx packages/hub/src/open-data/run.ts [--force]
 *
 * Skips when nothing changed since the last build (the inputs fingerprint), unless --force.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { directorVersion } from '../../../director/src/provenance.js';
import { registryVersion } from '../../../registry/src/index.js';
import { loadConfig, repoRoot, type HubConfig } from '../config.js';
import { connect, type Sql } from '../db.js';
import { Hub } from '../hub.js';
import { FsBundleStore } from '../store.js';
import { acquireLock, buildOpenData, LOG_VERSION, type BuildResult } from './build.js';
import { OPEN_DATA_LICENSE } from './license.js';
import { OPEN_DATA_SCHEMA_VERSION } from './tables.js';

export const openDataRoot = (cfg: HubConfig): string => join(cfg.dataDir, 'open-data');
export const openDataLink = (cfg: HubConfig): string => join(cfg.dataDir, 'site', 'open');

/**
 * Everything a build depends on, cheaply, from the database and the code: accepted events (and re-ingests), reviewer
 * exclusions, contributors' visibility, usage uploads, the code and registry versions, the 17Lands snapshots and the
 * contributor-key salt. Equal fingerprints: the build would publish the same data.
 */
export async function inputsFingerprint(sql: Sql, cfg: HubConfig): Promise<string> {
  const events = await sql`
    select e.id, s.bundle_sha256, s.ingested_at, e.excluded from events e join submissions s on s.id = e.submission_id order by e.id`;
  const contributors = await sql`select id, handle, status, board_visibility, moderation_hidden is not null as mod_hidden from contributors order by id`;
  const [moderation] = await sql`select count(*)::int as n, max(id)::text as last from moderation_log`;
  const usage = await sql`select event_id, seat_name, body_sha256 from seat_usage order by event_id, seat_name`;
  const manifest = join(repoRoot, 'deps', 'manifest.json');
  return createHash('sha256').update(JSON.stringify({
    events, contributors, usage, moderation,
    code: directorVersion(), log: LOG_VERSION, schema: OPEN_DATA_SCHEMA_VERSION, license: OPEN_DATA_LICENSE.id,
    human_reference: cfg.openData.humanReference, registry: registryVersion().sha256,
    deps: existsSync(manifest) ? createHash('sha256').update(readFileSync(manifest)).digest('hex') : null,
    salt: createHash('sha256').update(process.env.MTGDT_CONTRIBUTOR_SALT ?? 'mtgdt').digest('hex'),
  })).digest('hex');
}

export type RunOutcome = { status: 'built'; result: BuildResult } | { status: 'skipped'; reason: string } | { status: 'busy' };

export async function runOpenData(cfg: HubConfig, sql: Sql, opts: { force?: boolean; log?: (m: string) => void } = {}): Promise<RunOutcome> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const root = openDataRoot(cfg);
  const release = acquireLock(root);
  if (!release) return { status: 'busy' };
  try {
    const fingerprint = await inputsFingerprint(sql, cfg);
    let last: { fingerprint?: string } = {};
    try {
      last = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
    } catch {
      // first build
    }
    if (!opts.force && last.fingerprint === fingerprint && existsSync(join(openDataLink(cfg), 'latest.json'))) {
      return { status: 'skipped', reason: 'nothing changed since the last build' };
    }
    const hub = new Hub(cfg, sql, new FsBundleStore(cfg.bundleDir), log);
    await hub.load();
    const publicIds = await hub.contributors.publicIds();
    const result = await buildOpenData({
      root, siteLink: openDataLink(cfg), ctx: hub.context(undefined, publicIds), methodology: hub.methodology, url: `${cfg.publicUrl}/data/open`,
      fingerprint, humanReference: cfg.openData.humanReference,
      retention: { daily: cfg.openData.keepDaily, monthly: cfg.openData.keepMonthly, maxBytes: cfg.openData.maxBytes }, log,
    });
    return { status: 'built', result };
  } finally {
    release();
  }
}

// The child process the scheduler starts (already under nice/ionice): one build, then exit. Exit codes: 0 built or
// skipped, 75 another build holds the lock, 1 failed.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const cfg = loadConfig();
  const sql = connect(cfg.databaseUrl, 2);
  const force = process.argv.includes('--force');
  let code = 0;
  try {
    const out = await runOpenData(cfg, sql, { force });
    if (out.status === 'skipped') console.log(`open data: skipped (${out.reason})`);
    if (out.status === 'busy') {
      console.log('open data: another build is running');
      code = 75;
    }
  } catch (e) {
    console.error(`open data: build failed: ${(e as Error).stack ?? e}`);
    code = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
  process.exit(code);
}
