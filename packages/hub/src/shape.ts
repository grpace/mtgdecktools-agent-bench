/**
 * Shape limits for an uploaded bundle, checked right after it is unpacked and before anything parses it (HUB-33).
 *
 * - **Nesting depth.** JSON.parse takes any depth, but the recursive walkers after it (the scrubber, the open-data
 *   redaction, JSON.stringify) overflow the stack from a few thousand levels, so one accepted record nested that deep
 *   would stop the export or the nightly open-data build until it was taken down. Real records are under 10 deep.
 * - **Records.** The unpacked size cap stops a gzip bomb but not millions of tiny records, each one parsed and kept
 *   several times on the event loop (a 0.3 MB upload held it for about 10 s and 2 GB). The largest real table log
 *   has about 35,000 records.
 */

export const SHAPE_LIMITS = {
  /** Deepest nesting of objects and arrays in any JSON or JSONL file of a bundle. */
  depth: 64,
  /** Records (non-empty lines) in events.jsonl. */
  records: 250_000,
} as const;

/**
 * The deepest nesting in `text`, counting `{` and `[` outside strings; stops as soon as it passes `limit`. For JSONL
 * (`lines`), the count restarts at every line break (a JSON string can't hold one), so a malformed line can't add up.
 */
export function jsonDepth(text: string, limit: number, lines = false): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i++; // backslash: skip the escaped character
      else if (c === 0x22) inString = false;
      else if (c === 0x0a && lines) inString = false;
      continue;
    }
    if (c === 0x22) inString = true;
    else if (c === 0x7b || c === 0x5b) {
      if (++depth > max && (max = depth) > limit) return max;
    } else if (c === 0x7d || c === 0x5d) depth = Math.max(0, depth - 1);
    else if (c === 0x0a && lines) depth = 0;
  }
  return max;
}

/** Errors for a bundle whose files are nested too deep or whose log holds too many records; empty when it is fine. */
export function shapeErrors(files: Map<string, Buffer>, limits: { depth: number; records: number } = SHAPE_LIMITS): string[] {
  const errors: string[] = [];
  for (const [name, data] of files) {
    if (!/\.jsonl?$/.test(name)) continue;
    const text = data.toString('utf8');
    if (jsonDepth(text, limits.depth, name.endsWith('.jsonl')) > limits.depth) errors.push(`${name} is nested deeper than ${limits.depth} levels`);
    if (name === 'events.jsonl') {
      let records = 0;
      for (let from = 0; from < text.length; ) {
        let end = text.indexOf('\n', from);
        if (end === -1) end = text.length;
        if (end > from && text.slice(from, end).trim() && ++records > limits.records) {
          errors.push(`events.jsonl holds more than ${limits.records} records`);
          break;
        }
        from = end + 1;
      }
    }
  }
  return errors;
}
