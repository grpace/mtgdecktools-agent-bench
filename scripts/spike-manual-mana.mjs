// Spike: how does phase-rs manual mana payment flow? Seat A casts with payment_mode Manual and taps
// sources one at a time; we log each ManaPayment state. Usage: node scripts/spike-manual-mana.mjs
import WebSocket from 'ws';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const url = 'ws://127.0.0.1:9374/ws';
const PROTOCOL = JSON.parse(readFileSync('engine/phase.lock.json', 'utf8')).protocol_version;
const LIMITED = {
  format: 'Limited', starting_life: 20, min_players: 2, max_players: 2, deck_size: { type: 'Minimum', data: 40 },
  singleton: false, command_zone: false, commander_damage_threshold: null, range_of_influence: null, team_based: false,
  uses_commander: false, supplies_fixed_deck: false, sideboard_policy: { type: 'Unlimited' },
  default_deck_copy_limit: { type: 'Unlimited' }, allow_debug_actions: false,
};
const deck = (p) => {
  const main = [];
  for (const l of readFileSync(p, 'utf8').split('\n')) { const m = l.match(/^(\d+)\s+(.+)$/); if (m) for (let i = 0; i < +m[1]; i++) main.push(m[2]); }
  return { main_deck: main, sideboard: [] };
};
mkdirSync('tmp', { recursive: true });
const trace = [];
let code, manualCasts = 0, done = false;

function seat(idx, start) {
  const ws = new WebSocket(url);
  const send = (type, data) => ws.send(JSON.stringify(data === undefined ? { type } : { type, data }));
  let last = -1;
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw)); const d = m.data ?? {};
    if (m.type === 'ServerHello') { send('ClientHello', { client_version: 'spike', build_commit: '', protocol_version: PROTOCOL }); start(send); return; }
    if (m.type === 'GameCreated') { code = d.game_code; seats[1](); return; }
    if (m.type === 'ActionRejected') { trace.push({ seat: idx, rejected: d.rejection }); return; }
    if (m.type !== 'StateUpdate' && m.type !== 'GameStarted') return;
    const s = d.state; const wf = s?.waiting_for;
    if (wf?.type === 'GameOver' || done) { finish(); return; }
    if (!d.legal_actions?.length || d.state_revision === last) return;
    last = d.state_revision;
    const acts = d.legal_actions;
    let pick;
    if (wf.type === 'ManaPayment' && idx === 0) {
      const byObj = d.legal_actions_by_object ?? {};
      const manaActs = Object.entries(byObj).flatMap(([oid, v]) => (Array.isArray(v) ? v : [v]).map((a) => ({ oid, a })))
        .filter(({ a }) => /Mana/.test(a.type));
      trace.push({
        seat: idx, rev: d.state_revision, waiting_for: wf, pool: s.players[0].mana_pool,
        pending_cast: s.pending_cast ?? null, flat: acts, byObject_mana: manaActs.slice(0, 12),
        lands_tapped: s.lands_tapped_for_mana ?? null,
      });
      const tap = manaActs.find(({ a }) => a.type === 'ActivateManaSource' || a.type === 'TapLandForMana');
      pick = tap ? (({ interactionActionId, ...rest }) => rest)(tap.a) : acts.find((a) => a.type === 'PassPriority');
      trace.push({ seat: idx, sent: pick });
      if (trace.length > 60) done = true;
    } else {
      const cast = acts.find((a) => a.type === 'CastSpell');
      const land = acts.find((a) => a.type === 'PlayLand');
      if (idx === 0 && cast && manualCasts < 4) {
        manualCasts++;
        pick = { ...cast, data: { ...cast.data, payment_mode: { type: 'Manual' } } };
        trace.push({ seat: idx, rev: d.state_revision, castManual: pick, pool: s.players[0].mana_pool });
      } else pick = land ?? acts.find((a) => a.type === 'PassPriority') ?? acts[0];
    }
    setTimeout(() => send('Action', { action: pick }), 70);
  });
  return ws;
}
function finish() {
  if (finish.done) return; finish.done = true;
  writeFileSync('tmp/manual-mana-trace.json', JSON.stringify(trace, null, 1));
  console.log('trace entries', trace.length, 'manual casts', manualCasts);
  setTimeout(() => process.exit(0), 300);
}
const seats = [
  () => seat(0, (send) => send('CreateGameWithSettings', { deck: deck('decks/fra-wu.txt'), display_name: 'A', public: false, password: null, timer_seconds: null, player_count: 2, match_config: { match_type: 'Bo1' }, ai_seats: [], format_config: LIMITED, start_when_full: true, ranked: false })),
  () => seat(1, (send) => send('JoinGameWithPassword', { game_code: code, deck: deck('decks/fra-br.txt'), display_name: 'B', password: null })),
];
seats[0]();
setTimeout(finish, 90000);
