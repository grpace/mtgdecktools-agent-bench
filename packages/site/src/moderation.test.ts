/**
 * The Hub's moderation list on parsed events (a Director's own /data export), and automatic features skipping
 * flagged or hidden notes.
 *   npx tsx packages/site/src/moderation.test.ts
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileModeration, REMOVED_TEXT } from '../../director/src/public-text.js';
import { loadEvent } from './data.js';
import { quotable } from './highlights.js';
import { moderateEvent, moderateEvents } from './moderation.js';

const E = '2026-10-22-10-00-00-sos-abcd';
const root = mkdtempSync(join(tmpdir(), 'mtgdt-site-mod-'));
try {
  const dir = join(root, E);
  mkdirSync(dir);
  const recs = [
    { t: 1, type: 'event_start', id: E, set: { code: 'SOS', name: 'Secrets of Strixhaven' }, best_of: 3,
      seats: [{ name: 'seat-aaaaaa', kind: 'agent', position: 0, contributor_id: '7', contributor: 'rudehandle' }, { name: 'seat-bbbbbb', kind: 'agent', position: 1, contributor_id: '9', contributor: 'alice' }],
      organizer: { kind: 'lobby' } },
    { t: 2, type: 'draft_pick', seat: 'seat-aaaaaa', pack_number: 1, pick_number: 1, overall_pick: 1, pack: ['A', 'B'], pick: 'A', by: 'agent', note: 'A rude first pick note' },
    { t: 3, type: 'draft_pick', seat: 'seat-bbbbbb', pack_number: 1, pick_number: 1, overall_pick: 1, pack: ['B'], pick: 'B', by: 'agent', note: 'Saved my list to /home/alice/picks.txt' },
    { t: 4, type: 'deck_built', seat: 'seat-bbbbbb', by: 'agent', main: ['B'], sideboard: [], note: 'deck plan' },
    { t: 5, type: 'game_start', game: 'g1', seats: ['seat-aaaaaa', 'seat-bbbbbb'], match: 'm1', game_number: 1 },
    { t: 6, type: 'decision_offered', game: 'g1', seat: 'seat-aaaaaa', id: 'G1', kind: 'Priority', turn: 1, text: 'view' },
    { t: 7, type: 'agent_decision', game: 'g1', seat: 'seat-aaaaaa', id: 'G1', kind: 'Priority', turn: 1, choice: 'Pass priority', note: 'hidden decision note', accepted: true },
    { t: 8, type: 'rules_issue', seat: 'seat-bbbbbb', card: 'Heated Argument', note: 'report text', stage: 'games', game: 'g1', turn: 1 },
  ];
  writeFileSync(join(dir, 'events.jsonl'), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const ev = loadEvent(dir, Date.now())!;
  assert.ok(ev, 'the fixture loads');
  const c = compileModeration({
    version: 't', takedowns: [],
    hides: [
      { kind: 'note', event: E, seat: 'seat-aaaaaa', item: 'pick-1' },
      { kind: 'note', event: E, seat: 'seat-aaaaaa', item: 'G1' },
      { kind: 'note', event: E, seat: 'seat-bbbbbb', item: 'deck' },
      { kind: 'note', event: E, seat: 'seat-bbbbbb', item: 'rules-8' },
    ],
    hiddenHandles: ['7'], erased: [{ id: '9', anon: 'erased-0011' }],
  });
  moderateEvent(ev, c);
  assert.equal(ev.picks.find((p) => p.seat === 'seat-aaaaaa')!.note, REMOVED_TEXT);
  assert.equal(ev.picks.find((p) => p.seat === 'seat-bbbbbb')!.note, 'Saved my list to [path]', 'other notes are scrubbed');
  assert.equal(ev.decks.get('seat-bbbbbb')!.note, REMOVED_TEXT);
  assert.equal(ev.games[0]!.decisions.find((d) => d.id === 'G1')!.answer!.note, REMOVED_TEXT);
  assert.equal([...ev.rulesIssues, ...ev.games.flatMap((g) => g.rulesIssues)][0]!.note, REMOVED_TEXT);
  const a = ev.seats.find((s) => s.name === 'seat-aaaaaa')!;
  const b = ev.seats.find((s) => s.name === 'seat-bbbbbb')!;
  assert.equal(a.contributorHandle, undefined, 'a handle moderators hid is dropped');
  assert.equal(a.contributorId, '7');
  assert.deepEqual([b.contributorId, b.contributorHandle], ['erased-0011', undefined], 'an erased contributor is anonymized');
  // Taken down: out of the export.
  const ev2 = loadEvent(dir, Date.now())!;
  assert.deepEqual(moderateEvents([ev2], compileModeration({ version: 'x', takedowns: [E], hides: [], hiddenHandles: [], erased: [] })), []);
} finally {
  rmSync(root, { recursive: true, force: true });
}

// Automatic features (event highlights, model pages) need the filter's pass; hidden text is never quoted.
assert.ok(quotable('Bitter Triumph answers their best threat for two mana, and I keep my curve intact.'));
assert.ok(!quotable('This draw is total shit but Bitter Triumph still answers their best threat for two.'), 'flagged words');
assert.ok(!quotable('Read my full draft write-up at https://example.com/draft before the next game, please.'), 'links');
assert.ok(!quotable(REMOVED_TEXT));

console.log('moderation: ok');
