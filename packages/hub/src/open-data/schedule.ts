/**
 * When the open dataset is built: once a night (HUB_OPEN_DATA_AT, default 03:30 in HUB_OPEN_DATA_TZ, the server's
 * America/New_York; well clear of the 02:20 database dump), in a child process at the lowest CPU and I/O priority
 * (`ionice -c3 nice -n 19` when available), so the Hub's request loop never does the work. Also:
 * - a first build a few minutes after start when none exists yet;
 * - an earlier rebuild after a takedown or a contributor hiding their handle (coalesced: HUB_OPEN_DATA_PRIVACY_DELAY_MIN);
 * - never two at once (the child takes a lock file; a manual `hub open-data build` respects it too).
 * The child skips the build when nothing changed since the last one (run.ts inputsFingerprint).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setPriority } from 'node:os';
import type { OpenDataConfig } from '../config.js';

const RUN_SCRIPT = join(import.meta.dirname, 'run.ts');
const FIRST_BUILD_DELAY_MS = 5 * 60_000;

interface Wall { y: number; m: number; d: number; h: number; mi: number }

function wallOf(ms: number, tz: string): Wall {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
      .formatToParts(new Date(ms)).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]),
  ) as Record<string, number>;
  return { y: parts.year!, m: parts.month!, d: parts.day!, h: parts.hour! % 24, mi: parts.minute! };
}

/** The UTC instant of a wall-clock time in `tz` (DST gaps resolve to the next valid minute). */
function utcOf(w: Wall, tz: string): number {
  const target = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi);
  let guess = target;
  for (let k = 0; k < 3; k++) {
    const p = wallOf(guess, tz);
    guess += target - Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
  }
  return guess;
}

/** The next time after `now` that the clock in `tz` shows `at` ("HH:MM"). */
export function nextRunAt(at: string, tz: string, now: number): number {
  const [hh, mm] = at.split(':').map(Number) as [number, number];
  const today = wallOf(now, tz);
  for (let k = 0; k < 3; k++) {
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d + k));
    const t = utcOf({ y: day.getUTCFullYear(), m: day.getUTCMonth() + 1, d: day.getUTCDate(), h: hh, mi: mm }, tz);
    if (t > now + 1000) return t;
  }
  return now + 24 * 3600_000;
}

/** The command that runs one build at low priority: ionice and nice when the image has them. */
export function buildCommand(force: boolean, has: (p: string) => boolean = existsSync): { cmd: string; args: string[]; reniceChild: boolean } {
  const node = [process.execPath, ...process.execArgv, RUN_SCRIPT, ...(force ? ['--force'] : [])];
  const nice = ['/usr/bin/nice', '/bin/nice'].find(has);
  const ionice = ['/usr/bin/ionice', '/bin/ionice'].find(has);
  if (nice && ionice) return { cmd: ionice, args: ['-c3', nice, '-n', '19', ...node], reniceChild: false };
  if (nice) return { cmd: nice, args: ['-n', '19', ...node], reniceChild: false };
  return { cmd: node[0]!, args: node.slice(1), reniceChild: true };
}

export class OpenDataScheduler {
  private nightly: NodeJS.Timeout | null = null;
  private soon: NodeJS.Timeout | null = null;
  private child: ChildProcess | null = null;
  private again = false;
  nextAt: number | null = null;
  lastRun: { at: string; code: number | null; ms: number } | null = null;

  constructor(private cfg: OpenDataConfig, private log: (m: string) => void = (m) => console.log(m), private hasBuild: () => boolean = () => true) {}

  start(): void {
    if (!this.cfg.enabled) {
      this.log('open data: nightly build off (HUB_OPEN_DATA=0)');
      return;
    }
    this.scheduleNight();
    if (!this.hasBuild()) this.runSoon(FIRST_BUILD_DELAY_MS, 'no build yet');
  }

  stop(): void {
    if (this.nightly) clearTimeout(this.nightly);
    if (this.soon) clearTimeout(this.soon);
    this.nightly = this.soon = null;
    this.child?.kill('SIGTERM');
  }

  /** A takedown or a hidden handle: rebuild before the night (coalesced), so the data stops showing it. */
  privacyChange(why: string): void {
    if (!this.cfg.enabled || this.cfg.privacyDelayMs <= 0) return;
    this.runSoon(this.cfg.privacyDelayMs, why);
  }

  private scheduleNight(): void {
    const at = nextRunAt(this.cfg.at, this.cfg.tz, Date.now());
    this.nextAt = at;
    this.nightly = setTimeout(() => {
      this.run(false, 'nightly');
      this.scheduleNight();
    }, Math.min(at - Date.now(), 2 ** 31 - 1));
    this.nightly.unref();
  }

  private runSoon(delayMs: number, why: string): void {
    if (this.soon) return; // one pending early build covers every request until it runs
    this.log(`open data: build in ${Math.round(delayMs / 60_000)} min (${why})`);
    this.soon = setTimeout(() => {
      this.soon = null;
      this.run(false, why);
    }, delayMs);
    this.soon.unref();
  }

  /** Start one build in a child process; a request while one runs starts another right after it. */
  run(force: boolean, why: string): Promise<number | null> {
    if (this.child) {
      this.again = true;
      return Promise.resolve(null);
    }
    const { cmd, args, reniceChild } = buildCommand(force);
    const t0 = Date.now();
    this.log(`open data: starting a build (${why})`);
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    this.child = child;
    if (reniceChild && child.pid) {
      try {
        setPriority(child.pid, 19);
      } catch {
        // not permitted: runs at normal priority
      }
    }
    const relay = (s: NodeJS.ReadableStream | null) => s?.on('data', (b: Buffer) => b.toString('utf8').split('\n').filter(Boolean).forEach((l) => this.log(`[open-data] ${l}`)));
    relay(child.stdout);
    relay(child.stderr);
    return new Promise((resolve) => {
      child.on('error', (e) => this.log(`open data: could not start the build: ${e.message}`));
      child.on('close', (code) => {
        this.child = null;
        this.lastRun = { at: new Date(t0).toISOString(), code, ms: Date.now() - t0 };
        if (code !== 0 && code !== 75) this.log(`open data: build exited with ${code}`);
        if (this.again) {
          this.again = false;
          void this.run(false, 'requested during the last build');
        }
        resolve(code);
      });
    });
  }
}
