"""Score the draft of every seat in a benchmark run: writes runs/<id>/draft-eval.json.

See analysis/README.md for the definitions and the output schema.
"""
from __future__ import annotations

import json
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

from . import config
from .cards import COLORS, PAIRS, card_meta, wubrg
from .features import build_context, featurize, lane_weights
from .model import Model

SCHEMA = "draft-eval/1"
SIGNAL_PICKS = range(4, 10)  # pack 1, picks 4-9


def canon_basic(name: str) -> bool:
    return name in ("Plains", "Island", "Swamp", "Mountain", "Forest", "Wastes")


def read_events(run_dir: Path):
    ev = defaultdict(list)
    with open(run_dir / "events.jsonl") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            e = json.loads(line)
            ev[e["type"]].append(e)
    return ev


def r(x, d=4):
    if x is None:
        return None
    x = float(x)
    return None if not np.isfinite(x) else round(x, d)


def deck_colors(main: list[str], set_code: str):
    """Main colors = colors with >= 3 non-land cards (hard or hybrid pips); splash = other colors used."""
    cnt = Counter()
    for n in main:
        m = card_meta(n, set_code)
        if m.land:
            continue
        cols = set(m.pips) if m.pips else set().union(*map(set, m.hybrid)) if m.hybrid else set()
        for c in cols:
            cnt[c] += 1
    main_c = wubrg("".join(c for c, k in cnt.items() if k >= 3))
    splash = wubrg("".join(c for c, k in cnt.items() if 0 < k < 3))
    return main_c, splash


def infer_upstream(picks_by_seat: dict, pack_number: int):
    """Who passes to whom in a pack round: seat s at pick k+1 sees seat u's pick-k pack minus u's pick."""
    after = {}
    for s, ps in picks_by_seat.items():
        for p in ps:
            if p["pack_number"] == pack_number:
                rest = Counter(p["pack"])
                rest[p["pick"]] -= 1
                after[(s, p["pick_number"])] = +rest
    votes = defaultdict(Counter)
    for s, ps in picks_by_seat.items():
        for p in ps:
            if p["pack_number"] != pack_number or p["pick_number"] == 1:
                continue
            seen = Counter(p["pack"])
            for u in picks_by_seat:
                if u != s and after.get((u, p["pick_number"] - 1)) == seen:
                    votes[s][u] += 1
    return {s: v.most_common(1)[0][0] for s, v in votes.items() if v}


def score_run(run_dir, quiet: bool = False):
    run_dir = Path(run_dir)
    ev = read_events(run_dir)
    dp = ev.get("draft_pick") or []
    per_seat = Counter(p["seat"] for p in dp)
    first = [p for p in dp if p["pick_number"] == 1]
    if not dp or not first or min(per_seat.values()) < 3 * max(len(p["pack"]) for p in first):
        if not quiet:
            print(f"skip {run_dir.name}: no complete draft")
        return None
    start = ev["event_start"][0]
    set_code = start["set"]["code"]
    seats_meta = {s["name"]: s for s in start["seats"]}
    picks_by_seat = defaultdict(list)
    rarity_hints = {}
    ppp = max(len(p["pack"]) for p in ev["draft_pick"] if p["pick_number"] == 1)
    for p in ev["draft_pick"]:
        if "overall_pick" not in p:  # older logs
            p["overall_pick"] = (p["pack_number"] - 1) * ppp + p["pick_number"]
        picks_by_seat[p["seat"]].append(p)
        for n, rr in zip(p["pack"], p.get("pack_rarities") or []):
            rarity_hints.setdefault(n, rr)
    for s in picks_by_seat:
        picks_by_seat[s].sort(key=lambda p: p["overall_pick"])
    decks = {d["seat"]: d for d in ev.get("deck_built", [])}

    model = Model.load(set_code)
    names = list(model.d["intercepts"].keys())
    extra = sorted({n for ps in picks_by_seat.values() for p in ps for n in p["pack"]} - set(names))
    names += extra
    ctx = build_context(set_code, names, rarity_hints, lam=model.lam)
    C = len(names)
    l17 = json.load(open(config.sets_dir() / set_code / "17lands.json"))["cards"]
    naive_gih = lambda n: (l17.get(n) or {}).get("gih_wr")

    # one row per pick of every seat
    rows = []
    for s, ps in picks_by_seat.items():
        pool = np.zeros(C, np.int8)
        for p in ps:
            pack = np.zeros(C, np.int8)
            for n in p["pack"]:
                pack[ctx.index[n]] += 1
            rows.append((s, p, pack, pool.copy()))
            pool[ctx.index[p["pick"]]] += 1
    total_picks = max(p["overall_pick"] for p in ev["draft_pick"])
    pack_arr = np.stack([x[2] for x in rows])
    pool_arr = np.stack([x[3] for x in rows])
    t = np.array([(x[1]["overall_pick"] - 1) / max(total_picks - 1, 1) for x in rows], np.float32)
    cand, mask, X, aux = featurize(ctx, pack_arr, pool_arr, t)
    U = model.utilities(X, cand, ctx)
    U = np.where(mask, U, -np.inf)
    P = np.exp(U - U.max(1, keepdims=True))
    P = P / P.sum(1, keepdims=True)
    pick_idx = np.array([ctx.index[x[1]["pick"]] for x in rows])
    y = np.argmax(cand == pick_idx[:, None], 1)
    order = np.argsort(-U, 1)
    rank = np.argmax(order == y[:, None], 1)
    ctx_wr = np.where(mask, aux["ctx_wr"], -np.inf)
    V = np.where(mask, model.value_utilities(X), -np.inf)
    v_order = np.argsort(-V, 1)
    v_rank = np.argmax(v_order == y[:, None], 1)

    # final lane per seat (from the full pool), used for bots and as a proxy for agents
    final_pool = {}
    for s, ps in picks_by_seat.items():
        v = np.zeros(C, np.int8)
        for p in ps:
            v[ctx.index[p["pick"]]] += 1
        final_pool[s] = v
    seat_list = list(picks_by_seat)
    W_final = dict(zip(seat_list, lane_weights(ctx, np.stack([final_pool[s] for s in seat_list]))))

    # signals: color quality flowing to each seat in pack 1 picks 4-9, vs the pod at the same picks
    q = np.maximum(0.0, ctx.gih - np.median(ctx.repl)) / 0.03
    q[ctx.basic] = 0
    col_share = np.zeros((C, 5), np.float32)
    for i, cs in enumerate(ctx.colors):
        hard = [c for c in COLORS if ctx.pips[i, COLORS.index(c)] > 0] or list(cs)
        for c in hard:
            col_share[i, COLORS.index(c)] = 1.0 / len(hard)
    flow = {}
    for s, ps in picks_by_seat.items():
        f = np.zeros(5)
        for p in ps:
            if p["pack_number"] == 1 and p["pick_number"] in SIGNAL_PICKS:
                for n in p["pack"]:
                    i = ctx.index[n]
                    f += q[i] * col_share[i]
        flow[s] = f
    pod_mean = np.mean(list(flow.values()), 0)
    pod_sd = np.std(list(flow.values()), 0) + 1e-6
    upstream = {k: infer_upstream(picks_by_seat, k) for k in (1, 2, 3)}

    out_seats = {}
    by_seat_rows = defaultdict(list)
    for i, (s, p, _, _) in enumerate(rows):
        by_seat_rows[s].append(i)
    for s in picks_by_seat:
        ids = by_seat_rows[s]
        ps = picks_by_seat[s]
        meta = seats_meta.get(s, {})
        deck = decks.get(s)
        wf = W_final[s]
        lane = PAIRS[int(np.argmax(wf))]
        if deck:
            main_c, splash_c = deck_colors(deck["main"], set_code)
            final_cols = main_c or lane
            main_counts = Counter(deck["main"])
        else:
            main_c, splash_c, final_cols, main_counts = None, None, lane, None
        # lane used for "was a playable alternative available": the pool's leading pair, restricted to the deck's
        # main colors when a deck was submitted
        cand_pairs = [j for j, pp in enumerate(PAIRS) if (set(pp) <= set(final_cols) or set(final_cols) <= set(pp))] if final_cols else []
        jf = max(cand_pairs, key=lambda j: wf[j]) if cand_pairs else int(np.argmax(wf))
        final_set = set(final_cols)
        seen_copies = Counter()
        pick_out = []
        lanes_after = []
        for i, p in zip(ids, ps):
            k = mask[i].sum()
            ci = cand[i]
            pi = y[i]
            pick = p["pick"]
            m_top = int(order[i, 0])
            best_ctx = int(np.argmax(ctx_wr[i]))
            g_pack = [naive_gih(n) or 0 for n in p["pack"]]
            g_pick = naive_gih(pick)
            naive_best = p["pack"][int(np.argmax(g_pack))]
            meta_pick = card_meta(pick, set_code)
            cast_final = 1.0 if meta_pick.basic else (
                1.0 if (not meta_pick.pips and not meta_pick.hybrid) or (set(meta_pick.pips) <= final_set and all(set(h) & final_set for h in meta_pick.hybrid)) else 0.0)
            seen_copies[pick] += 1
            made = None if main_counts is None else bool(main_counts.get(pick, 0) >= seen_copies[pick])
            # playable alternative in the final colors (castable, above replacement in the final lane)
            alt_playable = any(ctx.cast[c, jf] >= 1 and not ctx.basic[c] and ctx.lar[c, jf] > 0 for c in ci[mask[i]])
            wasted = bool((cast_final < 1 or meta_pick.basic) and alt_playable)
            unplayed_alt = None if made is None else bool((not made) and alt_playable)
            pool_after = pool_arr[i].copy()
            pool_after[pick_idx[i]] += 1
            lanes_after.append(pool_after)
            pick_out.append({
                "overall_pick": p["overall_pick"], "pack_number": p["pack_number"], "pick_number": p["pick_number"],
                "pick": pick, "by": p.get("by"), "n_options": int(k),
                "p_pick": r(P[i, pi]), "logp": r(np.log(max(P[i, pi], 1e-12))), "rank": int(rank[i]) + 1,
                "model_top": names[ci[m_top]], "p_model_top": r(P[i, m_top]),
                "regret_model_logit": r(U[i, m_top] - U[i, pi]),
                "value_top": names[ci[int(v_order[i, 0])]], "value_rank": int(v_rank[i]) + 1,
                "regret_value_logit": r(V[i, int(v_order[i, 0])] - V[i, pi]),
                "ctx_wr_pick": r(aux["ctx_wr"][i, pi]), "ctx_best": names[ci[best_ctx]],
                "regret_ctx_wr_pts": r(100 * (ctx_wr[i, best_ctx] - aux["ctx_wr"][i, pi]), 2),
                "regret_ctx_wr_pts_vs_model_top": r(100 * (aux["ctx_wr"][i, m_top] - aux["ctx_wr"][i, pi]), 2),
                "gih_pick": r(g_pick), "naive_best": naive_best,
                "naive_regret_gih_pts": r(100 * (max(g_pack) - g_pick), 2) if g_pick is not None else None,
                "in_final_colors": bool(cast_final >= 1),
                "made_deck": made, "wasted": wasted, "unplayed_with_alternative": unplayed_alt,
                "lane_before": PAIRS[int(np.argmax(aux["w"][i]))], "lane_conf_before": r(float(np.max(aux["w"][i])), 3),
                "note": p.get("note"),
            })
        # commitment: first pick after which the leading lane (from the pool) equals the final lane for good
        La = lane_weights(ctx, np.stack(lanes_after))
        lead = [PAIRS[int(j)] for j in La.argmax(1)]
        commit = None
        for j in range(len(lead)):
            if all(x == lane for x in lead[j:]):
                commit = ps[j]["overall_pick"]
                break
        # color-level commitment: top-2 colors of the pool settle
        S = La @ np.array([[1.0 if c in pp else 0.0 for c in COLORS] for pp in PAIRS])
        top2 = ["".join(sorted(np.array(list(COLORS))[np.argsort(-row)[:2]], key=COLORS.index)) for row in S]
        commit_cols = None
        for j in range(len(top2)):
            if all(x == top2[-1] for x in top2[j:]):
                commit_cols = ps[j]["overall_pick"]
                break

        open_z = (flow[s] - pod_mean) / pod_sd
        open_rank = [COLORS[j] for j in np.argsort(-open_z)]
        fc = [c for c in final_cols if c in COLORS]
        signal = {
            "definition": "color quality (sum of max(0, GIH - replacement)/3pp over cards, split across a card's colors) "
                          "in the packs this seat saw at pack 1 picks 4-9, z-scored against the pod's seats at the same picks",
            "flow_z": {c: r(open_z[j], 3) for j, c in enumerate(COLORS)},
            "most_open": "".join(sorted(open_rank[:2], key=COLORS.index)),
            "final_colors": final_cols,
            "alignment": r(float(np.mean([open_z[COLORS.index(c)] for c in fc])) if fc else None, 3),
            "overlap_with_top2_open": len(set(fc) & set(open_rank[:2])),
        }
        up1 = upstream[1].get(s)
        if up1:
            ucnt = Counter()
            for p in picks_by_seat[up1]:
                if p["pack_number"] == 1:
                    for c in card_meta(p["pick"], set_code).pips:
                        ucnt[c] += 1
            ucols = wubrg("".join(c for c, _ in ucnt.most_common(2)))
            signal["upstream_pack1"] = {"seat": up1, "kind": seats_meta.get(up1, {}).get("kind"), "top_colors_taken": ucols,
                                        "final_colors_shared": len(set(ucols) & set(fc))}

        def agg(sel_picks):
            if not sel_picks:
                return None
            arr = lambda k: [x[k] for x in sel_picks if x[k] is not None]
            return {
                "n": len(sel_picks),
                "mean_logp": r(np.mean(arr("logp"))),
                "mean_logp_floored": r(np.mean(np.maximum(arr("logp"), np.log(0.01)))),
                "median_p_pick": r(np.median(arr("p_pick"))),
                "flagged_rate": r(np.mean([x["p_pick"] < 0.05 for x in sel_picks])),
                "basic_land_picks": sum(1 for x in sel_picks if canon_basic(x["pick"])),
                "top1_agree": r(np.mean([x["rank"] == 1 for x in sel_picks])),
                "top3_agree": r(np.mean([x["rank"] <= 3 for x in sel_picks])),
                "mean_regret_model_logit": r(np.mean(arr("regret_model_logit"))),
                "mean_regret_value_logit": r(np.mean(arr("regret_value_logit"))),
                "value_top1_agree": r(np.mean([x["value_rank"] == 1 for x in sel_picks])),
                "mean_regret_ctx_wr_pts": r(np.mean(arr("regret_ctx_wr_pts")), 3),
                "mean_naive_regret_gih_pts": r(np.mean(arr("naive_regret_gih_pts")), 3) if arr("naive_regret_gih_pts") else None,
                "naive_top1_agree": r(np.mean([x["pick"] == x["naive_best"] for x in sel_picks])),
                "wasted_rate": r(np.mean([x["wasted"] for x in sel_picks])),
                "unplayed_with_alternative_rate": (r(np.mean([x["unplayed_with_alternative"] for x in sel_picks]))
                                                   if sel_picks[0]["unplayed_with_alternative"] is not None else None),
                "in_final_colors_rate": r(np.mean([x["in_final_colors"] for x in sel_picks])),
            }

        phases = {}
        for pk in (1, 2, 3):
            for lab, lo, hi in (("early", 1, 5), ("mid", 6, 9), ("late", 10, 99)):
                phases[f"p{pk}_{lab}"] = agg([x for x in pick_out if x["pack_number"] == pk and lo <= x["pick_number"] <= hi])
        made = [x["made_deck"] for x in pick_out if x["made_deck"] is not None]
        rand_logp = float(np.mean([-np.log(x["n_options"]) for x in pick_out]))
        out_seats[s] = {
            "kind": meta.get("kind"), "harness": meta.get("harness"), "model": meta.get("model"),
            "position": meta.get("position"),
            "summary": {
                **agg(pick_out),
                "random_mean_logp": r(rand_logp),
                "made_deck_rate": r(np.mean(made)) if made else None,
                "final_lane_from_pool": lane, "deck_main_colors": main_c, "deck_splash": splash_c,
                "commitment_pick_lane": commit, "commitment_pick_colors": commit_cols,
                "signal": signal,
            },
            "by_phase": phases,
            "picks": pick_out,
        }

    val = {}
    try:
        vj = json.load(open(config.results_dir() / f"validation-{set_code}.json"))
        val = {k: vj["results"][k] and {kk: vj["results"][k][kk] for kk in ("top1", "top3", "nll")}
               for k in ("model_context_plus_card", "gih_overall", "gih_archetype_aware")}
    except Exception:
        pass
    out = {
        "schema": SCHEMA,
        "event_id": start.get("id", run_dir.name), "set": set_code,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "knowledge": (start.get("knowledge") or {}).get("level") if isinstance(start.get("knowledge"), dict) else start.get("knowledge"),
        "model": {"file": f"analysis/models/{set_code}.json", "kind": model.d["kind"], "lambda": model.lam,
                  "expert_definition": model.d["expert_definition"], "holdout_validation": val,
                  "unrated_cards_in_event": extra},
        "definitions": {
            "p_pick": "expert-model probability of the card actually picked (conditional logit over the pack, given pool and pick number)",
            "regret_model_logit": "expert-model utility of its top card minus the pick's (0 = agreed). Behavioral: includes human habits such as rare-drafting",
            "regret_value_logit": "same with the value model (ratings + pool context only; no ATA, rarity or card intercepts): context-aware EV regret in model-value units",
            "regret_ctx_wr_pts": "archetype-aware GIH regret in win-rate points: max over the pack of ctx_wr minus ctx_wr of the pick, "
                                 "where ctx_wr = sum over color pairs of lane weight (from the pool so far) x lane value (archetype GIH if castable, replacement level if not)",
            "naive_regret_gih_pts": "max overall 17Lands GIH WR in the pack minus the pick's (scripts/compare-events.py definition)",
            "in_final_colors": "pick castable in the seat's final main colors (deck main colors for agents; leading color pair of the final pool for bots)",
            "made_deck": "the pick (this copy) is in the submitted main deck (agents only)",
            "wasted": "pick not castable in the final colors (or a basic land) while the pack offered a castable, above-replacement card in the final lane (same definition for agents and bots)",
            "unplayed_with_alternative": "agents only: pick not in the main deck while the pack offered a castable, above-replacement card in the final lane",
            "commitment_pick_lane": "first overall pick after which the pool's leading color pair never changes again",
            "mean_logp_floored": "mean log p_pick with each pick floored at log(0.01), so one absurd pick (e.g. a basic land) cannot dominate",
            "flagged_rate": "share of picks the expert model gave < 5% probability",
            "signal.alignment": "mean flow z-score of the seat's final colors (positive = settled into colors that flowed to it)",
        },
        "seats": out_seats,
    }
    with open(run_dir / "draft-eval.json", "w") as fh:
        json.dump(out, fh, indent=1, ensure_ascii=False)
    if not quiet:
        print(f"{run_dir.name} [{set_code}]")
        for s, v in out_seats.items():
            sm = v["summary"]
            print(f"  {s:10s} {str(v['kind']):5s} logp {sm['mean_logp']:6.3f} (rand {sm['random_mean_logp']:6.3f}) top1 {sm['top1_agree']:.2f} "
                  f"ctxReg {sm['mean_regret_ctx_wr_pts']:5.2f} naiveReg {sm['mean_naive_regret_gih_pts'] or 0:5.2f} "
                  f"waste {sm['wasted_rate']:.2f} lane {sm['final_lane_from_pool']} deck {sm['deck_main_colors']} commit {sm['commitment_pick_lane']} "
                  f"signal {sm['signal']['alignment']}")
    return out


def batch(runs_dir=None, extra=()):
    runs_dir = Path(runs_dir) if runs_dir else config.repo() / "runs"
    dirs = sorted(p for p in runs_dir.iterdir() if (p / "events.jsonl").exists()) + [Path(e) for e in extra]
    summary = []
    for d in dirs:
        try:
            out = score_run(d)
        except FileNotFoundError as e:
            print(f"skip {d.name}: {e}")
            continue
        if not out:
            continue
        for s, v in out["seats"].items():
            sm = {k: v2 for k, v2 in v["summary"].items() if k != "signal"}
            summary.append({"event": out["event_id"], "set": out["set"], "seat": s, "kind": v["kind"], "model": v["model"],
                            **sm, "signal_alignment": v["summary"]["signal"]["alignment"],
                            "signal_overlap_top2": v["summary"]["signal"]["overlap_with_top2_open"]})
    out = config.results_dir() / "agent-draft-scores.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w") as fh:
        json.dump({"generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                   "note": "seat-level summaries of runs/*/draft-eval.json (+ any extra runs passed on the command line)",
                   "rows": summary}, fh, indent=1)
    print(f"wrote {out}")
    return summary
