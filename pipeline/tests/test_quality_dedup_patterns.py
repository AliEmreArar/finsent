from datetime import date

import pandas as pd

from finsent import kap, patterns, quality
from finsent.config import get_settings
from finsent.dedup import dedup_disclosures, dedup_market


def test_market_quality_passes_on_complete_data(market_df, window):
    rep = quality.check_market(market_df, *window, max_missing_ratio=0.05, min_symbols_per_day=2)
    names = {c.name: c for c in rep.checks}
    # synthetic bdate_range ignores BIST holidays, so only symbol gaps matter here
    assert names["missing_symbol_observations"].passed
    assert names["duplicate_keys"].passed


def test_market_quality_detects_missing_observations(market_df, window):
    holed = market_df[~((market_df["symbol"] == "AAA") &
                        (market_df.index % 5 == 0))]  # drop ~20% of AAA's rows
    rep = quality.check_market(holed, *window, max_missing_ratio=0.05, min_symbols_per_day=1)
    chk = next(c for c in rep.checks if c.name == "missing_symbol_observations")
    assert not chk.passed and chk.detail["missing"] > 0
    assert rep.status == "fail"


def test_dedup_market_keeps_last(market_df):
    doubled = pd.concat([market_df, market_df.head(10)])
    out, stats = dedup_market(doubled)
    assert len(out) == len(market_df) and stats.in_batch_duplicates == 10


def test_kap_sample_dedup_and_index_roundtrip():
    s = get_settings()
    df = kap.load_sample(s, date(2025, 1, 1), date(2025, 3, 31))
    new, index, stats = dedup_disclosures(df, None)
    assert stats.in_batch_duplicates > 0           # generator injects duplicates
    assert new["content_hash"].is_unique and new["disclosure_id"].is_unique
    again, _, stats2 = dedup_disclosures(df, index)  # second run sees nothing new
    assert len(again) == 0 and stats2.already_seen == len(new)


def test_content_hash_separates_days_but_not_formatting():
    same_day = kap.content_hash("ABC", "Geri alım", "Pay geri alımı", "", "2026-10-05")
    assert same_day == kap.content_hash("abc ", "geri  alım", "pay geri alımı", "", "2026-10-05")
    assert same_day != kap.content_hash("ABC", "Geri alım", "Pay geri alımı", "", "2026-10-06")


def test_content_hash_ignores_whitespace_and_case():
    assert kap.content_hash("ABC", "Konu", "Özet", "Metin  burada") == \
        kap.content_hash("abc ", "konu", "özet", "metin burada")


def test_patterns_detect_crosses_and_flags(market_df):
    out = patterns.detect_patterns(market_df)
    assert set(out.columns) == set(patterns.PATTERN_COLUMNS)
    assert out["strength"].between(0, 1).all()
    assert {"macd_bullish_cross", "macd_bearish_cross"} & set(out["pattern"])


def test_event_returns_after_close_moves_to_next_day(market_df):
    d = market_df["trade_date"].iloc[30]
    disc = pd.DataFrame([{"disclosure_id": "t:1", "symbol": "AAA",
                          "published_at": pd.Timestamp(f"{d} 19:30")}])
    ev = patterns.event_returns(disc, market_df)
    days = sorted(market_df["trade_date"].unique())
    assert ev.loc[0, "event_date"] == days[days.index(d) + 1]
    assert pd.notna(ev.loc[0, "car_1d"])
