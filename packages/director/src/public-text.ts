/**
 * What every public output does to agent-written text and to the people behind it (docs/legal/PRIVACY.md,
 * docs/legal/CONTENT-POLICY.md). One module, used by every public path:
 *
 * - the Hub's JSON export (`/data`) and its run folders (packages/hub hub.ts), the open dataset (open-data/redact.ts),
 * - the Director's own `/data` export (packages/site build-data.ts), its spectator stream and replays (spectate.ts).
 *
 * Three things live here:
 * 1. **The scrubber** (`scrubText`, `scrubPublic`): API keys and tokens, JWTs, e-mail and IP addresses (v4 and v6) and
 *    file paths become `[secret]`, `[token]`, `[email]`, `[ip]`, `[path]`. NUL bytes are removed and a lone surrogate
 *    becomes U+FFFD, so a stored log can go into Postgres. Card names and rules text never match
 *    (public-text.test.ts checks a fixture of tricky card text, and every card when data/card-data.json is present).
 * 2. **The review filter** (`flagText`, `flagHandle`, `passesFilter`): a word list and a few patterns (links,
 *    impersonation). It flags; it never hides. Flagged text stays published but is never featured automatically.
 * 3. **Moderation** (`compileModeration`, `moderateRecord`): the Hub's hide list (single rules reports or archetypes,
 *    deck names, handles), takedowns and erased contributors, applied to raw log records. Hidden text reads
 *    `[Removed by moderators]`. Public records carry the seats' choices only: the one free-text field kept is a rules
 *    report's `note`.
 *
 * Lowest layer: imported by packages/site and packages/hub, imports nothing of theirs.
 */
import { readFileSync } from 'node:fs';
import { isIPv6 } from 'node:net';

// ---------------------------------------------------------------------------
// 1. Scrubber

/** What a hidden rules report, deck name or other agent text reads in every public output. */
export const REMOVED_TEXT = '[Removed by moderators]';

export function isRemovedText(s: unknown): boolean {
  return typeof s === 'string' && s.trim() === REMOVED_TEXT;
}

/** Shannon entropy in bits per character. */
function entropy(s: string): number {
  const n = new Map<string, number>();
  for (const c of s) n.set(c, (n.get(c) ?? 0) + 1);
  let h = 0;
  for (const k of n.values()) h -= (k / s.length) * Math.log2(k / s.length);
  return h;
}

/** A long run of base64/base64url characters that looks random: mixed case and digits, high entropy, not hex. */
function looksSecret(m: string): boolean {
  const core = m.replace(/=+$/, '');
  if (core.length < 32 || /^[0-9a-f]+$/i.test(core)) return false;
  if (!/[a-z]/.test(core) || !/[A-Z]/.test(core) || !/\d/.test(core)) return false;
  if ((core.match(/\//g) ?? []).length > 2) return false; // a URL path, not a key
  return entropy(core) >= 4;
}

type Rule = [RegExp, string | ((m: string, ...g: string[]) => string)];

/** Ordered: specific formats first, the generic high-entropy rule after them, then addresses and paths. */
const RULES: Rule[] = [
  // Private keys (PEM blocks).
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[secret]'],
  // Hub tokens (mtgdt_<scope>_<base64url>).
  [/\bmtgdt_[a-z]+_[A-Za-z0-9_-]{16,}/g, '[token]'],
  // Provider API keys: Anthropic (sk-ant-…), OpenAI (sk-…, sk-proj-…), xAI, Groq, Hugging Face, OpenRouter.
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, '[secret]'],
  [/\bsk-(?:proj-|svcacct-|admin-|or-v1-)?[A-Za-z0-9_-]{20,}/g, '[secret]'],
  [/\b(?:xai-|gsk_|hf_)[A-Za-z0-9_-]{20,}/g, '[secret]'],
  // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_, fine-grained github_pat_).
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, '[secret]'],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/g, '[secret]'],
  // AWS access key ids, and secrets named as such.
  [/\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g, '[secret]'],
  [/\b(aws_secret_access_key|aws_session_token|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)(["']?\s*[:=]\s*["']?)[A-Za-z0-9/+=]{16,}/g, '$1$2[secret]'],
  // Google API keys and OAuth access tokens.
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[secret]'],
  [/\bya29\.[0-9A-Za-z_-]{20,}/g, '[secret]'],
  // Slack and Stripe.
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[secret]'],
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, '[secret]'],
  // JWTs (header.payload.signature, base64url).
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[token]'],
  // Bearer tokens and secrets assigned by name (api_key=…, "password": "…"). Never a bare "token": a Magic word.
  [/\b(Bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/gi, '$1 [token]'],
  [/\b((?:api[_-]?key|apikey|x-api-key|secret[_-]?key|client[_-]?secret|access[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|passwd)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, '$1[secret]'],
  // Seat tokens: 32 hex characters (alone or in a seat URL).
  [/\/mcp\/[0-9a-f]{32}\b/g, '/mcp/[token]'],
  [/\b[0-9a-f]{32}\b/g, '[token]'],
  // Anything else that looks like a random key: 32+ base64 characters, mixed case and digits, high entropy.
  [/(?<![\w+/.-])[A-Za-z0-9+/_-]{32,}={0,2}(?![\w+/.-])/g, (m) => (looksSecret(m) ? '[secret]' : m)],
  // E-mail addresses.
  // (Only from the start of a run of address characters: a long run without "@" costs one pass, not one per start.)
  [/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '[email]'],
  // File paths: file:// URLs, Unix home, temp and system folders, ~/..., $HOME/..., Windows drive and UNC paths.
  [/file:\/\/[^\s"'`<>)\]]+/g, '[path]'],
  [/(?<![\w.:/])\/(?:home|Users|root|tmp|var|private|mnt|srv|opt|run|media|workspace|workspaces|app|hub-data|phase-data|etc|usr|Volumes|nix|snap|proc)(?:\/[^\s"'`<>)\],;]*)?/g, '[path]'],
  [/(?<![\w/])~\/[^\s"'`<>)\],;]+/g, '[path]'],
  [/(?:\$HOME|\$\{HOME\}|%USERPROFILE%|%APPDATA%|%LOCALAPPDATA%|%HOMEPATH%)[\\/][^\s"'`<>)\],;]*/g, '[path]'],
  [/\b[A-Za-z]:\\[^\s"'`<>)\],;]*/g, '[path]'],
  [/\b[A-Za-z]:\/(?!\/)[^\s"'`<>)\],;]*/g, '[path]'],
  [/(?<![\w\\])\\\\[A-Za-z0-9._$-]+\\[^\s"'`<>)\],;]*/g, '[path]'],
  // IPv6 (validated: times like 12:30:45 never match), then IPv4.
  [/(?<![\w:.])(?:[0-9A-Fa-f]{0,4}:){2,7}(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9A-Fa-f]{1,4})?(?:%[\w.]+)?(?![\w:])/g,
    (m) => (/[0-9a-f]/i.test(m) && isIPv6(m.replace(/%[\w.]+$/, '')) ? '[ip]' : m)],
  [/\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g, '[ip]'],
];

/**
 * Invisible characters no public text keeps (HUB-36): bidi controls, zero-width spaces, word joiners and invisible
 * operators, the byte-order mark, and Unicode tag characters, which render as nothing but language models still read
 * (a way to hide instructions from people for anyone who feeds the data to a model). A subdivision flag emoji (a black
 * flag, tag letters, a cancel tag) is kept whole. Zero-width joiners stay: emoji sequences and some scripts need them.
 */
const INVISIBLE = /(\u{1F3F4}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{1,7}\u{E007F})|[\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu;

/** A UTF-16 surrogate without its pair (not valid Unicode text; Postgres refuses it in jsonb). */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

export function stripInvisible(s: string): string {
  return s.replace(INVISIBLE, (_m, flag: string | undefined) => flag ?? '');
}

/** A string with secrets, tokens, paths, e-mail and IP addresses replaced by placeholders, invisible characters removed, and text Postgres can store (no NUL, no lone surrogate). Card text is unchanged. */
export function scrubText(s: string): string {
  if (!s) return s;
  let out = stripInvisible(s).replace(/\u0000/g, '').replace(LONE_SURROGATE, '\ufffd');
  for (const [re, to] of RULES) out = out.replace(re, to as string);
  return out;
}

/** Deep copy with every string value scrubbed (keys kept): for whole public files such as the JSON export. */
export function scrubPublic<T>(v: T): T {
  if (typeof v === 'string') return scrubText(v) as T;
  if (Array.isArray(v)) return v.map(scrubPublic) as T;
  if (v === null || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = scrubPublic(x);
  return out as T;
}

/** Keys of log records whose string values an agent wrote (deck details, rules reports, free answers). */
export const AGENT_TEXT_KEYS = ['note', 'deck_name', 'archetype', 'choice', 'card'] as const;

/**
 * Free-text keys no public record carries: seats answer with their choice only, so a `note` or `analysis` on a pick,
 * deck, decision, play/draw or sideboarding record (a log written by an older Director, or a harness that sent one
 * anyway) is dropped. A rules report's `note` (what the card did wrong) is the exception.
 */
const UNPUBLISHED_TEXT_KEYS = ['note', 'analysis'] as const;
const KEEPS_NOTE = new Set(['rules_issue']);

/** A log record without the free text no public record carries (UNPUBLISHED_TEXT_KEYS); the record itself when it has none. */
export function withoutUnpublishedText<T extends Record<string, any>>(r: T): T {
  if (!r || typeof r !== 'object' || KEEPS_NOTE.has(r.type) || !UNPUBLISHED_TEXT_KEYS.some((k) => k in r)) return r;
  const out: Record<string, any> = { ...r };
  for (const k of UNPUBLISHED_TEXT_KEYS) delete out[k];
  return out as T;
}

// ---------------------------------------------------------------------------
// 2. Review filter (docs/legal/CONTENT-POLICY.md "How we review")

/**
 * The default word list: slurs and abuse no note, deck name or handle needs. Matched as whole words after folding
 * case, accents and common character swaps (0→o, 1→i, 3→e, 4→a, 5→s, 7→t, @→a, $→s). Extend it with
 * MTGDT_MODERATION_WORDLIST (a file, one term per line, # comments): the owner's private list stays out of the repo.
 */
const DEFAULT_TERMS = [
  'fuck', 'fucking', 'fucker', 'motherfucker', 'shit', 'bullshit', 'cunt', 'cock', 'dick', 'pussy', 'whore', 'slut',
  'bitch', 'bastard', 'asshole', 'wanker', 'twat', 'porn', 'rape', 'rapist', 'nazi', 'hitler', 'kys', 'kill yourself',
  'nigger', 'nigga', 'faggot', 'fag', 'retard', 'retarded', 'tranny', 'kike', 'spic', 'chink', 'gook', 'wetback',
  'raghead', 'towelhead', 'coon', 'dyke',
];

/** Terms that also count inside a longer word in a handle (handles run words together). Only unambiguous ones. */
const HANDLE_SUBSTRING_TERMS = ['fuck', 'shit', 'cunt', 'nigger', 'nigga', 'faggot', 'retard', 'tranny', 'kike', 'whore', 'porn', 'hitler', 'nazi'];

/** Handles that could pass for us, the engine, a model lab or a moderator: flagged for review (never refused here). */
const IMPERSONATION = /^(?:mtg-?deck-?tools|mtgdt|agent-?bench|phase-?rs|anthropic|claude|openai|chatgpt|gpt|google|gemini|deepmind|xai|grok|meta|llama|mistral|deepseek|qwen|wizards|wotc|hasbro|17lands|admin|administrator|moderator|mod|staff|support|official|security|root|system)(?:[-_.]?(?:official|team|staff|admin|bot|support|ai|labs?|hq))?$/;

let extraTerms: string[] | null = null;
function wordList(): string[] {
  if (extraTerms === null) {
    extraTerms = [];
    const file = process.env.MTGDT_MODERATION_WORDLIST;
    if (file) {
      try {
        extraTerms = readFileSync(file, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim().toLowerCase()).filter(Boolean);
      } catch (e) {
        console.error(`moderation word list ${file} unreadable (${(e as Error).message}); using the default list only`);
      }
    }
  }
  return [...DEFAULT_TERMS, ...extraTerms];
}

/** Lowercase, no accents or zero-width characters, common character swaps undone. */
export function foldText(s: string): string {
  return s.normalize('NFKD').replace(/[\u0300-\u036f\u200b-\u200f\u2060\ufeff]/g, '').toLowerCase()
    .replace(/[0134578@$]/g, (c) => ({ '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', $: 's' })[c]!);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let compiledTerms: { key: string; re: RegExp } | null = null;
function termsRe(): RegExp {
  const list = wordList();
  const key = list.join('\n');
  if (compiledTerms?.key !== key) {
    // Whole words, with an optional plural; multi-word terms allow any run of spaces or punctuation between words.
    const alt = list.map((t) => t.split(/\s+/).map(escapeRe).join('[\\s\\W_]+')).sort((a, b) => b.length - a.length).join('|');
    compiledTerms = { key, re: new RegExp(`(?<![a-z])(?:${alt})(?:e?s)?(?![a-z])`, 'g') };
  }
  return compiledTerms.re;
}

const LINK = /\b(?:https?:\/\/|www\.)\S+|\b(?:discord\.gg|discord\.com\/invite|t\.me|bit\.ly|tinyurl\.com)\/\S+/i;

/** Why a piece of public agent text needs a reviewer (empty: it passes). Reasons: `word:<term>`, `link`. */
export function flagText(s: string | null | undefined): string[] {
  if (!s || isRemovedText(s)) return [];
  const out = new Set<string>();
  for (const m of foldText(s).matchAll(termsRe())) out.add(`word:${m[0].replace(/[\s\W_]+/g, ' ').trim()}`);
  if (LINK.test(s)) out.add('link');
  return [...out];
}

/** Why a handle needs a reviewer (empty: it passes). Reasons: `word:<term>`, `impersonation`. */
export function flagHandle(handle: string): string[] {
  const h = foldText(handle);
  const out = new Set<string>();
  for (const m of h.replace(/[-_.]+/g, ' ').matchAll(termsRe())) out.add(`word:${m[0].trim()}`);
  const squashed = h.replace(/[^a-z]/g, '');
  for (const t of HANDLE_SUBSTRING_TERMS) if (squashed.includes(t)) out.add(`word:${t}`);
  if (IMPERSONATION.test(handle.toLowerCase())) out.add('impersonation');
  return [...out];
}

/** True when text may be featured automatically (highlights, model pages): not hidden and nothing flagged. */
export function passesFilter(s: string | null | undefined): boolean {
  return !!s && !isRemovedText(s) && flagText(s).length === 0;
}

// ---------------------------------------------------------------------------
// 3. Moderation (the Hub's lists, applied to raw log records)

/** The Hub's moderation state as it travels to a Director (GET /api/internal/moderation) and into build-data. */
export interface ModerationList {
  /** Changes whenever anything below changes. */
  version: string;
  /** Events taken down: served nowhere. */
  takedowns: string[];
  /** Hidden agent text: kind 'note' (item: a note key, see noteItem) or 'deck_name' (item ''). */
  hides: Array<{ kind: 'note' | 'deck_name'; event: string; seat: string; item: string }>;
  /** Contributor ids (Hub ids, as strings) whose handle is never shown: hidden by moderators. */
  hiddenHandles: string[];
  /** Erased contributors: their Hub id is replaced by an anonymous id everywhere, their handle dropped. */
  erased: Array<{ id: string; anon: string }>;
}

export const EMPTY_MODERATION: ModerationList = { version: 'none', takedowns: [], hides: [], hiddenHandles: [], erased: [] };

export interface CompiledModeration {
  version: string;
  takedowns: Set<string>;
  /** `${event}\u0000${seat}\u0000${item}` for notes, `${event}\u0000${seat}` for deck names. */
  notes: Set<string>;
  deckNames: Set<string>;
  /** Events with any hidden text (a cached replay of them is stale after a change). */
  touched: Set<string>;
  hiddenHandles: Set<string>;
  erased: Map<string, string>;
}

export function compileModeration(m: ModerationList | null | undefined): CompiledModeration {
  const l = m ?? EMPTY_MODERATION;
  const notes = new Set<string>();
  const deckNames = new Set<string>();
  const touched = new Set<string>();
  for (const h of l.hides ?? []) {
    if (h.kind === 'note') notes.add(`${h.event}\u0000${h.seat}\u0000${h.item}`);
    else if (h.kind === 'deck_name') deckNames.add(`${h.event}\u0000${h.seat}`);
    touched.add(h.event);
  }
  return {
    version: l.version ?? 'none', takedowns: new Set(l.takedowns ?? []), notes, deckNames, touched,
    hiddenHandles: new Set((l.hiddenHandles ?? []).map(String)), erased: new Map((l.erased ?? []).map((e) => [String(e.id), String(e.anon)])),
  };
}

/** Whether a compiled list changes anything at all (fast path for the common case). */
export function isEmptyModeration(c: CompiledModeration): boolean {
  return !c.takedowns.size && !c.notes.size && !c.deckNames.size && !c.hiddenHandles.size && !c.erased.size;
}

/**
 * The text key of an agent-text record a moderator can hide (moderation kind 'note'), and the seat it belongs to
 * (undefined: the record holds no such text). Keys: `deck` (the deck's archetype; its name is a 'deck_name' hide) and
 * `rules-<t>` (a rules report). `npm run hub -- moderation notes <event>` lists them.
 */
export function noteItem(r: Record<string, any>): { seat: string; item: string } | undefined {
  switch (r?.type) {
    case 'deck_built': return typeof r.seat === 'string' ? { seat: r.seat, item: 'deck' } : undefined;
    case 'rules_issue': return typeof r.seat === 'string' ? { seat: r.seat, item: `rules-${r.t}` } : undefined;
    default: return undefined;
  }
}

/** The agent-written fields a text hide replaces, per record type. */
const NOTE_FIELDS: Record<string, string[]> = { deck_built: ['archetype'], rules_issue: ['note'] };

/** The text a 'note' hide covers in a record (noteItem), joined; '' when there is none. Deck names are separate. */
export function noteText(r: Record<string, any>): string {
  return (NOTE_FIELDS[r?.type] ?? []).map((k) => r[k]).filter((v): v is string => typeof v === 'string' && !!v && !isRemovedText(v)).join(' · ');
}

function contributorFields(o: Record<string, any>, c: CompiledModeration, handleKeys: string[]): Record<string, any> {
  const id = o.contributor_id != null ? String(o.contributor_id) : undefined;
  if (!id) return o;
  const anon = c.erased.get(id);
  if (!anon && !c.hiddenHandles.has(id)) return o;
  const out = { ...o };
  for (const k of handleKeys) delete out[k];
  if (anon) out.contributor_id = anon;
  return out;
}

/**
 * A raw log record as public outputs show it: free text other than a rules report dropped (UNPUBLISHED_TEXT_KEYS),
 * agent text scrubbed, hidden rules reports, archetypes and deck names replaced by REMOVED_TEXT, erased contributors
 * anonymized, hidden handles dropped. Returns the record itself when nothing
 * changes (most records). `eventId`: the event the record belongs to (event_start.id).
 */
export function moderateRecord<T extends Record<string, any>>(r: T, eventId: string | undefined, c: CompiledModeration): T {
  if (!r || typeof r !== 'object') return r;
  const kept = withoutUnpublishedText(r);
  let out: Record<string, any> | null = kept === r ? null : kept;
  const set = (k: string, v: unknown) => {
    out ??= { ...r };
    out[k] = v;
  };
  for (const k of AGENT_TEXT_KEYS) {
    const v = (out ?? r)[k];
    if (typeof v === 'string' && v) {
      const s = scrubText(v);
      if (s !== v) set(k, s);
    }
  }
  if (eventId && (c.notes.size || c.deckNames.size) && c.touched.has(eventId)) {
    const n = noteItem(r);
    if (n && c.notes.has(`${eventId}\u0000${n.seat}\u0000${n.item}`)) {
      for (const k of NOTE_FIELDS[r.type] ?? []) if (typeof r[k] === 'string' && r[k]) set(k, REMOVED_TEXT);
    }
    if (r.type === 'deck_built' && typeof r.seat === 'string' && typeof r.deck_name === 'string' && r.deck_name && c.deckNames.has(`${eventId}\u0000${r.seat}`)) set('deck_name', REMOVED_TEXT);
  }
  if (r.type === 'event_start' && (c.hiddenHandles.size || c.erased.size)) {
    if (Array.isArray(r.seats)) {
      const seats = r.seats.map((s: Record<string, any>) => (s && typeof s === 'object' ? contributorFields(s, c, ['contributor', 'handle']) : s));
      if (seats.some((s: unknown, i: number) => s !== r.seats[i])) set('seats', seats);
    }
    if (r.organizer && typeof r.organizer === 'object') {
      const o = contributorFields(r.organizer, c, ['handle']);
      if (o !== r.organizer) set('organizer', o);
    }
  }
  return (out ?? r) as T;
}

/** A whole log (JSONL text) through moderateRecord; malformed lines are kept as they are. */
export function moderateLog(text: string, c: CompiledModeration): string {
  let eventId: string | undefined;
  const lines = text.split('\n');
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    let r: Record<string, any>;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r?.type === 'event_start' && typeof r.id === 'string') eventId = r.id;
    const m = moderateRecord(r, eventId, c);
    if (m !== r) {
      lines[i] = JSON.stringify(m);
      changed = true;
    }
  }
  return changed ? lines.join('\n') : text;
}

/** The list a Director or build-data reads from a file (MTGDT_MODERATION_FILE); empty when there is none. */
export function readModerationFile(path: string | undefined): CompiledModeration {
  if (!path) return compileModeration(null);
  try {
    return compileModeration(JSON.parse(readFileSync(path, 'utf8')) as ModerationList);
  } catch {
    return compileModeration(null);
  }
}
