/**
 * The terms contributors accept before hosted play and uploads (docs/legal/TERMS.md, PRIVACY.md, CONTENT-POLICY.md).
 *
 * TERMS_VERSION names the current version. Bump it (the date of the change) when the terms change in a way that
 * needs re-acceptance: every contributor is then asked again (`bench login`, or the button on /account) before their
 * next hosted table or upload. Editorial fixes don't need a bump.
 *
 * The Hub records each acceptance (contributors.terms_version / terms_accepted_at, and a row in `consents`).
 * Admin and service accounts (hosted Directors, imports) are never asked.
 */
import type { Sql } from './db.js';

export const TERMS_VERSION = '2026-10-24';

/**
 * The contact for takedowns, privacy requests, erasure and conduct reports: MTGDT_CONTACT_URL in the Hub's environment
 * (deploy/compose.yaml defaults it to the site's address, mailto:magic@greg.tech). Without one, this placeholder shows
 * wherever the contact belongs, so a missing value is obvious.
 */
export const CONTACT_URL_PLACEHOLDER = 'CONTACT_URL (not set yet)';
export const CONTACT_URL = (process.env.MTGDT_CONTACT_URL ?? '').trim() || CONTACT_URL_PLACEHOLDER;
/** Whether a contact address is configured. Until it is, takedown, erasure and report requests can't be made yet. */
export const HAS_CONTACT = CONTACT_URL !== CONTACT_URL_PLACEHOLDER;
/** What readers see instead of a request route while no contact address is configured (open data card, CLI). */
export const NO_CONTACT_REQUESTS = "Takedown and erasure requests can't be made yet: they open with the contact address.";

/**
 * docs/legal/*.md as readers get it (the Hub's /legal/*; the site's pages do the same in LegalPage.tsx):
 *   - "(OWNER: …)" notes go;
 *   - with a contact address, CONTACT_URL reads it and the `[[no-contact: …]]` alternates go;
 *   - without one, every sentence naming CONTACT_URL goes and its `[[no-contact: …]]` alternate is shown, so the text
 *     says plainly that the request can't be made yet rather than "ask us" with nowhere to ask.
 */
export function legalForReaders(md: string, o: { contact: string | null }): string {
  let body = md.replace(/\s*\(OWNER:[^)]*\)/g, '');
  // A mailto: contact reads as the bare address (the Hub serves these as plain text).
  if (o.contact) return body.replace(/\s*\[\[no-contact: [^\]]*\]\]/g, '').replace(/CONTACT_URL/g, o.contact.replace(/^mailto:/, ''));
  body = body
    .split('\n')
    .map((line) => {
      if (!line.includes('CONTACT_URL')) return line;
      // Keep the alternates whole while sentences are split.
      const alts: string[] = [];
      const masked = line.replace(/\[\[no-contact: ([^\]]*)\]\]/g, (_m, t: string) => `\u0000${alts.push(t) - 1}\u0000`);
      const marker = /^(\s*(?:[-*]|\d+\.)\s+)/.exec(masked)?.[1] ?? '';
      const kept = masked
        .slice(marker.length)
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => !sentence.includes('CONTACT_URL'))
        .join(' ')
        .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => alts[Number(i)]!)
        .trim();
      return kept ? `${marker}${kept}` : '';
    })
    .join('\n');
  return body.replace(/\[\[no-contact: ([^\]]*)\]\]/g, '$1');
}

/** Where the documents are read. The Hub serves them itself (/legal/*); MTGDT_*_URL points them at the site's pages. */
export function termsLinks(publicUrl: string): { terms: string; privacy: string; content_policy: string } {
  const env = process.env;
  return {
    terms: env.MTGDT_TERMS_URL?.trim() || `${publicUrl}/legal/terms`,
    privacy: env.MTGDT_PRIVACY_URL?.trim() || `${publicUrl}/legal/privacy`,
    content_policy: env.MTGDT_CONTENT_POLICY_URL?.trim() || `${publicUrl}/legal/content-policy`,
  };
}

/** The short summary shown before the explicit "yes" (bench login / setup, the /account page). Plain and complete. */
export const TERMS_SUMMARY: readonly string[] = [
  'You run your agents on your own subscriptions or API keys. You are responsible for all costs and for following your AI providers\' terms; we can\'t refund costs or help with account actions (rate limits, flags, suspensions or bans).',
  'Finished events are published, including your agents\' picks, decks, plays and notes, and released as open data under CC BY 4.0. You agree that your agents\' output in events is published under that license.',
  'We keep your GitHub id and handle, your seats\' logs and notes, and usage summaries (tokens and cost). Your handle is shown only if you choose to show it.',
  'No abuse, and nothing harmful in notes, deck names or handles. Moderators can hide text or remove events.',
  HAS_CONTACT
    ? 'You can ask us to take down an event or erase your account. Copies already downloaded can\'t be recalled.'
    : `${NO_CONTACT_REQUESTS} Copies already downloaded can't be recalled.`,
  'The software and data come as is, with no warranty. You run it at your own risk; harness isolation is best-effort.',
];

export interface TermsInfo {
  version: string;
  summary: readonly string[];
  links: { terms: string; privacy: string; content_policy: string };
  contact: string;
}

export function termsInfo(publicUrl: string): TermsInfo {
  return { version: TERMS_VERSION, summary: TERMS_SUMMARY, links: termsLinks(publicUrl), contact: CONTACT_URL };
}

export interface TermsStatus {
  current: string;
  accepted_version: string | null;
  accepted_at: string | null;
  /** True when the contributor accepted the current version (or isn't asked: admin and service accounts). */
  accepted: boolean;
}

/** Contributors who must accept: people. Hosted Directors and the admin account never are. */
export const asksTerms = (kind: string): boolean => kind === 'person';

export async function termsStatus(sql: Sql, contributorId: number): Promise<TermsStatus> {
  const [c] = await sql`select kind, terms_version, terms_accepted_at from contributors where id = ${contributorId}`;
  const accepted = (c?.terms_version as string | null) ?? null;
  return {
    current: TERMS_VERSION, accepted_version: accepted,
    accepted_at: c?.terms_accepted_at ? new Date(c.terms_accepted_at as Date).toISOString() : null,
    accepted: !c || !asksTerms(String(c.kind)) || accepted === TERMS_VERSION,
  };
}

/** Record an acceptance of the current version (idempotent for the version; every call adds a consent row). */
export async function acceptTerms(sql: Sql, contributorId: number, via: 'cli' | 'web' | 'admin'): Promise<TermsStatus> {
  await sql.begin(async (tx) => {
    await tx`update contributors set terms_version = ${TERMS_VERSION}, terms_accepted_at = now() where id = ${contributorId}`;
    await tx`insert into consents (contributor_id, terms_version, via) values (${contributorId}, ${TERMS_VERSION}, ${via})`;
  });
  return termsStatus(sql, contributorId);
}

/** The refusal hosted play and uploads give a contributor who hasn't accepted the current terms. */
export function termsRequiredMessage(publicUrl: string, status?: Pick<TermsStatus, 'accepted_version'>): string {
  const again = status?.accepted_version ? `The terms changed since you accepted them (${status.accepted_version}).` : 'You haven\'t accepted the terms yet.';
  return `${again} Accept the current terms (${TERMS_VERSION}) before hosted play or uploads: run \`bench login\` again, or use the Accept button on ${publicUrl}/account. Read them at ${termsLinks(publicUrl).terms}.`;
}
