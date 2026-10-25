import { promptVersionOf } from './prompts.js';

/**
 * How decisions are rendered for agents. It follows the event's prompt version, so an event run with prompts/v3
 * still gets exactly the v3 texts (a prompt version is a comparability group, METHODOLOGY §3):
 *  - 'v3' (prompts v1–v3): text board, card text the first time a card is seen in a game or draft;
 *  - 'v4' (prompts v4+): every game decision carries the whole visible game as JSON plus the printed data of every
 *    card in view; packs and pools use the same card JSON.
 */
export type ObservationFormat = 'v3' | 'v4';

/**
 * The observation format a prompts folder implies: the current prompts and archive v4 → 'v4'; archive v1–v3 → 'v3'.
 * Other folders (experiments) follow their name: "v<N>" below 4 → 'v3', anything else → 'v4'.
 */
export function observationFormat(promptsDir: string): ObservationFormat {
  const m = /^v(\d+)$/.exec(promptVersionOf(promptsDir));
  return m && Number(m[1]) < 4 ? 'v3' : 'v4';
}

/** What agents call the MTG Deck Tools set write-up: "set primer" up to prompt v3, "set context" from v4 on. */
export function setDocName(format: ObservationFormat | undefined): { lower: string; title: string; tool: string } {
  return format === 'v4'
    ? { lower: 'set context', title: 'SET CONTEXT', tool: 'get_set_context' }
    : { lower: 'set primer', title: 'SET PRIMER', tool: 'get_set_primer' };
}
