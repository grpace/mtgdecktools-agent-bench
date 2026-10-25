/**
 * Integrity checks against a real finished event (a smoke run: scripts/smoke-event.sh, or HUB_TEST_RUN).
 * Skipped when no run is available. Pack regeneration also needs data/draft-pools.json.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkBundle, latencyAnomalies, pairingCheck, seatEligibility, type CheckOptions } from '../src/checks.js';
import { policy } from '../src/hub.js';
import { regenInputFromLog, regeneratePacks } from '../src/packs.js';
import { boosters, filesOf, findRun, forgeFirstPick, haveBoosterData, rewrite, type Rec } from './helpers.js';

const run = findRun();
const opts: CheckOptions = { allowedEngineDigests: [], boosters, minLatencyMs: 300, fastShare: 0.1 };
const skip = run ? false : 'no finished run found (run scripts/smoke-event.sh or set HUB_TEST_RUN)';
const outcome = (r: ReturnType<typeof checkBundle>, id: string) => r.checks.find((c) => c.id === id)?.outcome;

test('an untouched bundle passes the integrity checks', { skip }, () => {
  const r = checkBundle(filesOf(run!), opts);
  assert.equal(r.structural, true, r.errors.join('; '));
  assert.equal(outcome(r, 'draft.consistency'), 'pass');
  assert.equal(outcome(r, 'draft.decks'), 'pass');
  assert.equal(outcome(r, 'games.consistency'), 'pass');
  if (haveBoosterData) assert.ok(['verified', 'partial'].includes(r.regen!.status), r.regen!.message);
  assert.ok(Object.keys(r.fingerprints).length >= 1);
});

test('a hash mismatch is a structural error', { skip }, () => {
  const f = rewrite(filesOf(run!), (ev) => void (ev[1]!.t += 1), false);
  const r = checkBundle(f, opts);
  assert.equal(r.structural, false);
  assert.ok(r.errors.some((e) => /sha256 mismatch for events.jsonl/.test(e)));
});

test('a pick that was not in the pack fails draft consistency', { skip }, () => {
  const f = rewrite(filesOf(run!), (ev) => {
    const p = ev.find((e) => e.type === 'draft_pick' && e.pack_number === 1 && e.pick_number === 2)!;
    p.pick = 'Black Lotus';
  });
  const r = checkBundle(f, opts);
  assert.equal(outcome(r, 'draft.consistency'), 'fail');
  assert.equal(policy(r.checks.find((c) => c.id === 'draft.consistency')!, 'upload'), 'reject');
  assert.equal(policy(r.checks.find((c) => c.id === 'draft.consistency')!, 'director'), 'hold');
});

test('a deck with a card from outside the pool fails', { skip }, () => {
  const f = rewrite(filesOf(run!), (ev) => {
    const d = ev.find((e) => e.type === 'deck_built')!;
    d.main[0] = 'Black Lotus';
  });
  assert.equal(outcome(checkBundle(f, opts), 'draft.decks'), 'fail');
});

test('a flipped game result fails game consistency', { skip }, () => {
  const f = rewrite(filesOf(run!), (ev) => {
    const g = ev.find((e) => e.type === 'game_over' && e.winner)!;
    const start = ev.find((e) => e.type === 'game_start' && e.game === g.game)!;
    g.winner = start.seats.find((s: string) => s !== g.winner);
  });
  assert.equal(outcome(checkBundle(f, opts), 'games.consistency'), 'fail');
});

test('edited standings in summary.json fail game consistency', { skip }, () => {
  const f = rewrite(filesOf(run!), (_ev, summary) => {
    summary.standings[0].gameWins += 5;
  });
  assert.equal(outcome(checkBundle(f, opts), 'games.consistency'), 'fail');
});

test('a forged first pick replays as a draft but fails pack regeneration', { skip: skip || (!haveBoosterData && 'no data/draft-pools.json') }, () => {
  const f = rewrite(filesOf(run!), (ev) => void forgeFirstPick(ev, 'Black Lotus'));
  const r = checkBundle(f, opts);
  assert.equal(outcome(r, 'draft.consistency'), 'pass', 'the forgery is internally consistent');
  assert.equal(outcome(r, 'draft.decks'), 'pass');
  assert.equal(r.regen!.status, 'mismatch', r.regen!.message);
  assert.equal(policy(r.checks.find((c) => c.id === 'packs.regeneration')!, 'upload'), 'reject');
});

test('pack regeneration: missing booster data or a different seed is unverifiable, not a failure', { skip: skip || (!haveBoosterData && 'no data/draft-pools.json') }, () => {
  const events: Rec[] = filesOf(run!).get('events.jsonl')!.toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const logged = regenInputFromLog(events)!;
  // Logs from before event_start.boosters (the legacy case this test is about); newer logs are checked below.
  const inp = { ...logged, boosters: undefined };
  assert.equal(regeneratePacks(inp, {}).status, 'unverifiable');
  const noList = regeneratePacks(inp, { defaultDraftPools: boosters.defaultDraftPools });
  assert.ok(['verified', 'partial'].includes(noList.status), noList.message);
  if (inp.rounds.some((r) => r.swaps.length)) assert.equal(noList.status, 'partial');
  const other = regeneratePacks({ ...inp, seed: `${inp.seed}-x` }, { defaultDraftPools: boosters.defaultDraftPools });
  assert.equal(other.status, 'unverifiable');
  assert.ok(other.missing?.includes('event_start.boosters.draft_pools_sha256'));
  // With the booster data named by sha256 (what the Director should log), a difference is a mismatch.
  const named = regeneratePacks({ ...inp, seed: `${inp.seed}-x`, boosters: { draft_pools_sha256: noList.draft_pools_sha256 } }, { defaultDraftPools: boosters.defaultDraftPools });
  assert.equal(named.status, 'mismatch');
  if (logged.boosters) {
    // A log that names its booster data (generator, both sha256s) regenerates exactly with the same files.
    const exact = regeneratePacks(logged, boosters);
    if (logged.boosters.unsupported_sha256 && exact.unsupported_sha256 === logged.boosters.unsupported_sha256) assert.equal(exact.status, 'verified', exact.message);
    assert.equal(exact.missing, undefined);
  }
});

test('latency anomalies: scripted speed on an LLM seat is flagged', { skip }, () => {
  const events: Rec[] = filesOf(run!).get('events.jsonl')!.toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  // Pretend the seats are LLMs: rename agents to model-like names and make every answer 5 ms.
  const names = new Map<string, string>();
  for (const s of events[0]!.seats) if (s.kind === 'agent') names.set(s.name, `sonnet-${names.size + 1}`);
  for (const e of events) {
    if (e.type === 'event_start') for (const s of e.seats) s.name = names.get(s.name) ?? s.name;
    if (typeof e.seat === 'string' && names.has(e.seat)) e.seat = names.get(e.seat);
    if (typeof e.latency_ms === 'number') e.latency_ms = 5;
  }
  const r = latencyAnomalies(events as any, { minLatencyMs: 300, fastShare: 0.1 });
  assert.equal(r.outcome, 'warn');
  assert.equal(policy(r, 'upload'), 'hold');
  assert.equal(policy(r, 'import'), 'flag');
});

test('eligibility: bot drafter seats make a bundle ineligible (rejected from uploads and Directors, flagged on import)', () => {
  const seats = Array.from({ length: 8 }, (_, i) => ({ name: i < 2 ? `rand-${i + 1}` : `bot-${i + 1}`, kind: i < 2 ? 'agent' : 'bot', position: i }));
  const dev = seatEligibility([{ t: 0, type: 'event_start', seats, dev_bot_fill: true }] as any);
  assert.equal(dev.outcome, 'fail');
  assert.match(dev.message, /6 of 8 seats are bot drafters/);
  assert.equal(policy(dev, 'upload'), 'reject');
  assert.equal(policy(dev, 'director'), 'reject');
  assert.equal(policy(dev, 'import'), 'flag');
  const full = seatEligibility([{ t: 0, type: 'event_start', seats: seats.map((s) => ({ ...s, kind: 'agent' })) }] as any);
  assert.equal(full.outcome, 'pass');
});

const swissRun = findRun((start) => !!start.pairing);
test('pairings: a Swiss event\'s pairings regenerate; an edited pairing fails', { skip: swissRun ? false : 'no finished Swiss run (scripts/smoke-event.sh)' }, () => {
  const files = filesOf(swissRun!);
  const r = checkBundle(files, opts);
  assert.equal(outcome(r, 'games.pairings'), 'pass');
  assert.equal(outcome(r, 'eligibility.agent_seats'), 'pass');
  const events: Rec[] = files.get('events.jsonl')!.toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const r2 = events.find((e) => e.type === 'round_start' && e.round === 2)!;
  [r2.pairs[0][1], r2.pairs[1][1]] = [r2.pairs[1][1], r2.pairs[0][1]];
  const bad = pairingCheck(events as any);
  assert.equal(bad.outcome, 'fail');
  assert.equal(policy(bad, 'upload'), 'reject');
});

test('card data (provenance.card_data): pinned upstream, with or without this repository\'s overrides; anything else is held', async () => {
  const { cardDataCheck } = await import('../src/checks.js');
  const { overridesFingerprint } = await import('../../director/src/cards.js');
  const { pinnedCardData } = await import('../src/config.js');
  const pinned = pinnedCardData();
  assert.ok(pinned.length >= 1 && pinned.every((s) => /^[0-9a-f]{64}$/.test(s)), 'the pinned build\'s card data, from deps/manifest.json');
  const up = pinned[0]!;
  const repo = { upstream: pinned, fingerprint: (slugs: string[]) => overridesFingerprint(slugs) };
  const start = (cd: unknown) => ({ type: 'event_start', provenance: cd === undefined ? {} : { card_data: cd } });
  const ha = overridesFingerprint(['heated-argument'])!;
  assert.match(ha, /^[0-9a-f]{64}$/);
  const cases: Array<[string, unknown, string]> = [
    ['logs from before card overrides', undefined, 'skip'],
    ['upstream card data, no sidecar', { sha256: up }, 'pass'],
    ['upstream card data with a sidecar that says so', { sha256: up, upstream_sha256: up, overrides_sha256: overridesFingerprint([]), overrides: [] }, 'pass'],
    ['the pinned upstream + Heated Argument, as this repository writes it', { sha256: 'b'.repeat(64), upstream_sha256: up, overrides_sha256: ha, overrides: ['heated-argument'] }, 'pass'],
    ['a stale sidecar on an unknown file', { sha256: 'c'.repeat(64), sidecar: 'stale' }, 'warn'],
    ['overrides that hash differently from this repository\'s files', { sha256: 'b'.repeat(64), upstream_sha256: up, overrides_sha256: 'd'.repeat(64), overrides: ['heated-argument'] }, 'warn'],
    ['an override this repository doesn\'t have', { sha256: 'b'.repeat(64), upstream_sha256: up, overrides_sha256: ha, overrides: ['made-up-card'] }, 'warn'],
    ['an upstream file that isn\'t a pinned build\'s', { sha256: 'b'.repeat(64), upstream_sha256: 'e'.repeat(64), overrides_sha256: ha, overrides: ['heated-argument'] }, 'warn'],
  ];
  for (const [what, cd, want] of cases) {
    const r = cardDataCheck(start(cd), repo);
    assert.equal(r.outcome, want, `${what}: ${r.message}`);
    assert.equal(r.id, 'provenance.card_data');
  }
  // A warning holds the bundle for a reviewer (hosted Directors and uploads); imports keep history with a flag.
  const warn = cardDataCheck(start({ sha256: 'c'.repeat(64), sidecar: 'stale' }), repo);
  assert.equal(policy(warn, 'director'), 'hold');
  assert.equal(policy(warn, 'upload'), 'hold');
  assert.equal(policy(warn, 'import'), 'flag');
});

test('the card-data check runs inside checkBundle when the Hub configures it', { skip }, async () => {
  const { pinnedCardData } = await import('../src/config.js');
  const { overridesFingerprint } = await import('../../director/src/cards.js');
  const without = checkBundle(filesOf(run!), opts);
  assert.equal(without.checks.some((c) => c.id === 'provenance.card_data'), false, 'not configured: not run');
  const r = checkBundle(filesOf(run!), { ...opts, cardData: { upstream: pinnedCardData(), fingerprint: (s) => overridesFingerprint(s) } });
  const c = r.checks.find((x) => x.id === 'provenance.card_data');
  assert.ok(c && ['pass', 'skip', 'warn'].includes(c.outcome), JSON.stringify(c));
});
