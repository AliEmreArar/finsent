"""Rule-based pattern recognition on daily bars, plus announcement event studies.

Detectors are vectorised per symbol and emit one row per (symbol, day, pattern)
with a direction and a 0..1 strength. Candlestick detectors depend on the open;
when the open is estimated from the previous close (the local BIST history has
no opens) their strength is halved and the row is flagged.
"""
from __future__ import annotations

import json
from datetime import time

import numpy as np
import pandas as pd

PATTERN_COLUMNS = ["symbol", "trade_date", "pattern", "category", "direction", "strength", "detail"]


def _emit(g: pd.DataFrame, mask: pd.Series, pattern: str, category: str, direction: str,
          strength: pd.Series | float, detail_cols: list[str]) -> pd.DataFrame:
    hit = g[mask.fillna(False)]
    if hit.empty:
        return pd.DataFrame(columns=PATTERN_COLUMNS)
    s = strength[mask.fillna(False)] if isinstance(strength, pd.Series) else strength
    details = hit[detail_cols].round(4).to_dict("records") if detail_cols else [{}] * len(hit)
    return pd.DataFrame({
        "symbol": hit["symbol"].values,
        "trade_date": hit["trade_date"].values,
        "pattern": pattern,
        "category": category,
        "direction": direction,
        "strength": np.clip(np.asarray(s, dtype=float), 0, 1).round(3) if not np.isscalar(s) else s,
        # NaN/inf are not valid JSON (MySQL's JSON column rejects them)
        "detail": [json.dumps({k: (None if isinstance(v, float) and not np.isfinite(v) else v)
                               for k, v in d.items()}, default=str) for d in details],
    })


def detect_symbol(g: pd.DataFrame) -> pd.DataFrame:
    g = g.sort_values("trade_date").reset_index(drop=True)
    o, h, l, c = g["open"], g["high"], g["low"], g["close"]
    rng = (h - l).replace(0, np.nan)
    body = (c - o).abs()
    upper = h - np.maximum(o, c)
    lower = np.minimum(o, c) - l
    est = g["open_is_estimated"].astype(bool)
    candle_w = np.where(est, 0.5, 1.0)
    out = []

    # --- candlesticks ---------------------------------------------------------
    doji = (body <= 0.1 * rng) & (rng / c > 0.01)
    out.append(_emit(g, doji, "doji", "candlestick", "neutral",
                     pd.Series((1 - body / rng) * candle_w, index=g.index), ["open", "close"]))
    downtrend = c.shift(1) < c.rolling(10).mean().shift(1)
    uptrend = c.shift(1) > c.rolling(10).mean().shift(1)
    hammer = (lower >= 2 * body) & (upper <= 0.3 * body.clip(lower=1e-9) + 0.1 * rng) & downtrend & (body > 0)
    out.append(_emit(g, hammer, "hammer", "candlestick", "bullish",
                     pd.Series(np.clip(lower / rng, 0, 1) * candle_w, index=g.index), ["low", "close"]))
    star = (upper >= 2 * body) & (lower <= 0.1 * rng) & uptrend & (body > 0)
    out.append(_emit(g, star, "shooting_star", "candlestick", "bearish",
                     pd.Series(np.clip(upper / rng, 0, 1) * candle_w, index=g.index), ["high", "close"]))
    po, pc = o.shift(1), c.shift(1)
    prev_body = (pc - po).abs()
    # With estimated opens every candle "opens" at the prior close, so demand a
    # clearly larger body and a meaningful prior candle to keep the signal rare.
    body_mult = np.where(est, 1.5, 1.0)
    big = (body > body_mult * prev_body) & (prev_body / c > 0.01)
    bull_eng = (pc < po) & (c > o) & (o <= pc) & (c >= po) & big
    bear_eng = (pc > po) & (c < o) & (o >= pc) & (c <= po) & big
    eng_strength = pd.Series(np.clip(body / (pc - po).abs().replace(0, np.nan) / 3, 0, 1) * candle_w,
                             index=g.index)
    out.append(_emit(g, bull_eng, "bullish_engulfing", "candlestick", "bullish", eng_strength, ["close"]))
    out.append(_emit(g, bear_eng, "bearish_engulfing", "candlestick", "bearish", eng_strength, ["close"]))

    # --- trend / momentum ---------------------------------------------------------
    s50, s200 = g["sma_50"], g["sma_200"]
    golden = (s50 > s200) & (s50.shift(1) <= s200.shift(1))
    death = (s50 < s200) & (s50.shift(1) >= s200.shift(1))
    out.append(_emit(g, golden, "golden_cross", "trend", "bullish", 0.8, ["sma_50", "sma_200"]))
    out.append(_emit(g, death, "death_cross", "trend", "bearish", 0.8, ["sma_50", "sma_200"]))
    m, ms = g["macd"], g["macd_signal"]
    out.append(_emit(g, (m > ms) & (m.shift(1) <= ms.shift(1)), "macd_bullish_cross", "momentum",
                     "bullish", 0.5, ["macd", "macd_signal"]))
    out.append(_emit(g, (m < ms) & (m.shift(1) >= ms.shift(1)), "macd_bearish_cross", "momentum",
                     "bearish", 0.5, ["macd", "macd_signal"]))
    rsi = g["rsi_14"]
    out.append(_emit(g, (rsi < 30) & (rsi.shift(1) >= 30), "rsi_oversold", "momentum", "bullish",
                     pd.Series((30 - rsi) / 30 + 0.4, index=g.index), ["rsi_14"]))
    out.append(_emit(g, (rsi > 70) & (rsi.shift(1) <= 70), "rsi_overbought", "momentum", "bearish",
                     pd.Series((rsi - 70) / 30 + 0.4, index=g.index), ["rsi_14"]))

    # --- volatility / volume ---------------------------------------------------------
    out.append(_emit(g, (c > g["bb_upper"]) & (c.shift(1) <= g["bb_upper"].shift(1)),
                     "bollinger_breakout_up", "volatility", "bullish", 0.6, ["close", "bb_upper"]))
    out.append(_emit(g, (c < g["bb_lower"]) & (c.shift(1) >= g["bb_lower"].shift(1)),
                     "bollinger_breakout_down", "volatility", "bearish", 0.6, ["close", "bb_lower"]))
    vol_avg = g["volume_try"].rolling(20).mean().shift(1)
    ratio = g["volume_try"] / vol_avg
    spike = ratio >= 3
    direction = np.where(c >= c.shift(1), "bullish", "bearish")
    for d in ("bullish", "bearish"):
        out.append(_emit(g.assign(volume_ratio=ratio), spike & (direction == d), "volume_spike",
                         "volume", d, pd.Series(np.clip(ratio / 10, 0, 1), index=g.index),
                         ["volume_ratio"]))

    frames = [f for f in out if not f.empty]
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=PATTERN_COLUMNS)


def detect_patterns(df: pd.DataFrame, only_from=None) -> pd.DataFrame:
    """Run all detectors. Pass extra history in ``df`` and restrict output with ``only_from``."""
    frames = [detect_symbol(g) for _, g in df.groupby("symbol")]
    frames = [f for f in frames if not f.empty]
    if not frames:
        return pd.DataFrame(columns=PATTERN_COLUMNS)
    out = pd.concat(frames, ignore_index=True)
    if only_from is not None:
        out = out[pd.to_datetime(out["trade_date"]).dt.date >= only_from]
    return out.sort_values(["trade_date", "symbol", "pattern"]).reset_index(drop=True)


# ---------------------------------------------------------------------------------
# Event study: how did the stock move (vs. BIST100) after each disclosure?
# ---------------------------------------------------------------------------------
MARKET_CLOSE = time(18, 0)


def event_day(published_at: pd.Timestamp, trading_days: np.ndarray) -> object | None:
    """First trading day on which the market could react to the disclosure."""
    d = published_at.date()
    if published_at.time() >= MARKET_CLOSE:
        idx = np.searchsorted(trading_days, d, side="right")
    else:
        idx = np.searchsorted(trading_days, d, side="left")
    return trading_days[idx] if idx < len(trading_days) else None


def event_returns(disclosures: pd.DataFrame, market: pd.DataFrame,
                  horizons=(1, 3, 5)) -> pd.DataFrame:
    """Cumulative abnormal returns (stock minus BIST100) from the close before the event day."""
    mk = market[["symbol", "trade_date", "close", "bist100"]].copy()
    mk["trade_date"] = pd.to_datetime(mk["trade_date"]).dt.date
    trading_days = np.array(sorted(mk["trade_date"].unique()))
    by_symbol = {s: g.set_index("trade_date").sort_index() for s, g in mk.groupby("symbol")}

    rows = []
    for r in disclosures.itertuples():
        g = by_symbol.get(r.symbol)
        ts = pd.Timestamp(r.published_at)
        eday = event_day(ts, trading_days)
        rec = {"disclosure_id": r.disclosure_id, "symbol": r.symbol, "event_date": eday}
        if g is None or eday is None or eday not in g.index:
            rows.append(rec)
            continue
        pos = g.index.get_loc(eday)
        if pos == 0:
            rows.append(rec)
            continue
        base = g.iloc[pos - 1]
        for hzn in horizons:
            end = pos + hzn - 1
            if end < len(g):
                stock = g.iloc[end]["close"] / base["close"] - 1
                index = g.iloc[end]["bist100"] / base["bist100"] - 1 if base["bist100"] else np.nan
                rec[f"ret_{hzn}d"] = stock
                rec[f"car_{hzn}d"] = stock - index if pd.notna(index) else np.nan
        if pos >= 6:
            rec["pre_car_5d"] = (base["close"] / g.iloc[pos - 6]["close"] - 1) - (
                base["bist100"] / g.iloc[pos - 6]["bist100"] - 1)
        rows.append(rec)
    return pd.DataFrame(rows)
