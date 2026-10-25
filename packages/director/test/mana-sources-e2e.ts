/**
 * Manual mana from non-land sources, end to end on a real phase-server (no LLM): the Director's Game drives both
 * seats, and this script answers their decisions. phase-server offers a mana creature, a mana rock and a Treasure as
 * plain ActivateAbility actions (not TapLandForMana); a tap plan naming them must pay the spell with no payment
 * failure and no auto-tapper (critic round 2, finding 1).
 *
 * The board is built with phase-rs debug actions (format_config.allow_debug_actions, a sandbox game): seat 0 gets
 * Noxious Newt ({T}: Add {G}), Potioner's Trove ({T}: Add one mana of any color), a Treasure (from Sailor of Means'
 * enter trigger) and three one-mana spells. On its next turn it casts:
 *   Savannah Lions {W} with mana=["<Treasure>:W"]   (sacrificed for its mana; the color asked for)
 *   Raging Goblin  {R} with mana=["<Trove>:R"]      (a mana rock; the color asked for)
 *   Llanowar Elves {G} with mana=["<Newt>"]         (a mana creature)
 *
 * Usage: npx tsx packages/director/test/mana-sources-e2e.ts [ws://127.0.0.1:9374/ws] [data-dir]
 * Never point it at a server running real events (it uses a game slot). Exit 0 when every check passed.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CardDb } from '../src/cards.js';
import { Game } from '../src/game.js';
import { LIMITED_FORMAT } from '../src/phase.js';
import { AgentSeat } from '../src/seat.js';

const url = process.argv[2] ?? 'ws://127.0.0.1:9374/ws';
const data = process.argv[3] ?? 'data';
const TIMEOUT_MS = Number(process.env.MANA_E2E_TIMEOUT_MS) || 120_000;

// A sandbox game: debug actions build the board (never set outside this test process).
(LIMITED_FORMAT as { allow_debug_actions: boolean }).allow_debug_actions = true;

const cards = new CardDb(join(data, 'card-data.json'));
const seats: [AgentSeat, AgentSeat] = [new AgentSeat('mana-e2e-a', 0), new AgentSeat('mana-e2e-b', 1)];
const deck = { main_deck: Array(40).fill('Forest'), sideboard: [] };
const logged: Array<Record<string, any>> = [];
const game = new Game(url, cards, seats, [deck, deck], (type, d) => logged.push({ type, ...d }), 'mana-e2e-a vs mana-e2e-b — game 1', 'manual',
  { match: 'mana-e2e', game_number: 1 }, undefined, { observation: 'v4', seatLabel: 'Round 1 of 1, game 1 (best of 1)', match: { game: 1, bestOf: 1, results: [] } } as any);
const players = (game as any).players as any[];
const p0 = players[0];

const SETUP: Array<{ card: string; zone: string; run_etb?: boolean }> = [
  { card: 'Noxious Newt', zone: 'Battlefield' },
  { card: "Potioner's Trove", zone: 'Battlefield' },
  { card: 'Sailor of Means', zone: 'Battlefield', run_etb: true },
  { card: 'Savannah Lions', zone: 'Hand' },
  { card: 'Raging Goblin', zone: 'Hand' },
  { card: 'Llanowar Elves', zone: 'Hand' },
];
const CASTS: Array<{ spell: string; source: string; color?: string }> = [
  { spell: 'Savannah Lions', source: 'Treasure', color: 'W' },
  { spell: 'Raging Goblin', source: "Potioner's Trove", color: 'R' },
  { spell: 'Llanowar Elves', source: 'Noxious Newt' },
];

const objects = (): any[] => Object.values(p0.latest?.state?.objects ?? {});
const mine = (name: string, zone: string) => objects().find((o) => o.name === name && o.zone === zone && o.controller === p0.me);
let created = false;
let step = 0;
let castAt = -1;
let finished = false;
const trace: string[] = [];

function pick(seat: AgentSeat, labels: RegExp[]): string | undefined {
  const opts = seat.pending?.options ?? [];
  for (const re of labels) {
    const o = opts.find((x) => re.test(x.label));
    if (o) return o.id;
  }
  return opts[0]?.id;
}

async function answerOpponent(): Promise<void> {
  const s = seats[1];
  const o = s.pending;
  if (!o || o.answering) return;
  const option = pick(s, [/^Keep this hand$/, /^Play land/, /^Pass priority$/, /^No attack$/, /^No blocks$/]);
  if (option) await s.decide({ decision_id: o.id, option, note: 'mana e2e' });
}

async function answerCaster(): Promise<void> {
  const s = seats[0];
  const o = s.pending;
  if (!o || o.answering) return;
  const st = p0.latest?.state;
  const myMain = st?.active_player === p0.me && st?.phase === 'PreCombatMain' && o.kind === 'Priority';
  if (o.kind === 'Priority' && !created) {
    created = true;
    for (const x of SETUP) {
      await p0.phase.act({ type: 'Debug', data: { type: 'CreateCard', data: { card_name: x.card, owner: p0.me, zone: x.zone, count: 1, run_etb: x.run_etb ?? false } } });
    }
    trace.push(`board created on turn ${st?.turn_number}`);
    return;
  }
  const newt = mine('Noxious Newt', 'Battlefield');
  const ready = created && myMain && newt && !newt.summoning_sick && !newt.has_summoning_sickness && (step > 0 || mine('Treasure', 'Battlefield') !== undefined);
  if (ready && step < CASTS.length && castAt !== step && (st?.stack ?? []).length === 0) {
    const c = CASTS[step]!;
    const spell = mine(c.spell, 'Hand');
    const source = mine(c.source, 'Battlefield');
    assert.ok(spell, `${c.spell} in hand`);
    assert.ok(source, `${c.source} on the battlefield`);
    const opt = o.options.find((x) => (x.value as any)?.type === 'CastSpell' && (x.value as any)?.data?.object_id === spell.id);
    assert.ok(opt, `a cast option for ${c.spell}: ${o.options.map((x) => x.label).join(' | ')}`);
    const untapped = JSON.parse(o.text.split('\n').slice(2, -1).join('\n')).state.you.untapped_mana;
    assert.ok(Object.values(untapped).some((v) => Array.isArray(v) && v.includes(source.id)), `untapped_mana lists ${c.source} [#${source.id}]: ${JSON.stringify(untapped)}`);
    castAt = step;
    const mana = [`${source.id}${c.color ? `:${c.color}` : ''}`];
    const reply = await s.decide({ decision_id: o.id, option: opt.id, mana, note: 'mana e2e' });
    trace.push(`cast ${c.spell} with mana=${JSON.stringify(mana)}: ${reply.split('\n')[0]}`);
    assert.match(reply, /^Accepted\./);
    return;
  }
  if (castAt === step && mine(CASTS[step]!.spell, 'Battlefield')) {
    trace.push(`${CASTS[step]!.spell} resolved`);
    step++;
    // The next spell from the same main phase (this decision stays open).
    if (step < CASTS.length) return;
  }
  if (step >= CASTS.length) {
    finished = true;
    return;
  }
  const option = pick(s, [/^Keep this hand$/, /^Play land/, /^Pass priority$/, /^No attack$/, /^No blocks$/]);
  if (option) await s.decide({ decision_id: o.id, option, note: 'mana e2e' });
}

async function main(): Promise<void> {
  const playing = game.play().catch((e) => {
    if (!finished) throw e;
  });
  const t0 = Date.now();
  while (!finished) {
    if (Date.now() - t0 > TIMEOUT_MS) throw new Error(`timed out (step ${step}, created ${created})`);
    await answerOpponent();
    await answerCaster();
    await new Promise((r) => setTimeout(r, 50));
  }
  const stats = game.stats()[seats[0].name] as Record<string, number>;
  const payErrors = logged.filter((r) => r.type === 'pay_error' && r.seat === seats[0].name);
  const offeredPayments = logged.filter((r) => r.type === 'decision_offered' && r.seat === seats[0].name && r.kind === 'ManaPayment');
  for (const c of CASTS) assert.ok(mine(c.spell, 'Battlefield'), `${c.spell} on the battlefield`);
  assert.equal(mine('Treasure', 'Battlefield'), undefined, 'the Treasure was sacrificed for its mana');
  assert.deepEqual(payErrors, [], 'no pay_error');
  assert.equal(offeredPayments.length, 0, 'the agent was never asked to finish a payment');
  assert.equal(stats.payment_failures, 0);
  assert.equal(stats.auto_tapper, 0);
  assert.equal(stats.manual_payments, CASTS.length);
  const colors = logged.filter((r) => r.type === 'pay_color' && r.seat === seats[0].name);
  assert.equal(colors.length, 2, 'the Treasure and the Trove asked for a color');
  game.abandon();
  void playing;
  for (const line of trace) console.log(`  ${line}`);
  console.log(`MANA SOURCES E2E OK: ${CASTS.map((c) => `${c.spell} paid by ${c.source}`).join('; ')}; stats ${JSON.stringify(stats)}`);
}

main().then(() => process.exit(0), (e) => {
  for (const line of trace) console.error(`  ${line}`);
  console.error(`MANA SOURCES E2E FAIL: ${e?.message ?? e}`);
  for (const r of logged.filter((x) => /pay_|agent_decision/.test(x.type)).slice(-15)) console.error(`  ${JSON.stringify(r).slice(0, 300)}`);
  game.abandon();
  process.exit(1);
});
