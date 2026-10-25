/**
 * Licenses and credits of the open dataset (docs/OPEN-DATA.md). One place: the data card, latest.json, the zip's
 * LICENSE.md, the Parquet metadata and the docs all read these constants.
 *
 * Owner decision (2026-10-22): our benchmark data is CC BY 4.0 with the attribution "MTG Deck Tools Agent Bench".
 */

export interface DataLicense {
  /** SPDX identifier. */
  id: string;
  name: string;
  url: string;
  /** The credit line a reuser gives. */
  attribution: string;
  summary: string;
}

/** Our benchmark data: event logs and every table except `human_reference`. */
export const OPEN_DATA_LICENSE: DataLicense = {
  id: 'CC-BY-4.0',
  name: 'Creative Commons Attribution 4.0 International',
  url: 'https://creativecommons.org/licenses/by/4.0/',
  attribution: 'MTG Deck Tools Agent Bench',
  summary: 'You may share and adapt the data for any purpose, including commercially, as long as you give appropriate credit ("MTG Deck Tools Agent Bench"), link to the license and indicate if changes were made.',
};

/** The Set Contexts (set primers) the agents read: public domain (NOTICE). Not in the dataset; referenced by hash. */
export const SET_CONTEXT_LICENSE: DataLicense = {
  id: 'CC0-1.0',
  name: 'Creative Commons Zero v1.0 Universal',
  url: 'https://creativecommons.org/publicdomain/zero/1.0/',
  attribution: 'MTG Deck Tools',
  summary: 'Dedicated to the public domain: no permission or attribution needed.',
};

/** The `human_reference` table: per-card aggregates derived from the 17Lands public datasets (NOTICE "17Lands data"). */
export const HUMAN_REFERENCE_CREDIT = {
  source: '17Lands public datasets',
  url: 'https://www.17lands.com/public_datasets',
  license: { id: 'CC-BY-4.0', name: 'Creative Commons Attribution 4.0 International', url: 'https://creativecommons.org/licenses/by/4.0/' },
  attribution: 'Data from 17Lands (17lands.com)',
  note: 'Derived aggregates (per-card win rates and pick positions computed by this project from the 17Lands public datasets), modified from the originals, not produced or endorsed by 17Lands.',
} as const;

/** Card names and rules text in the logs (NOTICE "Card data" and the Fan Content Policy). */
export const WOTC_NOTICE =
  'Card names and rules text are property of Wizards of the Coast and are not covered by this license. MTG Deck Tools Agent Bench is unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. (c) Wizards of the Coast LLC.';

export const DATASET_NAME = 'MTG Deck Tools Agent Bench Open Data';

/** How to cite a snapshot (the data card, latest.json and docs/OPEN-DATA.md). */
export function citation(snapshotDate: string, url: string): { text: string; bibtex: string } {
  const year = snapshotDate.slice(0, 4);
  return {
    text: `MTG Deck Tools Agent Bench (${year}). ${DATASET_NAME}, snapshot ${snapshotDate}. ${url}. Licensed under CC BY 4.0.`,
    bibtex: [
      `@misc{mtgdecktools_agent_bench_${snapshotDate.replace(/-/g, '_')},`,
      `  author = {{MTG Deck Tools Agent Bench}},`,
      `  title = {{${DATASET_NAME}}},`,
      `  year = {${year}},`,
      `  note = {Snapshot ${snapshotDate}. Licensed under CC BY 4.0},`,
      `  howpublished = {\\url{${url}}}`,
      `}`,
    ].join('\n'),
  };
}
