"""CLI: uv run python -m draft_eval <command> ...

  prepare   [SETS...]                 convert 17Lands CSV.gz -> parquet cache
  archetypes [SETS...]                write sets/<SET>/17lands-archetypes.json
  train     [SETS...] [--max-drafts N] train the expert pick model, write analysis/models/<SET>.json
                                      and analysis/results/validation-<SET>.json
  score     RUN_DIR [RUN_DIR...]      write <run>/draft-eval.json
  batch     [--runs DIR] [--include-smoke]  score every run with draft picks
  buildeval [SETS...]                 deck-quality validation + sets/<SET>/deck-norms.json (needs archetypes first)
  pipeline  SETS... [--json OUT] [--drop-cache]
                                      prepare -> archetypes -> train -> buildeval per set, skipping any output
                                      below the set-level thresholds in config.py; writes a per-set status JSON
                                      (used by scripts/deps.py). --drop-cache deletes the set's parquet files after.

With no SETS, commands use every set with a 17Lands snapshot in deps/manifest.json.
"""
from __future__ import annotations

import argparse
import sys
import time

from . import config


def main(argv=None):
    ap = argparse.ArgumentParser(prog="draft_eval")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("prepare"); p.add_argument("sets", nargs="*"); p.add_argument("--force", action="store_true")
    p = sub.add_parser("archetypes"); p.add_argument("sets", nargs="*")
    p = sub.add_parser("train"); p.add_argument("sets", nargs="*")
    p.add_argument("--max-drafts", type=int, default=8000)
    p.add_argument("--seed", type=int, default=0)
    p = sub.add_parser("score"); p.add_argument("runs", nargs="+")
    p = sub.add_parser("buildeval"); p.add_argument("sets", nargs="*")
    p = sub.add_parser("batch"); p.add_argument("--runs", default=None); p.add_argument("--extra", nargs="*", default=[])
    p = sub.add_parser("pipeline"); p.add_argument("sets", nargs="+"); p.add_argument("--json", default=None)
    p.add_argument("--drop-cache", action="store_true"); p.add_argument("--max-drafts", type=int, default=8000)
    p.add_argument("--steps", default="archetypes,model,norms")
    a = ap.parse_args(argv)
    sets = [s.upper() for s in getattr(a, "sets", [])] or config.SETS

    if a.cmd == "prepare":
        from .prepare import ensure_parquet
        for s in sets:
            for k in ("draft", "game"):
                t = time.time(); ensure_parquet(k, s, force=a.force); print(k, s, f"{time.time()-t:.1f}s")
    elif a.cmd == "archetypes":
        from .archetypes import build
        for s in sets:
            t = time.time(); out = build(s); print(s, out["games"], "games", out["shrinkage"], f"{time.time()-t:.1f}s")
    elif a.cmd == "train":
        from .model import train_set
        for s in sets:
            train_set(s, max_drafts=a.max_drafts, seed=a.seed)
    elif a.cmd == "score":
        from .score import score_run
        for r in a.runs:
            score_run(r)
    elif a.cmd == "buildeval":
        from .build_eval import run, summary
        for s in sets:
            t = time.time(); r = run(s)["validation"]
            print(s, {k: r[k] for k in ("archetype_weight", "auc_model", "auc_quality", "auc_overall_gih", "auc_quality_with_pair_base", "deck_pearson", "slope_adj_logit_per_pp", "pair_base_adj_logit_per_pp", "verdict")}, f"{time.time()-t:.0f}s", flush=True)
        summary()
    elif a.cmd == "pipeline":
        from .pipeline import run_sets
        return run_sets(sets, a.json, a.drop_cache, a.max_drafts, a.steps.split(","))
    elif a.cmd == "batch":
        from .score import batch
        batch(a.runs, a.extra)


if __name__ == "__main__":
    sys.exit(main())
