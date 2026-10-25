/**
 * File formats of the open dataset: gzipped CSV, Parquet (hyparquet-writer, pure JavaScript, MIT) and the snapshot zip
 * (written here: stored entries for files that are already compressed, deflate for text). Everything is synchronous:
 * the build runs in its own low-priority process (schedule.ts), never in the Hub's request loop.
 */
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { crc32, deflateRawSync, gzipSync, inflateRawSync } from 'node:zlib';
import { parquetWriteBuffer } from 'hyparquet-writer';
import type { Cell, ColumnDef, Row, TableDef } from './tables.js';

// ---------------------------------------------------------------------------
// CSV (RFC 4180, UTF-8, header row; null = empty cell)

/** What spreadsheets read as the start of a formula (OWASP CSV injection). */
export const FORMULA_START = /^[=+\-@\t\r]/;

function csvCell(c: ColumnDef, v: Cell | undefined): string {
  if (v === null || v === undefined) return '';
  let s: string;
  switch (c.type) {
    case 'bool': s = v ? 'true' : 'false'; break;
    case 'json': s = JSON.stringify(v); break;
    case 'timestamp': s = new Date(v as number).toISOString(); break;
    case 'double': s = String(v); break;
    default:
      s = String(v);
      // Formula injection (HUB-25): agent-written text (notes, deck names) opened in a spreadsheet must stay text, so a
      // string cell that starts like a formula gets a leading apostrophe. CSV only; Parquet holds the exact text.
      if (c.type === 'string' && FORMULA_START.test(s)) s = `'${s}`;
  }
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(def: TableDef, rows: Row[]): string {
  const lines = [def.columns.map((c) => c.name).join(',')];
  for (const r of rows) lines.push(def.columns.map((c) => csvCell(c, r[c.name])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** gzip with a zero mtime, so the same rows give the same bytes. */
export const gzip = (data: string | Buffer): Buffer => gzipSync(typeof data === 'string' ? Buffer.from(data, 'utf8') : data, { level: 9 });

export const toCsvGz = (def: TableDef, rows: Row[]): Buffer => gzip(toCsv(def, rows));

// ---------------------------------------------------------------------------
// Parquet

const PARQUET_TYPE = { string: 'STRING', int: 'INT64', double: 'DOUBLE', bool: 'BOOLEAN', json: 'JSON', timestamp: 'TIMESTAMP' } as const;

function parquetValues(c: ColumnDef, rows: Row[]): unknown[] {
  return rows.map((r) => {
    const v = r[c.name];
    if (v === null || v === undefined) return null;
    if (c.type === 'int') return BigInt(v as number);
    if (c.type === 'timestamp') return new Date(v as number);
    return v;
  });
}

/** One Parquet file (snappy-compressed pages, column statistics) with the table's description and license in its metadata. */
export function toParquet(def: TableDef, rows: Row[], meta: Record<string, string>): Buffer {
  const ab = parquetWriteBuffer({
    columnData: def.columns.map((c) => ({ name: c.name, data: parquetValues(c, rows) as never, type: PARQUET_TYPE[c.type], nullable: true })),
    rowGroupSize: 100_000,
    kvMetadata: Object.entries({ table: def.name, description: def.description, ...meta }).map(([key, value]) => ({ key, value })),
    createdBy: 'mtgdecktools-agent-bench open-data (hyparquet-writer)',
  });
  return Buffer.from(ab);
}

// ---------------------------------------------------------------------------
// Zip (no Zip64: the writer refuses more than 65,535 entries or 4 GB, far beyond a nightly snapshot today)

export interface ZipEntry {
  /** Path inside the zip (forward slashes). */
  name: string;
  /** A file on disk (read whole: per-event logs and tables are a few MB each) or bytes. */
  file?: string;
  data?: Buffer;
  /** Stored as is (already compressed: .gz, .parquet) instead of deflated. */
  store?: boolean;
}

const LIMIT = 0xffffffff;

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: ((d.getUTCHours() & 31) << 11) | ((d.getUTCMinutes() & 63) << 5) | (Math.floor(d.getUTCSeconds() / 2) & 31),
    date: (((d.getUTCFullYear() - 1980) & 127) << 9) | (((d.getUTCMonth() + 1) & 15) << 5) | (d.getUTCDate() & 31),
  };
}

/** Write a zip to `path`, one entry at a time (memory: the largest entry). */
export function writeZip(path: string, entries: ZipEntry[], when: Date): number {
  if (entries.length > 0xffff) throw new Error(`zip: ${entries.length} entries (more than 65,535 needs Zip64)`);
  const { time, date } = dosTime(when);
  const fd = openSync(path, 'w', 0o644);
  const central: Buffer[] = [];
  let offset = 0;
  const put = (b: Buffer) => {
    writeSync(fd, b);
    offset += b.length;
  };
  try {
    for (const e of entries) {
      const raw = e.data ?? readFileSync(e.file!);
      const body = e.store ? raw : deflateRawSync(raw, { level: 9 });
      const crc = crc32(raw) >>> 0;
      const name = Buffer.from(e.name, 'utf8');
      if (raw.length >= LIMIT || offset + body.length + 30 + name.length >= LIMIT) throw new Error('zip: larger than 4 GB (needs Zip64)');
      const method = e.store ? 0 : 8;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4); // version needed
      local.writeUInt16LE(0x0800, 6); // UTF-8 names
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(raw.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      const at = offset;
      put(local);
      put(name);
      put(body);
      const cen = Buffer.alloc(46);
      cen.writeUInt32LE(0x02014b50, 0);
      cen.writeUInt16LE(0x031e, 4); // made by: Unix, 3.0
      cen.writeUInt16LE(20, 6);
      cen.writeUInt16LE(0x0800, 8);
      cen.writeUInt16LE(method, 10);
      cen.writeUInt16LE(time, 12);
      cen.writeUInt16LE(date, 14);
      cen.writeUInt32LE(crc, 16);
      cen.writeUInt32LE(body.length, 20);
      cen.writeUInt32LE(raw.length, 24);
      cen.writeUInt16LE(name.length, 28);
      cen.writeUInt32LE(((0o100644 << 16) >>> 0), 38); // external attributes: a regular file, rw-r--r--
      cen.writeUInt32LE(at, 42);
      central.push(Buffer.concat([cen, name]));
    }
    const cdStart = offset;
    for (const c of central) put(c);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(offset - cdStart, 12);
    end.writeUInt32LE(cdStart, 16);
    put(end);
  } finally {
    closeSync(fd);
  }
  return offset;
}

/** Entries of a zip written by writeZip (tests and the build's own check): name, method, sizes, CRC and data. */
export function readZip(buf: Buffer): Array<{ name: string; data: Buffer; crcOk: boolean }> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('zip: no end of central directory');
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: Array<{ name: string; data: Buffer; crcOk: boolean }> = [];
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip: bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const at = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(at + 26);
    const lxlen = buf.readUInt16LE(at + 28);
    const body = buf.subarray(at + 30 + lnlen + lxlen, at + 30 + lnlen + lxlen + csize);
    const data = method === 0 ? Buffer.from(body) : inflateRawSync(body);
    out.push({ name, data, crcOk: (crc32(data) >>> 0) === crc });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}
