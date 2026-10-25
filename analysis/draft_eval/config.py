"""Paths. Everything is configurable via environment variables or CLI flags.

  DRAFT_EVAL_REPO     repo root (default: parent of analysis/)
  DRAFT_EVAL_DATA     data dir (default: <repo>/data)          -- gitignored
  DRAFT_EVAL_17L      17Lands CSV dir (default: <data>/17lands)
  DRAFT_EVAL_CACHE    parquet cache (default: <17l>/parquet)
  DRAFT_EVAL_SETS     sets dir (default: <repo>/sets)
  DRAFT_EVAL_MODELS   model dir (default: <repo>/analysis/models) -- small JSON models, committed
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

_HERE = Path(__file__).resolve().parent


def repo() -> Path:
    return Path(os.environ.get("DRAFT_EVAL_REPO", _HERE.parent.parent))


def data_dir() -> Path:
    return Path(os.environ.get("DRAFT_EVAL_DATA", repo() / "data"))


def l17_dir() -> Path:
    return Path(os.environ.get("DRAFT_EVAL_17L", data_dir() / "17lands"))


def cache_dir() -> Path:
    return Path(os.environ.get("DRAFT_EVAL_CACHE", l17_dir() / "parquet"))


def sets_dir() -> Path:
    return Path(os.environ.get("DRAFT_EVAL_SETS", repo() / "sets"))


def models_dir() -> Path:
    return Path(os.environ.get("DRAFT_EVAL_MODELS", repo() / "analysis" / "models"))


def results_dir() -> Path:
    return repo() / "analysis" / "results"


FORMAT = "PremierDraft"  # default; a set's own format comes from source() below

# Set-level thresholds: below them a set's output would be statistically meaningless, so it is skipped and the
# skip is recorded in deps/manifest.json (scripts/deps.py). Per-card / per-cell thresholds live in the builders.
MIN_GAMES_ARCHETYPES = 20_000   # game rows for 17lands-archetypes.json (and the deck norms built on it)
MIN_EXPERT_DRAFTS = 1_000       # expert drafts for the pick model (the smallest current set, TMT, has 6,997)
MIN_DECKS_BUILDEVAL = 5_000     # sane decks (38-45 cards) for the build-quality validation and deck norms


def manifest() -> dict:
    p = repo() / "deps" / "manifest.json"
    return json.loads(p.read_text()) if p.exists() else {}


def sets() -> list[str]:
    """Every set with a 17Lands snapshot in deps/manifest.json; else every sets/<SET>/17lands.json."""
    m = manifest().get("17lands", {}).get("sets")
    if m:
        return sorted(m)
    return sorted(p.parent.name for p in sets_dir().glob("*/17lands.json"))


def source(set_code: str) -> tuple[str, str]:
    """(17Lands code, format) of a set's raw files: from sets/<SET>/17lands.json, else the code itself."""
    p = sets_dir() / set_code.upper() / "17lands.json"
    if p.exists():
        with open(p) as fh:
            head = fh.read(4096)
        code = re.search(r'"source_code": "([^"]+)"', head)
        fmt = re.search(r'"format": "([^"]+)"', head)
        return (code.group(1) if code else set_code.upper(), fmt.group(1) if fmt else FORMAT)
    return set_code.upper(), FORMAT


def format_of(set_code: str) -> str:
    return source(set_code)[1]


SETS = sets()
