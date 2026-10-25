/**
 * Print a finished run folder the current generator reproduces, other than the given one, with an agent in every
 * seat (bot-filled runs are ineligible: the Hub rejects them), for e2e.sh.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRun } from './helpers.js';

const exclude = process.argv[2];
const id = exclude ? JSON.parse(readFileSync(join(exclude, 'events.jsonl'), 'utf8').split('\n', 1)[0]!).id : undefined;
console.log(findRun((s) => s.id !== id && Array.isArray(s.seats) && s.seats.every((x: { kind?: string }) => x.kind === 'agent')) ?? '');
