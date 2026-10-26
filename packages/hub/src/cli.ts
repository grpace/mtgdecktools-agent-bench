/**
 * Hub admin CLI. Talks to Postgres and the data directory directly; the running server picks up changes
 * through NOTIFY (or its 60 s reconcile).
 *
 *   npm run hub -- migrate
 *   npm run hub -- contributor add <handle> [--trusted] [--note text]
 *   npm run hub -- contributor ban <handle> --reason text   (suspend, exclude their events and their lobby seats' games)
 *   npm run hub -- contributor list | suspend <handle> | activate <handle> | trust <handle> | untrust <handle>
 *   npm run hub -- contributor quota <handle> [--concurrent N|default] [--daily N|default]   (Private Table quotas)
 *                 [--lobby-concurrent N|default] [--lobby-daily N|default]                    (lobby quotas, counted separately)
 *   npm run hub -- token issue <handle> [--scope submit|ingest|play|contributor] [--label text]     (prints the token once)
 *   npm run hub -- token list [<handle>] | revoke <token-id>
 *   npm run hub -- submissions [--status held|rejected|ingested|...]
 *   npm run hub -- show <submission-id>
 *   npm run hub -- approve <submission-id> [--note text] | reject <submission-id> --note text
 *   npm run hub -- exclude <event-id> --reason text | include <event-id> | takedown <event-id> --reason text [--purge]
 *   npm run hub -- import <runs-dir-or-run-folder>...        (first data: local runs/, pulled hosted runs)
 *   npm run hub -- reingest [<event-id>...]                  (all when none given)
 *   npm run hub -- export                                    (full JSON export, when no server is running)
 *   npm run hub -- points recompute [--dry-run]              (rebuild the points ledger from the accepted events)
 *   npm run hub -- points show <handle>                      (a contributor's points, rank and ledger lines)
 *   npm run hub -- open-data build [--force]                 (build the open dataset now; skips when nothing changed)
 *   npm run hub -- open-data status                          (the current build and snapshots)
 *
 * Moderation (docs/legal/CONTENT-POLICY.md; every action needs --reason and is logged with who, when and why):
 *   npm run hub -- moderation queue [--status open|kept|hidden]         flagged deck names, archetypes, rules reports and handles
 *   npm run hub -- moderation keep <flag-id> --reason text               published, never featured automatically
 *   npm run hub -- moderation hide <flag-id> --reason text               hide the flagged text, deck name or handle
 *   npm run hub -- moderation notes <event-id> [--seat s] [--grep text]  an event's deck names, archetypes and rules reports with their keys
 *   npm run hub -- moderation hide-note <event-id> <seat> <key> --reason text
 *   npm run hub -- moderation hide-deck-name <event-id> <seat> --reason text
 *   npm run hub -- moderation hide-handle|show-handle <handle> --reason text
 *   npm run hub -- moderation hides | unhide <hide-id> --reason text | log
 *   npm run hub -- contributor erase <handle> --reason text [--remove-events]   (docs/legal/PRIVACY.md "Erasure")
 *   npm run hub -- contributor terms <handle>                            whether they accepted the current terms
 */
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { connect, migrate } from './db.js';
import { Hub } from './hub.js';
import { importRuns } from './importer.js';
import { FsBundleStore } from './store.js';
import { createContributor, issueToken, maintainersId, SCOPES, type Scope } from './tokens.js';
import {
  banContributor, eraseContributor, eventNotes, hideDeckName, hideNote, listHides, moderationLog, reviewFlag, reviewQueue, scanHandle, setHandleHidden, unhide,
} from './moderation.js';
import { termsStatus } from './terms.js';
import { openDataLink, openDataRoot, runOpenData } from './open-data/run.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installLogCap } from './logsafe.js';

// What this prints (check messages, review notes, ledger notes, import logs) can hold text from bundles: terminal
// control characters are stripped, so a bundle can't drive the reviewer's terminal (HUB-24). No length cap here.
installLogCap(Number.MAX_SAFE_INTEGER);

const [cmd, ...rest] = process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    trusted: { type: 'boolean' }, note: { type: 'string' }, scope: { type: 'string', default: 'submit' }, label: { type: 'string' },
    status: { type: 'string' }, reason: { type: 'string' }, purge: { type: 'boolean' }, kind: { type: 'string', default: 'person' },
    concurrent: { type: 'string' }, daily: { type: 'string' }, 'lobby-concurrent': { type: 'string' }, 'lobby-daily': { type: 'string' }, 'dry-run': { type: 'boolean' }, force: { type: 'boolean' },
    seat: { type: 'string' }, grep: { type: 'string' }, 'remove-events': { type: 'boolean' },
  },
});
const die = (m: string): never => {
  console.error(`error: ${m}`);
  process.exit(1);
};
const cfg = loadConfig();
const sql = connect(cfg.databaseUrl, 2);
const reviewer = process.env.USER ?? 'cli';
/** Who a moderation action is logged as. */
const actor = `cli:${reviewer}`;
const needReason = (): string => (values.reason?.trim() ? values.reason.trim() : die('--reason <why> is required (it goes into the moderation log)'));

async function hub(load = true): Promise<Hub> {
  const h = new Hub(cfg, sql, new FsBundleStore(cfg.bundleDir));
  if (load) await h.load();
  return h;
}

async function contributorId(handle: string): Promise<number> {
  const [c] = await sql`select id from contributors where handle = ${handle}`;
  return c ? Number(c.id) : die(`no contributor ${handle}`);
}

async function main(): Promise<void> {
  await migrate(sql);
  switch (cmd) {
    case 'migrate':
      console.log('schema up to date');
      return;
    case 'contributor': {
      const [sub, handle] = positionals;
      if (sub === 'list') {
        const rows = await sql`
          select c.handle, c.kind, c.status, c.trust, c.github_login as github, c.play_concurrent, c.play_daily, c.lobby_concurrent, c.lobby_daily, c.created_at,
            (select count(*) from submissions s where s.contributor_id = c.id)::int as submissions,
            (select count(*) from tokens t where t.contributor_id = c.id and t.revoked_at is null)::int as tokens
          from contributors c order by c.id`;
        const q = (v: unknown, d: number) => (v == null ? `${d} (default)` : String(v));
        console.table(rows.map(({ play_concurrent, play_daily, lobby_concurrent, lobby_daily, ...r }) => ({
          ...r, github: r.github ?? '', concurrent: q(play_concurrent, cfg.playConcurrent), daily: q(play_daily, cfg.playDaily),
          lobby_concurrent: q(lobby_concurrent, cfg.lobbyConcurrent), lobby_daily: q(lobby_daily, cfg.lobbyDaily),
          created_at: new Date(r.created_at as string).toISOString().slice(0, 10),
        })));
        return;
      }
      if (!handle) die('give a handle');
      if (sub === 'quota') {
        const parse = (v: string | undefined, flag: string): number | null | undefined => {
          if (v === undefined) return undefined;
          if (v === 'default') return null;
          const n = Number(v);
          return Number.isInteger(n) && n >= 0 && n <= 1000 ? n : die(`--${flag} must be a whole number 0..1000 or "default"`);
        };
        const concurrent = parse(values.concurrent, 'concurrent');
        const daily = parse(values.daily, 'daily');
        const lobbyConcurrent = parse(values['lobby-concurrent'], 'lobby-concurrent');
        const lobbyDaily = parse(values['lobby-daily'], 'lobby-daily');
        const id = await contributorId(handle!);
        if (concurrent !== undefined) await sql`update contributors set play_concurrent = ${concurrent} where id = ${id}`;
        if (daily !== undefined) await sql`update contributors set play_daily = ${daily} where id = ${id}`;
        if (lobbyConcurrent !== undefined) await sql`update contributors set lobby_concurrent = ${lobbyConcurrent} where id = ${id}`;
        if (lobbyDaily !== undefined) await sql`update contributors set lobby_daily = ${lobbyDaily} where id = ${id}`;
        const [c] = await sql`select play_concurrent, play_daily, lobby_concurrent, lobby_daily from contributors where id = ${id}`;
        const d = (v: unknown, def: number) => (v == null ? `${def} (default)` : String(v));
        console.log(`${handle}: Private Tables ${d(c!.play_concurrent, cfg.playConcurrent)} at a time, ${d(c!.play_daily, cfg.playDaily)} per day; `
          + `lobby tables ${d(c!.lobby_concurrent, cfg.lobbyConcurrent)} at a time, ${d(c!.lobby_daily, cfg.lobbyDaily)} per day`);
        return;
      }
      if (sub === 'ban') {
        const h = await hub();
        const out = await banContributor(h, actor, handle!, needReason());
        await h.idle();
        console.log(`banned ${handle} (id ${out.contributorId}): suspended (every token stops; sign-in refused), ${out.events.length} event(s) excluded, `
          + `seats excluded at ${out.seats.length} lobby table(s); points recomputed`);
        for (const e of out.events) console.log(`  excluded ${e}`);
        for (const x of out.seats) console.log(`  ${x.event}: seats ${x.seats.join(', ')}`);
        console.log('Undo: contributor activate, then include <event> / include-seats <event> for each.');
        return;
      }
      if (sub === 'erase') {
        const h = await hub();
        const out = await eraseContributor(h, actor, handle!, needReason(), { removeEvents: !!values['remove-events'] });
        await h.idle();
        console.log(`erased contributor ${out.contributorId} (was ${handle}): ${out.anonymized.length} event(s) anonymized as ${out.anon}, ${out.removed.length} taken down`);
        console.log('Public exports are rebuilt; open data rebuilds early (the server picks this up); hosted Directors apply it within a minute.');
        return;
      }
      if (sub === 'terms') {
        const st = await termsStatus(sql, await contributorId(handle!));
        console.log(`${handle}: ${st.accepted ? 'accepted' : 'not accepted'} the current terms (${st.current}); last accepted ${st.accepted_version ?? 'never'}${st.accepted_at ? ` on ${st.accepted_at.slice(0, 10)}` : ''}`);
        return;
      }
      if (sub === 'add') {
        const id = await createContributor(sql, handle!, { kind: values.kind, trust: values.trusted ? 'trusted' : 'new', note: values.note });
        await scanHandle(sql, id, handle!);
        console.log(`contributor ${handle} (id ${id}) created${values.trusted ? ' as trusted' : '; their first submissions are held for review'}`);
        console.log(`next: npm run hub -- token issue ${handle}`);
        return;
      }
      const set: Record<string, [string, string]> = { suspend: ['status', 'suspended'], activate: ['status', 'active'], trust: ['trust', 'trusted'], untrust: ['trust', 'new'] };
      const s = set[sub ?? ''] ?? die(`unknown contributor command ${sub}`);
      await sql`update contributors set ${sql({ [s[0]]: s[1] })} where id = ${await contributorId(handle!)}`;
      console.log(`${handle}: ${s[0]} = ${s[1]}`);
      return;
    }
    case 'token': {
      const [sub, arg] = positionals;
      if (sub === 'issue') {
        if (!SCOPES.includes(values.scope as Scope)) die(`--scope ${SCOPES.join('|')}`);
        const t = await issueToken(sql, await contributorId(arg ?? die('give a handle')), values.scope as Scope, values.label);
        console.error(`token ${t.id} for ${arg} (scope ${values.scope}); shown once, stored as sha256 only:`);
        console.log(t.token);
        return;
      }
      if (sub === 'list') {
        const rows = await sql`
          select t.id, c.handle, t.scope, array_to_string(t.scopes, ',') as scopes, t.prefix, t.label, t.created_at, t.last_used_at, t.revoked_at from tokens t join contributors c on c.id = t.contributor_id
          where ${arg ?? null}::text is null or c.handle = ${arg ?? null} order by t.id`;
        console.table(rows);
        return;
      }
      if (sub === 'revoke') {
        const r = await sql`update tokens set revoked_at = now() where id = ${Number(arg)} and revoked_at is null returning id`;
        console.log(r.length ? `token ${arg} revoked` : `no active token ${arg}`);
        return;
      }
      return die(`unknown token command ${sub}`);
    }
    case 'submissions': {
      const rows = await sql`
        select s.id, s.event_id, s.status, s.label, s.via, c.handle, s.received_at, s.reasons from submissions s left join contributors c on c.id = s.contributor_id
        where ${values.status ?? null}::text is null or s.status = ${values.status ?? null} order by s.id desc limit 100`;
      for (const r of rows) {
        const reasons = ((r.reasons ?? []) as Array<{ code: string; severity: string }>).filter((x) => x.severity !== 'info').map((x) => `${x.code}:${x.severity}`);
        console.log(`${String(r.id).padStart(5)}  ${String(r.status).padEnd(9)} ${String(r.label ?? '-').padEnd(9)} ${String(r.via).padEnd(8)} ${String(r.handle ?? '').padEnd(16)} ${r.event_id ?? '-'}${reasons.length ? `  [${reasons.join(', ')}]` : ''}`);
      }
      return;
    }
    case 'show': {
      const [s] = await sql`select s.*, c.handle from submissions s left join contributors c on c.id = s.contributor_id where s.id = ${Number(positionals[0])}`;
      if (!s) die('no such submission');
      const checks = (s!.checks ?? {}) as { checks?: Array<{ id: string; outcome: string; message: string }>; regen?: unknown };
      console.log(JSON.stringify({ ...s, checks: undefined }, null, 1));
      for (const c of checks.checks ?? []) console.log(`  ${c.outcome.padEnd(12)} ${c.id.padEnd(22)} ${c.message}`);
      console.log(`  pack regeneration: ${JSON.stringify(checks.regen)}`);
      return;
    }
    case 'approve': {
      const h = await hub();
      const id = await h.approve(Number(positionals[0] ?? die('give a submission id')), reviewer, values.note);
      await h.idle();
      console.log(`approved and ingested: ${id}`);
      return;
    }
    case 'reject': {
      if (!values.note) die('--note <reason> is required');
      await (await hub(false)).rejectHeld(Number(positionals[0] ?? die('give a submission id')), reviewer, values.note!);
      console.log('rejected');
      return;
    }
    case 'include-seats': {
      const h = await hub();
      const id = positionals[0] ?? die('give an event id');
      await h.setSeatsExcluded(id, {});
      await h.idle();
      console.log(`include-seats: ${id} (no seat excluded)`);
      return;
    }
    case 'exclude':
    case 'include':
    case 'takedown': {
      const h = await hub();
      const id = positionals[0] ?? die('give an event id');
      if (cmd !== 'include' && !values.reason) die('--reason is required');
      if (cmd === 'include') await h.setExcluded(id, null);
      else if (cmd === 'exclude') await h.setExcluded(id, values.reason!);
      else await h.takedown(id, values.reason!, !!values.purge, actor);
      await h.idle();
      console.log(`${cmd}: ${id}`);
      return;
    }
    case 'moderation': {
      const [sub, a, b, c] = positionals;
      if (sub === 'queue') {
        const rows = await reviewQueue(sql, values.status ?? 'open');
        if (!rows.length) return void console.log(`no ${values.status ?? 'open'} flags`);
        for (const r of rows) {
          const where = r.kind === 'handle' ? `contributor ${r.contributor_id}` : `${r.event_id} ${r.seat} ${r.kind === 'note' ? r.item : 'deck name'}`;
          console.log(`${String(r.id).padStart(5)}  ${r.kind.padEnd(9)} ${where}  [${r.reasons.join(', ')}]\n       ${r.excerpt}`);
        }
        return;
      }
      if (sub === 'keep' || sub === 'hide') {
        const h = await hub();
        await reviewFlag(h, actor, Number(a ?? die('give a flag id')), sub, needReason());
        await h.idle();
        return void console.log(`flag ${a}: ${sub === 'keep' ? 'kept (published, not featured automatically)' : 'hidden'}`);
      }
      if (sub === 'notes') {
        const h = await hub();
        const rows = eventNotes(h, a ?? die('give an event id'), { seat: values.seat, grep: values.grep });
        for (const r of rows) console.log(`${r.seat.padEnd(14)} ${r.item.padEnd(22)} ${r.flagged.length ? `[${r.flagged.join(', ')}] ` : ''}${r.text.slice(0, 160)}`);
        return void console.log(`${rows.length} text(s). Hide one: npm run hub -- moderation hide-note ${a} <seat> <key> --reason …`);
      }
      if (sub === 'hide-note') {
        const h = await hub();
        await hideNote(h, actor, { event: a ?? die('give an event id'), seat: b ?? die('give a seat'), item: c ?? die('give the note key (moderation notes lists them)') }, needReason());
        await h.idle();
        return void console.log(`hidden: ${a} ${b} ${c}`);
      }
      if (sub === 'hide-deck-name') {
        const h = await hub();
        await hideDeckName(h, actor, { event: a ?? die('give an event id'), seat: b ?? die('give a seat') }, needReason());
        await h.idle();
        return void console.log(`hidden: the deck name of ${b} in ${a}`);
      }
      if (sub === 'hide-handle' || sub === 'show-handle') {
        const h = await hub();
        await setHandleHidden(h, actor, a ?? die('give a handle'), sub === 'hide-handle', needReason());
        await h.idle();
        return void console.log(`${a}: ${sub === 'hide-handle' ? 'handle hidden by moderators' : 'handle follows the contributor\'s own setting again'}`);
      }
      if (sub === 'hides') return void console.table(await listHides(sql));
      if (sub === 'unhide') {
        const h = await hub();
        await unhide(h, actor, Number(a ?? die('give a hide id (moderation hides)')), needReason());
        await h.idle();
        return void console.log(`hide ${a} undone`);
      }
      if (sub === 'log') {
        for (const r of (await moderationLog(sql)).reverse()) console.log(`${new Date(r.at as string).toISOString()}  ${String(r.actor).padEnd(18)} ${String(r.action).padEnd(18)} ${JSON.stringify(r.target)}  ${r.reason ?? ''}`);
        return;
      }
      return die('moderation queue|keep|hide|notes|hide-note|hide-deck-name|hide-handle|show-handle|hides|unhide|log (see the header of packages/hub/src/cli.ts)');
    }
    case 'import': {
      if (!positionals.length) die('give one or more run folders or directories of run folders');
      const h = await hub();
      const who = { contributorId: await maintainersId(sql), handle: 'maintainers', kind: 'maintainers', trust: 'trusted', tokenId: 0 };
      h.deferExports(true);
      const out = await importRuns(h, who, positionals, (m) => console.log(m));
      h.deferExports(false);
      await h.idle();
      const by = out.reduce<Record<string, number>>((m, o) => ((m[o.status] = (m[o.status] ?? 0) + 1), m), {});
      console.log(`import: ${JSON.stringify(by)}`);
      return;
    }
    case 'reingest': {
      const h = await hub();
      h.deferExports(true);
      const n = await h.reingest(positionals);
      h.deferExports(false);
      await h.idle();
      console.log(`re-ingested ${n} event(s)`);
      return;
    }
    case 'export': {
      const h = await hub();
      await h.exportNow('full');
      return;
    }
    case 'points': {
      const [sub, handle] = positionals;
      const h = await hub();
      if (sub === 'recompute') {
        const before = new Map((await sql`select contributor_id, sum(points)::int as p from points_ledger group by contributor_id`).map((r) => [Number(r.contributor_id), Number(r.p)]));
        const view = values['dry-run'] ? await h.contributors.compute() : await h.contributors.refresh();
        if (!view) die('recompute failed (see the log above)');
        const after = new Map<number, number>();
        for (const l of view!.lines) after.set(l.contributorId, (after.get(l.contributorId) ?? 0) + l.points);
        const rows = [...new Set([...before.keys(), ...after.keys()])].map((id) => ({
          handle: view!.contributors.get(id)?.handle ?? String(id), before: before.get(id) ?? 0, after: after.get(id) ?? 0,
        })).filter((r) => r.before !== r.after || values['dry-run']).sort((a, b) => b.after - a.after);
        if (rows.length) console.table(rows);
        console.log(`${view!.lines.length} ledger line(s), ${after.size} contributor(s)${values['dry-run'] ? ' (dry run: nothing written)' : '; ledger and contributors files written'}`);
        return;
      }
      if (sub === 'show') {
        if (!handle) die('give a handle');
        const view = await h.contributors.compute();
        const id = view.idByHandle(handle!) ?? die(`no contributor ${handle}`);
        const a = view.account(id);
        console.log(`${handle}: ${a.points.season} points in ${a.season.label} (rank ${a.points.rank_season ?? '-'}), ${a.points.all_time} all time (rank ${a.points.rank_all_time ?? '-'}); ${a.public ? 'public' : 'hidden'}`);
        for (const l of a.lines) console.log(`  ${new Date(l.at).toISOString().slice(0, 10)}  ${l.eventId}  ${l.seat.padEnd(14)} ${String(l.points).padStart(4)}  ${l.note}`);
        return;
      }
      die('points recompute [--dry-run] | points show <handle>');
      return;
    }
    case 'open-data': {
      const [sub] = positionals;
      if (sub === 'build') {
        // Runs here, in this process (not the server's); the lock keeps it from overlapping the nightly build.
        const out = await runOpenData(cfg, sql, { force: !!values.force });
        if (out.status === 'busy') die('another open-data build is running');
        if (out.status === 'skipped') console.log(`open data: skipped (${out.reason}; --force builds anyway)`);
        return;
      }
      if (sub === 'status') {
        const latest = join(openDataLink(cfg), 'latest.json');
        if (!existsSync(latest)) return void console.log('open data: no build yet');
        const l = JSON.parse(readFileSync(latest, 'utf8'));
        const state = JSON.parse(readFileSync(join(openDataRoot(cfg), 'state.json'), 'utf8'));
        console.log(`build ${state.build} at ${l.built_at}: ${l.events} event(s); snapshot ${l.snapshot.file} (${l.snapshot.size}); ${l.earlier_snapshots.length} earlier snapshot(s)`);
        for (const [name, t] of Object.entries(l.tables as Record<string, { rows: number; parquet: { bytes: number } }>)) console.log(`  ${name.padEnd(16)} ${String(t.rows).padStart(8)} rows  ${(t.parquet.bytes / 1024).toFixed(1)} KB parquet`);
        return;
      }
      die('open-data build [--force] | open-data status');
      return;
    }
    default:
      console.log(String(readHelp()));
  }
}

function readHelp(): string {
  return `usage: npm run hub -- <command>   (see packages/hub/README.md)
  migrate | contributor add|list|suspend|activate|trust|untrust|quota|terms|erase | token issue|list|revoke
  moderation queue|keep|hide|notes|hide-note|hide-deck-name|hide-handle|show-handle|hides|unhide|log
  submissions [--status s] | show <id> | approve <id> | reject <id> --note
  exclude|include|takedown <event-id> | import <dirs...> | reingest [ids] | export
  points recompute [--dry-run] | points show <handle> | open-data build [--force] | open-data status`;
}

main()
  .then(() => sql.end({ timeout: 5 }))
  .catch(async (e) => {
    console.error(`error: ${(e as Error).message}`);
    await sql.end({ timeout: 5 });
    process.exit(1);
  });
