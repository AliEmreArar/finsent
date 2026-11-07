"""Gold, silver, FX and the BIST 100 index as chartable "instruments" (Yahoo Finance daily).

They live in the serving table ``market_daily`` with ``source = 'instrument'``, so every chart,
agent tool and pair comparison works on them, while equity-only views (screens, breadth,
movers) leave them out. Gram prices in TL are derived: ounce price x USD/TRY / 31.1035.

    python -m finsent.instruments
"""
from __future__ import annotations

import logging

import numpy as np
import pandas as pd

from . import mysql_sink
from .config import get_settings
from .market import compute_indicators

log = logging.getLogger(__name__)
OZ_TO_GRAM = 31.1034768

INSTRUMENTS = {
    "XAUUSD": {"yahoo": "GC=F", "name": "Ons altın (USD)"},
    "XAGUSD": {"yahoo": "SI=F", "name": "Ons gümüş (USD)"},
    "USDTRY": {"yahoo": "USDTRY=X", "name": "Dolar / TL"},
    "EURTRY": {"yahoo": "EURTRY=X", "name": "Euro / TL"},
    "XU100": {"yahoo": "XU100.IS", "name": "BIST 100 endeksi"},
    "ALTIN": {"derived": ("XAUUSD", "USDTRY"), "name": "Gram altın (TL)"},
    "GUMUS": {"derived": ("XAGUSD", "USDTRY"), "name": "Gram gümüş (TL)"},
}
# Instruments quoted in USD: a TL / USD toggle does not apply to them as-is
USD_QUOTED = {"XAUUSD", "XAGUSD"}


def _download() -> dict[str, pd.DataFrame]:
    import yfinance as yf

    out = {}
    for sym, spec in INSTRUMENTS.items():
        if "yahoo" not in spec:
            continue
        d = yf.download(spec["yahoo"], period="max", interval="1d", progress=False, auto_adjust=False)
        if isinstance(d.columns, pd.MultiIndex):
            d.columns = d.columns.get_level_values(0)
        d = d.dropna(subset=["Close"])
        d.index = pd.to_datetime(d.index).date
        out[sym] = d[["Open", "High", "Low", "Close", "Volume"]].astype(float)
    return out


def build() -> pd.DataFrame:
    raw = _download()
    usd = raw["USDTRY"]["Close"]
    idx = raw["XU100"]["Close"]
    for sym, spec in INSTRUMENTS.items():
        if "derived" in spec:
            oz, fx = spec["derived"]
            a, b = raw[oz], raw[fx].reindex(raw[oz].index).ffill()
            d = pd.DataFrame({c: a[c] * b["Close"] / OZ_TO_GRAM for c in ("Open", "High", "Low", "Close")})
            d["Volume"] = 0.0
            raw[sym] = d.dropna()
    frames = []
    for sym, d in raw.items():
        f = pd.DataFrame({"symbol": sym, "trade_date": list(d.index), "open": d["Open"].to_numpy(),
                          "high": d["High"].to_numpy(), "low": d["Low"].to_numpy(), "close": d["Close"].to_numpy(),
                          "volume_try": (d["Volume"] * d["Close"]).to_numpy() if sym == "XU100" else 0.0})
        frames.append(f)
    df = compute_indicators(pd.concat(frames, ignore_index=True))
    df["usd_try"] = df["trade_date"].map(usd).astype(float)
    df["usd_try"] = df.groupby("symbol")["usd_try"].ffill()
    df["bist100"] = df["trade_date"].map(idx).astype(float)
    df["market_cap_try"] = np.nan
    df["open_is_estimated"] = False
    df["source"] = "instrument"
    df = df.replace([np.inf, -np.inf], np.nan)
    return df


def refresh() -> dict:
    settings = get_settings()
    df = build()
    with mysql_sink.connect(settings) as conn:
        n = mysql_sink.upsert(conn, "market_daily", df, mysql_sink.MARKET_COLS, batch=5000)
        titles = pd.DataFrame({"symbol": list(INSTRUMENTS), "title": [v["name"] for v in INSTRUMENTS.values()]})
        mysql_sink.upsert(conn, "companies", titles, ["symbol", "title"])
    last = df.sort_values("trade_date").groupby("symbol").tail(1)
    out = {"rows": n, "last": {r.symbol: [str(r.trade_date), round(float(r.close), 4)] for r in last.itertuples()}}
    log.info("instruments refreshed: %s", out)
    return out


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print(refresh())
