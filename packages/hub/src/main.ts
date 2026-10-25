/**
 * Hub server: migrations, service tokens, load events, full export on start, then serve and listen for
 * changes made by other processes (the admin CLI). See packages/hub/README.md.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { connect, migrate, waitForDb } from './db.js';
import { Hub } from './hub.js';
import { startServer } from './http.js';
import { FsBundleStore } from './store.js';
import { OpenDataScheduler } from './open-data/schedule.js';
import { openDataLink } from './open-data/run.js';
import { ensureServiceTokens } from './tokens.js';
import { installLogCap } from './logsafe.js';

// Every log line is capped and terminal-safe (HUB-24): request paths, bundle text and error messages reach it.
installLogCap();

const cfg = loadConfig();
const sql = connect(cfg.databaseUrl);
await waitForDb(sql);
const applied = await migrate(sql);
if (applied.length) console.log(`migrations applied: ${applied.join(', ')}`);
await ensureServiceTokens(sql, cfg.serviceTokens);
if (!cfg.adminToken) console.warn('HUB_ADMIN_TOKEN is not set: the admin API is off (use the CLI)');
if (!existsSync(cfg.draftPools)) console.warn(`booster data not found at ${cfg.draftPools}: pack regeneration will report "unverifiable"`);

const hub = new Hub(cfg, sql, new FsBundleStore(cfg.bundleDir));
await hub.load();
await hub.listen();
// Rebuild the served tree from the index on every start (cheap; keeps it consistent with the code version).
if (process.env.HUB_EXPORT_ON_START !== '0' || !existsSync(join(hub.siteDir, 'index.json'))) hub.requestExport('full');
setInterval(() => hub.syncAll().catch((e) => console.error(`sync: ${(e as Error).message}`)), 60_000).unref();
// Seasons are calendar months (UTC): rebuild the contributor boards when one starts, even with no new table (F-4).
hub.contributors.startSeasonClock();

// The open dataset (docs/OPEN-DATA.md): built once a night in a separate low-priority process, served as static files.
const openData = new OpenDataScheduler(cfg.openData, (m) => console.log(m), () => existsSync(join(openDataLink(cfg), 'latest.json')));
hub.openData = openData;
openData.start();

const server = startServer(hub);
// Not listening (port taken, bad HOST): exit, so the container restarts with the reason in its log.
server.on('error', (err) => {
  console.error(`hub: cannot serve: ${err.message}`);
  process.exit(1);
});
// Once serving, one failed request or background task must never take the Hub down (it serves /data and the hosted
// Director's hand-offs). Logged with the full stack, so the bug stays visible. Installed only now: a failure during
// start-up (database unreachable, bad config) still exits non-zero, so the container restarts and the log says why.
process.on('unhandledRejection', (err) => console.error(`unhandled rejection: ${String((err as Error)?.stack ?? err)}`));
process.on('uncaughtException', (err) => console.error(`uncaught exception: ${String(err?.stack ?? err)}`));
console.log(`hub listening on ${cfg.host}:${cfg.port} (public ${cfg.publicUrl}); data ${cfg.dataDir}; ${cfg.allowedEngineDigests.length} allowed engine build(s)`);
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close();
    openData.stop();
    hub.contributors.stopSeasonClock();
    hub.idle().finally(() => sql.end({ timeout: 5 }).finally(() => process.exit(0)));
  });
}
