/**
 * Shape and size limits on untrusted bundle content, checked before anything is derived from it.
 *
 * validateBundle (packages/director/src/submissions.ts) checks the bundle's structure and hashes; everything
 * else in events.jsonl and summary.json is free-form JSON written by whoever made the bundle. The export
 * (packages/site) turns it into HTML and JSON that mtgdecktools.com renders, and file paths (sets/<CODE>.json),
 * so the fields that reach paths, markup or loops must have the type and size the Director writes. A bundle
 * that breaks one of these limits was not written by a Director: it is rejected as structurally invalid.
 * See docs/SECURITY.md (the site export).
 */

import { SET_CODE_RE } from '../../site/src/data.js';

/** Set codes are path segments (sets/<CODE>.json) and URL parts. */
export { SET_CODE_RE };
/** Seat names are object keys in the export; SEAT_NAME_RE (Director) allows these. */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** Identity strings (harness, model, effort…): short, printable, no markup characters. */
const IDENTITY_RE = /^[^\u0000-\u001f\u007f<>"'`\\]{0,100}$/;

export const LIMITS = {
  note: 4_000,
  cardName: 200,
  text: 200_000,
  label: 200,
  turn: 10_000,
  count: 100_000,
  options: 2_000,
  cardsPlayed: 1_000,
  /** Cards in one deck list (main or sideboard): a pool is 42–45 cards plus basics. */
  deckCards: 500,
} as const;

/** Record times are Unix ms; nothing after 2100-01-01 (a time like 8.6e15 would make year-275760 dates). */
const T_MAX = Date.UTC(2100, 0, 1);

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x);
const isInt = (x: unknown, max: number, min = 0) => typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max;

export function sanityErrors(files: Map<string, Buffer>): string[] {
  const errors: string[] = [];
  const err = (m: string) => {
    if (errors.length < 20) errors.push(m);
  };
  const str = (where: string, x: unknown, max: number, opt = true) => {
    if (x === undefined || x === null) {
      if (!opt) err(`${where} is missing`);
      return;
    }
    if (typeof x !== 'string') err(`${where} must be a string`);
    else if (x.length > max) err(`${where} is longer than ${max} characters`);
  };
  const int = (where: string, x: unknown, max: number, min = 0) => {
    if (x === undefined || x === null) return;
    if (!isInt(x, max, min)) err(`${where} must be an integer from ${min} to ${max}`);
  };

  const lines = files.get('events.jsonl')?.toString('utf8').split('\n') ?? [];
  let n = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    n++;
    let e: Obj;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // reported by validateBundle
    }
    if (!isObj(e)) continue;
    const at = `events.jsonl record ${n} (${String(e.type).slice(0, 40)})`;
    // Times are informational (points use the Hub's acceptance time, PTS-1), but they reach dates in the export.
    if ('t' in e && !(typeof e.t === 'number' && Number.isInteger(e.t) && e.t >= 0 && e.t <= T_MAX)) err(`${at}: t must be a Unix time in milliseconds, before 2100`);
    if (e.type === 'event_start') {
      const set = e.set as Obj | undefined;
      if (!isObj(set) || typeof set.code !== 'string' || !SET_CODE_RE.test(set.code)) err('event_start.set.code must be 2–8 letters or digits');
      else str('event_start.set.name', set.name, LIMITS.label);
      for (const k of ['seed', 'mana', 'prompt_version', 'ratings']) str(`event_start.${k}`, e[k], LIMITS.label);
      int('event_start.best_of', e.best_of, 9, 1);
      if (e.sideboarding !== undefined && typeof e.sideboarding !== 'boolean') err('event_start.sideboarding must be true or false');
      str('event_start.play_draw', e.play_draw, 40);
      if (e.knowledge !== undefined && !isObj(e.knowledge)) err('event_start.knowledge must be an object');
      else if (isObj(e.knowledge)) str('event_start.knowledge.level', e.knowledge.level, 40);
      const seats = Array.isArray(e.seats) ? (e.seats as unknown[]) : [];
      if (seats.length > 64) err('event_start.seats: more than 64 seats');
      for (const s of seats) {
        if (!isObj(s)) {
          err('event_start.seats: every seat must be an object');
          continue;
        }
        const name = String(s.name);
        if (RESERVED_KEYS.has(name)) err(`seat name "${name}" is reserved`);
        int(`seat ${name}: position`, s.position, 63);
        for (const k of ['kind', 'harness', 'model', 'model_id', 'effort']) {
          if (s[k] === undefined || s[k] === null) continue;
          if (typeof s[k] !== 'string' || !IDENTITY_RE.test(s[k] as string)) err(`seat ${name}: ${k} must be a short string without markup characters`);
        }
      }
      continue;
    }
    if ('turn' in e) int(`${at}: turn`, e.turn, LIMITS.turn);
    if ('note' in e) str(`${at}: note`, e.note, LIMITS.note);
    if ('card' in e) str(`${at}: card`, e.card, LIMITS.cardName);
    if ('text' in e) str(`${at}: text`, e.text, LIMITS.text);
    if ('seat' in e && typeof e.seat === 'string' && RESERVED_KEYS.has(e.seat)) err(`${at}: seat name is reserved`);
    if (e.type === 'decision_offered' && e.options !== undefined) {
      if (!Array.isArray(e.options) || e.options.length > LIMITS.options) err(`${at}: options must be a list of at most ${LIMITS.options}`);
      else if (e.options.some((o) => typeof o !== 'string' || o.length > LIMITS.text)) err(`${at}: options must be strings`);
    }
    if (e.type === 'agent_decision' && e.choice !== undefined && typeof e.choice === 'string') str(`${at}: choice`, e.choice, LIMITS.text);
    if (e.type === 'game_start' && e.deck_sizes !== undefined && e.deck_sizes !== null) {
      if (!isObj(e.deck_sizes)) err(`${at}: deck_sizes must be an object`);
      else for (const v of Object.values(e.deck_sizes)) int(`${at}: deck_sizes`, v, LIMITS.deckCards);
    }
    // Best of 3 with sideboarding (2026-10-22 on): play_draw and sideboarded records reach the export's games.
    if (e.type === 'play_draw' || e.type === 'sideboarded') {
      str(`${at}: match`, e.match, LIMITS.label * 2, false);
      int(`${at}: game_number`, e.game_number, 9, 1);
      str(`${at}: by`, e.by, 20);
      int(`${at}: latency_ms`, e.latency_ms, Number.MAX_SAFE_INTEGER);
    }
    if (e.type === 'play_draw') {
      for (const k of ['on_play', 'chooser', 'choice']) str(`${at}: ${k}`, e[k], LIMITS.label, k !== 'on_play' ? true : false);
    }
    if (e.type === 'sideboarded') {
      for (const k of ['main', 'sideboard']) {
        const xs = e[k];
        if (!Array.isArray(xs) || xs.length > LIMITS.deckCards) err(`${at}: ${k} must be a list of at most ${LIMITS.deckCards} card names`);
        else if (xs.some((c) => typeof c !== 'string' || c.length > LIMITS.cardName)) err(`${at}: ${k} must be card names`);
      }
      for (const k of ['in', 'out']) {
        const xs = e[k];
        if (xs === undefined || xs === null) continue;
        if (!Array.isArray(xs) || xs.length > LIMITS.deckCards) err(`${at}: ${k} must be a list of at most ${LIMITS.deckCards} entries`);
        else for (const c of xs) {
          if (!isObj(c) || typeof c.name !== 'string' || c.name.length > LIMITS.cardName) err(`${at}: ${k} entries need a card name`);
          else int(`${at}: ${k} qty`, c.qty, LIMITS.deckCards, 1);
        }
      }
      if (e.basics !== undefined && e.basics !== null) {
        if (!isObj(e.basics)) err(`${at}: basics must be an object`);
        else for (const [b, v] of Object.entries(e.basics)) {
          if (b.length > LIMITS.cardName) err(`${at}: basics: name too long`);
          int(`${at}: basics`, v, LIMITS.deckCards);
        }
      }
      int(`${at}: main_count`, e.main_count, LIMITS.deckCards);
      if (e.kept !== undefined && typeof e.kept !== 'boolean') err(`${at}: kept must be true or false`);
    }
    if (e.type === 'game_over') {
      int(`${at}: turns`, e.turns, LIMITS.turn);
      if (e.stats !== undefined && e.stats !== null) {
        if (!isObj(e.stats)) err(`${at}: stats must be an object`);
        else {
          for (const [seat, st] of Object.entries(e.stats)) {
            if (!isObj(st)) {
              err(`${at}: stats.${seat} must be an object`);
              continue;
            }
            for (const [k, v] of Object.entries(st)) int(`${at}: stats.${seat}.${k}`, v, LIMITS.count);
          }
        }
      }
      if (e.cards_played !== undefined && e.cards_played !== null) {
        if (!isObj(e.cards_played)) err(`${at}: cards_played must be an object`);
        else {
          for (const [seat, rec] of Object.entries(e.cards_played)) {
            if (!isObj(rec)) {
              err(`${at}: cards_played.${seat} must be an object`);
              continue;
            }
            for (const how of ['cast', 'activated']) {
              const counts = rec[how];
              if (counts === undefined || counts === null) continue;
              if (!isObj(counts)) err(`${at}: cards_played.${seat}.${how} must be an object`);
              else for (const [card, v] of Object.entries(counts)) {
                if (card.length > LIMITS.cardName) err(`${at}: cards_played card name too long`);
                int(`${at}: cards_played.${seat}.${how}`, v, LIMITS.cardsPlayed);
              }
            }
          }
        }
      }
      for (const k of ['final_life', 'mulligans']) {
        const m = e[k];
        if (m === undefined || m === null) continue;
        if (!isObj(m)) err(`${at}: ${k} must be an object`);
        else for (const v of Object.values(m)) int(`${at}: ${k}`, v, LIMITS.count, -LIMITS.count);
      }
    }
  }

  const rawSummary = files.get('summary.json');
  if (rawSummary) {
    let s: unknown;
    try {
      s = JSON.parse(rawSummary.toString('utf8'));
    } catch {
      s = undefined; // reported by validateBundle
    }
    if (isObj(s) && s.standings !== undefined) {
      if (!Array.isArray(s.standings)) err('summary.json standings must be a list');
      else {
        const names = new Set<string>();
        for (const st of s.standings) {
          if (!isObj(st) || typeof st.name !== 'string') {
            err('summary.json standings entries need a name');
            continue;
          }
          if (names.has(st.name)) err(`summary.json lists ${st.name} twice`);
          names.add(st.name);
          for (const k of ['matchWins', 'matchLosses', 'gameWins', 'gameLosses']) int(`summary.json ${st.name}.${k}`, st[k], LIMITS.count);
        }
      }
    }
  }
  return errors;
}
