// Spike: two seats on one phase-server game, each picking random legal actions.
// Usage: node scripts/spike-random-game.mjs [ws-url] [deckA] [deckB]
import WebSocket from 'ws';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'ws://127.0.0.1:9374/ws';
const deckA = process.argv[3] ?? 'decks/fra-wu.txt';
const deckB = process.argv[4] ?? 'decks/fra-br.txt';
const PROTOCOL = 159;

function loadDeck(path) {
  const main = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (m) for (let i = 0; i < Number(m[1]); i++) main.push(m[2]);
  }
  return { main_deck: main, sideboard: [] };
}

const LIMITED = {
  format: 'Limited', starting_life: 20, min_players: 2, max_players: 2,
  deck_size: { type: 'Minimum', data: 40 }, singleton: false, command_zone: false,
  commander_damage_threshold: null, range_of_influence: null, team_based: false,
  uses_commander: false, supplies_fixed_deck: false, sideboard_policy: { type: 'Unlimited' },
  default_deck_copy_limit: { type: 'Unlimited' }, allow_debug_actions: false,
};

mkdirSync('tmp', { recursive: true });
const stats = { messages: {}, decisions: [0, 0], actionTypes: {}, rejections: 0 };
let gameCode;
let sample = 0;
const eventSamples = {};
const logSamples = [];
const wfSamples = {};
const misc = {};

function seat(idx, onReady) {
  const ws = new WebSocket(url);
  const send = (type, data) => ws.send(JSON.stringify(data === undefined ? { type } : { type, data }));
  let lastRevision = -1;
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    stats.messages[msg.type] = (stats.messages[msg.type] ?? 0) + 1;
    const d = msg.data ?? {};
    switch (msg.type) {
      case 'ServerHello':
        send('ClientHello', { client_version: 'mtgdt-spike/0.1', build_commit: '', protocol_version: PROTOCOL });
        onReady(send);
        break;
      case 'GameCreated':
        gameCode = d.game_code;
        console.log(`seat ${idx}: created ${gameCode}`);
        seats[1]();
        break;
      case 'GameStarted':
      case 'StateUpdate': {
        for (const ev of d.events ?? []) if (idx === 0 && !eventSamples[ev.type]) eventSamples[ev.type] = ev;
        if (idx === 0 && d.log_entries?.length && logSamples.length < 40) logSamples.push(...d.log_entries);
        if (d.legal_actions?.length && d.state?.waiting_for && !wfSamples[d.state.waiting_for.type + (d.state.waiting_for.data?.pending?.[0]?.phase?.type ?? '')]) {
          wfSamples[d.state.waiting_for.type + (d.state.waiting_for.data?.pending?.[0]?.phase?.type ?? '')] = { waiting_for: d.state.waiting_for, legal: d.legal_actions };
        }
        if (d.state?.stack?.length && !misc.stack) misc.stack = { stack: d.state.stack, objs: d.state.stack.map((e) => d.state.objects[e.source_id] ? { name: d.state.objects[e.source_id].name, zone: d.state.objects[e.source_id].zone } : null) };
        if (d.state?.combat?.attackers?.length && Object.keys(d.state.combat.blocker_to_attacker ?? {}).length && !misc.combat) misc.combat = d.state.combat;
        for (const o of Object.values(d.state?.objects ?? {})) {
          if (o.keywords?.length && !misc.kw) misc.kw = { name: o.name, keywords: o.keywords, abilities: o.abilities?.map((a) => a.description), counters: o.counters };
          if (Object.keys(o.counters ?? {}).length && !misc.counters) misc.counters = o.counters;
        }
        if (sample < 3 && d.legal_actions?.length) {
          writeFileSync(`tmp/state-sample-${sample++}.json`, JSON.stringify(d, null, 1));
        }
        const wf = d.state?.waiting_for;
        if (wf?.type === 'GameOver') {
          console.log(`seat ${idx}: GameOver winner=${wf.data?.winner} turn=${d.state.turn_number}`);
          finish();
          return;
        }
        if (!d.legal_actions?.length || d.state_revision === lastRevision) return;
        lastRevision = d.state_revision;
        const acts = d.legal_actions;
        const nonPass = acts.filter((a) => a.type !== 'PassPriority' && a.type !== 'CancelCast');
        const pick = nonPass.length && Math.random() < 0.85
          ? nonPass[Math.floor(Math.random() * nonPass.length)]
          : acts.find((a) => a.type === 'PassPriority') ?? acts[0];
        stats.decisions[idx]++;
        stats.actionTypes[`${wf?.type}:${pick.type}`] = (stats.actionTypes[`${wf?.type}:${pick.type}`] ?? 0) + 1;
        setTimeout(() => send('Action', { action: pick }), 40);
        break;
      }
      case 'ActionRejected':
        stats.rejections++;
        if (stats.rejections < 5) console.log(`seat ${idx}: rejected`, JSON.stringify(d).slice(0, 300));
        break;
      case 'Error':
        console.log(`seat ${idx}: ERROR`, JSON.stringify(d));
        break;
    }
  });
  ws.on('close', (c) => console.log(`seat ${idx}: closed ${c}`));
  return ws;
}

let done = false;
function finish() {
  if (done) return;
  done = true;
  setTimeout(() => {
    console.log(JSON.stringify(stats, null, 1));
    writeFileSync('tmp/event-samples.json', JSON.stringify(eventSamples, null, 1));
    writeFileSync('tmp/log-samples.json', JSON.stringify(logSamples, null, 1));
    writeFileSync('tmp/wf-samples.json', JSON.stringify(wfSamples, null, 1));
    writeFileSync('tmp/misc-samples.json', JSON.stringify(misc, null, 1));
    process.exit(0);
  }, 500);
}

const seats = [
  () => seat(0, (send) => send('CreateGameWithSettings', {
    deck: loadDeck(deckA), display_name: 'SeatA', public: false, password: null, timer_seconds: null,
    player_count: 2, match_config: { match_type: 'Bo1' }, ai_seats: [], format_config: LIMITED,
    start_when_full: true, ranked: false,
  })),
  () => seat(1, (send) => send('JoinGameWithPassword', {
    game_code: gameCode, deck: loadDeck(deckB), display_name: 'SeatB', password: null,
  })),
];
seats[0]();
setTimeout(() => { console.log('timeout'); finish(); }, 120000);
