"""Accumulate intraday bars from Yahoo Finance (which only serves ~60 days of 5-minute and
~7 days of 1-minute history), so short-horizon studies such as the PGSUS / THYAO catch-up
test get a longer sample every day the pipeline runs.

Bars are upserted into ``data/market/intraday.db`` (table ``bars``), keyed by
(symbol, interval, ts). Symbols: ``FINSENT_INTRADAY_SYMBOLS`` (default PGSUS,THYAO,XU100).

    python -m finsent.intraday
"""
from __future__ import annotations

import logging
import os
import sqlite3
from pathlib import Path

import pandas as pd

from .config import Settings, get_settings

log = logging.getLogger(__name__)
INTERVALS = {"1m": "7d", "5m": "60d", "15m": "60d"}


def db_path(settings: Settings) -> Path:
    return Path(settings.market_updates_path).with_name("intraday.db")


def collect(settings: Settings, symbols: list[str] | None = None) -> dict:
    import yfinance as yf

    symbols = symbols or [s.strip().upper() for s in
                          os.environ.get("FINSENT_INTRADAY_SYMBOLS", "PGSUS,THYAO,XU100").split(",") if s.strip()]
    p = db_path(settings)
    p.parent.mkdir(parents=True, exist_ok=True)
    stats = {}
    with sqlite3.connect(p) as conn:
        conn.execute("CREATE TABLE IF NOT EXISTS bars (symbol TEXT, interval TEXT, ts INTEGER, open REAL, high REAL, "
                     "low REAL, close REAL, volume REAL, PRIMARY KEY (symbol, interval, ts))")
        for itv, period in INTERVALS.items():
            data = yf.download([f"{s}.IS" for s in symbols], period=period, interval=itv, group_by="ticker",
                               auto_adjust=True, progress=False, threads=True)
            rows = []
            for s in symbols:
                t = f"{s}.IS"
                if t not in data.columns.get_level_values(0):
                    continue
                x = data[t].dropna(subset=["Close"])
                # unit-independent epoch seconds (the index resolution may be ns, us or ms)
                ts = ((pd.DatetimeIndex(x.index).tz_convert("UTC") - pd.Timestamp("1970-01-01", tz="UTC"))
                      // pd.Timedelta(seconds=1)).astype(int)
                rows += list(zip([s] * len(x), [itv] * len(x), ts, x["Open"], x["High"], x["Low"], x["Close"], x["Volume"]))
            conn.executemany("INSERT OR REPLACE INTO bars VALUES (?,?,?,?,?,?,?,?)", rows)
            total = conn.execute("SELECT COUNT(*), MIN(ts), MAX(ts) FROM bars WHERE interval = ?", (itv,)).fetchone()
            stats[itv] = {"fetched": len(rows), "stored": total[0],
                          "from": str(pd.Timestamp(total[1], unit="s", tz="Europe/Istanbul")) if total[1] else None,
                          "to": str(pd.Timestamp(total[2], unit="s", tz="Europe/Istanbul")) if total[2] else None}
    log.info("intraday collect: %s", stats)
    return stats


def load(settings: Settings, symbols: list[str], interval: str) -> pd.DataFrame:
    """Wide frame of closes (and opens) indexed by Istanbul time, one column pair per symbol."""
    with sqlite3.connect(db_path(settings)) as conn:
        q = f"SELECT * FROM bars WHERE interval = ? AND symbol IN ({','.join('?' * len(symbols))})"
        df = pd.read_sql_query(q, conn, params=[interval, *symbols])
    df["time"] = pd.to_datetime(df["ts"], unit="s", utc=True).dt.tz_convert("Europe/Istanbul")
    return df.pivot(index="time", columns="symbol", values=["open", "close"]).sort_index()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print(collect(get_settings()))
