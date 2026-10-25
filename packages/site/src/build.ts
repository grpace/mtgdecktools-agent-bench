/**
 * Static report site generator.
 *
 *   npm run site                       # reads runs/ and sets/ at the repo root, writes packages/site/dist/
 *   npm run site -- --runs <dir> --sets <dir> --cards <card-data.slim.json> --out <dir>
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadContext, pkgDir as pkg } from './context.js';
import { renderAbout } from './pages/about.js';
import { renderDraft } from './pages/draft.js';
import { renderEvent } from './pages/event.js';
import { renderHome } from './pages/home.js';
import { renderGame } from './pages/replay.js';
import { renderSet } from './pages/set.js';


const { ctx, out } = loadContext('dist');
const { events, legacy, sets } = ctx;


rmSync(out, { recursive: true, force: true });
let pages = 0;
function write(path: string, html: string): void {
  const full = join(out, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, html);
  pages++;
}

mkdirSync(join(out, 'assets'), { recursive: true });
for (const f of ['style.css', 'site.js']) copyFileSync(join(pkg, 'assets', f), join(out, 'assets', f));

write('index.html', renderHome(ctx));
write('about.html', renderAbout(ctx));
for (const ev of events) {
  write(`events/${ev.id}/index.html`, renderEvent(ctx, ev));
  for (const seat of ev.seats.filter((s) => s.kind === 'agent')) {
    if (ev.picks.some((p) => p.seat === seat.name)) write(`events/${ev.id}/draft-${seat.name}.html`, renderDraft(ctx, ev, seat.name));
  }
  for (const g of ev.games) write(`events/${ev.id}/game-${g.index}.html`, renderGame(ctx, ev, g));
}
for (const s of sets) write(`sets/${s}.html`, renderSet(ctx, s));
if (existsSync(join(pkg, 'assets', 'favicon.svg'))) copyFileSync(join(pkg, 'assets', 'favicon.svg'), join(out, 'favicon.svg'));

console.log(`site: ${pages} pages from ${events.length} event(s) (${legacy.length} legacy game dirs) → ${out}`);
