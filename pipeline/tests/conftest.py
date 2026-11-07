import os
from datetime import date

import numpy as np
import pandas as pd
import pytest

os.environ.setdefault("AWS_ACCESS_KEY_ID", "test")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "test")
os.environ.setdefault("AWS_DEFAULT_REGION", "eu-central-1")
os.environ["FINSENT_LLM_PROVIDER"] = "lexicon"


def make_market(symbols=("AAA", "BBB"), start="2025-01-02", days=80, seed=0) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    dates = pd.bdate_range(start, periods=days).date
    idx = 10000 * np.cumprod(1 + rng.normal(0, 0.01, days))
    rows = []
    for s in symbols:
        close = 100 * np.cumprod(1 + rng.normal(0, 0.02, days))
        for i, d in enumerate(dates):
            hi = close[i] * (1 + abs(rng.normal(0, 0.01)))
            lo = close[i] * (1 - abs(rng.normal(0, 0.01)))
            rows.append({"symbol": s, "trade_date": d, "high": hi, "low": lo, "close": close[i],
                         "volume_try": float(rng.integers(1e6, 5e6)), "market_cap_try": 1e9,
                         "bist100": idx[i], "usd_try": 35.0})
    df = pd.DataFrame(rows)
    from finsent.market import compute_indicators
    df = compute_indicators(df)
    df = df.sort_values(["symbol", "trade_date"])
    df["open"] = df.groupby("symbol")["close"].shift(1)
    df["open_is_estimated"] = True
    df["source"] = "test"
    return df.reset_index(drop=True)


@pytest.fixture
def market_df():
    return make_market()


@pytest.fixture
def window():
    return date(2025, 1, 2), date(2025, 4, 23)
