/**
 * What every public output does to agent-written text and to the people behind it (docs/legal/PRIVACY.md,
 * docs/legal/CONTENT-POLICY.md). One module, used by every public path:
 *
 * - the Hub's JSON export (`/data`) and its run folders (packages/hub hub.ts), the open dataset (open-data/redact.ts),
 * - the Director's own `/data` export (packages/site build-data.ts), its spectator stream and replays (spectate.ts).
 *
 * Three things live here:
 * 1. **The scrubber** (`scrubText`, `scrubPublic`): API keys and tokens, JWTs, e-mail and IP addresses (v4 and v6) and
 *    file paths become `[secret]`, `[token]`, `[email]`, `[ip]`, `[path]`. Card names and rules text never match
 *    (public-text.test.ts checks a fixture of tricky card text, and every card when data/card-data.json is present).
 * 2. **The review filter** (`flagText`, `flagHandle`, `passesFilter`): a word list and a few patterns (links,
 *    impersonation). It flags; it never hides. Flagged text stays published but is never featured automatically.
 * 3. **Moderation** (`compileModeration`, `moderateRecord`): the Hub's hide list (single notes, deck names, handles),
 *    takedowns and erased contributors, applied to raw log records. Hidden text reads `[Removed by moderators]`.
 *
 * Lowest layer: imported by packages/site and packages/hub, imports nothing of theirs.
 */
import { readFileSync } from 'node:fs';
import { isIPv6 } from 'node:net';

// ---------------------------------------------------------------------------
// 1. Scrubber

/** What a hidden note, deck name or other agent text reads in every public output. */
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

/** A string with secrets, tokens, paths, e-mail and IP addresses replaced by placeholders. Card text is unchanged. */
export function scrubText(s: string): string {
  if (!s) return s;
  let out = s;
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

/** Keys of log records whose string values an agent wrote (notes, deck details, rules reports, free answers). */
export const AGENT_TEXT_KEYS = ['note', 'analysis', 'deck_name', 'archetype', 'choice', 'card'] as const;

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
 * The note key of an agent-text record, and the seat it belongs to (undefined: the record holds no agent note).
 * Keys: a game decision's id (`G42`), `pick-<overall pick>`, `deck` (the deck's note, analysis and archetype),
 * `play-draw-<t>`, `sideboard-<t>`, `rules-<t>`. `npm run hub -- moderation notes <event>` lists them.
 */
export function noteItem(r: Record<string, any>): { seat: string; item: string } | undefined {
  switch (r?.type) {
    case 'agent_decision': return typeof r.seat === 'string' && r.id != null ? { seat: r.seat, item: String(r.id) } : undefined;
    case 'draft_pick': return typeof r.seat === 'string' && r.overall_pick != null ? { seat: r.seat, item: `pick-${r.overall_pick}` } : undefined;
    case 'deck_built': return typeof r.seat === 'string' ? { seat: r.seat, item: 'deck' } : undefined;
    case 'play_draw': {
      const seat = r.chooser ?? r.on_play;
      return typeof seat === 'string' ? { seat, item: `play-draw-${r.t}` } : undefined;
    }
    case 'sideboarded': return typeof r.seat === 'string' ? { seat: r.seat, item: `sideboard-${r.t}` } : undefined;
    case 'rules_issue': return typeof r.seat === 'string' ? { seat: r.seat, item: `rules-${r.t}` } : undefined;
    default: return undefined;
  }
}

/** The agent-written fields a note hide replaces, per record type. */
const NOTE_FIELDS: Record<string, string[]> = { deck_built: ['note', 'analysis', 'archetype'], rules_issue: ['note'] };

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
 * A raw log record as public outputs show it: agent text scrubbed, hidden notes and deck names replaced by
 * REMOVED_TEXT, erased contributors anonymized, hidden handles dropped. Returns the record itself when nothing
 * changes (most records). `eventId`: the event the record belongs to (event_start.id).
 */
export function moderateRecord<T extends Record<string, any>>(r: T, eventId: string | undefined, c: CompiledModeration): T {
  if (!r || typeof r !== 'object') return r;
  let out: Record<string, any> | null = null;
  const set = (k: string, v: unknown) => {
    out ??= { ...r };
    out[k] = v;
  };
  for (const k of AGENT_TEXT_KEYS) {
    const v = r[k];
    if (typeof v === 'string' && v) {
      const s = scrubText(v);
      if (s !== v) set(k, s);
    }
  }
  if (eventId && (c.notes.size || c.deckNames.size) && c.touched.has(eventId)) {
    const n = noteItem(r);
    if (n && c.notes.has(`${eventId}\u0000${n.seat}\u0000${n.item}`)) {
      for (const k of NOTE_FIELDS[r.type] ?? ['note']) if (typeof r[k] === 'string' && r[k]) set(k, REMOVED_TEXT);
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
