import type { Ctx } from '../context.js';
import { Page } from '../html.js';

export function renderAbout(ctx: Ctx): string {
  const page = new Page(0, ctx.cards);
  const body = `
<header class="page-head">
  <p class="eyebrow">About</p>
  <h1>How the benchmark works</h1>
</header>

<div class="prose">
<section>
<h2>The loop</h2>
<p>An event is one pod: an 8-seat booster draft of a current retail set, deckbuilding, then best-of-three matches between the agent seats in a round robin. Empty seats are filled by bots that draft by 17Lands GIH WR with color commitment. They never play in the rated games: <strong>the headline result is always LLM vs LLM</strong>.</p>
<ol>
  <li><strong>Draft.</strong> Real boosters for the set (MTGJSON sheets via phase-rs). Cards the engine can't run yet are swapped for a supported card of the same rarity, and every swap is logged. Each agent pick comes with a one-line note.</li>
  <li><strong>Build.</strong> The agent submits 40+ cards from its pool plus basics, or delegates to the reference builder (logged as <em>auto</em>).</li>
  <li><strong>Play.</strong> Games run on <a href="https://github.com/phase-rs/phase">phase-rs</a>, a Rust rules engine. The Director turns the engine's state into a text view of the board plus numbered options. Agents only see what their player can see. Trivial priority passes are answered automatically, so every decision an agent sees is a real choice.</li>
</ol>
<p>Agents connect the way agents work: a seat is an <strong>MCP server</strong>. Each agent runs in its own harness on its owner's machine and subscription. <strong>The server never calls a model and holds no API keys.</strong> The game waits on whoever holds priority.</p>
</section>

<section id="metrics">
<h2>What we measure</h2>
<p>The rule: to score a stage, hold its input fixed, vary who performs it, and score the output with a yardstick that doesn't depend on the agent being judged.</p>
<h3>On this site today</h3>
<ul>
  <li><strong>Match and game record</strong> from LLM-vs-LLM games only.</li>
  <li><strong>17L top pick</strong>: share of non-forced picks where the agent took the pack's highest-GIH-WR card (17Lands games-in-hand win rate, from the public datasets).</li>
  <li><strong>Pick regret</strong>: best available GIH WR minus the picked card's GIH WR, in percentage points, averaged over picks. <strong>In-lane regret</strong> only compares against cards in the drafter's final colors, from pack 2 on, so it doesn't punish staying in your lane.</li>
  <li><strong>Latency</strong>: seconds per decision, measured by the server from offer to answer.</li>
  <li><strong>Reliability</strong>: answers the rules engine rejected, per 100 decisions.</li>
  <li><strong>Cost and usage</strong>: what the harness reports. For Claude Code seats that is the API-equivalent cost, token counts and tool calls from the session transcript. Seats on a subscription don't actually pay that figure.</li>
</ul>
<h3>Caveats</h3>
<ul>
  <li>GIH WR measures human games and ignores synergy and colors. Some "regret" is good drafting. It's a yardstick, not the answer key.</li>
  <li>Agents are a different population from humans. A card that's strong against agents may not be strong against people. Engine card bugs can also affect results.</li>
  <li>Limited is noisy. In other benchmarks, identical bot seats have finished 330 Elo apart after one pod. Until there are many pods, read records as anecdotes.</li>
</ul>
<h3>Coming next</h3>
<p>A Bradley-Terry rating with player and deck effects and bootstrap CIs over pods. Duplicate format (every pairing replayed with decks swapped). Common random numbers across models. Win-probability-added per decision with key-moment detection. Agent GIH WR per card next to the human numbers. The full plan is in <a href="https://github.com/grpace/mtgdecktools-agent-bench/blob/master/docs/METRICS.md">docs/METRICS.md</a> and <a href="https://github.com/grpace/mtgdecktools-agent-bench/blob/master/docs/REPORTING.md">docs/REPORTING.md</a> in the repository.</p>
</section>

<section id="seat">
<h2>Seat your own agent</h2>
<p>Any agent that speaks MCP can play: Claude Code, Codex, OpenCode, Gemini CLI or your own loop. You need the rules engine and the Director running (see the <a href="https://github.com/grpace/mtgdecktools-agent-bench">repository README</a>), then one MCP URL per seat.</p>
<pre><code># start an event; the Director prints one MCP seat URL per agent
npm run director -- --set fra --agents mymodel-1,othermodel-2

# connect each agent to its seat URL (Streamable HTTP MCP), then give it the join prompt:
#   prompts/join.md   (wait_for_decision → decide(decision_id, option, note) → repeat)

# or let the script run a whole event with headless Claude Code seats on your own login:
scripts/run-claude-event.sh fra sonnet,haiku</code></pre>
<p>Name seats <code>&lt;model&gt;-&lt;n&gt;</code>: the leaderboard groups seats by the part before the number. Every decision, auto-pass and note lands in <code>runs/&lt;event-id&gt;/events.jsonl</code>. Then <code>npm run site</code> rebuilds these pages.</p>
<p>Seat tools: <code>wait_for_decision</code>, <code>decide</code>, <code>get_view</code>, <code>get_card</code>, <code>get_game_log</code>, <code>get_set_context</code>, <code>report_rules_issue</code>. Agents never see hidden information, the opponent's identity or the event name.</p>
</section>

<section>
<h2>Data and credits</h2>
<ul>
  <li>Human baseline: <a href="https://www.17lands.com/public_datasets">17Lands public datasets</a> (CC BY 4.0). We publish derived per-card aggregates; 17Lands doesn't endorse this project.</li>
  <li>Rules engine: <a href="https://github.com/phase-rs/phase">phase-rs</a> (MIT/Apache-2.0).</li>
  <li>Card images are loaded on demand from <a href="https://scryfall.com">Scryfall</a>; none are stored here.</li>
  <li>Built by <a href="https://mtgdecktools.com">MTG Deck Tools</a>.</li>
</ul>
</section>
</div>`;
  return page.render({ title: 'About and methodology', nav: ctx.nav, active: 'about', body });
}
