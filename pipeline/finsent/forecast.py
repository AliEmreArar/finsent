"""Direction forecasts (v2): relate each stock's current set-up to the history of the
whole market and estimate where it is more likely to go over 1 / 5 / 20 trading days.

What is predicted, per horizon h:

* ``p_up``     - P(close in h days > close today)                     ("absolute")
* ``p_beat``   - P(stock return over h days > BIST 100 return)        ("relative")
* ``rank_pct`` - where today's ``p_beat`` sits among all stocks today (0 = worst, 1 = best)

Models: gradient-boosted trees (``HistGradientBoostingClassifier``) on ~40
features - momentum and short-term reversal at several lengths, volatility,
liquidity (Amihud, turnover), size, 60-day beta and residual momentum, distance
to highs/averages, RSI/Bollinger/MACD, market regime (index momentum and
volatility, USD/TRY) - plus each feature's cross-sectional percentile on the
day. Probabilities are calibrated with isotonic regression fitted on the year
that precedes the model's use (time-respecting, no look-ahead).

Research (walk-forward over 2022-2026, four yearly folds; see
docs/forecast_research.md) chose this set-up: versus v1 it raised the daily rank
IC from ~0.05-0.08 to ~0.10-0.11, and showed that nearest-past-day "analogs" have
no out-of-sample skill (AUC ~0.50-0.52) - they are therefore shown as context
only and never enter the probabilities.

Days within reach of a corporate action (|daily move| > 25 %, i.e. splits / bonus
issues in the unadjusted history) are excluded from targets and analogs.
"""
from __future__ import annotations

import json
import logging
import os
from datetime import date

import numpy as np
import pandas as pd

from . import market
from .config import Settings

log = logging.getLogger(__name__)

VERSION = "v2"
HORIZONS = (1, 5, 20)
PATH_DAYS = 20
N_ANALOGS = 20
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
FEATURES = EXT + [f"cs_{f}" for f in CS]
ANALOG_FEATURES = ["ret_5", "ret_20", "ret_60", "rel_20", "rsi_14", "bb_pos", "d_sma50",
                   "d_sma200", "vol_ratio", "vol_20"]
PARAMS = dict(max_iter=200, learning_rate=0.03, max_leaf_nodes=15, min_samples_leaf=3000,
              l2_regularization=5.0, early_stopping=False, random_state=7)
TARGETS = {"abs": "fwd_{h}", "beat": "xs_{h}"}
DISCLAIMER = ("Olasılıksal bir tahmindir: tüm BIST hisselerinin 2008'den bu yana verisiyle eğitilmiş "
              "bir model kullanılır ve isabeti sınırlıdır. Yatırım tavsiyesi değildir.")


# --------------------------------------------------------------------------- features
def _roll(g, col: str, w: int, fn: str, mp: int | None = None):
    return g[col].transform(lambda s: getattr(s.rolling(w, min_periods=mp or max(2, w // 2)), fn)())


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    """Features, forward returns and excess returns per (symbol, day)."""
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
        "usd_ret_5": usd / usd.shift(5) - 1, "usd_ret_20": usd / usd.shift(20) - 1, "idx_r1": idx_r,
    })
    for h in HORIZONS:
        day[f"idx_fwd_{h}"] = idx.shift(-h) / idx - 1
    df = df.join(day, on="trade_date")
    df["rel_20"] = df["ret_20"] - df["idx_ret_20"]
    g = df.groupby("symbol", sort=False)

    df["vol_20"] = _roll(g, "ret_1", 20, "std", 15)
    df["vol_60"] = _roll(g, "ret_1", 60, "std", 40)
    df["vol_ratio_20_60"] = df["vol_20"] / df["vol_60"]
    df["max_ret_20"] = _roll(g, "ret_1", 20, "max", 15)
    df["min_ret_20"] = _roll(g, "ret_1", 20, "min", 15)
    df["up_days_20"] = g["ret_1"].transform(lambda s: (s > 0).astype(float).rolling(20, min_periods=15).mean())
    avg_vol = g["volume_try"].transform(lambda s: s.rolling(20, min_periods=10).mean().shift(1))
    df["vol_ratio"] = np.log1p(df["volume_try"] / avg_vol.replace(0, np.nan))
    df["amihud_20"] = np.log1p(1e9 * (df["ret_1"].abs() / df["volume_try"].replace(0, np.nan))
                               .groupby(df["symbol"]).transform(lambda s: s.rolling(20, min_periods=10).mean()))
    df["turnover_20"] = np.log((avg_vol / df["market_cap_try"]).replace(0, np.nan))
    df["log_mcap"] = np.log(df["market_cap_try"].replace(0, np.nan))
    df["log_price"] = np.log(c)
    hi = _roll(g, "high", 252, "max", 60)
    lo = _roll(g, "low", 252, "min", 60)
    df["pos_52w"] = (c - lo) / (hi - lo).replace(0, np.nan)
    df["dist_hi_252"] = c / hi - 1
    df["macd_n"] = df["macd_hist"] / c
    df["bb_pos"] = (c - df["bb_lower"]) / (df["bb_upper"] - df["bb_lower"]).replace(0, np.nan)
    df["d_sma50"] = c / df["sma_50"] - 1
    df["d_sma200"] = c / df["sma_200"] - 1
    m_ri = df.groupby("symbol")["idx_r1"].transform(lambda s: s.rolling(60, min_periods=40).mean())
    cov = (df["ret_1"] * df["idx_r1"]).groupby(df["symbol"]).transform(
        lambda s: s.rolling(60, min_periods=40).mean()) - _roll(g, "ret_1", 60, "mean", 40) * m_ri
    var = df.groupby("symbol")["idx_r1"].transform(lambda s: s.rolling(60, min_periods=40).var())
    df["beta_60"] = (cov / var).clip(-3, 5)
    df["resid_ret_20"] = df["ret_20"] - df["beta_60"] * df["idx_ret_20"]
    df["dow"] = df["trade_date"].dt.dayofweek.astype(float)

    jump = (df["ret_1"].abs() > 0.25).astype(float)
    back = jump.groupby(df["symbol"]).transform(lambda s: s.rolling(60, min_periods=1).max())
    ahead = jump.groupby(df["symbol"]).transform(lambda s: s[::-1].rolling(PATH_DAYS + 1, min_periods=1).max()[::-1])
    df["clean"] = (back == 0) & (ahead == 0)
    df[EXT] = df[EXT].replace([np.inf, -np.inf], np.nan)
    for f in CS:
        df[f"cs_{f}"] = df.groupby("trade_date")[f].rank(pct=True)
    for h in HORIZONS:
        df[f"xs_{h}"] = df[f"fwd_{h}"] - df[f"idx_fwd_{h}"]
    return df


# --------------------------------------------------------------------------- models
class CalibratedModel:
    """Gradient-boosted classifier + isotonic calibration fitted on a later, disjoint period."""

    def __init__(self, clf, iso):
        self.clf, self.iso = clf, iso

    def predict(self, X: pd.DataFrame) -> np.ndarray:
        raw = self.clf.predict_proba(X)[:, 1]
        # isotonic output is a step function; a tiny raw term keeps the ranking within steps
        return np.clip(self.iso.predict(raw) + (raw - 0.5) * 1e-3, 0.0, 1.0)


def _fit_calibrated(fit: pd.DataFrame, cal: pd.DataFrame, ycol: str) -> CalibratedModel:
    from sklearn.ensemble import HistGradientBoostingClassifier
    from sklearn.isotonic import IsotonicRegression

    clf = HistGradientBoostingClassifier(**PARAMS).fit(fit[FEATURES], fit[ycol])
    iso = IsotonicRegression(out_of_bounds="clip", y_min=0.02, y_max=0.98).fit(
        clf.predict_proba(cal[FEATURES])[:, 1], cal[ycol])
    return CalibratedModel(clf, iso)


def _metrics(y: np.ndarray, p: np.ndarray, base_train: float, dates: pd.Series, ret: np.ndarray) -> dict:
    from sklearn.metrics import roc_auc_score

    brier = float(np.mean((p - y) ** 2))
    tmp = pd.DataFrame({"d": dates.to_numpy(), "p": p, "r": ret, "y": y})
    ic = tmp.groupby("d").apply(lambda x: x["p"].corr(x["r"], method="spearman") if len(x) > 20 else np.nan).dropna()
    q = tmp.groupby("d")["p"].rank(pct=True)
    return {"auc": float(roc_auc_score(y, p)), "accuracy": float(((p > 0.5) == y).mean()),
            "base_rate": float(y.mean()), "brier": brier,
            "brier_skill": float(1 - brier / np.mean((base_train - y) ** 2)),
            "rank_ic": float(ic.mean()) if len(ic) else None,
            "top_decile_hit": float(tmp.loc[q >= 0.9, "y"].mean()),
            "bottom_decile_hit": float(tmp.loc[q <= 0.1, "y"].mean()),
            "n_test": int(len(y))}


def train_models(feat: pd.DataFrame, as_of: pd.Timestamp | None = None, mlflow_log: bool = True) -> dict:
    """Per target and horizon: a holdout evaluation on the last year, then the production model.

    holdout:    fit < T-2y-gap  | calibrate [T-2y, T-1y-gap) | test [T-1y, T)
    production: fit < T-1y-gap  | calibrate [T-1y, T)
    """
    as_of = as_of or feat["trade_date"].max()
    # one slim float32 frame (features + targets only) instead of copying the wide frame per model
    tcols = [t.format(h=h) for t in TARGETS.values() for h in HORIZONS]
    keep = feat["clean"] & (feat["trade_date"] >= TRAIN_START)
    base = feat.loc[keep, ["symbol", "trade_date"]].join(feat.loc[keep, FEATURES + tcols].astype("float32"))
    models, metrics = {}, {}
    for tgt, tmpl in TARGETS.items():
        for h in HORIZONS:
            rcol, ycol = tmpl.format(h=h), f"y_{tgt}_{h}"
            d = base[base[rcol].notna()]
            d = d.assign(**{ycol: (d[rcol] > 0).astype("float32")})
            gap = pd.Timedelta(days=int(h * 1.5) + 2)
            year = pd.Timedelta(days=365)
            last = d["trade_date"].max()
            thin = lambda x: x[x.groupby("symbol").cumcount() % 3 == 0]  # noqa: E731 - less overlap
            ev = _fit_calibrated(thin(d[d["trade_date"] < last - 2 * year - gap]),
                                 d[(d["trade_date"] >= last - 2 * year) & (d["trade_date"] < last - year - gap)], ycol)
            te = d[d["trade_date"] >= last - year]
            p = ev.predict(te[FEATURES])
            m = _metrics(te[ycol].to_numpy(), p, float(d[d["trade_date"] < last - year][ycol].mean()),
                         te["trade_date"], te[rcol].to_numpy())
            metrics.setdefault(tgt, {})[h] = m
            log.info("forecast %s h=%d holdout %s", tgt, h, {k: round(v, 4) if isinstance(v, float) else v for k, v in m.items()})
            models.setdefault(tgt, {})[h] = _fit_calibrated(
                thin(d[d["trade_date"] < last - year - gap]), d[d["trade_date"] >= last - year], ycol)
    out = {"models": models, "metrics": metrics, "as_of": str(as_of.date() if hasattr(as_of, "date") else as_of)}
    if mlflow_log and os.environ.get("MLFLOW_TRACKING_URI"):
        try:
            import mlflow
            mlflow.set_experiment(os.environ.get("FINSENT_FORECAST_EXPERIMENT", "finsent-forecast"))
            with mlflow.start_run(run_name=f"direction_{VERSION}_{date.today()}"):
                mlflow.log_params({"version": VERSION, "n_features": len(FEATURES), "train_start": TRAIN_START,
                                   "horizons": ",".join(map(str, HORIZONS)), **{f"gb_{k}": v for k, v in PARAMS.items()},
                                   "calibration": "isotonic, previous year", "holdout": "last 365 days"})
                for tgt, by_h in metrics.items():
                    for h, m in by_h.items():
                        mlflow.log_metrics({f"{tgt}_h{h}_{k}": v for k, v in m.items() if isinstance(v, (int, float))})
        except Exception as e:  # noqa: BLE001 - tracking must never break forecasting
            log.warning("mlflow logging failed: %s", e)
    return out


# --------------------------------------------------------------------------- analogs (context only)
def find_analogs(sym_feat: pd.DataFrame, k: int = N_ANALOGS, gap: int = 10) -> pd.DataFrame | None:
    """Nearest past days of the same stock. Shown for context; not used in the probabilities."""
    s = sym_feat.reset_index(drop=True)
    today = s.iloc[-1][ANALOG_FEATURES].astype(float)
    if today.isna().any():
        return None
    hist = s.iloc[: max(0, len(s) - 60)]
    hist = hist[hist["clean"]].dropna(subset=ANALOG_FEATURES + [f"fwd_{PATH_DAYS}"])
    if len(hist) < 200:
        return None
    mu, sd = hist[ANALOG_FEATURES].mean(), hist[ANALOG_FEATURES].std().replace(0, 1)
    dist = np.sqrt((((hist[ANALOG_FEATURES] - mu) / sd - (today - mu) / sd) ** 2).sum(axis=1))
    picked: list[int] = []
    for i in dist.sort_values().index:
        if all(abs(i - j) >= gap for j in picked):
            picked.append(i)
        if len(picked) == k:
            break
    out = hist.loc[picked].copy()
    out["distance"] = dist.loc[picked]
    closes = s["close"].to_numpy()
    out["path"] = [list(closes[i: i + PATH_DAYS + 1] / closes[i] - 1) for i in out.index]
    return out


# --------------------------------------------------------------------------- assembly
def _pct(v: float) -> str:
    return f"%{v * 100:+.1f}".replace(".", ",")


def _explain(today: pd.Series, horizons: list[dict]) -> str:
    bits = []
    if pd.notna(today.get("ret_20")):
        bits.append(f"son 20 günde {_pct(today['ret_20'])}")
    if pd.notna(today.get("rsi_14")):
        r = today["rsi_14"]
        bits.append(f"RSI {r:.0f} ({'aşırı satım' if r < 30 else 'aşırı alım' if r > 70 else 'nötr'})")
    if pd.notna(today.get("d_sma200")):
        bits.append("200 günlük ortalamanın " + ("üzerinde" if today["d_sma200"] > 0 else "altında"))
    text = ("Hisse şu an " + ", ".join(bits) + ".") if bits else ""
    h5 = next((h for h in horizons if h["days"] == 5), None)
    if h5 and h5.get("rank_pct") is not None:
        r = h5["rank_pct"]
        where = ("en güçlü %10'luk dilimde" if r >= 0.9 else "üst çeyrekte" if r >= 0.75 else
                 "en zayıf %10'luk dilimde" if r <= 0.1 else "alt çeyrekte" if r <= 0.25 else "ortalarda")
        text += f" Model bugün 1 haftalık görünümde hisseyi tüm BIST hisseleri arasında {where} sıralıyor."
    return text.strip()


def forecast_frame(today_rows: pd.DataFrame, models: dict) -> pd.DataFrame:
    """Probabilities for every symbol on its latest day, plus the cross-sectional rank."""
    out = today_rows[["symbol"]].copy()
    for tgt in TARGETS:
        for h in HORIZONS:
            out[f"p_{tgt}_{h}"] = models[tgt][h].predict(today_rows[FEATURES])
    for h in HORIZONS:
        out[f"rank_{h}"] = out[f"p_beat_{h}"].rank(pct=True)
    return out


def forecast_symbol(sym_feat: pd.DataFrame, probs: pd.Series, metrics: dict) -> dict:
    s = sym_feat.sort_values("trade_date")
    today = s.iloc[-1]
    analogs = find_analogs(s)
    horizons = []
    for h in HORIZONS:
        ma, mb = metrics["abs"][h], metrics["beat"][h]
        rec = {"days": h, "p_up": float(probs[f"p_abs_{h}"]), "p_beat": float(probs[f"p_beat_{h}"]),
               "rank_pct": float(probs[f"rank_{h}"]),
               "model_auc": ma["auc"], "beat_auc": mb["auc"],
               "top_decile_hit": mb["top_decile_hit"], "bottom_decile_hit": mb["bottom_decile_hit"]}
        if analogs is not None:
            fwd = analogs[f"fwd_{h}"].dropna()
            rec.update({"analog_up_share": float((fwd > 0).mean()), "analog_median": float(fwd.median()),
                        "analog_n": int(len(fwd))})
        rec["median_return"] = rec.get("analog_median")
        rec["basis"] = (f"Endeksi geçme olasılığı %{rec['p_beat'] * 100:.0f} · bugün hisselerin "
                        f"%{rec['rank_pct'] * 100:.0f}'inden daha iyi sıralanıyor")
        horizons.append(rec)
    payload = {
        "version": VERSION,
        "as_of": str(pd.Timestamp(today["trade_date"]).date()),
        "close": float(today["close"]),
        "horizons": horizons,
        "explanation": _explain(today, horizons),
        "model": {"name": "HistGradientBoosting + isotonic (mutlak ve endekse göre)",
                  "metrics": {t: {str(h): m for h, m in by.items()} for t, by in metrics.items()}},
        "analogs_note": "Benzer geçmiş durumlar yalnızca bağlam içindir; geriye dönük testte tahmin gücü gösteremedi.",
        "disclaimer": DISCLAIMER,
    }
    if analogs is not None:
        paths = np.array(list(analogs["path"]))
        payload["analogs"] = [{"date": str(pd.Timestamp(d).date()), "distance": round(float(x), 3),
                               "path": [round(v, 4) for v in p]}
                              for d, x, p in zip(analogs["trade_date"], analogs["distance"], analogs["path"])]
        payload["analog_median"] = [round(float(v), 4) for v in np.median(paths, axis=0)]
    return payload


def model_path(settings: Settings):
    from pathlib import Path

    return Path(settings.market_updates_path).parent.parent / "models" / f"forecast_{VERSION}.joblib"


def run(settings: Settings, as_of: date | None = None, symbols: list[str] | None = None,
        predict_only: bool = False, retrain_after_days: int | None = None) -> dict:
    """Train (or load), evaluate and write one forecast per active symbol to MySQL (``forecasts``)."""
    import gc

    import joblib

    from . import mysql_sink

    end = as_of or date.today()
    raw = market.extract_market(settings, date(2004, 1, 1), end)
    raw = raw.drop(columns=[c for c in ("bb_mid", "macd", "macd_signal", "pct_change", "source") if c in raw])
    feat = build_features(raw)
    del raw
    path = model_path(settings)
    if retrain_after_days is not None and path.exists():
        import time
        age_days = (time.time() - path.stat().st_mtime) / 86400
        predict_only = age_days < retrain_after_days
    if predict_only and path.exists():
        trained = joblib.load(path)
        log.info("loaded models from %s (trained %s)", path, trained.get("as_of"))
    else:
        trained = train_models(feat)
        path.parent.mkdir(parents=True, exist_ok=True)
        joblib.dump(trained, path)
    # keep only what prediction and analogs need (the wide frame is ~2 GB)
    need = list(dict.fromkeys(["symbol", "trade_date", "close", "clean", *FEATURES, *ANALOG_FEATURES,
                               *[f"fwd_{h}" for h in HORIZONS]]))
    feat = feat[need]
    gc.collect()
    num_cols = [c for c in need if c not in ("symbol", "trade_date", "clean")]
    feat[num_cols] = feat[num_cols].astype("float32")
    last_day = feat["trade_date"].max()
    latest = feat[feat["trade_date"] == feat.groupby("symbol")["trade_date"].transform("max")]
    latest = latest[latest["trade_date"] >= last_day - pd.Timedelta(days=7)]
    probs = forecast_frame(latest, trained["models"]).set_index("symbol")
    wanted = set(symbols) if symbols else set(probs.index)
    rows = []
    for sym, g in feat[feat["symbol"].isin(wanted & set(probs.index))].groupby("symbol"):
        try:
            rows.append((sym, forecast_symbol(g, probs.loc[sym], trained["metrics"])))
        except Exception as e:  # noqa: BLE001 - one bad symbol must not stop the batch
            log.warning("forecast %s failed: %s", sym, e)
    with mysql_sink.connect(settings) as conn, conn.cursor() as cur:
        cur.executemany("REPLACE INTO forecasts (symbol, as_of, payload) VALUES (%s, %s, %s)",
                        [(s, p["as_of"], json.dumps(p, ensure_ascii=False, default=float)) for s, p in rows])
    summary = {"version": VERSION, "symbols": len(rows), "as_of": str(last_day.date()),
               "holdout": {t: {str(h): {k: round(v, 4) for k, v in m.items() if isinstance(v, float)}
                               for h, m in by.items()} for t, by in trained["metrics"].items()}}
    log.info("forecast run: %s", summary)
    return summary


if __name__ == "__main__":
    import argparse

    from .config import get_settings

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbols")
    ap.add_argument("--predict-only", action="store_true", help="reuse the saved models instead of retraining")
    a = ap.parse_args()
    print(json.dumps(run(get_settings(), symbols=a.symbols.split(",") if a.symbols else None,
                         predict_only=a.predict_only), indent=2))
