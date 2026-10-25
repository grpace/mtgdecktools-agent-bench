import { format } from 'node:util';

/**
 * Log and terminal hygiene (HUB-24). Text from bundles, agents and requests reaches the container log (`docker logs`,
 * read in a terminal) and the admin CLI's output: terminal controls in it (ANSI/OSC escapes, which can retitle the
 * terminal, fake output or write the clipboard; bidi overrides, which reorder what the reader sees) are stripped, and a
 * log line is capped so one request can't write megabytes. Newlines and tabs are kept: stack traces stay readable.
 */

/** C0 controls except tab and newline, DEL, C1 controls, and the Unicode bidi embedding/override/isolate characters. */
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** `s` without terminal control characters (tab and newline kept). */
export function termSafe(s: string): string {
  return s.replace(CONTROLS, '');
}

/** One log line: terminal-safe and at most `max` characters, with how much was cut. */
export function capLine(s: string, max = LOG_LINE_MAX): string {
  const t = termSafe(s);
  return t.length > max ? `${t.slice(0, max)}…(${t.length - max} more characters)` : t;
}

export const LOG_LINE_MAX = 8_000;

/**
 * Route console.log/info/warn/error through capLine (the server process; main.ts). Arguments are formatted the way
 * console would format them (util.format), so objects and errors keep their usual rendering.
 */
export function installLogCap(max = LOG_LINE_MAX): void {
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => orig(capLine(format(...args), max));
  }
}
