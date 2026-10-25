// Does phase-server itself refuse structured answers outside what it offered? (docs/SECURITY-FINDINGS.md SEC-8)
// The Director builds DeclareAttackers, DeclareBlockers and SelectCards from an agent's raw ids; this plays random
// games against a LOCAL phase-server and, at those decisions, sends ids the engine did not offer: the opponent's
// creature or a land as an attacker, the attacker itself as a blocker, the opponent's hand card as a selection.
// Also times a game created with a 20,000-card deck (SEC-3).
//   node scripts/security/engine-probe.mjs ws://127.0.0.1:19391/ws     (never a shared or hosted engine)
import WebSocket from 'ws';
import { readFileSync } from 'node:fs';

const url = process.argv[2] ?? 'ws://127.0.0.1:19391/ws';
if (!/^ws:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error('local engines only');
const PROTOCOL = Number(JSON.parse(readFileSync(new URL('../../engine/phase.lock.json', import.meta.url))).protocol_version);
const LIMITED = {
  format: 'Limited', starting_life: 20, min_players: 2, max_players: 2, deck_size: { type: 'Minimum', data: 40 }, singleton: false,
  command_zone: false, commander_damage_threshold: null, range_of_influence: null, team_based: false, uses_commander: false,
  supplies_fixed_deck: false, sideboard_policy: { type: 'Unlimited' }, default_deck_copy_limit: { type: 'Unlimited' }, allow_debug_actions: false,
};
const deckOf = (path) => {
  const main = [];
  for (const line of readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8').split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (m) for (let i = 0; i < Number(m[1]); i++) main.push(m[2]);
  }
  return { main_deck: main, sideboard: [] };
};

const results = {};
const note = (probe, outcome, detail = '') => {
  if (results[probe]?.outcome === 'ACCEPTED') return;
  results[probe] = { outcome, detail };
  console.log(`${probe}: ${outcome}${detail ? ` (${detail})` : ''}`);
};
const isCreature = (o) => (o?.card_types?.core_types ?? o?.card_types ?? []).includes?.('Creature') || JSON.stringify(o?.card_types ?? '').includes('Creature');

function game(deckA, deckB, { probe = true, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    let code;
    const seats = [];
    let finished = false;
    const done = (why) => {
      if (finished) return;
      finished = true;
      for (const s of seats) s.ws.close();
      resolve(why);
    };
    const timer = setTimeout(() => done(`timeout (last: ${seats.map((x) => `${x?.idx}:${x?.lastWf}@${x?.rev}`).join(' ')})`), timeoutMs);
    const open = (idx, first) => {
      const ws = new WebSocket(url, { maxPayload: 512 * 1024 * 1024 });
      const s = { ws, idx, rev: -1, pending: null, started: 0 };
      seats[idx] = s;
      const send = (type, data) => ws.send(JSON.stringify(data === undefined ? { type } : { type, data }));
      s.send = send;
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        const d = msg.data ?? {};
        if (msg.type === 'ServerHello') {
          send('ClientHello', { client_version: 'mtgdt-probe/0.1', build_commit: '', protocol_version: PROTOCOL });
          s.started = Date.now();
          first(send);
          return;
        }
        if (msg.type === 'GameCreated') {
          code = d.game_code;
          open(1, (send2) => send2('JoinGameWithPassword', { game_code: code, deck: deckB, display_name: 'B', password: null }));
          return;
        }
        if (msg.type === 'ActionRejected') {
          if (s.pending) note(s.pending.probe, 'rejected', d?.rejection?.message ?? JSON.stringify(d).slice(0, 120));
          s.pending = null;
          // The state didn't change, so no new update comes: answer the same decision with a legal action.
          const acts = s.lastLegal ?? [];
          const pick = acts.find((a) => a.type === 'PassPriority') ?? acts[Math.floor(Math.random() * acts.length)];
          if (pick) setTimeout(() => send('Action', { action: pick }), 40);
          return;
        }
        if (msg.type === 'Error') {
          if (s.pending) note(s.pending.probe, 'error', JSON.stringify(d).slice(0, 120));
          s.pending = null;
          return;
        }
        if (msg.type !== 'GameStarted' && msg.type !== 'StateUpdate') return;
        if (msg.type === 'GameStarted' && idx === 0) s.onStart?.(Date.now() - s.started, String(raw).length);
        const st = d.state;
        if (s.pending && st) {
          const p = s.pending;
          s.pending = null;
          note(p.probe, p.check(st) ? 'ACCEPTED' : 'no effect', p.what);
        }
        const wf = st?.waiting_for;
        if (wf) s.lastWf = `${wf.type}/p${wf.data?.player ?? '?'}`;
        if (wf?.type === 'GameOver') return done('over');
        if (!d.legal_actions?.length || d.state_revision === s.rev) return;
        s.rev = d.state_revision;
        s.lastLegal = d.legal_actions;
        const me = d.your_player ?? idx;
        const objs = Object.values(st.objects ?? {});
        const opp = 1 - me;
        if (probe && idx === 0 && wf?.data?.player === me) {
          const valid = new Set(wf.data.valid_attacker_ids ?? []);
          if (wf.type === 'DeclareAttackers' && !results['attack with the opponent\'s creature']) {
            const theirs = objs.find((o) => o.controller === opp && o.zone === 'Battlefield' && isCreature(o));
            if (theirs) return probeSend(s, 'attack with the opponent\'s creature', { type: 'DeclareAttackers', data: { attacks: [[theirs.id, { type: 'Player', data: opp }]], bands: [] } },
              (n) => (n.combat?.attackers ?? []).some((a) => (a.object_id ?? a.id ?? a[0] ?? a) === theirs.id), `#${theirs.id} ${theirs.name}`);
          }
          if (wf.type === 'DeclareAttackers' && !results['attack with a land']) {
            const land = objs.find((o) => o.controller === me && o.zone === 'Battlefield' && !isCreature(o) && !valid.has(o.id));
            if (land) return probeSend(s, 'attack with a land', { type: 'DeclareAttackers', data: { attacks: [[land.id, { type: 'Player', data: opp }]], bands: [] } },
              (n) => (n.combat?.attackers ?? []).some((a) => (a.object_id ?? a.id ?? a[0] ?? a) === land.id), `#${land.id} ${land.name}`);
          }
          if (wf.type === 'DeclareAttackers' && !results['attack with a missing id']) {
            return probeSend(s, 'attack with a missing id', { type: 'DeclareAttackers', data: { attacks: [[999999, { type: 'Player', data: opp }]], bands: [] } },
              (n) => JSON.stringify(n.combat ?? {}).includes('999999'), '#999999');
          }
          if (wf.type === 'DeclareBlockers' && !results['block with the attacker itself']) {
            const targets = wf.data.valid_block_targets ?? {};
            const attacker = Object.values(targets).flat()[0] ?? (st.combat?.attackers?.[0]?.object_id);
            if (attacker != null) return probeSend(s, 'block with the attacker itself', { type: 'DeclareBlockers', data: { assignments: [[attacker, attacker]] } },
              (n) => JSON.stringify(n.combat?.blocker_to_attacker ?? {}).includes(`"${attacker}"`), `#${attacker}`);
          }
          const selecting = d.legal_actions.some((a) => a.type === 'SelectCards') && !['MulliganDecision', 'OpeningHandBottomCards'].includes(wf.type);
          if (selecting && !results[`select the opponent's hand card (${wf.type})`]) {
            const theirHand = st.players?.[opp]?.hand ?? [];
            if (theirHand.length) {
              const id = theirHand[0];
              return probeSend(s, `select the opponent's hand card (${wf.type})`, { type: 'SelectCards', data: { cards: [id] } },
                (n) => !(n.players?.[opp]?.hand ?? []).includes(id), `#${id}`);
            }
          }
        }
        const acts = d.legal_actions;
        const nonPass = acts.filter((a) => a.type !== 'PassPriority' && a.type !== 'CancelCast');
        const pick = nonPass.length && Math.random() < 0.85 ? nonPass[Math.floor(Math.random() * nonPass.length)] : acts.find((a) => a.type === 'PassPriority') ?? acts[0];
        setTimeout(() => send('Action', { action: pick }), 40);
      });
      ws.on('error', (e) => done(`socket error ${e.message}`));
      return s;
    };
    const probeSend = (s, probe, action, check, what) => {
      const pending = { probe, check, what };
      s.pending = pending;
      setTimeout(() => s.send('Action', { action }), 40);
      // No answer at all (neither a rejection nor a new state): the engine ignored it. Carry on with a legal action.
      setTimeout(() => {
        if (s.pending !== pending) return;
        s.pending = null;
        note(probe, 'ignored (no answer)', what);
        const acts = s.lastLegal ?? [];
        const pick = acts.find((a) => a.type === 'PassPriority') ?? acts[0];
        if (pick) s.send('Action', { action: pick });
      }, 3000);
    };
    const s0 = open(0, (send) => send('CreateGameWithSettings', {
      deck: deckA, display_name: 'A', public: false, password: null, timer_seconds: null, player_count: 2, match_config: { match_type: 'Bo1' },
      ai_seats: [], format_config: LIMITED, start_when_full: true, ranked: false,
    }));
    s0.onStart = (ms, bytes) => {
      if (!probe) {
        clearTimeout(timer);
        console.log(`game with a ${deckA.main_deck.length}-card deck started in ${ms} ms; first update ${bytes} bytes`);
        done('measured');
      }
    };
  });
}

const a = deckOf('decks/fra-wu.txt');
const b = deckOf('decks/fra-br.txt');
const wanted = 5;
for (let i = 0; i < 12 && Object.keys(results).length < wanted; i++) {
  const why = await game(a, b);
  console.log(`game ${i + 1}: ${why}; probes so far ${Object.keys(results).length}`);
}
for (const n of [40, 2_000, 20_000]) {
  await game({ main_deck: Array.from({ length: n }, (_, i) => (i % 2 ? 'Island' : 'Plains')), sideboard: [] }, b, { probe: false, timeoutMs: 180_000 }).then((why) => why !== 'measured' && console.log(`${n}-card deck: ${why}`));
}
console.log(JSON.stringify(results, null, 1));
process.exit(0);
