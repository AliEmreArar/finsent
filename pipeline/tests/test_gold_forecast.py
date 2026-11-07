import numpy as np
import pandas as pd

from finsent import gold_forecast as gf


def _raw(n=3000, seed=1):
    rng = np.random.default_rng(seed)
    idx = pd.bdate_range("2004-01-01", periods=n)
    walk = lambda mu, s: 100 * np.exp(np.cumsum(rng.normal(mu, s, n)))  # noqa: E731
    return pd.DataFrame({"GOLD": walk(3e-4, 0.01), "GOLD_H": np.nan, "GOLD_L": np.nan, "SILVER": walk(2e-4, 0.015),
                         "DXY": walk(0, 0.004), "US10Y": 3 + np.cumsum(rng.normal(0, 0.03, n)), "VIX": 15 + rng.gamma(2, 3, n),
                         "OIL": walk(0, 0.02), "SPX": walk(3e-4, 0.01), "COPPER": walk(0, 0.015), "USDTRY": walk(1e-3, 0.006)}, index=idx)


def test_range_bands_are_calibrated_on_a_random_walk():
    df, _ = gf.features(_raw(), "ALTIN")
    res = gf.range_walk_forward(df, first_test_year=2008)
    for h in gf.HORIZONS:
        assert 0.83 <= res[h]["coverage_90"] <= 0.96
        assert 0.58 <= res[h]["coverage_68"] <= 0.78


def test_trend_rules_report_buy_and_hold_and_rules():
    df, _ = gf.features(_raw(), "XAUUSD")
    rules = gf.trend_rules(df, since="2006-01-01")
    assert rules["Al-tut"]["time_in_market"] == 1.0
    assert all(-1 <= r["maxdd"] <= 0 for r in rules.values())
