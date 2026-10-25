/**
 * Engine flags for known-issue cards (METHODOLOGY §5.6, docs/CARD-OVERRIDES.md): a game where a card on the
 * known-issues list was played is flagged, unless the event's card data carried an override for it.
 *   npx tsx packages/site/src/engine-flags.test.ts
 */
import assert from 'node:assert/strict';
import type { EventData, Game } from './data.js';
import { engineCards, engineSplit, gameFlags, knownIssueApplies, knownIssues, type KnownIssue } from './engine-flags.js';

let failed = 0;
const check = (name: string, f: () => void) => {
  try {
    f();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n     ${(err as Error).stack}`);
  }
};

const game = (cards: string[]): Game => ({
  index: 0, plays: cards.map((card, i) => ({ seat: 'seat-a', card, how: 'cast', turn: i + 1, t: i })), playsLogged: true,
  decisions: [], refusedAuto: [], unimplemented: [], rulesIssues: [],
}) as unknown as Game;
const event = (provenance: unknown, games: Game[] = []): EventData => ({ id: 'ev', packs: [], games, rulesIssues: [], provenance }) as unknown as EventData;
const engine = { server_version: '0.115.0', build_commit: '6485512' };
const heated: KnownIssue = { card: 'Heated Argument', status: 'confirmed', upstream_issue: 'https://github.com/phase-rs/phase/issues/10205', override: 'heated-argument' };
const known = new Map([['heated argument', heated]]);

check('a confirmed card that was cast flags the game', () => {
  const f = gameFlags(event({ engine }), game(['Mountain', 'Heated Argument']), new Set(), known);
  assert.equal(f.flagged, true);
  assert.equal(f.counts.known_issue_card, 1);
  assert.deepEqual(f.items[0], { kind: 'known_issue_card', seat: 'seat-a', card: 'Heated Argument', turn: 2, detail: 'confirmed: https://github.com/phase-rs/phase/issues/10205' });
});

check('an active override for the card in the event card data clears it', () => {
  const prov = { engine, card_data: { sha256: 'x', upstream_sha256: 'y', overrides_sha256: 'z', overrides: ['heated-argument'] } };
  assert.equal(gameFlags(event(prov), game(['Heated Argument']), new Set(), known).flagged, false);
  // A different override set (the card's override was stale and skipped) does not.
  const other = { engine, card_data: { sha256: 'x', overrides: [] } };
  assert.equal(gameFlags(event(other), game(['Heated Argument']), new Set(), known).flagged, true);
});

check('not-a-bug never flags; fixed flags only builds before the fix', () => {
  assert.equal(knownIssueApplies({ ...heated, status: 'not-a-bug' }, event({ engine })), false);
  const fixed: KnownIssue = { ...heated, status: 'fixed', fixed_in: '0.116.0', override: null };
  assert.equal(knownIssueApplies(fixed, event({ engine })), true);
  assert.equal(knownIssueApplies(fixed, event({ engine: { server_version: '0.116.0' } })), false);
  assert.equal(knownIssueApplies({ ...fixed, fixed_in: null }, event({ engine })), false);
});

check('a card not on the list, or a game without it, is not flagged', () => {
  assert.equal(gameFlags(event({ engine }), game(['Mountain']), new Set(), known).flagged, false);
});

check('known-issue flags count toward flagged games, not toward rules reports', () => {
  const ev = event({ engine }, [game(['Heated Argument'])]);
  // engineCards reads the repo's list; this only checks the counters stay apart when the card is on it.
  const row = engineCards([ev]).find((r) => r.name === 'Heated Argument');
  if (knownIssues().has('heated argument')) {
    assert.ok(row);
    assert.equal(row.flagged_games, 1);
    assert.equal(row.rules_issues, 0);
  } else assert.equal(row, undefined);
});

check("the repo's known-issues list parses and uses only known statuses", () => {
  for (const i of knownIssues().values()) assert.ok(['suspected', 'confirmed', 'not-a-bug', 'fixed'].includes(i.status), i.card);
});

check('card swaps and rules errors are counted apart, with games where the implicated seat lost', () => {
  const g = (cards: string[], winner: string, rulesIssues: unknown[] = []) => ({
    ...game(cards), over: true, winner, seats: ['seat-a', 'seat-b'], rulesIssues,
  }) as unknown as Game;
  const ev = {
    id: 'ev2', provenance: { engine }, rulesIssues: [], source: { label: 'verified' },
    seats: [{ name: 'seat-a', kind: 'agent', llm: true }, { name: 'seat-b', kind: 'agent', llm: true }],
    packs: [{ swaps: [{ from: 'Unsupported Card', to: 'Swapped Card' }] }],
    games: [g(['Swapped Card'], 'seat-a'), g(['Mountain'], 'seat-a', [{ seat: 'seat-b', card: 'Bad Card', note: 'it did nothing', t: 1 }]), g(['Mountain'], 'seat-b')],
  } as unknown as EventData;
  const s = engineSplit([ev], 'llm');
  assert.equal(s.games, 3);
  assert.deepEqual(s.card_swaps, { swaps: 1, cards: 1, games: 1 });
  assert.equal(s.rules_errors.games, 1);
  assert.equal(s.rules_errors.by_kind.rules_issue, 1);
  assert.deepEqual([s.rules_errors.implicated_single_seat, s.rules_errors.lost_by_implicated], [1, 1]);
  assert.match(s.text, /^Rules errors touched 1 of 3 games .*Swapped-in cards .* were cast in 1 of 3 games\.$/);
});

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
