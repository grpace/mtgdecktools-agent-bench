"""Context features for a pick: (pack, pool, pick position) -> per-candidate feature matrix.

The same code path is used to train on 17Lands expert picks and to score benchmark drafts.

Lane model (soft archetype membership)
--------------------------------------
For each card c and color pair P we have an archetype-conditional value val[c,P] (shrunk GIH WR of c
in decks whose main colors are P; see archetypes.py) and a castability cast[c,P] in {1, 0.35, 0}
(0.35 = splashable: one off-color pip). Replacement level repl[P] is the 25th percentile of val among
castable non-land cards of that pair (roughly the last card that makes a deck). A card's value in a
lane is

    lane_value[c,P] = repl[P] + cast[c,P] * max(0, val[c,P] - repl[P])        (basics: repl[P])

The drafter's lane weights w[P] come from their pool so far:

    strength[P] = sum_{c in pool} lane_value[c,P] - repl[P]       (value above replacement in P)
    w           = softmax(lambda * strength + log prior_share[P])

so an empty pool gives the population's archetype shares and the distribution sharpens as the pool
commits. The context value of a candidate is ctx_wr[c] = sum_P w[P] * lane_value[c,P] (in GIH WR
units) -- the "archetype-aware GIH" used for regret in win-rate points.
"""
from __future__ import annotations

import json
from dataclasses import dataclass

import numpy as np

from . import config
from .cards import COLORS, PAIRS, card_meta

FEATURES = [
    "gih", "gih_x_t", "ata", "ata_x_t", "ctx", "ctx_x_t", "fit", "fit_x_t", "offpip_x_t",
    "gold", "gold_x_t", "creature_need", "cheap_need", "topend_excess", "dup", "dup_x_legend",
    "land", "land_x_fit", "basic", "rare", "rare_x_t", "unrated",
]
PAIR_COL = np.array([[1.0 if c in p else 0.0 for c in COLORS] for p in PAIRS], dtype=np.float32)  # [10,5]
DEFAULT_LAMBDA = 15.0


@dataclass
class SetContext:
    set_code: str
    names: list
    index: dict
    gih: np.ndarray        # overall GIH WR (shrunk)
    ata: np.ndarray
    rated: np.ndarray      # bool: has 17Lands data
    cast: np.ndarray       # [C,10]
    lane_value: np.ndarray  # [C,10]
    lar: np.ndarray        # [C,10] value above replacement (>= 0)
    repl: np.ndarray       # [10]
    base_pair: np.ndarray  # [10]
    log_prior: np.ndarray  # [10]
    baseline: float
    pips: np.ndarray       # [C,5] hard pips
    creature: np.ndarray
    land: np.ndarray
    basic: np.ndarray
    cheap: np.ndarray
    topend: np.ndarray
    gold: np.ndarray
    rare: np.ndarray
    legendary: np.ndarray
    colors: list
    lam: float = DEFAULT_LAMBDA

    def idx(self, name: str) -> int:
        return self.index[name]


def load_json(path):
    with open(path) as fh:
        return json.load(fh)


def build_context(set_code: str, names: list[str], rarity_hints: dict | None = None,
                  lam: float = DEFAULT_LAMBDA) -> SetContext:
    sd = config.sets_dir() / set_code
    arch = load_json(sd / "17lands-archetypes.json")
    try:
        l17 = load_json(sd / "17lands.json")["cards"]
    except FileNotFoundError:
        l17 = {}
    baseline = arch["baseline_win_rate"]
    A = arch["archetypes"]
    base_pair = np.array([A.get(p, {}).get("win_rate", baseline) for p in PAIRS], dtype=np.float32)
    share = np.array([A.get(p, {}).get("share", 0.01) or 0.01 for p in PAIRS], dtype=np.float32)
    log_prior = np.log(share / share.sum())
    rarity_hints = rarity_hints or {}

    C = len(names)
    metas = [card_meta(n, set_code, rarity_hints.get(n)) for n in names]
    gih = np.full(C, np.nan, np.float32)
    ata = np.full(C, np.nan, np.float32)
    val = np.full((C, 10), np.nan, np.float32)
    for i, n in enumerate(names):
        a = arch["cards"].get(n)
        if a and a["overall"]["gih_wr"] is not None:
            gih[i] = a["overall"]["gih_wr"]
            for j, p in enumerate(PAIRS):
                cell = a["by_archetype"].get(p)
                val[i, j] = cell[0] if cell else gih[i] + base_pair[j] - baseline
        r = l17.get(n)
        if r and r.get("ata") is not None:
            ata[i] = r["ata"]
    rated = ~np.isnan(gih)
    rarity = np.array([m.rarity for m in metas])
    # unrated cards: rarity-mean fallback (flagged with the `unrated` feature)
    for rr in set(rarity):
        sel = rarity == rr
        g = np.nanmean(gih[sel & rated]) if (sel & rated).any() else np.nanmean(gih[rated]) if rated.any() else baseline
        gih[sel & ~rated] = g - 0.01
        at = ata[sel & ~np.isnan(ata)]
        ata[sel & np.isnan(ata)] = np.mean(at) if at.size else 7.0
    ata[np.isnan(ata)] = 7.0
    for i in np.flatnonzero(~rated):
        val[i] = gih[i] + base_pair - baseline

    cast = np.array([[m.castability(p) for p in PAIRS] for m in metas], dtype=np.float32)
    basic = np.array([m.basic for m in metas])
    land = np.array([m.land and not m.basic for m in metas])
    creature = np.array([m.creature and not m.land for m in metas])
    mv = np.array([m.mv for m in metas], dtype=np.float32)
    repl = np.zeros(10, np.float32)
    for j in range(10):
        sel = (cast[:, j] >= 1) & ~basic & ~land & rated
        repl[j] = np.percentile(val[sel, j], 25) if sel.sum() > 10 else base_pair[j] - 0.02
    lar = cast * np.maximum(0.0, val - repl[None, :])
    lar[basic] = 0.0
    lane_value = repl[None, :] + lar
    pips = np.zeros((C, 5), np.float32)
    for i, m in enumerate(metas):
        for c, k in m.pips.items():
            pips[i, COLORS.index(c)] = k
    return SetContext(
        set_code=set_code, names=list(names), index={n: i for i, n in enumerate(names)},
        gih=gih, ata=ata, rated=rated, cast=cast, lane_value=lane_value.astype(np.float32),
        lar=lar.astype(np.float32), repl=repl, base_pair=base_pair, log_prior=log_prior.astype(np.float32),
        baseline=float(baseline), pips=pips, creature=creature, land=land, basic=basic,
        cheap=(mv <= 2) & ~land & ~basic, topend=(mv >= 5) & ~land & ~basic,
        gold=np.array([m.gold for m in metas]), rare=np.isin(rarity, ["rare", "mythic"]),
        legendary=np.array([m.legendary for m in metas]), colors=[m.colors for m in metas], lam=lam,
    )


def lane_weights(ctx: SetContext, pool: np.ndarray) -> np.ndarray:
    """pool: [n,C] counts -> [n,10] soft lane weights."""
    strength = pool.astype(np.float32) @ ctx.lar
    z = ctx.lam * strength + ctx.log_prior[None, :]
    z -= z.max(1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(1, keepdims=True)


def candidates(pack: np.ndarray, K: int | None = None):
    present = pack > 0
    K = K or int(present.sum(1).max())
    cand = np.argsort(~present, axis=1, kind="stable")[:, :K]
    mask = np.take_along_axis(present, cand, 1)
    return cand, mask


def featurize(ctx: SetContext, pack: np.ndarray, pool: np.ndarray, t: np.ndarray, K: int | None = None):
    """pack, pool: [n,C] counts; t: [n] overall pick fraction in [0,1].

    Returns cand [n,K] (card indices), mask [n,K], X [n,K,F], aux dict (ctx_wr, gih, w).
    """
    n = pack.shape[0]
    cand, mask = candidates(pack, K)
    pool_f = pool.astype(np.float32)
    w = lane_weights(ctx, pool)                       # [n,10]
    S = np.clip(w @ PAIR_COL, 0, 1)                   # [n,5] color commitment
    fitC = w @ ctx.cast.T                              # [n,C]
    onlane = pool_f * fitC
    nonb = (~ctx.basic & ~ctx.land).astype(np.float32)
    L = onlane @ nonb
    crea_L = onlane @ ctx.creature.astype(np.float32)
    cheap_L = onlane @ ctx.cheap.astype(np.float32)
    top_L = onlane @ ctx.topend.astype(np.float32)
    rows = np.arange(n)[:, None]
    fit = fitC[rows, cand]
    ctx_wr = (w[:, None, :] * ctx.lane_value[cand]).sum(-1)
    g = ctx.gih[cand]
    tt = t[:, None].astype(np.float32)
    gz = (g - ctx.baseline) / 0.03
    cz = (ctx_wr - ctx.baseline) / 0.03
    az = (ctx.ata[cand] - 7.0) / 3.0
    off = (ctx.pips[cand] * (1 - S)[:, None, :]).sum(-1)
    gold = ctx.gold[cand].astype(np.float32)
    dup = np.minimum(pool[rows, cand], 4).astype(np.float32)
    landc = ctx.land[cand].astype(np.float32)
    rare = ctx.rare[cand].astype(np.float32)
    feats = [
        gz, gz * tt, az, az * tt, cz, cz * tt, fit, fit * tt, off * tt,
        gold, gold * tt,
        ctx.creature[cand] * ((0.45 * L - crea_L) / 5.0)[:, None],
        ctx.cheap[cand] * ((0.25 * L - cheap_L) / 3.0)[:, None],
        ctx.topend[cand] * ((top_L - 0.12 * L) / 3.0)[:, None],
        dup, dup * ctx.legendary[cand],
        landc, landc * fit, ctx.basic[cand].astype(np.float32), rare, rare * tt,
        (~ctx.rated[cand]).astype(np.float32),
    ]
    X = np.stack([f.astype(np.float32) for f in feats], -1)
    X[~mask] = 0.0
    return cand, mask, X, {"ctx_wr": ctx_wr, "gih": g, "w": w, "fit": fit}
