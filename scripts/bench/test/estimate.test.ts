// Token and cost estimates (node --import tsx --test). Every match is best of 3 with sideboarding; the request model's
// per-game sizes are calibrated on the first two 8-seat hosted tables (best of 1), checked here in their shape.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { priceFor } from '../../../packages/registry/src/prices.js';
import { calibrationTokens, effortFactor, projectTokens, runUsd, seatUsd, sumOf, tableUsd } from '../estimate.js';
import { estimate, TOKENS_NOTE } from '../setup.js';

const M = 1e6;

test('calibration, one session per seat: the request model brackets the first table (54 to 168 M cache reads per seat)', () => {
  const { low, high } = calibrationTokens();
  assert.ok(sumOf(low, 'read') >= 45 * M && sumOf(low, 'read') <= 65 * M, `low ${sumOf(low, 'read') / M} M`);
  assert.ok(sumOf(high, 'read') >= 140 * M && sumOf(high, 'read') <= 175 * M, `high ${sumOf(high, 'read') / M} M`);
  // Cache writes 0.55 to 1.13 M measured; output 57 to 100 k.
  assert.ok(sumOf(low, 'write') >= 0.5 * M && sumOf(high, 'write') <= 1.2 * M);
  assert.ok(low.output >= 50e3 && high.output <= 110e3);
  // In dollars: $3.20 to $9.51 per seat measured (finished seats stopping).
  const [lo, hi] = seatUsd('claude-haiku-5-5', '2026-10-22', 'off', 'low', calibrationTokens())!;
  assert.ok(lo >= 2.5 && lo <= 4, `low $${lo}`);
  assert.ok(hi >= 8 && hi <= 10.5, `high $${hi}`);
});

test('calibration, a fresh session per game: the second table\'s seats ($0.27–0.93 low, $0.55–1.46 medium) are inside the range', () => {
  const shape = calibrationTokens('per-game');
  const low = seatUsd('claude-haiku-5-5', '2026-10-22', 'per-game', 'low', shape)!;
  const medium = seatUsd('claude-haiku-5-5', '2026-10-22', 'per-game', 'medium', shape)!;
  assert.ok(low[0] <= 0.27 && low[1] >= 0.93, `low $${low}`);
  assert.ok(medium[0] <= 0.55 && medium[1] >= 1.4, `medium $${medium}`);
  // The table: $5.93 measured (4 low, 4 medium), and the range is centered near it.
  const total = [4 * (low[0] + medium[0]), 4 * (low[1] + medium[1])];
  assert.ok(total[0]! <= 5.93 && total[1]! >= 5.93 && total[1]! < 12, `$${total}`);
  // Tokens per seat at low: 7.3 to 15 M cache reads, 40 to 63 k output measured.
  assert.ok(sumOf(shape.low, 'read') <= 9e6 && sumOf(shape.high, 'read') >= 15e6);
  assert.ok(shape.low.output <= 40e3 && shape.high.output >= 55e3);
});

test('best of 3 with sideboarding: 6 to 9 games, and the between-games decisions on top', () => {
  const off = projectTokens();
  // More than twice the measured shape: each game re-reads a longer conversation in one session.
  assert.ok(sumOf(off.low, 'read') > 2.5 * sumOf(calibrationTokens().low, 'read'));
  const fresh = projectTokens('per-game');
  const base = calibrationTokens('per-game');
  // 6 to 9 games in their own sessions: about 2 to 3 times the 3-game shape, not the one-session blow-up.
  assert.ok(sumOf(fresh.low, 'read') > 1.8 * sumOf(base.low, 'read') && sumOf(fresh.high, 'read') < 3.6 * sumOf(base.high, 'read'));
  // Sideboarding: 3 (low) to 6 (high) between-games points per seat, each adding its decision text and output.
  assert.equal(fresh.low.output - 5e3 - 6 * 10e3, 3 * 0.5e3);
  assert.equal(fresh.high.output - 5e3 - 9 * 17e3, 6 * 3e3);
  const [lo, hi] = seatUsd('claude-haiku-5-5', '2026-10-22', 'per-game')!;
  assert.ok(lo > 0.3 && lo < 0.8 && hi > 2 && hi < 4.5, `$${lo}–${hi}`);
  assert.equal(tableUsd(['claude-haiku-5-5'], 'per-game').perModel[0]!.basis, 'projected');
});

test('the long-context surcharge applies above the listed size only (Haiku: 5× above 100 k)', () => {
  const price = priceFor('claude-haiku-5-5', '2026-10-22')!;
  const at = (context: number) => runUsd({ calls: [{ context, read: 1 * M, write: 0 }], output: 0 }, 'claude-haiku-5-5', price);
  assert.ok(Math.abs(at(90e3) - 0.01) < 1e-9);
  assert.ok(Math.abs(at(200e3) - 0.05) < 1e-9);
});

test('the long-context prices come from the registry (GPT-6.1 Sol over 272 k; flat-priced Claude Opus 5.5 has none)', () => {
  const sol = priceFor('gpt-6.1-sol', '2026-10-22')!;
  const run = (context: number) => ({ calls: [{ context, read: 1 * M, write: 0 }], output: 1 * M });
  // Base: $0.10 per M cache reads, $10 per M output; long: $0.20 and $15.
  assert.ok(Math.abs(runUsd(run(250e3), 'gpt-6.1-sol', sol) - 10.1) < 1e-9);
  assert.ok(Math.abs(runUsd(run(300e3), 'gpt-6.1-sol', sol) - 15.2) < 1e-9);
  const opus = priceFor('claude-opus-5-5', '2026-10-22')!;
  assert.ok(Math.abs(runUsd(run(900e3), 'claude-opus-5-5', opus) - (0.2 + 20)) < 1e-9);
});

test('the estimate keeps the table total and the time; it prints no projection (TOKENS_NOTE instead)', () => {
  const e = estimate(3, ['claude-haiku-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5'], 'per-game', ['low', 'low', 'low']);
  assert.ok(Math.abs(e.per_seat.usd[0]! * 3 - e.table_usd[0]) < 1e-9);
  assert.equal('tokens' in e, false);
  assert.match(estimate(8).time, /^about 45 min to 2\.4 h: .*once its last match ends it stops/);
  assert.doesNotMatch(TOKENS_NOTE, /\$|\d M\b|list price/);
});

test('a seat seated by hand keeps one session, and Keep Playing sizes it that way', () => {
  const e = estimate(2, ['claude-haiku-5-5', 'gemini-3.8-flash'], 'per-game', ['low', 'high'], [undefined, 'off']);
  const [lo, hi] = seatUsd('gemini-3.8-flash', Date.now(), 'off', 'high')!;
  const [hlo, hhi] = seatUsd('claude-haiku-5-5', Date.now(), 'per-game', 'low')!;
  assert.ok(Math.abs(e.table_usd[0] - (lo + hlo)) < 1e-9 && Math.abs(e.table_usd[1] - (hi + hhi)) < 1e-9);
  assert.ok(lo > seatUsd('gemini-3.8-flash', Date.now(), 'per-game', 'high')![0], 'one session costs more than a fresh one per game');
});

test('a fresh session per game (the default for launched seats) is much cheaper than one long session', () => {
  const off = projectTokens();
  const fresh = projectTokens('per-game');
  assert.ok(sumOf(fresh.low, 'read') < sumOf(off.low, 'read') / 2);
  assert.ok(sumOf(fresh.high, 'read') < sumOf(off.high, 'read') / 2);
  const [lo, hi] = seatUsd('claude-haiku-5-5', '2026-10-22', 'per-game')!;
  const [offLo, offHi] = seatUsd('claude-haiku-5-5', '2026-10-22')!;
  assert.ok(lo < offLo / 2 && hi < offHi / 2, `$${lo}–${hi} vs $${offLo}–${offHi}`);
  // Per match sits between the two (2 or 3 games per session).
  assert.ok(sumOf(projectTokens('per-match').high, 'read') > sumOf(fresh.high, 'read'));
  assert.ok(sumOf(projectTokens('per-match').high, 'read') < sumOf(off.high, 'read'));
});

test('medium effort costs more than low (measured 1.32×); higher levels more again; unknown counts as medium', () => {
  const [l0, l1] = seatUsd('claude-haiku-5-5', '2026-10-22', 'per-game', 'low')!;
  const [m0, m1] = seatUsd('claude-haiku-5-5', '2026-10-22', 'per-game', 'medium')!;
  assert.ok(m0 > l0 && m1 > l1);
  assert.ok(Math.abs(m1 / l1 - 1.32) < 1e-9);
  const order = ['low', 'medium', 'high', 'xhigh', 'max'].map((x) => effortFactor(x).usd);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.equal(effortFactor('unknown'), effortFactor('medium'));
  assert.equal(effortFactor(undefined), effortFactor('medium'));
});
