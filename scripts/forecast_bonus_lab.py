"""Does the bonus-issue (bedelsiz) give-back improve the direction model? Walk-forward A/B.

The KAP topic study (pipeline/finsent/kap_topics.py) found one robust post-news drift: after a
bonus-issue disclosure stocks lag BIST 100 by ~2.4% over 20 trading days. This lab checks whether
the forecast model already captures it (via short-term reversal features) and whether explicit
features help:

  bonus_since   trading days since the last bonus-issue disclosure became known (cap 60)
  bonus_20      1 if that was within the last 20 trading days

A disclosure published after 18:00 counts for the next trading day. Folds 2023 / 2024 / 2025-26,
training from 2021 (KAP history starts there), same settings as forecast_news_lab.py.

    python scripts/forecast_bonus_lab.py <release_dir> <work_dir>

release_dir holds the data-* release Parquet files; work_dir caches raw/features Parquet.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import forecast_lab as lab  # noqa: E402

from finsent.kap_topics import topic_of  # noqa: E402

BONUS = ["bonus_since", "bonus_20"]


def bonus_days(release: Path, cal: np.ndarray) -> pd.DataFrame:
    dis = pd.read_parquet(release / "tables__disclosures.parquet", columns=["symbol", "published_at", "subject", "summary", "body"])
    dis = dis[dis["subject"].fillna("").str.startswith("Sermaye Artırımı")]
    text = dis["summary"].fillna("") + " " + dis["body"].fillna("").str[:3000]
    dis = dis[[topic_of(s, t, "") == "Bedelsiz sermaye artırımı" for s, t in zip(dis["subject"], text)]]
    ts = pd.to_datetime(dis["published_at"])
    cand = ts.dt.normalize() + pd.to_timedelta((ts.dt.hour >= 18).astype(int), unit="D")
    idx = np.searchsorted(cal, cand.to_numpy())
    ok = idx < len(cal)
    return pd.DataFrame({"symbol": dis["symbol"].to_numpy()[ok], "trade_date": cal[idx[ok]], "bonus_hit": 1.0}).drop_duplicates()


def add_bonus(df: pd.DataFrame, release: Path) -> pd.DataFrame:
    cal = np.array(sorted(df["trade_date"].unique()))
    df = df.merge(bonus_days(release, cal), on=["symbol", "trade_date"], how="left")
    df["bonus_hit"] = df["bonus_hit"].fillna(0.0)
    pos = df.groupby("symbol", sort=False).cumcount()
    last = pos.where(df["bonus_hit"] > 0).groupby(df["symbol"]).ffill()
    df["bonus_since"] = (pos - last).clip(upper=60).fillna(60).astype("float32")
    df["bonus_20"] = (df["bonus_since"] < 20).astype("float32")
    return df.drop(columns="bonus_hit")


def window_check(df: pd.DataFrame, feats: list, tgt: str, h: int = 20) -> dict:
    """On test folds: inside the 20-day bonus window, mean predicted P(beat) vs realised beat rate."""
    from sklearn.ensemble import HistGradientBoostingClassifier

    retcol = f"xs_{h}" if tgt == "xs" else f"fwd_{h}"
    y = (df[retcol] > 0).astype(float)
    dd = df[df["clean"] & df[retcol].notna() & (df["trade_date"] >= lab.TRAIN_START)].assign(_y=y)
    out = []
    for a, b in lab.FOLDS:
        a, b = pd.Timestamp(a), pd.Timestamp(b)
        gap = pd.Timedelta(days=int(h * 1.5) + 2)
        tr = dd[dd["trade_date"] < a - gap]
        tr = tr[tr.groupby("symbol").cumcount() % 3 == 0]
        te = dd[(dd["trade_date"] >= a) & (dd["trade_date"] < b)]
        p = HistGradientBoostingClassifier(**lab.REG).fit(tr[feats], tr["_y"]).predict_proba(te[feats])[:, 1]
        w = te["bonus_20"].to_numpy() > 0
        out.append({"fold": str(a.date()), "n_window": int(w.sum()), "pred_window": float(p[w].mean()) if w.any() else None,
                    "real_window": float(te["_y"].to_numpy()[w].mean()) if w.any() else None,
                    "pred_rest": float(p[~w].mean()), "real_rest": float(te["_y"].to_numpy()[~w].mean())})
    return {"h": h, "target": tgt, "folds": out}


def main(release: str, work: str) -> None:
    release, work = Path(release), Path(work)
    cache = work / "features.parquet"
    if cache.exists():
        df = pd.read_parquet(cache)
    else:
        raw = pd.read_parquet(release / "tables__market_daily.parquet")
        raw = raw[raw["source"].astype(str) != "instrument"]
        df = lab.build(raw)
        df.to_parquet(cache, index=False)
    df = add_bonus(df, release)
    print(f"rows {len(df):,}  bonus-window rows {int(df['bonus_20'].sum()):,}", flush=True)
    lab.FOLDS = [("2023-01-01", "2024-01-01"), ("2024-01-01", "2025-01-01"), ("2025-01-01", "2026-12-31")]
    lab.TRAIN_START = "2021-01-01"
    res = {"window_check_base": window_check(df, lab.FULL, "xs")}
    print(json.dumps(res["window_check_base"], indent=1), flush=True)
    for name, feats, tgt in (("BASE_beat", lab.FULL, "xs"), ("BONUS_beat", lab.FULL + BONUS, "xs"),
                             ("BASE_abs", lab.FULL, "abs"), ("BONUS_abs", lab.FULL + BONUS, "abs")):
        res[name] = {str(h): v for h, v in lab.run(df, name, feats, tgt, lab.REG, calibrate=True).items()}
    res["window_check_bonus"] = window_check(df, lab.FULL + BONUS, "xs")
    print(json.dumps(res["window_check_bonus"], indent=1), flush=True)
    (work / "bonus_ab.json").write_text(json.dumps(res, indent=1))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
