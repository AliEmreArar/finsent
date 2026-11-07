import json
from types import SimpleNamespace

from finsent.config import get_settings
from finsent.sentiment import LexiconAnalyzer
from finsent.sentiment.llm import ClaudeAnalyzer


def lex():
    return LexiconAnalyzer(get_settings().lexicon_path)


def test_lexicon_basic_polarity():
    a = lex()
    assert a.analyze("Şirketimiz 120 milyon USD tutarındaki ihaleyi kazanmıştır.").label == "positive"
    assert a.analyze("Şirketimiz dönemi 320 milyon TL net zarar ile kapatmıştır.").label == "negative"
    assert a.analyze("Olağan genel kurul toplantısı 28 Mart'ta yapılacaktır.").label == "neutral"


def test_lexicon_turkish_casing_and_event_type():
    r = lex().analyze("İDARİ PARA CEZASI uygulanmıştır")
    assert r.label == "negative"
    assert r.event_type == "legal"


def test_lexicon_contrast_clause_weighs_main_clause():
    r = lex().analyze("Satışlar artmasına rağmen yüksek finansman giderleri nedeniyle net zarar açıklanmıştır.")
    assert r.label == "negative"


def test_lexicon_beats_chance_on_labeled_set():
    s = get_settings()
    rows = [json.loads(l) for l in s.labeled_eval_path.read_text(encoding="utf-8").splitlines() if l.strip()]
    a = lex()
    acc = sum(a.analyze(r["text"]).label == r["label"] for r in rows) / len(rows)
    assert acc > 0.6, acc


class FakeMessages:
    def __init__(self, payload, stop_reason="end_turn"):
        self.payload, self.stop_reason, self.calls = payload, stop_reason, []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(
            stop_reason=self.stop_reason, _request_id="req_test",
            content=[SimpleNamespace(type="text", text=json.dumps(self.payload))],
        )


def fake_client(payload, stop_reason="end_turn"):
    msgs = FakeMessages(payload, stop_reason)
    return SimpleNamespace(beta=SimpleNamespace(messages=msgs)), msgs


def test_claude_analyzer_parses_structured_output():
    client, msgs = fake_client({"label": "positive", "score": 1.7, "confidence": 0.9,
                                "event_type": "new_business", "key_points": ["ihale"], "rationale": "won"})
    a = ClaudeAnalyzer("claude-opus-5", client=client, fallback=lex())
    r = a.analyze("x", symbol="ASELS")
    assert r.label == "positive" and r.score == 1.0 and r.provider == "anthropic"
    call = msgs.calls[0]
    assert call["fallbacks"] == "default"
    assert call["output_config"]["format"]["type"] == "json_schema"


def test_claude_analyzer_falls_back_on_refusal():
    client, _ = fake_client({}, stop_reason="refusal")
    a = ClaudeAnalyzer("claude-opus-5", client=client, fallback=lex())
    r = a.analyze("Şirketimiz konkordato talebiyle mahkemeye başvurmuştur.")
    assert r.provider == "lexicon" and r.label == "negative"
