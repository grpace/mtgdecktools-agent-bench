/**
 * One console line is at most MAX_LOG_LINE characters (SEC-9). Request paths, engine errors and stack traces end up in
 * the container log; a megabyte line from a hostile request or a runaway error must not flood it or the platform's
 * log shipper. Applies to console.log, info, warn and error from the moment this module is imported.
 */
import { format } from 'node:util';

export const MAX_LOG_LINE = 8_192;

/** A log line cut to `max` characters, saying how much was left out. */
export function capLine(line: string, max = MAX_LOG_LINE): string {
  return line.length <= max ? line : `${line.slice(0, max)}… [${line.length - max} more characters cut]`;
}

let installed = false;

export function installLogCap(max = MAX_LOG_LINE): void {
  if (installed) return;
  installed = true;
  for (const name of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[name].bind(console);
    console[name] = (...args: unknown[]) => original(capLine(format(...args), max));
  }
}
