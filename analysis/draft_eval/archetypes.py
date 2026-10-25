"""Archetype-conditional card ratings and deck-shape stats from 17Lands game data.

Output: sets/<SET>/17lands-archetypes.json (schema in analysis/README.md).

Buckets ("archetypes") come from the 17Lands `main_colors` column: the 10 color pairs, mono-color
decks (`W`..`G`), each 3-color combination with >= 1% of games, and `3c+` for the rest. Splashes
(`splash_colors`) are counted inside the main-color bucket and reported separately.

Per card x bucket we count GIH (opening hand or drawn), GP (in main deck) and GNS (in deck, never
seen) games and wins, then shrink each rate toward a card-specific prior with an empirical-Bayes
beta prior:

    prior_mean[c, b] = R_c - offset_c + base_b
        R_c      = the card's overall rate (itself shrunk toward the global baseline)
        base_b   = bucket baseline win rate (all games in bucket b)
        offset_c = sum_b n[c,b] * base_b / n_c   (the bucket mix the card's overall rate came from)
    posterior    = (wins + k * prior_mean) / (n + k)

so a card with few games in a bucket is assumed to perform like it does overall, adjusted for how
strong that bucket is. k is estimated per set and metric by the method of moments (between-cell
variance of raw - prior, after subtracting binomial noise).
"""
from __future__ import annotations

import datetime as dt
import json

import numpy as np
import polars as pl

from . import config
from .cards import COLORS, PAIRS, card_meta, wubrg
from .prepare import ensure_parquet

LICENSE_NOTE = (
    "Derived from 17Lands public datasets (17lands.com, CC BY 4.0 per the 17Lands public datasets page). "
    "Per-card and per-archetype aggregates computed by this project; not a 17Lands product and not endorsed "
    "by 17Lands. Credit 17Lands when you reuse it."
)
MIN_CELL_GP = 50      # cells with fewer raw GP games are omitted from the JSON (consumers fall back to the prior)
MIN_TRIPLE_SHARE = 0.01


def bucket_of(main: str | None, triples: set[str]) -> str:
    m = wubrg(main or "")
    if len(m) == 1:
        return m
    if len(m) == 2:
        return m
    if len(m) == 3 and m in triples:
        return m
    return "3c+"


def eb_k(wins: np.ndarray, n: np.ndarray, prior: np.ndarray, min_n: int = 100) -> float:
    """Method-of-moments pseudo-count for a beta prior centered on `prior`."""
    sel = n >= min_n
    if sel.sum() < 10:
        return 200.0
    raw = wins[sel] / n[sel]
    m = np.clip(prior[sel], 0.05, 0.95)
    resid2 = (raw - m) ** 2
    noise = m * (1 - m) / n[sel]
    tau2 = float(np.mean(resid2 - noise))
    if tau2 <= 1e-6:
        return 20000.0
    k = float(np.mean(m * (1 - m)) / tau2 - 1)
    return float(np.clip(k, 10, 20000))


def shrink(wins, n, prior, k):
    return (wins + k * prior) / (n + k)


def _rnd(x, d=4):
    return None if x is None or not np.isfinite(x) else round(float(x), d)


def build(set_code: str, write: bool = True, keep_drafts=None) -> dict:
    """`keep_drafts(draft_id) -> bool` restricts the games used (e.g. a training split for validation)."""
    path = ensure_parquet("game", set_code)
    schema = pl.read_parquet_schema(path)
    names = [c[len("deck_"):] for c in schema if c.startswith("deck_")]
    meta_cols = ["draft_id", "build_index", "main_colors", "splash_colors", "won"]
    df = pl.read_parquet(path, columns=meta_cols
                         + [f"deck_{n}" for n in names]
                         + [f"opening_hand_{n}" for n in names]
                         + [f"drawn_{n}" for n in names])
    if keep_drafts is not None:
        ids = df["draft_id"].unique().to_list()
        df = df.filter(pl.col("draft_id").is_in([d for d in ids if keep_drafts(d)]))
    G = df.height
    main = df["main_colors"].fill_null("").to_list()
    splash = df["splash_colors"].fill_null("").to_list()
    won = df["won"].cast(pl.Float32).to_numpy()

    trip_counts: dict[str, int] = {}
    for m in main:
        m = wubrg(m)
        if len(m) == 3:
            trip_counts[m] = trip_counts.get(m, 0) + 1
    triples = {t for t, c in trip_counts.items() if c / G >= MIN_TRIPLE_SHARE}
    rows_bucket = [bucket_of(m, triples) for m in main]
    buckets = PAIRS + list(COLORS) + sorted(triples) + ["3c+"]
    bidx = {b: i for i, b in enumerate(buckets)}
    bi = np.array([bidx[b] for b in rows_bucket])
    nb, C = len(buckets), len(names)
    B = np.zeros((G, nb), dtype=np.float32)
    B[np.arange(G), bi] = 1.0
    BW = B * won[:, None]

    deck = df.select([f"deck_{n}" for n in names]).to_numpy().astype(np.int16)
    oh = df.select([f"opening_hand_{n}" for n in names]).to_numpy()
    dr = df.select([f"drawn_{n}" for n in names]).to_numpy()
    gp = (deck > 0).astype(np.float32)
    gih = ((oh > 0) | (dr > 0)).astype(np.float32)
    del oh, dr
    gns = gp * (1 - gih)

    def agg(ind):
        return B.T @ ind, BW.T @ ind  # [nb, C] games, wins

    stats = {"gih": agg(gih), "gp": agg(gp), "gns": agg(gns)}
    base_n = B.sum(0)
    base_w = BW.sum(0)
    base_b = np.where(base_n > 0, base_w / np.maximum(base_n, 1), np.nan)
    global_base = float(won.mean())

    # splash usage per card: in deck while the card's colored pips are not all in main colors
    metas = [card_meta(n, set_code) for n in names]
    hard_cols = [set(m.pips) for m in metas]
    main_sets = [set(wubrg(m)) for m in main]
    # group rows by main colors for speed
    splash_n = np.zeros(C, np.float32)
    splash_w = np.zeros(C, np.float32)
    splash_gih_n = np.zeros(C, np.float32)
    splash_gih_w = np.zeros(C, np.float32)
    by_main: dict[str, list[int]] = {}
    for i, m in enumerate(main):
        by_main.setdefault(wubrg(m), []).append(i)
    for m, idx in by_main.items():
        ms = set(m)
        cols = np.array([bool(hc) and not hc <= ms for hc in hard_cols])
        if not cols.any():
            continue
        idx = np.array(idx)
        sub_gp = gp[idx][:, cols]
        sub_gih = gih[idx][:, cols]
        w = won[idx][:, None]
        splash_n[cols] += sub_gp.sum(0)
        splash_w[cols] += (sub_gp * w).sum(0)
        splash_gih_n[cols] += sub_gih.sum(0)
        splash_gih_w[cols] += (sub_gih * w).sum(0)

    out_metrics = {}
    ks = {}
    for metric, (n, w) in stats.items():
        n_c = n.sum(0)
        w_c = w.sum(0)
        # overall rate shrunk toward the global baseline
        k0 = eb_k(w_c[None], n_c[None], np.full((1, C), global_base))
        R = shrink(w_c, n_c, global_base, k0)
        off = np.where(n_c > 0, (n * base_b[:, None]).sum(0) / np.maximum(n_c, 1), global_base)
        prior = np.clip(R[None, :] - off[None, :] + base_b[:, None], 0.02, 0.98)
        k = eb_k(w, n, prior)
        post = shrink(w, n, prior, k)
        ks[metric] = {"overall_k": round(k0, 1), "archetype_k": round(k, 1)}
        out_metrics[metric] = dict(n=n, w=w, post=post, R=R, n_c=n_c, w_c=w_c, prior=prior)

    # deck-level stats
    is_land = np.array([m.land for m in metas])
    is_basic = np.array([m.basic for m in metas])
    is_crea = np.array([m.creature for m in metas])
    mv = np.array([m.mv for m in metas])
    deck_df = (df.select(["draft_id", "build_index", "won"]).with_row_index("row")
               .group_by(["draft_id", "build_index"], maintain_order=True)
               .agg(pl.col("row").first(), pl.len().alias("games"), pl.col("won").sum().alias("wins")))
    first_rows = deck_df["row"].to_numpy()
    dgames = deck_df["games"].to_numpy()
    dwins = deck_df["wins"].to_numpy()
    dk = deck[first_rows].astype(np.float32)
    dbucket = bi[first_rows]
    lands = dk @ is_land
    nonbasic = dk @ (is_land & ~is_basic)
    nonland = dk @ (~is_land)
    crea = dk @ (is_crea & ~is_land)
    mvb = np.clip(np.where(is_land, -1, np.floor(mv)), -1, 6)
    curve = np.stack([dk @ ((mvb >= 0) & (mvb <= 1)), *[dk @ (mvb == v) for v in (2, 3, 4, 5)], dk @ (mvb >= 6)], 1)
    avg_mv = (dk @ np.where(is_land, 0, mv)) / np.maximum(nonland, 1)
    total = dk.sum(1)
    sane = (total >= 38) & (total <= 45)

    def shape(sel):
        if sel.sum() == 0:
            return None
        q = lambda x: [_rnd(v, 2) for v in np.percentile(x[sel], [25, 50, 75])]
        return {
            "decks": int(sel.sum()),
            "games": int(dgames[sel].sum()),
            "win_rate": _rnd(dwins[sel].sum() / max(dgames[sel].sum(), 1)),
            "lands_p25_p50_p75": q(lands),
            "nonbasic_lands_mean": _rnd(nonbasic[sel].mean(), 2),
            "creatures_p25_p50_p75": q(crea),
            "noncreature_spells_p25_p50_p75": q(nonland - crea),
            "avg_mv_nonland_mean": _rnd(avg_mv[sel].mean(), 3),
            "curve_mean": dict(zip(["0-1", "2", "3", "4", "5", "6+"], [_rnd(v, 2) for v in curve[sel].mean(0)])),
        }

    def wr_by(x, bins, sel):
        res = {}
        for lab, lo, hi in bins:
            s = sel & (x >= lo) & (x <= hi)
            g = dgames[s].sum()
            if g >= 200:
                res[lab] = {"games": int(g), "win_rate": _rnd(dwins[s].sum() / g)}
        return res

    land_bins = [("<=15", 0, 15), ("16", 16, 16), ("17", 17, 17), ("18+", 18, 99)]
    crea_bins = [("<=11", 0, 11), ("12-13", 12, 13), ("14-15", 14, 15), ("16-17", 16, 17), ("18+", 18, 99)]
    winners_def = (dwins >= 6)

    arche = {}
    for b in buckets:
        i = bidx[b]
        sel_rows = bi == i
        if base_n[i] == 0:
            continue
        dsel = (dbucket == i) & sane
        arche[b] = {
            "games": int(base_n[i]),
            "share": _rnd(base_n[i] / G),
            "win_rate": _rnd(base_b[i]),
            "splash_share": _rnd(np.mean([bool(splash[j]) for j in np.flatnonzero(sel_rows)])),
            "deck_shape_all": shape(dsel),
            "deck_shape_winners": shape(dsel & winners_def),
            "win_rate_by_lands": wr_by(lands, land_bins, dsel),
            "win_rate_by_creatures": wr_by(crea, crea_bins, dsel),
        }

    cards = {}
    gm, pm, nm = out_metrics["gih"], out_metrics["gp"], out_metrics["gns"]
    for c, name in enumerate(names):
        meta = metas[c]
        by = {}
        for b in buckets:
            i = bidx[b]
            if pm["n"][i, c] < MIN_CELL_GP:
                continue
            by[b] = [
                _rnd(gm["post"][i, c]), int(gm["n"][i, c]),
                _rnd(pm["post"][i, c]), int(pm["n"][i, c]),
                _rnd(gm["post"][i, c] - nm["post"][i, c]),
                _rnd(gm["w"][i, c] / gm["n"][i, c]) if gm["n"][i, c] > 0 else None,
            ]
        cards[name] = {
            "colors": meta.colors,
            "mv": meta.mv,
            "type": "land" if meta.land else ("creature" if meta.creature else "spell"),
            "rarity": meta.rarity,
            "overall": {
                "gih_wr": _rnd(gm["R"][c]), "gih_games": int(gm["n_c"][c]),
                "gp_wr": _rnd(pm["R"][c]), "gp_games": int(pm["n_c"][c]),
                "iwd": _rnd(gm["R"][c] - nm["R"][c]),
            },
            "splash": ({"gp_games": int(splash_n[c]), "gp_wr_raw": _rnd(splash_w[c] / splash_n[c]),
                        "gih_games": int(splash_gih_n[c]),
                        "gih_wr_raw": _rnd(splash_gih_w[c] / splash_gih_n[c]) if splash_gih_n[c] else None}
                       if splash_n[c] >= 20 else None),
            "by_archetype": by,
        }

    out = {
        "set": set_code,
        "format": config.format_of(set_code),
        "source": "17Lands public game data (game_data_public.{}.{}.csv.gz)".format(*config.source(set_code)),
        "license_note": LICENSE_NOTE,
        "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "generator": "analysis/draft_eval/archetypes.py",
        "games": G,
        "baseline_win_rate": _rnd(global_base),
        "shrinkage": ks,
        "by_archetype_fields": ["gih_wr", "gih_games", "gp_wr", "gp_games", "iwd", "gih_wr_raw"],
        "notes": {
            "rates": "gih_wr/gp_wr/iwd are empirical-Bayes shrunk (see shrinkage.*.archetype_k pseudo-games); gih_wr_raw is unshrunk",
            "cells": f"a card x archetype cell is listed only if the card was in >= {MIN_CELL_GP} main decks of that archetype; otherwise use the prior: overall.gih_wr - (card's mix offset) + archetypes[b].win_rate, or simply overall.gih_wr + archetypes[b].win_rate - baseline_win_rate",
            "winners": "deck_shape_winners = decks with >= 6 recorded game wins (near-trophy in PremierDraft); decks = (draft_id, build_index), 38-45 cards",
            "buckets": "color pairs; mono colors; 3-color combos with >= 1% of games; 3c+ = the rest. Splashes count toward the main colors",
        },
        "archetypes": arche,
        "cards": cards,
    }
    if write:
        p = config.sets_dir() / set_code / "17lands-archetypes.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        write_compact(p, out)
    return out


def write_compact(path, out: dict) -> None:
    """Pretty top level, one line per card (keeps the file small and diffable)."""
    cards = out["cards"]
    head = {k: v for k, v in out.items() if k != "cards"}
    text = json.dumps(head, indent=1, ensure_ascii=False)[:-2]
    lines = [f" {json.dumps(n, ensure_ascii=False)}: {json.dumps(c, ensure_ascii=False, separators=(',', ':'))}"
             for n, c in sorted(cards.items())]
    with open(path, "w") as fh:
        fh.write(text + ',\n "cards": {\n' + ",\n".join(lines) + "\n }\n}\n")
