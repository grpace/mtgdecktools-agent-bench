import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { CardDb } from './cards.js';
import { directorVersion } from './provenance.js';
import { stripInvisible } from './public-text.js';
import { BodyTooLarge, clientIp, RateLimiter, readLimited, tooLarge } from './ratelimit.js';
import { AgentSeat } from './seat.js';

export const SEAT_INSTRUCTIONS = `You are one player in a Magic: The Gathering limited event against other AI agents: FORMAT.
Loop: call wait_for_decision; read it; call decide with your choice and a short note; repeat until a result says EVENT COMPLETE.
- wait_for_decision returns after ~40 s with a status line while others are still deciding; just call it again. Waits between rounds of matches can take 10–30 minutes: keep calling it until EVENT COMPLETE, even when you have no match right now.
- decide usually returns your next decision directly.
- Draft picks and the deck use option numbers / pool numbers. In games, card ids look like [#42] and stay fixed for the whole game.
- Trivial priority passes are handled for you, so every decision you see matters. Play to win.
- If a card doesn't work the way its rules text says (the engine refuses a listed option, an effect does nothing or the wrong thing), call report_rules_issue with the card and what happened. It never changes the game; it helps us flag engine bugs.`;

/** Prompt v4 seats: same loop, plus how to read the JSON state. */
export const SEAT_INSTRUCTIONS_V4 = `You are one player in a Magic: The Gathering limited event against other AI agents: FORMAT.
Loop: call wait_for_decision; read it; call decide with your choice and a short note; decide returns your next decision, so call one tool at a time and don't call wait_for_decision after it unless it says to. Repeat until a result says EVENT COMPLETE.
- wait_for_decision returns after ~40 s with a status line while others are still deciding; just call it again. Waits between rounds of matches can take 10–30 minutes: keep calling it until EVENT COMPLETE, even when you have no match right now.
- Draft picks and the deck use option numbers / pool numbers ("n" in the card JSON); to play several copies of a card in your deck, repeat its pool number.
- Matches are best of 3. Before games 2 and 3 the loser of the previous game chooses to play or draw, then both players may sideboard: option "keep", or the whole deck again (pool numbers and basics).
- Every game decision is a summary line and one JSON object: events since your last decision, the whole visible game (state), the printed data of every card in view (cards) and your options (decision). Object ids ("id", shown as [#42] in labels and events) stay fixed for the whole game.
- Trivial priority passes are handled for you, so every decision you see matters. Play to win.
- If a card doesn't work the way its rules text says (the engine refuses a listed option, an effect does nothing or the wrong thing), call report_rules_issue with the card and what happened. It never changes the game; it helps us flag engine bugs.`;

const WAIT_MS = 40_000;

/**
 * Characters agent-written text never keeps (notes, deck names, analysis, rules reports, option text): C0/C1 controls
 * except tab and newline (NUL breaks Postgres text and jsonb; ESC sequences drive terminals), and invisible or bidi
 * formatting characters that can disguise text for a maintainer reading a log or the review queue. Lone surrogates
 * become U+FFFD. The text goes to the event log, the spectator stream, bundles and the site.
 */
const UNSAFE_TEXT = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/**
 * The CORS header of the Director's public reads (the report export under /data/, live streams, the lobby's public
 * views), for answers sent before a route runs (429, 500), so a browser sees them like the route's own answers. Never
 * for admin, seat or authenticated routes.
 */
export function publicReadCors(req: IncomingMessage): Record<string, string> {
  if (req.method !== 'GET') return {};
  const path = (req.url ?? '').split('?')[0]!;
  return /^\/data\/|^\/api\/events\/[^/]+\/live$|^\/api\/lobby(\/(?!tickets\/)|$)/.test(path) ? { 'Access-Control-Allow-Origin': '*' } : {};
}

export function cleanAgentText(s: string): string {
  // String.prototype.toWellFormed (Node 20+; not in this project's TypeScript lib yet).
  // Invisible and bidi characters (and Unicode tag characters) go by the public scrubber's own list (public-text.ts).
  return stripInvisible((s as string & { toWellFormed(): string }).toWellFormed().replace(UNSAFE_TEXT, ''));
}

/** Every string an agent sends with decide, cleaned (cleanAgentText); numbers and structure untouched. */
export function cleanDecideInput<T extends Record<string, unknown>>(input: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') out[k] = cleanAgentText(v);
    else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === 'string' ? cleanAgentText(x) : x));
    else if (k === 'basics' && v && typeof v === 'object') out[k] = Object.fromEntries(Object.entries(v).map(([n, c]) => [cleanAgentText(n), c]));
    else out[k] = v;
  }
  return out as T;
}

/** Engine object ids and pool numbers: whole numbers in the engine's id range (never floats, negatives or 1e308). */
const objectId = z.number().int().min(0).max(2_147_483_647);
/**
 * Basic lands for a deck: at most 12 names (there are 6 basic types; case and spacing variants are refused later) and
 * 120 lands in all. Unbounded, case/space variants of "Island" × 40 each made decks of 100,000+ cards (SEC-3).
 */
const MAX_BASIC_KEYS = 12;
const MAX_BASIC_LANDS = 120;
const basicsSchema = z.record(z.string().max(40), z.number().int().min(0).max(40))
  .refine((r) => Object.keys(r).length <= MAX_BASIC_KEYS, { message: `basics: at most ${MAX_BASIC_KEYS} entries` })
  .refine((r) => Object.values(r).reduce((a, n) => a + n, 0) <= MAX_BASIC_LANDS, { message: `basics: at most ${MAX_BASIC_LANDS} basic lands in all` });

/** JSON-RPC messages in one HTTP request (MCP 2025-06-18 dropped batches; older clients batch a few at most). */
export const MAX_BATCH = 4;

export type SeatLookup = (token: string) => AgentSeat | undefined;

/** The instructions for one seat: its event's format instead of a fixed one. */
export function seatInstructions(seat: AgentSeat | undefined): string {
  const format = seat?.formatLine ?? 'a booster draft, then deckbuilding, then matches (the first decision gives the exact format)';
  return (seat?.observation === 'v4' ? SEAT_INSTRUCTIONS_V4 : SEAT_INSTRUCTIONS).replace('FORMAT', format);
}

/** One part of the Set Context (1-based), with where it sits and how to get the next one. */
export function setContextPart(seat: AgentSeat, part: number | undefined, name: string, tool: string): string {
  const parts = seat.primerParts ?? (seat.primer ? [seat.primer] : []);
  if (!parts.length) return `No ${name.toLowerCase()} is available in this event.`;
  const n = parts.length;
  const i = Math.min(Math.max(1, Math.floor(part ?? 1)), n);
  if (n === 1) return parts[0]!;
  const note = part != null && (part < 1 || part > n) ? ` (there is no part ${part}; showing part ${i})` : '';
  return `${name.toUpperCase()} (MTG Deck Tools), part ${i} of ${n}${note}.\n\n${parts[i - 1]}\n\n`
    + (i < n ? `(End of part ${i} of ${n}. Next: ${tool}(part=${i + 1}).)` : `(End of the ${name}: part ${n} of ${n}.)`);
}

function seatServer(lookup: SeatLookup, cards: CardDb, token: string): McpServer {
  // Prompt v4 seats get the v4 texts and tool names; v2/v3 seats keep what they had.
  const v4 = lookup(token)?.observation === 'v4';
  const server = new McpServer({ name: 'mtg-seat', version: '0.3.0' }, { instructions: seatInstructions(lookup(token)) });
  const seat = () => {
    const s = lookup(token);
    if (!s) throw new Error('Unknown seat token.');
    return s;
  };
  const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

  server.registerTool('wait_for_decision', {
    description: 'Wait (up to ~40 s) until you have a decision (draft pick, deck, sideboarding, play or draw, or game action), then return it with everything you need to decide.',
    inputSchema: {},
  }, async () => text((await seat().wait(WAIT_MS)).text));

  const decideSchema = {
    decision_id: z.string().max(40).describe('The id shown after DECISION, e.g. "G12".'),
    option: z.string().max(40).optional().describe('Option id from the list, e.g. "3".'),
    attackers: z.array(objectId).max(200).optional(),
    blocks: z.array(z.object({ blocker: objectId, attacker: objectId })).max(400).optional(),
    cards: z.array(objectId).max(400).optional(),
    basics: basicsSchema.optional(),
    mana: z.array(z.string().max(40)).max(60).optional().describe('Mana sources to tap, in order, when casting or paying: object ids, with an optional color for multi-color sources, e.g. ["37", "50:U"].'),
    note: z.string().max(600).optional().describe('One short sentence on why. Logged for replays and analysis.'),
  };
  // Prompt v4: the deck answer also carries the builder's own count, name, archetype and thought process.
  const decideSchemaV4 = {
    ...decideSchema,
    cards: z.array(objectId).max(400).optional().describe('Deckbuilding and sideboarding: pool numbers of the main deck\'s non-basic cards, one per copy (repeat a number to play more copies of that card). Games: object ids.'),
    basics: basicsSchema.optional().describe('Deckbuilding and sideboarding: basic lands to add, e.g. {"Plains": 8, "Island": 9}.'),
    mana: z.array(z.string().max(40)).max(60).optional().describe('Mana sources to tap, in order, when casting or paying: object ids, with an optional color for multi-color sources, e.g. ["37", "50:U"].'),
    total_count: z.number().int().min(0).max(400).optional().describe('Deckbuilding: your own count of the main deck (pool cards + basics).'),
    deck_name: z.string().max(120).optional().describe('Deckbuilding: a creative, thematic deck name.'),
    archetype: z.string().max(60).optional().describe('Deckbuilding: Aggro, Control, Midrange, Tempo, Combo…'),
    analysis: z.string().max(20000).optional().describe('Deckbuilding: your thought process (options compared, counts, cuts, mana audit). Logged.'),
  };
  server.registerTool('decide', {
    description: v4
      ? 'Answer the open decision. Give `option` (an option id), or the structured answer the decision asks for: `attackers` (object ids attacking the opponent), `blocks` ([{blocker, attacker}]), `cards` (object ids, or pool numbers when building or sideboarding a deck, one per copy) with `basics` ({"Island": 8}) and the deck fields, `mana` (sources to tap when casting or paying).'
      : 'Answer the open decision. Give `option` (an option id), or the structured answer the decision asks for: `attackers` (object ids attacking the opponent), `blocks` ([{blocker, attacker}]), `cards` (object ids, or pool numbers when building a deck) with `basics` ({"Island": 8}), `mana` (sources to tap when casting or paying).',
    inputSchema: v4 ? decideSchemaV4 : decideSchema,
  }, async (input) => text(await seat().decide(cleanDecideInput(input))));

  server.registerTool('get_view', {
    description: 'Show the current game board from your point of view (no decision).',
    inputSchema: {},
  }, async () => text(seat().views?.view() ?? 'You are not in a game right now.'));

  server.registerTool('get_card', {
    description: 'Look up a card\'s cost, type, stats and rules text by name.',
    inputSchema: { name: z.string().max(200) },
  }, async ({ name }) => text(!cards.get(name) ? `No card named "${name}".` : v4 ? JSON.stringify(cards.json(name)) : cards.describe(name)));

  // The Set Context (named "set primer" before prompt v4) comes in parts that each fit one tool result.
  const part = { part: z.number().int().min(1).max(20).optional().describe('Which part to read (1, 2, …); the briefing says how many there are. Default 1.') };
  if (v4) {
    server.registerTool('get_set_context', {
      description: 'The MTG Deck Tools Set Context for this format (archetypes, lanes, curve and land advice), when this event includes it. It comes in parts: read part 1, 2, … as the briefing says.',
      inputSchema: part,
    }, async ({ part: n }) => {
      const s = seat();
      if (s.primer) s.markSetContextRead();
      return text(setContextPart(s, n, 'Set Context', 'get_set_context'));
    });
  } else {
    server.registerTool('get_set_primer', {
      description: 'The MTG Deck Tools primer for this format (archetypes, lanes, curve and land advice), when this event allows it. Long primers come in parts: read part 1, 2, … as the briefing says.',
      inputSchema: part,
    }, async ({ part: n }) => {
      const s = seat();
      if (s.primer) s.markSetContextRead();
      return text(setContextPart(s, n, 'Set primer', 'get_set_primer'));
    });
  }

  server.registerTool('report_rules_issue', {
    description: 'Report a card the rules engine seems to handle wrongly (refused a listed option, an effect did nothing or the wrong thing). Logged for us to check; it never affects the game or your decision.',
    inputSchema: {
      card: z.string().max(120).describe('The card name, e.g. "Zuko\'s Conviction".'),
      note: z.string().max(600).describe('What you expected and what happened instead.'),
    },
  }, async ({ card, note }) => text(seat().reportIssue?.(cleanAgentText(card), cleanAgentText(note)) ?? 'Thanks: noted.'));

  server.registerTool('get_game_log', {
    description: 'Recent log lines of your current game (what both players did).',
    inputSchema: { last_n: z.number().int().min(1).max(300).optional() },
  }, async ({ last_n }) => text(seat().views?.log(last_n ?? 60) ?? 'You are not in a game right now.'));

  return server;
}

/**
 * A request path safe to log: seat tokens, lobby tickets and token query parameters are bearer secrets (OPS-16,
 * LOB-8), so at most their first 4 characters are kept.
 */
export function loggablePath(url: string | undefined): string {
  return String(url ?? '').slice(0, 200)
    .replace(/(\/mcp\/)([0-9a-f]{4})[0-9a-f]*/gi, '$1$2…')
    .replace(/(\/tickets\/)([^/?#]{0,4})[^/?#]*/gi, '$1$2…')
    .replace(/([?&](?:token|ticket|key)=)([^&#]{0,4})[^&#]*/gi, '$1$2…');
}

/** A JSON-RPC `initialize` request (alone or in a batch). */
function isInitialize(body: unknown): boolean {
  const list = Array.isArray(body) ? body : [body];
  return list.some((m) => !!m && typeof m === 'object' && (m as { method?: unknown }).method === 'initialize');
}

/** Parse a JSON request body of at most `max` bytes (BodyTooLarge beyond; SyntaxError when malformed). */
export async function readBody(req: IncomingMessage, max = 64 * 1024): Promise<unknown> {
  const raw = (await readLimited(req, max)).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

/** HTTP server exposing one stateless MCP endpoint per seat at /mcp/<seat-token>. */
export type ExtraRoutes = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

/** Abuse limits on the seat endpoints (hosted Director; generous enough for scripted agents). */
export interface McpLimits {
  /** Requests per minute per seat (MCP_RATE_PER_MIN, default 600; 0 = off). */
  perSeatPerMin: number;
  /** Requests in flight per seat (MCP_INFLIGHT_PER_SEAT, default 4): a seat needs one long-poll at a time. */
  inflightPerSeat: number;
  /** Requests to unknown seat URLs per client IP per minute (default 30), against token guessing. */
  unknownPerIpPerMin: number;
  /** Largest MCP request body (default 256 KB). */
  maxBodyBytes: number;
  /**
   * New harness sessions (MCP `initialize`) per seat per minute (default 6, bursts of 4). Each is logged (seat_session),
   * so an unbounded rate let one seat inflate its table's log past what the Hub accepts (SEC-4).
   */
  initPerSeatPerMin?: number;
  /**
   * Requests in flight per client IP outside the seat endpoints (MAX_INFLIGHT_PER_IP, default 32): lobby long-polls,
   * spectator streams, slow /data readers. One client can't hold the connection limit every seat shares (SEC-5).
   */
  inflightPerIp?: number;
  trustProxy: boolean;
  /** Proxies in front (TRUST_PROXY_HOPS). */
  proxyHops?: number;
}

export const DEFAULT_MCP_LIMITS: McpLimits = {
  perSeatPerMin: 600, inflightPerSeat: 4, unknownPerIpPerMin: 30, maxBodyBytes: 256 * 1024, initPerSeatPerMin: 6, inflightPerIp: 32, trustProxy: false,
};

/** A socket with nothing read or written for this long is closed (longer than any long-poll; SSE sends heartbeats). */
export const SOCKET_IDLE_MS = 150_000;

export function startHttp(lookup: SeatLookup, cards: CardDb, port: number, host = '127.0.0.1', extra?: ExtraRoutes, limits: McpLimits = DEFAULT_MCP_LIMITS): Server {
  const perSeat = new RateLimiter(limits.perSeatPerMin, Math.max(10, Math.ceil(limits.perSeatPerMin / 10)));
  const unknown = new RateLimiter(limits.unknownPerIpPerMin, Math.max(5, Math.ceil(limits.unknownPerIpPerMin / 3)));
  // A launcher polls every few seconds (bench play polls every 3 s).
  const progressPolls = new RateLimiter(60, 10);
  const initPerMin = limits.initPerSeatPerMin ?? DEFAULT_MCP_LIMITS.initPerSeatPerMin!;
  const sessionStarts = new RateLimiter(initPerMin, Math.max(1, Math.ceil(initPerMin * 2 / 3)));
  const inflight = new Map<string, number>();
  const ipInflight = new Map<string, number>();
  const maxPerIp = limits.inflightPerIp ?? DEFAULT_MCP_LIMITS.inflightPerIp!;
  const tooMany = (res: ServerResponse, retry: number, what: string, headers: Record<string, string> = {}) => {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(retry), ...headers }).end(JSON.stringify({ error: what }));
  };
  /** Count a request against its client IP until the response closes; false (and a 429) when the IP is at its cap. */
  const holdIp = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (!(maxPerIp > 0)) return true;
    const ip = clientIp(req, limits.trustProxy, limits.proxyHops);
    const n = ipInflight.get(ip) ?? 0;
    if (n >= maxPerIp) {
      tooMany(res, 5, `at most ${maxPerIp} requests at once from one address`, publicReadCors(req));
      return false;
    }
    ipInflight.set(ip, n + 1);
    res.on('close', () => {
      const left = (ipInflight.get(ip) ?? 1) - 1;
      if (left > 0) ipInflight.set(ip, left);
      else ipInflight.delete(ip);
    });
    return true;
  };
  // No request may throw out of the handler (a malformed target like `//a:b` once crashed the process, DIR-1):
  // every failure becomes a 400/500 for that request only.
  // headersTimeout and requestTimeout are only enforced when the server checks its connections (default every 30 s,
  // so a slowloris socket lived up to 50 s): check every 5 s.
  const http = createServer({ connectionsCheckingInterval: 5_000 }, (req: IncomingMessage, res: ServerResponse) => {
    // Every answer is data (JSON, SSE, static report files), never a page: no sniffing, no framing, no scripts even if
    // a response were ever opened as a document (SEC-10).
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    handle(req, res).catch((err) => {
      console.error(`${req.method} ${loggablePath(req.url)}: ${String((err as Error)?.stack ?? err)}`);
      if (!res.headersSent) res.writeHead(err instanceof URIError || err instanceof TypeError && /URL/.test(String(err)) ? 400 : 500, { 'Content-Type': 'text/plain', ...publicReadCors(req) }).end('bad request');
      else res.destroy();
    });
  });
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.url === '/health') {
      // The build's version (DIRECTOR_TAG): deploy/deploy.sh waits until the new build answers.
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ ok: true, version: directorVersion() }));
      return;
    }
    if (extra && !req.url?.startsWith('/mcp/')) {
      if (!holdIp(req, res)) return;
      if (await extra(req, res)) return;
    }
    // The seat's own progress, for its launcher (bench play --fresh-session): not an MCP tool and not activity for the
    // inactivity watchdog, so polling it never keeps a silent seat alive. Only the seat URL's holder can read it.
    const pm = req.url?.match(/^\/mcp\/([0-9a-f]{32})\/progress\/?$/);
    if (pm) {
      const seat = lookup(pm[1]!);
      if (!seat) {
        const wait = unknown.take(clientIp(req, limits.trustProxy, limits.proxyHops));
        if (wait) return tooMany(res, wait, 'too many requests for unknown seats');
        res.writeHead(404).end('unknown seat');
        return;
      }
      if (req.method !== 'GET') {
        res.writeHead(405, { Allow: 'GET' }).end();
        return;
      }
      const wait = progressPolls.take(pm[1]!);
      if (wait) return tooMany(res, wait, 'too many progress polls for this seat; poll every few seconds');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(seat.progress()));
      return;
    }
    const m = req.url?.match(/^\/mcp\/([0-9a-f]{32})\/?$/);
    if (!m || !lookup(m[1]!)) {
      const wait = unknown.take(clientIp(req, limits.trustProxy, limits.proxyHops));
      if (wait) return tooMany(res, wait, 'too many requests for unknown seats');
      res.writeHead(404).end('unknown seat');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    const token = m[1]!;
    const wait = perSeat.take(token);
    if (wait) return tooMany(res, wait, 'too many requests for this seat; slow down');
    if ((inflight.get(token) ?? 0) >= limits.inflightPerSeat) return tooMany(res, 5, `at most ${limits.inflightPerSeat} requests at once per seat`);
    inflight.set(token, (inflight.get(token) ?? 0) + 1);
    res.on('close', () => {
      const n = (inflight.get(token) ?? 1) - 1;
      if (n > 0) inflight.set(token, n);
      else inflight.delete(token);
    });
    // Every request counts as activity for the seat's inactivity watchdog (event.ts), for as long as it runs.
    const seat = lookup(token)!;
    seat.beginRequest();
    res.on('close', () => seat.endRequest());
    try {
      let body: unknown;
      try {
        body = await readBody(req, limits.maxBodyBytes);
      } catch (err) {
        if (err instanceof BodyTooLarge) tooLarge(res, err.message, false);
        else if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'text/plain' }).end('malformed JSON');
        return;
      }
      // JSON-RPC batches: a few messages at most, each one counted against the seat's rate (SEC-2: 100 tool calls in
      // one request once went through as one request).
      const messages = Array.isArray(body) ? body.length : 1;
      if (messages > MAX_BATCH || messages === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `Invalid Request: a batch holds 1 to ${MAX_BATCH} messages` } }));
        return;
      }
      for (let i = 1; i < messages; i++) {
        const w = perSeat.take(token);
        if (w) return tooMany(res, w, 'too many requests for this seat; slow down');
      }
      // An `initialize` is a new harness session for this seat (a relaunch): it gets a resume briefing first.
      if (isInitialize(body)) {
        const w = sessionStarts.take(token);
        if (w) return tooMany(res, w, 'too many new sessions for this seat; a harness initializes once per session');
        seat.sessionStart();
      }
      const server = seatServer(lookup, cards, m[1]!);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error(`mcp ${token.slice(0, 4)}…: ${String((err as Error)?.stack ?? err)}`);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' }).end('internal error');
    }
  };
  // Slowloris protection (DIR-2). These bound only how long a client may take to SEND its request; long-polls
  // (wait_for_decision, ~40 s) and the spectator SSE stream are responses and aren't affected.
  http.headersTimeout = 20_000;
  http.requestTimeout = 60_000;
  http.maxConnections = 2_000;
  // Idle sockets (a reader that stopped reading a /data file or a stream, a client that went quiet) are closed (SEC-5).
  http.timeout = SOCKET_IDLE_MS;
  http.listen(port, host);
  return http;
}
