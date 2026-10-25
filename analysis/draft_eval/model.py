"""Expert pick model: conditional logit over the cards in the pack, trained on 17Lands expert picks.

    P(pick = c | pack, pool, t) = exp(u_c) / sum_{c' in pack} exp(u_c')
    u_c = x_c(pack, pool, t) . beta  [+ a_c]

x_c are the context features of features.py (standardized); a_c is an optional per-card intercept
(the residual "expert pick order" not explained by ratings and context), L2-regularized.

Expert drafters (default): user_n_games_bucket >= 50 and user_game_win_rate_bucket >= 0.60.
"""
from __future__ import annotations

import hashlib
import json
import time

import numpy as np
import polars as pl
from scipy.optimize import minimize, minimize_scalar

from . import config
from .features import FEATURES, build_context, featurize
from .prepare import ensure_parquet

EXPERT_MIN_GAMES = 50
EXPERT_MIN_WR = 0.60
L2_BETA = 1e-4
L2_INTERCEPT = 1e-5
HOLDOUT_FRAC = 0.2
VALUE_FEATURES = [f for f in FEATURES if not f.startswith(("ata", "rare", "unrated"))]


def _holdout(draft_id: str) -> bool:
    return int(hashlib.md5(draft_id.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF < HOLDOUT_FRAC


def load_drafts(set_code: str, max_drafts: int, seed: int = 0, expert: bool = True):
    path = ensure_parquet("draft", set_code)
    meta = pl.read_parquet(path, columns=["draft_id", "user_n_games_bucket", "user_game_win_rate_bucket"]).unique("draft_id")
    if expert:
        sel = meta.filter((pl.col("user_n_games_bucket") >= EXPERT_MIN_GAMES)
                          & (pl.col("user_game_win_rate_bucket") >= EXPERT_MIN_WR))
    else:
        sel = meta.filter((pl.col("user_game_win_rate_bucket") < EXPERT_MIN_WR) | (pl.col("user_n_games_bucket") < EXPERT_MIN_GAMES))
    n_avail = sel.height
    ids = sel["draft_id"].sort().to_list()
    rng = np.random.default_rng(seed)
    if len(ids) > max_drafts:
        ids = list(rng.choice(ids, max_drafts, replace=False))
    schema = pl.read_parquet_schema(path)
    names = [c[len("pack_card_"):] for c in schema if c.startswith("pack_card_")]
    df = (pl.scan_parquet(path).filter(pl.col("draft_id").is_in(ids))
          .select(["draft_id", "pack_number", "pick_number", "pick"]
                  + [f"pack_card_{n}" for n in names] + [f"pool_{n}" for n in names]).collect())
    return df, names, n_avail, meta.height


def to_arrays(df: pl.DataFrame, names: list[str]):
    idx = {n: i for i, n in enumerate(names)}
    pick = np.array([idx.get(p, -1) for p in df["pick"].to_list()])
    pack = df.select([f"pack_card_{n}" for n in names]).to_numpy().astype(np.int8)
    pool = df.select([f"pool_{n}" for n in names]).to_numpy().astype(np.int8)
    ppp = int(df["pick_number"].max()) + 1
    overall = df["pack_number"].to_numpy() * ppp + df["pick_number"].to_numpy()
    t = overall / (3 * ppp - 1)
    ok = (pick >= 0) & (pack[np.arange(len(pick)), np.maximum(pick, 0)] > 0)
    return dict(pack=pack[ok], pool=pool[ok], pick=pick[ok], t=t[ok].astype(np.float32),
                pick_in_pack=df["pick_number"].to_numpy()[ok], pack_number=df["pack_number"].to_numpy()[ok],
                draft=np.array(df["draft_id"].to_list())[ok])


def featurize_chunks(ctx, arr, K, chunk=40000):
    out = []
    for s in range(0, len(arr["pick"]), chunk):
        sl = slice(s, s + chunk)
        cand, mask, X, aux = featurize(ctx, arr["pack"][sl], arr["pool"][sl], arr["t"][sl], K)
        y = np.argmax(cand == arr["pick"][sl, None], 1)
        out.append((cand, mask, X, y, aux["ctx_wr"], aux["gih"]))
    cat = lambda i: np.concatenate([o[i] for o in out])
    return dict(cand=cat(0), mask=cat(1), X=cat(2), y=cat(3), ctx_wr=cat(4), gih=cat(5))


# ---------------------------------------------------------------- conditional logit
def _logsoftmax(U, mask):
    U = np.where(mask, U, -1e9)
    m = U.max(1, keepdims=True)
    lse = m + np.log(np.exp(U - m).sum(1, keepdims=True))
    return U - lse


def nll_of_scores(U, mask, y):
    ls = _logsoftmax(U, mask)
    return -ls[np.arange(len(y)), y]


def fit_temperature(S, mask, y):
    S = np.where(mask, S, 0.0)
    f = lambda b: float(nll_of_scores(b * S, mask, y).mean())
    r = minimize_scalar(f, bounds=(0.0, 500.0), method="bounded")
    return float(r.x)


def fit_cl(X, mask, cand, y, C, intercepts: bool, init=None):
    N, K, F = X.shape
    rows = np.arange(N)
    onehot = np.zeros((N, K), np.float32)
    onehot[rows, y] = 1.0
    nparam = F + (C if intercepts else 0)

    def f(theta):
        beta = theta[:F].astype(np.float32)
        U = X @ beta
        if intercepts:
            a = theta[F:].astype(np.float32)
            U = U + a[cand]
        ls = _logsoftmax(U, mask)
        nll = -ls[rows, y].mean()
        P = np.exp(ls) * mask
        G = (P - onehot) / N
        g = np.zeros(nparam)
        g[:F] = np.einsum("nk,nkf->f", G, X) + 2 * L2_BETA * theta[:F]
        loss = nll + L2_BETA * float(theta[:F] @ theta[:F])
        if intercepts:
            g[F:] = np.bincount(cand.ravel(), weights=G.ravel(), minlength=C) + 2 * L2_INTERCEPT * theta[F:]
            loss += L2_INTERCEPT * float(theta[F:] @ theta[F:])
        return float(loss), g

    theta0 = np.zeros(nparam) if init is None else init
    r = minimize(f, theta0, jac=True, method="L-BFGS-B", options={"maxiter": 500})
    return r.x, r


def evaluate(U, mask, y, groups: dict | None = None):
    U = np.where(mask, U, -np.inf)
    order = np.argsort(-U, 1)
    rank = np.argmax(order == y[:, None], 1)
    nll = nll_of_scores(np.where(mask, U, 0), mask, y)
    res = {"n": int(len(y)), "top1": round(float((rank == 0).mean()), 4), "top3": round(float((rank < 3).mean()), 4),
           "nll": round(float(nll.mean()), 4)}
    if groups:
        res["by"] = {}
        for gname, g in groups.items():
            res["by"][gname] = {}
            for v in np.unique(g):
                s = g == v
                res["by"][gname][str(v)] = {"n": int(s.sum()), "top1": round(float((rank[s] == 0).mean()), 4),
                                            "top3": round(float((rank[s] < 3).mean()), 4),
                                            "nll": round(float(nll[s].mean()), 4)}
    return res


def phase_of(pick_in_pack):
    return np.where(pick_in_pack < 5, "picks01-05", np.where(pick_in_pack < 9, "picks06-09", "picks10+"))


class Model:
    def __init__(self, d: dict):
        self.d = d
        self.mu = np.array(d["mu"], np.float32)
        self.sd = np.array(d["sd"], np.float32)
        self.beta = np.array(d["beta"], np.float32)
        self.lam = d["lambda"]

    @classmethod
    def load(cls, set_code: str):
        with open(config.models_dir() / f"{set_code}.json") as fh:
            return cls(json.load(fh))

    def intercepts_for(self, ctx):
        ic = self.d.get("intercepts") or {}
        fb = self.d.get("intercept_fallback_by_rarity", {})
        out = np.zeros(len(ctx.names), np.float32)
        for i, n in enumerate(ctx.names):
            if n in ic:
                out[i] = ic[n]
            else:
                out[i] = fb.get("rare" if ctx.rare[i] else "common", 0.0)
        return out

    def value_utilities(self, X):
        vm = self.d["value_model"]
        idx = [self.d["features"].index(f) for f in vm["features"]]
        Xs = (X[..., idx] - self.mu[idx]) / self.sd[idx]
        return Xs @ np.array(vm["beta"], np.float32)

    def utilities(self, X, cand, ctx, intercepts=None):
        Xs = (X - self.mu) / self.sd
        U = Xs @ self.beta
        if self.d.get("intercepts"):
            a = self.intercepts_for(ctx) if intercepts is None else intercepts
            U = U + a[cand]
        return U


def train_set(set_code: str, max_drafts: int = 8000, seed: int = 0):
    t0 = time.time()
    df, names, n_expert, n_all = load_drafts(set_code, max_drafts, seed, expert=True)
    arr = to_arrays(df, names)
    del df
    hold = np.array([_holdout(d) for d in arr["draft"]])
    print(f"[{set_code}] expert drafts available {n_expert}/{n_all}; using {len(np.unique(arr['draft']))} drafts, "
          f"{len(arr['pick'])} picks ({hold.mean():.0%} held out) {time.time()-t0:.0f}s", flush=True)
    K = int((arr["pack"] > 0).sum(1).max())

    # tune the lane sharpness lambda on the archetype-aware baseline (training split, subsample)
    tr_idx = np.flatnonzero(~hold)
    rng = np.random.default_rng(seed)
    sub = rng.choice(tr_idx, min(40000, len(tr_idx)), replace=False)
    sub_arr = {k: v[sub] for k, v in arr.items()}
    best = None
    lam_scores = {}
    for lam in (3.0, 8.0, 15.0, 30.0, 60.0):
        ctx = build_context(set_code, names, lam=lam)
        F = featurize_chunks(ctx, sub_arr, K)
        b = fit_temperature(F["ctx_wr"] / 0.03, F["mask"], F["y"])
        nll = float(nll_of_scores(b * np.where(F["mask"], F["ctx_wr"] / 0.03, 0), F["mask"], F["y"]).mean())
        lam_scores[lam] = round(nll, 4)
        if best is None or nll < best[1]:
            best = (lam, nll)
    lam = best[0]
    print(f"[{set_code}] lambda scores {lam_scores} -> {lam}", flush=True)
    ctx = build_context(set_code, names, lam=lam)
    F = featurize_chunks(ctx, arr, K)
    del arr["pack"], arr["pool"]
    X, mask, cand, y = F["X"], F["mask"], F["cand"], F["y"]
    tr, te = ~hold, hold
    m = mask[tr]
    mu = (X[tr] * m[..., None]).sum((0, 1)) / m.sum()
    sd = np.sqrt((((X[tr] - mu) ** 2) * m[..., None]).sum((0, 1)) / m.sum())
    sd[sd < 1e-6] = 1.0
    Xs = ((X - mu) / sd * mask[..., None]).astype(np.float32)
    C = len(names)
    groups = {"phase": phase_of(arr["pick_in_pack"][te]), "pack": arr["pack_number"][te] + 1}

    results = {}
    basic_pen = np.where(ctx.basic[cand], -1.0, 0.0)
    # baselines (temperature fitted on the training split)
    for bname, S in {
        "random": np.zeros(cand.shape, np.float32),
        "gih_overall": (F["gih"] - ctx.baseline) / 0.03 + 10 * basic_pen,
        "ata": -(ctx.ata[cand] - 7.0) / 3.0,
        "gih_archetype_aware": (F["ctx_wr"] - ctx.baseline) / 0.03,
    }.items():
        b = fit_temperature(S[tr], mask[tr], y[tr]) if bname != "random" else 0.0
        results[bname] = evaluate(b * S[te], mask[te], y[te], groups)
        results[bname]["temperature_beta"] = round(b, 4)
        print(f"[{set_code}] {bname:22s} top1 {results[bname]['top1']:.3f} top3 {results[bname]['top3']:.3f} nll {results[bname]['nll']:.3f}", flush=True)

    t1 = time.time()
    theta_f, r1 = fit_cl(Xs[tr], mask[tr], cand[tr], y[tr], C, intercepts=False)
    U = Xs @ theta_f.astype(np.float32)
    results["model_context"] = evaluate(U[te], mask[te], y[te], groups)
    print(f"[{set_code}] model_context          top1 {results['model_context']['top1']:.3f} top3 {results['model_context']['top3']:.3f} nll {results['model_context']['nll']:.3f} ({time.time()-t1:.0f}s, {r1.nit} it)", flush=True)
    t1 = time.time()
    init = np.concatenate([theta_f, np.zeros(C)])
    theta, r2 = fit_cl(Xs[tr], mask[tr], cand[tr], y[tr], C, intercepts=True, init=init)
    beta, a = theta[:len(FEATURES)], theta[len(FEATURES):]
    U2 = Xs @ beta.astype(np.float32) + a[cand].astype(np.float32)
    results["model_context_plus_card"] = evaluate(U2[te], mask[te], y[te], groups)
    print(f"[{set_code}] model_context_plus_card top1 {results['model_context_plus_card']['top1']:.3f} top3 {results['model_context_plus_card']['top3']:.3f} nll {results['model_context_plus_card']['nll']:.3f} ({time.time()-t1:.0f}s, {r2.nit} it)", flush=True)

    # value model: win-rate-derived ratings + pool context only (no ATA, rarity or card intercepts), so it
    # cannot learn human pick habits that are not about winning (rare-drafting, popularity)
    vf = [i for i, f in enumerate(FEATURES) if f in VALUE_FEATURES]
    Xv = Xs[..., vf]
    theta_v, _ = fit_cl(Xv[tr], mask[tr], cand[tr], y[tr], C, intercepts=False)
    Uv = Xv @ theta_v.astype(np.float32)
    results["model_value"] = evaluate(Uv[te], mask[te], y[te], groups)
    print(f"[{set_code}] model_value             top1 {results['model_value']['top1']:.3f} top3 {results['model_value']['top3']:.3f} nll {results['model_value']['nll']:.3f}", flush=True)

    # ablation: card intercepts + overall ratings only (no pool context)
    ctx_free = [i for i, f in enumerate(FEATURES) if f in ("gih", "gih_x_t", "ata", "ata_x_t", "gold", "gold_x_t", "land", "basic", "rare", "rare_x_t", "unrated")]
    Xn = Xs[..., ctx_free]
    theta_n, _ = fit_cl(Xn[tr], mask[tr], cand[tr], y[tr], C, intercepts=True)
    Un = Xn @ theta_n[:len(ctx_free)].astype(np.float32) + theta_n[len(ctx_free):][cand].astype(np.float32)
    results["ablation_card_no_context"] = evaluate(Un[te], mask[te], y[te], groups)
    print(f"[{set_code}] ablation_card_no_context top1 {results['ablation_card_no_context']['top1']:.3f} nll {results['ablation_card_no_context']['nll']:.3f}", flush=True)

    # how predictable are non-expert drafters under the expert model?
    try:
        dfn, names_n, _, _ = load_drafts(set_code, 800, seed + 1, expert=False)
        an = to_arrays(dfn, names_n)
        Fn = featurize_chunks(ctx, an, K)
        Xsn = ((Fn["X"] - mu) / sd * Fn["mask"][..., None]).astype(np.float32)
        Un2 = Xsn @ beta.astype(np.float32) + a[Fn["cand"]].astype(np.float32)
        results["model_context_plus_card_on_nonexperts"] = evaluate(Un2, Fn["mask"], Fn["y"])
    except Exception as e:  # pragma: no cover
        print("non-expert eval failed", e)

    rarity_fb = {
        "rare": float(np.mean(a[ctx.rare])) if ctx.rare.any() else 0.0,
        "common": float(np.mean(a[~ctx.rare])),
    }
    model = {
        "set": set_code,
        "kind": "conditional_logit",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "expert_definition": {"user_n_games_bucket_min": EXPERT_MIN_GAMES, "user_game_win_rate_bucket_min": EXPERT_MIN_WR},
        "n_train_picks": int(tr.sum()), "n_holdout_picks": int(te.sum()),
        "features": FEATURES, "lambda": lam,
        "mu": [round(float(v), 6) for v in mu], "sd": [round(float(v), 6) for v in sd],
        "beta": [round(float(v), 5) for v in beta],
        "beta_context_only": [round(float(v), 5) for v in theta_f],
        "intercepts": {n: round(float(v), 4) for n, v in zip(names, a)},
        "value_model": {"features": VALUE_FEATURES, "beta": [round(float(v), 5) for v in theta_v]},
        "intercept_fallback_by_rarity": rarity_fb,
    }
    config.models_dir().mkdir(parents=True, exist_ok=True)
    with open(config.models_dir() / f"{set_code}.json", "w") as fh:
        json.dump(model, fh, indent=1)
    val = {
        "set": set_code, "generated_at": model["generated_at"],
        "expert_definition": model["expert_definition"],
        "expert_drafts_available": n_expert, "drafts_in_file": n_all,
        "drafts_used": int(len(np.unique(arr["draft"]))), "train_picks": int(tr.sum()), "holdout_picks": int(te.sum()),
        "lambda_selection_nll": {str(k): v for k, v in lam_scores.items()}, "lambda": lam,
        "coefficients_standardized": dict(zip(FEATURES, [round(float(v), 4) for v in beta])),
        "coefficients_context_only_model": dict(zip(FEATURES, [round(float(v), 4) for v in theta_f])),
        "coefficients_value_model": dict(zip(VALUE_FEATURES, [round(float(v), 4) for v in theta_v])),
        "results": results, "seconds": round(time.time() - t0, 1),
    }
    config.results_dir().mkdir(parents=True, exist_ok=True)
    with open(config.results_dir() / f"validation-{set_code}.json", "w") as fh:
        json.dump(val, fh, indent=1)
    print(f"[{set_code}] done in {time.time()-t0:.0f}s", flush=True)
    return val
