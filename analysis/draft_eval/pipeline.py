"""One set at a time: parquet cache -> archetype ratings -> expert pick model -> build-quality norms.

Each output is skipped (not written, old file removed) when the set is below the set-level thresholds in
config.py, and the reason is reported, so deps/manifest.json can say why a set has no model or norms. Used by
`npm run deps -- update 17lands` (scripts/deps.py); also runnable on its own:

    uv run python -m draft_eval pipeline FRA KHM --json /tmp/status.json
"""
from __future__ import annotations

import json
import time
import traceback

import polars as pl

from . import config
from .prepare import csv_path, ensure_parquet, parquet_path


class Skip(Exception):
    """The set is below a threshold for this output."""


def _remove(*paths) -> None:
    for p in paths:
        if p.exists():
            p.unlink()


def _archetypes(s: str) -> dict:
    from .archetypes import build
    cols = pl.read_parquet_schema(parquet_path("game", s))
    if "main_colors" not in cols:
        _remove(config.sets_dir() / s / "17lands-archetypes.json")
        raise Skip("older game file without main_colors/splash_colors: decks can't be put in color pairs")
    games = pl.scan_parquet(parquet_path("game", s)).select(pl.len()).collect().item()
    if games < config.MIN_GAMES_ARCHETYPES:
        _remove(config.sets_dir() / s / "17lands-archetypes.json")
        raise Skip(f"{games:,} game rows < {config.MIN_GAMES_ARCHETYPES:,}")
    out = build(s)
    return {"games": out["games"], "buckets": len(out["archetypes"]), "cards": len(out["cards"])}


def _model(s: str, max_drafts: int) -> dict:
    from .model import EXPERT_MIN_GAMES, EXPERT_MIN_WR, train_set
    outs = (config.models_dir() / f"{s}.json", config.results_dir() / f"validation-{s}.json")
    if not csv_path("draft", s).exists() and not parquet_path("draft", s).exists():
        _remove(*outs)
        raise Skip("no 17Lands draft data file")
    path = ensure_parquet("draft", s)
    cols = pl.read_parquet_schema(path)
    if "user_n_games_bucket" not in cols or "user_game_win_rate_bucket" not in cols:
        _remove(*outs)
        if "user_match_win_rate_bucket" in cols:
            raise Skip("older draft file: player skill is bucketed by match win rate, not game win rate, so the expert definition doesn't apply")
        raise Skip("draft data has no player-skill buckets (expert drafters can't be identified)")
    meta = pl.read_parquet(path, columns=["draft_id", "user_n_games_bucket", "user_game_win_rate_bucket"]).unique("draft_id")
    experts = meta.filter((pl.col("user_n_games_bucket") >= EXPERT_MIN_GAMES) & (pl.col("user_game_win_rate_bucket") >= EXPERT_MIN_WR)).height
    if experts < config.MIN_EXPERT_DRAFTS:
        _remove(*outs)
        raise Skip(f"{experts:,} expert drafts < {config.MIN_EXPERT_DRAFTS:,}")
    val = train_set(s, max_drafts=max_drafts)
    r = val["results"]["model_context_plus_card"]
    return {"expert_drafts": experts, "drafts_in_file": meta.height, "holdout_top1": r["top1"], "holdout_nll": r["nll"],
            "gih_overall_top1": val["results"]["gih_overall"]["top1"]}


def _norms(s: str) -> dict:
    from .build_eval import run
    outs = (config.sets_dir() / s / "deck-norms.json", config.results_dir() / f"build-quality-{s}.json")
    if not (config.sets_dir() / s / "17lands-archetypes.json").exists():
        _remove(*outs)
        raise Skip("no archetype ratings")
    cols = pl.read_parquet_schema(parquet_path("game", s))
    missing = [c for c in ("on_play", "user_game_win_rate_bucket", "user_n_games_bucket") if c not in cols]
    if missing:
        _remove(*outs)
        raise Skip(f"game data lacks {', '.join(missing)} (needed to hold player skill fixed in the validation)")
    decks = (pl.scan_parquet(parquet_path("game", s)).select(["draft_id", "build_index"]).unique().select(pl.len()).collect().item())
    if decks < config.MIN_DECKS_BUILDEVAL:
        _remove(*outs)
        raise Skip(f"{decks:,} decks < {config.MIN_DECKS_BUILDEVAL:,}")
    v = run(s)["validation"]
    return {"verdict": v["verdict"], "auc_model": v["auc_model"], "auc_overall_gih": v["auc_overall_gih"], "games_eval": v["games_eval"]}


def run_sets(sets: list[str], json_out: str | None, drop_cache: bool, max_drafts: int, steps: list[str]) -> int:
    status: dict = {}
    failed = 0
    for s in sets:
        st: dict = {}
        t0 = time.time()
        try:
            for kind in ("game", "draft"):
                if csv_path(kind, s).exists() or parquet_path(kind, s).exists():
                    ensure_parquet(kind, s)
        except Exception as e:  # pragma: no cover - corrupt download etc.
            st["prepare"] = {"status": "failed", "error": repr(e)[:2000]}
        for step, fn in (("archetypes", lambda: _archetypes(s)), ("model", lambda: _model(s, max_drafts)), ("norms", lambda: _norms(s))):
            if step not in steps or "prepare" in st:
                continue
            t = time.time()
            try:
                info = fn()
                st[step] = {"status": "ok", **info, "seconds": round(time.time() - t)}
            except Skip as e:
                st[step] = {"status": "skipped", "reason": str(e)}
            except Exception as e:
                failed += 1
                traceback.print_exc()
                st[step] = {"status": "failed", "error": repr(e)[:2000]}
            print(f"[{s}] {step}: {st[step]}", flush=True)
        if drop_cache:
            _remove(parquet_path("game", s), parquet_path("draft", s))
        st["seconds"] = round(time.time() - t0)
        status[s] = st
        if json_out:
            with open(json_out, "w") as fh:
                json.dump(status, fh, indent=1)
    if "norms" in steps:
        from .build_eval import summary
        summary()
    return 1 if failed else 0
