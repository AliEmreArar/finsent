"""Forecast research harness: walk-forward evaluation of feature/target/model variants.

usage: python scripts/forecast_lab.py <experiment> [<experiment> ...]

Expects data/research/raw.parquet (market.extract_market for 2004..today); results go to
data/research/results.json. See docs/forecast_research.md.
"""
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import roc_auc_score

HERE = Path(__file__).resolve().parents[1] / "data" / "research"
HORIZONS = (1, 5, 20)
FOLDS = [("2022-01-01", "2023-01-01"), ("2023-01-01", "2024-01-01"),
         ("2024-01-01", "2025-01-01"), ("2025-01-01", "2026-12-31")]
TRAIN_START = "2008-01-01"

BASE = ["ret_5", "ret_20", "ret_60", "rel_20", "vol_20", "rsi_14", "macd_n", "bb_pos",
        "d_sma50", "d_sma200", "vol_ratio", "pos_52w", "idx_ret_5", "idx_ret_20"]
EXT = BASE + ["ret_1", "ret_3", "ret_120", "ret_250", "mom_12_1", "max_ret_20", "min_ret_20",
              "vol_60", "vol_ratio_20_60", "amihud_20", "turnover_20", "log_mcap", "log_price",
              "idx_vol_20", "idx_ret_60", "usd_ret_5", "usd_ret_20", "beta_60", "resid_ret_20",
              "dist_hi_252", "up_days_20", "dow"]
CS = ["ret_1", "ret_5", "ret_20", "ret_60", "ret_250", "mom_12_1", "vol_20", "vol_60", "rsi_14",
      "bb_pos", "d_sma50", "d_sma200", "vol_ratio", "pos_52w", "max_ret_20", "amihud_20",
      "turnover_20", "log_mcap", "beta_60", "resid_ret_20", "dist_hi_252"]


def roll(g, col, w, fn, mp=None):
    return g[col].transform(lambda s: getattr(s.rolling(w, min_periods=mp or max(2, w // 2)), fn)())


def build(df: pd.DataFrame) -> pd.DataFrame:
    df = df.sort_values(["symbol", "trade_date"]).reset_index(drop=True)
    for c in df.columns:
        if c not in ("symbol", "trade_date", "source", "open_is_estimated"):
            df[c] = pd.to_numeric(df[c], errors="coerce").astype("float64")
    df["trade_date"] = pd.to_datetime(df["trade_date"])
    g = df.groupby("symbol", sort=False)
    c = df["close"]
    df["ret_1"] = c / g["close"].shift(1) - 1
    for k in (3, 5, 20, 60, 120, 250):
        df[f"ret_{k}"] = c / g["close"].shift(k) - 1
    df["mom_12_1"] = g["close"].shift(20) / g["close"].shift(250) - 1
    for h in HORIZONS:
        df[f"fwd_{h}"] = g["close"].shift(-h) / c - 1

    idx = df.groupby("trade_date")["bist100"].median().sort_index()
    usd = df.groupby("trade_date")["usd_try"].median().sort_index().ffill()
    idx_r = idx.pct_change()
    day = pd.DataFrame({
        "idx_ret_5": idx / idx.shift(5) - 1, "idx_ret_20": idx / idx.shift(20) - 1,
        "idx_ret_60": idx / idx.shift(60) - 1, "idx_vol_20": idx_r.rolling(20).std(),
        "usd_ret_5": usd / usd.shift(5) - 1, "usd_ret_20": usd / usd.shift(20) - 1,
        "idx_r1": idx_r,
    })
    for h in HORIZONS:
        day[f"idx_fwd_{h}"] = idx.shift(-h) / idx - 1
    df = df.join(day, on="trade_date")
    df["rel_20"] = df["ret_20"] - df["idx_ret_20"]
    g = df.groupby("symbol", sort=False)

    df["vol_20"] = roll(g, "ret_1", 20, "std", 15)
    df["vol_60"] = roll(g, "ret_1", 60, "std", 40)
    df["vol_ratio_20_60"] = df["vol_20"] / df["vol_60"]
    df["max_ret_20"] = roll(g, "ret_1", 20, "max", 15)
    df["min_ret_20"] = roll(g, "ret_1", 20, "min", 15)
    df["up_days_20"] = g["ret_1"].transform(lambda s: (s > 0).astype(float).rolling(20, min_periods=15).mean())
    avg_vol = g["volume_try"].transform(lambda s: s.rolling(20, min_periods=10).mean().shift(1))
    df["vol_ratio"] = np.log1p(df["volume_try"] / avg_vol.replace(0, np.nan))
    df["amihud_20"] = np.log1p(1e9 * (df["ret_1"].abs() / df["volume_try"].replace(0, np.nan))
                               .groupby(df["symbol"]).transform(lambda s: s.rolling(20, min_periods=10).mean()))
    df["turnover_20"] = np.log((avg_vol / df["market_cap_try"]).replace(0, np.nan))
    df["log_mcap"] = np.log(df["market_cap_try"].replace(0, np.nan))
    df["log_price"] = np.log(c)
    hi = roll(g, "high", 252, "max", 60)
    lo = roll(g, "low", 252, "min", 60)
    df["pos_52w"] = (c - lo) / (hi - lo).replace(0, np.nan)
    df["dist_hi_252"] = c / hi - 1
    df["macd_n"] = df["macd_hist"] / c
    df["bb_pos"] = (c - df["bb_lower"]) / (df["bb_upper"] - df["bb_lower"]).replace(0, np.nan)
    df["d_sma50"] = c / df["sma_50"] - 1
    df["d_sma200"] = c / df["sma_200"] - 1
    # 60-day beta to the index and the residual 20-day return
    cov = (df["ret_1"] * df["idx_r1"]).groupby(df["symbol"]).transform(lambda s: s.rolling(60, min_periods=40).mean()) \
        - roll(g, "ret_1", 60, "mean", 40) * df.groupby("symbol")["idx_r1"].transform(lambda s: s.rolling(60, min_periods=40).mean())
    var = df.groupby("symbol")["idx_r1"].transform(lambda s: s.rolling(60, min_periods=40).var())
    df["beta_60"] = (cov / var).clip(-3, 5)
    df["resid_ret_20"] = df["ret_20"] - df["beta_60"] * df["idx_ret_20"]
    df["dow"] = df["trade_date"].dt.dayofweek.astype(float)

    # corporate-action guard (same as production)
    jump = (df["ret_1"].abs() > 0.25).astype(float)
    back = jump.groupby(df["symbol"]).transform(lambda s: s.rolling(60, min_periods=1).max())
    ahead = jump.groupby(df["symbol"]).transform(lambda s: s[::-1].rolling(21, min_periods=1).max()[::-1])
    df["clean"] = (back == 0) & (ahead == 0)
    # tradability: skip names with tiny turnover (prices there are noise)
    df["liquid"] = avg_vol > 5e6

    feats = list(dict.fromkeys(EXT))
    df[feats] = df[feats].replace([np.inf, -np.inf], np.nan)
    # cross-sectional percentile ranks per day
    for f in CS:
        df[f"cs_{f}"] = df.groupby("trade_date")[f].rank(pct=True)
    for h in HORIZONS:
        df[f"xs_{h}"] = df[f"fwd_{h}"] - df[f"idx_fwd_{h}"]
    return df


def metrics(d, p, ycol, retcol):
    y = d[ycol].to_numpy()
    base = y.mean()
    brier = np.mean((p - y) ** 2)
    brier_clim = np.mean((d["_clim"].to_numpy() - y) ** 2)
    tmp = pd.DataFrame({"date": d["trade_date"].to_numpy(), "p": p, "r": d[retcol].to_numpy()})
    ic = tmp.groupby("date").apply(lambda x: x["p"].corr(x["r"], method="spearman") if len(x) > 20 else np.nan).dropna()

    def spread(x):
        if len(x) < 50:
            return np.nan
        q = x["p"].rank(pct=True)
        return x.loc[q >= 0.9, "r"].mean() - x.loc[q <= 0.1, "r"].mean()
    sp = tmp.groupby("date").apply(spread).dropna()
    tmp["y"] = y
    top = tmp[tmp.groupby("date")["p"].rank(pct=True) >= 0.9]
    bot = tmp[tmp.groupby("date")["p"].rank(pct=True) <= 0.1]
    # reliability: predicted vs realised rate in 5 probability bins
    bins = pd.cut(p, [0, .4, .47, .53, .6, 1])
    rel = pd.DataFrame({"b": bins, "p": p, "y": y}).groupby("b", observed=True).agg(p=("p", "mean"), y=("y", "mean"), n=("y", "size"))
    return {"auc": roc_auc_score(y, p), "acc": float(((p > 0.5) == y).mean()), "base": float(base),
            "top_hit": float(top["y"].mean()), "bot_hit": float(bot["y"].mean()),
            "calib_gap": float((rel["p"] - rel["y"]).abs().mul(rel["n"]).sum() / rel["n"].sum()),
            "bss": float(1 - brier / brier_clim), "ic": float(ic.mean()), "ic_t": float(ic.mean() / ic.std() * np.sqrt(len(ic))),
            "spread": float(sp.mean())}


def tw(frame, half_life_years):
    if not half_life_years:
        return None
    age = (frame["trade_date"].max() - frame["trade_date"]).dt.days / 365.25
    return np.power(0.5, age / half_life_years).to_numpy()


def run(df, name, feats, target="abs", params=None, liquid_only=False, horizons=HORIZONS, calibrate=False, half_life=None):
    params = params or dict(max_iter=250, learning_rate=0.05, max_leaf_nodes=31, min_samples_leaf=400,
                            l2_regularization=1.0, early_stopping=False, random_state=7)
    res = {}
    for h in horizons:
        ycol = f"y_{target}_{h}"
        retcol = f"fwd_{h}" if target == "abs" else f"xs_{h}"
        df[ycol] = (df[retcol] > 0).astype(float)
        dd = df[df["clean"] & df[retcol].notna() & (df["trade_date"] >= TRAIN_START)]
        if liquid_only:
            dd = dd[dd["liquid"]]
        fold_m = []
        for a, b in FOLDS:
            a, b = pd.Timestamp(a), pd.Timestamp(b)
            gap = pd.Timedelta(days=int(h * 1.5) + 2)
            tr = dd[(dd["trade_date"] < a - gap)]
            tr = tr[tr.groupby("symbol").cumcount() % 3 == 0]
            te = dd[(dd["trade_date"] >= a) & (dd["trade_date"] < b)].copy()
            if calibrate:
                # time-respecting: fit on older data, calibrate on the most recent year before the test fold
                cut = a - gap - pd.Timedelta(days=365)
                fit, cal = tr[tr["trade_date"] < cut - gap], tr[tr["trade_date"] >= cut]
                clf = HistGradientBoostingClassifier(**params).fit(fit[feats], fit[ycol], sample_weight=tw(fit, half_life))
                from sklearn.isotonic import IsotonicRegression
                iso = IsotonicRegression(out_of_bounds="clip", y_min=0.02, y_max=0.98).fit(
                    clf.predict_proba(cal[feats])[:, 1], cal[ycol])
                raw = clf.predict_proba(te[feats])[:, 1]
                # keep ranking information: blend calibrated level with a tiny raw tiebreaker
                p = np.clip(iso.predict(raw) + (raw - raw.mean()) * 1e-3, 0, 1)
            else:
                clf = HistGradientBoostingClassifier(**params).fit(tr[feats], tr[ycol])
                p = clf.predict_proba(te[feats])[:, 1]
            te["_clim"] = tr[ycol].mean()
            fold_m.append(metrics(te, p, ycol, retcol))
        avg = {k: float(np.nanmean([m[k] for m in fold_m])) for k in fold_m[0]}
        avg["folds_auc"] = [round(m["auc"], 4) for m in fold_m]
        res[h] = avg
        print(f"[{name}] h={h} " + " ".join(f"{k}={v:.4f}" if isinstance(v, float) else f"{k}={v}" for k, v in avg.items()), flush=True)
    return res


REG = dict(max_iter=200, learning_rate=0.03, max_leaf_nodes=15, min_samples_leaf=3000,
           l2_regularization=5.0, early_stopping=False, random_state=7)
FULL = EXT + [f"cs_{f}" for f in CS]
BIG = dict(max_iter=400, learning_rate=0.03, max_leaf_nodes=31, min_samples_leaf=1500,
           l2_regularization=5.0, early_stopping=False, random_state=7)
EXPERIMENTS = {
    "E12_full_abs_big_cal": lambda d: run(d, "E12_full_abs_big_cal", FULL, "abs", BIG, calibrate=True),
    "E13_full_abs_reg_cal_tw": lambda d: run(d, "E13_full_abs_reg_cal_tw", FULL, "abs", REG, calibrate=True, half_life=4),
    "E14_full_xs_big_cal": lambda d: run(d, "E14_full_xs_big_cal", FULL, "xs", BIG, calibrate=True),
    "E15_full_xs_reg_cal_tw": lambda d: run(d, "E15_full_xs_reg_cal_tw", FULL, "xs", REG, calibrate=True, half_life=4),
    "E7_full_abs_reg": lambda d: run(d, "E7_full_abs_reg", FULL, "abs", REG),
    "E8_full_abs_reg_cal": lambda d: run(d, "E8_full_abs_reg_cal", FULL, "abs", REG, calibrate=True),
    "E9_full_xs_reg_cal": lambda d: run(d, "E9_full_xs_reg_cal", FULL, "xs", REG, calibrate=True),
    "E10_full_xs_liq_reg_cal": lambda d: run(d, "E10_full_xs_liq_reg_cal", FULL, "xs", REG, liquid_only=True, calibrate=True),
    "E11_base_abs_cal": lambda d: run(d, "E11_base_abs_cal", BASE, "abs", calibrate=True),
    "E0_base_abs": lambda d: run(d, "E0_base_abs", BASE, "abs"),
    "E1_base_xs": lambda d: run(d, "E1_base_xs", BASE, "xs"),
    "E2_ext_abs": lambda d: run(d, "E2_ext_abs", EXT, "abs"),
    "E3_ext_xs": lambda d: run(d, "E3_ext_xs", EXT, "xs"),
    "E4_extcs_xs": lambda d: run(d, "E4_extcs_xs", EXT + [f"cs_{f}" for f in CS], "xs"),
    "E5_extcs_abs": lambda d: run(d, "E5_extcs_abs", EXT + [f"cs_{f}" for f in CS], "abs"),
    "E6_extcs_xs_liq": lambda d: run(d, "E6_extcs_xs_liq", EXT + [f"cs_{f}" for f in CS], "xs", liquid_only=True),
}

if __name__ == "__main__":
    t = time.time()
    cache = HERE / "features.parquet"
    if cache.exists():
        df = pd.read_parquet(cache)
    else:
        df = build(pd.read_parquet(HERE / "raw.parquet"))
        df.to_parquet(cache, index=False)
    print(f"features ready {df.shape} in {time.time() - t:.0f}s", flush=True)
    out = {}
    for e in sys.argv[1:]:
        t = time.time()
        out[e] = EXPERIMENTS[e](df)
        print(f"  ({e} took {time.time() - t:.0f}s)", flush=True)
    res_file = HERE / "results.json"
    prev = json.loads(res_file.read_text()) if res_file.exists() else {}
    prev.update({k: {str(h): v for h, v in r.items()} for k, r in out.items()})
    res_file.write_text(json.dumps(prev, indent=1))
