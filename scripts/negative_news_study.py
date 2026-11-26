"""Does a negative KAP disclosure predict the next 20 trading days? (basis of the news-alert badge)

Reads the snapshot tables (the data-YYYY-MM-DD GitHub release Parquet files) from a folder:

    python scripts/negative_news_study.py /path/to/release_dir

Method: abnormal daily return = stock return - BIST 100 return (corporate-action days, |r| > 25%,
dropped). For each xAI-scored disclosure, cumulative abnormal return from the event day's close
to +5/+20 days, then demeaned by the same month's neutral disclosures (removes market-wide
clustering). t-statistics are computed on monthly means (clustered by month).

Result (data-2026-11-08): score <= -0.7: -1.6% over 20 days, n=565, t=-2.3, negative in 5/6 years;
other negatives: -0.4%, t=-1.1; positives: ~0.
"""
import sys

import numpy as np
import pandas as pd


def main(d: str) -> None:
    m = pd.read_parquet(f"{d}/tables__market_daily.parquet", columns=["symbol", "trade_date", "close", "bist100", "source"])
    m = m[m["source"].astype(str) != "instrument"].copy()
    m["trade_date"] = pd.to_datetime(m["trade_date"])
    m = m.sort_values(["symbol", "trade_date"]).reset_index(drop=True)
    g = m.groupby("symbol")
    m["r"] = m["close"] / g["close"].shift(1) - 1
    ir = m.groupby("trade_date")["bist100"].median().pct_change()
    m["ar"] = (m["r"] - m["trade_date"].map(ir)).where(m["r"].abs() <= 0.25)
    m["pos"] = g.cumcount()
    m["car"] = m.groupby("symbol")["ar"].transform(lambda s: s.fillna(0).cumsum())

    s = pd.read_parquet(f"{d}/tables__disclosure_sentiment.parquet")
    s = s[s["provider"] == "xai"]
    e = pd.read_parquet(f"{d}/tables__event_returns.parquet")[["disclosure_id", "symbol", "event_date"]]
    e["event_date"] = pd.to_datetime(e["event_date"])
    x = e.merge(s[["disclosure_id", "label", "score", "event_type"]], on="disclosure_id").dropna(subset=["event_date"])
    x = x.drop_duplicates(["symbol", "event_date", "label"])
    x = x.merge(m[["symbol", "trade_date", "pos", "car"]].rename(columns={"trade_date": "event_date"}), on=["symbol", "event_date"])
    mm = m[["symbol", "pos", "car"]]

    def at(k):
        return x[["symbol"]].assign(pos=x["pos"] + k).merge(mm, on=["symbol", "pos"], how="left")["car"].to_numpy()

    c0 = at(0)
    x["post5"], x["post20"] = at(5) - c0, at(20) - c0
    x["ym"] = x["event_date"].dt.to_period("M")
    neutral = x[x["label"] == "neutral"]
    for h in ("post5", "post20"):
        x[f"ex_{h}"] = x[h] - x["ym"].map(neutral.groupby("ym")[h].mean())
    x["grp"] = np.where(x["label"] != "negative", x["label"], np.where(x["score"] <= -0.7, "negative_strong", "negative_other"))
    for name, df in x.groupby("grp"):
        mon = df.groupby("ym")["ex_post20"].mean()
        yrs = df.groupby(df["event_date"].dt.year)["ex_post20"].mean()
        print(f"{name:16s} n={len(df):6d}  excess 5d {df['ex_post5'].mean():+.4f}  20d {df['ex_post20'].mean():+.4f}  "
              f"t(month) {mon.mean() / mon.std() * np.sqrt(len(mon)):+.2f}  years<0 {(yrs < 0).sum()}/{len(yrs)}")


if __name__ == "__main__":
    main(sys.argv[1])
