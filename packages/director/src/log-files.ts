/**
 * Event logs on disk (docs/OPERATIONS.md): a best-of-3 table's `events.jsonl` is about 72 MB and gzips to about 6 MB.
 * Once the Hub has accepted a finished event (a final, successful `hub_handoff` record), the Director keeps only
 * `events.jsonl.gz`; everything that reads a run folder's log goes through here, so both forms work.
 */
import { closeSync, createReadStream, createWriteStream, existsSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Writable, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip, gunzipSync } from 'node:zlib';

export const LOG = 'events.jsonl';
export const LOG_GZ = 'events.jsonl.gz';

/** The run folder's event log: the plain file while it is written, else the compressed one; undefined when neither. */
export function eventLogFile(dir: string): string | undefined {
  if (existsSync(join(dir, LOG))) return join(dir, LOG);
  if (existsSync(join(dir, LOG_GZ))) return join(dir, LOG_GZ);
  return undefined;
}

export function hasEventLog(dir: string): boolean {
  return eventLogFile(dir) !== undefined;
}

/** The whole log as text ('' when there is none). */
export function readEventLog(dir: string): string {
  const f = eventLogFile(dir);
  if (!f) return '';
  const raw = readFileSync(f);
  return (f.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8');
}

/** The log as a stream of its plain bytes (the compressed file is inflated on the fly); undefined when there is none. */
export function eventLogStream(dir: string, opts: { end?: number } = {}): Readable | undefined {
  const f = eventLogFile(dir);
  if (!f) return undefined;
  if (!f.endsWith('.gz')) return createReadStream(f, opts.end != null ? { end: opts.end } : {});
  const src = createReadStream(f);
  const gun = createGunzip();
  src.on('error', (e) => gun.destroy(e));
  return src.pipe(gun);
}

/** Size of the plain log: the file's size, or the size gzip recorded (exact below 4 GB). */
export function eventLogSize(dir: string): number {
  const f = eventLogFile(dir);
  if (!f) return 0;
  if (!f.endsWith('.gz')) return statSync(f).size;
  const size = statSync(f).size;
  if (size < 4) return 0;
  const fd = openSync(f, 'r');
  try {
    const b = Buffer.alloc(4);
    readSync(fd, b, 0, 4, size - 4);
    return b.readUInt32LE(0);
  } finally {
    closeSync(fd);
  }
}

/** Last `bytes` of the plain log (whole lines only when cut). */
export function readEventLogTail(dir: string, bytes: number): string {
  const f = eventLogFile(dir);
  if (!f) return '';
  if (f.endsWith('.gz')) {
    const text = readEventLog(dir);
    if (text.length <= bytes) return text;
    const t = text.slice(-bytes);
    return t.slice(t.indexOf('\n') + 1);
  }
  const size = statSync(f).size;
  const n = Math.min(size, bytes);
  const buf = Buffer.alloc(n);
  const fd = openSync(f, 'r');
  try {
    readSync(fd, buf, 0, n, size - n);
  } finally {
    closeSync(fd);
  }
  const text = buf.toString('utf8');
  return n < size ? text.slice(text.indexOf('\n') + 1) : text;
}

/** Whether a finished event's log says the Hub accepted it (a final, successful hand-off: ingested, held or duplicate). */
export function handedOff(dir: string): boolean {
  if (!existsSync(join(dir, LOG)) || !existsSync(join(dir, 'summary.json'))) return false;
  let ended = false;
  let accepted = false;
  for (const line of readEventLogTail(dir, 512 * 1024).split('\n')) {
    if (!line.includes('"type":"')) continue;
    let r: { type?: string; final?: boolean; ok?: boolean };
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.type === 'event_end') ended = true;
    if (r.type === 'hub_handoff' && r.final && r.ok) accepted = true;
  }
  return ended && accepted;
}

/**
 * Compress a finished event's log: events.jsonl → events.jsonl.gz (written beside it and renamed, then the plain file
 * removed, so a reader always finds one whole log). Only after the Hub accepted the event (`handedOff`): from then on
 * nothing is appended to it. Returns whether it compressed.
 */
export async function compressEventLog(dir: string): Promise<boolean> {
  if (!handedOff(dir)) return false;
  const src = join(dir, LOG);
  const tmp = join(dir, `${LOG_GZ}.tmp-${process.pid}`);
  try {
    await pipeline(createReadStream(src), createGzip({ level: 6 }), createWriteStream(tmp, { mode: 0o644 }));
    // Check the copy before the original goes: it inflates to the same number of bytes.
    let n = 0;
    await pipeline(createReadStream(tmp), createGunzip(), new Writable({ write(chunk: Buffer, _e, cb) { n += chunk.length; cb(); } }));
    if (n !== statSync(src).size) throw new Error('the compressed copy does not match');
    renameSync(tmp, join(dir, LOG_GZ));
    rmSync(src);
    return true;
  } catch (err) {
    rmSync(tmp, { force: true });
    console.error(`compress ${dir}: ${String((err as Error)?.message ?? err)}`);
    return false;
  }
}

/** Compress the logs of every finished event in runsDir the Hub has accepted (at start: events from before this). */
export async function compressHandedOff(runsDir: string): Promise<string[]> {
  if (!existsSync(runsDir)) return [];
  const done: string[] = [];
  for (const name of readdirSync(runsDir)) {
    const dir = join(runsDir, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (await compressEventLog(dir)) done.push(name);
  }
  return done;
}
