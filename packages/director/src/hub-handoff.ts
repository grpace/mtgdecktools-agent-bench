/**
 * Director → Hub hand-off (contract: packages/hub/README.md "Hosted Director → Hub hand-off").
 *
 * After an event writes event_end and summary.json, its results bundle (bundle.ts) is POSTed to
 * $HUB_URL/api/internal/events with Bearer $HUB_SERVICE_TOKEN. Every attempt is recorded in the event log as
 * a `hub_handoff` record (left out of bundles, so resends are byte-identical):
 *   201 → done (`ingested` / `held`), 409 → done (already received), 400/413/422 → done (`rejected`, never resent),
 *   401/403 → stop for now (`unauthorized`: resent at the next start, once the token is fixed),
 *   network errors, 429 and 5xx → retried with backoff; still unsent after the last retry → resent at the next start.
 * Without HUB_URL nothing happens.
 */
import { appendFileSync, closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildBundle, readEventStart } from './bundle.js';
import { directorVersion } from './provenance.js';

export interface HubTarget {
  url: string;
  token: string;
}

/** HUB_URL + HUB_SERVICE_TOKEN (or HUB_SERVICE_TOKEN_FILE); undefined when the hand-off is off. */
export function hubTargetFromEnv(env: NodeJS.ProcessEnv): HubTarget | undefined {
  const url = (env.HUB_URL ?? '').trim().replace(/\/+$/, '');
  if (!url) return undefined;
  let token = (env.HUB_SERVICE_TOKEN ?? '').trim();
  if (!token && env.HUB_SERVICE_TOKEN_FILE && existsSync(env.HUB_SERVICE_TOKEN_FILE)) token = readFileSync(env.HUB_SERVICE_TOKEN_FILE, 'utf8').trim();
  if (!token) {
    console.warn('hub hand-off: HUB_URL is set but HUB_SERVICE_TOKEN is empty; finished events will not be sent.');
    return undefined;
  }
  return { url, token };
}

export type HandoffStatus = 'ingested' | 'held' | 'duplicate' | 'rejected' | 'unauthorized' | 'error';

export interface HandoffRecord {
  attempt: number;
  ok: boolean;
  status: HandoffStatus | string;
  /** No more attempts in this process (done, permanently refused, or out of retries). */
  final: boolean;
  http?: number;
  bundle_sha256?: string;
  submission_id?: string;
  label?: string;
  flags?: string[];
  holds?: string[];
  pack_regeneration?: string;
  message?: string;
}

/** Retry delays after a failed attempt (network, 429, 5xx): about 40 minutes in all. */
export const DEFAULT_DELAYS_MS = [10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 600_000, 600_000];

export class HubHandoff {
  private inFlight = new Set<string>();

  constructor(
    private target: HubTarget,
    private opts: { delaysMs?: number[]; timeoutMs?: number; log?: (m: string) => void; afterAccepted?: (dir: string) => void } = {},
  ) {}

  private say(m: string): void {
    (this.opts.log ?? console.log)(`hub hand-off: ${m}`);
  }

  /** Send one finished event (retrying); resolves with the last attempt's record. */
  async send(dir: string): Promise<HandoffRecord | undefined> {
    const id = dir.replace(/\/+$/, '').split('/').pop()!;
    if (this.inFlight.has(id)) return undefined;
    this.inFlight.add(id);
    try {
      const delays = this.opts.delaysMs ?? DEFAULT_DELAYS_MS;
      for (let attempt = 1; ; attempt++) {
        const rec = await this.attempt(dir, attempt, attempt > delays.length);
        appendFileSync(join(dir, 'events.jsonl'), JSON.stringify({ t: Date.now(), type: 'hub_handoff', ...rec }) + '\n');
        this.say(`${id}: ${rec.status}${rec.http ? ` (${rec.http})` : ''}${rec.pack_regeneration ? `, packs ${rec.pack_regeneration}` : ''}${rec.holds?.length ? `, held: ${rec.holds.join('; ')}` : ''}${rec.message && !rec.ok ? `: ${rec.message}` : ''}`);
        if (rec.final) {
          // Accepted (ingested, held or already there): nothing more is appended to this event's log.
          if (rec.ok) this.opts.afterAccepted?.(dir);
          return rec;
        }
        await new Promise((r) => setTimeout(r, delays[attempt - 1]));
      }
    } finally {
      this.inFlight.delete(id);
    }
  }

  private async attempt(dir: string, attempt: number, last: boolean): Promise<HandoffRecord> {
    let gz: Buffer;
    let sha: string;
    try {
      // Deterministic bytes, a function of the run folder only (created at the event's end, by the Director version
      // that ran it), so a resend, even by a newer Director after a restart, is the same bundle (409, a no-op).
      const end = lastRecordTime(join(dir, 'events.jsonl'), 'event_end');
      const ranBy = readEventStart(dir)?.provenance?.director ?? directorVersion();
      const b = buildBundle(dir, { createdBy: `mtgdt-director ${ranBy}`, createdAt: end });
      gz = b.gz;
      sha = b.sha256;
    } catch (e) {
      return { attempt, ok: false, status: 'error', final: true, message: `could not build the bundle: ${(e as Error).message}` };
    }
    let res: Response;
    try {
      res = await fetch(`${this.target.url}/api/internal/events`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.target.token}`, 'Content-Type': 'application/gzip' },
        body: new Uint8Array(gz),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 180_000),
      });
    } catch (e) {
      return { attempt, ok: false, status: 'error', final: last, bundle_sha256: sha, message: String((e as Error).cause ?? (e as Error).message ?? e).slice(0, 300) };
    }
    let body: any = {};
    const text = await res.text().catch(() => '');
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text.slice(0, 300) };
    }
    const base = { attempt, http: res.status, bundle_sha256: sha };
    if (res.status === 201) {
      return {
        ...base, ok: true, status: String(body.status ?? 'ingested'), final: true, submission_id: body.submission_id, label: body.label,
        flags: body.flags?.length ? body.flags : undefined,
        holds: (body.reasons ?? []).filter((r: { severity?: string }) => r.severity === 'hold').map((r: { code?: string; message?: string }) => `${r.code}: ${r.message}`).slice(0, 10),
        pack_regeneration: body.pack_regeneration?.status,
      };
    }
    if (res.status === 409) return { ...base, ok: true, status: 'duplicate', final: true, message: body.error };
    if (res.status === 401 || res.status === 403) return { ...base, ok: false, status: 'unauthorized', final: true, message: body.error };
    if (res.status === 400 || res.status === 413 || res.status === 422) {
      return { ...base, ok: false, status: 'rejected', final: true, message: [body.error, ...(body.reasons ?? []).map((r: { message?: string }) => r.message)].filter(Boolean).join('; ').slice(0, 500) };
    }
    return { ...base, ok: false, status: 'error', final: last, message: String(body.error ?? text).slice(0, 300) };
  }

  /**
   * At start: send every finished event in runsDir whose hand-off never completed. Only events this Director
   * version could have handed off (event_start.boosters, logged since the hand-off exists); older runs and
   * community submissions (source.json) go to the Hub through `hub import` instead.
   */
  async resendPending(runsDir: string): Promise<void> {
    if (!existsSync(runsDir)) return;
    const pending = readdirSync(runsDir).filter((d) => needsHandoff(join(runsDir, d)));
    if (pending.length) this.say(`${pending.length} finished event(s) not handed off yet: ${pending.join(', ')}`);
    for (const d of pending) await this.send(join(runsDir, d));
  }
}

/** Whether a run folder holds a finished (or stopped, with finished games) event of ours whose hand-off has not completed. */
export function needsHandoff(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory() || existsSync(join(dir, 'source.json')) || !existsSync(join(dir, 'summary.json'))) return false;
    const start = readEventStart(dir);
    if (!start?.boosters) return false;
    const tail = readTail(join(dir, 'events.jsonl'), 512 * 1024);
    let ended = false;
    let done = false;
    for (const line of tail.split('\n')) {
      if (!line.includes('"type":"')) continue;
      let r: any;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      if (r.type === 'event_error') return false;
      // A stopped event with finished games has a summary.json (Event.abort) and goes to the Hub like a finished one.
      if (r.type === 'event_end' || r.type === 'event_abort') ended = true;
      if (r.type === 'hub_handoff' && r.final && (r.ok || r.status === 'rejected')) done = true;
    }
    return ended && !done;
  } catch {
    return false;
  }
}

function readTail(file: string, bytes: number): string {
  const size = statSync(file).size;
  const n = Math.min(size, bytes);
  const buf = Buffer.alloc(n);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buf, 0, n, size - n);
  } finally {
    closeSync(fd);
  }
  const text = buf.toString('utf8');
  // Drop a partial first line when we started mid-file.
  return n < size ? text.slice(text.indexOf('\n') + 1) : text;
}

/** Time of the last record of a type (deterministic bundle timestamps); now if there is none. */
function lastRecordTime(file: string, type: string): number {
  for (const line of readTail(file, 512 * 1024).split('\n').reverse()) {
    if (!line.includes(`"type":"${type}"`)) continue;
    try {
      const r = JSON.parse(line);
      if (r.type === type && typeof r.t === 'number') return r.t;
    } catch {
      // partial line
    }
  }
  return Date.now();
}
