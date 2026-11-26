import numpy as np
import pandas as pd

from finsent import stock_range as sr


def _market(n_sym=30, n=2600, seed=3):
    """Random-walk stocks with persistent, stock-specific volatility (GARCH-like regimes)."""
    rng = np.random.default_rng(seed)
    days = pd.bdate_range("2008-01-01", periods=n)
    idx = 1000 * np.exp(np.cumsum(rng.normal(2e-4, 0.012, n)))
    rows = []
    for k in range(n_sym):
        base = rng.uniform(0.012, 0.035)
        regime = np.exp(np.convolve(rng.normal(0, 0.25, n), np.ones(60) / np.sqrt(60), mode="same"))
        r = rng.standard_t(5, n) / np.sqrt(5 / 3) * base * regime
        px = 20 * np.exp(np.cumsum(r))
        rows.append(pd.DataFrame({"symbol": f"S{k:02d}", "trade_date": days, "close": px, "bist100": idx, "source": "sqlite"}))
    return pd.concat(rows, ignore_index=True)


def test_bands_are_calibrated_out_of_sample():
    d = sr.range_frame(_market())
    res = sr.walk_forward(d, first_test_year=2012)
    for h in ("1", "5", "20"):
        assert 0.85 <= res[h]["coverage_90"] <= 0.95, res[h]
        assert 0.60 <= res[h]["coverage_68"] <= 0.76, res[h]
        assert res[h]["avg_width_90"] > res[h]["avg_width_68"] > 0


def test_corporate_action_jump_is_not_volatility_and_not_clean():
    m = _market(n_sym=2)
    s = m["symbol"] == "S00"
    cut = m.loc[s, "trade_date"].iloc[1500]
    m.loc[s & (m["trade_date"] >= cut), "close"] /= 2  # 2:1 bonus issue in unadjusted prices
    d = sr.range_frame(m).set_index(["symbol", "trade_date"])
    after = d.loc[("S00", cut)]
    assert after["ret_1"] < -0.45
    assert after["v20"] < 1.0  # the -50% day is excluded from the rolling vol
    assert not after["clean"]
    before = d.loc["S00"].loc[:cut].iloc[-5]
    assert not before["clean"]  # its forward window crosses the jump


def test_compute_returns_ordered_bands_for_latest_symbols():
    m = _market(n_sym=12, n=1800)
    inst = m[m["symbol"] == "S00"].assign(symbol="XAUUSD", source="instrument")
    d = sr.stock_rows(pd.concat([m, inst], ignore_index=True))
    out = sr.compute(d, {"20": {"coverage_90": 0.9, "coverage_68": 0.66}})
    assert "XAUUSD" not in out and len(out) == 12
    p = out["S03"]
    assert p["version"] == sr.VERSION and 0 <= p["vol_pctile_5y"] <= 1
    widths = []
    for h in p["horizons"]:
        assert h["p05"] < h["p16"] < h["p50"] < h["p84"] < h["p95"]
        assert h["p05"] < p["close"] < h["p95"]
        widths.append(h["p95"] - h["p05"])
    assert widths == sorted(widths)  # longer horizon, wider band
    assert p["horizons"][2]["coverage_90"] == 0.9 and p["horizons"][0]["coverage_90"] is None


def test_fit_uses_only_data_before_end():
    d = sr.range_frame(_market(n_sym=6, n=2000))
    end = pd.Timestamp("2012-01-01")
    a = sr.fit(d, end)
    future = d.copy()
    later = future["trade_date"] >= end
    future.loc[later, ["v5", "v20", "v60", "fut", "fwd_1", "fwd_5", "fwd_20"]] *= 5  # tamper with the future
    b = sr.fit(future, end)
    np.testing.assert_allclose(a["reg"].coef_, b["reg"].coef_)
    for h in sr.HORIZONS:
        np.testing.assert_allclose(a["q"][h], b["q"][h])


def test_forecast_stock_ranges_caches_study_and_never_raises(tmp_path, monkeypatch):
    from finsent import forecast

    monkeypatch.setattr(forecast, "model_path", lambda settings: tmp_path / "forecast_v2.joblib")
    raw = _market(n_sym=5, n=1800)
    out = forecast.stock_ranges(raw, settings=None, refresh_study=False)
    assert len(out) == 5 and (tmp_path / "stock_range_study.json").exists()
    assert out["S01"]["horizons"][0]["coverage_90"] is not None
    calls = []
    monkeypatch.setattr(sr, "walk_forward", lambda d: calls.append(1) or {})
    forecast.stock_ranges(raw, settings=None, refresh_study=False)
    assert calls == []  # cached study reused on predict-only days
    assert forecast.stock_ranges(raw.iloc[:50], settings=None, refresh_study=False) == {}
