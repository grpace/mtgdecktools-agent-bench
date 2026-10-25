"""Print markdown tables: model validation per set, and seat-level draft scores across runs."""
from __future__ import annotations

import json
import statistics as st
from collections import defaultdict

from . import config

ORDER = ["random", "gih_overall", "ata", "gih_archetype_aware", "ablation_card_no_context", "model_value",
         "model_context", "model_context_plus_card"]


def validation_table() -> str:
    lines = ["| set | expert drafts (used/avail/all) | holdout picks | " + " | ".join(ORDER) + " |",
             "|---|---|---|" + "---|" * len(ORDER)]
    for s in config.SETS:
        p = config.results_dir() / f"validation-{s}.json"
        if not p.exists():
            continue
        v = json.load(open(p))
        cells = []
        for k in ORDER:
            r = v["results"].get(k)
            cells.append(f"{r['top1']:.3f} / {r['top3']:.3f} / {r['nll']:.3f}" if r else "-")
        lines.append(f"| {s} | {v['drafts_used']}/{v['expert_drafts_available']}/{v['drafts_in_file']} | {v['holdout_picks']} | " + " | ".join(cells) + " |")
    return "\n".join(lines)


def phase_table(set_code: str = "FRA") -> str:
    v = json.load(open(config.results_dir() / f"validation-{set_code}.json"))
    lines = ["| model | " + " | ".join(["picks01-05", "picks06-09", "picks10+"]) + " |", "|---|---|---|---|"]
    for k in ORDER:
        r = v["results"].get(k)
        if not r:
            continue
        b = r["by"]["phase"]
        lines.append(f"| {k} | " + " | ".join(f"{b[p]['top1']:.3f} / {b[p]['nll']:.3f}" for p in ["picks01-05", "picks06-09", "picks10+"]) + " |")
    return "\n".join(lines)


def seat_table() -> str:
    rows = json.load(open(config.results_dir() / "agent-draft-scores.json"))["rows"]
    cols = ["mean_logp", "mean_logp_floored", "top1_agree", "top3_agree", "value_top1_agree", "mean_regret_value_logit",
            "mean_regret_ctx_wr_pts", "mean_naive_regret_gih_pts", "naive_top1_agree", "wasted_rate", "unplayed_with_alternative_rate", "in_final_colors_rate",
            "commitment_pick_lane", "signal_alignment"]
    out = ["| event | seat | " + " | ".join(cols) + " |", "|---|---|" + "---|" * len(cols)]
    for r in rows:
        if r["kind"] == "bot":
            continue
        out.append(f"| {r['event']} | {r['seat']} | " + " | ".join("-" if r.get(c) is None else f"{r[c]}" for c in cols) + " |")
    g = defaultdict(list)
    for r in rows:
        key = "bots" if r["kind"] == "bot" else ("random (scripted)" if r["seat"].startswith("rand") else r["seat"].split("-")[0])
        g[key].append(r)
    out += ["", "| group | seats | " + " | ".join(cols[:-2]) + " | signal_alignment |", "|---|---|" + "---|" * (len(cols) - 1)]
    for k, v in g.items():
        def m(c):
            xs = [x[c] for x in v if x.get(c) is not None]
            return f"{st.mean(xs):.3f}" if xs else "-"
        out.append(f"| {k} | {len(v)} | " + " | ".join(m(c) for c in cols[:-2]) + f" | {m('signal_alignment')} |")
    return "\n".join(out)


def main():
    print("## Validation (top1 / top3 / NLL on held-out expert drafts)\n")
    print(validation_table())
    print("\n## FRA by pick phase (top1 / NLL)\n")
    print(phase_table("FRA"))
    print("\n## Seat scores\n")
    print(seat_table())


if __name__ == "__main__":
    main()
