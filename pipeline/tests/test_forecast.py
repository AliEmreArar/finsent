import numpy as np
import pandas as pd

from finsent import forecast

from .conftest import make_market


def feats(symbols=("AAA", "BBB", "CCC", "DDD"), days=700, start="2020-01-01"):
    return forecast.build_features(make_market(symbols=symbols, start=start, days=days, seed=3))


def test_features_forward_and_excess_returns_align():
    f = feats()
    a = f[f.symbol == "AAA"].reset_index(drop=True)
    i = 300
    assert np.isclose(a.loc[i, "fwd_5"], a.loc[i + 5, "close"] / a.loc[i, "close"] - 1)
    assert np.isclose(a.loc[i, "ret_20"], a.loc[i, "close"] / a.loc[i - 20, "close"] - 1)
    idx = a["bist100"]
    assert np.isclose(a.loc[i, "xs_5"], a.loc[i, "fwd_5"] - (idx[i + 5] / idx[i] - 1))
    assert set(forecast.FEATURES) <= set(f.columns)
    # cross-sectional ranks are percentiles within each day
    assert f["cs_ret_20"].dropna().between(0, 1).all()


def test_corporate_action_guard_masks_window_around_jump():
    mk = make_market(symbols=("AAA",), start="2020-01-01", days=300, seed=1)
    mk.loc[150:, ["close", "high", "low"]] *= 0.5  # a 2:1 split in unadjusted data
    f = forecast.build_features(mk)
    assert not f.loc[150, "clean"] and not f.loc[140, "clean"] and not f.loc[200, "clean"]
    assert f.loc[100, "clean"] and f.loc[260, "clean"]


def test_analogs_are_separated_and_have_paths():
    f = feats(symbols=("AAA",), days=900)
    an = forecast.find_analogs(f, k=10, gap=10)
    assert an is not None and len(an) == 10
    idx = sorted(an.index)
    assert all(b - a >= 10 for a, b in zip(idx, idx[1:]))
    assert all(len(p) == forecast.PATH_DAYS + 1 and p[0] == 0 for p in an["path"])


def test_train_calibrate_and_forecast(monkeypatch):
    monkeypatch.setattr(forecast, "TRAIN_START", "2015-01-01")
    monkeypatch.setattr(forecast, "PARAMS", dict(max_iter=20, max_leaf_nodes=7, min_samples_leaf=20, random_state=0))
    f = feats(days=1100, start="2019-01-01")
    trained = forecast.train_models(f, mlflow_log=False)
    for tgt in forecast.TARGETS:
        assert set(trained["models"][tgt]) == set(forecast.HORIZONS)
        for m in trained["metrics"][tgt].values():
            assert 0 <= m["auc"] <= 1 and m["n_test"] > 0
    latest = f[f["trade_date"] == f["trade_date"].max()]
    probs = forecast.forecast_frame(latest, trained["models"]).set_index("symbol")
    assert probs.filter(like="p_").stack().between(0, 1).all()
    assert probs["rank_5"].between(0, 1).all()
    out = forecast.forecast_symbol(f[f.symbol == "AAA"], probs.loc["AAA"], trained["metrics"])
    assert [h["days"] for h in out["horizons"]] == list(forecast.HORIZONS)
    h = out["horizons"][1]
    assert {"p_up", "p_beat", "rank_pct", "model_auc"} <= set(h)
    assert out["explanation"] and out["version"] == "v2"
    assert isinstance(pd.Timestamp(out["as_of"]), pd.Timestamp)
