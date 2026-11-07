"""Bring market data up to date from Yahoo Finance (yfinance, free, delayed).

The original history (``bist_model_ready.db``) is never modified. New bars go
to a separate SQLite file (``FINSENT_MARKET_UPDATES``, default
``data/market/bist_updates.db``) with the same ``model_data`` columns plus a
real ``open``; ``market.extract_market`` in ``auto`` mode serves the original
history up to its last day and the updates after it.

Indicators (RSI/MACD/SMA/Bollinger) are computed on the Yahoo series itself
with ~300 days of warm-up, so they stay consistent across splits/bonus issues
that Yahoo adjusts for. Market cap columns are not available from Yahoo and
stay NULL.

    python -m finsent.market_refresh               # from the day after the last stored bar to today
    python -m finsent.market_refresh --start 2026-10-01 --symbols ASELS,THYAO
"""
from __future__ import annotations

import argparse
import logging
import sqlite3
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

from .config import Settings, get_settings
from .market import compute_indicators

log = logging.getLogger(__name__)

INDEX_TICKER = "XU100.IS"
FX_TICKER = "USDTRY=X"
TABLE_COLUMNS = [
    "symbol", "date", "open", "close", "low", "high", "volume", "volume_try", "BIST",
    "usd_kur_price", "close_usd", "relative_to_index", "volume_usd", "market_cap_try",
    "pct_change", "RSI_14", "MACD_12_26_9", "MACDh_12_26_9", "MACDs_12_26_9", "SMA_50", "SMA_200",
    "BBL_20_2.0_2.0", "BBM_20_2.0_2.0", "BBU_20_2.0_2.0", "source",
]


def updates_path(settings: Settings) -> Path:
    return Path(settings.market_updates_path)


def _ensure_table(conn: sqlite3.Connection) -> None:
    cols = ", ".join(f'"{c}" {"TEXT" if c in ("symbol", "date", "source") else "REAL"}' for c in TABLE_COLUMNS)
    conn.execute(f"CREATE TABLE IF NOT EXISTS model_data ({cols}, PRIMARY KEY (symbol, date))")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_updates_date ON model_data(date)")


def history_last_date(settings: Settings) -> date | None:
    uri = f"file:{settings.market_sqlite_path}?mode=ro"
    with sqlite3.connect(uri, uri=True) as conn:
        row = conn.execute("SELECT MAX(date) FROM model_data").fetchone()
    return date.fromisoformat(row[0][:10]) if row and row[0] else None


def updates_last_date(settings: Settings) -> date | None:
    p = updates_path(settings)
    if not p.exists():
        return None
    with sqlite3.connect(p) as conn:
        try:
            row = conn.execute("SELECT MAX(date) FROM model_data").fetchone()
        except sqlite3.OperationalError:
            return None
    return date.fromisoformat(row[0][:10]) if row and row[0] else None


def symbol_universe(settings: Settings, extra: set[str] | None = None) -> list[str]:
    """Symbols still trading at the end of the history, plus anything already in the
    updates DB and any ``extra`` codes (e.g. new listings seen in KAP disclosures)."""
    uri = f"file:{settings.market_sqlite_path}?mode=ro"
    with sqlite3.connect(uri, uri=True) as conn:
        cutoff = conn.execute("SELECT date(MAX(date), '-30 day') FROM model_data").fetchone()[0]
        rows = {r[0] for r in conn.execute("SELECT DISTINCT symbol FROM model_data WHERE date >= ?", (cutoff,))}
    p = updates_path(settings)
    if p.exists():
        with sqlite3.connect(p) as conn:
            try:
                rows |= {r[0] for r in conn.execute("SELECT DISTINCT symbol FROM model_data")}
            except sqlite3.OperationalError:
                pass
    rows |= {s for s in (extra or set()) if s.isalnum() and 3 <= len(s) <= 6}
    return sorted(rows)


def _download(tickers: list[str], start: date, end: date) -> pd.DataFrame:
    import yfinance as yf

    frames = []
    for i in range(0, len(tickers), 100):  # chunks keep each request reasonable
        chunk = tickers[i:i + 100]
        data = yf.download(chunk, start=start.isoformat(), end=(end + timedelta(days=1)).isoformat(),
                           group_by="ticker", auto_adjust=False, progress=False, threads=True)
        if data.empty:
            continue
        for t in chunk:
            if t not in data.columns.get_level_values(0):
                continue
            x = data[t].dropna(subset=["Close"])
            if x.empty:
                continue
            frames.append(pd.DataFrame({
                "ticker": t, "trade_date": pd.to_datetime(x.index).date,
                "open": x["Open"].values, "high": x["High"].values, "low": x["Low"].values,
                "close": x["Close"].values, "volume": x["Volume"].values,
            }))
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def refresh(settings: Settings, start: date | None = None, end: date | None = None,
            symbols: list[str] | None = None, extra_symbols: set[str] | None = None) -> dict:
    hist_end = history_last_date(settings)
    start = start or max(d for d in (hist_end, updates_last_date(settings)) if d) + timedelta(days=1)
    end = end or date.today()
    if start > end:
        return {"rows": 0, "start": str(start), "end": str(end), "note": "already up to date"}
    symbols = symbols or symbol_universe(settings, extra_symbols)
    warmup = start - timedelta(days=420)  # ~300 trading days for SMA200

    tickers = [f"{s}.IS" for s in symbols] + [INDEX_TICKER, FX_TICKER]
    raw = _download(tickers, warmup, end)
    if raw.empty:
        raise RuntimeError("Yahoo returned no data")
    idx = raw[raw.ticker == INDEX_TICKER].set_index("trade_date")["close"].rename("bist100")
    fx = raw[raw.ticker == FX_TICKER].set_index("trade_date")["close"].rename("usd_try")
    bars = raw[raw.ticker.str.endswith(".IS") & (raw.ticker != INDEX_TICKER)].copy()
    bars["symbol"] = bars.ticker.str[:-3]
    bars = bars.join(idx, on="trade_date").join(fx, on="trade_date")
    bars["usd_try"] = bars.groupby("symbol")["usd_try"].ffill()
    bars["volume_try"] = bars["volume"] * bars["close"]
    bars = compute_indicators(bars.drop(columns="ticker"))
    bars = bars[(bars.trade_date >= start) & (bars.trade_date <= end)]

    out = pd.DataFrame({
        "symbol": bars["symbol"], "date": bars["trade_date"].astype(str), "open": bars["open"],
        "close": bars["close"], "low": bars["low"], "high": bars["high"], "volume": bars["volume"],
        "volume_try": bars["volume_try"], "BIST": bars["bist100"], "usd_kur_price": bars["usd_try"],
        "close_usd": bars["close"] / bars["usd_try"],
        "relative_to_index": bars["close"] / bars["bist100"],
        "volume_usd": bars["volume_try"] / bars["usd_try"], "market_cap_try": np.nan,
        "pct_change": bars["pct_change"], "RSI_14": bars["rsi_14"], "MACD_12_26_9": bars["macd"],
        "MACDh_12_26_9": bars["macd_hist"], "MACDs_12_26_9": bars["macd_signal"],
        "SMA_50": bars["sma_50"], "SMA_200": bars["sma_200"], "BBL_20_2.0_2.0": bars["bb_lower"],
        "BBM_20_2.0_2.0": bars["bb_mid"], "BBU_20_2.0_2.0": bars["bb_upper"], "source": "yahoo",
    })
    out = out.replace([np.inf, -np.inf], np.nan)

    p = updates_path(settings)
    p.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(p) as conn:
        _ensure_table(conn)
        cols = ", ".join(f'"{c}"' for c in TABLE_COLUMNS)
        conn.executemany(f"INSERT OR REPLACE INTO model_data ({cols}) VALUES ({','.join('?' * len(TABLE_COLUMNS))})",
                         [tuple(None if (isinstance(v, float) and np.isnan(v)) else v for v in r)
                          for r in out[TABLE_COLUMNS].itertuples(index=False, name=None)])
    got = out["symbol"].nunique()
    log.info("market refresh %s..%s: %d rows, %d/%d symbols -> %s", start, end, len(out), got, len(symbols), p)
    return {"rows": len(out), "symbols": got, "requested": len(symbols), "start": str(start),
            "end": str(end), "last_bar": out["date"].max() if len(out) else None,
            "missing_symbols": sorted(set(symbols) - set(out["symbol"]))[:50]}


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", type=date.fromisoformat)
    ap.add_argument("--end", type=date.fromisoformat)
    ap.add_argument("--symbols", help="comma separated, default: all active symbols")
    a = ap.parse_args()
    syms = [s.strip().upper() for s in a.symbols.split(",")] if a.symbols else None
    print(refresh(get_settings(), a.start, a.end, syms))


if __name__ == "__main__":
    main()
