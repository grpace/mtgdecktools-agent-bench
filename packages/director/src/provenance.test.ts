/**
 * The Director version (directorVersion): an explicit DIRECTOR_TAG, else the commit Coolify deployed (SOURCE_COMMIT).
 *   npx tsx packages/director/src/provenance.test.ts
 */
import assert from 'node:assert/strict';
import { directorVersion, provisionalSets } from './provenance.js';

const sha = '0123456789abcdef0123456789abcdef01234567';
function version(env: { DIRECTOR_TAG?: string; SOURCE_COMMIT?: string }): string {
  const saved = { DIRECTOR_TAG: process.env.DIRECTOR_TAG, SOURCE_COMMIT: process.env.SOURCE_COMMIT };
  for (const k of ['DIRECTOR_TAG', 'SOURCE_COMMIT'] as const) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return directorVersion();
  } finally {
    for (const k of ['DIRECTOR_TAG', 'SOURCE_COMMIT'] as const) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// `bench up` and the CI image check pass their own tag; it wins.
assert.equal(version({ DIRECTOR_TAG: 'abc1234-dirty', SOURCE_COMMIT: sha }), 'abc1234-dirty');
// Coolify builds the image with the default tag and passes the deployed commit: its short form.
assert.equal(version({ DIRECTOR_TAG: 'local', SOURCE_COMMIT: sha }), '0123456');
// Anything that isn't a full commit hash is not taken for one.
assert.equal(version({ DIRECTOR_TAG: 'local', SOURCE_COMMIT: 'unknown' }), 'local');
assert.equal(version({ DIRECTOR_TAG: 'local' }), 'local');
console.log('ok - directorVersion: DIRECTOR_TAG, else the deployed commit');

// Provisional booster sheets (engine/provisional-boosters/) are found by the pool's own `provisional: true`.
assert.deepEqual(provisionalSets(Buffer.from(JSON.stringify({ fra: { code: 'FRA' } }))), []);
assert.deepEqual(provisionalSets(Buffer.from(JSON.stringify({ trk: { code: 'TRK', provisional: true }, fra: { code: 'FRA' }, xyz: { provisional: 'yes' } }))), ['TRK']);
console.log('ok - provisionalSets: pools marked provisional: true');

// The Director only plays on the pinned build (phase.ts sameBuild): commits compare as prefixes, either way round.
import('./phase.js').then(({ sameBuild }) => {
  assert.equal(sameBuild('ad0de6a', 'ad0de6adf'), true);
  assert.equal(sameBuild('ad0de6adf0', 'ad0de6a'), true);
  assert.equal(sameBuild('ad0de6a', '4f73fb039'), false);
  assert.equal(sameBuild('ad0de6a', undefined), false);
  assert.equal(sameBuild(undefined, '4f73fb039'), true);
  console.log('ok - sameBuild: the pinned build, by commit prefix');
});
