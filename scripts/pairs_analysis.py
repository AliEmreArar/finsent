"""PGSUS vs THYAO: correlation, cointegration and lead-lag at daily / hourly / 15-minute bars.

Data: data/research/pairs/{1d,60m,15m}.parquet (Yahoo, split/dividend adjusted), written by
scripts/pairs_fetch (see docs/pairs_pgsus_thyao.md).

    python scripts/pairs_analysis.py
"""
import json
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
from statsmodels.tsa.stattools import adfuller, coint, grangercausalitytests

warnings.filterwarnings("ignore")
DATA = Path(__file__).resolve().parents[1] / "data" / "research" / "pairs"
A, B = "PGSUS", "THYAO"


def load(itv: str) -> pd.DataFrame:
    df = pd.read_parquet(DATA / f"{itv}.parquet")
    out = pd.DataFrame({A: df[(A, "Close")], B: df[(B, "Close")], "IDX": df[("XU100", "Close")]}).dropna(subset=[A, B])
    if itv != "1d":  # continuous session only (drop the closing-auction bar after 18:00)
        out = out.iloc[out.index.indexer_between_time("09:30", "17:59")]
    return out


def half_life(spread: pd.Series) -> float:
    lag = spread.shift(1)
    d = (spread - lag).dropna()
    beta = np.polyfit(lag.loc[d.index], d, 1)[0]
    return float(-np.log(2) / beta) if beta < 0 else float("inf")


def lead_lag(ra: pd.Series, rb: pd.Series, lags=range(-3, 4)) -> dict:
    """corr(PGSUS_t, THYAO_{t-k}): k>0 means THYAO leads PGSUS by k bars."""
    return {k: float(ra.corr(rb.shift(k))) for k in lags}


def analyse(itv: str, same_day_only: bool) -> dict:
    px = load(itv)
    lp = np.log(px[[A, B]])
    r = lp.diff()
    if same_day_only:  # never relate the last bar of one day to the first bar of the next
        day = pd.Series(px.index.date, index=px.index)
        r[day != day.shift(1)] = np.nan
    r = r.dropna()
    res = {"bars": len(px), "from": str(px.index.min()), "to": str(px.index.max())}
    res["corr"] = float(r[A].corr(r[B]))
    cov = np.cov(r[A], r[B])
    res["beta_pgsus_on_thyao"] = float(cov[0, 1] / cov[1, 1])
    res["lead_lag"] = lead_lag(r[A], r[B])
    gc = grangercausalitytests(r[[A, B]].to_numpy(), maxlag=3)   # does THYAO help predict PGSUS?
    gc_rev = grangercausalitytests(r[[B, A]].to_numpy(), maxlag=3)
    res["granger_thyao_to_pgsus_p"] = {l: float(gc[l][0]["ssr_ftest"][1]) for l in gc}
    res["granger_pgsus_to_thyao_p"] = {l: float(gc_rev[l][0]["ssr_ftest"][1]) for l in gc_rev}
    # cointegration of log prices (Engle-Granger), hedge ratio by OLS
    t, p, _ = coint(lp[A], lp[B])
    hedge = np.polyfit(lp[B], lp[A], 1)[0]
    spread = lp[A] - hedge * lp[B]
    res["coint_p"] = float(p)
    res["hedge_ratio"] = float(hedge)
    res["spread_adf_p"] = float(adfuller(spread.dropna())[1])
    res["half_life_bars"] = half_life(spread)
    return res, r, lp


def main() -> None:
    out = {}
    for itv, same_day in (("1d", False), ("60m", True), ("15m", True)):
        res, r, lp = analyse(itv, same_day)
        out[itv] = res
        print(f"\n=== {itv}: {res['bars']} bars {res['from'][:16]} -> {res['to'][:16]}")
        print(f"return corr {res['corr']:.3f} | beta PGSUS~THYAO {res['beta_pgsus_on_thyao']:.2f}")
        print("lead-lag corr(PGSUS_t, THYAO_t-k): " + "  ".join(f"k={k:+d}:{v:+.3f}" for k, v in res["lead_lag"].items()))
        print("Granger THYAO->PGSUS p: " + ", ".join(f"lag{l}={p:.4f}" for l, p in res["granger_thyao_to_pgsus_p"].items()))
        print("Granger PGSUS->THYAO p: " + ", ".join(f"lag{l}={p:.4f}" for l, p in res["granger_pgsus_to_thyao_p"].items()))
        print(f"cointegration p {res['coint_p']:.4f} | hedge {res['hedge_ratio']:.2f} | spread half-life {res['half_life_bars']:.1f} bars")
        if itv == "1d":
            # stability: rolling 1y correlation and 2y cointegration windows
            yearly = r.groupby(r.index.year).apply(lambda x: x[A].corr(x[B]))
            print("yearly return corr: " + "  ".join(f"{y}:{c:.2f}" for y, c in yearly.items()))
            wins = []
            for start in pd.date_range("2014-01-01", lp.index.max() - pd.DateOffset(years=2), freq="6MS"):
                w = lp[(lp.index >= start) & (lp.index < start + pd.DateOffset(years=2))]
                wins.append(coint(w[A], w[B])[1])
            share = float(np.mean(np.array(wins) < 0.05))
            out[itv]["coint_2y_windows_share"] = share
            out[itv]["yearly_corr"] = {int(k): float(v) for k, v in yearly.items()}
            print(f"2-year windows cointegrated at 5%: {share:.0%} of {len(wins)}")
    (DATA / "analysis.json").write_text(json.dumps(json.loads(pd.Series(out).to_json()), indent=1))


if __name__ == "__main__":
    main()
