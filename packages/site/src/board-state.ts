/**
 * The board at a decision, for visual replays (export 2.23, `TimelineEntry.state`): read from the view the agent saw
 * (prompts v4+: "Everything you can see, as JSON: …" then a JSON object with `state`), with "you" and "opponent"
 * mapped to the two seats. Public zones of both players (battlefields, graveyards, exile, the stack, life, hand and
 * library counts) plus the deciding seat's own hand.
 *
 * It is derived from the decision text, so it is withheld exactly when the text is: live redaction blanks the text
 * of a decision whose hidden information isn't released yet (live-redact.ts), and an empty text has no state. Older
 * views (the text format before v4) have no JSON and no state.
 */
import type { BoardState, BoardPerm } from './schema.js';

/** The first complete JSON object in `text` at or after `from`, or undefined (strings and escapes respected). */
export function firstJsonObject(text: string, from = 0): unknown {
  const start = text.indexOf('{', from);
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

const MARKER = 'Everything you can see, as JSON';
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v.slice(0, 200) : undefined);
const obj = (v: unknown): Record<string, any> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : undefined);
const names = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => str(obj(x)?.card) ?? str(x)).filter((x): x is string => !!x) : []);

/** One battlefield entry; grouped entries (`ids: [..]`, identical lands) become one permanent per object. */
function perms(v: unknown): BoardPerm[] {
  if (!Array.isArray(v)) return [];
  const out: BoardPerm[] = [];
  for (const raw of v) {
    const p = obj(raw);
    const card = str(p?.card);
    if (!p || !card) continue;
    const base: Omit<BoardPerm, 'id'> = {
      card,
      ...(p.tapped === true ? { tapped: true } : {}),
      ...(str(p.pt) ? { pt: str(p.pt) } : {}),
      ...(num(p.loyalty) != null ? { loyalty: num(p.loyalty) } : {}),
      ...(obj(p.counters) ? { counters: Object.fromEntries(Object.entries(p.counters).filter(([, n]) => typeof n === 'number')) as Record<string, number> } : {}),
      ...(Array.isArray(p.keywords) || Array.isArray(p.granted)
        ? { keywords: [...new Set([...(p.keywords ?? []), ...(p.granted ?? [])].filter((k: unknown): k is string => typeof k === 'string'))].slice(0, 20) }
        : {}),
      ...(p.sick === true ? { sick: true } : {}),
      ...(num(p.damage) ? { damage: num(p.damage) } : {}),
      ...(p.token === true ? { token: true } : {}),
      ...(num(p.attached_to) != null ? { attached_to: num(p.attached_to) } : {}),
    };
    const ids: number[] = Array.isArray(p.ids) ? p.ids.filter((x: unknown): x is number => typeof x === 'number') : num(p.id) != null ? [p.id] : [];
    for (const id of ids.length ? ids : [-1]) out.push({ id, ...base });
  }
  return out;
}

/** "you" / "opponent" → seats; anything else is kept only if it is already a seat. */
const sideOf = (k: string, seat: string, other: string): string | null => (k === 'you' ? seat : k === 'opponent' ? other : k === seat || k === other ? k : null);

/** The board a decision's view shows, or undefined when the view has no JSON state (older formats, withheld text). */
export function boardStateOf(text: string | undefined, seat: string, other: string): BoardState | undefined {
  if (!text) return undefined;
  const at = text.indexOf(MARKER);
  if (at < 0) return undefined;
  const view = obj(firstJsonObject(text, at));
  const st = obj(view?.state);
  if (!st) return undefined;
  const side = (k: unknown) => (typeof k === 'string' ? sideOf(k, seat, other) : null);
  const player = (k: 'you' | 'opponent') => {
    const p = obj(st[k]) ?? {};
    const who = k === 'you' ? seat : other;
    const zone = (z: string) => {
      const v = st[z];
      if (Array.isArray(v)) return names(v.filter((x) => side(obj(x)?.owner ?? obj(x)?.controller) === who));
      return names(obj(v)?.[k]);
    };
    return {
      life: num(p.life) ?? 0,
      hand: num(p.hand) ?? 0,
      library: num(p.library) ?? 0,
      ...(num(p.poison) ? { poison: num(p.poison) } : {}),
      graveyard: zone('graveyard'),
      exile: zone('exile'),
      battlefield: perms(obj(st.battlefield)?.[k]),
    };
  };
  const stack = (Array.isArray(st.stack) ? st.stack : []).map((x) => obj(x)).filter((x): x is Record<string, any> => !!x && !!str(x.card)).map((x) => ({
    card: str(x.card)!,
    controller: side(x.controller),
    kind: str(x.kind) ?? 'spell',
    ...(str(x.text) ? { text: str(x.text) } : {}),
    ...(Array.isArray(x.targets) ? { targets: names(x.targets) } : {}),
  }));
  const hand = names(st.hand);
  return {
    turn: num(st.turn) ?? 0,
    step: str(st.step) ?? null,
    active: side(st.active),
    priority: side(st.priority),
    players: { [seat]: player('you'), [other]: player('opponent') },
    stack,
    hand: { seat, cards: hand },
  };
}
