"""Backtest the analog (nearest-past-days) method without leakage.

For random (symbol, day) points in 2022-2026, analogs are searched only among that
symbol's days that ended (incl. their 20-day future) before the point.
"""
import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score

HERE = __import__("pathlib").Path(__file__).resolve().parents[1] / "data" / "research"
FEAT = ["ret_5", "ret_20", "ret_60", "rel_20", "rsi_14", "bb_pos", "d_sma50", "d_sma200", "vol_ratio", "vol_20"]
df = pd.read_parquet(HERE / "features.parquet", columns=["symbol", "trade_date", "clean", "liquid"] + FEAT
                     + ["fwd_1", "fwd_5", "fwd_20", "xs_5", "xs_20"])
rng = np.random.default_rng(0)
cand = df[(df.trade_date >= "2022-01-01") & df.clean & df.liquid & df.fwd_20.notna() & df[FEAT].notna().all(axis=1)]
pts = cand.sample(4000, random_state=1)
by_sym = {s: g.reset_index(drop=True) for s, g in df[df.symbol.isin(pts.symbol.unique())].groupby("symbol")}
rows = []
for r in pts.itertuples():
    g = by_sym[r.symbol]
    hist = g[(g.trade_date < r.trade_date - pd.Timedelta(days=35)) & g.clean & g.fwd_20.notna()].dropna(subset=FEAT)
    if len(hist) < 250:
        continue
    mu, sd = hist[FEAT].mean(), hist[FEAT].std().replace(0, 1)
    z = ((hist[FEAT] - mu) / sd).to_numpy()
    zt = ((pd.Series([getattr(r, f) for f in FEAT], index=FEAT) - mu) / sd).to_numpy()
    d = np.sqrt(((z - zt) ** 2).sum(axis=1))
    order = np.argsort(d)
    picked = []
    for i in order:
        if all(abs(i - j) >= 10 for j in picked):
            picked.append(i)
        if len(picked) == 20:
            break
    an = hist.iloc[picked]
    rec = {"date": r.trade_date}
    for h in (1, 5, 20):
        rec[f"p_{h}"] = (an[f"fwd_{h}"] > 0).mean()
        rec[f"y_{h}"] = float(getattr(r, f"fwd_{h}") > 0)
        # naive baseline: the symbol's own historical up-rate
        rec[f"b_{h}"] = (hist[f"fwd_{h}"] > 0).mean()
    rec["p_xs20"] = (an["xs_20"] > 0).mean()
    rec["y_xs20"] = float(r.xs_20 > 0)
    rows.append(rec)
res = pd.DataFrame(rows)
print("points", len(res))
for h in (1, 5, 20):
    print(f"h={h} analog AUC={roc_auc_score(res[f'y_{h}'], res[f'p_{h}']):.4f}  own-base-rate AUC={roc_auc_score(res[f'y_{h}'], res[f'b_{h}']):.4f}"
          f"  hit(p>.5)={((res[f'p_{h}'] > .5) == res[f'y_{h}']).mean():.4f} base={res[f'y_{h}'].mean():.4f}")
print(f"xs20 analog AUC={roc_auc_score(res['y_xs20'], res['p_xs20']):.4f}")
