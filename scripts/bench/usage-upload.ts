/**
 * After a hosted event: send the Hub the usage summary of every seat this machine started (`bench play`) or whose
 * session it found (`bench attach-logs`), so those seats can be Checked Against Logs. The hosted Director never sees
 * harness logs; this is how they reach the Hub (packages/hub/src/usage-uploads.ts).
 *
 * Only the model ids, token counts, the logged effort and the harness version go out (the closed format in
 * packages/director/src/usage-upload.ts), never prompts, transcripts or paths. Seats this contributor didn't seat are
 * refused by the Hub. The contributor token (`bench login`) is used for tables you created or joined; tables created on
 * the hosted Director with its admin token use the Hub admin token (HUB_ADMIN_TOKEN, or ~/.config/mtgdt/hub-admin-token),
 * and only if you have it. Your own tables (`bench up`) don't use this: their bundle carries the usage files.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readEventStart } from '../../packages/director/src/bundle.js';
import { SEAT_KEYS_V1, seatUploadFromRun, USAGE_UPLOAD_VERSION, type UploadSeat, type UsageUpload } from '../../packages/director/src/usage-upload.js';
import { BENCH, contributorToken, env, hubUrl, isLoopback, readIf, sleep, tilde, trustedOrigin, VERSION, type LocalEvent } from './core.js';

/** Whether the event ran on a hosted Director that hands its events to the Hub (not this machine, not a community one). */
export function handedToHub(ev: LocalEvent): boolean {
  if (!ev.director || isLoopback(ev.director)) return false;
  return trustedOrigin(ev.director);
}

/** The Hub admin token, for tables created with the hosted Director's admin token: only ever sent to an official Hub. */
export function hubAdminToken(hub: string, e: NodeJS.ProcessEnv = env, home = homedir()): string | undefined {
  if (!trustedOrigin(hub)) return undefined;
  return e.HUB_ADMIN_TOKEN || readIf(join(home, '.config/mtgdt/hub-admin-token')) || undefined;
}

/** The seats' summaries this machine has, with each seat's declaration as the event recorded it. */
export function usageBody(dir: string, ev: LocalEvent, seats: string[], readBy: string): { body: UsageUpload; missing: string[] } {
  const start: any = readEventStart(dir);
  const declared = (seat: string) => {
    const s = (start?.seats ?? []).find((x: any) => x?.name === seat);
    return s ? { harness: s.harness, model: s.model_declared ?? s.model, effort: s.effort_declared ?? s.effort } : ev.meta?.[seat] ?? {};
  };
  const out: UploadSeat[] = [];
  const missing: string[] = [];
  for (const seat of seats) {
    const s = seatUploadFromRun(dir, seat, declared(seat), readBy, typeof start?.t === 'number' ? start.t : undefined);
    if (s) out.push(s);
    else missing.push(seat);
  }
  return { body: { version: USAGE_UPLOAD_VERSION, event_id: ev.id, seats: out }, missing };
}

export interface SendResult { ok: boolean; status: number; body: any; attempts: number; legacy?: boolean }

/** The body with only the fields a Hub before the per-request fields knows (it refuses unknown keys). */
export function legacyBody(body: UsageUpload): UsageUpload {
  const keep = new Set<string>(SEAT_KEYS_V1);
  return { ...body, seats: body.seats.map((s) => Object.fromEntries(Object.entries(s).filter(([k]) => keep.has(k))) as unknown as UploadSeat) };
}

/**
 * POST /api/usage. The hosted Director hands the event to the Hub as it ends, so the Hub may not have it yet: 404 (and
 * 429) are retried until `waitMs` has passed; anything else is final.
 */
export async function sendUsage(hub: string, token: string, body: UsageUpload, opts: { waitMs?: number; retryMs?: number; fetchImpl?: typeof fetch; legacy?: boolean } = {}): Promise<SendResult> {
  const f = opts.fetchImpl ?? fetch;
  const deadline = Date.now() + (opts.waitMs ?? 5 * 60_000);
  for (let attempts = 1; ; attempts++) {
    let status = 0;
    let parsed: any = {};
    try {
      const r = await f(`${hub}/api/usage`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
      });
      status = r.status;
      parsed = await r.json().catch(() => ({}));
      if (r.ok) return { ok: true, status, body: parsed, attempts };
      // A Hub that doesn't know the per-request fields yet refuses them: send what it knows (the cost is then estimated
      // from totals until the Hub is updated and the usage sent again).
      if (status === 400 && /unknown field/.test(String(parsed?.error ?? '')) && !opts.legacy) {
        const again = await sendUsage(hub, token, legacyBody(body), { ...opts, legacy: true });
        return { ...again, attempts: attempts + again.attempts, legacy: again.ok || again.legacy };
      }
    } catch (e) {
      parsed = { error: String((e as Error).message ?? e) };
    }
    const retry = status === 0 || status === 404 || status === 429 || status >= 500;
    const wait = Math.max(opts.retryMs ?? 30_000, status === 429 ? 1000 * Number(parsed?.retry_after_s ?? 30) : 0);
    if (!retry || Date.now() + wait > deadline) return { ok: false, status, body: parsed, attempts };
    await sleep(wait);
  }
}

/**
 * Send what this machine has for these seats of a hosted event; prints one line per outcome and records it in
 * usage-upload.json in the run folder. Returns the per-seat results ({} when nothing was sent).
 */
export async function uploadHostedUsage(dir: string, ev: LocalEvent, seats: string[], opts: { readBy: string; hub?: string; token?: string; waitMs?: number; quiet?: boolean }): Promise<Record<string, string>> {
  const say = (m: string) => (opts.quiet ? undefined : console.log(m));
  if (!handedToHub(ev) || !seats.length) return {};
  const hub = hubUrl(opts.hub);
  const token = ev.hosted ? contributorToken(opts.token, hub) : hubAdminToken(hub);
  if (!token) {
    say(ev.hosted ? 'Usage not sent to the Hub: not signed in (`bench login`). These seats stay Self-Reported until you send it with `bench attach-logs ' + ev.id + '`.'
      : 'Usage not sent to the Hub: this table was created with the Director admin token, and sending its usage takes the Hub admin token (HUB_ADMIN_TOKEN or ~/.config/mtgdt/hub-admin-token). These seats stay Self-Reported.');
    return {};
  }
  const { body, missing } = usageBody(dir, ev, seats, opts.readBy);
  if (missing.length) say(`No harness usage on this machine for ${missing.join(', ')}: ${missing.length === 1 ? 'it stays' : 'they stay'} Self-Reported.`);
  if (!body.seats.length) return {};
  say(`Sending the usage of ${body.seats.length} seat${body.seats.length === 1 ? '' : 's'} to the Hub (model ids, token counts, effort and harness version only)…`);
  const r = await sendUsage(hub, token, body, { waitMs: opts.waitMs });
  writeFileSync(join(dir, 'usage-upload.json'), JSON.stringify({ at: new Date().toISOString(), hub, status: r.status, ok: r.ok, result: r.body }, null, 1), { mode: 0o600 });
  if (!r.ok) {
    say(`The Hub didn't take the usage (${r.status || 'unreachable'}${r.body?.error ? `: ${r.body.error}` : ''}). Send it again later with \`bench attach-logs ${ev.id}\`; until then these seats stay Self-Reported.`);
    return {};
  }
  if (r.legacy) say(`This Hub doesn't take per-request usage yet, so it got token totals only and estimates the cost from them. Once it is updated, \`${BENCH} attach-logs ${ev.id}\` sends the full usage again.`);
  const checks: Record<string, string> = r.body?.model_check ?? {};
  const label = (c: string) => (c === 'verified' ? 'Checked Against Logs' : c === 'mismatch' ? 'Mismatch' : c === 'unlisted' ? 'Unlisted' : 'Self-Reported');
  for (const [seat, how] of Object.entries((r.body?.seats ?? {}) as Record<string, string>)) say(`  ${seat}: ${how}${checks[seat] ? `, ${label(checks[seat])}` : ''}`);
  if (r.body?.applied === 'when the event is accepted') say('The event is still in review at the Hub; the usage counts once it is accepted.');
  say(`(recorded in ${tilde(join(dir, 'usage-upload.json'))})`);
  return r.body?.seats ?? {};
}

/** The seats this machine started with `bench play` (a transcript) or found with attach-logs (harness-logs-<seat>.json). */
export function seatsWithUsage(dir: string, ev: LocalEvent): string[] {
  const start: any = readEventStart(dir);
  const names: string[] = start?.seats ? start.seats.filter((s: any) => s?.kind === 'agent').map((s: any) => String(s.name)) : Object.keys(ev.seats ?? {});
  // Scripted test seats have no model and no usage to check.
  const scripted = (n: string) => ev.meta?.[n]?.harness === 'script' || start?.seats?.some((s: any) => s?.name === n && s?.harness === 'script');
  return names.filter((n) => !scripted(n) && (existsSync(join(dir, `transcript-${n}.jsonl`)) || existsSync(join(dir, `harness-logs-${n}.json`))));
}

export const readByPlay = () => `bench play ${VERSION}`;
export const readByAttach = () => `bench attach-logs ${VERSION}`;
