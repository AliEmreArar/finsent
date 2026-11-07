"""Re-score stored disclosures with Grok in batches (e.g. history that was loaded with the
lexicon). Newest first; idempotent (only rows without an ``xai`` score are taken) and keeps
polling for a while so it also picks up windows a concurrent KAP backfill is still loading.

    python -m finsent.rescore --workers 40 --batch 20
"""
from __future__ import annotations

import argparse
import logging
import time
from concurrent.futures import ThreadPoolExecutor

import pandas as pd

from . import mysql_sink
from .config import get_settings
from .jobs import SENTIMENT_SCHEMA
from .sentiment import get_grok
from .storage import Lake

log = logging.getLogger("finsent.rescore")


def pending(conn, limit: int) -> pd.DataFrame:
    with conn.cursor() as cur:
        cur.execute("""SELECT d.disclosure_id, d.symbol, d.subject, d.summary, d.body, d.published_at
                         FROM disclosures d
                         LEFT JOIN disclosure_sentiment x ON x.disclosure_id = d.disclosure_id AND x.provider = 'xai'
                        WHERE x.disclosure_id IS NULL
                        ORDER BY d.published_at DESC LIMIT %s""", (limit,))
        rows = cur.fetchall()
    return pd.DataFrame(rows, columns=["disclosure_id", "symbol", "subject", "summary", "body", "published_at"])


def run(workers: int = 40, batch: int = 20, chunk: int = 4000, idle_minutes: int = 25) -> dict:
    settings = get_settings()
    grok = get_grok(settings)
    lake = Lake(settings)
    done, idle_since, t0 = 0, None, time.time()
    while True:
        with mysql_sink.connect(settings) as conn:
            todo = pending(conn, chunk)
        if todo.empty:
            idle_since = idle_since or time.time()
            if time.time() - idle_since > idle_minutes * 60:
                break
            time.sleep(120)
            continue
        idle_since = None
        items = [{"id": r.disclosure_id, "symbol": r.symbol, "subject": r.subject,
                  "text": f"{r.subject}. {r.summary}. {r.body or ''}"} for r in todo.itertuples()]
        groups = [items[i:i + batch] for i in range(0, len(items), batch)]
        with ThreadPoolExecutor(workers) as ex:
            results = [x for g in ex.map(grok.analyze_batch, groups) for x in g]
        scored = pd.DataFrame([r.model_dump() for r in results])
        scored.insert(0, "disclosure_id", todo["disclosure_id"].to_numpy())
        # a lexicon fallback is not a Grok score: keep it out so the row is retried next pass
        scored = scored[scored["provider"] == "xai"]
        with mysql_sink.connect(settings) as conn:
            mysql_sink.upsert(conn, "disclosure_sentiment", scored, mysql_sink.SENTIMENT_COLS)
        scored["published_date"] = pd.to_datetime(todo.set_index("disclosure_id").loc[scored["disclosure_id"], "published_at"]).dt.date.to_numpy()
        run_id = f"rescore_xai_{int(time.time())}"
        for day, part in scored.groupby("published_date"):
            lake.put_parquet(f"curated/sentiment/published_date={day}/{run_id}.parquet",
                             part.drop(columns="published_date"), schema=SENTIMENT_SCHEMA)
        done += len(scored)
        rate = done / max(1, time.time() - t0)
        log.info("rescored %d (total %d, %.1f/s), oldest in chunk %s", len(scored), done, rate, todo["published_at"].min())
    return {"rescored": done, "seconds": int(time.time() - t0)}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=40)
    ap.add_argument("--batch", type=int, default=20)
    a = ap.parse_args()
    print(run(a.workers, a.batch))
