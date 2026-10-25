#!/usr/bin/env python3
"""Recompute a leaderboard's ratings from the open data (docs/OPEN-DATA.md, "Reproduce the leaderboard").

Standard library only. Point it at an unzipped snapshot (or the served `tables/` folder's parent):

    python3 reproduce_leaderboard.py --data agent-bench-data-2026-10-22            # the main board
    python3 reproduce_leaderboard.py --data DIR --board 'kn=primer;mana=manual;prompt=sha256:abc|*|all'
    python3 reproduce_leaderboard.py --data DIR --compare                          # diff against tables/ratings

The model is the one in docs/METHODOLOGY.md §4 and packages/site/src/rating.ts: Bradley-Terry on rated games
(games.rated), a maximum a posteriori fit with a N(0, prior_sd_elo) prior on every setup's rating and a
N(0, play_prior_sd_elo) prior on the play advantage, which enters only game 1 of each match (games.on_play_random).
Ratings are on an Elo scale (400 / ln 10 Elo per logit), each connected group centered on its unweighted mean at
`center` (1500). It reproduces the point estimates; the intervals also need the bootstrap (boards.seed, clusters).
"""
import argparse
import csv
import gzip
import json
import math
import sys
from pathlib import Path

ELO_PER_LOGIT = 400 / math.log(10)


def read_table(data: Path, name: str):
    """Rows of tables/<name>.csv.gz as dicts (empty cells: None)."""
    path = data / "tables" / f"{name}.csv.gz"
    with gzip.open(path, "rt", encoding="utf-8", newline="") as f:
        return [{k: (v if v != "" else None) for k, v in row.items()} for row in csv.DictReader(f)]


def truthy(v) -> bool:
    return v == "true"


def solve(a, b):
    """Gaussian elimination with partial pivoting (the system is small and positive definite)."""
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(m[r][c]))
        m[c], m[p] = m[p], m[c]
        for r in range(c + 1, n):
            f = m[r][c] / m[c][c]
            if f:
                for k in range(c, n + 1):
                    m[r][k] -= f * m[c][k]
    x = [0.0] * n
    for r in range(n - 1, -1, -1):
        x[r] = (m[r][n] - sum(m[r][k] * x[k] for k in range(r + 1, n))) / m[r][r]
    return x


def fit(games, prior_sd_elo: float, play_prior_sd_elo: float, center: float):
    """MAP Bradley-Terry with a play term; returns {identity: rating}."""
    ids = sorted({g["a"] for g in games} | {g["b"] for g in games})
    idx = {k: i for i, k in enumerate(ids)}
    use_play = any(g["s"] for g in games)
    dim = len(ids) + (1 if use_play else 0)
    tau2 = [(prior_sd_elo / ELO_PER_LOGIT) ** 2] * len(ids) + ([(play_prior_sd_elo / ELO_PER_LOGIT) ** 2] if use_play else [])
    p = [0.0] * dim
    for _ in range(100):
        grad = [-p[k] / tau2[k] for k in range(dim)]
        hess = [[(1 / tau2[k]) if k == j else 0.0 for j in range(dim)] for k in range(dim)]
        for g in games:
            cols = [(idx[g["a"]], 1.0), (idx[g["b"]], -1.0)] + ([(dim - 1, float(g["s"]))] if use_play and g["s"] else [])
            eta = sum(p[c] * v for c, v in cols)
            pr = 1 / (1 + math.exp(-eta))
            r, w = g["y"] - pr, pr * (1 - pr)
            for c, v in cols:
                grad[c] += r * v
                for c2, v2 in cols:
                    hess[c][c2] += w * v * v2
        step = solve(hess, grad)
        p = [p[k] + step[k] for k in range(dim)]
        if max(abs(s) for s in step) < 1e-9:
            break
    # Connected groups (setups linked through games), each centered on its unweighted mean.
    parent = {k: k for k in ids}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for g in games:
        parent[find(g["a"])] = find(g["b"])
    groups = {}
    for k in ids:
        groups.setdefault(find(k), []).append(k)
    out = {}
    for members in groups.values():
        mean = sum(p[idx[k]] for k in members) / len(members)
        for k in members:
            out[k] = center + (p[idx[k]] - mean) * ELO_PER_LOGIT
    play = p[dim - 1] * ELO_PER_LOGIT if use_play else None
    return out, play


def board_games(data: Path, board):
    """The rated games behind a board: its comparability group, set and table provenance."""
    events = {e["event_id"]: e for e in read_table(data, "events")}
    out = []
    for g in read_table(data, "games"):
        if not truthy(g["rated"]) or g["rating_group"] != board["group_key"]:
            continue
        ev = events.get(g["event_id"], {})
        if board["set_code"] != "*" and ev.get("set_code") != board["set_code"]:
            continue
        if board["provenance"] not in (None, "all") and ev.get("provenance") != board["provenance"]:
            continue
        s = 0
        if truthy(g["on_play_random"]):
            s = 1 if g["on_play"] == g["seat_a"] else -1 if g["on_play"] == g["seat_b"] else 0
        out.append({"a": g["identity_a"], "b": g["identity_b"], "y": 1.0 if g["winner"] == g["seat_a"] else 0.0, "s": s})
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--data", required=True, help="folder holding tables/ (an unzipped snapshot)")
    ap.add_argument("--board", help="board_id (default: the main board)")
    ap.add_argument("--compare", action="store_true", help="compare with tables/ratings and fail beyond --tolerance Elo")
    ap.add_argument("--tolerance", type=float, default=0.5)
    a = ap.parse_args(argv)
    data = Path(a.data)
    boards = read_table(data, "boards")
    board = next((b for b in boards if (b["board_id"] == a.board if a.board else b["role"] == "main")), None)
    if board is None:
        print(json.dumps({"error": "no such board" if a.board else "no main board yet (no rated games)"}))
        return 1 if a.board else 0
    games = board_games(data, board)
    ratings, play = fit(games, float(board["prior_sd_elo"]), float(board["play_prior_sd_elo"]), float(board["center"]))
    result = {"board_id": board["board_id"], "games": len(games), "play_advantage": play,
              "ratings": {k: round(v, 2) for k, v in sorted(ratings.items(), key=lambda kv: -kv[1])}}
    if a.compare:
        published = {r["identity"]: float(r["rating"]) for r in read_table(data, "ratings") if r["board_id"] == board["board_id"] and r["rating"] is not None}
        diffs = {k: round(ratings.get(k, float("nan")) - v, 3) for k, v in published.items()}
        result["published_games"] = int(board["games"])
        result["max_abs_diff_elo"] = max((abs(d) for d in diffs.values()), default=0.0)
        result["ok"] = len(games) == int(board["games"]) and set(published) == set(ratings) and result["max_abs_diff_elo"] <= a.tolerance
        print(json.dumps(result, indent=1))
        return 0 if result["ok"] else 1
    print(json.dumps(result, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
