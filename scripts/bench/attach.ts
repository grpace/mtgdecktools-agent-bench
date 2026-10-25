/**
 * `bench attach-logs <event> [--seat X]`: for seats you started by hand (T3 Code, Claude Desktop, Codex, OpenCode,
 * Cursor, Antigravity and other MCP clients), find the harness session that played each seat in this machine's
 * harness stores and keep what verifies its model and effort: model ids, effort levels, fast mode, harness version
 * and token counts. Never prompts, reasoning, tool output, titles or paths.
 *
 * The scan and the matching are packages/director/src/harness-logs.ts (`attachHarnessLogs`): a session belongs to
 * a seat when it contains decision text only that seat was shown. It writes harness-logs-<seat>.json next to the
 * event log, and `bench bundle` turns it into the seat's usage-<seat>.json.
 *
 * It always asks first, listing the folders it will read (--yes skips the question; --agent answers in JSON with
 * the list and the command to run once the person agrees).
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { attachHarnessLogs } from '../../packages/director/src/harness-logs.js';
import { registry } from '../../packages/registry/src/index.js';
import { BENCH, VERSION, contributorToken, die, directorUrl, eventDir, isLoopback, loadEvent, requireTls, tilde } from './core.js';
import { handedToHub, readByAttach, seatsWithUsage, uploadHostedUsage } from './usage-upload.js';

/** Folders in `d`, following symlinks (a ~/.claude-accounts/<name> is often a link). */
const subdirs = (d: string) => {
  try {
    return readdirSync(d).map((n) => join(d, n)).filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
};

/**
 * Other events in the same runs folder that started within 12 hours of this one: a session that also holds their
 * decision text played (or watched) another event, so it can't be this seat's own (harness-logs.ts).
 */
export function nearbyEvents(dir: string, t0: number, windowMs = 12 * 3600_000, max = 20): string[] {
  const out: Array<{ d: string; dt: number }> = [];
  for (const d of subdirs(dirname(dir))) {
    if (d === dir) continue;
    try {
      const st = statSync(join(d, 'events.jsonl'));
      if (Math.abs(st.mtimeMs - t0) > windowMs + 24 * 3600_000) continue;
      const first = JSON.parse(readFileSync(join(d, 'events.jsonl'), 'utf8').split('\n', 1)[0] ?? '');
      if (first?.type === 'event_start' && typeof first.t === 'number' && Math.abs(first.t - t0) <= windowMs) out.push({ d, dt: Math.abs(first.t - t0) });
    } catch {
      // not an event folder
    }
  }
  return out.sort((a, b) => a.dt - b.dt).slice(0, max).map((x) => x.d);
}

/** The harness store folders the scan may read on this machine (the ones that exist), for the question. */
export function storeDirs(home = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = [
    env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, 'projects') : '', join(home, '.claude', 'projects'),
    ...subdirs(join(home, '.claude-accounts')).map((d) => join(d, 'projects')),
    env.CODEX_HOME ? join(env.CODEX_HOME, 'sessions') : '', join(home, '.codex', 'sessions'),
    env.XDG_DATA_HOME ? join(env.XDG_DATA_HOME, 'opencode') : '', join(home, '.local', 'share', 'opencode'),
    join(home, '.cursor', 'projects'),
    join(home, '.t3', 'userdata', 'providers', 'antigravity'), join(home, '.gemini', 'antigravity-cli', 'conversations'),
    join(home, '.t3', 'userdata', 'logs', 'provider'),
  ];
  return [...new Set(dirs.filter((d) => d && existsSync(d)))];
}

/** The seats started by hand: agent seats without a transcript from `bench play` in this folder. */
export function handSeated(dir: string, start: { seats?: Array<{ name: string; kind: string }> }): string[] {
  return (start.seats ?? []).filter((s) => s.kind === 'agent' && !/^(rand|bot-|bot$|random)/i.test(s.name))
    .map((s) => String(s.name)).filter((n) => !existsSync(join(dir, `transcript-${n}.jsonl`)));
}

/** The question, in words: which seats, which folders, what is kept. */
export function scanQuestion(seats: string[], dirs: string[], clients: string[]): string {
  return `To verify the model and effort of ${seats.join(', ')}, this reads the session logs ${clients.length ? `your ${clients.join(' / ')} sessions` : 'your harnesses'} left on this machine during the event, in:\n` +
    `${dirs.map((d) => `  ${tilde(d)}`).join('\n') || '  (none of the usual folders exist here)'}\n` +
    'Only the model, effort, fast mode, harness version and token counts are kept; no conversation text, title or path is copied.';
}

async function ask(q: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise<string>((r) => rl.question(q, r));
  rl.close();
  return /^y/i.test(a.trim());
}

export async function cmdAttachLogs(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: { seat: { type: 'string', multiple: true }, yes: { type: 'boolean', short: 'y' }, agent: { type: 'boolean' }, director: { type: 'string' }, token: { type: 'string' } },
  });
  const dir = eventDir(positionals[0]);
  const ev = loadEvent(dir);
  const id = basename(dir);
  // The event log (the scan matches on the decision texts in it): pull it from the Director when it isn't here yet.
  const logFile = join(dir, 'events.jsonl');
  if (!existsSync(logFile)) {
    const base = directorUrl(values.director, ev);
    const tok = isLoopback(base) && !ev.hosted ? undefined : contributorToken(values.token, base);
    if (tok) requireTls(base);
    const r = await fetch(`${base}/api/events/${id}/files/events.jsonl`, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} }).catch(() => undefined);
    if (!r?.ok) die(`no event log for ${id} here, and the Director didn't give it (${r?.status ?? 'unreachable'}): wait for the event to end, then try again`);
    writeFileSync(logFile, Buffer.from(await r!.arrayBuffer()), { mode: 0o600 });
  }
  let start: any;
  try {
    start = JSON.parse(readFileSync(logFile, 'utf8').split('\n', 1)[0] ?? '');
  } catch {
    die(`${tilde(logFile)} doesn't start with event_start`);
  }
  const all = handSeated(dir, start);
  const seats = values.seat?.length ? values.seat.filter((s) => all.includes(s)) : all;
  if (!seats.length) {
    // Hosted: (re)send the usage of the seats `bench play` started (e.g. the Hub didn't have the event yet then).
    const sendable = handedToHub(ev) ? seatsWithUsage(dir, ev).filter((s) => !values.seat?.length || values.seat.includes(s)) : [];
    if (sendable.length) {
      const sent = await uploadHostedUsage(dir, ev, sendable, { readBy: readByAttach(), token: values.token, waitMs: 60_000, quiet: values.agent });
      if (values.agent) console.log(JSON.stringify({ step: 'uploaded', event: id, seats: sent }, null, 1));
      return;
    }
    console.log(values.seat?.length
      ? `${values.seat.join(', ')}: not a seat started by hand here (seats \`${BENCH} play\` started already have their usage).`
      : `Every seat of ${id} on this machine was started by \`${BENCH} play\`, so its usage is already recorded. Nothing to attach.`);
    return;
  }
  const dirs = storeDirs();
  const clients = [...new Set(seats.map((s) => {
    const h = (start.seats ?? []).find((x: any) => x.name === s)?.harness ?? ev.meta?.[s]?.harness;
    return h ? registry.harnessDisplay(h) : '';
  }).filter(Boolean))];
  const cmd = `${BENCH} attach-logs ${id}${values.seat?.length ? seats.map((s) => ` --seat ${s}`).join('') : ''} --yes`;
  if (!values.yes) {
    const text = scanQuestion(seats, dirs, clients);
    if (values.agent) {
      console.log(JSON.stringify({ step: 'confirm_scan', event: id, seats, directories: dirs, text, next: cmd, instructions: 'Show the person `text` and ask whether to go ahead. Run `next` only after they say yes.' }, null, 1));
      return;
    }
    console.log(text);
    if (!(await ask('Go ahead? [y/N] '))) {
      console.log(`Nothing read. Run \`${cmd}\` to do it later.`);
      return;
    }
  }
  const found = attachHarnessLogs(dir, { seats, otherEvents: nearbyEvents(dir, typeof start?.t === 'number' ? start.t : Date.now()), readBy: `bench attach-logs ${VERSION}` });
  const out: Record<string, unknown> = {};
  for (const r of found) {
    const ok = r.facts.length > 0;
    out[r.seat] = ok ? { sessions: r.facts.length, model_ids: r.model_ids, effort: r.effort_reported?.level ?? null, harness_version: r.harness_version ?? null } : null;
    if (values.agent) continue;
    if (!ok) {
      const why = r.rejected?.length ? ` (${r.rejected.length} session${r.rejected.length === 1 ? '' : 's'} set aside: ${[...new Set(r.rejected.map((x) => x.reason))].join(', ')})` : '';
      console.log(`seat ${r.seat}: no session found${r.snippets ? '' : ' (the log has no decision text to match on)'}${why}. Its model stays Self-Reported.`);
      continue;
    }
    const models = r.model_ids.map((m) => {
      const x = registry.resolveModel(m);
      return x.ok ? registry.modelDisplay(x.id) : m;
    });
    console.log(`seat ${r.seat}: ${r.facts.length} session${r.facts.length === 1 ? '' : 's'} found; model ${models.join(', ') || '?'}${r.effort_reported?.level ? `, effort ${r.effort_reported.level}` : ''}${r.harness_version ? `, version ${r.harness_version}` : ''}.`);
  }
  // Hosted: the Hub gets the facts now (the Director handed it the event without harness logs).
  const hosted = handedToHub(ev);
  const foundSeats = found.filter((r) => r.facts.length > 0).map((r) => r.seat);
  if (!values.agent) console.log('');
  const uploaded = hosted && foundSeats.length ? await uploadHostedUsage(dir, ev, foundSeats, { readBy: readByAttach(), token: values.token, waitMs: 60_000, quiet: values.agent }) : {};
  if (values.agent) {
    console.log(JSON.stringify({ step: 'attached', event: id, seats: out, ...(hosted ? { uploaded } : {}) }, null, 1));
    return;
  }
  console.log(hosted
    ? `Saved next to the event on this machine (harness-logs-<seat>.json).`
    : `Saved next to the event (harness-logs-<seat>.json). Next: ${BENCH} bundle ${id} (the bundle carries these facts), then ${BENCH} submit <bundle>.`);
}
