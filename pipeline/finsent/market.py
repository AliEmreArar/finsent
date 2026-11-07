"""Market data extraction.

Two sources are supported:

* ``sqlite`` (default) - the BIST daily history that already lives in this
  repository (``bist_model_ready.db``, ~2.1M rows, 1996-2025, 586 symbols,
  with precomputed technical indicators).
* ``yfinance`` - incremental pulls for ``<SYMBOL>.IS`` tickers; indicators are
  computed locally so both sources produce the same schema.

Both return a DataFrame with the canonical columns in ``MARKET_COLUMNS``.
"""
from __future__ import annotations

import logging
import sqlite3
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

from .config import Settings

log = logging.getLogger(__name__)

MARKET_COLUMNS = [
    "symbol", "trade_date", "open", "high", "low", "close", "volume_try",
    "market_cap_try", "bist100", "usd_try", "pct_change", "rsi_14",
    "macd", "macd_signal", "macd_hist", "sma_50", "sma_200",
    "bb_lower", "bb_mid", "bb_upper", "open_is_estimated", "source",
]

_SQLITE_COLUMN_MAP = {
    "symbol": "symbol",
    "date": "trade_date",
    "high": "high",
    "low": "low",
    "close": "close",
    "volume_try": "volume_try",
    "market_cap_try": "market_cap_try",
    "BIST": "bist100",
    "usd_kur_price": "usd_try",
    "pct_change": "pct_change",
    "RSI_14": "rsi_14",
    "MACD_12_26_9": "macd",
    "MACDs_12_26_9": "macd_signal",
    "MACDh_12_26_9": "macd_hist",
    "SMA_50": "sma_50",
    "SMA_200": "sma_200",
    "BBL_20_2.0_2.0": "bb_lower",
    "BBM_20_2.0_2.0": "bb_mid",
    "BBU_20_2.0_2.0": "bb_upper",
}


def _add_estimated_open(df: pd.DataFrame) -> pd.DataFrame:
    """The source history has no opening price; use the previous close.

    Pattern detectors that depend on the candle body treat these rows with the
    ``open_is_estimated`` flag in mind.
    """
    df = df.sort_values(["symbol", "trade_date"])
    df["open"] = df.groupby("symbol")["close"].shift(1)
    df["open_is_estimated"] = True
    return df


def load_from_sqlite(settings: Settings, start: date, end: date,
                     symbols: list[str] | None = None) -> pd.DataFrame:
    # Pull a short look-back so the first requested day still gets an estimated open.
    lookback_start = start - timedelta(days=10)
    cols = ", ".join(f'"{c}"' for c in _SQLITE_COLUMN_MAP)
    sql = f"SELECT {cols} FROM model_data WHERE date >= ? AND date <= ?"
    params: list = [lookback_start.isoformat(), end.isoformat()]
    if symbols:
        sql += f" AND symbol IN ({','.join('?' * len(symbols))})"
        params.extend(symbols)

    uri = f"file:{settings.market_sqlite_path}?mode=ro"
    with sqlite3.connect(uri, uri=True) as conn:
        df = pd.read_sql_query(sql, conn, params=params)
    df = df.rename(columns=_SQLITE_COLUMN_MAP)
    df["trade_date"] = pd.to_datetime(df["trade_date"]).dt.date
    df = _add_estimated_open(df)
    df["source"] = "sqlite"
    df = df[(df["trade_date"] >= start) & (df["trade_date"] <= end)]
    log.info("sqlite market rows %s..%s: %d", start, end, len(df))
    return df[MARKET_COLUMNS].reset_index(drop=True)


def load_from_updates(settings: Settings, start: date, end: date,
                      symbols: list[str] | None = None) -> pd.DataFrame:
    """Yahoo bars written by ``market_refresh`` (same columns + a real open)."""
    path = Path(settings.market_updates_path)
    if not path.exists():
        return pd.DataFrame(columns=MARKET_COLUMNS)
    cols = ", ".join(f'"{c}"' for c in [*_SQLITE_COLUMN_MAP, "open"])
    sql = f"SELECT {cols} FROM model_data WHERE date >= ? AND date <= ?"
    params: list = [start.isoformat(), end.isoformat()]
    if symbols:
        sql += f" AND symbol IN ({','.join('?' * len(symbols))})"
        params.extend(symbols)
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as conn:
        df = pd.read_sql_query(sql, conn, params=params)
    df = df.rename(columns=_SQLITE_COLUMN_MAP)
    df["trade_date"] = pd.to_datetime(df["trade_date"]).dt.date
    df["open_is_estimated"] = False
    df["source"] = "yahoo"
    log.info("yahoo update rows %s..%s: %d", start, end, len(df))
    return df[MARKET_COLUMNS].reset_index(drop=True)


def _history_end(settings: Settings) -> date:
    uri = f"file:{settings.market_sqlite_path}?mode=ro"
    with sqlite3.connect(uri, uri=True) as conn:
        return date.fromisoformat(conn.execute("SELECT MAX(date) FROM model_data").fetchone()[0][:10])


def load_auto(settings: Settings, start: date, end: date,
              symbols: list[str] | None = None) -> pd.DataFrame:
    """Original history up to its last day, Yahoo updates after it."""
    hist_end = _history_end(settings)
    parts = []
    if start <= hist_end:
        parts.append(load_from_sqlite(settings, start, min(end, hist_end), symbols))
    if end > hist_end:
        parts.append(load_from_updates(settings, max(start, hist_end + timedelta(days=1)), end, symbols))
    parts = [p for p in parts if not p.empty]
    if not parts:
        return pd.DataFrame(columns=MARKET_COLUMNS)
    return pd.concat(parts, ignore_index=True)


def compute_indicators(df: pd.DataFrame) -> pd.DataFrame:
    """RSI(14), MACD(12,26,9), SMA(50/200), Bollinger(20,2) per symbol."""
    def per_symbol(g: pd.DataFrame) -> pd.DataFrame:
        g = g.sort_values("trade_date").copy()
        close = g["close"]
        g["pct_change"] = close.pct_change()
        delta = close.diff()
        gain = delta.clip(lower=0).ewm(alpha=1 / 14, adjust=False).mean()
        loss = (-delta.clip(upper=0)).ewm(alpha=1 / 14, adjust=False).mean()
        rs = gain / loss.replace(0, np.nan)
        g["rsi_14"] = 100 - 100 / (1 + rs)
        ema12 = close.ewm(span=12, adjust=False).mean()
        ema26 = close.ewm(span=26, adjust=False).mean()
        g["macd"] = ema12 - ema26
        g["macd_signal"] = g["macd"].ewm(span=9, adjust=False).mean()
        g["macd_hist"] = g["macd"] - g["macd_signal"]
        g["sma_50"] = close.rolling(50).mean()
        g["sma_200"] = close.rolling(200).mean()
        mid = close.rolling(20).mean()
        std = close.rolling(20).std(ddof=0)
        g["bb_mid"], g["bb_lower"], g["bb_upper"] = mid, mid - 2 * std, mid + 2 * std
        return g

    frames = [per_symbol(g) for _, g in df.groupby("symbol", sort=False)]
    return pd.concat(frames, ignore_index=True) if frames else df


def load_from_yfinance(start: date, end: date, symbols: list[str]) -> pd.DataFrame:
    import yfinance as yf  # optional dependency

    # 300 calendar days of warm-up so SMA_200 is defined on the first requested day.
    warmup_start = start - timedelta(days=300)
    frames = []
    for sym in symbols:
        hist = yf.Ticker(f"{sym}.IS").history(
            start=warmup_start.isoformat(), end=(end + timedelta(days=1)).isoformat(),
            auto_adjust=False,
        )
        if hist.empty:
            log.warning("yfinance returned no rows for %s", sym)
            continue
        hist = hist.reset_index()
        frames.append(pd.DataFrame({
            "symbol": sym,
            "trade_date": pd.to_datetime(hist["Date"]).dt.date,
            "open": hist["Open"], "high": hist["High"], "low": hist["Low"],
            "close": hist["Close"], "volume_try": hist["Volume"] * hist["Close"],
        }))
    if not frames:
        return pd.DataFrame(columns=MARKET_COLUMNS)
    df = compute_indicators(pd.concat(frames, ignore_index=True))
    for col in ("market_cap_try", "bist100", "usd_try"):
        df[col] = np.nan
    df["open_is_estimated"] = False
    df["source"] = "yfinance"
    df = df[(df["trade_date"] >= start) & (df["trade_date"] <= end)]
    return df[MARKET_COLUMNS].reset_index(drop=True)


def list_symbols(settings: Settings) -> set[str] | None:
    if settings.market_source not in ("sqlite", "auto"):
        return None
    uri = f"file:{settings.market_sqlite_path}?mode=ro"
    with sqlite3.connect(uri, uri=True) as conn:
        return {r[0] for r in conn.execute("SELECT DISTINCT symbol FROM model_data")}


def extract_market(settings: Settings, start: date, end: date,
                   symbols: list[str] | None = None) -> pd.DataFrame:
    if settings.market_source == "auto":
        return load_auto(settings, start, end, symbols)
    if settings.market_source == "sqlite":
        return load_from_sqlite(settings, start, end, symbols)
    if settings.market_source == "yfinance":
        if not symbols:
            raise ValueError("yfinance source needs an explicit symbol list")
        return load_from_yfinance(start, end, symbols)
    raise ValueError(f"unknown market source: {settings.market_source}")
