"""End-to-end lake steps against an in-memory S3 (moto)."""
from dataclasses import replace
from datetime import date
from unittest import mock

import pytest
from moto import mock_aws

from finsent import jobs
from finsent.config import Settings
from finsent.storage import Lake

from .conftest import make_market


@pytest.fixture
def settings(monkeypatch):
    monkeypatch.delenv("AWS_ENDPOINT_URL", raising=False)
    return Settings()


@mock_aws
def test_ingest_score_detect_roundtrip(settings):
    mk = make_market(symbols=tuple(f"S{i:02d}" for i in range(5)), start="2024-10-01", days=150)
    start, end = date(2025, 1, 6), date(2025, 2, 28)
    settings = replace(settings, dq_min_symbols_per_day=3)
    with mock.patch("finsent.market.extract_market",
                    side_effect=lambda s, a, b, symbols=None: mk[(mk.trade_date >= a) & (mk.trade_date <= b)]), \
         mock.patch("finsent.quality.BIST_HOLIDAYS", set()):
        m = jobs.ingest_market(settings, start, end, "r1")
        k = jobs.ingest_disclosures(settings, start, end, "r1")
        k2 = jobs.ingest_disclosures(settings, start, end, "r2")   # rerun: all deduped
        sres = jobs.score_sentiment(settings, start, end, "r1")
        p = jobs.detect_patterns(settings, start, end, "r1")

    assert m["dq_status"] in ("pass", "warn") and m["partitions"] > 30
    assert k["new"] > 0 and k2["new"] == 0
    assert sres["scored"] == k["new"] and sres["provider"] == "lexicon"
    assert p["patterns"] > 0
    lake = Lake(settings)
    assert lake.get_json("state/kap_dedup_index.json")["ids"]
    assert lake.list_keys("quality/market/")
    # every sentiment partition must carry the same schema, even days with no key points
    import io
    import pyarrow.parquet as pq
    for key in lake.list_keys("curated/sentiment/"):
        schema = pq.read_schema(io.BytesIO(lake.get_bytes(key)))
        assert str(schema.field("key_points").type) == "list<element: string>", key
    for key in lake.list_keys("raw/market/")[:3]:
        assert pq.read_schema(io.BytesIO(lake.get_bytes(key))).equals(jobs.MARKET_SCHEMA), key


@mock_aws
def test_market_schema_pinned_when_column_all_null(settings):
    mk = make_market(symbols=tuple(f"S{i}" for i in range(3)), start="2025-01-06", days=30)
    mk["market_cap_try"] = None  # e.g. Yahoo has no market cap
    settings = replace(settings, dq_min_symbols_per_day=1)
    with mock.patch("finsent.market.extract_market", return_value=mk), \
         mock.patch("finsent.quality.BIST_HOLIDAYS", set()):
        jobs.ingest_market(settings, date(2025, 1, 6), date(2025, 2, 14), "nulls")
    import io
    import pyarrow.parquet as pq
    lake = Lake(settings)
    key = lake.list_keys("raw/market/")[0]
    assert str(pq.read_schema(io.BytesIO(lake.get_bytes(key))).field("market_cap_try").type) == "double"


@mock_aws
def test_market_dq_failure_blocks_write(settings):
    mk = make_market(symbols=("A", "B"), start="2025-01-06", days=40)
    mk = mk[~((mk.symbol == "A") & (mk.index % 3 == 0))]
    start, end = date(2025, 1, 6), date(2025, 2, 28)
    settings = replace(settings, dq_min_symbols_per_day=1)
    with mock.patch("finsent.market.extract_market", return_value=mk), \
         mock.patch("finsent.quality.BIST_HOLIDAYS", set()):
        with pytest.raises(jobs.DataQualityError):
            jobs.ingest_market(settings, start, end, "bad")
    assert not Lake(settings).list_keys("raw/market/")


@mock_aws
def test_rebuild_lake_from_serving_db(settings):
    """rebuild-lake rewrites raw KAP, curated sentiment and the dedup index from MySQL rows."""
    import pandas as pd

    from finsent import kap, lake_rebuild

    disc = pd.DataFrame([{c: None for c in kap.DISCLOSURE_COLUMNS} | {
        "disclosure_id": f"d{i}", "disclosure_index": i, "symbol": "THYAO", "subject": "Özel Durum Açıklaması",
        "published_at": pd.Timestamp(2025, 1, 6 + i, 10), "source": "kap", "content_hash": f"h{i}"} for i in range(3)])
    sent = pd.DataFrame([{"disclosure_id": f"d{i}", "label": "positive", "score": 0.5, "confidence": 0.9,
                          "event_type": "other", "key_points": '["a"]' if i else None, "rationale": "r",
                          "provider": "xai", "model": "grok", "published_date": date(2025, 1, 6 + i)} for i in range(3)])

    def fake_query(_s, sql, _args):
        if "FROM disclosure_sentiment" in sql:
            return sent
        if sql.startswith("SELECT disclosure_id, content_hash"):
            return disc[["disclosure_id", "content_hash"]]
        return disc

    with mock.patch.object(lake_rebuild, "_query", side_effect=fake_query):
        out = lake_rebuild.rebuild(settings, date(2025, 1, 1), date(2025, 1, 31), parts=("kap", "index"))
    assert out == {"disclosures": 3, "sentiment_rows": 3, "dedup_index_ids": 3}
    lake = Lake(settings)
    assert len(jobs._read_raw_disclosures(lake, date(2025, 1, 6), date(2025, 1, 8))) == 3
    assert lake.get_json("state/kap_dedup_index.json")["hashes"]["h2"] == "d2"
    assert len(lake.list_keys("curated/sentiment/")) == 3
