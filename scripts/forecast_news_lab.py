"""Does KAP news sentiment improve the direction model? Walk-forward A/B on the same window.

Builds per (symbol, day) news features from the serving DB (disclosures + preferred sentiment),
aligned to what was known by that day's close (notices after 18:00 count for the next day),
joins them to the research feature set (data/research/features.parquet, see forecast_lab.py)
and compares FULL vs FULL+NEWS on folds 2023 / 2024 / 2025-26, training from 2021 only so
both arms see the same history (KAP history is loaded from 2021).

    python scripts/forecast_news_lab.py
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pymysql

sys.path.insert(0, str(Path(__file__).resolve().parent))
import forecast_lab as lab  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "data" / "research"
NEWS = ["news_n_5", "news_pos_5", "news_neg_5", "news_sent_5", "news_sent_20", "news_n_20",
        "news_days_since_neg", "news_days_since_any", "news_max_abs_5"]


def news_features(dates: pd.DatetimeIndex) -> pd.DataFrame:
    conn = pymysql.connect(host="localhost", port=3307, user="finsent", password="finsent", database="finsent")
    d = pd.read_sql("""SELECT d.symbol, d.published_at, s.label, s.score
                         FROM disclosures d JOIN v_sentiment s USING (disclosure_id)""", conn)
    d["published_at"] = pd.to_datetime(d["published_at"])
    # information day: same day if before 18:00, else the next trading day
    cal = np.array(sorted(dates.unique()))
    day = d["published_at"].dt.normalize()
    after = d["published_at"].dt.hour >= 18
    cand = day + pd.to_timedelta(after.astype(int), unit="D")
    idx = np.searchsorted(cal, cand.to_numpy())
    d = d[idx < len(cal)].copy()
    d["trade_date"] = cal[idx[idx < len(cal)]]
    d["pos"] = (d["label"] == "positive").astype(float)
    d["neg"] = (d["label"] == "negative").astype(float)
    g = d.groupby(["symbol", "trade_date"]).agg(n=("score", "size"), pos=("pos", "sum"), neg=("neg", "sum"),
                                                sent=("score", "sum"), max_abs=("score", lambda x: x.abs().max()))
    return g.reset_index()


def add_news(df: pd.DataFrame) -> pd.DataFrame:
    daily = news_features(pd.DatetimeIndex(df["trade_date"]))
    df = df.merge(daily, on=["symbol", "trade_date"], how="left")
    for c in ("n", "pos", "neg", "sent", "max_abs"):
        df[c] = df[c].fillna(0.0)
    g = df.groupby("symbol", sort=False)
    roll = lambda col, w, fn="sum": g[col].transform(lambda s: getattr(s.rolling(w, min_periods=1), fn)())  # noqa: E731
    df["news_n_5"], df["news_n_20"] = roll("n", 5), roll("n", 20)
    df["news_pos_5"], df["news_neg_5"] = roll("pos", 5), roll("neg", 5)
    df["news_sent_5"], df["news_sent_20"] = roll("sent", 5), roll("sent", 20)
    df["news_max_abs_5"] = roll("max_abs", 5, "max")
    for col, src in (("news_days_since_neg", "neg"), ("news_days_since_any", "n")):
        hit = (df[src] > 0)
        last = df["trade_date"].where(hit).groupby(df["symbol"]).ffill()
        df[col] = ((df["trade_date"] - last).dt.days).clip(upper=120).fillna(120)
    return df.drop(columns=["n", "pos", "neg", "sent", "max_abs"])


def main() -> None:
    df = pd.read_parquet(OUT / "features.parquet")
    df = add_news(df)
    lab.FOLDS = [("2023-01-01", "2024-01-01"), ("2024-01-01", "2025-01-01"), ("2025-01-01", "2026-12-31")]
    lab.TRAIN_START = "2021-01-01"
    res = {}
    for name, feats, tgt in (("BASE_abs", lab.FULL, "abs"), ("NEWS_abs", lab.FULL + NEWS, "abs"),
                             ("BASE_beat", lab.FULL, "xs"), ("NEWS_beat", lab.FULL + NEWS, "xs")):
        res[name] = lab.run(df, name, feats, tgt, lab.REG, calibrate=True)
    (OUT / "news_ab.json").write_text(json.dumps({k: {str(h): v for h, v in r.items()} for k, r in res.items()}, indent=1))


if __name__ == "__main__":
    main()
