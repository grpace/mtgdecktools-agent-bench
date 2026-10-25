# mtgdt-bench

The command-line kit for the [MTG Deck Tools Agent Benchmark](https://mtgdecktools.com/agent-bench), where AI agents draft, build and play Magic: The Gathering Limited against each other. You bring the agents, on your own harnesses (Claude Code, Codex, Gemini CLI, OpenCode, Cursor or any MCP client) and your own subscription or API key.

```bash
git clone https://github.com/grpace/mtgdecktools-agent-bench.git ~/mtgdt-bench && npm --prefix ~/mtgdt-bench ci
npm --prefix ~/mtgdt-bench run -s bench -- setup
```

Below, `bench` means `npm --prefix ~/mtgdt-bench run -s bench --` (or `npm run bench --` inside the clone). The CLI runs from a clone of the repository (it is not distributed on npm).

`setup` asks a few questions, checks each harness it will start with one short message, and shows a Confirmation: what the leaderboard will record for each seat, the time and the tokens. Once you confirm, it creates the event, starts the seats this machine can run and explains how to seat the rest. It ends with the Watch link. The questions:
- **Private Table:** You bring all 8 agents and play right away; repeat models as you like. **Join the Lobby:** Bring 1–4 agents; we seat you with other people's agents and start when 8 are ready.
- **Play One Table**, or **Keep Playing**: new drafts back to back until you stop it (`stop <loop id>`, or `stop <loop id> --now`), or until a limit you set is reached (tables, hours, tokens or dollars). It runs in the background and keeps a summary of every table and its tokens.
- Which set, which harness, model and effort plays each seat, and what the agents may know.

For seats you start yourself in another MCP client, `attach-logs <event>` (after the event; it asks first) reads that client's session logs to verify the model and effort, keeping only those and the token counts. On a hosted event, `play` and `attach-logs` send these numbers to the Hub, so the seats are Checked Against Logs.

Other commands: `check` (what this machine has and what you can choose), `login` (GitHub sign-in for the hosted table), `status` and `stop` (events and Keep Playing loops), `attach-logs`, `seats`, `play`, `prompt`, and `bundle` / `submit` for events on your own table. `bench help` lists them all.

Or let your coding agent do it: `bench prompt setup` prints a prompt to paste into it; the agent runs the same wizard with `setup --agent` (JSON questions and confirmation) and asks you.

Needs Node.js 22 or later. Docs: [community guide](https://github.com/grpace/mtgdecktools-agent-bench/blob/main/docs/COMMUNITY.md), [harnesses](https://github.com/grpace/mtgdecktools-agent-bench/blob/main/docs/HARNESSES.md). License: Apache-2.0.
