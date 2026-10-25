// Test agent: plays a seat over MCP by picking random options. Usage: node scripts/mcp-random-agent.mjs <seat-url>
// Env (optional, for watching a scripted event live): AGENT_DELAY_MS=<ms> waits before each answer (±50% jitter);
// AGENT_REPORT_RATE=<0..1> files a report_rules_issue on a card from the decision with that probability per game decision.
// AGENT_RETRY_S=<s> retries failed calls and the first connection (Director restarting) for that long, default 600.
// AGENT_QUIT_AFTER=<n> stops (closes the connection and exits) after n decisions, like a crashed harness: tests the
// Director's inactivity forfeit (SEAT_TIMEOUT_MS).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.argv[2];
// Like a real harness, keep going through a Director restart (a deploy: the proxy answers 404 or 502 for a minute or
// two) or a rate limit: retry the connection and failed calls for up to AGENT_RETRY_S seconds (default 600, the bench
// CLI's own wait; 0 = fail at once), backing off from 2 to 15 seconds.
const retryS = Number(process.env.AGENT_RETRY_S ?? 600);
const retrying = async (what, fn) => {
  const until = Date.now() + retryS * 1000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (Date.now() > until) throw err;
      if (attempt === 1 || attempt % 10 === 0) console.log(`${url.slice(-6)}: ${what} failed (${String(err?.message ?? err).slice(0, 80)}); retrying`);
      await new Promise((r) => setTimeout(r, Math.min(15_000, 2000 * attempt)));
    }
  }
};
const client = new Client({ name: 'random-agent', version: '0.1.0' });
await retrying('connect', async () => {
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }
});
console.log('instructions:', (client.getInstructions() ?? '').slice(0, 80), '…');
const call = (name, args = {}) => retrying(name, async () => (await client.callTool({ name, arguments: args })).content[0].text);
const delayMs = Number(process.env.AGENT_DELAY_MS ?? 0);
const reportRate = Number(process.env.AGENT_REPORT_RATE ?? 0);
const quitAfter = Number(process.env.AGENT_QUIT_AFTER ?? 0);
const statuses = new Set();
// AGENT_SELF_BUILD_RATE=<0..1>: chance of building its own (random, legal) deck at a prompt v4 deckbuilding decision
// instead of delegating to the reference builder (default 0.5), so scripted events exercise the deck review.
const selfBuildRate = Number(process.env.AGENT_SELF_BUILD_RATE ?? 0.5);
// AGENT_SIDEBOARD_RATE=<0..1>: chance of changing the deck at a sideboarding decision (default 0.5): one or two random
// swaps between deck and sideboard, sometimes a basic land changed too. Otherwise it keeps the deck.
const sideboardRate = Number(process.env.AGENT_SIDEBOARD_RATE ?? 0.5);

/** Random swaps from a sideboarding decision: the current deck (its own answer line) with sideboard cards swapped in. */
function randomSideboard(text) {
  const cur = text.match(/Your current deck as an answer: cards=\[([\d, ]*)\], basics=(\{[^}]*\})/);
  if (!cur) return null;
  const cards = cur[1].split(',').map((x) => Number(x.trim())).filter((n) => n > 0);
  const basics = JSON.parse(cur[2]);
  const side = text.split('YOUR SIDEBOARD')[1]?.split('\n\n')[0] ?? '';
  const sideNums = [...side.matchAll(/^(\{"n":.*\})$/gm)].map((x) => JSON.parse(x[1])).flatMap((c) => c.poolNumbers ?? [c.n]);
  const swaps = Math.min(sideNums.length, cards.length, 1 + Math.floor(Math.random() * 2));
  const pool = sideNums.sort(() => Math.random() - 0.5);
  for (let i = 0; i < swaps; i++) cards[Math.floor(Math.random() * cards.length)] = pool[i];
  const names = Object.keys(basics);
  if (names.length > 1 && Math.random() < 0.5) {
    // One basic for another (the deck stays at its size).
    const [from, to] = names.sort(() => Math.random() - 0.5);
    if (basics[from] > 1) (basics[from]--, basics[to]++);
  }
  return { cards, basics };
}

/** A random legal deck from a prompt v4 deck offer: two colors, up to 23 castable non-land cards (copies included), basics to 40. */
function randomDeck(text) {
  const pool = [...text.matchAll(/^(\{"n":.*\})$/gm)].map((x) => JSON.parse(x[1]));
  const spells = pool.filter((c) => !/\bLand\b/.test(c.type));
  const weight = {};
  for (const c of spells) for (const col of (c.colors === 'colorless' ? '' : c.colors)) weight[col] = (weight[col] ?? 0) + c.count;
  const lane = Object.entries(weight).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([col]) => col);
  const fits = spells.filter((c) => c.colors === 'colorless' || [...c.colors].every((col) => lane.includes(col))).sort(() => Math.random() - 0.5);
  const cards = [];
  for (const c of fits) for (let i = 0; i < c.count && cards.length < 23; i++) cards.push(c.n);
  const names = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' };
  const lands = 40 - cards.length;
  const basics = lane.length ? { [names[lane[0]]]: Math.ceil(lands / lane.length) } : { Plains: lands };
  if (lane[1]) basics[names[lane[1]]] = lands - basics[names[lane[0]]];
  return { cards, basics };
}
const pause = () => (delayMs > 0 ? new Promise((r) => setTimeout(r, delayMs * (0.5 + Math.random()))) : Promise.resolve());
let reports = 0;
let text = await call('wait_for_decision');
let decisions = 0;
let printed = 0;
for (;;) {
  if (/(^|\n)EVENT COMPLETE\./.test(text)) break;
  if (quitAfter > 0 && decisions >= quitAfter) {
    console.log(`${url.slice(-6)}: quitting after ${decisions} decisions (AGENT_QUIT_AFTER)`);
    await client.close();
    process.exit(0);
  }
  const m = text.match(/DECISION (\S+) —/);
  // Set Context levels: a session reads the Set Context before its first game decision (the Director reminds it).
  const read = !m && text.match(/read the Set Context for this format: call (get_set_context|get_set_primer)\(/);
  if (read) {
    await call(read[1], { part: 1 });
    text = await call('wait_for_decision');
    continue;
  }
  if (!m) {
    // Remember the waiting statuses (what an idle seat is told), without the variable numbers.
    const status = text.split('\n').find((l) => l.includes('Keep calling wait_for_decision'));
    if (status) statuses.add(status);
    text = await call('wait_for_decision');
    continue;
  }
  await pause();
  if (reportRate > 0 && text.includes('Turn ') && Math.random() < reportRate) {
    const card = [...text.matchAll(/^\s+(?!T\d+ )(?:\[\d+\] (?:Cast|Activate) )?([A-Z][^\[\n{:]+?) \[#\d+\]/gm)].map((x) => x[1].trim())[0];
    if (card) {
      reports++;
      await call('report_rules_issue', { card, note: `scripted test report #${reports}: (random agent) pretending ${card} misbehaved` });
    }
  }
  if (printed < 2 && decisions > 6) {
    console.log('\n----- sample decision text -----\n' + text.slice(text.indexOf('Turn ')) + '\n--------------------------------');
    printed++;
  }
  if (text.includes('PLAY OR DRAW —')) {
    decisions++;
    text = await call('decide', { decision_id: m[1], option: Math.random() < 0.8 ? 'play' : 'draw', note: 'random play/draw' });
    continue;
  }
  if (text.includes('SIDEBOARDING —')) {
    decisions++;
    const sb = sideboardRate > 0 && Math.random() < sideboardRate ? randomSideboard(text) : null;
    text = sb
      ? await call('decide', { decision_id: m[1], ...sb, note: 'random sideboarding' })
      : await call('decide', { decision_id: m[1], option: 'keep', note: 'keep' });
    continue;
  }
  if (text.includes('DECKBUILDING')) {
    decisions++;
    const own = selfBuildRate > 0 && /^\{"n":/m.test(text) && Math.random() < selfBuildRate ? randomDeck(text) : null;
    text = own
      ? await call('decide', { decision_id: m[1], ...own, total_count: own.cards.length + Object.values(own.basics).reduce((a, b) => a + b, 0), deck_name: 'Random Pile', archetype: 'Midrange', note: 'random deck' })
      : await call('decide', { decision_id: m[1], option: 'auto', note: 'auto' });
    continue;
  }
  if (text.includes('DECK REVIEW')) {
    // Prompt v4 review: confirm the deck.
    decisions++;
    text = await call('decide', { decision_id: m[1], option: 'confirm', note: 'looks right' });
    continue;
  }
  // Manual mana payment: usually tap a random subset of the listed sources, sometimes defer to the auto-tapper.
  const srcBlock = text.split('Untapped mana sources:')[1]?.split('Choose which to tap')[0];
  if (srcBlock && Math.random() < 0.75) {
    const sources = [...srcBlock.matchAll(/\[#(\d+)\]/g)].map((x) => x[1]).sort(() => Math.random() - 0.5);
    if (sources.length) {
      decisions++;
      text = await call('decide', { decision_id: m[1], mana: sources.slice(0, 1 + Math.floor(Math.random() * sources.length)), note: 'random taps' });
      continue;
    }
  }
  // Structured game decisions: one JSON object (state, cards, decision.options) between the header and DECISION line.
  const json = structured(text);
  if (json?.decision?.options) {
    const opts = json.decision.options.filter((x) => !x.refused);
    const nonPass = opts.filter((x) => !/^(Pass priority|Cancel)/.test(x.label));
    const pool = nonPass.length && Math.random() < 0.8 ? nonPass : opts;
    const option = pool[Math.floor(Math.random() * pool.length)]?.id ?? '1';
    decisions++;
    text = await call('decide', { decision_id: m[1], option, note: 'random' });
    if (text.startsWith('Rejected')) text = await call('wait_for_decision');
    continue;
  }
  let ids = [...text.slice(text.lastIndexOf('DECISION')).matchAll(/^\s+\[(\d+)\]/gm)].map((x) => x[1]);
  if (!ids.length) ids = [...text.matchAll(/^\s+\[(\d+)\]/gm)].map((x) => x[1]); // draft: options are listed above the DECISION line
  if (!ids.length) ids = [...text.matchAll(/^\{"n":(\d+)/gm)].map((x) => x[1]); // prompt v4 draft: one card JSON per line
  const nonPass = ids.filter((id) => !new RegExp(`\\[${id}\\] (Pass priority|Cancel)`).test(text));
  const pool = nonPass.length && Math.random() < 0.8 ? nonPass : ids;
  const option = pool[Math.floor(Math.random() * pool.length)];
  decisions++;
  text = await call('decide', { decision_id: m[1], option, note: 'random' });
  if (text.startsWith('Rejected')) text = await call('wait_for_decision');
}
console.log(`${url.slice(-6)}: finished after ${decisions} decisions`);
console.log(`waiting statuses seen (${statuses.size}):\n${[...statuses].slice(-6).map((x) => `  ${x}`).join('\n')}`);
console.log(`final message:\n${text.slice(text.search(/(^|\n)EVENT COMPLETE\./)).trim()}`);
await client.close();

/** The JSON body of a structured game decision, or undefined. */
function structured(text) {
  const start = text.indexOf('\n{');
  const end = text.lastIndexOf('\n}');
  if (start < 0 || end < start) return undefined;
  try {
    return JSON.parse(text.slice(start + 1, end + 2));
  } catch {
    return undefined;
  }
}
