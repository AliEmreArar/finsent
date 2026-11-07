"""Versioned data snapshots: export the serving DB + market files, publish them as a GitHub
Release, and seed a fresh install from it.

A snapshot is a directory of files plus ``manifest.json`` (row counts, sizes, sha256):

    tables/<table>.parquet         every serving-DB table (zstd parquet), except personal
                                   ones (alerts, drawings)
    market/bist_model_ready.db.gz  daily price history 1996-2025 (SQLite, the market source)
    market/bist_updates.db.gz      Yahoo daily bars after the history ends
    market/intraday.db.gz          1m/5m/15m bars
    models/forecast_v2.joblib      trained stock direction model (predict-only runs)
    models/gold_study.json         gold walk-forward study

    finsent export-snapshot --out data/snapshot              # maintainer: build files
    gh release create data-YYYY-MM-DD data/snapshot/*        # maintainer: publish
    finsent seed                                             # anyone: download + load

``seed`` downloads the newest ``data-*`` release of FINSENT_DATA_REPO (default
AliEmreArar/finsent) over plain HTTPS (no token needed for a public repo), verifies every
sha256, loads MySQL (TRUNCATE + bulk insert, FK checks off during the load), unpacks the
market files into data/market and data/models, and finally rebuilds the S3 lake.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import logging
import os
import shutil
import subprocess
import urllib.request
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from .config import Settings
from .mysql_sink import connect

log = logging.getLogger(__name__)

# load order respects foreign keys (seed also disables FK checks, this is belt and braces)
TABLES = ["companies", "market_daily", "disclosures", "disclosure_sentiment", "event_returns", "patterns",
          "forecasts", "llm_insights", "social_sentiment", "market_briefs", "research_results",
          "model_evaluations", "pipeline_runs", "dq_reports"]
PERSONAL = {"alerts", "drawings"}   # never exported: the user's own chart drawings and alerts
CHUNK = 200_000
DATA_REPO = os.environ.get("FINSENT_DATA_REPO", "AliEmreArar/finsent")


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _gzip(src: Path, dst: Path) -> None:
    with open(src, "rb") as fi, gzip.open(dst, "wb", compresslevel=6) as fo:
        shutil.copyfileobj(fi, fo, 1 << 20)


_ARROW = {"tinyint": pa.int64(), "smallint": pa.int64(), "int": pa.int64(), "bigint": pa.int64(),
          "decimal": pa.float64(), "double": pa.float64(), "float": pa.float64(),
          "date": pa.date32(), "datetime": pa.timestamp("us"), "timestamp": pa.timestamp("us")}


def _table_schema(settings: Settings, table: str) -> pa.Schema:
    """Arrow schema from MySQL column types, so an all-NULL first chunk cannot pin a column to null."""
    with connect(settings) as conn, conn.cursor() as cur:
        cur.execute("SELECT column_name, data_type FROM information_schema.columns "
                    "WHERE table_schema = DATABASE() AND table_name = %s ORDER BY ordinal_position", (table,))
        return pa.schema([(c, _ARROW.get(t.lower(), pa.string())) for c, t in cur.fetchall()])


def _clean_frame(df: pd.DataFrame) -> pd.DataFrame:
    for c in df.columns:
        if df[c].dtype == object:
            sample = df[c].dropna().head(50)
            if len(sample) and all(isinstance(v, Decimal) for v in sample):
                df[c] = df[c].astype(float)
            elif len(sample) and all(isinstance(v, (bytes, bytearray)) for v in sample):
                df[c] = df[c].map(lambda v: v.decode("utf-8") if isinstance(v, (bytes, bytearray)) else v)
    return df


# --------------------------------------------------------------------------- export
def export(settings: Settings, out: Path) -> dict:
    """Write a flat release folder: asset names encode the path (tables__x.parquet)."""
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    files: dict[str, dict] = {}

    for table in TABLES:
        rel = f"tables/{table}.parquet"
        schema = _table_schema(settings, table)
        rows = 0
        with pq.ParquetWriter(out / _asset_name(rel), schema, compression="zstd") as writer,                 connect(settings) as conn, conn.cursor() as cur:
            cur.execute(f"SELECT {', '.join(f'`{c}`' for c in schema.names)} FROM `{table}`")
            while True:
                batch = cur.fetchmany(CHUNK)
                if not batch:
                    break
                df = _clean_frame(pd.DataFrame(batch, columns=schema.names))
                writer.write_table(pa.Table.from_pandas(df, schema=schema, preserve_index=False))
                rows += len(df)
        files[rel] = {"rows": rows}
        log.info("exported %s: %d rows", table, rows)

    for src in (Path(settings.market_sqlite_path), Path(settings.market_updates_path),
                Path(settings.market_updates_path).with_name("intraday.db")):
        if src.exists():
            rel = f"market/{src.name}.gz"
            _gzip(src, out / _asset_name(rel))
            files[rel] = {"unpacked_name": src.name}
            log.info("packed %s", rel)

    models_dir = Path(settings.market_updates_path).parent.parent / "models"
    for name in ("forecast_v2.joblib", "gold_study.json"):
        if (models_dir / name).exists():
            shutil.copy2(models_dir / name, out / _asset_name(f"models/{name}"))
            files[f"models/{name}"] = {}

    for rel, meta in files.items():
        p = out / _asset_name(rel)
        meta.update(size=p.stat().st_size, sha256=_sha256(p))
    try:
        commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True,
                                cwd=Path(__file__).resolve().parents[2]).stdout.strip() or None
    except OSError:
        commit = None
    with connect(settings) as conn, conn.cursor() as cur:
        cur.execute("SELECT MIN(trade_date), MAX(trade_date) FROM market_daily")
        m0, m1 = cur.fetchone()
        cur.execute("SELECT MIN(published_at), MAX(published_at) FROM disclosures")
        d0, d1 = cur.fetchone()
    manifest = {
        "format": 1, "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "git_commit": commit,
        "coverage": {"market_daily": [str(m0), str(m1)], "disclosures": [str(d0), str(d1)]},
        "files": files,
        "sources": {
            "prices": "Yahoo Finance via yfinance and the original BIST history DB",
            "disclosures": "KAP - Kamuyu Aydınlatma Platformu (www.kap.org.tr), public regulatory filings",
            "sentiment": "xAI Grok (structured outputs) + FinSent Turkish lexicon",
        },
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1, ensure_ascii=False), encoding="utf-8")
    return {"out": str(out), "files": len(files), "bytes": sum(m["size"] for m in files.values())}


# --------------------------------------------------------------------------- seed
def _http_json(url: str) -> dict | list:
    req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "finsent-seed"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def _download(url: str, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(dst.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "finsent-seed", "Accept": "application/octet-stream"})
    with urllib.request.urlopen(req, timeout=600) as r, open(tmp, "wb") as f:
        shutil.copyfileobj(r, f, 1 << 20)
    tmp.replace(dst)


def latest_release(repo: str = DATA_REPO, tag: str | None = None) -> dict:
    if tag:
        return _http_json(f"https://api.github.com/repos/{repo}/releases/tags/{tag}")
    rels = [r for r in _http_json(f"https://api.github.com/repos/{repo}/releases?per_page=30")
            if r["tag_name"].startswith("data-") and not r.get("draft")]
    if not rels:
        raise RuntimeError(f"no data-* release found in {repo}")
    return max(rels, key=lambda r: r["published_at"])


def _asset_name(rel_path: str) -> str:
    """Release assets are flat: tables/market_daily.parquet -> tables__market_daily.parquet."""
    return rel_path.replace("/", "__")


def _to_db(v):
    if v is None or v is pd.NaT or (isinstance(v, float) and np.isnan(v)):
        return None
    if isinstance(v, pd.Timestamp):
        return None if pd.isna(v) else v.to_pydatetime()
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating,)):
        return None if np.isnan(v) else float(v)
    if isinstance(v, np.bool_):
        return bool(v)
    return v


def load_tables(settings: Settings, folder: Path, tables: list[str] = TABLES) -> dict:
    counts = {}
    with connect(settings) as conn, conn.cursor() as cur:
        cur.execute("SET FOREIGN_KEY_CHECKS = 0")
        for table in reversed(tables):
            cur.execute(f"TRUNCATE TABLE `{table}`")
        for table in tables:
            path = folder / "tables" / f"{table}.parquet"
            if not path.exists():
                continue
            pf, n = pq.ParquetFile(path), 0
            cols = pf.schema_arrow.names
            sql = f"INSERT INTO `{table}` ({', '.join(f'`{c}`' for c in cols)}) VALUES ({', '.join(['%s'] * len(cols))})"
            for batch in pf.iter_batches(batch_size=5000):
                df = batch.to_pandas()
                rows = [tuple(_to_db(v) for v in r) for r in df.itertuples(index=False, name=None)]
                cur.executemany(sql, rows)
                n += len(rows)
            conn.commit()
            counts[table] = n
            log.info("loaded %s: %d rows", table, n)
        cur.execute("SET FOREIGN_KEY_CHECKS = 1")
    return counts


def seed(settings: Settings, tag: str | None = None, workdir: Path | None = None, lake: bool = True,
         keep_downloads: bool = False) -> dict:
    data_dir = Path(settings.market_updates_path).parent.parent        # <repo>/data
    work = Path(workdir or data_dir / "snapshot")
    rel = latest_release(tag=tag)
    assets = {a["name"]: a["browser_download_url"] for a in rel["assets"]}
    log.info("seeding from %s (%s), %d assets", rel["tag_name"], rel["html_url"], len(assets))
    _download(assets["manifest.json"], work / "manifest.json")
    manifest = json.loads((work / "manifest.json").read_text(encoding="utf-8"))

    for rel_path, meta in manifest["files"].items():
        dst = work / rel_path
        if not (dst.exists() and _sha256(dst) == meta["sha256"]):
            log.info("downloading %s (%.1f MB)", rel_path, meta["size"] / 1e6)
            _download(assets[_asset_name(rel_path)], dst)
        if _sha256(dst) != meta["sha256"]:
            raise RuntimeError(f"checksum mismatch for {rel_path}")

    # market files -> data/market, models -> data/models
    (data_dir / "market").mkdir(parents=True, exist_ok=True)
    for rel_path, meta in manifest["files"].items():
        if rel_path.startswith("market/"):
            target = data_dir / "market" / meta["unpacked_name"]
            with gzip.open(work / rel_path, "rb") as fi, open(target, "wb") as fo:
                shutil.copyfileobj(fi, fo, 1 << 20)
        elif rel_path.startswith("models/"):
            (data_dir / "models").mkdir(exist_ok=True)
            shutil.copy2(work / rel_path, data_dir / "models" / Path(rel_path).name)

    counts = load_tables(settings, work)
    out = {"release": rel["tag_name"], "tables": counts}
    if lake:
        from .lake_rebuild import rebuild

        start, end = manifest["coverage"]["disclosures"]
        out["lake"] = rebuild(settings, date.fromisoformat(start[:10]), date.fromisoformat(end[:10]))
    if not keep_downloads:
        shutil.rmtree(work, ignore_errors=True)
    return out
