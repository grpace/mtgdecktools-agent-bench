/**
 * Card overrides in JavaScript (docs/CARD-OVERRIDES.md): `apply`, ported from scripts/card_overrides.py for the hosted
 * stack, whose image has Node and no Python. The two must write byte-identical card-data.json files (CI compares them:
 * card-overrides.test.ts and scripts/ci-local.sh).
 *
 * Lossless by construction. card-data.json holds 64-bit integers (18446744073709551615), so it is never parsed whole
 * with JSON.parse: a scanner finds each overridden card's entry in the raw bytes, only that entry is parsed (numbers
 * keep their source text, objects keep their key order in a Map), patched with the same RFC 6902 semantics as the
 * Python tool, serialized compactly and spliced back. Every other byte of the file is copied as is. With no override
 * the output is the upstream file itself.
 *
 * Why the patched entry's bytes equal Python's: Python's json.dumps of the loaded upstream file reproduces it byte for
 * byte (phase-rs writes compact UTF-8 JSON), so every number and string in it is already in the form Python writes;
 * keeping source text keeps that form. Numbers in patch values must be integers (the only kind the data has), so they
 * print the same in both. Object keys keep insertion order, and `replace` on an object member moves it to the end,
 * as Python's dict does.
 */
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CARD_DATA = 'card-data.json';
export const UPSTREAM_COPY = 'card-data.upstream.json';
export const SIDECAR = 'card-overrides.json';
const STATUSES = ['active', 'submitted-upstream', 'retired'];
const APPLIED = new Set(['active', 'submitted-upstream']);
const KINDS = ['card-data', 'parser', 'engine', 'coverage'];
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class OverrideError extends Error {}

// ---------------------------------------------------------------------------------------------------------------
// Lossless JSON: values with numbers as source text and objects as Maps.

/** A JSON number as written in the source. */
export class RawNum {
  constructor(readonly raw: string) {}
}
export type JValue = null | boolean | string | RawNum | JValue[] | JObject;
export type JObject = Map<string, JValue>;

const isObj = (v: JValue): v is JObject => v instanceof Map;

/** Parse JSON text keeping every number's source text and every object's key order. */
export function parseLossless(text: string): JValue {
  let i = 0;
  const ws = () => {
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) i++;
      else break;
    }
  };
  const fail = (what: string): never => {
    throw new OverrideError(`invalid JSON at ${i}: ${what}`);
  };
  const str = (): string => {
    const start = i;
    i++;
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 0x5c) i += 2;
      else if (c === 0x22) {
        i++;
        return JSON.parse(text.slice(start, i)) as string;
      } else i++;
    }
    return fail('unterminated string');
  };
  const value = (): JValue => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const m: JObject = new Map();
      ws();
      if (text[i] === '}') {
        i++;
        return m;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail('expected a key');
        const k = str();
        ws();
        if (text[i] !== ':') fail('expected ":"');
        i++;
        m.set(k, value());
        ws();
        if (text[i] === ',') i++;
        else if (text[i] === '}') {
          i++;
          return m;
        } else fail('expected "," or "}"');
      }
    }
    if (c === '[') {
      i++;
      const a: JValue[] = [];
      ws();
      if (text[i] === ']') {
        i++;
        return a;
      }
      for (;;) {
        a.push(value());
        ws();
        if (text[i] === ',') i++;
        else if (text[i] === ']') {
          i++;
          return a;
        } else fail('expected "," or "]"');
      }
    }
    if (c === '"') return str();
    for (const [lit, v] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(lit, i)) {
        i += lit.length;
        return v;
      }
    }
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?/.exec(text.slice(i, i + 400));
    if (!m) return fail('unexpected character');
    i += m[0].length;
    return new RawNum(m[0]);
  };
  const v = value();
  ws();
  if (i !== text.length) fail('trailing characters');
  return v;
}

/** Compare by code point, as Python sorts str keys (sort_keys=True). */
function byCodePoint(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let k = 0; k < Math.min(x.length, y.length); k++) {
    const d = x[k]!.codePointAt(0)! - y[k]!.codePointAt(0)!;
    if (d) return d;
  }
  return x.length - y.length;
}

/**
 * Compact JSON as Python's json.dumps(separators=(",", ":"), ensure_ascii=False) writes it (`sortKeys`: sort_keys=True,
 * the canonical form behind entry_sha256 and patch `test` operations).
 */
export function serialize(v: JValue, sortKeys = false): string {
  if (v === null) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'string') return JSON.stringify(v);
  if (v instanceof RawNum) return v.raw;
  if (Array.isArray(v)) return `[${v.map((x) => serialize(x, sortKeys)).join(',')}]`;
  const keys = [...v.keys()];
  if (sortKeys) keys.sort(byCodePoint);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(v.get(k)!, sortKeys)}`).join(',')}}`;
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
/** sha256 of an entry's canonical JSON (sorted keys), as card_overrides.py entry_sha256(). */
export const entrySha256 = (entry: JValue): string => sha256(Buffer.from(serialize(entry, true), 'utf8'));

function clone(v: JValue): JValue {
  if (Array.isArray(v)) return v.map(clone);
  if (isObj(v)) return new Map([...v].map(([k, x]) => [k, clone(x)]));
  return v;
}

/** Patch values may only hold integers: the data has no other numbers, and integers print alike in Python and here. */
function integersOnly(v: JValue, where: string): void {
  if (v instanceof RawNum && !/^-?(?:0|[1-9]\d*)$/.test(v.raw)) {
    throw new OverrideError(`${where}: the number ${v.raw} isn't an integer (the JavaScript apply supports integers only)`);
  }
  if (Array.isArray(v)) v.forEach((x) => integersOnly(x, where));
  else if (isObj(v)) for (const x of v.values()) integersOnly(x, where);
}

// ---------------------------------------------------------------------------------------------------------------
// RFC 6902 JSON Patch with RFC 6901 pointers, with card_overrides.py apply_patch()'s semantics.

function pointer(path: string): string[] {
  if (path === '') return [];
  if (!path.startsWith('/')) throw new OverrideError(`bad JSON pointer ${JSON.stringify(path)}`);
  return path.slice(1).split('/').map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function index(t: string, path: string): number {
  if (!/^\d+$/.test(t)) throw new OverrideError(`path ${path} not found (list index ${JSON.stringify(t)})`);
  return Number(t);
}

function walk(doc: JValue, tokens: string[], path: string): JValue {
  let cur = doc;
  for (const t of tokens) {
    if (Array.isArray(cur)) {
      const k = index(t, path);
      if (k >= cur.length) throw new OverrideError(`path ${path} not found (index ${k})`);
      cur = cur[k]!;
    } else if (isObj(cur)) {
      if (!cur.has(t)) throw new OverrideError(`path ${path} not found (${JSON.stringify(t)})`);
      cur = cur.get(t)!;
    } else throw new OverrideError(`cannot descend into a ${cur === null ? 'null' : typeof cur} at ${JSON.stringify(t)}`);
  }
  return cur;
}

const get = (doc: JValue, path: string): JValue => walk(doc, pointer(path), path);

function remove(doc: JValue, path: string): JValue {
  const toks = pointer(path);
  const parent = walk(doc, toks.slice(0, -1), path);
  const last = toks[toks.length - 1]!;
  if (Array.isArray(parent)) {
    const k = index(last, path);
    if (k >= parent.length) throw new OverrideError(`remove: path ${path} not found`);
    return parent.splice(k, 1)[0]!;
  }
  if (isObj(parent) && parent.has(last)) {
    const v = parent.get(last)!;
    parent.delete(last);
    return v;
  }
  throw new OverrideError(`remove: path ${path} not found`);
}

function add(doc: JValue, path: string, value: JValue): JValue {
  const toks = pointer(path);
  if (!toks.length) return value;
  const parent = walk(doc, toks.slice(0, -1), path);
  const last = toks[toks.length - 1]!;
  if (Array.isArray(parent)) {
    const k = last === '-' ? parent.length : index(last, path);
    if (k > parent.length) throw new OverrideError(`add: index ${k} out of range at ${path}`);
    parent.splice(k, 0, value);
  } else if (isObj(parent)) parent.set(last, value);
  else throw new OverrideError(`add: ${path} has no container parent`);
  return doc;
}

export interface PatchOp { op: string; path?: string; from?: string; value?: JValue }

export function applyPatch(entry: JValue, ops: PatchOp[]): JValue {
  let doc = clone(entry);
  for (const op of ops) {
    const path = op.path ?? '';
    if (op.value !== undefined) integersOnly(op.value, `${op.op} ${path}`);
    switch (op.op) {
      case 'test':
        if (serialize(get(doc, path), true) !== serialize(op.value ?? null, true)) {
          throw new OverrideError(`test failed at ${path}: upstream no longer has the value this override expects`);
        }
        break;
      case 'remove':
        remove(doc, path);
        break;
      case 'add':
        doc = add(doc, path, clone(op.value ?? null));
        break;
      case 'replace':
        get(doc, path);
        if (path === '') doc = clone(op.value ?? null);
        else {
          remove(doc, path);
          doc = add(doc, path, clone(op.value ?? null));
        }
        break;
      case 'move':
        doc = add(doc, path, remove(doc, op.from ?? ''));
        break;
      case 'copy':
        doc = add(doc, path, clone(get(doc, op.from ?? '')));
        break;
      default:
        throw new OverrideError(`unsupported patch op ${JSON.stringify(op.op)}`);
    }
  }
  return doc;
}

// ---------------------------------------------------------------------------------------------------------------
// The raw card-data.json: top-level entries located without parsing the file.

/**
 * Byte ranges of the top-level members of a JSON object whose (decoded) keys are in `want`: key → [start, end) of the
 * value. Strings are skipped with their escapes, so a brace or quote inside card text never confuses it.
 */
export function locateEntries(buf: Buffer, want: Set<string>): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  let i = 0;
  const n = buf.length;
  const fail = (what: string): never => {
    throw new OverrideError(`card-data.json is not a JSON object as expected (${what} at byte ${i})`);
  };
  const ws = () => {
    while (i < n && (buf[i] === 0x20 || buf[i] === 0x0a || buf[i] === 0x0d || buf[i] === 0x09)) i++;
  };
  const skipString = () => {
    i++;
    while (i < n) {
      const c = buf[i]!;
      if (c === 0x5c) i += 2;
      else if (c === 0x22) {
        i++;
        return;
      } else i++;
    }
    fail('unterminated string');
  };
  const skipValue = () => {
    const c = buf[i];
    if (c === 0x22) return skipString();
    if (c === 0x7b || c === 0x5b) {
      let depth = 0;
      while (i < n) {
        const d = buf[i]!;
        if (d === 0x22) {
          skipString();
          continue;
        }
        if (d === 0x7b || d === 0x5b) depth++;
        else if (d === 0x7d || d === 0x5d) {
          depth--;
          if (depth === 0) {
            i++;
            return;
          }
        }
        i++;
      }
      return fail('unterminated container');
    }
    while (i < n && buf[i] !== 0x2c && buf[i] !== 0x7d && buf[i] !== 0x5d && buf[i] !== 0x20 && buf[i] !== 0x0a && buf[i] !== 0x0d && buf[i] !== 0x09) i++;
  };
  ws();
  if (buf[i] !== 0x7b) fail('expected "{"');
  i++;
  ws();
  if (buf[i] === 0x7d) return out;
  for (;;) {
    ws();
    if (buf[i] !== 0x22) fail('expected a key');
    const ks = i;
    skipString();
    const key = JSON.parse(buf.toString('utf8', ks, i)) as string;
    ws();
    if (buf[i] !== 0x3a) fail('expected ":"');
    i++;
    ws();
    const vs = i;
    skipValue();
    if (want.has(key)) out.set(key, [vs, i]);
    ws();
    if (buf[i] === 0x2c) i++;
    else if (buf[i] === 0x7d) return out;
    else fail('expected "," or "}"');
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Override files (engine/overrides/<slug>.json)

export interface Override {
  slug: string;
  card: string;
  status: string;
  /** The override makes a card the engine couldn't run work as printed: it comes off the unsupported-card list. */
  marks_supported: boolean;
  upstream_issue?: string | null;
  applies_to: { server_version: string; build_commit: string; card_data_sha256: string; entry_sha256: string };
  patch: PatchOp[];
  /** sha256 of the file's bytes. */
  file_sha256: string;
}

/** Python truthiness (empty strings, lists and objects are false), so validation agrees with card_overrides.py. */
const truthy = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : v && typeof v === 'object' ? Object.keys(v).length > 0 : !!v);

/** The problems card_overrides.py validate() reports, or [] when the file is valid. */
function validate(slug: string, o: Record<string, any>): string[] {
  const bad: string[] = [];
  if (!SLUG_RE.test(slug)) bad.push('file name must be a lowercase slug (heated-argument.json)');
  if (typeof o.card !== 'string' || !o.card) bad.push('card: the card\'s name, as in card-data.json');
  if (!STATUSES.includes(o.status)) bad.push(`status: one of ${STATUSES.join(', ')}`);
  if (!KINDS.includes(o.kind)) bad.push(`kind: where upstream should fix it, one of ${KINDS.join(', ')}`);
  for (const k of ['server_version', 'build_commit', 'card_data_sha256', 'entry_sha256']) {
    if (typeof o.applies_to?.[k] !== 'string' || !o.applies_to[k]) bad.push(`applies_to.${k} is required`);
  }
  if (o.upstream_issue !== undefined && o.upstream_issue !== null && typeof o.upstream_issue !== 'string') bad.push('upstream_issue: a URL or null');
  if (o.marks_supported !== undefined && typeof o.marks_supported !== 'boolean') bad.push('marks_supported: true or false');
  if (!truthy(o.rules?.oracle) || !truthy(o.rules?.cr)) bad.push('rules.oracle and rules.cr (Comprehensive Rules references) are required');
  if (!Array.isArray(o.patch) || !o.patch.length) bad.push('patch: a JSON Patch (list of operations) against the card\'s entry');
  const coverage = o.kind === 'coverage';
  if (coverage) {
    if (Array.isArray(o.patch) && o.patch.some((op: any) => op?.op !== 'test')) bad.push('patch: a coverage override only pins the verified values (test ops)');
    if (o.marks_supported !== true) bad.push('marks_supported: a coverage override exists to mark its card supported');
  }
  if (!Array.isArray(o.tests) || !o.tests.length) bad.push('tests: at least one scripted case');
  else if (coverage && o.tests.some((t: any) => truthy(t?.expect?.bug))) bad.push('tests: a coverage override changes nothing, so no case can show a bug');
  else if (!coverage && !o.tests.some((t: any) => truthy(t?.expect?.bug))) bad.push('tests: at least one case must reproduce the bug (expect.bug)');
  return bad;
}

/** Every override file in `dir`, validated, sorted by slug (as card_overrides.py load_overrides()). */
export function loadOverrides(dir: string): Override[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const slug = f.slice(0, -'.json'.length);
    const bytes = readFileSync(join(dir, f));
    const o = JSON.parse(bytes.toString('utf8')) as Record<string, any>;
    const problems = validate(slug, o);
    if (problems.length) throw new OverrideError(`engine/overrides/${f}: ${problems.join('; ')}`);
    // The patch again, losslessly: its values keep key order and number text.
    const lossless = parseLossless(bytes.toString('utf8')) as JObject;
    const patch = (lossless.get('patch') as JValue[]).map((op) => {
      const m = op as JObject;
      const s = (k: string) => (typeof m.get(k) === 'string' ? (m.get(k) as string) : undefined);
      return { op: s('op') ?? '', ...(s('path') !== undefined ? { path: s('path') } : {}), ...(s('from') !== undefined ? { from: s('from') } : {}), ...(m.has('value') ? { value: m.get('value')! } : {}) };
    });
    return { slug, card: o.card, status: o.status, marks_supported: o.marks_supported === true, upstream_issue: o.upstream_issue ?? null, applies_to: o.applies_to, patch, file_sha256: sha256(bytes) };
  });
}

/** sha256 over the applied override files (slug \0 file sha256 bytes \0, sorted by slug), as card_overrides.py fingerprint(). */
export function fingerprint(applied: Array<{ slug: string; file_sha256: string }>): string {
  const h = createHash('sha256');
  for (const o of [...applied].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))) {
    h.update(Buffer.concat([Buffer.from(o.slug), Buffer.from([0]), Buffer.from(o.file_sha256, 'hex'), Buffer.from([0])]));
  }
  return h.digest('hex');
}

export interface Skipped { slug: string; reason: string }

/** Upstream card data + the active overrides, as bytes. Deterministic; with nothing applied, the input itself. */
export function patchCardData(raw: Buffer, overrides: Override[]): { out: Buffer; applied: Override[]; skipped: Skipped[] } {
  const active = overrides.filter((o) => APPLIED.has(o.status));
  const spans = locateEntries(raw, new Set(active.map((o) => o.card.toLowerCase())));
  const applied: Override[] = [];
  const skipped: Skipped[] = [];
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const o of active) {
    const key = o.card.toLowerCase();
    const span = spans.get(key);
    if (!span) {
      skipped.push({ slug: o.slug, reason: `${o.card} is not in this card data` });
      continue;
    }
    // Several overrides of one card patch the entry in turn, like the Python tool's dict.
    const prior = edits.find((e) => e.start === span[0]);
    const entry = parseLossless(prior ? prior.text : raw.toString('utf8', span[0], span[1]));
    const have = entrySha256(entry);
    if (have !== o.applies_to.entry_sha256) {
      skipped.push({ slug: o.slug, reason: `stale: upstream changed ${o.card} since the override was written (entry ${have.slice(0, 12)}, override pins ${o.applies_to.entry_sha256.slice(0, 12)}); re-test, then retire or re-pin` });
      continue;
    }
    let patched: JValue;
    try {
      patched = applyPatch(entry, o.patch);
    } catch (err) {
      if (!(err instanceof OverrideError)) throw err;
      skipped.push({ slug: o.slug, reason: err.message });
      continue;
    }
    if (prior) prior.text = serialize(patched);
    else edits.push({ start: span[0], end: span[1], text: serialize(patched) });
    applied.push(o);
  }
  if (!applied.length) return { out: raw, applied, skipped };
  edits.sort((a, b) => a.start - b.start);
  const parts: Buffer[] = [];
  let at = 0;
  for (const e of edits) {
    parts.push(raw.subarray(at, e.start), Buffer.from(e.text, 'utf8'));
    at = e.end;
  }
  parts.push(raw.subarray(at));
  return { out: Buffer.concat(parts), applied, skipped };
}

// ---------------------------------------------------------------------------------------------------------------
// apply: card-data.json = card-data.upstream.json + overrides, and the sidecar (card_overrides.py build()).

const sha256File = (p: string) => sha256(readFileSync(p));
const readJson = (p: string): any => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

function writeAtomic(p: string, b: Buffer | string, mode = 0o644): void {
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, b);
  chmodSync(tmp, mode);
  renameSync(tmp, p);
}

/**
 * The pristine upstream card data in a data dir. card-data.json is our patched output only when the sidecar says so
 * (its sha256 matches and the upstream copy is intact); anything else in card-data.json is a fresh upstream copy.
 */
export function pristinePath(dataDir: string): string {
  const cur = join(dataDir, CARD_DATA);
  const up = join(dataDir, UPSTREAM_COPY);
  const side = readJson(join(dataDir, SIDECAR));
  if (!existsSync(cur)) {
    if (existsSync(up)) return up;
    throw new OverrideError(`no ${CARD_DATA} in ${dataDir}`);
  }
  if (side && existsSync(up) && side.sha256 === sha256File(cur) && side.upstream_sha256 === sha256File(up)) return up;
  return cur;
}

export interface Sidecar {
  _comment: string;
  format: 1;
  upstream_sha256: string;
  sha256: string;
  overrides_sha256: string;
  overrides: Array<{ slug: string; card: string; status: string; file_sha256: string; upstream_issue: string | null }>;
  /** Cards the applied overrides make supported (marks_supported): they come off the unsupported-card list. */
  supported: string[];
  skipped: Skipped[];
}

/** Write dataDir/card-data.json = upstream + overrides and its sidecar. Deterministic; unchanged files aren't rewritten. */
export function applyOverrides(dataDir: string, overrides: Override[]): Sidecar {
  const src = pristinePath(dataDir);
  const up = join(dataDir, UPSTREAM_COPY);
  if (src !== up) {
    copyFileSync(src, `${up}.tmp`);
    renameSync(`${up}.tmp`, up);
  }
  const raw = readFileSync(up);
  const { out, applied, skipped } = patchCardData(raw, overrides);
  const cur = join(dataDir, CARD_DATA);
  const outSha = sha256(out);
  if (!existsSync(cur) || sha256File(cur) !== outSha) writeAtomic(cur, out);
  const side: Sidecar = {
    _comment: 'Written by the card-data stage (packages/director/src/card-overrides.ts; scripts/card_overrides.py writes the same). card-data.json = card-data.upstream.json + these overrides.',
    format: 1,
    upstream_sha256: sha256(raw),
    sha256: outSha,
    overrides_sha256: fingerprint(applied),
    overrides: applied.map((o) => ({ slug: o.slug, card: o.card, status: o.status, file_sha256: o.file_sha256, upstream_issue: o.upstream_issue ?? null })),
    supported: supportedBy(applied),
    skipped,
  };
  const text = `${JSON.stringify(side, null, 2)}\n`;
  const sidePath = join(dataDir, SIDECAR);
  if (!existsSync(sidePath) || readFileSync(sidePath, 'utf8') !== text) writeAtomic(sidePath, text);
  return side;
}

// ---------------------------------------------------------------------------------------------------------------
// The unsupported-card list with the overrides that make cards supported (card_overrides.py adjust_unsupported).

/** Python's sort key (name.lower(), name): code points of the lower-cased name, then of the name. */
function byLowerThenName(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
}

/** Card names the applied overrides make supported (marks_supported), sorted as card_overrides.py supported_by(). */
export function supportedBy(applied: Array<{ card: string; marks_supported?: boolean }>): string[] {
  return [...new Set(applied.filter((o) => o.marks_supported).map((o) => o.card))].sort(byLowerThenName);
}

export interface UnsupportedDoc {
  unsupported: string[];
  /** What an earlier adjustment took off (the base list is `unsupported` + this). */
  removed_by_overrides?: string[];
  [k: string]: unknown;
}

/**
 * The unsupported-card list without the cards active overrides make supported. The base list is `unsupported` plus
 * `removed_by_overrides`, so adjusting again for other overrides (or none) restores it first. Unchanged input is
 * returned as is; a changed list is sorted, and `removed_by_overrides` is present only when non-empty.
 */
export function adjustUnsupported(doc: UnsupportedDoc, supported: string[]): { doc: UnsupportedDoc; changed: boolean } {
  const base = [...(doc.unsupported ?? []), ...(doc.removed_by_overrides ?? [])];
  const want = new Set(supported.map((n) => n.toLowerCase()));
  const removed = [...new Set(base.filter((n) => want.has(n.toLowerCase())))].sort(byLowerThenName);
  const before = doc.removed_by_overrides ?? [];
  if (removed.length === before.length && removed.every((n, i) => n === before[i])) return { doc, changed: false };
  const { unsupported: _u, removed_by_overrides: _r, ...rest } = doc;
  const out: UnsupportedDoc = { ...rest, unsupported: [...new Set(base.filter((n) => !want.has(n.toLowerCase())))].sort(byLowerThenName) };
  if (removed.length) out.removed_by_overrides = removed;
  return { doc: out, changed: true };
}
