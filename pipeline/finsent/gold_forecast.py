"""Gold direction model: ounce gold (XAUUSD) and gram gold in TL (ALTIN).

Unlike the stock model (which ranks stocks against each other), gold is a single macro asset,
so this model uses gold's own price action plus the usual drivers: the dollar index, US 10-year
yield, VIX, oil, S&P 500, copper, the gold/silver ratio and, for gram gold, USD/TRY.

Research finding (walk-forward by calendar year, 2012+): gold's *direction* is not predictable
from these inputs (AUC ~0.50 for logit, gradient boosting and their average; no long/flat or
trend rule beat buy-and-hold). Its *volatility* is, so production forecasts a calibrated price
range per horizon (vol regression + empirical quantiles of standardised returns) and reports the
direction study, trend-rule backtests and a macro driver snapshot honestly alongside it.

    python -m finsent.gold_forecast --research     # walk-forward study -> MLflow + JSON
    python -m finsent.gold_forecast                # fit, forecast, write to MySQL `forecasts`
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import numpy as np
import pandas as pd

log = logging.getLogger("finsent.gold")
OZ = 31.1034768
HORIZONS = (1, 5, 20)
TICKERS = {"GOLD": "GC=F", "SILVER": "SI=F", "DXY": "DX-Y.NYB", "US10Y": "^TNX", "VIX": "^VIX",
           "OIL": "CL=F", "SPX": "^GSPC", "COPPER": "HG=F", "USDTRY": "USDTRY=X"}
TARGETS = {"XAUUSD": {"start": "2001-06-01", "name": "Ons altın"}, "ALTIN": {"start": "2006-06-01", "name": "Gram altın"}}
LABELS = {
    "g_ret_5": "altının son 1 haftalık getirisi", "g_ret_20": "altının son 1 aylık getirisi", "g_ret_60": "altının son 3 aylık getirisi",
    "g_ret_250": "altının 1 yıllık getirisi", "g_rsi": "altının RSI'ı", "g_d_sma50": "altının 50 günlük ortalamaya uzaklığı",
    "g_d_sma200": "altının 200 günlük ortalamaya uzaklığı", "g_dist_hi": "altının zirveye uzaklığı", "g_vol20": "altının oynaklığı",
    "g_up20": "son 20 günün yükselen gün oranı", "dxy_ret_5": "doların (DXY) 1 haftalık hareketi", "dxy_ret_20": "doların (DXY) 1 aylık hareketi",
    "dxy_d_sma200": "doların uzun vadeli trendi", "y10_chg_5": "ABD 10y faizinin 1 haftalık değişimi", "y10_chg_20": "ABD 10y faizinin 1 aylık değişimi",
    "y10_level": "ABD 10y faiz seviyesi", "vix": "VIX (korku endeksi)", "vix_chg_5": "VIX'in 1 haftalık değişimi", "oil_ret_20": "petrolün 1 aylık getirisi",
    "spx_ret_5": "S&P 500'ün 1 haftalık getirisi", "spx_ret_20": "S&P 500'ün 1 aylık getirisi", "cu_ret_20": "bakırın 1 aylık getirisi",
    "gsr_z": "altın/gümüş oranının normaline göre konumu", "gsr_ret_20": "altın/gümüş oranının 1 aylık değişimi",
    "fx_ret_5": "USD/TRY'nin 1 haftalık hareketi", "fx_ret_20": "USD/TRY'nin 1 aylık hareketi", "fx_ret_60": "USD/TRY'nin 3 aylık hareketi",
    "month": "mevsimsellik (ay)",
}


def download() -> pd.DataFrame:
    import yfinance as yf

    cols = {}
    for k, t in TICKERS.items():
        d = yf.download(t, period="max", interval="1d", progress=False, auto_adjust=False)
        if isinstance(d.columns, pd.MultiIndex):
            d.columns = d.columns.get_level_values(0)
        cols[k] = d["Close"].astype(float)
        if k == "GOLD":
            cols["GOLD_H"], cols["GOLD_L"] = d["High"].astype(float), d["Low"].astype(float)
    df = pd.DataFrame(cols)
    df.index = pd.to_datetime(df.index).tz_localize(None).normalize()
    df = df[df["GOLD"].notna()].sort_index()
    return df.ffill(limit=5)


def rsi(s: pd.Series, n: int = 14) -> pd.Series:
    d = s.diff()
    up, dn = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean(), (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    return 100 - 100 / (1 + up / dn.replace(0, np.nan))


def features(raw: pd.DataFrame, target: str) -> tuple[pd.DataFrame, list[str]]:
    df = pd.DataFrame(index=raw.index)
    px = raw["GOLD"] * raw["USDTRY"] / OZ if target == "ALTIN" else raw["GOLD"]
    df["px"] = px
    r = px.pct_change()
    for k in (5, 20, 60, 250):
        df[f"g_ret_{k}"] = px / px.shift(k) - 1
    df["g_rsi"] = rsi(px)
    df["g_d_sma50"] = px / px.rolling(50).mean() - 1
    df["g_d_sma200"] = px / px.rolling(200).mean() - 1
    df["g_dist_hi"] = px / px.rolling(250, min_periods=60).max() - 1
    df["g_vol20"] = r.rolling(20).std() * np.sqrt(252)
    df["g_up20"] = (r > 0).astype(float).rolling(20).mean()
    df["dxy_ret_5"], df["dxy_ret_20"] = raw["DXY"].pct_change(5), raw["DXY"].pct_change(20)
    df["dxy_d_sma200"] = raw["DXY"] / raw["DXY"].rolling(200).mean() - 1
    df["y10_chg_5"], df["y10_chg_20"], df["y10_level"] = raw["US10Y"].diff(5), raw["US10Y"].diff(20), raw["US10Y"]
    df["vix"], df["vix_chg_5"] = raw["VIX"], raw["VIX"].diff(5)
    df["oil_ret_20"] = raw["OIL"].pct_change(20).clip(-0.8, 2)
    df["spx_ret_5"], df["spx_ret_20"] = raw["SPX"].pct_change(5), raw["SPX"].pct_change(20)
    df["cu_ret_20"] = raw["COPPER"].pct_change(20)
    gsr = raw["GOLD"] / raw["SILVER"]
    df["gsr_z"] = (gsr - gsr.rolling(250).mean()) / gsr.rolling(250).std()
    df["gsr_ret_20"] = gsr.pct_change(20)
    feats = [c for c in df.columns if c != "px"]
    if target == "ALTIN":
        for k in (5, 20, 60):
            df[f"fx_ret_{k}"] = raw["USDTRY"].pct_change(k)
        feats += ["fx_ret_5", "fx_ret_20", "fx_ret_60"]
    df["month"] = df.index.month.astype(float)
    feats.append("month")
    for h in HORIZONS:
        df[f"fwd_{h}"] = px.shift(-h) / px - 1
    df["ret_1"] = r
    df = df[df.index >= TARGETS[target]["start"]].replace([np.inf, -np.inf], np.nan)
    return df, feats


def models():
    from sklearn.ensemble import HistGradientBoostingClassifier
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    from sklearn.impute import SimpleImputer

    return {
        "logit": lambda: make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), LogisticRegression(C=0.05, max_iter=2000)),
        "gbm": lambda: HistGradientBoostingClassifier(max_iter=150, learning_rate=0.03, max_leaf_nodes=8, min_samples_leaf=150,
                                                      l2_regularization=3.0, random_state=7),
    }


def walk_forward(df: pd.DataFrame, feats: list[str], h: int, first_test_year: int = 2012) -> pd.DataFrame:
    """Out-of-sample predictions for every test year (expanding training window, h-day gap)."""
    d = df.dropna(subset=[f"fwd_{h}"])
    y = (d[f"fwd_{h}"] > 0).astype(int)
    out = []
    for year in range(first_test_year, d.index.max().year + 1):
        start, end = pd.Timestamp(year, 1, 1), pd.Timestamp(year + 1, 1, 1)
        tr = d.index < start - pd.Timedelta(days=int(h * 1.5) + 3)
        te = (d.index >= start) & (d.index < end)
        if te.sum() < 20:
            continue
        row = pd.DataFrame(index=d.index[te])
        row["y"], row["ret"], row["fwd"] = y[te], d.loc[te, "ret_1"], d.loc[te, f"fwd_{h}"]
        row["base"] = y[tr].mean()
        for name, mk in models().items():
            m = mk().fit(d.loc[tr, feats], y[tr])
            row[name] = m.predict_proba(d.loc[te, feats])[:, 1]
        row["ensemble"] = (row["logit"] + row["gbm"]) / 2
        out.append(row)
    return pd.concat(out)


def evaluate(pred: pd.DataFrame, h: int, cost: float = 0.0005) -> dict:
    from sklearn.metrics import roc_auc_score

    res = {}
    for m in ("logit", "gbm", "ensemble"):
        p, y = pred[m].to_numpy(), pred["y"].to_numpy()
        brier, brier0 = np.mean((p - y) ** 2), np.mean((pred["base"].to_numpy() - y) ** 2)
        yearly = pred.groupby(pred.index.year).apply(lambda g: roc_auc_score(g["y"], g[m]) if g["y"].nunique() > 1 else np.nan)
        # long/flat: hold gold the next day while P(up over h days) > 0.5
        pos = (pred[m] > 0.5).astype(float).shift(1).fillna(0)
        daily = pred["ret"].shift(-1).fillna(0)   # return earned the day after the signal
        strat = pos * daily - pos.diff().abs().fillna(0) * cost
        eq, bh = (1 + strat).cumprod(), (1 + daily).cumprod()
        yrs = len(pred) / 252
        res[m] = {"auc": float(roc_auc_score(y, p)), "accuracy": float(((p > 0.5) == y).mean()), "base_rate": float(y.mean()),
                  "always_up_accuracy": float(max(y.mean(), 1 - y.mean())), "brier_skill": float(1 - brier / brier0),
                  "years_auc_above_0_5": float((yearly > 0.5).mean()), "yearly_auc": {int(k): round(float(v), 3) for k, v in yearly.items()},
                  "strategy_cagr": float(eq.iloc[-1] ** (1 / yrs) - 1), "buyhold_cagr": float(bh.iloc[-1] ** (1 / yrs) - 1),
                  "strategy_maxdd": float((eq / eq.cummax() - 1).min()), "buyhold_maxdd": float((bh / bh.cummax() - 1).min()),
                  "strategy_sharpe": float(strat.mean() / strat.std() * np.sqrt(252)) if strat.std() else None,
                  "buyhold_sharpe": float(daily.mean() / daily.std() * np.sqrt(252)),
                  "time_in_market": float(pos.mean())}
    return res


VOL_X = ["v5", "v20", "v60", "vix"]
QUANTS = (0.05, 0.16, 0.5, 0.84, 0.95)
DRIVERS = [("dxy_ret_20", "Dolar endeksi (DXY), 1 ay", "pct", -1), ("y10_chg_20", "ABD 10y faiz, 1 ay değişim", "bp", -1),
           ("vix", "VIX korku endeksi", "lvl", 1), ("spx_ret_20", "S&P 500, 1 ay", "pct", 0), ("oil_ret_20", "Petrol, 1 ay", "pct", 1),
           ("gsr_z", "Altın/gümüş oranı (z-skor)", "z", 0), ("fx_ret_20", "USD/TRY, 1 ay", "pct", 1)]


def vol_frame(df: pd.DataFrame) -> pd.DataFrame:
    r = df["ret_1"]
    return pd.DataFrame({"v5": r.rolling(5).std(), "v20": r.rolling(20).std(), "v60": r.rolling(60).std(),
                         "vix": df["vix"] / 100 / np.sqrt(252), "fut": r[::-1].rolling(20).std()[::-1].shift(-1)}, index=df.index) * np.sqrt(252)


def fit_range(df: pd.DataFrame, end: pd.Timestamp | None = None) -> dict:
    """Vol model (log-linear on past vols + VIX) and, per horizon, empirical quantiles of the
    standardised forward return z = fwd_h / (vol_forecast * sqrt(h/252)) over the last 10 years.
    The quantiles carry drift (gram gold rises with the lira's fall) and fat tails."""
    from sklearn.linear_model import LinearRegression

    v = vol_frame(df)
    m = v.index < end if end is not None else np.ones(len(v), bool)
    cut_fut = (end or df.index[-1]) - pd.Timedelta(days=35)
    d = v[m & (v.index < cut_fut)].dropna()
    reg = LinearRegression().fit(np.log(d[VOL_X].clip(lower=1e-4)), np.log(d["fut"].clip(lower=1e-4)))
    vf = pd.Series(np.exp(reg.predict(np.log(v[VOL_X].clip(lower=1e-4).fillna(v[VOL_X].median())))), index=v.index)
    q = {}
    for h in HORIZONS:
        z = (df[f"fwd_{h}"] / (vf * np.sqrt(h / 252)))[m]
        cut = (end or df.index[-1]) - pd.Timedelta(days=int(h * 1.5) + 3)
        z = z[(z.index < cut) & (z.index >= cut - pd.DateOffset(years=10))].dropna()
        q[h] = z.quantile(list(QUANTS)).to_numpy()
    return {"reg": reg, "vf": vf, "q": q}


def range_walk_forward(df: pd.DataFrame, first_test_year: int = 2012) -> dict:
    out = {h: [] for h in HORIZONS}
    for year in range(first_test_year, df.index.max().year + 1):
        start = pd.Timestamp(year, 1, 1)
        te = (df.index >= start) & (df.index < pd.Timestamp(year + 1, 1, 1))
        if te.sum() < 20:
            continue
        fr = fit_range(df, start)
        for h in HORIZONS:
            sc = fr["vf"][te] * np.sqrt(h / 252)
            f = df.loc[te, f"fwd_{h}"]
            ok = f.notna()
            lo90, lo68, hi68, hi90 = (fr["q"][h][i] * sc for i in (0, 1, 3, 4))
            out[h].append(pd.DataFrame({"in68": (f >= lo68) & (f <= hi68), "in90": (f >= lo90) & (f <= hi90),
                                        "w68": hi68 - lo68, "w90": hi90 - lo90, "above": f > hi90, "below": f < lo90})[ok])
    res = {}
    for h, parts in out.items():
        a = pd.concat(parts)
        res[h] = {"coverage_68": float(a["in68"].mean()), "coverage_90": float(a["in90"].mean()), "avg_width_68": float(a["w68"].mean()),
                  "avg_width_90": float(a["w90"].mean()), "breach_up_90": float(a["above"].mean()), "breach_down_90": float(a["below"].mean()),
                  "n": int(len(a))}
    return res


def trend_rules(df: pd.DataFrame, since: str = "2012-01-01", cost: float = 0.0005) -> dict:
    nxt = df["ret_1"].shift(-1).fillna(0)
    rules = {"Al-tut": pd.Series(1.0, index=df.index), "Fiyat > 200g ort.": (df["g_d_sma200"] > 0).astype(float),
             "Fiyat > 50g ort.": (df["g_d_sma50"] > 0).astype(float), "12 ay momentum > 0": (df["g_ret_250"] > 0).astype(float),
             "3 ay momentum > 0": (df["g_ret_60"] > 0).astype(float), "DXY < 200g ort.": (df["dxy_d_sma200"] < 0).astype(float)}
    sub = df.index >= since
    res = {}
    for k, pos in rules.items():
        s = (pos * nxt - pos.diff().abs().fillna(0) * cost)[sub]
        eq, yrs = (1 + s).cumprod(), sub.sum() / 252
        res[k] = {"cagr": float(eq.iloc[-1] ** (1 / yrs) - 1), "sharpe": float(s.mean() / s.std() * np.sqrt(252)),
                  "maxdd": float((eq / eq.cummax() - 1).min()), "time_in_market": float(pos[sub].mean())}
    return res


def research() -> dict:
    raw = download()
    out = {}
    for target in TARGETS:
        df, feats = features(raw, target)
        direction = {}
        for h in HORIZONS:
            e = evaluate(walk_forward(df, feats, h), h)
            direction[h] = e
            summary = "  ".join(f"{m}: auc={v['auc']:.3f} acc={v['accuracy']:.3f}/{v['always_up_accuracy']:.3f} "
                                f"cagr={v['strategy_cagr']:+.3f} vs {v['buyhold_cagr']:+.3f}" for m, v in e.items())
            log.info("%s direction h=%d  %s", target, h, summary)
        rng = range_walk_forward(df)
        for h, v in rng.items():
            log.info("%s range h=%d  cov68=%.3f cov90=%.3f width90=%.3f", target, h, v["coverage_68"], v["coverage_90"], v["avg_width_90"])
        out[target] = {"direction": direction, "range": rng, "rules": trend_rules(df)}
    if os.environ.get("MLFLOW_TRACKING_URI"):
        try:
            import mlflow
            mlflow.set_experiment("finsent-gold-forecast")
            for target, st in out.items():
                for h, by_m in st["direction"].items():
                    for m, v in by_m.items():
                        with mlflow.start_run(run_name=f"{target}_dir_h{h}_{m}"):
                            mlflow.set_tags({"target": target, "horizon": h, "model": m, "task": "direction", "evaluation": "walk-forward by year 2012+"})
                            mlflow.log_metrics({k: x for k, x in v.items() if isinstance(x, (int, float)) and x is not None})
                for h, v in st["range"].items():
                    with mlflow.start_run(run_name=f"{target}_range_h{h}"):
                        mlflow.set_tags({"target": target, "horizon": h, "model": "logvol-regression + empirical z quantiles", "task": "range"})
                        mlflow.log_metrics(v)
        except Exception as e:  # noqa: BLE001
            log.warning("mlflow logging failed: %s", e)
    return out


def driver_table(df: pd.DataFrame) -> list[dict]:
    """Where each macro driver stands today vs its last 5 years, and which way that usually leans for gold."""
    rows, last5 = [], df[df.index >= df.index[-1] - pd.DateOffset(years=5)]
    for k, label, unit, lean in DRIVERS:
        if k not in df or pd.isna(df[k].iloc[-1]):
            continue
        v = float(df[k].iloc[-1])
        pct = float((last5[k].dropna() <= v).mean())
        tilt = None
        if lean and (pct >= 0.8 or pct <= 0.2):
            tilt = "destek" if (pct >= 0.8) == (lean > 0) else "baskı"
        rows.append({"key": k, "label": label, "value": v, "unit": unit, "pctile_5y": pct, "tilt": tilt})
    return rows


def run(study: dict | None = None) -> dict:
    """Fit on all history, forecast ranges from the latest day, store in MySQL `forecasts`."""
    from .config import get_settings
    from . import mysql_sink

    if study is None:
        study = json.loads(_study_path().read_text()) if _study_path().exists() else {}
    raw = download()
    rows = []
    for target in TARGETS:
        df, feats = features(raw, target)
        st = study.get(target, {})
        fr = fit_range(df)
        close, vf = float(df["px"].iloc[-1]), float(fr["vf"].iloc[-1])
        hist_vf = fr["vf"][fr["vf"].index >= df.index[-1] - pd.DateOffset(years=5)]
        horizons = []
        for h in HORIZONS:
            sc = vf * np.sqrt(h / 252)
            qs = [float(close * (1 + z * sc)) for z in fr["q"][h]]
            y10 = df[df.index >= df.index[-1] - pd.DateOffset(years=10)][f"fwd_{h}"].dropna()
            dirv = (st.get("direction", {}).get(str(h)) or {}).get("ensemble", {})
            rv = st.get("range", {}).get(str(h), {})
            horizons.append({"days": h, "p05": qs[0], "p16": qs[1], "p50": qs[2], "p84": qs[3], "p95": qs[4],
                             "up_rate_10y": float((y10 > 0).mean()), "median_move_10y": float(y10.median()),
                             "coverage_68": rv.get("coverage_68"), "coverage_90": rv.get("coverage_90"),
                             "direction_auc": dirv.get("auc"), "direction_years_auc_above_0_5": dirv.get("years_auc_above_0_5")})
        payload = {"version": "gold-v1", "as_of": str(df.index[-1].date()), "close": close, "name": TARGETS[target]["name"],
                   "currency": "TRY" if target == "ALTIN" else "USD",
                   "vol": {"forecast_ann": vf, "pctile_5y": float((hist_vf <= vf).mean()), "realized_20d": float(df["g_vol20"].iloc[-1])},
                   "horizons": horizons, "drivers": driver_table(df), "rules": st.get("rules"),
                   "trend": {"d_sma50": float(df["g_d_sma50"].iloc[-1]), "d_sma200": float(df["g_d_sma200"].iloc[-1]),
                             "ret_20": float(df["g_ret_20"].iloc[-1]), "ret_250": float(df["g_ret_250"].iloc[-1]),
                             "rsi": float(df["g_rsi"].iloc[-1]), "dist_hi": float(df["g_dist_hi"].iloc[-1])},
                   "model": {"range": "Log-oynaklık regresyonu (5/20/60 günlük oynaklık + VIX) + son 10 yılın ampirik getiri dağılımı",
                             "direction": f"Lojistik regresyon + gradient boosting, {len(feats)} makro/teknik özellik",
                             "evaluation": "Yıl bazında ileri yürüyen test, 2012-2026"},
                   "disclaimer": "Aralıklar olasılıksaldır; %90 bandın dışına çıkış yaklaşık 10'da 1 beklenir. Yatırım tavsiyesi değildir."}
        rows.append((target, payload["as_of"], json.dumps(payload, ensure_ascii=False, default=float)))
    with mysql_sink.connect(get_settings()) as conn, conn.cursor() as cur:
        cur.executemany("REPLACE INTO forecasts (symbol, as_of, payload) VALUES (%s, %s, %s)", rows)
    return {"written": [r[0] for r in rows], "as_of": rows[0][1]}


def _study_path():
    from pathlib import Path

    from .config import get_settings
    return Path(get_settings().market_updates_path).parent.parent / "models" / "gold_study.json"


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--research", action="store_true")
    a = ap.parse_args()
    if a.research:
        res = research()
        _study_path().parent.mkdir(parents=True, exist_ok=True)
        _study_path().write_text(json.dumps(res, indent=1, default=float))
        print(json.dumps(run(json.loads(_study_path().read_text())), indent=1))
    else:
        print(json.dumps(run(), indent=1))
