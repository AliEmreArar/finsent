"""Do Grok-scored KAP disclosures move prices? Event study on 2021-2026 history.

For each disclosure: information day = publish day (before 18:00) or next trading day.
Excess return vs BIST 100 from the previous close to h trading days later (h = 1/5/20),
grouped by sentiment label and by |score| strength. Day-0 return (the reaction on the
information day itself) is reported separately from the post-event drift (days 1..h),
since only the drift could be traded after reading the disclosure.

    python scripts/news_event_study.py
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pymysql

OUT = Path(__file__).resolve().parents[1] / "data" / "research" / "news_event_study.json"
conn = pymysql.connect(host="localhost", port=3307, user="finsent", password="finsent", database="finsent")
d = pd.read_sql("""SELECT d.symbol, d.published_at, s.label, s.score FROM disclosures d
                   JOIN v_sentiment s USING (disclosure_id) WHERE s.provider <> 'lexicon'""", conn)
px = pd.read_sql("SELECT symbol, trade_date, close FROM market_daily WHERE trade_date >= '2020-12-01'", conn)
px["trade_date"] = pd.to_datetime(px["trade_date"])
wide = px.pivot_table(index="trade_date", columns="symbol", values="close").sort_index()
wide = wide[wide["XU100"].notna()]
ret = wide.pct_change(fill_method=None)
xs = ret.sub(ret["XU100"], axis=0).clip(-0.3, 0.3)       # daily excess return vs index
cal = wide.index.to_numpy()

d["published_at"] = pd.to_datetime(d["published_at"])
cand = d["published_at"].dt.normalize() + pd.to_timedelta((d["published_at"].dt.hour >= 18).astype(int), unit="D")
d["i"] = np.searchsorted(cal, cand.to_numpy())
d = d[(d["i"] < len(cal)) & d["symbol"].isin(xs.columns)].copy()
# one event per symbol-day: average sentiment of that day's disclosures
d["sgn"] = d["label"].map({"positive": 1, "negative": -1, "neutral": 0})
ev = d.groupby(["symbol", "i"]).agg(score=("score", "mean"), n=("score", "size")).reset_index()
ev["label"] = np.select([ev["score"] > 0.15, ev["score"] < -0.15], ["positive", "negative"], "neutral")

X = xs.to_numpy()
col = {s: k for k, s in enumerate(xs.columns)}
c = ev["symbol"].map(col).to_numpy()
i = ev["i"].to_numpy()
cum = np.nancumsum(np.nan_to_num(X), axis=0)              # cumulative (additive) excess returns
cum = np.vstack([np.zeros((1, X.shape[1])), cum])          # cum[t] = sum of days < t


def window(a, b):
    """Excess return over trading days i+a .. i+b (inclusive); NaN past the data end."""
    hi = i + b + 1
    ok = hi <= len(cal)
    out = np.full(len(i), np.nan)
    out[ok] = cum[hi[ok], c[ok]] - cum[i[ok] + a, c[ok]]
    return out


ev["day0"] = window(0, 0)
for h in (1, 5, 20):
    ev[f"drift_{h}"] = window(1, h)

res = {}
for lab, g in ev.groupby("label"):
    row = {"events": int(len(g))}
    for k in ("day0", "drift_1", "drift_5", "drift_20"):
        v = g[k].dropna()
        row[k] = {"mean": float(v.mean()), "t": float(v.mean() / (v.std() / np.sqrt(len(v)))), "hit": float((v > 0).mean())}
    res[lab] = row
strong = ev[ev["score"].abs() >= 0.6]
for lab, g in strong.groupby("label"):
    v0, v5 = g["day0"].dropna(), g["drift_5"].dropna()
    res[f"strong_{lab}"] = {"events": int(len(g)), "day0_mean": float(v0.mean()), "day0_t": float(v0.mean() / (v0.std() / np.sqrt(len(v0)))),
                            "drift_5_mean": float(v5.mean()), "drift_5_t": float(v5.mean() / (v5.std() / np.sqrt(len(v5))))}
OUT.write_text(json.dumps(res, indent=1))
for k, v in res.items():
    print(k, json.dumps(v)[:400])
