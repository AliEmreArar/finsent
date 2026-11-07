"""Gold lab: what about gold is actually predictable? (range/volatility, trend rules, small models)."""
import numpy as np, pandas as pd
from sklearn.linear_model import LogisticRegression, LinearRegression, QuantileRegressor
from sklearn.metrics import roc_auc_score
from finsent.gold_forecast import download, features

raw = download()
for target in ("XAUUSD", "ALTIN"):
    df, feats = features(raw, target)
    r = df["ret_1"]
    print(f"\n===== {target}  {df.index[0].date()} .. {df.index[-1].date()}")
    # 1) trend rules (signal at close t, earn t+1), 5bp per switch
    nxt = r.shift(-1).fillna(0)
    rules = {"buyhold": pd.Series(1.0, index=df.index),
             "px>sma200": (df["g_d_sma200"] > 0).astype(float),
             "px>sma50": (df["g_d_sma50"] > 0).astype(float),
             "mom12m>0": (df["g_ret_250"] > 0).astype(float),
             "mom3m>0": (df["g_ret_60"] > 0).astype(float),
             "dxy<sma200": (df["dxy_d_sma200"] < 0).astype(float)}
    sub = df.index >= "2012-01-01"
    for k, pos in rules.items():
        s = (pos * nxt - pos.diff().abs().fillna(0) * 0.0005)[sub]
        eq = (1 + s).cumprod(); yrs = len(s) / 252
        print(f"  {k:12s} cagr={eq.iloc[-1]**(1/yrs)-1:+.3f} sharpe={s.mean()/s.std()*np.sqrt(252):.2f} maxdd={(eq/eq.cummax()-1).min():+.2f} in={pos[sub].mean():.2f}")
    # 2) volatility predictability: forecast next-20d realized vol from past vol
    fut = r[::-1].rolling(20).std()[::-1].shift(-1) * np.sqrt(252)
    d = pd.DataFrame({"fut": fut, "v20": df["g_vol20"], "v60": r.rolling(60).std() * np.sqrt(252),
                      "v5": r.rolling(5).std() * np.sqrt(252), "vix": df["vix"]}).dropna()
    tr, te = d.index < "2016-01-01", d.index >= "2016-01-01"
    X = ["v5", "v20", "v60", "vix"]
    lr = LinearRegression().fit(np.log(d.loc[tr, X]), np.log(d.loc[tr, "fut"]))
    pred = np.exp(lr.predict(np.log(d.loc[te, X])))
    print(f"  vol20 forecast OOS(2016+): corr={np.corrcoef(pred, d.loc[te,'fut'])[0,1]:.2f}  naive(v20) corr={np.corrcoef(d.loc[te,'v20'], d.loc[te,'fut'])[0,1]:.2f}"
          f"  MAPE={np.mean(np.abs(pred/d.loc[te,'fut']-1)):.2f}")
    # 3) range coverage: band = +-z * vol_forecast * sqrt(h/252)
    for h in (5, 20):
        dd = df[["g_vol20", f"fwd_{h}"]].join(d[X]).dropna()
        dd = dd[dd.index >= "2016-01-01"]
        vf = np.exp(lr.predict(np.log(dd[X])))
        for q, z in ((0.68, 1.0), (0.9, 1.645)):
            band = z * vf * np.sqrt(h / 252)
            print(f"  h={h:2d} {int(q*100)}% band avg ±{band.mean():.3f} coverage={(dd[f'fwd_{h}'].abs() <= band).mean():.3f}")
    # 4) tiny macro logit (4 features) for 20d direction, yearly walk-forward
    small = ["g_ret_250", "g_d_sma200", "dxy_ret_20", "y10_chg_20"] + (["fx_ret_60"] if target == "ALTIN" else [])
    dd = df.dropna(subset=small + ["fwd_20"]); y = (dd["fwd_20"] > 0).astype(int); ps = []
    for yr in range(2012, 2027):
        trm = dd.index < pd.Timestamp(yr, 1, 1) - pd.Timedelta(days=35); tem = dd.index.year == yr
        if tem.sum() < 20: continue
        m = LogisticRegression(C=0.1, max_iter=1000).fit((dd.loc[trm, small] - dd.loc[trm, small].mean()) / dd.loc[trm, small].std(), y[trm])
        ps.append(pd.Series(m.predict_proba((dd.loc[tem, small] - dd.loc[trm, small].mean()) / dd.loc[trm, small].std())[:, 1], index=dd.index[tem]))
    p = pd.concat(ps); print(f"  small logit h20 AUC={roc_auc_score(y[p.index], p):.3f}")
