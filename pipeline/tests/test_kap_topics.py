import numpy as np
import pandas as pd

from finsent import kap_topics as kt


def _setup(n_sym=40, n=900, seed=5):
    """Random-walk stocks; 'Yeni İş İlişkisi' days get a +3% same-day jump, buyback days are
    followed by +0.2%/day for 20 days, other disclosures are noise."""
    rng = np.random.default_rng(seed)
    days = pd.bdate_range("2021-01-04", periods=n)
    idx = 1000 * np.exp(np.cumsum(rng.normal(0, 0.01, n)))
    market, events, dis, sent = [], [], [], []
    k = 0
    for s in range(n_sym):
        r = rng.normal(0, 0.02, n)
        kinds = {}
        for pos in rng.choice(np.arange(30, n - 30), 36, replace=False):
            # most disclosure days are noise, as in real data (the month baseline is mostly them)
            kinds[pos] = ("Yeni İş İlişkisi", "Payların Geri Alınmasına İlişkin Bildirim", "Genel Kurul İşlemlerine İlişkin Bildirim",
                          "Finansal Rapor", "Finansal Rapor", "Finansal Rapor")[k % 6]
            k += 1
        for pos, subj in kinds.items():
            if subj == "Yeni İş İlişkisi":
                r[pos] += 0.03
            elif subj.startswith("Payların"):
                r[pos + 1:pos + 21] += 0.002
        px = 10 * idx / idx[0] * np.exp(np.cumsum(r))
        sym = f"S{s:02d}"
        market.append(pd.DataFrame({"symbol": sym, "trade_date": days, "close": px, "bist100": idx}))
        for pos, subj in kinds.items():
            did = f"kap:{len(dis)}"
            dis.append({"disclosure_id": did, "subject": subj, "text": ""})
            sent.append({"disclosure_id": did, "label": "positive", "event_type": "other"})
            events.append({"disclosure_id": did, "symbol": sym, "event_date": days[pos]})
    return pd.concat(market), pd.DataFrame(dis), pd.DataFrame(sent), pd.DataFrame(events)


def test_study_separates_same_day_reaction_from_drift():
    res = kt.study(*_setup())
    rows = {r["topic"]: r for r in res["rows"] if r["label"] is None}
    new, buy, agm = rows["Yeni iş ilişkisi"], rows["Pay geri alımı"], rows["Genel kurul"]
    assert new["reaction"] > 0.015 and abs(new["drift20"]) < 0.02
    assert buy["drift20"] > 0.015 and abs(buy["reaction"]) < 0.01  # part of the +4% is absorbed by the month baseline
    assert abs(agm["reaction"]) < 0.01 and abs(agm["drift20"]) < 0.02
    assert new["verdict"] == "aynı gün fiyatlanıyor"
    assert buy["verdict"] == "sonrasında da sürüyor"
    assert agm["verdict"] == "belirgin etki yok"


def test_topic_of_splits_capital_increases_and_uses_event_type_for_oda():
    assert kt.topic_of("Sermaye Artırımı - Azaltımı İşlemlerine İlişkin Bildirim", "%100 BEDELSİZ", "") == "Bedelsiz sermaye artırımı"
    assert kt.topic_of("Sermaye Artırımı - Azaltımı İşlemlerine İlişkin Bildirim", "bedelli artırım", "") == "Bedelli sermaye artırımı"
    assert kt.topic_of("Özel Durum Açıklaması (Genel)", "", "legal") == "ÖDA: hukuki"
    assert kt.topic_of("Özel Durum Açıklaması (Genel)", "", "other") is None
    assert kt.topic_of(None, None, None) is None


def test_prefer_llm_keeps_one_row_per_disclosure():
    s = pd.DataFrame({"disclosure_id": ["a", "a", "b"], "provider": ["lexicon", "xai", "lexicon"],
                      "label": ["neutral", "negative", "positive"], "event_type": ["x", "legal", "y"]})
    out = kt._prefer_llm(s).set_index("disclosure_id")
    assert out.loc["a", "label"] == "negative" and out.loc["b", "label"] == "positive" and len(out) == 2
