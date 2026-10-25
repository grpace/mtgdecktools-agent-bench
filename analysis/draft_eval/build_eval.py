"""Deckbuilding yardstick (METHODOLOGY §5.2): archetype expected-quality score, structural norms of winning
human decks, and validation of the score on held-out 17Lands games.

Outputs
  sets/<SET>/deck-norms.json                    compact per-pair norms + scoring parameters (read by packages/site)
  analysis/results/build-quality-<SET>.json     validation numbers for one set
  analysis/results/build-quality.md             summary table across sets
  analysis/results/noise-17lands.json           game-level noise estimates used by the rating calibration study

Expected-quality score of a deck in color bucket P (mirrors packages/site/src/build-quality.ts exactly):
  for every non-land card copy in the main deck
    - a colored pip with no source among the deck's lands -> the card is dead: value = repl[P]
      (repl = 10th percentile of the listed non-land cells of P)
    - listed cell (card was in >= 50 main decks of P): value = shrunk GIH WR in P - base[P] + baseline, i.e. the
      card's lift inside this archetype on the set's scale (splashed copies are counted in the bucket of the
      deck's main colors, so a splash card's cell is its splash performance)
    - otherwise the prior lift: overall GIH WR, plus splash_delta when the card needs a color outside P
      (splash_delta = games-weighted mean of splash GIH WR - overall GIH WR, per set)
  quality = mean value over the rated copies (fraction, like a GIH WR)
  The archetype's own base win rate is left out on purpose: on held-out games it adds nothing once card lifts
  are known (it mostly reflects who plays the archetype), and including it lowers AUC (FRA: 0.537 vs 0.554).

Validation: archetype ratings are rebuilt on the training drafts only (80% by draft-id hash, the same split as
the pick model), so a held-out deck's own games never feed the ratings that score it. Held-out decks are split
again in half: one half fits the calibration (logistic), the other reports AUC / calibration / correlation.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
from collections import Counter

import numpy as np
import polars as pl

from . import config
from .archetypes import LICENSE_NOTE, build as build_archetypes
from .cards import COLORS, PAIRS, card_meta, wubrg
from .model import _holdout
from .prepare import ensure_parquet

WINNER_WINS = 6          # "winning" human deck: >= 6 recorded game wins (near-trophy in Bo1 PremierDraft)
QS = [10, 25, 50, 75, 90]
REPL_Q = 10              # replacement level: 10th percentile of the pair's listed non-land cells
BUCKETS = PAIRS + list(COLORS)


def _half(draft_id: str) -> bool:
    """Second, independent split of the held-out drafts (calibration fit vs evaluation)."""
    return int(hashlib.sha1(draft_id.encode()).hexdigest()[:8], 16) % 2 == 0


def _r(x, d=4):
    if x is None:
        return None
    x = float(x)
    return None if not np.isfinite(x) else round(x, d)


# ---------------------------------------------------------------------------
# Ratings view (the same numbers the site reads from 17lands-archetypes.json)

class ArchView:
    def __init__(self, arch: dict, set_code: str, metric: str = "gih"):
        self.set = set_code
        self.baseline = float(arch["baseline_win_rate"])
        self.base = {b: float(a["win_rate"]) for b, a in arch["archetypes"].items() if a.get("win_rate") is not None}
        fields = arch["by_archetype_fields"]
        gi = fields.index(f"{metric}_wr")
        self.overall: dict[str, float] = {}
        self.cell: dict[str, dict[str, float]] = {}
        for name, c in arch["cards"].items():
            if c["overall"].get(f"{metric}_wr") is not None:
                self.overall[name] = float(c["overall"][f"{metric}_wr"])
            self.cell[name] = {b: float(v[gi]) for b, v in c["by_archetype"].items() if v[gi] is not None}
        # splash delta: games-weighted mean of (splash GIH WR - overall GIH WR)
        num = den = 0.0
        for name, c in arch["cards"].items():
            s = c.get("splash")
            if s and s.get(f"{metric}_wr_raw") is not None and s.get(f"{metric}_games") and name in self.overall:
                num += s[f"{metric}_games"] * (s[f"{metric}_wr_raw"] - self.overall[name])
                den += s[f"{metric}_games"]
        self.splash_delta = num / den if den else 0.0
        self.repl: dict[str, float] = {}
        for b in BUCKETS:
            vals = [cells[b] for n, cells in self.cell.items() if b in cells and not card_meta(n, set_code).land]
            if vals and b in self.base:
                self.repl[b] = float(np.percentile(vals, REPL_Q)) - self.base[b] + self.baseline

    def value(self, name: str, bucket: str, dead: bool, splash: bool, w: float = 1.0) -> float | None:
        """Archetype value on the set's scale: GIH WR in the bucket minus the bucket's base win rate plus the
        set baseline (the card's lift in this archetype). None when the card has no 17Lands data."""
        if name not in self.overall or bucket not in self.base:
            return None
        if dead:
            return self.repl.get(bucket)
        prior = self.overall[name] + (self.splash_delta if splash else 0.0)
        v = self.cell.get(name, {}).get(bucket)
        if v is None:  # the prior: overall + base - baseline (+ splash), so the lift is overall (+ splash)
            return prior
        return w * (v - self.base[bucket] + self.baseline) + (1 - w) * prior


# ---------------------------------------------------------------------------
# Deck table

def load_decks(set_code: str):
    path = ensure_parquet("game", set_code)
    schema = pl.read_parquet_schema(path)
    names = [c[len("deck_"):] for c in schema if c.startswith("deck_")]
    meta = ["draft_id", "build_index", "main_colors", "splash_colors", "won", "on_play", "user_game_win_rate_bucket",
            "user_n_games_bucket", "match_number"]
    have = set(schema)
    df = pl.read_parquet(path, columns=[c for c in meta if c in have] + [f"deck_{n}" for n in names]).with_row_index("row")
    if "match_number" not in have:  # older 17Lands files (no match_number): the game-1/game-2 noise estimate is skipped
        df = df.with_columns(pl.lit(None, dtype=pl.Int32).alias("match_number"))
    games = df.select(["row", "draft_id", "build_index", "won", "on_play", "user_game_win_rate_bucket", "user_n_games_bucket",
                       "match_number"])
    decks = (df.select(["row", "draft_id", "build_index", "main_colors", "splash_colors", "won", "user_game_win_rate_bucket",
                        "user_n_games_bucket"])
             .group_by(["draft_id", "build_index"], maintain_order=True)
             .agg(pl.col("row").first(), pl.col("main_colors").first(), pl.col("splash_colors").first(),
                  pl.len().alias("games"), pl.col("won").sum().alias("wins"),
                  pl.col("user_game_win_rate_bucket").first().alias("skill"),
                  pl.col("user_n_games_bucket").first().alias("exp")))
    first = decks["row"].to_numpy()
    counts = df.select([f"deck_{n}" for n in names])[first].to_numpy().astype(np.int16)
    # deck index for every game row
    key = {(d, b): i for i, (d, b) in enumerate(zip(decks["draft_id"].to_list(), decks["build_index"].to_list()))}
    gdeck = np.array([key[(d, b)] for d, b in zip(games["draft_id"].to_list(), games["build_index"].to_list())])
    return names, decks, counts, games, gdeck


class Features:
    """Per-deck structural features and per-card-copy castability (shared by norms and scoring)."""

    def __init__(self, names: list[str], set_code: str):
        self.names = names
        self.meta = [card_meta(n, set_code) for n in names]
        self.is_land = np.array([m.land for m in self.meta])
        self.is_crea = np.array([m.creature and not m.land for m in self.meta])
        self.mv = np.array([m.mv for m in self.meta])
        self.prod = {c: np.array([(c in m.produces) if m.land else False for m in self.meta]) for c in COLORS}

    def deck(self, row: np.ndarray, bucket: str, splash_colors: str | None = None) -> dict:
        idx = np.flatnonzero(row > 0)
        src = {c: int(row[idx] @ self.prod[c][idx]) for c in COLORS}
        lands = int(row[idx] @ self.is_land[idx])
        nonland_idx = [i for i in idx if not self.is_land[i]]
        n_nonland = int(sum(row[i] for i in nonland_idx))
        need = Counter()
        for i in nonland_idx:
            for c in self.meta[i].pips:
                need[c] += int(row[i])
        pair = [c for c in bucket]
        prim = sorted(pair, key=lambda c: (-need[c], COLORS.index(c)))
        splash = sorted(c for c in need if c not in pair)
        mvs = np.concatenate([np.full(int(row[i]), self.mv[i]) for i in nonland_idx]) if nonland_idx else np.zeros(0)
        return {
            "lands": lands,
            "nonland": n_nonland,
            "creatures": int(sum(row[i] for i in nonland_idx if self.is_crea[i])),
            "two_minus": int((mvs <= 2).sum()),
            "five_plus": int((mvs >= 5).sum()),
            "avg_mv": float(mvs.mean()) if len(mvs) else 0.0,
            "src_primary": src[prim[0]] if prim else None,
            "src_secondary": src[prim[1]] if len(prim) > 1 else None,
            "src_splash": min(src[c] for c in splash) if splash else None,
            "src": src,
        }

    def copies(self, row: np.ndarray, bucket: str, src: dict):
        """(name, n, dead, splash) per non-land card in the deck."""
        out = []
        for i in np.flatnonzero(row > 0):
            m = self.meta[i]
            if m.land:
                continue
            dead = any(src[c] == 0 for c in m.pips) or any(not any(src[c] for c in h) for h in m.hybrid)
            splash = any(c not in bucket for c in m.pips) or any(not (set(h) & set(bucket)) for h in m.hybrid)
            out.append((self.names[i], int(row[i]), dead, splash))
        return out


def deck_bucket(main: str | None) -> str | None:
    m = wubrg(main or "")
    return m if len(m) in (1, 2) else None


def score_decks(view: ArchView, feats: Features, counts, buckets: list[str | None], w: float = 1.0):
    """Quality (and overall-GIH baseline score) per deck; NaN when the bucket is unsupported."""
    q = np.full(len(buckets), np.nan)
    q_overall = np.full(len(buckets), np.nan)
    shape = [None] * len(buckets)
    for k, b in enumerate(buckets):
        if b is None:
            continue
        f = feats.deck(counts[k], b)
        shape[k] = f
        vals, wts, ov = [], [], []
        for name, n, dead, splash in feats.copies(counts[k], b, f["src"]):
            v = view.value(name, b, dead, splash, w)
            if v is None:
                continue
            vals.append(v)
            wts.append(n)
            ov.append(view.overall[name])
        if wts:
            q[k] = np.average(vals, weights=wts)
            q_overall[k] = np.average(ov, weights=wts)
    return q, q_overall, shape


# ---------------------------------------------------------------------------
# Stats helpers

def auc(score: np.ndarray, y: np.ndarray) -> float:
    from scipy.stats import rankdata
    r = rankdata(score)
    n1 = y.sum()
    n0 = len(y) - n1
    return float((r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))


def logistic(X: np.ndarray, y: np.ndarray, w: np.ndarray | None = None, iters: int = 50):
    """IRLS logistic regression (X includes the intercept column). Returns (beta, cov)."""
    w = np.ones(len(y)) if w is None else w
    b = np.zeros(X.shape[1])
    for _ in range(iters):
        p = 1 / (1 + np.exp(-(X @ b)))
        W = w * p * (1 - p)
        H = X.T @ (X * W[:, None]) + 1e-9 * np.eye(X.shape[1])
        step = np.linalg.solve(H, X.T @ (w * (y - p)))
        b += step
        if np.abs(step).max() < 1e-10:
            break
    return b, np.linalg.inv(H)


def cluster_se(X, y, beta, cluster):
    """Deck-clustered sandwich SE (games of one deck are not independent)."""
    p = 1 / (1 + np.exp(-(X @ beta)))
    H = X.T @ (X * (p * (1 - p))[:, None])
    Hi = np.linalg.inv(H)
    sc = X * (y - p)[:, None]
    _, inv = np.unique(cluster, return_inverse=True)
    S = np.zeros((inv.max() + 1, X.shape[1]))
    np.add.at(S, inv, sc)
    return np.sqrt(np.diag(Hi @ (S.T @ S) @ Hi))


def quantiles(x) -> list | None:
    x = np.asarray([v for v in x if v is not None and np.isfinite(v)], float)
    if len(x) < 20:
        return None
    return [_r(v, 3) for v in np.percentile(x, QS)]


def norms_for(sel: np.ndarray, shape: list, buckets: list, q: np.ndarray | None = None) -> dict:
    out = {}
    for b in BUCKETS:
        idx = [k for k in np.flatnonzero(sel) if buckets[k] == b and shape[k] is not None]
        if len(idx) < 30:
            continue
        S = [shape[k] for k in idx]
        row = {"decks": len(idx)}
        for f in ("lands", "nonland", "creatures", "two_minus", "five_plus", "avg_mv", "src_primary", "src_secondary", "src_splash"):
            row[f] = quantiles([s[f] for s in S])
        row["splash_share"] = _r(np.mean([s["src_splash"] is not None for s in S]), 3)
        if q is not None:
            row["quality"] = quantiles(q[idx])
        out[b] = row
    return out


# ---------------------------------------------------------------------------

def run(set_code: str, write: bool = True) -> dict:
    names, decks, counts, games, gdeck = load_decks(set_code)
    feats = Features(names, set_code)
    D = decks.height
    draft_ids = decks["draft_id"].to_list()
    hold = np.array([_holdout(d) for d in draft_ids])
    half = np.array([_half(d) for d in draft_ids])
    buckets = [deck_bucket(m) for m in decks["main_colors"].to_list()]
    total = counts.sum(1)
    sane = (total >= 38) & (total <= 45)
    dgames = decks["games"].to_numpy()
    dwins = decks["wins"].to_numpy()
    winners = dwins >= WINNER_WINS

    # --- validation: ratings from training drafts only
    train_arch = build_archetypes(set_code, write=False, keep_drafts=lambda d: not _holdout(d))
    tview = ArchView(train_arch, set_code)
    q_lift, q_ov, shape = score_decks(tview, feats, counts, buckets)
    ok = sane & np.isfinite(q_lift)
    norms_train = norms_for(ok & ~hold & winners, shape, buckets)

    y = games["won"].cast(pl.Int8).to_numpy().astype(float)
    on_play = games["on_play"].cast(pl.Int8).to_numpy().astype(float)
    skill = games["user_game_win_rate_bucket"].to_numpy().astype(float)
    exp = games["user_n_games_bucket"].to_numpy().astype(float)
    g_ok = ok[gdeck] & np.isfinite(skill)
    fit_g = g_ok & hold[gdeck] & half[gdeck]
    ev_g = g_ok & hold[gdeck] & ~half[gdeck]
    sk = np.clip(skill, 0.3, 0.8) - 0.55
    lowexp = (exp < 10).astype(float)

    def X(*cols, sel):
        return np.column_stack([np.ones(sel.sum())] + [c[sel] for c in cols])

    # How much to trust the archetype-specific part of a card's rating: w in [0, 1] blends the card's lift in the
    # archetype (w = 1) with its overall GIH WR (w = 0). Fitted on the fit half: the ratio of the two deck-mean
    # coefficients in one logistic model (with the archetype base rate).
    xl = (q_lift[gdeck] - np.nanmean(q_lift[ok & hold])) * 100
    xo = (q_ov[gdeck] - np.nanmean(q_ov[ok & hold])) * 100
    base_d = np.array([tview.base.get(b, np.nan) if b else np.nan for b in buckets])
    xb = (base_d[gdeck] - tview.baseline) * 100
    b_w, _ = logistic(X(xl, xo, xb, sel=fit_g), y[fit_g])
    w_arch = float(np.clip(b_w[1] / (b_w[1] + b_w[2]), 0, 1)) if (b_w[1] + b_w[2]) > 0 else 1.0
    q = score_decks(tview, feats, counts, buckets, w_arch)[0]
    q_ref = float(np.nanmean(q[ok & hold]))
    x = (q[gdeck] - q_ref) * 100  # percentage points of mean card value

    # The model: quality (card lifts) + the archetype's own base win rate, with weights fitted per set. Whether an
    # archetype's base rate carries over to held-out decks differs by set (FRA: no; SOS: yes), so it is fitted.
    q_wb = (q_lift + base_d - tview.baseline)[gdeck]
    q_gp = score_decks(ArchView(train_arch, set_code, "gp"), feats, counts, buckets)[0][gdeck]

    b_raw, _ = logistic(X(x, xb, sel=fit_g), y[fit_g])
    b_q, _ = logistic(X(x, sel=fit_g), y[fit_g])
    b_adj, _ = logistic(X(x, xb, sk, lowexp, on_play, sel=fit_g), y[fit_g])
    se_adj = cluster_se(X(x, xb, sk, lowexp, on_play, sel=fit_g), y[fit_g], b_adj, gdeck[fit_g])

    # evaluation half
    ye = y[ev_g]
    p_raw = 1 / (1 + np.exp(-(X(x, xb, sel=ev_g) @ b_raw)))
    res = {
        "games_eval": int(ev_g.sum()), "decks_eval": int((ok & hold & ~half).sum()),
        "games_fit": int(fit_g.sum()),
        "auc_model": _r(auc(p_raw, ye)),
        "archetype_weight": _r(w_arch, 3),
        "auc_quality": _r(auc(x[ev_g], ye)),
        "auc_lift_only": _r(auc(xl[ev_g], ye)),
        "auc_overall_gih": _r(auc(xo[ev_g], ye)),
        "auc_quality_with_pair_base": _r(auc(q_wb[ev_g], ye)),
        "auc_gp_lift": _r(auc(q_gp[ev_g], ye)),
    }
    b_sk, _ = logistic(X(sk, lowexp, on_play, sel=fit_g), y[fit_g])
    p_sk = 1 / (1 + np.exp(-(X(sk, lowexp, on_play, sel=ev_g) @ b_sk)))
    p_adj = 1 / (1 + np.exp(-(X(x, xb, sk, lowexp, on_play, sel=ev_g) @ b_adj)))
    res["auc_skill_play"] = _r(auc(p_sk, ye))
    res["auc_skill_play_quality"] = _r(auc(p_adj, ye))
    # deck-level correlation (decks with >= 3 games), eval half
    dsel = ok & hold & ~half & (dgames >= 3)
    wr = dwins[dsel] / dgames[dsel]
    lin = b_raw[1] * (q[dsel] - q_ref) * 100 + b_raw[2] * (base_d[dsel] - tview.baseline) * 100
    from scipy.stats import spearmanr
    res["deck_pearson"] = _r(np.corrcoef(lin, wr)[0, 1])
    res["deck_spearman"] = _r(spearmanr(lin, wr).statistic)
    res["deck_pearson_quality"] = _r(np.corrcoef(q[dsel], wr)[0, 1])
    res["deck_pearson_overall_gih"] = _r(np.corrcoef(q_ov[dsel], wr)[0, 1])
    # calibration by decile of the model's prediction
    edges = np.percentile(p_raw, np.linspace(0, 100, 11))
    cal = []
    for i in range(10):
        s = (p_raw >= edges[i]) & (p_raw <= edges[i + 1] if i == 9 else p_raw < edges[i + 1])
        if s.sum():
            cal.append({"pred": _r(p_raw[s].mean()), "obs": _r(ye[s].mean()), "games": int(s.sum()),
                        "quality_pp": _r(x[ev_g][s].mean(), 2)})
    res["calibration_deciles"] = cal
    res["calibration_max_abs_err"] = _r(max(abs(c["pred"] - c["obs"]) for c in cal))
    res["brier_model"] = _r(np.mean((p_raw - ye) ** 2))
    res["brier_constant"] = _r(np.mean((ye.mean() - ye) ** 2))
    res["slope_quality_only_logit_per_pp"] = _r(b_q[1])
    res["slope_raw_logit_per_pp"] = _r(b_raw[1])
    res["pair_base_raw_logit_per_pp"] = _r(b_raw[2])
    res["slope_adj_logit_per_pp"] = _r(b_adj[1])
    res["slope_adj_se"] = _r(se_adj[1])
    res["pair_base_adj_logit_per_pp"] = _r(b_adj[2])
    res["pair_base_adj_se"] = _r(se_adj[2])
    res["skill_coef"] = _r(b_adj[3])
    res["quality_sd_pp"] = _r(np.nanstd(q[ok & hold]) * 100, 3)

    # structural features: do deviations from the winners' norms add anything beyond quality?
    def dev(k, f, lo_q=0, hi_q=4):
        s = shape[k]
        n = norms_train.get(buckets[k]) if buckets[k] else None
        if s is None or n is None or n.get(f) is None or s[f] is None:
            return 0.0, 0.0
        return float(max(0, n[f][lo_q] - s[f])), float(max(0, s[f] - n[f][hi_q]))
    feat_rows = np.zeros((D, 6))
    for k in np.flatnonzero(ok & hold):
        lo_l, hi_l = dev(k, "lands")
        lo_c, _ = dev(k, "creatures")
        lo_2, _ = dev(k, "two_minus")
        _, hi_5 = dev(k, "five_plus")
        lo_s, _ = dev(k, "src_secondary")
        feat_rows[k] = [lo_l, hi_l, lo_c, lo_2, hi_5, lo_s]
    F = feat_rows[gdeck]
    cols = [x, xb, sk, lowexp, on_play] + [F[:, j] for j in range(6)]
    b_st, _ = logistic(X(*cols, sel=fit_g), y[fit_g])
    se_st = cluster_se(X(*cols, sel=fit_g), y[fit_g], b_st, gdeck[fit_g])
    p_st = 1 / (1 + np.exp(-(X(*cols, sel=ev_g) @ b_st)))
    res["auc_skill_play_quality_structure"] = _r(auc(p_st, ye))
    res["structure_coefs"] = {k: {"coef": _r(b_st[6 + j]), "se": _r(se_st[6 + j]),
                                  "share_flagged": _r(float((F[ev_g][:, j] > 0).mean()), 3)}
                              for j, k in enumerate(["lands_below_p10", "lands_above_p90", "creatures_below_p10",
                                                     "two_drops_below_p10", "five_plus_above_p90", "secondary_sources_below_p10"])}

    # noise estimates for the rating calibration study
    on = on_play[g_ok] == 1
    wr_play, wr_draw = y[g_ok][on].mean(), y[g_ok][~on].mean()
    mn = games["match_number"].fill_null(0).to_numpy()
    first3 = {}
    for k_, m_, y_ in zip(gdeck, mn, y):
        if m_ <= 3:
            first3.setdefault(k_, {})[m_] = y_
    pairs_ = np.array([(v[1], v[2]) for v in first3.values() if 1 in v and 2 in v] +
                      [(v[2], v[3]) for v in first3.values() if 2 in v and 3 in v])
    cov12 = float(np.cov(pairs_[:, 0], pairs_[:, 1])[0, 1]) if len(pairs_) > 2 else float("nan")
    pbar = float(pairs_.mean()) if len(pairs_) else float(y[g_ok].mean())
    # method of moments on whole-deck win rates (decks with >= 3 games): Var(wins/n) - E[p(1-p)/n]
    dm = (dgames >= 3) & sane
    p_d = dwins[dm] / dgames[dm]
    mom = float(np.var(p_d) - np.mean(pbar * (1 - pbar) / dgames[dm]))
    to_logit_sd = lambda v: float(np.sqrt(max(v, 0)) / (pbar * (1 - pbar)))
    res["noise"] = {
        "on_play_wr": _r(wr_play), "on_draw_wr": _r(wr_draw),
        "play_advantage_elo": _r(400 / np.log(10) * (np.log(wr_play / (1 - wr_play)) - np.log(wr_draw / (1 - wr_draw))) / 2, 1),
        "cov_game1_game2": _r(cov12, 5),
        "deck_logit_sd_mom": _r(to_logit_sd(mom), 3),
        "quality_logit_sd_raw": _r(abs(b_raw[1]) * np.nanstd(q[ok & hold]) * 100, 3),
        "quality_logit_sd_adj": _r(abs(b_adj[1]) * np.nanstd(q[ok & hold]) * 100, 3),
        "method": "Arena pairs players by record, so outcomes within a deck are not exchangeable (game 1 / game 2 "
                  "covariance is ~0 or negative) and whole-deck win-rate variance is compressed: deck_logit_sd_mom is a "
                  "lower bound. quality_logit_sd_* = spread of deck strength explained by the quality score (raw, and "
                  "holding player skill fixed).",
    }

    # --- production norms and parameters from the full-data ratings (the file the site reads)
    full = json.load(open(config.sets_dir() / set_code / "17lands-archetypes.json"))
    fview = ArchView(full, set_code)
    qf, _, shape_f = score_decks(fview, feats, counts, buckets, w_arch)
    okf = sane & np.isfinite(qf)
    pairs_norm = norms_for(okf & winners, shape_f, buckets, qf)
    all_norm = norms_for(okf, shape_f, buckets, qf)
    for b, n in pairs_norm.items():
        n["replacement"] = _r(fview.repl.get(b))
        if b in all_norm:
            n["all_decks"] = {"decks": all_norm[b]["decks"], "lands": all_norm[b]["lands"], "quality": all_norm[b].get("quality")}
    q_ref_full = float(np.nanmean(qf[okf]))
    # validated: the model beats raw overall GIH WR on held-out games, or at least matches it (within 0.005 AUC)
    # while the card-quality term stays clearly significant with player skill held fixed
    verdict = ("validated" if res["auc_model"] >= res["auc_overall_gih"] - 0.005
               and res["slope_adj_logit_per_pp"] > 3 * res["slope_adj_se"] else "weak")
    out = {
        "set": set_code,
        "format": config.format_of(set_code),
        "generator": "analysis/draft_eval/build_eval.py",
        "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "17Lands public game data (game_data_public.{}.{}.csv.gz)".format(*config.source(set_code)),
        "license_note": LICENSE_NOTE,
        "requires": {"archetypes_generated_at": full.get("generated_at")},
        "definitions": {
            "winners": f"decks (draft_id, build_index; 38-45 cards) with >= {WINNER_WINS} recorded game wins",
            "quantiles": "p10, p25, p50, p75, p90",
            "two_minus": "non-land cards with mana value <= 2", "five_plus": "non-land cards with mana value >= 5",
            "src_primary": "lands producing the pair color more non-land cards need (hard pips)",
            "src_secondary": "lands producing the other pair color",
            "src_splash": "lands producing the scarcest splash color (decks with a splash only)",
            "quality": "mean archetype value of the non-land cards (see analysis/draft_eval/build_eval.py)",
        },
        "scoring": {
            "baseline_win_rate": _r(fview.baseline),
            "splash_delta": _r(fview.splash_delta),
            # card value = w * (lift in the archetype) + (1 - w) * (overall GIH WR); w fitted on held-out games
            "archetype_weight": _r(w_arch, 3),
            "replacement_quantile": REPL_Q / 100,
            "quality_ref": _r(q_ref_full),
            # expected 17Lands game win rate of a deck in bucket P:
            #   sigmoid(logit(baseline) + slope * (quality - quality_ref) * 100 + pair_base * (base[P] - baseline) * 100)
            # (coefficients with player skill and play/draw held fixed; base[P] from 17lands-archetypes.json)
            "slope_logit_per_pp": _r(b_adj[1]),
            "pair_base_logit_per_pp": _r(b_adj[2]),
            "validation": {k: res[k] for k in ("auc_model", "auc_quality", "auc_overall_gih", "deck_pearson", "deck_spearman",
                                               "calibration_max_abs_err", "slope_adj_se", "games_eval")},
            "verdict": verdict,
        },
        "pairs": pairs_norm,
    }
    res["verdict"] = verdict
    if write:
        p = config.sets_dir() / set_code / "deck-norms.json"
        with open(p, "w") as fh:
            head = {k: v for k, v in out.items() if k != "pairs"}
            text = json.dumps(head, indent=1, ensure_ascii=False)[:-2]
            lines = [f'  {json.dumps(b)}: {json.dumps(v, separators=(",", ":"))}' for b, v in out["pairs"].items()]
            fh.write(text + ',\n "pairs": {\n' + ",\n".join(lines) + "\n }\n}\n")
        rp = config.results_dir() / f"build-quality-{set_code}.json"
        rp.write_text(json.dumps({"set": set_code, **res}, indent=1))
    return {"norms": out, "validation": res}


def summary(sets: list[str] | None = None) -> None:
    """Rewrite build-quality.md and noise-17lands.json from every results/build-quality-<SET>.json (or `sets`)."""
    if sets is None:
        sets = sorted(p.stem[len("build-quality-"):] for p in config.results_dir().glob("build-quality-*.json"))
    rows, noise = [], {}
    for s in sets:
        p = config.results_dir() / f"build-quality-{s}.json"
        if not p.exists():
            continue
        r = json.loads(p.read_text())
        rows.append(r)
        noise[s] = r["noise"]
    (config.results_dir() / "noise-17lands.json").write_text(json.dumps(noise, indent=1))
    L = ["# Build quality: validation on held-out 17Lands games", "",
         "Generated by `uv run python -m draft_eval buildeval` (analysis/draft_eval/build_eval.py). Archetype ratings rebuilt on the",
         "training drafts only (80% by draft-id hash); held-out decks split in half (fit the logistic model / evaluate). AUC is per",
         "game (did this deck win this game?), so the ceiling is low: one game is mostly luck, play and the opponent.", "",
         "Columns: **w** = fitted archetype weight (card value = w × lift in the archetype + (1 − w) × overall GIH WR);",
         "**model** = card quality + the archetype's base win rate, weights fitted on the fit half; **quality** = card quality",
         "alone; **lift** = archetype lift alone (w = 1); **overall GIH** = mean overall GIH WR of the non-land cards (the naive",
         "baseline); **+ base 1:1** = lift plus the archetype base rate unweighted; **skill+play** = player's long-run win-rate bucket,",
         "experience and play/draw only; **+model** = that plus the model; deck r = Pearson correlation of the model's linear",
         "predictor with deck win rate (decks with ≥ 3 games); slope = logits per point of card quality with skill fixed.", "",
         "| Set | eval games | w | AUC model | quality | lift | overall GIH | + base 1:1 | skill+play | +model | +structure | deck r | slope ± SE | pair base ± SE | calib. max err | verdict |",
         "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        L.append(f"| {r['set']} | {r['games_eval']:,} | {r['archetype_weight']:.2f} | {r['auc_model']:.3f} | {r['auc_quality']:.3f} | {r['auc_lift_only']:.3f} | {r['auc_overall_gih']:.3f} | "
                 f"{r['auc_quality_with_pair_base']:.3f} | {r['auc_skill_play']:.3f} | {r['auc_skill_play_quality']:.3f} | "
                 f"{r['auc_skill_play_quality_structure']:.3f} | {r['deck_pearson']:.3f} | "
                 f"{r['slope_adj_logit_per_pp']:.3f} ± {r['slope_adj_se']:.3f} | {r['pair_base_adj_logit_per_pp']:+.3f} ± {r['pair_base_adj_se']:.3f} | "
                 f"{r['calibration_max_abs_err']:.3f} | {r['verdict']} |")
    L += ["", "Structural deviations from the winners' norms (coefficients in logits per card/land outside the p10–p90 band, with",
          "quality, archetype base rate, player skill and play/draw in the model; deck-clustered SE; share of held-out decks flagged):", "",
          "| Set | " + " | ".join(["lands < p10", "lands > p90", "creatures < p10", "2-drops < p10", "5+ > p90", "2nd-color sources < p10"]) + " |",
          "|---|---|---|---|---|---|---|"]
    for r in rows:
        sc = r["structure_coefs"]
        L.append(f"| {r['set']} | " + " | ".join(f"{v['coef']:+.3f} ± {v['se']:.3f} ({v['share_flagged']:.0%})" for v in sc.values()) + " |")
    L += ["", "Calibration (deciles of predicted game win rate, evaluation half), first set:", ""]
    if rows:
        L += ["| predicted | observed | games | quality vs mean (pp) |", "|---|---|---|---|"]
        for c in rows[0]["calibration_deciles"]:
            L.append(f"| {c['pred']:.3f} | {c['obs']:.3f} | {c['games']:,} | {c['quality_pp']:+.2f} |")
    L += ["", "Game-level noise (used by the rating calibration study):", "",
          "| Set | on play | on draw | play adv. (Elo) | Cov(game 1, game 2) | deck logit SD (MoM, lower bound) | quality-explained SD raw / skill-adjusted (logits) |",
          "|---|---|---|---|---|---|---|"]
    for s, n in noise.items():
        L.append(f"| {s} | {n['on_play_wr']:.3f} | {n['on_draw_wr']:.3f} | {n['play_advantage_elo']:.0f} | {'n/a' if n['cov_game1_game2'] is None else format(n['cov_game1_game2'], '+.4f')} | "
                 f"{n['deck_logit_sd_mom']:.3f} | {n['quality_logit_sd_raw']:.3f} / {n['quality_logit_sd_adj']:.3f} |")
    (config.results_dir() / "build-quality.md").write_text("\n".join(L) + "\n")
