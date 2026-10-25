// Play the scripted test cases of a card override on a phase-server and report what happened
// (docs/CARD-OVERRIDES.md, "Tests").
//
// The cases are the `tests` list of an override file (engine/overrides/<slug>.json). Each case is one sandbox game
// (format_config.allow_debug_actions): the board is built with phase-rs debug actions, so there is no deck luck and
// no AI. Both seats are driven from here and every prompt is answered from the case.
//
// A case with `expect.bug` reproduces the bug: on upstream card data it must show `bug`, with the override `fixed`.
// A case without it is a guard: it must show `fixed` either way (the override must not break the other paths).
//
// Case fields:
//   setup [{ card, owner, zone, count?, run_etb?, counters?: { P1P1: 2, loyalty: 3, … }, tapped?, sick?, prepared? }]
//   phase? { phase: "PreCombatMain", active: 0 }   debug SetPhase after the setup (default: the first priority of turn 1)
//   infinite_mana? [0, 1]                          players whose costs are paid by the engine's debug infinite mana
//   steps [step…], played in order (a legacy case has `cast` + `respond` instead: one cast step). A step is one of:
//     { cast: { card, by?: 0, from?: "Hand", targets?: [selector], respond?: [debug…] } }   cast, then resolve it
//     { play: { card, by?: 0 } }                      play a land from hand
//     { sneak: { card, by?: 0, return: selector } }    cast for its sneak cost (declare blockers step), then resolve
//     { crew: { card, by?: 0, with: [selector…] } }   crew a Vehicle with these creatures, then resolve
//     { activate: { card, by?: 0, owner?, ability?: index, text?: "substring of the ability's text", targets?,
//                   if_offered?: true, label?, zone? } }    activate an ability (loyalty, equip, …; zone: e.g.
//                                                    "Graveyard" for an ability that works there), then resolve it;
//                                                    with if_offered, a missing ability is recorded (offered: false) and skipped
//     { debug: "MoveToZone", object?: selector, data: {…} }                       a raw debug action
//     { advance: { phase: "Upkeep", active: 1 } }      pass priority until that step of that player's turn
//     { attack: [selector…] }                           pass until the active player declares attackers; attack with these
//     { block: [{ blocker: selector, attacker: selector }] }   pass until blockers are declared; block like this
//     { resolve: true }                                 pass priority until the stack is empty
//     { offered: { label, cast | activate | play: {…} } }   record whether that action is offered now (it isn't taken)
//   answers { optional: [bool…] (optional effects and "you may … instead" replacements, in order),
//             select: [selector…], targets: [selector…] (trigger targets, in order),
//             unless: [bool…] (pay an "unless" cost when asked, in order; default: don't) }
//   expect { fixed, bug? }, each { life: [p0, p1], zones: [{ card, owner, zone, count? }], hand: [n0, n1],
//            library: [n0, n1], objects: [{ card, owner?, controller?, zone?, count?, loyalty?, counters?, power?,
//            toughness?, tapped?, keywords?: [has…], no_keywords?: [lacks…] }], winner?: 0|1|null,
//            offered?: { label: bool } }
//   Cards in a hidden zone (the opponent's hand) are read from their owner's view.
//   A selector is { card, owner?, controller?, zone? }.
//
// Usage: node scripts/card-scenario.mjs <override.json> [--phase ws://127.0.0.1:9374/ws] [--data upstream|patched] [--json]
//   --data upstream: the server runs upstream card data, so cases with expect.bug must show the bug.
//   --data patched (default): the server runs card data with this override applied, so every case must be fixed.
// Exit: 0 when every case matched, 1 when one didn't, 2 on a harness error.
//
// Never point this at a server running real events: sandbox games don't touch other games, but they use a game
// slot. `npm run overrides -- test` starts throwaway servers for it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const FORMAT = {
  format: 'Limited', starting_life: 20, min_players: 2, max_players: 2, deck_size: { type: 'Minimum', data: 40 },
  singleton: false, command_zone: false, commander_damage_threshold: null, range_of_influence: null, team_based: false,
  uses_commander: false, supplies_fixed_deck: false, sideboard_policy: { type: 'Unlimited' },
  default_deck_copy_limit: { type: 'Unlimited' }, allow_debug_actions: true,
};
const STEP_LIMIT = 600;
const TIMEOUT_MS = Number(process.env.SCENARIO_TIMEOUT_MS) || 90_000;

class HarnessError extends Error {}

const sortKeys = (o) => Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)));

/** What a case can check: life, every object outside libraries (by "Name@owner" → zones, and in detail), counts. */
function observe(st, offered = {}) {
  const zones = {};
  const objects = [];
  for (const o of Object.values(st.objects ?? {})) {
    if (o.zone === 'Library') continue;
    (zones[`${o.name}@${o.owner}`] ??= []).push(o.zone);
    objects.push({
      name: o.name, owner: o.owner, controller: o.controller, zone: o.zone, tapped: !!o.tapped, loyalty: o.loyalty ?? null,
      power: o.power ?? null, toughness: o.toughness ?? null, counters: sortKeys(o.counters),
      keywords: (o.keywords ?? []).map((k) => (typeof k === 'string' ? k : Object.keys(k)[0])),
    });
  }
  const over = st.waiting_for?.type === 'GameOver' ? st.waiting_for.data ?? {} : null;
  return {
    life: st.players.map((p) => p.life), zones, objects,
    hand: st.players.map((p) => (p.hand ?? []).length), library: st.players.map((p) => (p.library ?? []).length),
    ...(over ? { winner: over.winner ?? null } : {}),
    offered,
  };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** What differs from an expectation; [] = matches. */
export function mismatches(outcome, want) {
  const problems = [];
  (want.life ?? []).forEach((l, p) => {
    if (outcome.life[p] !== l) problems.push(`player ${p} life ${outcome.life[p]}, expected ${l}`);
  });
  for (const k of ['hand', 'library']) {
    (want[k] ?? []).forEach((n, p) => {
      if (n !== null && outcome[k]?.[p] !== n) problems.push(`player ${p} ${k} ${outcome[k]?.[p]} cards, expected ${n}`);
    });
  }
  for (const z of want.zones ?? []) {
    const n = (outcome.zones[`${z.card}@${z.owner}`] ?? []).filter((x) => x === z.zone).length;
    if (n !== (z.count ?? 1)) problems.push(`${z.card} (owner ${z.owner}) in ${z.zone}: ${n}, expected ${z.count ?? 1}`);
  }
  for (const w of want.objects ?? []) {
    const what = `${w.card}${w.owner !== undefined ? ` (owner ${w.owner})` : ''}${w.controller !== undefined ? ` (controller ${w.controller})` : ''}${w.zone ? ` in ${w.zone}` : ''}`;
    const found = (outcome.objects ?? []).filter((o) => o.name === w.card && (w.owner === undefined || o.owner === w.owner)
      && (w.controller === undefined || o.controller === w.controller) && (w.zone === undefined || o.zone === w.zone));
    if (found.length !== (w.count ?? 1)) {
      problems.push(`${what}: ${found.length} object(s), expected ${w.count ?? 1}`);
      continue;
    }
    for (const o of found) {
      for (const k of ['loyalty', 'power', 'toughness', 'tapped']) {
        if (w[k] !== undefined && o[k] !== w[k]) problems.push(`${what}: ${k} ${o[k]}, expected ${w[k]}`);
      }
      if (w.counters !== undefined) {
        const want = Object.fromEntries(Object.entries(w.counters).filter(([, n]) => n));
        const have = Object.fromEntries(Object.entries(o.counters).filter(([, n]) => n));
        if (!same(sortKeys(want), sortKeys(have))) problems.push(`${what}: counters ${JSON.stringify(have)}, expected ${JSON.stringify(want)}`);
      }
      for (const kw of w.keywords ?? []) if (!o.keywords.includes(kw)) problems.push(`${what}: lacks ${kw} (has ${o.keywords.join(', ') || 'none'})`);
      for (const kw of w.no_keywords ?? []) if (o.keywords.includes(kw)) problems.push(`${what}: has ${kw}`);
    }
  }
  if (want.winner !== undefined && outcome.winner !== want.winner) problems.push(`winner ${outcome.winner === undefined ? '(game not over)' : outcome.winner}, expected ${want.winner}`);
  for (const [label, v] of Object.entries(want.offered ?? {})) {
    if (outcome.offered?.[label] !== v) problems.push(`${label}: ${outcome.offered?.[label] === undefined ? 'never probed' : outcome.offered[label] ? 'offered' : 'not offered'}, expected ${v ? 'offered' : 'not offered'}`);
  }
  return problems;
}

/** The steps of a case: `steps`, or the legacy single cast. */
function stepsOf(tc) {
  if (Array.isArray(tc.steps)) return tc.steps;
  return tc.cast ? [{ cast: { ...tc.cast, respond: tc.respond } }] : [];
}

/** Play one case to the end of its last step. Resolves with { outcome, trace }. */
export function playCase(url, protocol, tc) {
  return new Promise((resolve, reject) => {
    const trace = [];
    const note = (s) => trace.push(s);
    const seats = [];
    const sockets = [];
    const steps = stepsOf(tc);
    let phase = 'setup';
    let count = 0;
    let si = -1; // current step
    let cur = null; // per-step state
    let created = false;
    let adjusted = false;
    let pending = false;
    let done = false;
    const answers = tc.answers ?? {};
    const optional = Array.isArray(answers.optional) ? [...answers.optional] : null;
    const triggerTargets = [...(answers.targets ?? [])];
    const unless = [...(answers.unless ?? [])];
    const offered = {};
    const libStart = [0, 0];
    const deck = { main_deck: Array(40).fill(tc.deck_card ?? 'Mountain'), sideboard: [] };

    const end = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const ws of sockets) ws.terminate();
      if (err) {
        err.trace = trace;
        reject(err);
      } else resolve({ ...value, trace });
    };
    const fail = (msg) => end(new HarnessError(msg));
    const timer = setTimeout(() => fail(`timed out after ${TIMEOUT_MS} ms (${phase}${si >= 0 ? ` step ${si + 1}` : ''})`), TIMEOUT_MS);

    // Both seats' views: an object hidden from player 0 (the opponent's hand) is read from its owner's view.
    const objects = (st) => {
      const mine = st.objects ?? {};
      const theirs = seats[1]?.last?.state?.objects ?? {};
      return Object.entries(mine).map(([id, o]) => (o.name === 'Hidden Card' && theirs[id] && theirs[id].name !== 'Hidden Card' ? theirs[id] : o));
    };
    const legal = (i) => seats[i]?.last?.legal_actions ?? [];
    const find = (st, sel) => objects(st).find((o) => o.name === sel.card
      && (sel.owner === undefined || o.owner === sel.owner)
      && (sel.controller === undefined || o.controller === sel.controller)
      && (sel.zone === undefined || o.zone === sel.zone));
    // Each decision is made on fresh state: after an action, wait until both seats have seen a state revision newer
    // than the one the action was based on (a slow server otherwise lets the harness act twice on one state), or for a
    // fallback timer when only one seat's view changes.
    let rev = -1;
    let need = -1; // the state revision both seats must have seen before the next decision
    let fallback;
    const act = (i, action) => {
      note(`[${i}] ${JSON.stringify(action).slice(0, 240)}`);
      // Actions sent before their updates arrive (the setup's debug batch) each add a revision to wait for.
      need = need > rev ? need + 1 : rev + 1;
      seats[i].send('Action', { action });
      clearTimeout(fallback);
      fallback = setTimeout(() => schedule(true), 1500);
    };
    /** An action that should be possible isn't offered yet: the state may still be settling; retry briefly, then fail. */
    function notYet(c, msg) {
      c.retries = (c.retries ?? 0) + 1;
      if (c.retries > 12) return fail(msg);
      note(`not yet (${c.retries}): ${msg}`);
      setTimeout(() => schedule(true), 250);
    }
    function schedule(force) {
      if (pending || done || !seats[0]?.last || !seats[1]?.last) return;
      const fresh = (i) => (seats[i].rev ?? -1) >= need;
      if (!force && need >= 0 && !(fresh(0) && fresh(1))) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        clearTimeout(fallback);
        if (!done) {
          try {
            drive();
          } catch (e) {
            fail(e.message);
          }
        }
      }, 60);
    }
    const debug = (type, data) => act(0, { type: 'Debug', data: { type, data } });

    function open(idx, gameCode) {
      const ws = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 });
      sockets.push(ws);
      const seat = { last: null, send: (type, data) => ws.send(JSON.stringify({ type, data })) };
      seats[idx] = seat;
      ws.on('error', (e) => fail(`seat ${idx}: ${e.message}`));
      ws.on('message', (raw) => {
        if (done) return;
        const m = JSON.parse(String(raw));
        const d = m.data ?? {};
        if (m.type === 'ServerHello') {
          if (d.protocol_version !== protocol) return fail(`server speaks protocol ${d.protocol_version}, engine/phase.lock.json pins ${protocol}`);
          seat.send('ClientHello', { client_version: 'mtgdt-card-scenario/2', build_commit: '', protocol_version: protocol });
          if (idx === 0) {
            seat.send('CreateGameWithSettings', {
              deck, display_name: 'Caster', public: false, password: null, timer_seconds: null, player_count: 2,
              match_config: { match_type: 'Bo1' }, ai_seats: [], format_config: FORMAT, start_when_full: true, ranked: false,
            });
          } else seat.send('JoinGameWithPassword', { game_code: gameCode, deck, display_name: 'Opponent', password: null });
          return;
        }
        if (m.type === 'GameCreated') return open(1, d.game_code);
        if (m.type === 'StateUpdate' || m.type === 'GameStarted') {
          seat.last = d;
          if (typeof d.state_revision === 'number') seat.rev = d.state_revision;
          rev = Math.max(rev, seat.rev ?? -1);
          schedule(false);
          return;
        }
        if (/Reject|Fail|Error|Fault/.test(m.type)) {
          note(`[${idx}] ${m.type} ${JSON.stringify(d).slice(0, 300)}`);
          fail(`phase-server refused an action: ${m.type} ${JSON.stringify(d).slice(0, 300)}`);
        }
      });
    }

    /** Answer a prompt that isn't the current step's own business. Returns true when it acted. */
    function answerPrompt(st, wf) {
      for (const i of [0, 1]) {
        const L = legal(i);
        if (!L.length) continue;
        if (wf.type === 'TargetSelection' || wf.type === 'TriggerTargetSelection') {
          // The current cast/activate step's targets, else the trigger targets queue, else the first legal target.
          const own = cur?.targets;
          let pick;
          if (own && wf.type === 'TargetSelection') {
            const n = (wf.data?.pending_cast?.chosen_target_slots ?? wf.data?.pending_cast?.ability?.chosen_target_slots ?? []).length;
            const sel = own[Math.min(n, own.length - 1)];
            const obj = sel && find(st, sel);
            pick = obj ? L.find((a) => a.type === 'ChooseTarget' && a.data?.target?.Object === obj.id)
              : sel?.player !== undefined ? L.find((a) => a.type === 'ChooseTarget' && a.data?.target?.Player === sel.player) : undefined;
            if (!pick) return fail(`no legal target matching ${JSON.stringify(sel)}`), true;
          } else if (triggerTargets.length) {
            const sel = triggerTargets.shift();
            if (sel === null) pick = L.find((a) => a.type === 'ChooseTarget' && (a.data?.target === null || a.data?.target === undefined)) ?? L.find((a) => /Skip|Done|Finish/.test(a.type));
            else {
              const obj = sel.player === undefined ? find(st, sel) : null;
              pick = obj ? L.find((a) => a.type === 'ChooseTarget' && a.data?.target?.Object === obj.id)
                : L.find((a) => a.type === 'ChooseTarget' && a.data?.target?.Player === sel.player);
            }
            if (!pick) return fail(`no legal trigger target matching ${JSON.stringify(sel)}`), true;
          }
          act(i, pick ?? L.find((a) => a.type === 'ChooseTarget') ?? L[0]);
          return true;
        }
        if (wf.type === 'UnlessPayment' || L.some((a) => a.type === 'PayUnlessCost')) {
          const pay = unless.length ? unless.shift() : false;
          const pick = L.find((a) => a.type === 'PayUnlessCost' && a.data?.pay === pay);
          if (pick) {
            act(i, pick);
            return true;
          }
        }
        if (wf.type === 'ReplacementChoice' && wf.data?.kind?.type === 'OptionalBranch') {
          // "You may … instead" replacements: index 0 accepts, 1 declines (same queue as optional effects).
          const accept = optional ? (optional.shift() ?? false) : Boolean(answers.optional);
          const pick = L.find((a) => a.type === 'ChooseReplacement' && a.data?.index === (accept ? 0 : 1));
          if (pick) {
            act(i, pick);
            return true;
          }
        }
        if (wf.type === 'OptionalEffectChoice') {
          const accept = optional ? (optional.shift() ?? false) : Boolean(answers.optional);
          const pick = L.find((a) => a.type === 'DecideOptionalEffect' && a.data?.accept === accept);
          if (pick) {
            act(i, pick);
            return true;
          }
        }
        if (L.some((a) => a.type === 'SelectCards')) {
          const ids = (answers.select ?? []).map((s) => find(st, s)?.id).filter((x) => x !== undefined);
          const pick = (ids.length && L.find((a) => a.type === 'SelectCards' && ids.every((id) => a.data?.cards?.includes(id))))
            || L.find((a) => a.type === 'SelectCards');
          if (pick) {
            act(i, pick);
            return true;
          }
        }
        if (wf.type === 'DeclareAttackers' && !(cur?.kind === 'attack')) {
          act(i, { type: 'DeclareAttackers', data: { attacks: [], bands: [] } });
          return true;
        }
        if (wf.type === 'DeclareBlockers' && !(cur?.kind === 'block')) {
          act(i, { type: 'DeclareBlockers', data: { assignments: [] } });
          return true;
        }
      }
      return false;
    }

    const passAny = (st) => {
      for (const i of [0, 1]) {
        const L = legal(i);
        if (!L.length) continue;
        const pass = L.find((a) => a.type === 'PassPriority');
        if (!pass) note(`[${i}] unscripted prompt ${st.waiting_for?.type}; taking the first option`);
        act(i, pass ?? L[0]);
        return true;
      }
      return false;
    };

    function startStep(st) {
      si++;
      if (si >= steps.length) {
        phase = 'done';
        return end(null, { outcome: observe(merged(st), offered) });
      }
      const s = steps[si];
      const kind = ['cast', 'sneak', 'play', 'activate', 'crew', 'debug', 'advance', 'attack', 'block', 'resolve', 'offered'].find((k) => s[k] !== undefined);
      if (!kind) return fail(`step ${si + 1}: unknown step ${JSON.stringify(s)}`);
      cur = { kind, s: s[kind], started: false, targets: s[kind]?.targets };
      note(`step ${si + 1}: ${kind} ${JSON.stringify(s[kind]).slice(0, 160)}`);
      phase = 'steps';
      return drive();
    }

    const idle = (st) => (st.waiting_for?.type === 'Priority') && !(st.stack ?? []).length;

    function stepDrive(st, wf) {
      const c = cur;
      const by = c.s?.by ?? 0;
      if (c.kind === 'debug') {
        const obj = s_obj(st, steps[si].object);
        if (steps[si].object && !obj) return fail(`step ${si + 1}: no object matching ${JSON.stringify(steps[si].object)}`);
        debug(steps[si].debug, { ...(obj ? { object_id: obj.id } : {}), ...(steps[si].data ?? {}) });
        cur = { kind: 'after-debug' };
        return;
      }
      if (c.kind === 'after-debug') {
        // The debug action's own state update has arrived (schedule waits for it).
        cur = null;
        return startStep(st);
      }
      if (c.kind === 'offered') {
        // Record whether the action would be offered to its player now; never take it.
        if (answerPrompt(st, wf)) return;
        if (wf.type !== 'Priority') return passAny(st);
        const o = c.s;
        const kind = ['cast', 'activate', 'play'].find((k) => o[k] !== undefined);
        const q = o[kind] ?? {};
        const who = q.by ?? 0;
        if (st.priority_player !== who) return passAny(st);
        let ok = false;
        if (kind === 'cast' || kind === 'play') {
          const obj = find(st, { card: q.card, owner: q.owner ?? who, zone: q.from ?? 'Hand' });
          ok = !!obj && legal(who).some((a) => a.type === (kind === 'cast' ? 'CastSpell' : 'PlayLand') && a.data?.object_id === obj.id);
        } else {
          const src = find(st, { card: q.card, owner: q.owner, controller: q.controller ?? who, zone: 'Battlefield' });
          ok = !!src && legal(who).some((a) => ['ActivateAbility', 'Equip'].includes(a.type) && (a.data?.source_id === src.id || a.data?.object_id === src.id)
            && (q.ability !== undefined ? a.data?.ability_index === q.ability : q.text !== undefined ? String(src.abilities?.[a.data?.ability_index]?.description ?? '').includes(q.text) : true));
        }
        if (!ok && (c.retries ?? 0) < 4) return notYet(c, `step ${si + 1}: ${o.label} not offered`);
        offered[o.label] = ok;
        note(`step ${si + 1}: ${o.label} ${ok ? 'offered' : 'not offered'}`);
        cur = null;
        return startStep(st);
      }
      if (c.kind === 'play') {
        if (answerPrompt(st, wf)) return;
        const by = c.s.by ?? 0;
        if (!c.started) {
          if (wf.type !== 'Priority' || st.priority_player !== by) return passAny(st);
          const land = find(st, { card: c.s.card, owner: c.s.owner ?? by, zone: 'Hand' });
          const pick = land && legal(by).find((a) => a.type === 'PlayLand' && a.data?.object_id === land.id);
          if (!pick) return notYet(c, `step ${si + 1}: player ${by} can't play ${c.s.card} now`);
          c.started = true;
          return act(by, pick);
        }
        if (idle(st)) {
          cur = null;
          return startStep(st);
        }
        return passAny(st);
      }
      if (c.kind === 'sneak' && !c.started) {
        // CastSpellAsSneak (offered in the declare blockers step): return an unblocked attacker, cast from hand.
        if (answerPrompt(st, wf)) return;
        const card = find(st, { card: c.s.card, owner: c.s.owner ?? by, zone: 'Hand' });
        const back = c.s.return ? find(st, { zone: 'Battlefield', ...c.s.return }) : undefined;
        if (!card) return fail(`step ${si + 1}: ${c.s.card} is not in player ${by}'s hand`);
        const pick = legal(by).find((a) => a.type === 'CastSpellAsSneak' && (a.data?.hand_object === card.id || a.data?.object_id === card.id)
          && (!back || a.data?.creature_to_return === back.id));
        if (!pick) {
          if (wf.type === 'Priority' && st.priority_player !== by) return passAny(st);
          if (wf.type !== 'Priority') return passAny(st);
          return notYet(c, `step ${si + 1}: player ${by} can't cast ${c.s.card} for its sneak cost now (phase ${st.phase}; legal: ${legal(by).map((a) => a.type).join(', ')})`);
        }
        c.started = true;
        c.id = card.id;
        c.stackBefore = (st.stack ?? []).length;
        return act(by, pick);
      }
      if (c.kind === 'crew' && !c.started) {
        // Crew N (CR 702.122a): offered as CrewVehicle with no creatures; then the creatures are chosen.
        if (answerPrompt(st, wf)) return;
        const v = find(st, { card: c.s.card, controller: by, zone: 'Battlefield' });
        if (!v) return fail(`step ${si + 1}: no ${c.s.card} controlled by player ${by}`);
        const ids = [];
        for (const sel of c.s.with ?? []) {
          const o = objects(st).find((x) => !ids.includes(x.id) && x.name === sel.card && x.zone === 'Battlefield' && (sel.owner === undefined || x.owner === sel.owner));
          if (!o) return fail(`step ${si + 1}: no crew member matching ${JSON.stringify(sel)}`);
          ids.push(o.id);
        }
        if (wf.type === 'CrewVehicle') {
          c.started = true;
          c.stackBefore = (st.stack ?? []).length;
          return act(by, { type: 'CrewVehicle', data: { vehicle_id: v.id, creature_ids: ids } });
        }
        const start = legal(by).find((a) => a.type === 'CrewVehicle' && a.data?.vehicle_id === v.id);
        if (!start) {
          if (wf.type !== 'Priority' || st.priority_player !== by) return passAny(st);
          return notYet(c, `step ${si + 1}: player ${by} can't crew ${c.s.card} now`);
        }
        return act(by, start);
      }
      if (c.kind === 'cast' || c.kind === 'activate' || c.kind === 'sneak' || c.kind === 'crew') {
        if (!c.started) {
          if (answerPrompt(st, wf)) return;
          if (wf.type !== 'Priority') return passAny(st);
          if (c.kind === 'cast') {
            const spell = find(st, { card: c.s.card, owner: c.s.owner ?? by, zone: c.s.from ?? 'Hand' });
            if (!spell) return fail(`step ${si + 1}: ${c.s.card} is not in player ${c.s.owner ?? by}'s ${c.s.from ?? 'Hand'}`);
            const cast = legal(by).find((a) => a.type === 'CastSpell' && a.data?.object_id === spell.id);
            if (!cast) {
              if (st.priority_player !== by) return passAny(st);
              return notYet(c, `step ${si + 1}: player ${by} can't cast ${c.s.card} now (legal: ${legal(by).map((a) => a.type).join(', ')})`);
            }
            c.started = true;
            c.id = spell.id;
            c.stackBefore = (st.stack ?? []).length;
            return act(by, cast);
          }
          const zone = c.s.zone ?? 'Battlefield';
          const src = find(st, zone === 'Battlefield' ? { card: c.s.card, owner: c.s.owner, controller: c.s.controller ?? by, zone } : { card: c.s.card, owner: c.s.owner ?? by, zone });
          if (!src) return fail(`step ${si + 1}: no ${c.s.card} of player ${c.s.controller ?? c.s.owner ?? by} in ${zone}`);
          const abilities = src.abilities ?? [];
          const candidates = legal(by).filter((a) => ['ActivateAbility', 'Equip'].includes(a.type) && (a.data?.source_id === src.id || a.data?.object_id === src.id));
          const pick = candidates.find((a) => {
            const idx = a.data?.ability_index;
            if (c.s.ability !== undefined) return idx === c.s.ability;
            if (c.s.text !== undefined) return String(abilities[idx]?.description ?? '').includes(c.s.text);
            return true;
          });
          if (!pick && c.s.if_offered && st.priority_player === by && (c.retries ?? 0) < 4) return notYet(c, `step ${si + 1}: ${c.s.card} not offered`);
          if (!pick && c.s.if_offered && st.priority_player === by) {
            // Not offered (an ability the unpatched card doesn't have): record it and go on.
            offered[c.s.label ?? `activate ${c.s.card}`] = false;
            note(`step ${si + 1}: ${c.s.card} ${c.s.ability ?? c.s.text ?? ''} not offered; skipped`);
            cur = null;
            return startStep(st);
          }
          if (!pick) {
            if (st.priority_player !== by) return passAny(st);
            return notYet(c, `step ${si + 1}: player ${by} can't activate ${c.s.card} ${c.s.ability ?? c.s.text ?? ''} now (offered: ${JSON.stringify(candidates.map((a) => a.data?.ability_index))}; legal: ${legal(by).map((a) => a.type).join(', ')})`);
          }
          c.started = true;
          c.stackBefore = (st.stack ?? []).length;
          if (c.s.if_offered) offered[c.s.label ?? `activate ${c.s.card}`] = true;
          return act(by, pick);
        }
        // Started: respond once while it's on the stack, then resolve everything.
        if (!c.responded && c.s.respond?.length && wf.type === 'Priority' && (st.stack ?? []).length > c.stackBefore) {
          c.responded = true;
          for (const r of c.s.respond) {
            const obj = find(st, r.object);
            if (!obj) return fail(`respond: no object matching ${JSON.stringify(r.object)}`);
            act(0, { type: 'Debug', data: { type: r.debug, data: { object_id: obj.id, ...(r.data ?? {}) } } });
          }
          return;
        }
        if (answerPrompt(st, wf)) return;
        const spell = c.id !== undefined ? objects(st).find((o) => o.id === c.id) : null;
        if (idle(st) && (!spell || spell.zone !== 'Stack')) {
          cur = null;
          return startStep(st);
        }
        return passAny(st);
      }
      if (c.kind === 'resolve') {
        if (answerPrompt(st, wf)) return;
        if (idle(st)) {
          cur = null;
          return startStep(st);
        }
        return passAny(st);
      }
      if (c.kind === 'advance') {
        if (c.turn0 === undefined) {
          c.turn0 = st.turn_number;
          c.phase0 = st.phase;
        }
        if (st.phase === c.s.phase && st.active_player === (c.s.active ?? st.active_player) && (c.left || st.turn_number !== c.turn0 || c.s.now)
          && (wf.type === 'Priority' || wf.type === 'DeclareAttackers' || wf.type === 'DeclareBlockers')) {
          cur = null;
          return startStep(st);
        }
        if (c.turn0 === undefined) {
          c.turn0 = st.turn_number;
          c.phase0 = st.phase;
        }
        if (st.phase !== c.phase0 || st.turn_number !== c.turn0) c.left = true;
        if (answerPrompt(st, wf)) return;
        return passAny(st);
      }
      if (c.kind === 'attack' || c.kind === 'block') {
        const type = c.kind === 'attack' ? 'DeclareAttackers' : 'DeclareBlockers';
        if (wf.type === type && !c.declared) {
          const who = [0, 1].find((i) => legal(i).length);
          c.declared = true;
          if (c.kind === 'attack') {
            const byAttacker = wf.data?.valid_attack_targets_by_attacker ?? {};
            const attacks = [];
            const chosen = new Set();
            for (const sel of c.s) {
              // Two attackers with the same name: each selector takes the next one not chosen yet.
              const obj = objects(st).find((o) => !chosen.has(o.id) && o.name === sel.card && o.zone === 'Battlefield'
                && (sel.owner === undefined || o.owner === sel.owner) && (sel.controller === undefined || o.controller === sel.controller)
                && (wf.data?.valid_attacker_ids ?? []).includes(o.id)) ?? find(st, { zone: 'Battlefield', ...sel });
              if (obj) chosen.add(obj.id);
              if (!obj) return fail(`step ${si + 1}: no attacker matching ${JSON.stringify(sel)}`);
              if (!(wf.data?.valid_attacker_ids ?? []).includes(obj.id)) return fail(`step ${si + 1}: ${sel.card} can't attack (valid: ${JSON.stringify(wf.data?.valid_attacker_ids)})`);
              const targets = byAttacker[String(obj.id)] ?? wf.data?.valid_attack_targets ?? [];
              const t = sel.target ? (sel.target.player !== undefined ? targets.find((x) => x.type === 'Player' && x.data === sel.target.player) : targets.find((x) => x.type !== 'Player' && x.data === find(st, sel.target)?.id))
                : targets.find((x) => x.type === 'Player' && x.data !== who) ?? targets[0];
              attacks.push([obj.id, t]);
            }
            return act(who, { type, data: { attacks, bands: [] } });
          }
          const assignments = [];
          for (const b of c.s) {
            const bl = find(st, { zone: 'Battlefield', ...b.blocker });
            const at = find(st, { zone: 'Battlefield', ...b.attacker });
            if (!bl || !at) return fail(`step ${si + 1}: no block ${JSON.stringify(b)}`);
            assignments.push([bl.id, at.id]);
          }
          return act(who, { type, data: { assignments } });
        }
        if (c.declared && wf.type === 'Priority') {
          cur = null;
          return startStep(st);
        }
        if (answerPrompt(st, wf)) return;
        return passAny(st);
      }
      return fail(`step ${si + 1}: unhandled ${c.kind}`);
    }

    const s_obj = (st, sel) => (sel ? find(st, sel) : undefined);
    const merged = (st) => ({ ...st, objects: Object.fromEntries(objects(st).map((o) => [o.id, o])) });

    function drive() {
      if (++count > STEP_LIMIT) return fail(`gave up after ${STEP_LIMIT} decisions (${phase}${si >= 0 ? ` step ${si + 1}` : ''})`);
      const st = seats[0].last.state;
      const wf = st.waiting_for ?? {};
      if (wf.type === 'GameOver') {
        if (phase === 'steps') return end(null, { outcome: observe(merged(st), offered) });
        return fail('the game ended before the case finished');
      }
      if (wf.type === 'MulliganDecision') {
        for (const i of [0, 1]) {
          const keep = legal(i).find((a) => a.type === 'MulliganDecision' && a.data?.choice?.type === 'Keep');
          if (keep) return act(i, keep);
        }
      }

      if (phase === 'setup') {
        if (wf.type !== 'Priority') return passAny(st);
        if (!created) {
          // Debug actions skip the prompt in progress; send them all, then wait until the board shows them.
          created = true;
          libStart[0] = (st.players[0].library ?? []).length;
          libStart[1] = (st.players[1].library ?? []).length;
          for (const s of tc.setup) {
            debug('CreateCard', { card_name: s.card, owner: s.owner ?? 0, zone: s.zone, count: s.count ?? 1, run_etb: s.run_etb ?? false });
          }
          return;
        }
        const want = new Map();
        for (const s of tc.setup) {
          const k = `${s.card}\u0000${s.owner ?? 0}\u0000${s.zone}`;
          want.set(k, (want.get(k) ?? 0) + (s.count ?? 1));
        }
        for (const [k, n] of want) {
          const [card, owner, zone] = k.split('\u0000');
          if (zone === 'Library') continue; // hidden: counted below
          if (objects(st).filter((o) => o.name === card && o.owner === Number(owner) && o.zone === zone).length < n) return;
        }
        for (const p of [0, 1]) {
          const n = tc.setup.filter((s) => s.zone === 'Library' && (s.owner ?? 0) === p).reduce((a, s) => a + (s.count ?? 1), 0);
          if (n && (st.players[p].library ?? []).length < libStart[p] + n) return;
        }
        if (!adjusted) {
          // Counters, tapped state, summoning sickness, prepared, the phase and free mana: debug actions too.
          adjusted = true;
          let sent = 0;
          const used = new Set();
          for (const s of tc.setup) {
            const objs = objects(st).filter((o) => o.name === s.card && o.owner === (s.owner ?? 0) && o.zone === s.zone && !used.has(o.id)).slice(0, s.count ?? 1);
            for (const o of objs) {
              used.add(o.id);
              for (const [counter_type, delta] of Object.entries(s.counters ?? {})) {
                debug('ModifyCounters', { object_id: o.id, counter_type, delta });
                sent++;
              }
              if (s.tapped !== undefined) {
                debug('SetTapped', { object_id: o.id, tapped: s.tapped });
                sent++;
              }
              if (s.sick !== undefined) {
                debug('SetSummoningSickness', { object_id: o.id, sick: s.sick });
                sent++;
              }
              if (s.prepared !== undefined) {
                debug('SetPrepared', { object_id: o.id, prepared: s.prepared });
                sent++;
              }
            }
          }
          for (const p of tc.infinite_mana ?? []) {
            debug('SetInfiniteMana', { player_id: p, enabled: true });
            sent++;
          }
          if (tc.phase) {
            debug('SetPhase', { phase: tc.phase.phase, active_player: tc.phase.active ?? 0 });
            sent++;
          }
          if (sent) return; // the next fresh state continues
        }
        note(`board: ${JSON.stringify(observe(st).zones)}`);
        return startStep(st);
      }
      if (phase === 'steps' && cur) return stepDrive(st, wf);
    }

    open(0);
  });
}

/** Run every case; returns [{ name, verdict: fixed|bug|other, ok, outcome, problems }]. */
export async function runCases(url, protocol, override, data) {
  const results = [];
  for (const tc of override.tests ?? []) {
    const { outcome, trace } = await playCase(url, protocol, tc);
    const fixed = mismatches(outcome, tc.expect.fixed);
    const bug = tc.expect.bug ? mismatches(outcome, tc.expect.bug) : null;
    const verdict = fixed.length === 0 ? 'fixed' : bug && bug.length === 0 ? 'bug' : 'other';
    const want = data === 'upstream' && tc.expect.bug ? 'bug' : 'fixed';
    results.push({ name: tc.name, verdict, want, ok: verdict === want, outcome, problems: verdict === 'fixed' ? (bug && verdict !== want ? ['(the fixed outcome, on upstream data)'] : []) : fixed, ...(verdict === 'other' && bug ? { bug_problems: bug } : {}), trace });
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : dflt;
  };
  const file = args.find((a, i) => !a.startsWith('--') && !['--phase', '--data'].includes(args[i - 1]));
  const data = opt('--data', 'patched');
  if (!file || !['upstream', 'patched'].includes(data)) {
    console.error('usage: node scripts/card-scenario.mjs <override.json> [--phase URL] [--data upstream|patched] [--json]');
    process.exit(2);
  }
  const protocol = Number(process.env.PHASE_PROTOCOL_VERSION) || JSON.parse(
    readFileSync(fileURLToPath(new URL('../engine/phase.lock.json', import.meta.url)), 'utf8'),
  ).protocol_version;
  const override = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(override.tests) || !override.tests.length) {
    console.error(`${file}: no tests`);
    process.exit(2);
  }
  let results;
  try {
    results = await runCases(opt('--phase', 'ws://127.0.0.1:9374/ws'), protocol, override, data);
  } catch (e) {
    if (args.includes('--json')) console.log(JSON.stringify({ ok: false, error: e.message, trace: e.trace }));
    else console.error(`card-scenario: ${e.message}\n  ${(e.trace ?? []).slice(-12).join('\n  ')}`);
    process.exitCode = 2; // not process.exit(): a large result piped to the caller must be written out first
    return;
  }
  const ok = results.every((r) => r.ok);
  if (args.includes('--json')) console.log(JSON.stringify({ ok, data, results }));
  else {
    for (const r of results) {
      console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${override.card} / ${r.name}: ${r.verdict} (want ${r.want}; life ${r.outcome.life.join('/')})`);
      if (!r.ok) for (const p of r.problems) console.log(`         - ${p}`);
    }
  }
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
