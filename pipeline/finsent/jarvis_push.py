"""Push a compact FinSent snapshot to the Jarvis voice assistant (Cloudflare Worker).

Jarvis runs in the cloud and answers finance questions from the phone even when this PC is off,
so after each daily run we upload a small JSON summary of the serving DB:
market + instruments, breadth/movers, AI market brief, gold ranges, important KAP disclosures,
and per-stock price/technicals/forecast/X-sentiment. Configure JARVIS_URL and JARVIS_TOKEN in .env;
without them the push is skipped.
"""
from __future__ import annotations

import json
import logging
import os
from datetime import date, datetime, timedelta

import requests

from .config import Settings
from .mysql_sink import connect

log = logging.getLogger(__name__)

INSTRUMENTS = ["XU100", "USDTRY", "EURTRY", "ALTIN", "XAUUSD", "GUMUS", "XAGUSD"]
CHUNK = 100  # stocks per upload request (keeps each Worker request small)


def _r(v, n=4):
    return None if v is None else round(float(v), n)


def _j(v):
    if v is None:
        return None
    return v if isinstance(v, (dict, list)) else json.loads(v)


def _rows(cur, sql, args=()):
    cur.execute(sql, args)
    cols = [c[0] for c in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def _compact_forecast(p: dict) -> dict:
    return {
        "as_of": p.get("as_of"),
        "explanation": p.get("explanation"),
        "horizons": [
            {
                "days": h.get("days"),
                "p_up": _r(h.get("p_up"), 3),
                "p_beat_bist100": _r(h.get("p_beat"), 3),
                "rank_pct": _r(h.get("rank_pct"), 3),
                "model_auc": _r(h.get("model_auc"), 3),
            }
            for h in p.get("horizons") or []
        ],
        "note": "Model isabeti sınırlı (AUC ~0.52-0.55); olasılık olarak anlat, yön iddiası yapma.",
    }


def _compact_gold(p: dict) -> dict:
    return {
        "name": p.get("name"),
        "as_of": p.get("as_of"),
        "close": _r(p.get("close"), 2),
        "currency": p.get("currency"),
        "ranges": [
            {k: (_r(h.get(k), 2) if k.startswith("p") else h.get(k)) for k in ("days", "p05", "p16", "p50", "p84", "p95")}
            for h in p.get("horizons") or []
        ],
        "volatility_ann": _r((p.get("vol") or {}).get("forecast_ann"), 3),
        "trend": {k: _r(v, 3) for k, v in (p.get("trend") or {}).items()},
        "note": "Altının yönü tahmin edilemez (AUC ~0.50). Sadece aralıkları anlat.",
    }


def build_snapshot(settings: Settings) -> dict:
    with connect(settings) as conn, conn.cursor() as cur:
        d = _rows(cur, "SELECT MAX(trade_date) AS d FROM market_daily WHERE source <> 'instrument'")[0]["d"]
        prev = _rows(cur, "SELECT MAX(trade_date) AS d FROM market_daily WHERE source <> 'instrument' AND trade_date < %s", (d,))[0]["d"]

        # instruments: latest two closes each
        inst = {}
        for r in _rows(cur, f"""
            SELECT symbol, trade_date, close FROM market_daily
            WHERE source = 'instrument' AND symbol IN ({",".join(["%s"] * len(INSTRUMENTS))})
              AND trade_date >= %s ORDER BY symbol, trade_date DESC""", (*INSTRUMENTS, d - timedelta(days=10))):
            inst.setdefault(r["symbol"], []).append(r)
        instruments = {}
        for sym, rs in inst.items():
            last, before = rs[0], (rs[1] if len(rs) > 1 else None)
            chg = (float(last["close"]) / float(before["close"]) - 1) * 100 if before else None
            instruments[sym] = {"date": str(last["trade_date"]), "close": _r(last["close"], 4), "change_pct": _r(chg, 2)}

        stocks_rows = _rows(cur, """
            SELECT m.symbol, c.title, m.close, m.pct_change, m.rsi_14, m.sma_50, m.sma_200, m.volume_try
            FROM market_daily m LEFT JOIN companies c ON c.symbol = m.symbol
            WHERE m.trade_date = %s AND m.source <> 'instrument'""", (d,))
        up = sum(1 for s in stocks_rows if (s["pct_change"] or 0) > 0)
        down = sum(1 for s in stocks_rows if (s["pct_change"] or 0) < 0)
        liquid = [s for s in stocks_rows if (s["volume_try"] or 0) >= 20_000_000 and s["pct_change"] is not None]
        liquid.sort(key=lambda s: s["pct_change"])
        mover = lambda s: {"symbol": s["symbol"], "change_pct": _r(s["pct_change"], 2), "close": _r(s["close"], 2)}

        stocks = {}
        for s in stocks_rows:
            close = float(s["close"])
            stocks[s["symbol"]] = {
                "name": s["title"],
                "date": str(d),
                "close": _r(close, 2),
                "change_pct": _r(s["pct_change"], 2),
                "rsi_14": _r(s["rsi_14"], 1),
                "vs_sma50_pct": _r((close / float(s["sma_50"]) - 1) * 100, 1) if s["sma_50"] else None,
                "vs_sma200_pct": _r((close / float(s["sma_200"]) - 1) * 100, 1) if s["sma_200"] else None,
                "volume_mn_try": _r((s["volume_try"] or 0) / 1e6, 1),
            }

        for r in _rows(cur, """
            SELECT f.symbol, f.payload FROM forecasts f
            JOIN (SELECT symbol, MAX(as_of) AS a FROM forecasts GROUP BY symbol) x ON x.symbol = f.symbol AND x.a = f.as_of"""):
            p = _j(r["payload"])
            if r["symbol"] in stocks and p.get("version") != "gold-v1":
                stocks[r["symbol"]]["forecast"] = _compact_forecast(p)

        gold = {}
        for sym in ("ALTIN", "XAUUSD"):
            g = _rows(cur, "SELECT payload FROM forecasts WHERE symbol = %s ORDER BY as_of DESC LIMIT 1", (sym,))
            if g:
                gold[sym] = _compact_gold(_j(g[0]["payload"]))

        for r in _rows(cur, """
            SELECT s.symbol, s.as_of, s.label, s.score, s.bullish_share, s.bearish_share, s.post_volume, s.summary
            FROM social_sentiment s
            JOIN (SELECT symbol, MAX(as_of) AS a FROM social_sentiment GROUP BY symbol) x ON x.symbol = s.symbol AND x.a = s.as_of
            WHERE s.as_of >= %s""", (d - timedelta(days=14),)):
            if r["symbol"] in stocks:
                stocks[r["symbol"]]["x_sentiment"] = {
                    "as_of": str(r["as_of"]), "label": r["label"], "score": _r(r["score"], 2),
                    "bullish_share": _r(r["bullish_share"], 2), "bearish_share": _r(r["bearish_share"], 2),
                    "volume": r["post_volume"], "summary": (r["summary"] or "")[:400],
                }

        disc = _rows(cur, """
            SELECT d.symbol, d.published_at, d.subject, v.label, v.score, v.event_type, v.rationale
            FROM disclosures d JOIN v_sentiment v ON v.disclosure_id = d.disclosure_id
            WHERE d.published_at >= %s ORDER BY d.published_at DESC""", (datetime.combine(d - timedelta(days=30), datetime.min.time()),))
        important = []
        for r in disc:
            item = {
                "symbol": r["symbol"], "published_at": r["published_at"].strftime("%Y-%m-%d %H:%M"), "subject": r["subject"],
                "sentiment": r["label"], "score": _r(r["score"], 2), "event_type": r["event_type"],
                "why": (r["rationale"] or "")[:240],
            }
            if r["symbol"] in stocks:
                lst = stocks[r["symbol"]].setdefault("kap_last_30d", [])
                if len(lst) < 3:
                    lst.append({k: item[k] for k in ("published_at", "subject", "sentiment", "event_type")})
            if r["label"] != "neutral" and r["published_at"].date() >= d - timedelta(days=4) and len(important) < 25:
                important.append(item)

        brief = _rows(cur, "SELECT as_of, mood, summary FROM market_briefs ORDER BY as_of DESC LIMIT 1")

        # top/bottom of today's 5-day "beat BIST100" ranking (context only — weak model)
        ranked = [
            (sym, h) for sym, s in stocks.items() for h in (s.get("forecast") or {}).get("horizons", [])
            if h["days"] == 5 and h["p_beat_bist100"] is not None and (s["volume_mn_try"] or 0) >= 20
        ]
        ranked.sort(key=lambda x: x[1]["p_beat_bist100"], reverse=True)
        rank_item = lambda x: {"symbol": x[0], "p_beat_bist100_5d": x[1]["p_beat_bist100"]}

    return {
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "data_date": str(d),
        "market": {
            "date": str(d),
            "previous_date": str(prev) if prev else None,
            "instruments": instruments,
            "breadth": {"up": up, "down": down, "total": len(stocks_rows)},
            "top_gainers": [mover(s) for s in liquid[::-1][:5]],
            "top_losers": [mover(s) for s in liquid[:5]],
        },
        "brief": {"as_of": str(brief[0]["as_of"]), "mood": brief[0]["mood"], "summary": brief[0]["summary"]} if brief else None,
        "gold": gold,
        "important_disclosures": important,
        "forecast_ranking_5d": {
            "top": [rank_item(x) for x in ranked[:10]],
            "bottom": [rank_item(x) for x in ranked[-5:]],
            "note": "Zayıf sinyal (AUC ~0.54); öneri değil, sadece sıralama.",
        },
        "stocks": stocks,
    }


def push(settings: Settings, url: str | None = None, token: str | None = None) -> dict:
    url = (url or os.environ.get("JARVIS_URL", "")).rstrip("/")
    token = token or os.environ.get("JARVIS_TOKEN", "")
    if not url or not token:
        log.info("jarvis push skipped: JARVIS_URL / JARVIS_TOKEN not set")
        return {"skipped": True}
    snap = build_snapshot(settings)
    stocks = snap.pop("stocks")
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    enc = lambda o: json.dumps(o, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8")

    # per-stock rows first (Jarvis reads one small row per question), then the general summary
    items, sent, total = list(stocks.items()), 0, 0
    for i in range(0, len(items), CHUNK):
        body = enc({"stocks": dict(items[i:i + CHUNK])})
        r = requests.post(f"{url}/finsent/stocks", data=body, headers=headers, timeout=60)
        r.raise_for_status()
        sent += r.json().get("count", 0)
        total += len(body)
    body = enc(snap)
    r = requests.post(f"{url}/finsent/snapshot", data=body, headers=headers, timeout=60)
    r.raise_for_status()
    out = {"ok": True, "general_bytes": len(body), "stock_bytes": total, "stocks": sent, "data_date": snap["data_date"]}
    log.info("jarvis push: %s", out)
    return out
