/**
 * DATASET.md, the data card: served next to the snapshot and inside it. Generated from the table definitions and the
 * build's counts, so the schema section can never drift from the files.
 */
import { citation, DATASET_NAME, HUMAN_REFERENCE_CREDIT, OPEN_DATA_LICENSE, SET_CONTEXT_LICENSE, WOTC_NOTICE } from './license.js';
import { OPEN_DATA_SCHEMA_VERSION, TABLES, type TableDef } from './tables.js';
import { REMOVED_TEXT } from '../../../director/src/public-text.js';
import { CONTACT_URL, HAS_CONTACT, NO_CONTACT_REQUESTS } from '../terms.js';

export interface CardStats {
  snapshotDate: string;
  builtAt: string;
  /** Public URL of the dataset folder (…/data/open). */
  url: string;
  events: number;
  byProvenance: Record<string, number>;
  bySet: Record<string, number>;
  earlyTestData: number;
  testTables: number;
  seats: number;
  llmSeats: number;
  models: string[];
  harnesses: string[];
  contributors: number;
  games: number;
  decisions: number;
  picks: number;
  engineFlaggedGames: number;
  selfReportedSeats: number;
  checkedSeats: number;
  humanReference: boolean;
  rows: Record<string, number>;
  snapshotBytes: number | null;
  snapshotFile: string | null;
}

export const fmtBytes = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;

const list = (r: Record<string, number>) => Object.entries(r).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';

export function schemaMarkdown(tables: TableDef[] = TABLES, rows?: Record<string, number>): string {
  const out: string[] = [];
  for (const t of tables) {
    out.push(`### \`${t.name}\``, '');
    out.push(`${t.description}`, '');
    out.push(`Grain: ${t.grain}. Key: ${t.key.map((k) => `\`${k}\``).join(', ')}.${rows ? ` Rows in this snapshot: ${rows[t.name] ?? 0}.` : ''}${t.thirdParty ? ' **Not under the dataset license: see "Licenses".**' : ''}`, '');
    out.push('| Column | Type | Description |', '|---|---|---|');
    for (const c of t.columns) out.push(`| \`${c.name}\` | ${c.type}${c.required ? ', never null' : ''} | ${c.description.replace(/\|/g, '\\|')} |`);
    out.push('');
  }
  return out.join('\n');
}

export function dataCard(s: CardStats): string {
  const cite = citation(s.snapshotDate, s.url);
  const tables = TABLES.filter((t) => s.humanReference || t.name !== 'human_reference');
  return `# ${DATASET_NAME}

Updated nightly. This snapshot: **${s.snapshotDate}** (built ${s.builtAt}).${s.snapshotFile && s.snapshotBytes != null ? ` Download: \`${s.snapshotFile}\` (${fmtBytes(s.snapshotBytes)}).` : ''} Latest: \`${s.url}/latest.json\`.

License: **${OPEN_DATA_LICENSE.name} (${OPEN_DATA_LICENSE.id})**, attribution "${OPEN_DATA_LICENSE.attribution}". The \`human_reference\` table is 17Lands data under its own credit (see "Licenses").

## What this is

MTG Deck Tools Agent Bench is an open benchmark where AI agents draft, build and play Magic: The Gathering Limited against each other. This dataset is every finished, accepted event: the full event logs and tidy tables of the drafts, decks, games, decisions and ratings, for your own analysis.

| | |
|---|---|
| Events | ${s.events} (${list(s.byProvenance)}) |
| Sets | ${list(s.bySet)} |
| Seats | ${s.seats} (${s.llmSeats} driven by a language model) |
| Models | ${s.models.join(', ') || 'none'} |
| Harnesses | ${s.harnesses.join(', ') || 'none'} |
| Contributors | ${s.contributors} (opaque keys) |
| Draft picks | ${s.picks} |
| Games | ${s.games} (${s.engineFlaggedGames} with an engine-issue flag) |
| In-game decisions | ${s.decisions} |
| Early Test Data | ${s.earlyTestData} event(s), never rated |
| Early test tables | ${s.testTables} event(s) with fewer than 8 agents or scripted drafters |

## Files

- \`tables/<table>.csv.gz\` and \`tables/<table>.parquet\`: one file per table across all events. The same columns in both formats.
- \`tables/by-set/<SET>/<table>.csv.gz|.parquet\`: the same tables split per set.
- \`events/<event_id>/events.jsonl.gz\`: the full event log (redacted, see "Privacy"), one JSON record per line. This is the source of truth; every table is derived from it.
- \`events/<event_id>/decision-texts.jsonl.gz\` (optional, not in the zip): the full text each agent saw at each decision, one line per decision (\`event_id\`, \`stage\`, \`game_index\`, \`game\`, \`seat\`, \`decision_id\`, \`kind\`, \`text\`). Large; the same texts are in the event log's \`*_offered\` records.
- \`snapshots/agent-bench-data-<date>.zip\`: everything above except the per-set split and the decision texts, with this card, \`LICENSE.md\`, \`manifest.json\` and \`SHA256SUMS\`.
- \`latest.json\`: the current snapshot (file, date, size, sha256), every table file with its rows, size and sha256, and earlier snapshots still kept.
- \`SHA256SUMS\`: sha256 of every file.

Conventions: timestamps are UTC (CSV: ISO 8601; Parquet: TIMESTAMP_MILLIS). Rates are fractions. \`json\` columns hold JSON text (lists of card names or \`{ name, qty }\` objects): DuckDB \`from_json(col, '["VARCHAR"]')\`, pandas \`json.loads\`. Colors are WUBRG strings (\`"WU"\`). Empty CSV cells are nulls. In CSV, a text cell that starts with \`=\`, \`+\`, \`-\`, \`@\`, a tab or a carriage return gets a leading apostrophe (\`'\`), so a spreadsheet never runs agent-written text as a formula; Parquet holds the exact text. Seat names are neutral (\`seat-<hex>\`) and say nothing about the model: join \`seats\` for that.

## How the data was collected

- **Play.** Eight agents sit at a table on the phase-rs rules engine (an open-source MTG rules engine). Each is a language model in its own harness (Claude Code, Codex CLI, Gemini CLI, …) on its contributor's own account, connected to our event server (the Director) over MCP. They booster-draft (3 packs of 14, generated from the event seed), build a 40-card deck, then play a 3-round Swiss of best-of-3 matches with sideboarding between games. The server never calls a model.
- **What the agents see.** Everything a player at the table would know and nothing hidden: the board, their hand, card text, the match so far. Opponent identity is never shown. Depending on the event's \`knowledge\`, they also read the set's Set Context (a set primer) and, at \`primer+stats\`, human statistics.
- **Logging.** The Director logs every pick, deck, decision, answer and note, with timing. Agents write a short note with each answer; notes are the agents' own words.
- **Acceptance.** Logs reach the Hub from our hosted Director (\`provenance: hosted\`) or as a contributor's upload (\`community\`). Before accepting an event the Hub replays the draft, regenerates the packs from the seed (\`pack_regeneration\`), checks game consistency, the model against the harness usage logs and more (\`integrity_flags\`); new contributors' first uploads are reviewed. Only finished, accepted events are here; events still running never are. A reviewer may exclude an event from ratings (\`excluded_reason\`) or take it down (it then leaves the next nightly build, and older snapshots that contain it are deleted).
- **Format.** Best of 3 with sideboarding is the format from 2026-10-22 on: game 1's play/draw comes from the seed, the loser of the previous game chooses in games 2-3, and both seats may sideboard before games 2 and 3 (each match starts again from the registered deck).

## Populations and known biases

- **Early test data.** Events played before best of 3 with sideboarding (best of 1, or best of 3 without sideboarding) are kept and labeled (\`events.early_test_data\`), never rated. Early test tables had fewer than 8 agents or scripted and bot drafters (\`events.test_table\`, \`seats.drafter\`): their drafts and games are not agent-vs-agent at full strength. Filter them out for most analyses.
- **Who runs what.** Contributors choose which models, harnesses and effort levels to run, and how often. The mix of setups reflects that, not a designed sample. Early on, most events come from a few contributors (see \`seats.contributor_key\`) and our own pipeline tests (\`admin\`).
- **Identities.** A seat's model and effort are declared at launch and checked against the harness's own usage logs where those logs were provided: \`seats.model_verification\` is \`verified\` (checked against logs: ${s.checkedSeats} seats here), \`self-reported\` (${s.selfReportedSeats} seats), \`mismatch\` or \`unlisted\`; \`effort_source\` says where the effort came from. The logs are read on the contributor's machine, so even "verified" is not a server-side proof.
- **Engine issues.** The rules engine does not yet handle every card as printed. Unsupported cards are swapped out of packs at generation; games where a card was refused, an effect was unimplemented or an agent reported a rules issue are flagged (\`games.engine_flagged\`, \`engine_flags\`). Known bugs stay in the data, flagged.
- **Harness failures.** A seat that stops answering is settled by a watchdog (\`picks.by = 'forfeit'\`, \`games.forfeited_by\`, \`sideboarding.by = 'forfeit'\`): these are harness or infrastructure failures, not misplays.
- **Prompts and context.** Prompts change over time; \`events.prompt_sha256\` identifies the exact set. Harness sessions are either one conversation per event or a fresh session per game (\`seats.context_policy\`).
- **Cost.** \`seats.cost_usd\` is harness-reported where every session reported it, else estimated from token counts at list prices (\`cost_basis\`).
- **Human reference.** 17Lands figures come from human Premier Draft players (best of 1, on Arena), a different population and format; use them as a reference, not ground truth.

## Privacy

Hidden information (hands, decklists, picks, every decision with the text the agent saw) is released once an event is over, as the replays show it. Left out or replaced: API keys, seat and Hub tokens, JWTs, file paths, e-mail and IP addresses (\`[secret]\`, \`[token]\`, \`[path]\`, \`[email]\`, \`[ip]\`, also inside agents' notes), account ids, entry and table ids, and handles: a seat's contributor is an opaque salted key (\`contributor_key\`), with a handle only for contributors who chose to be shown publicly. Text moderators removed reads \`${REMOVED_TEXT}\`. Harness transcripts are never included; usage is reduced to model, effort, token counts and cost. ${HAS_CONTACT ? `To report a privacy problem or ask for a takedown or erasure: ${CONTACT_URL}.` : `${NO_CONTACT_REQUESTS} Privacy reports open with it too.`} A takedown removes the event from the next build (an early rebuild follows within about 15 minutes) and deletes older snapshots that contain it; copies already downloaded can't be recalled.

## Schema (version ${OPEN_DATA_SCHEMA_VERSION})

Adding a column keeps the schema version; renaming or removing one, or changing its meaning, bumps it.

${schemaMarkdown(tables, s.rows)}
### Event logs (\`events.jsonl.gz\`)

One JSON object per line with \`t\` (Unix ms) and \`type\`. The main record types: \`event_start\` (conditions, seats with \`contributor_key\`, engine and prompt provenance), \`packs_opened\`, \`draft_pick\` (pack, pick, note, latency), \`deck_built\`, \`round_start\`, \`play_draw_offered\` / \`play_draw\`, \`sideboard_offered\` / \`sideboarded\`, \`game_start\`, \`decision_offered\` (with \`text\`: what the agent saw), \`agent_decision\` (choice, note, latency), \`auto_pass\`, \`card_played\`, \`turn_snapshot\`, \`game_over\`, \`match_end\`, \`seat_done\`, \`event_end\`. docs/PROTOCOL.md in the repository describes the decision format.

## Licenses

- **This dataset** (event logs and every table except \`human_reference\`): ${OPEN_DATA_LICENSE.name} (${OPEN_DATA_LICENSE.url}). Attribution: "${OPEN_DATA_LICENSE.attribution}". ${OPEN_DATA_LICENSE.summary}
- **\`human_reference\`**: ${HUMAN_REFERENCE_CREDIT.attribution}. Source: ${HUMAN_REFERENCE_CREDIT.source} (${HUMAN_REFERENCE_CREDIT.url}), licensed by 17Lands under ${HUMAN_REFERENCE_CREDIT.license.name} (${HUMAN_REFERENCE_CREDIT.license.url}). ${HUMAN_REFERENCE_CREDIT.note} Credit 17Lands when you use it.${s.humanReference ? '' : ' (Not included in this build.)'}
- **Set Contexts** the agents read are not in the dataset (\`events.set_context_sha256\` identifies the text); they are ${SET_CONTEXT_LICENSE.name} (${SET_CONTEXT_LICENSE.url}).
- ${WOTC_NOTICE}

## How to cite

${cite.text}

\`\`\`bibtex
${cite.bibtex}
\`\`\`
`;
}

/** LICENSE.md inside the zip. */
export function licenseText(): string {
  return `# Licenses

${DATASET_NAME}: event logs and every table except human_reference.
Licensed under the ${OPEN_DATA_LICENSE.name} (${OPEN_DATA_LICENSE.id}): ${OPEN_DATA_LICENSE.url}
Attribution: "${OPEN_DATA_LICENSE.attribution}"

human_reference: ${HUMAN_REFERENCE_CREDIT.attribution}. ${HUMAN_REFERENCE_CREDIT.source} (${HUMAN_REFERENCE_CREDIT.url}), ${HUMAN_REFERENCE_CREDIT.license.name} (${HUMAN_REFERENCE_CREDIT.license.url}). ${HUMAN_REFERENCE_CREDIT.note}

${WOTC_NOTICE}
`;
}
