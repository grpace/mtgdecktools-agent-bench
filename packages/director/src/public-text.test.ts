/**
 * Public text: the scrubber (API keys, JWTs, IPv6, e-mail, paths; card text intact), the review filter, moderation
 * applied to raw records, and a hosted Director's moderation sync (takedowns leave the run folder, the export and
 * the spectator stream; hidden notes reach replays).
 *   npx tsx packages/director/src/public-text.test.ts
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentModeration, isTakenDown, ModerationSync, setModeration } from './moderation.js';
import {
  compileModeration, flagHandle, flagText, moderateLog, moderateRecord, noteItem, passesFilter, REMOVED_TEXT, scrubPublic, scrubText, type ModerationList,
} from './public-text.js';
import { publicMsg } from './spectate-http.js';

// ---------------------------------------------------------------------------
// Scrubber: secrets of every common format (fixtures are fake keys of the right shape)

const secrets: Array<[string, string]> = [
  ['Anthropic', 'sk-ant-api03-Zx9kQ2mN7pLr4TvW8yB1cD5fG3hJ6kL0aSdF-gHjK'],
  ['OpenAI project', 'sk-proj-Ab3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7d'],
  ['OpenAI legacy', 'sk-Ab3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7dE9f'],
  ['OpenRouter', 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef'],
  ['GitHub classic', 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'],
  ['GitHub OAuth', 'gho_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'],
  ['GitHub fine-grained', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ'],
  ['AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
  ['Google API key', 'AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY'],
  ['Google OAuth token', 'ya29.a0AfH6SMBx1234567890abcdefghijklmnop'],
  ['Slack', 'xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx'],
  ['Stripe', 'sk_live_51Hx0123456789abcdefGHIJ'],
  ['Hugging Face', 'hf_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'],
  ['generic random key', 'Zx9kQ2mN7pLr4TvW8yB1cD5fG3hJ6kL0aSdFgHjK'],
];
for (const [what, key] of secrets) {
  const out = scrubText(`my key is ${key}, do not share`);
  assert.ok(!out.includes(key), `${what}: ${out}`);
  assert.match(out, /^my key is \[(secret|token)\], do not share$/, what);
}
assert.equal(scrubText('aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'), 'aws_secret_access_key = [secret]');
assert.equal(scrubText('{"api_key": "abc123secretvalue"}'), '{"api_key": "[secret]"}');
assert.equal(scrubText('PASSWORD=hunter22x'), 'PASSWORD=[secret]');
// HUB-36: invisible characters leave every public output, community bundles included (they never pass the Director's cleaner).
assert.equal(scrubText(`deck\u202Ename\u2066x\u2069${String.fromCodePoint(0xe0068, 0xe0069)}`), 'decknamex');
assert.equal(scrubText('ok\u0000nul \ud800lone \u001b[31mred\u001b[0m \u202eevil\u202c \u0007bell'), 'oknul \ufffdlone \u001b[31mred\u001b[0m evil \u0007bell');
assert.equal(scrubText('\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F} ok'), '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F} ok');
assert.equal(scrubText('Authorization: Bearer abcdefghijklmnop0123456789'), 'Authorization: Bearer [token]');
assert.equal(scrubText('-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----'), '[secret]');
assert.equal(scrubText('mtgdt_con_AbCdEfGhIjKlMnOpQrStUv'), '[token]');
// JWTs.
assert.equal(scrubText('jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c ok'), 'jwt [token] ok');
// Seat tokens (32 hex) and seat URLs.
assert.equal(scrubText('http://d/mcp/0123456789abcdef0123456789abcdef'), 'http://d/mcp/[token]');
// E-mail, IPv4, IPv6 (full, compressed, loopback, zone, embedded IPv4); times and ratios are not addresses.
assert.equal(scrubText('mail greg@example.com now'), 'mail [email] now');
assert.equal(scrubText('host 10.1.10.101:8787'), 'host [ip]:8787');
assert.equal(scrubText('v6 2001:0db8:85a3:0000:0000:8a2e:0370:7334 end'), 'v6 [ip] end');
assert.equal(scrubText('v6 2001:db8::8a2e:370:7334 end'), 'v6 [ip] end');
assert.equal(scrubText('at fe80::1%eth0 and ::1.'), 'at [ip] and [ip].');
assert.equal(scrubText('mapped ::ffff:192.0.2.128 here'), 'mapped [ip] here');
assert.equal(scrubText('Turn 3 at 12:30:45, a 2:1 trade'), 'Turn 3 at 12:30:45, a 2:1 trade');
// File paths: Unix, macOS, home shorthand, Windows (both slashes), UNC, file URLs, env-var homes.
for (const p of ['/home/greg/agents/run', '/Users/greg/Library/x.json', '~/work/bench', 'C:\\Users\\greg\\bench', 'D:/work/bench/x.txt',
  '\\\\server\\share\\x', 'file:///tmp/x', '$HOME/.claude/config', '%USERPROFILE%\\bench', '/etc/hosts', '/tmp/claude-1234']) {
  assert.equal(scrubText(`see ${p} now`), 'see [path] now', p);
}
// Hex digests, event ids, seat names, identity keys, group keys and URLs stay.
for (const keep of [
  'sha256:23355427c25fc38e27b7138dd3b2c51f7b50a942a40b4c3e6db6cdb98c8fbce7', '2026-10-22-14-39-42-sos-909e', 'seat-4ff9a3', 'c-1a2b3c4d5e6f',
  'claude-haiku-5-5/medium', 'prompt=sha256:0123456789abcdef;knowledge=primer', 'https://www.17lands.com/public_datasets',
  'https://github.com/phase-rs/phase/issues/10205', 'https://bench-data.mtgdecktools.com/data/open/latest.json', 'v0.115.0', '1.2.3',
]) assert.equal(scrubText(keep), keep, keep);

// Card text is never touched: a fixture of tricky rules text (P/T, mana, colons, loyalty, URLs in flavor-free text).
const cards = [
  'Flying\nWhenever Serra Angel attacks, it gets +1/+1 until end of turn.',
  '{T}: Add {C}{C}. {2}, {T}: Draw a card.',
  '+1: Up to one target creature gets +2/+0. −3: Destroy target creature. −8: You get an emblem with "Creatures you control get +1/+1."',
  'Choose one —\n• Counter target spell.\n• Return target permanent to its owner\'s hand.',
  'Equipped creature gets +X/+X, where X is the number of cards in your graveyard. Equip {3}',
  '"Ach! Hans, run! It\'s the . . ." When Brims" Barone enters, put a +1/+1 counter on each other creature you control.',
  'Kicker {1}{G}{G}: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'Create a 1/1 white Soldier creature token. Token: Treasure (Sacrifice this: add one mana of any color.)',
  'Vehicle 3/3 Crew 2 · Station 7+ · Saga I, II, III — Lore counter',
];
for (const c of cards) assert.equal(scrubText(c), c, c);
// Every card, when the local card data is there (gitignored; CI has it from the engine container).
const slim = join(import.meta.dirname, '../../../data/card-data.slim.json');
if (existsSync(slim)) {
  const all = JSON.parse(readFileSync(slim, 'utf8')) as Array<{ name: string; oracle?: string; typeLine?: string }>;
  const changed = all.filter((c) => [c.name, c.oracle ?? '', c.typeLine ?? ''].some((t) => scrubText(t) !== t)).map((c) => c.name);
  assert.deepEqual(changed.slice(0, 5), [], `${changed.length} card(s) changed by the scrubber`);
  const flagged = all.filter((c) => flagText(`${c.name} ${c.oracle ?? ''}`).length).map((c) => c.name);
  assert.deepEqual(flagged.slice(0, 5), [], `${flagged.length} card(s) flagged by the filter`);
}
// scrubPublic keeps keys and shapes.
assert.deepEqual(scrubPublic({ note: 'see /home/x/y', n: 3, list: ['me@x.io', null], nested: { ok: true } }), { note: 'see [path]', n: 3, list: ['[email]', null], nested: { ok: true } });

// ---------------------------------------------------------------------------
// Review filter

assert.deepEqual(flagText('This deck is fucking great'), ['word:fucking']);
assert.deepEqual(flagText('Sh1t, I drew lands'), ['word:shit']);
assert.deepEqual(flagText('join us at https://discord.gg/abc'), ['link']);
assert.deepEqual(flagText('www.example.com has the list'), ['link']);
assert.deepEqual(flagText('Cockatrice blocks; Assassin\'s Strike; Scunthorpe; Raccoon; grape'), [], 'whole words only');
assert.deepEqual(flagText(REMOVED_TEXT), []);
assert.ok(passesFilter('Take the removal: Bitter Triumph answers their best threat cheaply.'));
assert.ok(!passesFilter('what a shit draw'));
assert.ok(!passesFilter(REMOVED_TEXT));
assert.ok(flagHandle('xXfuckXx').includes('word:fuck'), 'handles: words inside run-together handles');
assert.deepEqual(flagHandle('anthropic-official'), ['impersonation']);
assert.deepEqual(flagHandle('mtgdt'), ['impersonation']);
assert.deepEqual(flagHandle('grpace'), []);
assert.deepEqual(flagHandle('cockatrice-fan'), [], 'handles: no false hit on card names');

// ---------------------------------------------------------------------------
// Moderation of raw records

const E = '2026-10-22-14-39-42-sos-909e';
const list: ModerationList = {
  version: 'v1', takedowns: ['2026-10-01-00-00-00-fra-dead'],
  hides: [
    { kind: 'note', event: E, seat: 'seat-b', item: 'deck' },
    { kind: 'deck_name', event: E, seat: 'seat-b', item: '' },
    { kind: 'note', event: E, seat: 'seat-b', item: 'rules-1700' },
  ],
  hiddenHandles: ['7'], erased: [{ id: '9', anon: 'erased-abc123' }],
};
const c = compileModeration(list);
const start = {
  t: 1, type: 'event_start', id: E,
  seats: [{ name: 'seat-a', contributor_id: '7', contributor: 'rudehandle' }, { name: 'seat-b', contributor_id: '9', contributor: 'alice' }, { name: 'seat-c', contributor_id: '3', contributor: 'bob' }],
  organizer: { kind: 'contributor', contributor_id: '9', handle: 'alice' },
};
const ms = moderateRecord(start, E, c);
assert.deepEqual(ms.seats, [{ name: 'seat-a', contributor_id: '7' }, { name: 'seat-b', contributor_id: 'erased-abc123' }, { name: 'seat-c', contributor_id: '3', contributor: 'bob' }]);
assert.deepEqual(ms.organizer, { kind: 'contributor', contributor_id: 'erased-abc123' });
assert.equal(start.seats[0]!.contributor, 'rudehandle', 'the input record is never changed');

// Public records carry choices only: a note or analysis on a pick, deck, decision, play/draw or sideboarding record
// (an older log, or a harness that sent one anyway) is dropped; the input record is never changed.
const dec = { t: 5, type: 'agent_decision', game: 'g1', seat: 'seat-a', id: 'G42', choice: 'Attack', note: 'a rude note' };
assert.deepEqual(moderateRecord(dec, E, c), { t: 5, type: 'agent_decision', game: 'g1', seat: 'seat-a', id: 'G42', choice: 'Attack' });
assert.equal(dec.note, 'a rude note');
assert.ok(!('note' in moderateRecord(dec, 'another-event', c)), 'in every event, hides or not');
assert.ok(!('note' in moderateRecord({ t: 6, type: 'draft_pick', seat: 'seat-a', overall_pick: 3, pick: 'X', note: 'n' }, E, c)));
for (const type of ['play_draw', 'sideboarded']) assert.ok(!('note' in moderateRecord({ t: 6, type, seat: 'seat-a', note: 'n' }, E, c)), type);
const deck = moderateRecord({ t: 7, type: 'deck_built', seat: 'seat-b', deck_name: 'Bad Name', archetype: 'UW', analysis: 'long', note: 'plan', main: [] }, E, c);
assert.deepEqual([deck.deck_name, deck.archetype, 'analysis' in deck, 'note' in deck], [REMOVED_TEXT, REMOVED_TEXT, false, false]);
assert.equal(moderateRecord({ t: 7, type: 'deck_built', seat: 'seat-c', deck_name: 'Fine', archetype: 'UW', main: [] }, E, c).archetype, 'UW', 'other decks keep theirs');
assert.equal(moderateRecord({ t: 1700, type: 'rules_issue', seat: 'seat-b', card: 'Heated Argument', note: 'x' }, E, c).note, REMOVED_TEXT);
assert.equal(moderateRecord({ t: 1701, type: 'rules_issue', seat: 'seat-b', card: 'Heated Argument', note: 'x' }, E, c).note, 'x', 'other rules reports are kept');
// Scrubbing applies to agent text everywhere, hides or not.
assert.equal(moderateRecord({ t: 8, type: 'rules_issue', seat: 'seat-c', card: 'X', note: 'my key sk-ant-api03-Zx9kQ2mN7pLr4TvW8yB1cD5fG3hJ' }, E, c).note, 'my key [secret]');
assert.equal(moderateRecord({ t: 8, type: 'deck_built', seat: 'seat-c', deck_name: 'mail me at a@b.example', main: [] }, E, c).deck_name, 'mail me at [email]');
const plain = { t: 9, type: 'turn_snapshot', game: 'g1' };
assert.equal(moderateRecord(plain, E, c), plain, 'records without agent text are returned as they are');
assert.deepEqual(noteItem({ type: 'rules_issue', t: 12, seat: 'seat-a' }), { seat: 'seat-a', item: 'rules-12' });
assert.equal(noteItem({ type: 'agent_decision', id: 'G1', seat: 'seat-a' }), undefined, 'a decision holds no text to hide');
// A whole log: the event id comes from event_start; untouched logs come back as the same string.
const log = [JSON.stringify(start), JSON.stringify(dec), 'not json', JSON.stringify(plain)].join('\n') + '\n';
const mlog = moderateLog(log, c).split('\n');
assert.ok(!('note' in JSON.parse(mlog[1]!)));
assert.equal(mlog[2], 'not json');
const clean = [JSON.stringify({ t: 1, type: 'event_start', id: 'x', seats: [] }), JSON.stringify(plain)].join('\n');
assert.equal(moderateLog(clean, c), clean);

// ---------------------------------------------------------------------------
// Spectator messages: agent text scrubbed on the way out

const msg = { seq: 4, t: 1, type: 'decision', seat: 'seat-a', note: 'saved to /home/greg/notes.txt', choice: 'Attack' };
assert.equal(publicMsg(msg).note, 'saved to [path]');
assert.equal(publicMsg({ seq: 5, t: 1, type: 'board' }).type, 'board');

// ---------------------------------------------------------------------------
// A hosted Director's sync: takedowns delete the run folder and the exported files; the list persists

const root = mkdtempSync(join(tmpdir(), 'mtgdt-mod-'));
try {
  const runs = join(root, 'runs');
  const data = join(root, 'site-data');
  const gone = '2026-10-01-00-00-00-fra-dead';
  const kept = '2026-10-02-00-00-00-fra-live';
  for (const id of [gone, kept]) {
    mkdirSync(join(runs, id), { recursive: true });
    writeFileSync(join(runs, id, 'events.jsonl'), '{}\n');
    mkdirSync(join(data, 'events', id), { recursive: true });
    writeFileSync(join(data, 'events', `${id}.json`), '{}');
    writeFileSync(join(data, 'events', id, 'game-1.json'), '{}');
  }
  const changes: Array<{ removed: string[]; touched: string[] }> = [];
  let served: ModerationList = { version: 'none', takedowns: [], hides: [], hiddenHandles: [], erased: [] };
  const file = join(runs, '.moderation.json');
  const sync = new ModerationSync({ fetchList: async () => served, runsDir: runs, dataDir: data, file, onChange: (ch) => changes.push(ch) });
  assert.equal(process.env.MTGDT_MODERATION_FILE, file, 'build-data (a child process) reads the same list');
  assert.equal(await sync.syncNow(), null, 'an unchanged version does nothing');
  served = { ...list, version: 'v2', takedowns: [gone] };
  const ch = await sync.syncNow();
  assert.deepEqual(ch?.removed, [gone]);
  assert.deepEqual(ch?.touched, [E]);
  assert.ok(!existsSync(join(runs, gone)), 'the taken-down run folder is deleted');
  assert.ok(!existsSync(join(data, 'events', `${gone}.json`)) && !existsSync(join(data, 'events', gone)), 'its exported files leave the served tree at once');
  assert.ok(existsSync(join(runs, kept)) && existsSync(join(data, 'events', `${kept}.json`)), 'other events stay');
  assert.ok(isTakenDown(gone) && !isTakenDown(kept));
  assert.equal(currentModeration().version, 'v2');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 'v2', 'kept on disk for build-data and restarts');
  assert.equal(changes.length, 1);
  // The Hub down: the last list stays in force.
  const down = new ModerationSync({ fetchList: async () => { throw new Error('unreachable'); }, runsDir: runs, file });
  assert.equal(await down.syncNow(), null);
  assert.equal(down.lastSync?.ok, false);
  assert.ok(isTakenDown(gone), 'a restart reads the list from disk');
  // A folder restored from a backup is removed again at start.
  mkdirSync(join(runs, gone), { recursive: true });
  new ModerationSync({ fetchList: async () => served, runsDir: runs, file });
  assert.ok(!existsSync(join(runs, gone)));
} finally {
  setModeration(null);
  rmSync(root, { recursive: true, force: true });
}

console.log('public-text: ok');
