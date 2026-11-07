"""PGSUS / THYAO strategy backtests with costs and an in-sample / out-of-sample split.

Strategies
----------
1. catch_up (intraday 5m / 15m / 60m) - "PGSUS follows THYAO":
   when THYAO's move over the last `look` bars beats PGSUS's beta-adjusted move by more
   than `thr`, buy PGSUS at that bar's close and hold `hold` bars (long-only; an optional
   short side is reported separately). Never holds overnight.
2. pairs_z (daily) - classic market-neutral pairs trade on the log-price spread with a
   rolling hedge ratio: enter when the z-score passes ±`entry`, exit at ±`exit`, stop at ±4.
3. switch (daily, long-only) - always hold one of the two; switch into whichever is cheap
   relative to the other (z-score of the spread), versus buy-and-hold benchmarks.

Parameters are chosen on the first part of each sample only (in-sample) and reported on
the remainder (out-of-sample). Costs are per side, as a fraction of traded value.

    python scripts/pairs_backtest.py
"""
import itertools
import json
import warnings
from pathlib import Path

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")
DATA = Path(__file__).resolve().parents[1] / "data" / "research" / "pairs"
A, B = "PGSUS", "THYAO"
COSTS = (0.0, 0.0005, 0.001, 0.0015)  # per side: 0 / 5 / 10 / 15 bps


INTRADAY_DB = Path(__file__).resolve().parents[1] / "data" / "market" / "intraday.db"


def load(itv: str) -> pd.DataFrame:
    if itv in ("5m", "15m") and INTRADAY_DB.exists():
        # prefer the accumulating store (grows every day the pipeline runs) over the one-off download
        import sqlite3
        with sqlite3.connect(INTRADAY_DB) as conn:
            raw = pd.read_sql_query("SELECT symbol, ts, open, close FROM bars WHERE interval = ? AND symbol IN (?, ?)",
                                    conn, params=[itv, A, B])
        if raw["symbol"].nunique() == 2:
            raw["time"] = pd.to_datetime(raw["ts"], unit="s", utc=True).dt.tz_convert("Europe/Istanbul")
            wide = raw.pivot(index="time", columns="symbol", values=["open", "close"]).sort_index()
            out = pd.DataFrame({f"{s}_{f.capitalize()}": wide[(f, s)] for s in (A, B) for f in ("open", "close")}).dropna()
            return out.iloc[out.index.indexer_between_time("09:30", "17:59")]
    df = pd.read_parquet(DATA / f"{itv}.parquet")
    out = pd.DataFrame({f"{s}_{f}": df[(s, f)] for s in (A, B) for f in ("Open", "Close")}).dropna()
    if itv != "1d":
        out = out.iloc[out.index.indexer_between_time("09:30", "17:59")]
    return out


def stats(trade_rets: pd.Series, bars_per_year: float, n_bars: int, label: str) -> dict:
    tr = trade_rets.dropna()
    if tr.empty:
        return {"strategy": label, "trades": 0}
    eq = (1 + tr).cumprod()
    years = n_bars / bars_per_year
    dd = (eq / eq.cummax() - 1).min()
    return {"strategy": label, "trades": int(len(tr)), "win_rate": float((tr > 0).mean()),
            "avg_trade": float(tr.mean()), "total_return": float(eq.iloc[-1] - 1),
            "annualised": float(eq.iloc[-1] ** (1 / years) - 1) if years > 0 and eq.iloc[-1] > 0 else None,
            "max_drawdown": float(dd), "trades_per_year": float(len(tr) / years) if years else None}


# ------------------------------------------------------------------ 1) intraday catch-up
def catch_up_trades(px: pd.DataFrame, look: int, thr: float, hold: int, beta: float, side: str = "long") -> pd.Series:
    ca, cb = px[f"{A}_Close"], px[f"{B}_Close"]
    day = pd.Series(px.index.date, index=px.index)
    ra, rb = np.log(ca / ca.shift(look)), np.log(cb / cb.shift(look))
    same = day.eq(day.shift(look)) & day.eq(day.shift(-hold))  # signal window and holding inside one session
    gap = beta * rb - ra
    fwd = ca.shift(-hold) / ca - 1
    sig = (gap > thr) if side == "long" else (gap < -thr)
    sig &= same
    # no overlapping positions: take a signal only after the previous trade has closed
    idx, last_exit, out = np.flatnonzero(sig.to_numpy()), -1, []
    for i in idx:
        if i > last_exit:
            out.append(i)
            last_exit = i + hold
    r = fwd.iloc[out]
    return r if side == "long" else -r


def run_catch_up(itv: str, bars_per_year: float, grid: dict) -> dict:
    px = load(itv)
    n = len(px)
    split = int(n * 0.6)
    ins, oos = px.iloc[:split], px.iloc[split:]
    # beta from in-sample returns only
    r = np.log(ins[[f"{A}_Close", f"{B}_Close"]]).diff().dropna()
    beta = float(np.cov(r.iloc[:, 0], r.iloc[:, 1])[0, 1] / r.iloc[:, 1].var())
    rows = []
    for look, thr, hold in itertools.product(grid["look"], grid["thr"], grid["hold"]):
        tr = catch_up_trades(ins, look, thr, hold, beta)
        if len(tr) >= 20:
            rows.append({"look": look, "thr": thr, "hold": hold, "n": len(tr), "avg": tr.mean(), "win": (tr > 0).mean()})
    grid_df = pd.DataFrame(rows).sort_values("avg", ascending=False)
    best = grid_df.iloc[0].to_dict()
    res = {"interval": itv, "bars": n, "in_sample": [str(ins.index[0]), str(ins.index[-1])],
           "out_of_sample": [str(oos.index[0]), str(oos.index[-1])], "beta": beta,
           "best_in_sample": {k: (float(v) if isinstance(v, (float, np.floating)) else int(v)) for k, v in best.items()},
           "grid_top5": grid_df.head(5).round(5).to_dict("records"), "oos": {}}
    look, thr, hold = int(best["look"]), float(best["thr"]), int(best["hold"])
    for side in ("long", "short"):
        tr = catch_up_trades(oos, look, thr, hold, beta, side)
        # benchmark: same number of random same-session entries with the same holding period
        rng = np.random.default_rng(0)
        ca = oos[f"{A}_Close"]
        day = pd.Series(oos.index.date, index=oos.index)
        ok = np.flatnonzero(day.eq(day.shift(-hold)).to_numpy())
        rand = (ca.shift(-hold) / ca - 1).iloc[rng.choice(ok, size=min(len(ok), max(len(tr), 1) * 20))]
        if side == "long":
            res["oos_trades_long"] = [{"t": str(t), "r": round(float(x), 5)} for t, x in tr.items()]
        res["oos"][side] = {
            "gross_avg_trade": float(tr.mean()) if len(tr) else None,
            "random_entry_avg": float(rand.mean() if side == "long" else -rand.mean()),
            "by_cost": [stats(tr - 2 * c, bars_per_year, len(oos), f"{side} @ {c * 1e4:.0f}bps/side") for c in COSTS]}
    return res


# ------------------------------------------------------------------ 2) + 3) daily pairs / switching
def spread_z(px: pd.DataFrame, win: int) -> tuple[pd.Series, pd.Series]:
    la, lb = np.log(px[f"{A}_Close"]), np.log(px[f"{B}_Close"])
    beta = la.rolling(win).cov(lb) / lb.rolling(win).var()
    spread = la - beta * lb
    z = (spread - spread.rolling(win).mean()) / spread.rolling(win).std()
    return z.shift(1), beta.shift(1)  # decided on yesterday's close, traded today


def pairs_daily(px: pd.DataFrame, win: int, entry: float, exit_: float, cost: float) -> pd.Series:
    z, beta = spread_z(px, win)
    ra, rb = px[f"{A}_Close"].pct_change(), px[f"{B}_Close"].pct_change()
    pos = pd.Series(0.0, index=px.index)
    state = 0
    for i, zi in enumerate(z.to_numpy()):
        if np.isnan(zi):
            continue
        if state == 0 and zi > entry:
            state = -1   # PGSUS rich: short PGSUS, long THYAO
        elif state == 0 and zi < -entry:
            state = 1    # PGSUS cheap: long PGSUS, short THYAO
        elif state != 0 and (abs(zi) < exit_ or abs(zi) > 4):
            state = 0
        pos.iloc[i] = state
    b = beta.clip(0.3, 2.0).fillna(1.0)
    gross = pos * (ra - b * rb) / (1 + b)          # dollar-neutral, normalised to 1 unit of capital
    turnover = pos.diff().abs().fillna(0) * 2        # both legs trade on every position change
    return gross - turnover * cost


def switch_daily(px: pd.DataFrame, win: int, band: float, cost: float) -> pd.Series:
    z, _ = spread_z(px, win)
    ra, rb = px[f"{A}_Close"].pct_change(), px[f"{B}_Close"].pct_change()
    hold = pd.Series(np.nan, index=px.index)
    cur = "B"
    for i, zi in enumerate(z.to_numpy()):
        if not np.isnan(zi):
            if zi < -band:
                cur = "A"     # PGSUS cheap vs THYAO -> hold PGSUS
            elif zi > band:
                cur = "B"
        hold.iloc[i] = 1.0 if cur == "A" else 0.0
    h = hold.fillna(0)
    switches = h.diff().abs().fillna(0)
    return h * ra + (1 - h) * rb - switches * 2 * cost   # sell one, buy the other


def run_daily() -> dict:
    px = load("1d")
    cut = pd.Timestamp("2021-01-01")
    ins, oos = px[px.index < cut], px[px.index >= cut]
    out = {"in_sample": [str(ins.index[0].date()), str(ins.index[-1].date())],
           "out_of_sample": [str(oos.index[0].date()), str(oos.index[-1].date())]}
    def perf(r: pd.Series) -> dict:
        r = r.dropna()
        eq = (1 + r).cumprod()
        yrs = len(r) / 252
        return {"total_return": float(eq.iloc[-1] - 1), "annualised": float(eq.iloc[-1] ** (1 / yrs) - 1),
                "max_drawdown": float((eq / eq.cummax() - 1).min()), "sharpe": float(r.mean() / r.std() * np.sqrt(252))}
    # pairs: pick on in-sample at 10 bps
    best = max(((w, e, x) for w in (40, 60, 120) for e in (1.5, 2.0, 2.5) for x in (0.0, 0.5)),
               key=lambda p: perf(pairs_daily(ins, *p, 0.001))["sharpe"])
    out["pairs_best_params"] = {"window": best[0], "entry_z": best[1], "exit_z": best[2]}
    out["pairs_in_sample"] = perf(pairs_daily(ins, *best, 0.001))
    full = pairs_daily(px, *best, 0.001)
    out["pairs_oos_by_cost"] = {f"{c * 1e4:.0f}bps": perf(pairs_daily(px, *best, c)[px.index >= cut]) for c in COSTS}
    out["pairs_oos_trades"] = int((full[px.index >= cut] != 0).astype(int).diff().abs().sum() / 2)
    # switching vs buy & hold
    bestsw = max(((w, b) for w in (40, 60, 120) for b in (1.0, 1.5, 2.0)),
                 key=lambda p: perf(switch_daily(ins, *p, 0.001))["sharpe"])
    out["switch_best_params"] = {"window": bestsw[0], "band_z": bestsw[1]}
    out["switch_oos_by_cost"] = {f"{c * 1e4:.0f}bps": perf(switch_daily(px, *bestsw, c)[px.index >= cut]) for c in COSTS}
    ra, rb = px[f"{A}_Close"].pct_change(), px[f"{B}_Close"].pct_change()
    out["buy_hold_oos"] = {"THYAO": perf(rb[px.index >= cut]), "PGSUS": perf(ra[px.index >= cut]),
                           "50/50 rebalanced daily": perf((0.5 * ra + 0.5 * rb)[px.index >= cut])}
    # out-of-sample equity curves (weekly points) at 10 bps per side for the UI
    o = px.index >= cut
    curves = {"pairs": pairs_daily(px, *best, 0.001)[o], "switch": switch_daily(px, *bestsw, 0.001)[o],
              "THYAO": rb[o], "PGSUS": ra[o]}
    eq = pd.DataFrame({k: (1 + v.fillna(0)).cumprod() for k, v in curves.items()}).resample("W-FRI").last()
    out["equity_oos"] = {"dates": [str(d.date()) for d in eq.index], **{k: eq[k].round(4).tolist() for k in eq}}
    return out


def publish(results: dict) -> None:
    """Store the study in MySQL (research_results) so the dashboard can show it."""
    import os

    import pymysql

    analysis = json.loads((DATA / "analysis.json").read_text()) if (DATA / "analysis.json").exists() else {}
    payload = json.dumps({"pair": [A, B], "analysis": analysis, "backtest": results,
                          "generated_at": pd.Timestamp.now(tz="Europe/Istanbul").isoformat()}, default=float)
    try:
        conn = pymysql.connect(host=os.environ.get("MYSQL_HOST", "localhost"), port=int(os.environ.get("MYSQL_PORT", 3307)),
                               user="finsent", password=os.environ.get("MYSQL_PASSWORD", "finsent"), database="finsent")
        with conn, conn.cursor() as cur:
            cur.execute("CREATE TABLE IF NOT EXISTS research_results (rkey VARCHAR(64) PRIMARY KEY, payload JSON NOT NULL, "
                        "updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)")
            cur.execute("REPLACE INTO research_results (rkey, payload) VALUES (%s, %s)", (f"pairs:{A}:{B}", payload))
            conn.commit()
        print("published to MySQL research_results")
    except Exception as e:  # noqa: BLE001
        print("could not publish:", e)


def main() -> None:
    results = {"daily": run_daily()}
    grids = {
        "5m": dict(look=[1, 2, 3, 6], thr=[0.002, 0.003, 0.005, 0.008], hold=[1, 2, 3, 6, 12]),
        "15m": dict(look=[1, 2, 4], thr=[0.003, 0.005, 0.008, 0.012], hold=[1, 2, 4, 8]),
        "60m": dict(look=[1, 2, 3], thr=[0.005, 0.008, 0.012, 0.02], hold=[1, 2, 3, 6]),
    }
    per_year = {"5m": 252 * 100, "15m": 252 * 33, "60m": 252 * 9}
    for itv, g in grids.items():
        results[f"catch_up_{itv}"] = run_catch_up(itv, per_year[itv], g)
    (DATA / "backtest.json").write_text(json.dumps(results, indent=1, default=float))
    publish(results)

    d = results["daily"]
    print("=== DAILY (in-sample 2013-2020, out-of-sample 2021-2026)")
    print("pairs params", d["pairs_best_params"], "| OOS trades", d["pairs_oos_trades"])
    for k, v in d["pairs_oos_by_cost"].items():
        print(f"  pairs  {k:>6}: total {v['total_return']:+.1%} ann {v['annualised']:+.1%} maxDD {v['max_drawdown']:.1%} sharpe {v['sharpe']:.2f}")
    print("switch params", d["switch_best_params"])
    for k, v in d["switch_oos_by_cost"].items():
        print(f"  switch {k:>6}: total {v['total_return']:+.1%} ann {v['annualised']:+.1%} maxDD {v['max_drawdown']:.1%} sharpe {v['sharpe']:.2f}")
    for k, v in d["buy_hold_oos"].items():
        print(f"  hold {k:>22}: total {v['total_return']:+.1%} ann {v['annualised']:+.1%} maxDD {v['max_drawdown']:.1%} sharpe {v['sharpe']:.2f}")
    for itv in grids:
        r = results[f"catch_up_{itv}"]
        b = r["best_in_sample"]
        print(f"\n=== CATCH-UP {itv}: IS {r['in_sample'][0][:10]}..{r['in_sample'][1][:10]}  OOS {r['out_of_sample'][0][:10]}..{r['out_of_sample'][1][:10]}  beta {r['beta']:.2f}")
        print(f"  best IS: look {b['look']} thr {b['thr']:.3f} hold {b['hold']} | IS n={b['n']} avg {b['avg']:+.3%} win {b['win']:.0%}")
        for side, o in r["oos"].items():
            print(f"  OOS {side}: gross avg/trade {o['gross_avg_trade'] if o['gross_avg_trade'] is None else format(o['gross_avg_trade'], '+.3%')} vs random entry {o['random_entry_avg']:+.3%}")
            for s in o["by_cost"]:
                if s.get("trades"):
                    print(f"     {s['strategy']:>18}: trades {s['trades']:4d} win {s['win_rate']:.0%} avg {s['avg_trade']:+.3%} total {s['total_return']:+.1%} maxDD {s['max_drawdown']:.1%}")


if __name__ == "__main__":
    main()
