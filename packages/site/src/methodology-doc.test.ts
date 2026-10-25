/**
 * docs/METHODOLOGY.md says what the code does (it is shipped with every export as methodology.md). Phrases that once
 * contradicted the code, and the rules the code relies on, are checked here so they can't drift back.
 *   npx tsx packages/site/src/methodology-doc.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './context.js';
import { FORFEIT_POLICY } from './scoring.js';
import { DEFAULT_RATING_OPTIONS } from './rating.js';
import { provisionalRule } from './summary.js';

const doc = readFileSync(join(repoRoot, 'docs', 'METHODOLOGY.md'), 'utf8').replace(/\s+/g, ' ');
let failed = 0;
const check = (name: string, f: () => void) => {
  try {
    f();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n     ${(err as Error).message}`);
  }
};

check('forfeits: the doc never says a conceded game is unrated while the policy is "loss"', () => {
  assert.equal(FORFEIT_POLICY, 'loss');
  assert.doesNotMatch(doc, /conceded[^.]{0,80}(isn['’]t rated|not rated|not counted)/i);
  assert.doesNotMatch(doc, /Not counted:[^.]*watchdog/i);
});

check('stopped events: finished games rated, never "only finished events are rated"', () => {
  assert.doesNotMatch(doc, /Only finished events are rated/);
  assert.match(doc, /Stopped events/);
});

check('play advantage and the mirror on-play rate: game 1 only, never a "clean estimate" over all games', () => {
  assert.doesNotMatch(doc, /across all mirror games, a clean estimate/);
  assert.match(doc, /in game 1 of each match only/);
});

check('seat classification: metadata, not the rand-* name', () => assert.doesNotMatch(doc, /scripted `rand-\*` agents only/));

check('the provisional rule is stated whole, with the contributor floor', () => {
  const rule = provisionalRule(DEFAULT_RATING_OPTIONS);
  assert.ok(doc.includes(rule.split(' The contributor part')[0]!), 'the one-sentence rule appears in §4');
});

check('no overclaiming: an unqualified "validated" build model, "calibrated" without "in simulation"', () => {
  assert.ok(!doc.includes('Every set is labeled `validated`.'), 'the build model ties the baseline: never just "validated"');
  assert.ok(doc.includes('calibrated in simulation'), 'calibration is a simulation result');
  assert.ok(!doc.includes('more thinking helped'), 'no causal ladder verdicts');
});

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nmethodology doc: all passed');
