"""Rebuild the S3 data lake from the sources of truth.

The serving DB (MySQL) holds every ingested disclosure and its sentiment scores, and market
data can be re-read from the history DB plus the Yahoo updates DB. If the object store is lost
(e.g. the LocalStack community edition, which keeps S3 in memory, was restarted), this rewrites the lake with the same layout and pinned
schemas the daily jobs use, so the Spark lakehouse can run again:

    raw/market/trade_date=D/market.parquet          via jobs.ingest_market (DQ + pinned schema)
    raw/kap/published_date=D/rebuild.jsonl          from MySQL `disclosures`
    curated/sentiment/published_date=D/rebuild.parquet  from MySQL `disclosure_sentiment`
    curated/patterns/trade_date=D/patterns.parquet  via jobs.detect_patterns
    state/kap_dedup_index.json                      every id + content hash in MySQL

    finsent rebuild-lake --start 2021-01-01 --end 2026-11-07
"""
from __future__ import annotations

import json
import logging
from datetime import date

import pandas as pd

from . import jobs, kap
from .config import Settings
from .dedup import DEDUP_INDEX_KEY
from .mysql_sink import connect
from .storage import Lake

log = logging.getLogger(__name__)


def _years(start: date, end: date):
    y = start.year
    while y <= end.year:
        yield max(start, date(y, 1, 1)), min(end, date(y, 12, 31))
        y += 1


def _query(settings: Settings, sql: str, args: tuple) -> pd.DataFrame:
    with connect(settings) as conn, conn.cursor() as cur:
        cur.execute(sql, args)
        cols = [c[0] for c in cur.description]
        return pd.DataFrame(cur.fetchall(), columns=cols)


def rebuild(settings: Settings, start: date, end: date, run_id: str = "rebuild",
            parts: tuple[str, ...] = ("market", "kap", "patterns", "index")) -> dict:
    lake = Lake(settings)
    lake.ensure_bucket()
    out: dict = {}
    for a, b in _years(start, end):
        if "market" in parts:
            r = jobs.ingest_market(settings, a, b, f"{run_id}-{a.year}")
            out.setdefault("market_partitions", 0)
            out["market_partitions"] += r["partitions"]
            log.info("market %s..%s: %d partitions (dq %s)", a, b, r["partitions"], r["dq_status"])
        if "kap" in parts:
            d = _query(settings, f"SELECT {', '.join(kap.DISCLOSURE_COLUMNS)} FROM disclosures "
                                 "WHERE published_at >= %s AND published_at < %s + INTERVAL 1 DAY", (a, b))
            s = _query(settings, "SELECT s.disclosure_id, s.label, s.score, s.confidence, s.event_type, s.key_points, "
                                 "s.rationale, s.provider, s.model, DATE(d.published_at) AS published_date "
                                 "FROM disclosure_sentiment s JOIN disclosures d USING (disclosure_id) "
                                 "WHERE d.published_at >= %s AND d.published_at < %s + INTERVAL 1 DAY", (a, b))
            if not d.empty:
                d["published_at"] = pd.to_datetime(d["published_at"])
                for day, part in d.groupby(d["published_at"].dt.date):
                    lake.put_jsonl(f"raw/kap/published_date={day}/{run_id}.jsonl", kap.to_records(part))
            if not s.empty:
                s["key_points"] = s["key_points"].map(lambda v: json.loads(v) if isinstance(v, str) and v else [])
                for c in ("score", "confidence"):
                    s[c] = s[c].astype(float)
                for day, part in s.groupby("published_date"):
                    lake.put_parquet(f"curated/sentiment/published_date={day}/{run_id}.parquet",
                                     part[jobs.SENTIMENT_SCHEMA.names], schema=jobs.SENTIMENT_SCHEMA)
            out["disclosures"] = out.get("disclosures", 0) + len(d)
            out["sentiment_rows"] = out.get("sentiment_rows", 0) + len(s)
            log.info("kap %s..%s: %d disclosures, %d sentiment rows", a, b, len(d), len(s))
        if "patterns" in parts:
            r = jobs.detect_patterns(settings, a, b, f"{run_id}-{a.year}")
            out["patterns"] = out.get("patterns", 0) + r["patterns"]
            log.info("patterns %s..%s: %d", a, b, r["patterns"])
    if "index" in parts:
        ids = _query(settings, "SELECT disclosure_id, content_hash FROM disclosures", ())
        lake.put_json(DEDUP_INDEX_KEY, {"ids": sorted(ids["disclosure_id"]),
                                        "hashes": dict(zip(ids["content_hash"], ids["disclosure_id"]))})
        out["dedup_index_ids"] = len(ids)
    return out
