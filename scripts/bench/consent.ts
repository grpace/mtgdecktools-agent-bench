/**
 * The terms, before hosted play (docs/legal/TERMS.md; the Hub's packages/hub/src/terms.ts).
 *
 * The first `bench login` against a Hub shows the Hub's short summary and the links, and needs an explicit "yes" (in a
 * terminal) or `--accept-terms` (a coding agent, after it showed the person the summary and they agreed). The Hub
 * records the acceptance once the sign-in has a token. When the terms change, the Hub refuses hosted play and uploads
 * until they are accepted again: `bench login` (already signed in) or `bench terms --accept` asks again.
 *
 *   ensureTerms()       accepted, or ask and record (login when signed in, `terms`, setup)
 *   consentBeforeLogin  ask before the device flow starts; remembered until the token exists
 *   finishLogin         record the remembered consent with the new token
 *
 * Hubs from before terms existed (no /api/terms) are left alone.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { BENCH, CONFIG_DIR, die } from './core.js';

export interface TermsInfo {
  version: string;
  summary: string[];
  links: { terms: string; privacy: string; content_policy: string };
  contact?: string;
}

export interface TermsStatus {
  current: string;
  accepted_version: string | null;
  accepted_at: string | null;
  accepted: boolean;
}

const consentFile = () => join(CONFIG_DIR, 'terms-consent.json');

async function hubJson(url: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) }).catch((e) => die(`cannot reach the Hub (${(e as Error).message})`));
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** The Hub's current terms (version, summary, links); null for a Hub without terms. */
export async function fetchTerms(hub: string): Promise<TermsInfo | null> {
  const r = await hubJson(`${hub}/api/terms`);
  if (r.status === 404) return null;
  if (r.status !== 200 || typeof r.body?.version !== 'string' || !Array.isArray(r.body.summary)) die(`the Hub answered ${r.status} for its terms; try again shortly`);
  return r.body as TermsInfo;
}

/** Whether this token's contributor accepted the current terms; null for a Hub without terms. */
export async function termsStatus(hub: string, token: string): Promise<(TermsStatus & Partial<TermsInfo>) | null> {
  const r = await hubJson(`${hub}/api/account/terms`, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404) return null;
  if (r.status === 401) die(`the Hub doesn't recognize your token (revoked?): run \`${BENCH} login --force\``);
  if (r.status !== 200) die(`the Hub answered ${r.status} for your terms status; try again shortly`);
  return r.body;
}

/** Record the acceptance of `version` (must be the Hub's current one). */
export async function recordAcceptance(hub: string, token: string, version: string): Promise<TermsStatus> {
  const r = await hubJson(`${hub}/api/account/terms`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ version }),
  });
  if (r.status === 409) die(`the terms changed while you were reading them (now version ${r.body?.version}): run \`${BENCH} terms\` and accept again`);
  if (r.status !== 200 || r.body?.accepted !== true) die(`the Hub answered ${r.status} when recording your acceptance: ${r.body?.error ?? 'unknown error'}`);
  return r.body as TermsStatus;
}

/** The summary as people read it: the points, the links, and what accepting means. */
export function termsText(info: TermsInfo, changed = false): string {
  return [
    changed ? `The terms of MTG Deck Tools Agent Bench changed (version ${info.version}). Please read and accept them again:` : `Before you play: the terms of MTG Deck Tools Agent Bench (version ${info.version}), in short:`,
    '',
    ...info.summary.map((s) => `  • ${s}`),
    '',
    `  Terms:          ${info.links.terms}`,
    `  Privacy:        ${info.links.privacy}`,
    `  Content Policy: ${info.links.content_policy}`,
  ].join('\n');
}

/**
 * Ask for consent: true with `accept` (the person already agreed), or after the person types "yes" in a terminal.
 * Without a terminal and without `accept`, explains how to accept and returns false.
 */
export async function askConsent(info: TermsInfo, opts: { accept?: boolean; changed?: boolean; acceptCommand: string }): Promise<boolean> {
  console.log(`\n${termsText(info, opts.changed)}\n`);
  if (opts.accept) {
    console.log('Accepted with --accept-terms.');
    return true;
  }
  if (!process.stdin.isTTY) {
    console.log(`To accept, the person who runs these agents reads the above and agrees; then run \`${opts.acceptCommand}\`.`);
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('Do you accept these terms? Type "yes" to accept: ')).trim().toLowerCase();
    return answer === 'yes';
  } finally {
    rl.close();
  }
}

/** Before the device flow: ask, and remember the consent until the sign-in has a token. Dies when declined. */
export async function consentBeforeLogin(hub: string, opts: { accept?: boolean }): Promise<void> {
  const info = await fetchTerms(hub);
  if (!info) return;
  if (!(await askConsent(info, { accept: opts.accept, acceptCommand: `${BENCH} login --start --accept-terms` }))) {
    die(`not signed in: the hosted table needs the terms accepted. Run \`${BENCH} login\` again when you are ready.`);
  }
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(consentFile(), JSON.stringify({ hub, version: info.version, at: new Date().toISOString() }), { mode: 0o600 });
  chmodSync(consentFile(), 0o600);
}

/** After the device flow: record the consent given before it. */
export async function finishLogin(hub: string, token: string): Promise<void> {
  let c: { hub?: string; version?: string } = {};
  try {
    c = JSON.parse(readFileSync(consentFile(), 'utf8'));
  } catch {
    // none given before this sign-in (an old pending login): ask now
  }
  rmSync(consentFile(), { force: true });
  if (c.hub === hub && c.version) {
    const st = await recordAcceptance(hub, token, c.version);
    console.log(`Terms accepted (version ${st.accepted_version}).`);
    return;
  }
  await ensureTerms(hub, token, {});
}

/**
 * The token's contributor has accepted the current terms, or is asked now (and the acceptance recorded). Returns
 * false when they didn't accept (no terminal and no --accept-terms, or not "yes").
 */
export async function ensureTerms(hub: string, token: string, opts: { accept?: boolean }): Promise<boolean> {
  const st = await termsStatus(hub, token);
  if (!st || st.accepted) return true;
  const info = st.version && st.summary && st.links ? (st as unknown as TermsInfo) : await fetchTerms(hub);
  if (!info) return true;
  if (!(await askConsent(info, { accept: opts.accept, changed: !!st.accepted_version, acceptCommand: `${BENCH} terms --accept` }))) return false;
  const done = await recordAcceptance(hub, token, info.version);
  console.log(`Terms accepted (version ${done.accepted_version}).`);
  return true;
}

/** For setup's agent mode: the terms step (null when nothing is needed). */
export async function termsStep(hub: string, token: string): Promise<{ text: string; version: string; links: TermsInfo['links'] } | null> {
  const st = await termsStatus(hub, token);
  if (!st || st.accepted) return null;
  const info = st.version && st.summary && st.links ? (st as unknown as TermsInfo) : await fetchTerms(hub);
  return info ? { text: termsText(info, !!st.accepted_version), version: info.version, links: info.links } : null;
}

export const hasPendingConsent = (): boolean => existsSync(consentFile());
