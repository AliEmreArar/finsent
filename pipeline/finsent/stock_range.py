"""Price ranges (volatility bands) for BIST stocks.

Direction is close to a coin flip for single stocks (forecast v2 AUC ~0.55), but volatility is
persistent and therefore forecastable. This module follows the gold range model
(``gold_forecast.fit_range``) for the whole stock cross-section:

1. Volatility model: one pooled log-linear regression of the next 20 days' realised volatility on
   the stock's 5/20/60-day volatility and the BIST 100's 20-day volatility.
2. Return distribution: per horizon, empirical quantiles of the standardised forward return
   ``z = fwd_h / (vol_forecast * sqrt(h/252))`` over the last 10 years, pooled over all stocks and
   bucketed by forecast-volatility tercile (calm and wild stocks have differently shaped tails).
3. Bands: ``close * (1 + q * vol_forecast * sqrt(h/252))`` for p05/p16/p50/p84/p95.

Days around a corporate action (|daily move| > 25%, impossible under BIST's ±10% limit) are left
out of fitting, so splits/bonus issues in the unadjusted prices do not fatten the tails.
``walk_forward`` measures the band coverage year by year with models fitted on prior data only.
"""
from __future__ import annotations

import logging

import numpy as np
import pandas as pd

log = logging.getLogger(__name__)

VERSION = "range-v1"
HORIZONS = (1, 5, 20)
QUANTS = (0.05, 0.16, 0.5, 0.84, 0.95)
VOL_X = ["v5", "v20", "v60", "idx_v20"]
N_BUCKETS = 3
LOOKBACK_YEARS = 10
JUMP = 0.25
ANN = np.sqrt(252)


def range_frame(df: pd.DataFrame) -> pd.DataFrame:
    """Per (symbol, day): annualised past vols, market vol, next-20-day realised vol, forward
    returns and a ``clean`` flag. ``df`` needs symbol, trade_date, close and bist100 columns
    (instrument rows, if any, should be filtered out by the caller)."""
    d = df[["symbol", "trade_date", "close", "bist100"]].copy()
    d["trade_date"] = pd.to_datetime(d["trade_date"])
    d["close"] = pd.to_numeric(d["close"], errors="coerce")
    d = d[d["close"] > 0].sort_values(["symbol", "trade_date"]).reset_index(drop=True)
    g = d.groupby("symbol", sort=False)
    d["ret_1"] = d["close"] / g["close"].shift(1) - 1
    r = d["ret_1"].where(d["ret_1"].abs() <= JUMP)  # a split day must not look like volatility
    rg = r.groupby(d["symbol"], sort=False)
    for w, mp in ((5, 4), (20, 15), (60, 40)):
        d[f"v{w}"] = rg.transform(lambda s, w=w, mp=mp: s.rolling(w, min_periods=mp).std()) * ANN
    d["fut"] = rg.transform(lambda s: s[::-1].rolling(20, min_periods=15).std()[::-1].shift(-1)) * ANN
    for h in HORIZONS:
        d[f"fwd_{h}"] = g["close"].shift(-h) / d["close"] - 1

    idx = pd.to_numeric(d["bist100"], errors="coerce").groupby(d["trade_date"]).median().sort_index()
    idx_v = idx.pct_change().rolling(20, min_periods=15).std() * ANN
    d["idx_v20"] = d["trade_date"].map(idx_v)

    jump = (d["ret_1"].abs() > JUMP).astype(float)
    back = jump.groupby(d["symbol"]).transform(lambda s: s.rolling(60, min_periods=1).max())
    ahead = jump.groupby(d["symbol"]).transform(lambda s: s[::-1].rolling(21, min_periods=1).max()[::-1].shift(-1))
    d["clean"] = (back == 0) & (ahead.fillna(0) == 0)
    return d.drop(columns=["bist100"])


def _logx(v: pd.DataFrame, fill: pd.Series | None = None) -> np.ndarray:
    x = v[VOL_X]
    if fill is not None:
        x = x.fillna(fill)
    return np.log(x.clip(lower=1e-3).to_numpy(dtype="float64"))


def fit(d: pd.DataFrame, end: pd.Timestamp | None = None) -> dict:
    """Fit the vol regression and z-quantiles on rows strictly before ``end`` (all rows if None),
    leaving a gap so no forward window reaches past ``end``."""
    from sklearn.linear_model import LinearRegression

    end = pd.Timestamp(end) if end is not None else d["trade_date"].max() + pd.Timedelta(days=1)
    start = end - pd.DateOffset(years=LOOKBACK_YEARS)
    base = d[(d["trade_date"] >= start) & (d["trade_date"] < end) & d["clean"]]
    tr = base[base["trade_date"] < end - pd.Timedelta(days=35)].dropna(subset=VOL_X + ["fut"])
    if len(tr) < 1000:
        raise ValueError(f"not enough history to fit ranges before {end.date()}: {len(tr)} rows")
    reg = LinearRegression().fit(_logx(tr), np.log(tr["fut"].clip(lower=1e-3)))
    med = tr[VOL_X].median()

    vf_all = np.exp(reg.predict(_logx(base, med)))
    edges = np.quantile(vf_all[base["trade_date"] < end - pd.Timedelta(days=35)], np.linspace(0, 1, N_BUCKETS + 1)[1:-1])
    bucket = np.searchsorted(edges, vf_all)
    q = {}
    for h in HORIZONS:
        cut = end - pd.Timedelta(days=int(h * 1.5) + 3)
        z = base[f"fwd_{h}"].to_numpy() / (vf_all * np.sqrt(h / 252))
        ok = (base["trade_date"] < cut).to_numpy() & np.isfinite(z) & base[VOL_X].notna().all(axis=1).to_numpy()
        q[h] = np.array([np.quantile(z[ok & (bucket == b)], QUANTS) for b in range(N_BUCKETS)])
    return {"reg": reg, "median": med, "edges": edges, "q": q, "end": str(end.date()), "n_train": int(len(tr))}


def predict_vol(model: dict, rows: pd.DataFrame) -> np.ndarray:
    return np.exp(model["reg"].predict(_logx(rows, model["median"])))


def bands(model: dict, rows: pd.DataFrame) -> pd.DataFrame:
    """Price bands for each row (normally each symbol's latest day)."""
    vf = predict_vol(model, rows)
    b = np.searchsorted(model["edges"], vf)
    out = pd.DataFrame({"symbol": rows["symbol"].to_numpy(), "as_of": rows["trade_date"].to_numpy(),
                        "close": rows["close"].to_numpy(dtype="float64"), "vol_forecast": vf,
                        "vol_bucket": b})
    for h in HORIZONS:
        sc = vf * np.sqrt(h / 252)
        qs = model["q"][h][b]  # (n, 5)
        for i, name in enumerate(("p05", "p16", "p50", "p84", "p95")):
            out[f"{name}_{h}"] = out["close"] * (1 + qs[:, i] * sc)
    return out


def walk_forward(d: pd.DataFrame, first_test_year: int = 2012) -> dict:
    """Yearly out-of-sample coverage of the 68% and 90% bands (fit on prior years only).
    Includes non-clean rows in the test so the numbers reflect what a user would see."""
    parts = {h: [] for h in HORIZONS}
    last = d["trade_date"].max().year
    for year in range(first_test_year, last + 1):
        start = pd.Timestamp(year, 1, 1)
        te = d[(d["trade_date"] >= start) & (d["trade_date"] < pd.Timestamp(year + 1, 1, 1))].dropna(subset=["v20"])
        if len(te) < 500:
            continue
        try:
            m = fit(d, start)
        except ValueError:
            continue
        b = bands(m, te)
        for h in HORIZONS:
            f = te[f"fwd_{h}"].to_numpy()
            ok = np.isfinite(f)
            px = te["close"].to_numpy()
            lo90, lo68, hi68, hi90 = (b[f"{k}_{h}"].to_numpy() / px - 1 for k in ("p05", "p16", "p84", "p95"))
            parts[h].append(pd.DataFrame({
                "year": year, "bucket": b["vol_bucket"].to_numpy(), "clean": te["clean"].to_numpy(),
                "in68": (f >= lo68) & (f <= hi68), "in90": (f >= lo90) & (f <= hi90),
                "above": f > hi90, "below": f < lo90, "w68": hi68 - lo68, "w90": hi90 - lo90})[ok])
    res = {}
    for h, ps in parts.items():
        if not ps:
            continue
        a = pd.concat(ps, ignore_index=True)
        res[str(h)] = {
            "coverage_68": float(a["in68"].mean()), "coverage_90": float(a["in90"].mean()),
            "breach_up_90": float(a["above"].mean()), "breach_down_90": float(a["below"].mean()),
            "avg_width_68": float(a["w68"].mean()), "avg_width_90": float(a["w90"].mean()),
            "coverage_90_clean": float(a.loc[a["clean"], "in90"].mean()),
            "by_bucket": {str(k): float(v) for k, v in a.groupby("bucket")["in90"].mean().items()},
            "by_year": {str(k): float(v) for k, v in a.groupby("year")["in90"].mean().items()},
            "n": int(len(a)),
        }
    return res


def payload_for(row: pd.Series, study: dict | None, vol_hist: pd.Series | None = None) -> dict:
    """The ``ranges`` block stored inside a symbol's forecast payload."""
    study = study or {}
    horizons = []
    for h in HORIZONS:
        st = study.get(str(h), {})
        horizons.append({"days": h, **{k: float(row[f"{k}_{h}"]) for k in ("p05", "p16", "p50", "p84", "p95")},
                         "coverage_68": st.get("coverage_68"), "coverage_90": st.get("coverage_90")})
    vf = float(row["vol_forecast"])
    out = {"version": VERSION, "as_of": str(pd.Timestamp(row["as_of"]).date()), "close": float(row["close"]),
           "vol_forecast_ann": vf, "vol_bucket": int(row["vol_bucket"]), "horizons": horizons,
           "model": "Havuzlanmış log-oynaklık regresyonu (5/20/60 gün + BIST 100 oynaklığı) + son 10 yılın "
                    "oynaklık dilimine göre ampirik getiri dağılımı",
           "note": "Aralıklar yön tahmini değildir; %90 bandın dışına çıkış yaklaşık 10'da 1 beklenir."}
    if vol_hist is not None and len(vol_hist):
        out["vol_pctile_5y"] = float((vol_hist <= vf).mean())
    return out


def stock_rows(raw: pd.DataFrame) -> pd.DataFrame:
    """``range_frame`` over the stock rows of a market extract (instruments dropped)."""
    if "source" in raw:
        raw = raw[raw["source"].astype(str) != "instrument"]
    return range_frame(raw)


def compute(d: pd.DataFrame, study: dict | None = None) -> dict[str, dict]:
    """Fit on all of ``d`` (a ``range_frame``) and return {symbol: ranges payload} for symbols
    with a bar in the last week."""
    model = fit(d)
    last_day = d["trade_date"].max()
    latest = d[d["trade_date"] == d.groupby("symbol")["trade_date"].transform("max")]
    latest = latest[(latest["trade_date"] >= last_day - pd.Timedelta(days=7)) & latest["v20"].notna()]
    b = bands(model, latest)
    recent = d[(d["trade_date"] >= last_day - pd.DateOffset(years=5)) & d["symbol"].isin(b["symbol"])].dropna(subset=["v20"])
    hist = dict(tuple(pd.Series(predict_vol(model, recent), index=recent.index).groupby(recent["symbol"].to_numpy())))
    out = {row["symbol"]: payload_for(row, study, hist.get(row["symbol"])) for _, row in b.iterrows()}
    log.info("stock ranges: %d symbols as of %s", len(out), last_day.date())
    return out
