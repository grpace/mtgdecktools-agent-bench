/**
 * docs/legal as readers get it (terms.ts legalForReaders; the Hub's /legal/*, mirrored by the site's LegalPage): no
 * "ask us" with nowhere to ask while no contact address is configured, no owner notes, and the draft notice until the
 * legal review is done.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { repoRoot } from '../../site/src/context.js';
import { legalForReaders } from '../src/terms.js';

const DOCS = ['TERMS', 'PRIVACY', 'CONTENT-POLICY'].map((n) => ({ n, md: readFileSync(join(repoRoot, 'docs', 'legal', `${n}.md`), 'utf8') }));

test('no contact address: every request sentence says it can’t be made yet; no placeholder, owner note or marker', () => {
  for (const { n, md } of DOCS) {
    const out = legalForReaders(md, { contact: null });
    assert.doesNotMatch(out, /CONTACT_URL/, n);
    assert.doesNotMatch(out, /OWNER/, n);
    assert.doesNotMatch(out, /\[\[no-contact/, n);
    assert.match(out, /can't be (made|sent) yet/, n);
    assert.doesNotMatch(out, /Draft|not been reviewed/, n);
    assert.doesNotMatch(out, /owner's review/, n);
  }
  const terms = legalForReaders(DOCS[0]!.md, { contact: null });
  assert.doesNotMatch(terms, /You can ask us to take down/, 'no "ask us" without an address');
  assert.doesNotMatch(terms, /Ask us to take down/, 'nor in the short version');
  assert.match(terms, /- \*\*You can leave\*\*, but takedown and erasure requests can't be made yet/);
  assert.match(terms, /Takedown and erasure requests can't be made yet: they open with the contact address, before the public launch\./);
  assert.match(terms, /## 10\. Contact\n\nThere is no contact address yet/, 'the Contact section says so');
});

test('with a contact address: it is named, and the not-yet sentences go', () => {
  for (const { n, md } of DOCS) {
    const out = legalForReaders(md, { contact: 'https://example.org/contact' });
    assert.doesNotMatch(out, /CONTACT_URL|\[\[no-contact|can't be (made|sent) yet/, n);
    assert.match(out, /https:\/\/example\.org\/contact/, n);
  }
  assert.match(legalForReaders(DOCS[0]!.md, { contact: 'https://example.org/contact' }), /You can ask us to take down an event you played or uploaded, or to erase your contributor account, at https:\/\/example\.org\/contact\. The \[Privacy Notice\]/);
});

test('a mailto: contact reads as the bare address', () => {
  const out = legalForReaders(DOCS[0]!.md, { contact: 'mailto:magic@greg.tech' });
  assert.match(out, /erase your contributor account, at magic@greg\.tech\./);
  assert.doesNotMatch(out, /mailto:/);
});
