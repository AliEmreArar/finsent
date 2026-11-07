"""KAP live parsing, Grok client parsing (no network), and the auto market source."""
import json
import sqlite3
from dataclasses import replace
from datetime import date
from types import SimpleNamespace

import pandas as pd
import pytest

from finsent import kap, market
from finsent.config import Settings
from finsent.kap_live import KapLiveClient, extract_body_text, parse_kap_time
from finsent.sentiment.grok import GrokAnalyzer, GrokClient, usage_cost_usd

KAP_ITEMS = [
    {"publishDate": "20.11.2025 21:40:02", "kapTitle": "ÖRNEK A.Ş.", "disclosureClass": "ODA",
     "summary": "Birleşme hakkında", "subject": "Birleşme İşlemlerine İlişkin Bildirim",
     "disclosureIndex": 1518631, "stockCodes": "GATEG"},
    {"publishDate": "20.11.2025 10:00:00", "kapTitle": "İKİ HİSSE A.Ş.", "disclosureClass": "ODA",
     "summary": "Ortak açıklama", "subject": "Özel Durum Açıklaması (Genel)",
     "disclosureIndex": 1518600, "stockCodes": "AAAAA, BBBBB"},
    {"publishDate": "20.11.2025 11:00:00", "kapTitle": "FON", "disclosureClass": "ODA",
     "summary": "Fon", "subject": "Özel Durum Açıklaması (Genel)", "disclosureIndex": 1518601,
     "stockCodes": None},
    {"publishDate": "20.11.2025 12:00:00", "kapTitle": "X", "disclosureClass": "ODA", "summary": "dk",
     "subject": "Pay Bazında Devre Kesici Bildirimi", "disclosureIndex": 1518602, "stockCodes": "XXXXX"},
]


class FakeKapClient(KapLiveClient):
    def __init__(self, settings, items, page=""):
        super().__init__(settings, session=SimpleNamespace(headers={}))
        self.items, self.page, self.calls = items, page, []

    def list_day(self, day):
        self.calls.append(day)
        return self.items

    def _request(self, method, url, attempts=4, **kw):
        return SimpleNamespace(text=self.page)


def test_parse_kap_time():
    assert parse_kap_time("20.11.2025 21:40:02").hour == 21
    assert parse_kap_time("garbage") is None


def test_live_rows_filter_noise_and_explode_multi_stock(monkeypatch):
    s = replace(Settings(), kap_mode="live", kap_request_interval_s=0)
    client = FakeKapClient(s, KAP_ITEMS)
    raw = client.fetch_raw(date(2025, 11, 20), date(2025, 11, 20))
    assert sorted(raw["symbol"]) == ["AAAAA", "BBBBB", "GATEG"]  # fund (no code) + circuit breaker dropped
    monkeypatch.setattr("finsent.kap_live.KapLiveClient", lambda settings: client)
    df = kap.load_live(s, date(2025, 11, 20), date(2025, 11, 20))
    assert df["disclosure_id"].is_unique
    assert set(df["disclosure_id"]) == {"kap:1518631", "kap:1518600", "kap:1518600:BBBBB"}
    assert df["published_at"].dt.hour.tolist().count(21) == 1


def test_extract_body_text_from_escaped_page():
    page = ('...{"x":"\\u003cdiv\\u003eAçıklamalar\\u003c/div\\u003e\\u003ctd\\u003e\\u003cdiv\\u003e'
            'Explanations oda_ExplanationTextBlock| Şirketimiz 50 milyon USD tutarında sözleşme imzalamıştır.'
            '\\u003c/div\\u003e Yukarıdaki açıklamalarımızın ..."}')
    assert extract_body_text(page) == "Şirketimiz 50 milyon USD tutarında sözleşme imzalamıştır."


def test_extract_body_text_drops_trailing_component_payload():
    page = ('\\u003cdiv\\u003eAçıklamalar\\u003c/div\\u003e Eylül trafik sonuçları ektedir. '
            'Respectfully announced. 38:["$","$L41",null,{"x":1}]')
    assert extract_body_text(page) == "Eylül trafik sonuçları ektedir. Respectfully announced."


def test_enrich_bodies_respects_subjects_and_cap():
    s = replace(Settings(), kap_request_interval_s=0, kap_max_bodies=1)
    page = "\\u003cdiv\\u003eAçıklamalar\\u003c/div\\u003e Önemli bir gelişme yaşanmıştır ve kamuya açıklanmıştır."
    client = FakeKapClient(s, [], page)
    df = pd.DataFrame([
        {"disclosure_index": 1, "subject": "Özel Durum Açıklaması (Genel)", "body": ""},
        {"disclosure_index": 1, "subject": "Özel Durum Açıklaması (Genel)", "body": ""},  # same notice, 2nd stock
        {"disclosure_index": 2, "subject": "Genel Kurul İşlemlerine İlişkin Bildirim", "body": ""},
        {"disclosure_index": 3, "subject": "Yeni İş İlişkisi", "body": ""},  # over the cap
    ])
    out, cache = client.enrich_bodies(df)
    assert out["body"].tolist()[:2] == ["Önemli bir gelişme yaşanmıştır ve kamuya açıklanmıştır."] * 2
    assert out["body"].tolist()[2:] == ["", ""] and list(cache) == ["1"]


def test_enrich_bodies_stops_on_persistent_rate_limit():
    from finsent.kap_live import KapRateLimited

    s = replace(Settings(), kap_request_interval_s=0, kap_max_bodies=10)

    class Limited(FakeKapClient):
        calls = 0

        def _request(self, method, url, attempts=4, **kw):
            Limited.calls += 1
            raise KapRateLimited("429")

    df = pd.DataFrame([{"disclosure_index": i, "subject": "Özel Durum Açıklaması (Genel)", "body": ""}
                       for i in range(5)])
    out, cache = Limited(s, []).enrich_bodies(df)
    assert Limited.calls == 1 and not cache and (out["body"] == "").all()


class FakeGrok(GrokClient):
    def __init__(self, payload):
        self.payload, self.bodies = payload, []

    def post(self, path, body):
        self.bodies.append((path, body))
        return self.payload


def test_grok_analyzer_parses_chat_json():
    content = {"label": "negative", "score": -1.4, "confidence": 0.8, "event_type": "legal",
               "key_points": ["ceza"], "rationale": "x"}
    fake = FakeGrok({"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(content)}}]})
    r = GrokAnalyzer("grok-fast", client=fake).analyze("ceza", symbol="ABC")
    assert r.label == "negative" and r.score == -1.0 and r.provider == "xai"
    path, body = fake.bodies[0]
    assert path == "/chat/completions" and body["response_format"]["json_schema"]["strict"] is True


def test_grok_social_parses_responses_output_and_citations():
    answer = {"label": "positive", "score": 0.6, "bullish_share": 0.7, "bearish_share": 0.2,
              "post_volume": "medium", "summary": "olumlu", "themes": ["ihracat"],
              "notable_posts": [{"text": "al", "url": "https://x.com/i/status/1", "stance": "bullish"}]}
    fake = FakeGrok({"output": [
        {"type": "custom_tool_call"},
        {"type": "message", "content": [{"type": "output_text", "text": json.dumps(answer), "annotations": [
            {"type": "url_citation", "url": "https://x.com/i/status/1"},
            {"type": "url_citation", "url": "https://x.com/i/status/1"}]}]}],
        "usage": {"cost_in_usd_ticks": 1_350_000_000,
                  "server_side_tool_usage_details": {"x_posts_fetched": 27}}})
    r = GrokAnalyzer("f", "grok-4.7", client=fake).social_sentiment("ASELS", None, date(2026, 11, 4), date(2026, 11, 7))
    assert r["label"] == "positive" and r["posts_fetched"] == 27 and r["cost_usd"] == 0.135
    assert len(r["citations"]) == 1
    tool = fake.bodies[0][1]["tools"][0]
    assert tool == {"type": "x_search", "from_date": "2026-11-04", "to_date": "2026-11-07"}


def test_usage_cost():
    assert usage_cost_usd({}) is None and usage_cost_usd({"cost_in_usd_ticks": 1e10}) == 1.0


@pytest.fixture
def two_dbs(tmp_path):
    cols = ["symbol", "date", "close", "high", "low", "volume_try", "market_cap_try", "BIST", "usd_kur_price",
            "pct_change", "RSI_14", "MACD_12_26_9", "MACDs_12_26_9", "MACDh_12_26_9", "SMA_50", "SMA_200",
            "BBL_20_2.0_2.0", "BBM_20_2.0_2.0", "BBU_20_2.0_2.0"]
    hist, upd = tmp_path / "hist.db", tmp_path / "upd.db"
    for path, days, extra in ((hist, ["2025-11-20", "2025-11-21"], []), (upd, ["2025-11-24", "2025-11-25"], ["open"])):
        with sqlite3.connect(path) as c:
            allc = cols + extra
            c.execute(f"CREATE TABLE model_data ({', '.join(chr(34) + x + chr(34) for x in allc)})")
            for i, d in enumerate(days):
                row = {x: 1.0 for x in allc} | {"symbol": "AAA", "date": d, "close": 10.0 + i}
                c.execute(f"INSERT INTO model_data VALUES ({','.join('?' * len(allc))})", [row[x] for x in allc])
    return replace(Settings(), market_source="auto", market_sqlite_path=str(hist), market_updates_path=str(upd))


def test_auto_source_stitches_history_and_updates(two_dbs):
    df = market.extract_market(two_dbs, date(2025, 11, 20), date(2025, 11, 25))
    assert [str(d) for d in df["trade_date"]] == ["2025-11-20", "2025-11-21", "2025-11-24", "2025-11-25"]
    assert df["source"].tolist() == ["sqlite", "sqlite", "yahoo", "yahoo"]
    assert df["open_is_estimated"].tolist() == [True, True, False, False]
