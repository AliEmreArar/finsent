"""KAP event-type study: which disclosure topics move prices, and does anything drift afterwards?

Topics come from the KAP subject line ("Yeni İş İlişkisi", "İhale Süreci / Sonucu", ...); capital
increases are split into bonus (bedelsiz) and rights (bedelli) issues from the text; generic
"Özel Durum Açıklaması" items use Grok's event_type. For each (symbol, event day, topic):

  reaction  abnormal return (vs BIST 100) on the event day (close t-1 -> close t)
  drift5/20 abnormal return from the event-day close to +5 / +20 trading days, i.e. what a reader
            acting after the news was public could still have earned

Each window is demeaned by the month's average daily abnormal return over all stock-days times the
window length (equal-weighted market vs index; removes market-wide clustering); t-statistics use monthly means. Corporate-action days (|r| > 25%) are dropped.

    finsent kap-topics                       # MySQL -> research_results 'kap_topics'
    python scripts/kap_event_type_study.py DIR   # same study on release Parquet files
"""
from __future__ import annotations

import json
import logging

import numpy as np
import pandas as pd

log = logging.getLogger(__name__)

RKEY = "kap_topics"
JUMP = 0.25
MIN_N = 40
TOPICS = {
    "Yeni İş İlişkisi": "Yeni iş ilişkisi", "İhale Süreci / Sonucu": "İhale", "Payların Geri Alınmasına İlişkin Bildirim": "Pay geri alımı",
    "Kar Payı Dağıtım İşlemlerine İlişkin Bildirim": "Kâr payı (temettü)", "Pay Alım Satım Bildirimi": "İçeriden alım-satım",
    "Olağan Dışı Fiyat ve Miktar Hareketleri": "Olağan dışı fiyat hareketi", "Ortaklık Aleyhine Dava Açılması veya Davaya İlişkin Gelişmeler": "Dava",
    "Birleşme İşlemlerine İlişkin Bildirim": "Birleşme", "Maddi Duran Varlık Alımı": "Maddi duran varlık alımı",
    "Finansal Duran Varlık Edinimi": "İştirak / şirket edinimi", "Kredi Derecelendirmesi": "Kredi derecelendirmesi",
    "Pay Alım Teklifi Yoluyla Pay Toplanmasına İlişkin Bildirim": "Pay alım teklifi", "Geleceğe Dönük Değerlendirmeler": "Gelecek beklentileri",
    "İlişkili Taraf İşlemleri": "İlişkili taraf işlemi", "Finansal Rapor": "Finansal rapor", "Genel Kurul İşlemlerine İlişkin Bildirim": "Genel kurul",
}
ODA_TYPES = {"m_and_a": "ÖDA: birleşme/satın alma", "legal": "ÖDA: hukuki", "investment": "ÖDA: yatırım", "operations": "ÖDA: faaliyet",
             "debt": "ÖDA: borçlanma", "governance": "ÖDA: yönetim", "dividend": "ÖDA: temettü", "regulatory": "ÖDA: düzenleyici"}


def tr_lower(s: str) -> str:
    """Turkish-aware lower case: str.lower() turns "İ" into "i̇" (i + combining dot), so "BEDELSİZ" would not match."""
    return s.replace("İ", "i").replace("I", "ı").lower()


def topic_of(subject: str, text: str, event_type: str) -> str | None:
    subject = subject or ""
    if subject in TOPICS:
        return TOPICS[subject]
    if subject.startswith("Sermaye Artırımı"):
        t = tr_lower(text or "")
        return "Bedelsiz sermaye artırımı" if "bedelsiz" in t else "Bedelli sermaye artırımı" if "bedelli" in t else "Sermaye artırımı (diğer)"
    if subject.startswith("Özel Durum Açıklaması"):
        return ODA_TYPES.get(event_type or "")
    return None


def _car_frame(market: pd.DataFrame) -> pd.DataFrame:
    m = market[["symbol", "trade_date", "close", "bist100"]].copy()
    m["trade_date"] = pd.to_datetime(m["trade_date"])
    m["close"] = pd.to_numeric(m["close"], errors="coerce")
    m = m.sort_values(["symbol", "trade_date"]).reset_index(drop=True)
    g = m.groupby("symbol", sort=False)
    r = m["close"] / g["close"].shift(1) - 1
    ir = pd.to_numeric(m["bist100"], errors="coerce").groupby(m["trade_date"]).median().sort_index().pct_change()
    ar = (r - m["trade_date"].map(ir)).where(r.abs() <= JUMP)
    m["pos"] = g.cumcount()
    m["ar"] = ar
    m["car"] = ar.fillna(0).groupby(m["symbol"], sort=False).cumsum()
    return m[["symbol", "trade_date", "pos", "car", "ar"]]


def _windows(frame: pd.DataFrame, cars: pd.DataFrame) -> pd.DataFrame:
    mm = cars[["symbol", "pos", "car"]]

    def at(k):
        return frame[["symbol"]].assign(pos=frame["pos"] + k).merge(mm, on=["symbol", "pos"], how="left")["car"].to_numpy()

    c0 = at(0)
    out = frame.copy()
    out["reaction"], out["drift5"], out["drift20"] = c0 - at(-1), at(5) - c0, at(20) - c0
    out["ym"] = out["event_date"].dt.to_period("M")
    return out


def _t(df: pd.DataFrame, col: str) -> float:
    mon = df.groupby("ym")[col].mean().dropna()
    return float(mon.mean() / mon.std() * np.sqrt(len(mon))) if len(mon) > 2 and mon.std() > 0 else 0.0


def verdict(r: dict) -> str:
    """Plain-language reading used by the UI and the agent."""
    react = abs(r["t_reaction"]) >= 3
    drift = abs(r["t_drift20"]) >= 2.5 and r["years_same_sign_20"] >= r["years"] - 1
    if drift:
        return "sonrasında da sürüyor" if r["drift20"] > 0 else "sonrasında geri veriyor" if react and r["reaction"] > 0 else "sonrasında düşüş sürüyor"
    if react:
        return "aynı gün fiyatlanıyor"
    return "belirgin etki yok"


def _summ(topic: str, label: str | None, df: pd.DataFrame) -> dict:
    yrs = df.groupby(df["event_date"].dt.year)["drift20"].mean().dropna()
    d20 = float(df["drift20"].mean())
    r = {"topic": topic, "label": label, "n": int(len(df)),
         "reaction": float(df["reaction"].mean()), "t_reaction": _t(df, "reaction"),
         "drift5": float(df["drift5"].mean()), "drift20": d20, "t_drift20": _t(df, "drift20"),
         "drift20_median": float(df["drift20"].median()),
         "years_same_sign_20": int((np.sign(yrs) == np.sign(d20)).sum()), "years": int(len(yrs))}
    r["verdict"] = verdict(r)
    return r


def study(market: pd.DataFrame, disclosures: pd.DataFrame, sentiment: pd.DataFrame, events: pd.DataFrame) -> dict:
    """``disclosures``: disclosure_id, subject, text (summary/body, only needed for capital increases);
    ``sentiment``: disclosure_id, label, event_type (one row per disclosure); ``events``:
    disclosure_id, symbol, event_date."""
    cars = _car_frame(market)
    x = events[["disclosure_id", "symbol", "event_date"]].merge(disclosures, on="disclosure_id").merge(sentiment, on="disclosure_id", how="left")
    x["event_date"] = pd.to_datetime(x["event_date"])
    x = x.dropna(subset=["event_date"])
    x["topic"] = [topic_of(a, b, c) for a, b, c in zip(x["subject"], x.get("text", pd.Series("", index=x.index)).fillna(""),
                                                       x["event_type"].fillna(""))]
    x = x.merge(cars[["symbol", "trade_date", "pos"]].rename(columns={"trade_date": "event_date"}), on=["symbol", "event_date"])

    # baseline: the month's average abnormal return over all stock-days (equal-weighted market vs
    # the index), scaled to the window length; independent of the events being measured
    daily = cars["ar"].groupby(cars["trade_date"].dt.to_period("M")).mean()
    t = x.dropna(subset=["topic"]).drop_duplicates(["symbol", "event_date", "topic"])
    t = _windows(t[["symbol", "event_date", "pos", "topic", "label"]], cars)
    base = t["ym"].map(daily).fillna(0)
    for k, days in (("reaction", 1), ("drift5", 5), ("drift20", 20)):
        t[k] = t[k] - days * base

    rows = []
    for topic, df in t.groupby("topic"):
        if len(df) < MIN_N:
            continue
        rows.append(_summ(topic, None, df))
        for label, dl in df.groupby("label"):
            if len(dl) >= MIN_N:
                rows.append(_summ(topic, label, dl))
    rows.sort(key=lambda r: (r["topic"], r["label"] or ""))
    return {"version": 1, "period": [str(t["event_date"].min().date()), str(t["event_date"].max().date())] if len(t) else None,
            "n_events": int(len(t)), "rows": rows,
            "method": "BIST 100'e göre anormal getiri; o ayın tüm hisse-günlerindeki ortalama anormal getiriye göre arındırılmış; t değeri aylık ortalamalarla. "
                      "Tepki = olay günü, kayma = olay günü kapanışından sonraki 5/20 işlem günü."}


def load_parquet(d: str) -> tuple[pd.DataFrame, ...]:
    m = pd.read_parquet(f"{d}/tables__market_daily.parquet", columns=["symbol", "trade_date", "close", "bist100", "source"])
    m = m[m["source"].astype(str) != "instrument"]
    dis = pd.read_parquet(f"{d}/tables__disclosures.parquet", columns=["disclosure_id", "subject", "summary", "body"])
    cap = dis["subject"].fillna("").str.startswith("Sermaye Artırımı")
    dis["text"] = ""
    dis.loc[cap, "text"] = dis.loc[cap, "summary"].fillna("") + " " + dis.loc[cap, "body"].fillna("").str[:3000]
    dis = dis.drop(columns=["summary", "body"])
    s = pd.read_parquet(f"{d}/tables__disclosure_sentiment.parquet", columns=["disclosure_id", "provider", "label", "event_type"])
    s = _prefer_llm(s)
    e = pd.read_parquet(f"{d}/tables__event_returns.parquet", columns=["disclosure_id", "symbol", "event_date"])
    return m, dis, s, e


def _prefer_llm(s: pd.DataFrame) -> pd.DataFrame:
    """One sentiment row per disclosure, preferring an LLM provider over the lexicon (like v_sentiment)."""
    s = s.assign(_lex=(s["provider"] == "lexicon").astype(int)).sort_values(["disclosure_id", "_lex"])
    return s.drop_duplicates("disclosure_id")[["disclosure_id", "label", "event_type"]]


def load_mysql(settings) -> tuple[pd.DataFrame, ...]:
    from . import mysql_sink

    with mysql_sink.connect(settings) as conn:
        m = pd.read_sql_query("SELECT symbol, trade_date, close, bist100 FROM market_daily WHERE source <> 'instrument'", conn)
        dis = pd.read_sql_query(
            "SELECT disclosure_id, subject, CASE WHEN subject LIKE 'Sermaye Artırımı%' "
            "THEN CONCAT(COALESCE(summary, ''), ' ', LEFT(COALESCE(body, ''), 3000)) ELSE '' END AS text FROM disclosures", conn)
        s = _prefer_llm(pd.read_sql_query("SELECT disclosure_id, provider, label, event_type FROM disclosure_sentiment", conn))
        e = pd.read_sql_query("SELECT disclosure_id, symbol, event_date FROM event_returns WHERE event_date IS NOT NULL", conn)
    return m, dis, s, e


def run(settings) -> dict:
    """Recompute from the serving DB and store under research_results 'kap_topics'."""
    from . import mysql_sink

    res = study(*load_mysql(settings))
    with mysql_sink.connect(settings) as conn, conn.cursor() as cur:
        cur.execute("REPLACE INTO research_results (rkey, payload) VALUES (%s, %s)", (RKEY, json.dumps(res, ensure_ascii=False)))
    log.info("kap topics: %d rows over %d events", len(res["rows"]), res["n_events"])
    return {"rows": len(res["rows"]), "events": res["n_events"], "period": res["period"]}
