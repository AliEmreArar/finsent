"""Pipeline steps. Each function is a self-contained, idempotent unit that the
Airflow DAG (or the CLI) calls with a date window and a run id, and returns a
small JSON-serialisable stats dict (pushed to XCom by Airflow)."""
from __future__ import annotations

import logging
from datetime import date, timedelta

import pandas as pd
import pyarrow as pa

from . import kap, market, mysql_sink, patterns, quality
from .config import Settings
from .dedup import DEDUP_INDEX_KEY, dedup_disclosures, dedup_market
from .sentiment import analyze_many, get_analyzer
from .storage import Lake

log = logging.getLogger(__name__)


class DataQualityError(RuntimeError):
    pass


MARKET_SCHEMA = pa.schema(
    [("symbol", pa.string()), ("trade_date", pa.date32())]
    + [(c, pa.float64()) for c in market.MARKET_COLUMNS
       if c not in ("symbol", "trade_date", "open_is_estimated", "source")]
    + [("open_is_estimated", pa.bool_()), ("source", pa.string())]
)

SENTIMENT_SCHEMA = pa.schema([
    ("disclosure_id", pa.string()), ("label", pa.string()), ("score", pa.float64()),
    ("confidence", pa.float64()), ("event_type", pa.string()), ("key_points", pa.list_(pa.string())),
    ("rationale", pa.string()), ("provider", pa.string()), ("model", pa.string()),
])


def _days(start: date, end: date):
    d = start
    while d <= end:
        yield d
        d += timedelta(days=1)


def _known_symbols(settings: Settings) -> set[str] | None:
    try:
        return market.list_symbols(settings)
    except Exception:  # noqa: BLE001 - optional enrichment only
        return None


# --------------------------------------------------------------------------- market
def ingest_market(settings: Settings, start: date, end: date, run_id: str,
                  symbols: list[str] | None = None) -> dict:
    lake = Lake(settings)
    lake.ensure_bucket()
    df = market.extract_market(settings, start, end, symbols)
    df, dstats = dedup_market(df)

    report = quality.check_market(df, start, end, settings.dq_max_missing_ratio,
                                  settings.dq_min_symbols_per_day).as_dict()
    lake.put_json(f"quality/market/run_date={end}/{run_id}.json", report)
    if report["status"] == "fail":
        failed = [c["name"] for c in report["checks"] if not c["passed"] and c["severity"] == "error"]
        raise DataQualityError(f"market DQ failed for {start}..{end}: {failed}")

    written = 0
    # pinned schema: e.g. market_cap_try is all-NULL for Yahoo days and would otherwise be typed null
    df = df.astype({f.name: "float64" for f in MARKET_SCHEMA if pa.types.is_floating(f.type)})
    df["open_is_estimated"] = df["open_is_estimated"].astype(bool)
    for day, part in df.groupby("trade_date"):
        lake.put_parquet(f"raw/market/trade_date={day}/market.parquet", part[MARKET_SCHEMA.names],
                         schema=MARKET_SCHEMA)
        written += 1
    return {"rows": len(df), "partitions": written, "dedup": dstats.as_dict(),
            "dq_status": report["status"], "dq_report": report}


# --------------------------------------------------------------------------- KAP
def ingest_disclosures(settings: Settings, start: date, end: date, run_id: str) -> dict:
    lake = Lake(settings)
    lake.ensure_bucket()
    df = kap.extract_disclosures(settings, start, end)

    report = quality.check_disclosures(df, start, end, _known_symbols(settings)).as_dict()
    lake.put_json(f"quality/kap/run_date={end}/{run_id}.json", report)
    if report["status"] == "fail":
        failed = [c["name"] for c in report["checks"] if not c["passed"] and c["severity"] == "error"]
        raise DataQualityError(f"KAP DQ failed for {start}..{end}: {failed}")

    index = lake.get_json(DEDUP_INDEX_KEY, default=None)
    new, index, dstats = dedup_disclosures(df, index)
    bodies = 0
    if settings.kap_mode == "live" and not new.empty:
        # download full texts only for disclosures we have never seen (dedup runs first)
        from .kap_live import KapLiveClient
        new, cache = KapLiveClient(settings).enrich_bodies(new)
        bodies = len(cache)
    for day, part in new.groupby(new["published_at"].dt.date):
        lake.put_jsonl(f"raw/kap/published_date={day}/{run_id}.jsonl", kap.to_records(part))
    # Persist the index only after the raw data is safely written.
    lake.put_json(DEDUP_INDEX_KEY, index)
    return {"fetched": len(df), "new": len(new), "bodies_downloaded": bodies, "dedup": dstats.as_dict(),
            "dq_status": report["status"], "dq_report": report}


def _read_raw_disclosures(lake: Lake, start: date, end: date, run_id: str | None = None) -> pd.DataFrame:
    records = []
    for d in _days(start, end):
        prefix = f"raw/kap/published_date={d}/"
        if run_id:
            prefix += run_id
        records.extend(lake.read_jsonl_prefix(prefix))
    df = pd.DataFrame(records)
    if not df.empty:
        from .kap_live import NOISE_SUBJECTS

        df["published_at"] = pd.to_datetime(df["published_at"])
        # raw files written before a subject joined the noise list may still contain it
        df = df[~df["subject"].isin(NOISE_SUBJECTS)].reset_index(drop=True)
    return df


# --------------------------------------------------------------------------- sentiment
def score_sentiment(settings: Settings, start: date, end: date, run_id: str) -> dict:
    """Score only the disclosures this run ingested (dedup means nothing is re-scored)."""
    lake = Lake(settings)
    df = _read_raw_disclosures(lake, start, end, run_id)
    if df.empty:
        return {"scored": 0}
    analyzer = get_analyzer(settings)
    items = [{"text": f"{r.subject}. {r.summary}. {r.body}", "symbol": r.symbol, "subject": r.subject}
             for r in df.itertuples()]
    results = analyze_many(analyzer, items)
    scored = pd.DataFrame([r.model_dump() for r in results])
    scored.insert(0, "disclosure_id", df["disclosure_id"].values)
    scored["published_date"] = df["published_at"].dt.date.values
    for day, part in scored.groupby("published_date"):
        lake.put_parquet(f"curated/sentiment/published_date={day}/{run_id}.parquet",
                         part.drop(columns="published_date"), schema=SENTIMENT_SCHEMA)
    return {"scored": len(scored), "provider": scored["provider"].mode().iat[0],
            "labels": scored["label"].value_counts().to_dict()}


# --------------------------------------------------------------------------- patterns
def detect_patterns(settings: Settings, start: date, end: date, run_id: str) -> dict:
    """Needs ~60 trading days of history for rolling windows, read from the source DB."""
    hist = market.extract_market(settings, start - timedelta(days=120), end)
    pats = patterns.detect_patterns(hist, only_from=start)
    lake = Lake(settings)
    for day, part in pats.groupby("trade_date"):
        lake.put_parquet(f"curated/patterns/trade_date={day}/patterns.parquet", part)
    return {"patterns": len(pats), "by_pattern": pats["pattern"].value_counts().head(20).to_dict()}


# --------------------------------------------------------------------------- serving
def load_serving_db(settings: Settings, start: date, end: date, run_id: str,
                    stats: dict | None = None) -> dict:
    lake = Lake(settings)
    counts: dict[str, int] = {}
    with mysql_sink.connect(settings) as conn:
        mk = pd.concat([lake.read_parquet(f"raw/market/trade_date={d}/market.parquet")
                        for d in _days(start, end)], ignore_index=True)
        counts["market_daily"] = mysql_sink.upsert(conn, "market_daily", mk, mysql_sink.MARKET_COLS)

        disc = _read_raw_disclosures(lake, start, end)
        if not disc.empty:
            # a content hash already stored under another id would make the upsert rewrite that
            # row's primary key (and break child rows): keep the stored one, skip the newcomer
            with conn.cursor() as cur:
                hashes = list(disc["content_hash"].unique())
                taken = {}
                for i in range(0, len(hashes), 1000):
                    chunk = hashes[i:i + 1000]
                    cur.execute("SELECT content_hash, disclosure_id FROM disclosures WHERE content_hash IN "
                                f"({','.join(['%s'] * len(chunk))})", chunk)
                    taken.update(dict(cur.fetchall()))
            clash = disc["content_hash"].map(taken).notna() & (disc["content_hash"].map(taken) != disc["disclosure_id"])
            if clash.any():
                log.warning("skipping %d disclosures whose content is already stored under another id", int(clash.sum()))
                disc = disc[~clash]
            companies = disc[["symbol", "company_title"]].drop_duplicates("symbol")
            mysql_sink.upsert(conn, "companies", companies.rename(columns={"company_title": "title"}),
                              ["symbol", "title"])
            counts["disclosures"] = mysql_sink.upsert(conn, "disclosures", disc, mysql_sink.DISCLOSURE_COLS)

            sent = pd.concat([lake.read_parquet_prefix(f"curated/sentiment/published_date={d}/")
                              for d in _days(start, end)], ignore_index=True)
            if not sent.empty:
                sent = sent.drop_duplicates(["disclosure_id", "provider"], keep="last")
                sent = sent[sent["disclosure_id"].isin(disc["disclosure_id"])]
                counts["disclosure_sentiment"] = mysql_sink.upsert(
                    conn, "disclosure_sentiment", sent, mysql_sink.SENTIMENT_COLS)

            # Event returns need prices after the event, so read a little past the window.
            mk_ext = market.extract_market(settings, start - timedelta(days=15), end + timedelta(days=15))
            ev = patterns.event_returns(disc, mk_ext)
            for c in mysql_sink.EVENT_COLS:
                if c not in ev.columns:
                    ev[c] = None
            counts["event_returns"] = mysql_sink.upsert(conn, "event_returns", ev, mysql_sink.EVENT_COLS)

        pats = pd.concat([lake.read_parquet(f"curated/patterns/trade_date={d}/patterns.parquet")
                          for d in _days(start, end)], ignore_index=True)
        counts["patterns"] = mysql_sink.upsert(conn, "patterns", pats, mysql_sink.PATTERN_COLS)

        for key in ("market", "kap"):
            rep = (stats or {}).get(key, {}).get("dq_report")
            if rep:
                mysql_sink.record_dq(conn, run_id, rep)
        mysql_sink.record_run(conn, run_id, "load_serving_db", start, end, "success", counts)
    return counts


# --------------------------------------------------------------------------- market refresh
def refresh_market(settings: Settings, start: date, end: date, run_id: str) -> dict:
    """Pull Yahoo bars for days after the original history (no-op inside the history)."""
    if settings.market_source != "auto":
        return {"skipped": f"market source is {settings.market_source}"}
    from . import market_refresh

    hist_end = market_refresh.history_last_date(settings)
    if hist_end and end <= hist_end:
        return {"skipped": f"window inside original history (ends {hist_end})"}
    fetch_start = max(start, hist_end + timedelta(days=1)) if hist_end else start
    # top up any gap since the last stored update as well
    last = market_refresh.updates_last_date(settings)
    if last and last + timedelta(days=1) < fetch_start:
        fetch_start = last + timedelta(days=1)
    # new listings: KAP stock codes seen recently that the history does not know yet
    recent = _read_raw_disclosures(Lake(settings), end - timedelta(days=30), end)
    extra = set(recent["symbol"]) if not recent.empty else set()
    return market_refresh.refresh(settings, fetch_start, end, extra_symbols=extra)


# --------------------------------------------------------------------------- social (Grok X search)
def _social_watchlist(settings: Settings, lake: Lake, start: date, end: date) -> list[tuple[str, str | None]]:
    if settings.social_symbols:
        return [(s.strip().upper(), None) for s in settings.social_symbols.split(",") if s.strip()]
    """Half: stocks with the most non-neutral (LLM-scored) disclosures this week; half: most traded.

    Only symbols with market data qualify, which keeps warrants/certificates out.
    """
    mk = market.extract_market(settings, end - timedelta(days=7), end)
    if mk.empty:
        return []
    liquidity = mk.groupby("symbol")["volume_try"].mean().sort_values(ascending=False)
    titles: dict[str, str] = {}
    newsy: list[str] = []
    disc = _read_raw_disclosures(lake, end - timedelta(days=7), end)
    sent = pd.concat([lake.read_parquet_prefix(f"curated/sentiment/published_date={d}/")
                      for d in _days(end - timedelta(days=7), end)], ignore_index=True)
    if not disc.empty and not sent.empty:
        d = disc.merge(sent[["disclosure_id", "label"]], on="disclosure_id")
        d = d[(d["label"] != "neutral") & d["symbol"].isin(liquidity.index)]
        titles = dict(zip(disc["symbol"], disc["company_title"]))
        counts = d.groupby("symbol").size().to_frame("n").join(liquidity.rename("liq"))
        newsy = counts.sort_values(["n", "liq"], ascending=False).index.tolist()
    half = (settings.social_top_n + 1) // 2
    picked = newsy[:half]
    picked += [s for s in liquidity.index if s not in picked][: settings.social_top_n - len(picked)]
    return [(s, titles.get(s)) for s in picked]


def social_sentiment(settings: Settings, start: date, end: date, run_id: str) -> dict:
    import os

    if not os.environ.get("XAI_API_KEY"):
        return {"skipped": "XAI_API_KEY not set"}
    from .sentiment import get_grok
    from .sentiment.grok import GrokError

    lake = Lake(settings)
    grok = get_grok(settings)
    w_start = end - timedelta(days=settings.social_lookback_days)
    rows, errors = [], {}
    for symbol, title in _social_watchlist(settings, lake, start, end):
        try:
            r = grok.social_sentiment(symbol, title, w_start, end)
        except (GrokError, ValueError, KeyError) as e:
            errors[symbol] = str(e)[:200]
            continue
        rows.append({"symbol": symbol, "as_of": end, "window_start": w_start, "window_end": end, **r})
    if rows:
        df = pd.DataFrame(rows)
        lake.put_json(f"curated/social/as_of={end}/{run_id}.json", rows)
        with mysql_sink.connect(settings) as conn:
            mysql_sink.upsert(conn, "social_sentiment", df, mysql_sink.SOCIAL_COLS)
    cost = round(sum(r.get("cost_usd") or 0 for r in rows), 4)
    return {"symbols": len(rows), "errors": errors, "cost_usd": cost}


def market_brief(settings: Settings, start: date, end: date, run_id: str) -> dict:
    import json as _json
    import os

    if not os.environ.get("XAI_API_KEY"):
        return {"skipped": "XAI_API_KEY not set"}
    from .sentiment import get_grok

    mk = market.extract_market(settings, end - timedelta(days=7), end)
    move = None
    if not mk.empty:
        idx = mk.groupby("trade_date")["bist100"].first().dropna().sort_index()
        if len(idx) >= 2:
            move = {"bist100_close": round(float(idx.iloc[-1]), 2),
                    "bist100_change_pct": round(float(idx.iloc[-1] / idx.iloc[-2] - 1) * 100, 2),
                    "date": str(idx.index[-1])}
        day = idx.index[-1] if len(idx) else end
    else:
        day = end
    brief = get_grok(settings).market_brief(day, move)
    Lake(settings).put_json(f"curated/briefs/as_of={day}/{run_id}.json", brief)
    with mysql_sink.connect(settings) as conn, conn.cursor() as cur:
        cur.execute("REPLACE INTO market_briefs (as_of, mood, summary, payload, model, cost_usd) "
                    "VALUES (%s,%s,%s,%s,%s,%s)",
                    (day, brief["mood"], brief["summary"], _json.dumps(brief, ensure_ascii=False),
                     brief["model"], brief.get("cost_usd")))
    return {"as_of": str(day), "mood": brief["mood"], "cost_usd": brief.get("cost_usd")}
