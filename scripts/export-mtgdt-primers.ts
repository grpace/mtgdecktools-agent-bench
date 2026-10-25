// Export MTG Deck Tools set contexts ("primers") into sets/<SET>/primer.md.
// Usage: npx tsx scripts/export-mtgdt-primers.ts [path-to-Magic-Deck-Builder] [--check]
//   --check   write nothing; print JSON {code: {status, file, sha256}} (status: same | changed | new | not_featured)
//   --filter  read Markdown on stdin, print it through the tier-score filter (scripts/deps.py uses it for --from-site)
// Usually run through `npm run deps -- update set-context` (docs/UPGRADING.md), which also records the source commit
// in deps/manifest.json. File-name → set-code differences live in deps/set-codes.json ("mtgdecktools".codes).
// The set contexts are the MTG Deck Tools author's own writing; they power the `primer` knowledge level.
// Every copy goes through the tier-score filter (packages/director/src/set-context-filter.ts): the site's files stay as
// the author wrote them, and sets/<SET>/primer.md carries the text agents read (no tierScore wording; agents get none).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FILTER_NOTE, filterSetContext } from '../packages/director/src/set-context-filter.js';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
if (args.includes('--filter')) {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  process.stdout.write(filterSetContext(Buffer.concat(chunks).toString('utf8')));
  process.exit(0);
}
const check = args.includes('--check');
const repoArg = args.find((a) => !a.startsWith('--'));
const mtgdt = resolve(repoArg ?? process.env.MTGDT_REPO ?? join(root, '..', 'Magic-Deck-Builder'));
const dir = join(mtgdt, 'src', 'setContexts');

const codes = JSON.parse(readFileSync(join(root, 'deps', 'set-codes.json'), 'utf8')) as { mtgdecktools?: { codes?: Record<string, string> } };
const CODE: Record<string, string> = codes.mtgdecktools?.codes ?? {};
const rotation = JSON.parse(readFileSync(join(root, 'sets', 'rotation.json'), 'utf8'));
const active = new Set<string>((rotation.featured ?? rotation.active).map((s: { code: string }) => s.code));
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const report: Record<string, { status: string; file: string; sha256?: string }> = {};
for (const file of readdirSync(dir).filter((f) => /^[A-Z0-9]+\.ts$/.test(f))) {
  const code = CODE[file.replace('.ts', '')] ?? file.replace('.ts', '');
  if (!active.has(code)) {
    report[code] = { status: 'not_featured', file };
    if (!check) console.log(`skip ${file} (${code} not featured in sets/rotation.json)`);
    continue;
  }
  const mod = await import(pathToFileURL(join(dir, file)).href);
  const markdown = Object.values(mod).find((v): v is string => typeof v === 'string' && v.length > 500);
  if (!markdown) {
    if (!check) console.log(`skip ${file}: no primer string export`);
    continue;
  }
  const filtered = filterSetContext(markdown.trim());
  const note = filtered !== markdown.trim() ? ` ${FILTER_NOTE}` : '';
  const header = `<!-- Exported from MTG Deck Tools (mtgdecktools.com) set context ${file}. Edit it there, then rerun scripts/export-mtgdt-primers.ts. Public domain (CC0 1.0).${note} -->\n\n`;
  const text = header + filtered + '\n';
  const out = join(root, 'sets', code, 'primer.md');
  const before = existsSync(out) ? readFileSync(out, 'utf8') : undefined;
  report[code] = { status: before === undefined ? 'new' : before === text ? 'same' : 'changed', file, sha256: sha256(text) };
  if (check) continue;
  mkdirSync(join(root, 'sets', code), { recursive: true });
  writeFileSync(out, text);
  console.log(`${code}: ${markdown.length} chars (${report[code]!.status})`);
}
if (check) console.log(JSON.stringify(report));
