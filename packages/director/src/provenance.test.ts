/**
 * The Director version (directorVersion): an explicit DIRECTOR_TAG, else the commit Coolify deployed (SOURCE_COMMIT).
 *   npx tsx packages/director/src/provenance.test.ts
 */
import assert from 'node:assert/strict';
import { directorVersion } from './provenance.js';

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
