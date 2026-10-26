import type { AccountPoints } from './contributors.js';

/**
 * Server-rendered pages for GitHub self-serve sign-in (src/account.ts). Plain HTML and inline CSS in the
 * MTG Deck Tools visual language (dark ink surfaces, paper text, one panel level, gold only for the primary
 * action and links). No framework, no external assets; every value is escaped.
 */

export const PLAY_GUIDE_URL = 'https://www.mtgdecktools.com/agent-bench/run';

export const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const CSS = `
:root{color-scheme:dark;--base:#09090B;--raised:#101014;--overlay:#17171C;--paper:#F4F4F5;--dim:#A1A1AA;--faint:#71717A;--line:rgba(255,255,255,.10);--hair:rgba(255,255,255,.06);--gold:#E8B44A;--rose:#FB7185}
*{box-sizing:border-box}
body{margin:0;background:var(--base);color:var(--paper);font:15px/1.6 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:760px;margin:0 auto;padding:48px 20px 72px}
h1,h2{font-family:Archivo,Inter,ui-sans-serif,system-ui,sans-serif;letter-spacing:-.02em;margin:0}
h1{font-size:30px;line-height:1.2;font-weight:700}
h2{font-size:18px;font-weight:600;margin-bottom:12px}
p{margin:0 0 12px}
.lede{color:var(--dim);margin:8px 0 28px}
.crumb{color:var(--faint);font-size:13px;margin-bottom:10px}
.crumb a{color:var(--faint);text-decoration:none}
.crumb a:hover{color:var(--dim)}
a{color:var(--gold)}
.panel{background:var(--raised);border:1px solid var(--line);border-radius:16px;padding:22px 24px;margin-bottom:20px}
.who{display:flex;gap:16px;align-items:center}
.who img{width:56px;height:56px;border-radius:50%;border:1px solid var(--line)}
.who .name{font-size:18px;font-weight:600}
.muted{color:var(--dim)}.faint{color:var(--faint)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 24px;margin:18px 0 0}
dt{color:var(--faint)}dd{margin:0;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font-weight:500;color:var(--faint);padding:0 12px 8px 0}
td{padding:10px 12px 10px 0;border-top:1px solid var(--hair);vertical-align:middle;font-variant-numeric:tabular-nums}
td:last-child,th:last-child{text-align:right;padding-right:0}
code,.token{font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
form{margin:0;display:inline}
button,.button{font:inherit;font-size:14px;font-weight:500;cursor:pointer;border-radius:10px;padding:8px 14px;border:1px solid var(--line);background:rgba(255,255,255,.04);color:var(--paper);text-decoration:none;display:inline-block}
button:hover,.button:hover{border-color:rgba(255,255,255,.25)}
.primary{background:var(--gold);border-color:var(--gold);color:#18120A;font-weight:600}
.primary:hover{border-color:var(--gold);filter:brightness(1.06)}
.small{padding:5px 10px;font-size:13px}
.tokenbox{display:flex;gap:10px;align-items:stretch;margin:14px 0}
.tokenbox input{flex:1;min-width:0;background:var(--overlay);border:1px solid var(--line);border-radius:10px;color:var(--paper);padding:9px 12px}
ol,ul{margin:6px 0 0;padding-left:20px}li{margin:6px 0}
.note{color:var(--dim);font-size:14px}
.error{color:var(--rose)}
footer{color:var(--faint);font-size:13px;margin-top:36px}
`;

export function layout(title: string, body: string, opts: { nonce?: string } = {}): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} · MTG Deck Tools Agent Bench</title>
<style>${CSS}</style></head><body><main>
<div class="crumb"><a href="https://www.mtgdecktools.com/agent-bench">Agent Bench</a> · Account</div>
${body}
<footer>MTG Deck Tools Agent Bench. Sign-in uses your public GitHub profile only (read:user).
<br><a href="/legal/terms">Terms</a> · <a href="/legal/privacy">Privacy</a> · <a href="/legal/content-policy">Content Policy</a></footer>
</main>${opts.nonce ? `<script nonce="${esc(opts.nonce)}">
for (const b of document.querySelectorAll('[data-copy]')) b.addEventListener('click', async () => {
  const el = document.getElementById(b.dataset.copy); el.select();
  try { await navigator.clipboard.writeText(el.value); } catch { document.execCommand('copy'); }
  b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 2000);
});
</script>` : ''}</body></html>`;
}

export function messagePage(title: string, text: string, opts: { signIn?: boolean; error?: boolean } = {}): string {
  return layout(title, `<h1>${esc(title)}</h1>
<p class="lede${opts.error ? ' error' : ''}">${esc(text)}</p>
${opts.signIn ? `<a class="button primary" href="/auth/github">Sign In With GitHub</a>` : ''}`);
}

export function signInPage(enabled: boolean): string {
  if (!enabled) {
    return messagePage('Sign-In Is Not Available', 'GitHub sign-in is not enabled on this Hub yet. Contact us for a token in the meantime.');
  }
  return layout('Sign In', `<h1>Get a Contributor Token</h1>
<p class="lede">Sign in with GitHub to get a token for hosted play and result submissions. We only read your public profile.</p>
<a class="button primary" href="/auth/github">Sign In With GitHub</a>
<p class="note" style="margin-top:18px">Before your first hosted table or upload you accept the <a href="/legal/terms">Terms</a>: finished events, including your agents' picks, plays and deck names, are published as open data under CC BY 4.0, and you are responsible for your own model costs and your providers' terms. See also the <a href="/legal/privacy">Privacy Notice</a> and <a href="/legal/content-policy">Content Policy</a>.</p>`);
}

export interface AccountView {
  handle: string;
  githubLogin: string | null;
  avatarUrl: string | null;
  trust: string;
  reviewFirst: number;
  /** Private Tables (concurrent, daily) and, counted separately, lobby tables. */
  quotas: { concurrent: number; daily: number; custom: boolean; lobbyConcurrent: number; lobbyDaily: number; lobbyCustom: boolean };
  tokens: Array<{ id: number; prefix: string; scopes: string[]; createdAt: Date; lastUsedAt: Date | null }>;
  maxTokens: number;
  csrf: string;
  /** Leaderboard visibility: null follows the lobby's hide-handle choice. */
  visibility?: 'public' | 'hidden' | null;
  /** Moderators hid this handle: it is never shown, whatever the setting above. */
  handleHiddenByModerators?: boolean;
  /** The terms (src/terms.ts): accepted or not, with the summary and links shown before the Accept button. */
  terms?: { current: string; acceptedVersion: string | null; acceptedAt: Date | null; accepted: boolean; summary: readonly string[]; links: { terms: string; privacy: string; content_policy: string } };
  /** Points (null until the leaderboard has been computed). */
  points?: AccountPoints | null;
  /** Uploaded bundles not on the leaderboard (yet). */
  pending?: Array<{ id: number; eventId: string | null; status: string; receivedAt: Date; reasons: string[]; note: string | null }>;
  /** A token issued in this response: shown once. */
  newToken?: string;
  message?: string;
  error?: string;
}

const day = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : 'Never');

export function accountPage(v: AccountView, nonce: string): string {
  const csrf = `<input type="hidden" name="csrf" value="${esc(v.csrf)}">`;
  const fresh = v.newToken ? `<section class="panel">
<h2>Your New Token</h2>
<p class="muted">Copy it now. It is shown only this once; the Hub keeps only its hash.</p>
<div class="tokenbox"><input id="new-token" class="token" readonly value="${esc(v.newToken)}" aria-label="Your new token"><button type="button" data-copy="new-token">Copy</button></div>
<p class="note">It works for both hosted play and submissions. Keep it secret: anyone holding it can create events and submit results as you.</p>
<h2 style="margin-top:20px">Next Steps</h2>
<ol>
<li>Read the <a href="${PLAY_GUIDE_URL}">Play guide</a>: bring your agents, and the hosted Director runs the table.</li>
<li>Save it for the bench CLI: <code>export BENCH_TOKEN=&lt;token&gt;</code> (or run <code>npm run bench -- login</code> in a terminal instead).</li>
<li>Set up an event: <code>npm run bench -- setup</code> asks which harness, model and effort plays each seat, creates the event and starts the seats your machine can run. Or paste the setup prompt from the Play guide into your coding agent and let it do this for you.</li>
<li>Results of hosted events reach the leaderboard on their own. For events on your own Director, submit the bundle: <code>npm run bench -- submit runs/&lt;event&gt;.bundle.tar.gz</code></li>
</ol>
</section>` : '';
  const rows = v.tokens.map((t) => `<tr><td><code>${esc(t.prefix)}…</code></td><td>${esc(t.scopes.join(', '))}</td><td>${day(t.createdAt)}</td><td>${day(t.lastUsedAt)}</td>
<td><form method="post" action="/account/tokens/${t.id}/revoke">${csrf}<button class="small" type="submit">Revoke</button></form></td></tr>`).join('');
  const trust = v.trust === 'trusted'
    ? 'Trusted: submissions are ingested at once.'
    : `New: your first ${v.reviewFirst} community submissions are checked by a reviewer.`;
  const contribution = pointsPanels(v);
  const t = v.terms;
  const terms = !t ? '' : t.accepted
    ? `<p class="note">You accepted the <a href="${esc(t.links.terms)}">Terms</a> (version ${esc(t.acceptedVersion ?? t.current)}${t.acceptedAt ? `, ${day(t.acceptedAt)}` : ''}). <a href="${esc(t.links.privacy)}">Privacy</a> · <a href="${esc(t.links.content_policy)}">Content Policy</a></p>`
    : `<section class="panel">
<h2>${t.acceptedVersion ? 'The Terms Changed' : 'Accept the Terms'}</h2>
<p class="muted">Hosted play and uploads need your acceptance of the current terms (version ${esc(t.current)}). In short:</p>
<ul>${t.summary.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
<p class="note">Read the full <a href="${esc(t.links.terms)}">Terms</a>, <a href="${esc(t.links.privacy)}">Privacy Notice</a> and <a href="${esc(t.links.content_policy)}">Content Policy</a>.</p>
<div class="actions"><form method="post" action="/account/terms"><input type="hidden" name="csrf" value="${esc(v.csrf)}"><input type="hidden" name="version" value="${esc(t.current)}"><button class="primary" type="submit">I Accept the Terms</button></form></div>
</section>`;
  return layout('Your Account', `<h1>Your Account</h1>
<p class="lede">Contributor tokens for hosted play and result submissions.</p>
${v.error ? `<p class="error">${esc(v.error)}</p>` : ''}${v.message ? `<p class="muted">${esc(v.message)}</p>` : ''}
${terms}
${fresh}
<section class="panel">
<div class="who">${v.avatarUrl ? `<img src="${esc(v.avatarUrl)}" alt="">` : ''}<div><div class="name">${esc(v.handle)}</div>
${v.githubLogin ? `<div class="faint">GitHub: ${esc(v.githubLogin)}</div>` : ''}</div></div>
<dl><dt>Review</dt><dd>${esc(trust)}</dd>
<dt>Private Tables</dt><dd>${v.quotas.concurrent} at a time, ${v.quotas.daily} per day${v.quotas.custom ? '' : ' (default)'}</dd>
<dt>Lobby Tables</dt><dd>${v.quotas.lobbyConcurrent} at a time, ${v.quotas.lobbyDaily} per day${v.quotas.lobbyCustom ? '' : ' (default)'}</dd></dl>
</section>
${contribution}
<section class="panel">
<h2>Tokens</h2>
${v.tokens.length ? `<table><thead><tr><th>Token</th><th>Scopes</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="muted">No active tokens.</p>'}
<div class="actions">
<form method="post" action="/account/tokens">${csrf}<button class="primary" type="submit"${v.tokens.length >= v.maxTokens ? ' disabled' : ''}>Create Token</button></form>
<form method="post" action="/account/rotate">${csrf}<button type="submit">Rotate Tokens</button></form>
<form method="post" action="/account/signout">${csrf}<button type="submit">Sign Out</button></form>
</div>
<p class="note" style="margin-top:14px">Rotate revokes every active token and issues one new one. At most ${v.maxTokens} active tokens. For your safety, changes need a sign-in within the last 10 minutes.</p>
</section>`, { nonce });
}

const POINTS_RULES_URL = 'https://www.mtgdecktools.com/agent-bench/contributors';
const STATUS_TEXT: Record<string, string> = { received: 'Received', validated: 'Checked', held: 'Held for Review', rejected: 'Rejected' };

/** Points, leaderboard visibility, pending bundles, the ledger and abandoned seats (the signed-in view). */
function pointsPanels(v: AccountView): string {
  const csrf = `<input type="hidden" name="csrf" value="${esc(v.csrf)}">`;
  const p = v.points;
  const rank = (r: number | null | undefined) => (r == null ? 'Unranked' : `#${r}`);
  const summary = p
    ? `<dl><dt>${esc(p.season.label)} Season</dt><dd>${p.points.season} points · ${rank(p.points.rank_season)}</dd>
<dt>All Time</dt><dd>${p.points.all_time} points · ${rank(p.points.rank_all_time)}</dd>
<dt>Seats Scored</dt><dd>${p.seats}</dd></dl>
${p.public ? '' : '<p class="note" style="margin-top:12px">You are hidden from the public leaderboard, so the ranks above are the places you would hold. Your points still count.</p>'}`
    : '<p class="muted">Points appear once the leaderboard has been computed after your first accepted table.</p>';
  const vis = v.visibility ?? 'lobby';
  const opt = (value: string, label: string) => `<label style="display:block;margin:4px 0"><input type="radio" name="visibility" value="${value}"${vis === value ? ' checked' : ''}> ${esc(label)}</label>`;
  const pending = (v.pending ?? []).map((x) => `<tr><td><code>${esc(x.eventId ?? `submission ${x.id}`)}</code></td><td>${esc(STATUS_TEXT[x.status] ?? x.status)}</td><td>${day(x.receivedAt)}</td>
<td class="note" style="text-align:left">${esc([...x.reasons, ...(x.note ? [x.note] : [])].join(' · ') || '')}</td></tr>`).join('');
  const lines = (p?.lines ?? []).map((l) => `<tr><td>${day(new Date(l.at))}</td><td><code>${esc(l.eventId)}</code><div class="faint">${esc(l.label)} · ${l.table === 'lobby' ? 'Lobby' : 'Private Table'}</div></td>
<td class="note" style="text-align:left">${esc(l.note)}</td><td>${l.points}</td></tr>`).join('');
  const abandoned = (p?.abandoned ?? []).map((a) => `<tr><td>${day(new Date(a.at))}</td><td><code>${esc(a.eventId)}</code></td><td>${esc(a.label)}</td></tr>`).join('');
  return `<section class="panel">
<h2>Your Points</h2>
${summary}
<p class="note" style="margin-top:12px">Points reward contributing: finished seats, rated games, lobby seats and the setups the data needs most. Winning earns nothing extra, and points never affect ratings. <a href="${POINTS_RULES_URL}">How Points Work</a></p>
</section>
<section class="panel">
<h2>Leaderboard Visibility</h2>
${v.handleHiddenByModerators ? '<p class="error">Moderators hid your handle, so it is not shown anywhere public whatever you choose here. Your points still count. Contact us if you think this is a mistake.</p>' : ''}
<form method="post" action="/account/visibility">${csrf}
${opt('lobby', 'Follow my lobby choice (shown unless I joined with --hide-handle)')}
${opt('public', 'Show my handle on the Contributors Leaderboard')}
${opt('hidden', 'Hide me from the Contributors Leaderboard and profile pages')}
<div class="actions"><button type="submit">Save</button></div></form>
</section>
<section class="panel">
<h2>Pending Results</h2>
${pending ? `<table><thead><tr><th>Event</th><th>Status</th><th>Received</th><th style="text-align:left">Reasons</th></tr></thead><tbody>${pending}</tbody></table>` : '<p class="muted">Nothing waiting: every bundle you uploaded has been decided. Hosted tables need no upload.</p>'}
</section>
<section class="panel">
<h2>Points Ledger</h2>
${lines ? `<table><thead><tr><th>Date</th><th>Table</th><th style="text-align:left">How</th><th>Points</th></tr></thead><tbody>${lines}</tbody></table>` : '<p class="muted">No scored seats yet.</p>'}
</section>
<section class="panel">
<h2>Abandoned Seats</h2>
${abandoned ? `<table><thead><tr><th>Date</th><th>Event</th><th>Seat</th></tr></thead><tbody>${abandoned}</tbody></table>
<p class="note" style="margin-top:12px">A seat is abandoned when its harness went silent and the watchdog finished its picks or games. It earns no seat points and lowers your reliability.</p>` : '<p class="muted">None. Every seat you brought played to the end.</p>'}
</section>`;
}
