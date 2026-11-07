"""Idempotent upserts into the MySQL serving database used by the PHP app."""
from __future__ import annotations

import json
import logging
import math
from contextlib import contextmanager

import numpy as np
import pandas as pd
import pymysql

from .config import Settings

log = logging.getLogger(__name__)


@contextmanager
def connect(settings: Settings):
    conn = pymysql.connect(
        host=settings.mysql_host, port=settings.mysql_port, user=settings.mysql_user,
        password=settings.mysql_password, database=settings.mysql_database,
        charset="utf8mb4", autocommit=False,
    )
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _clean(v):
    if v is None:
        return None
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    if isinstance(v, np.ndarray):  # list columns come back from parquet as arrays
        v = v.tolist()
    if isinstance(v, (dict, list)):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, pd.Timestamp):
        return v.to_pydatetime().replace(tzinfo=None)
    if v is pd.NaT:
        return None
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    if hasattr(v, "item"):  # numpy scalar
        return v.item()
    return v


def upsert(conn, table: str, df: pd.DataFrame, columns: list[str], batch: int = 2000) -> int:
    if df.empty:
        return 0
    cols = ", ".join(f"`{c}`" for c in columns)
    placeholders = ", ".join(["%s"] * len(columns))
    updates = ", ".join(f"`{c}`=VALUES(`{c}`)" for c in columns)
    sql = f"INSERT INTO `{table}` ({cols}) VALUES ({placeholders}) ON DUPLICATE KEY UPDATE {updates}"
    rows = [tuple(_clean(v) for v in rec) for rec in df[columns].itertuples(index=False, name=None)]
    with conn.cursor() as cur:
        for i in range(0, len(rows), batch):
            cur.executemany(sql, rows[i:i + batch])
    log.info("upserted %d rows into %s", len(rows), table)
    return len(rows)


MARKET_COLS = ["symbol", "trade_date", "open", "high", "low", "close", "volume_try",
               "market_cap_try", "bist100", "usd_try", "pct_change", "rsi_14", "macd",
               "macd_signal", "macd_hist", "sma_50", "sma_200", "bb_lower", "bb_mid",
               "bb_upper", "open_is_estimated", "source"]
DISCLOSURE_COLS = ["disclosure_id", "disclosure_index", "symbol", "company_title", "published_at",
                   "disclosure_class", "subject", "summary", "body", "url", "source", "content_hash"]
SENTIMENT_COLS = ["disclosure_id", "provider", "model", "label", "score", "confidence",
                  "event_type", "key_points", "rationale"]
EVENT_COLS = ["disclosure_id", "symbol", "event_date", "ret_1d", "ret_3d", "ret_5d",
              "car_1d", "car_3d", "car_5d", "pre_car_5d"]
PATTERN_COLS = ["symbol", "trade_date", "pattern", "category", "direction", "strength", "detail"]


def record_run(conn, run_id: str, task: str, start, end, status: str, stats: dict) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "REPLACE INTO pipeline_runs (run_id, task, window_start, window_end, status, stats) "
            "VALUES (%s,%s,%s,%s,%s,%s)",
            (run_id, task, start, end, status, json.dumps(stats, default=str)),
        )


def record_dq(conn, run_id: str, report: dict) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "REPLACE INTO dq_reports (run_id, dataset, window_start, window_end, status, rows_checked, report) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s)",
            (run_id, report["dataset"], report["window_start"], report["window_end"],
             report["status"], report["rows"], json.dumps(report, default=str)),
        )
SOCIAL_COLS = ["symbol", "as_of", "window_start", "window_end", "label", "score", "bullish_share",
               "bearish_share", "post_volume", "summary", "themes", "notable_posts", "citations",
               "provider", "model", "posts_fetched", "cost_usd"]
