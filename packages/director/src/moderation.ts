/**
 * The Hub's moderation list on a hosted Director (docs/SECURITY.md "Moderation and erasure").
 *
 * The Hub holds takedowns, hidden notes and deck names, hidden handles and erased contributors. A Director serves
 * finished events too (its own `/data` export, spectator replays), so it reads the list from the Hub
 * (GET /api/internal/moderation, the service token it already uses for hand-offs and introspection):
 * - every minute (ModerationSync), and at once on POST /api/admin/moderation/sync (admin token);
 * - a taken-down event's run folder is deleted (it is served from nowhere: /data, replays, /api/events), its files
 *   leave the served export at once, and the export is rebuilt;
 * - hidden text and erased contributors apply to the export (packages/site build-data reads MTGDT_MODERATION_FILE)
 *   and to replays (spectate-http.ts, through moderateRecord); a finished event touched by a change is replayed
 *   afresh from its log rather than from memory.
 * If the Hub can't be reached the last list stays in force (it is kept on disk across restarts).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EVENT_ID_RE } from './submissions.js';
import { compileModeration, type CompiledModeration, type ModerationList } from './public-text.js';

let current: CompiledModeration = compileModeration(null);

/** The list in force in this process (empty until the first sync or the file from the last run). */
export function currentModeration(): CompiledModeration {
  return current;
}

/** For tests and the sync below. */
export function setModeration(list: ModerationList | null): CompiledModeration {
  current = compileModeration(list);
  return current;
}

export function isTakenDown(eventId: string): boolean {
  return current.takedowns.has(eventId);
}

export interface ModerationChange {
  /** Newly taken-down events whose run folder this Director held (now deleted). */
  removed: string[];
  /** Events with hidden text, before or after the change (replays of them are rebuilt). */
  touched: string[];
}

export interface ModerationSyncOptions {
  /** Fetch the list (HubAuth.moderation). */
  fetchList: () => Promise<ModerationList>;
  runsDir: string;
  /** The served export (SITE_DATA_DIR): a taken-down event's files leave it at once. */
  dataDir?: string;
  /** Where the list is kept for build-data and across restarts. */
  file: string;
  intervalMs?: number;
  onChange?: (change: ModerationChange) => void;
  log?: (msg: string) => void;
}

export class ModerationSync {
  private timer?: ReturnType<typeof setInterval>;
  private running: Promise<ModerationChange | null> | null = null;
  lastSync: { at: string; version: string; ok: boolean; error?: string } | null = null;

  constructor(private o: ModerationSyncOptions) {
    // build-data runs as a child of this process: it inherits the variable and applies the same list.
    process.env.MTGDT_MODERATION_FILE = o.file;
    try {
      if (existsSync(o.file)) {
        const list = JSON.parse(readFileSync(o.file, 'utf8')) as ModerationList;
        setModeration(list);
        // A takedown read before a restart is enforced again (a folder restored from a backup, say).
        this.enforceTakedowns(list.takedowns ?? []);
      }
    } catch {
      // a damaged file: the first sync replaces it
    }
  }

  start(): void {
    void this.syncNow();
    this.timer = setInterval(() => void this.syncNow(), this.o.intervalMs ?? 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Fetch and apply the list now; null when nothing changed or the Hub can't be reached. One at a time. */
  syncNow(): Promise<ModerationChange | null> {
    this.running ??= this.sync().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async sync(): Promise<ModerationChange | null> {
    let list: ModerationList;
    try {
      list = await this.o.fetchList();
    } catch (e) {
      this.lastSync = { at: new Date().toISOString(), version: current.version, ok: false, error: (e as Error).message };
      return null;
    }
    this.lastSync = { at: new Date().toISOString(), version: list.version, ok: true };
    if (list.version === current.version) return null;
    return this.apply(list);
  }

  /** Apply a list (also used by tests): persist it, delete taken-down folders, report what changed. */
  apply(list: ModerationList): ModerationChange {
    const before = current;
    const next = setModeration(list);
    mkdirSync(dirname(this.o.file), { recursive: true });
    const tmp = `${this.o.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(list));
    renameSync(tmp, this.o.file);
    const removed = this.enforceTakedowns([...next.takedowns]);
    const touched = [...new Set([...before.touched, ...next.touched])];
    const change = { removed, touched };
    if (removed.length) this.o.log?.(`moderation: taken down here: ${removed.join(', ')}`);
    this.o.onChange?.(change);
    return change;
  }

  /** Delete the run folders and exported files of taken-down events this Director holds. */
  private enforceTakedowns(ids: string[]): string[] {
    const removed: string[] = [];
    for (const id of ids) {
      if (!EVENT_ID_RE.test(id)) continue;
      const dir = join(this.o.runsDir, id);
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
        removed.push(id);
      }
      if (this.o.dataDir) {
        rmSync(join(this.o.dataDir, 'events', id), { recursive: true, force: true });
        rmSync(join(this.o.dataDir, 'events', `${id}.json`), { force: true });
      }
    }
    return removed;
  }
}
