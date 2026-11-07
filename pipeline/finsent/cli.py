"""Command line entry point: run pipeline steps without Airflow.

    python -m finsent.cli run --start 2025-10-01 --end 2025-11-21
    python -m finsent.cli analyze "Şirketimiz 50 milyon USD tutarında ihale kazanmıştır."
    python -m finsent.cli patterns --symbol ASELS --start 2025-09-01 --end 2025-11-21
"""
from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path
from datetime import date, datetime

from . import jobs, market, patterns
from .config import get_settings
from .sentiment import get_analyzer


def _d(s: str) -> date:
    return date.fromisoformat(s)


def reset_disclosures(settings, source: str) -> dict:
    """Remove disclosures (and everything derived from them) from MySQL and the lake.

    Market data, patterns and DQ history are kept. Delta tables are dropped
    entirely; the lakehouse DAG rebuilds them from the raw zone.
    """
    from . import mysql_sink
    from .storage import Lake

    out = {}
    with mysql_sink.connect(settings) as conn, conn.cursor() as cur:
        where = "" if source == "all" else " WHERE source = %s"
        params = () if source == "all" else (source,)
        out["mysql_disclosures"] = cur.execute("DELETE FROM disclosures" + where, params)  # cascades
        cur.execute("DELETE FROM llm_insights")
        cur.execute("DELETE FROM model_evaluations")
        cur.execute("DELETE FROM companies WHERE symbol NOT IN (SELECT DISTINCT symbol FROM disclosures)")
    lake = Lake(settings)
    keys = [k for p in ("raw/kap/", "curated/sentiment/", "delta/") for k in lake.list_keys(p)]
    keys.append("state/kap_dedup_index.json")
    for i in range(0, len(keys), 1000):
        lake.s3.delete_objects(Bucket=lake.bucket,
                               Delete={"Objects": [{"Key": k} for k in keys[i:i + 1000]]})
    out["lake_objects_deleted"] = len(keys)
    return out


def backfill_kap(settings, start: date, end: date, scorer: str = "lexicon", chunk_days: int = 14,
                 interval_s: float = 6.0, windows: list[tuple[date, date]] | None = None,
                 rate_limit_wait_s: int = 300, tries: int = 4) -> dict:
    """Pull historical KAP disclosures newest-first in small windows (list data only, no notice
    texts), score them (lexicon by default - free) and load them into the serving DB.

    Safe to stop and restart: dedup skips everything already ingested."""
    import time
    from dataclasses import replace
    from datetime import timedelta

    s = replace(settings, kap_mode="live", kap_fetch_body="none", llm_provider=scorer,
                kap_request_interval_s=interval_s)
    totals = {"windows": 0, "new": 0, "scored": 0, "failed": []}
    log = logging.getLogger("finsent.backfill")
    if windows is None:  # newest first, two-week windows
        windows, b = [], end
        while b >= start:
            a = max(start, b - timedelta(days=chunk_days - 1))
            windows.append((a, b))
            b = a - timedelta(days=1)
    for a, b in windows:
        run_id = f"kap_hist_{a:%Y%m%d}_{b:%Y%m%d}"
        for attempt in range(1, tries + 1):
            try:
                k = jobs.ingest_disclosures(s, a, b, run_id)
                sc = jobs.score_sentiment(s, a, b, run_id) if k["new"] else {"scored": 0}
                # load even when nothing was new: an earlier attempt may have stopped after ingesting
                jobs.load_serving_db(s, a, b, run_id, {"kap": k})
                totals["windows"] += 1
                totals["new"] += k["new"]
                totals["scored"] += sc.get("scored", 0)
                log.info("KAP %s..%s: %d new (total %d)", a, b, k["new"], totals["new"])
                break
            except Exception as e:  # noqa: BLE001 - KAP throttling is expected on long runs
                limited = "rate limit" in str(e).lower() or "429" in str(e)
                log.warning("KAP %s..%s attempt %d failed: %s", a, b, attempt, str(e)[:160])
                if attempt == tries:
                    totals["failed"].append(f"{a}..{b}")
                    log.warning("KAP %s..%s failed", a, b)
                elif limited:
                    time.sleep(rate_limit_wait_s)  # let KAP's window reset before retrying the same range
    return totals


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    ap = argparse.ArgumentParser(prog="finsent")
    sub = ap.add_subparsers(dest="cmd", required=True)

    run = sub.add_parser("run", help="run the full pipeline for a window")
    run.add_argument("--start", type=_d, required=True)
    run.add_argument("--end", type=_d, required=True)
    run.add_argument("--skip-mysql", action="store_true")

    an = sub.add_parser("analyze", help="score one text")
    an.add_argument("text")

    pt = sub.add_parser("patterns", help="detect patterns for one symbol")
    pt.add_argument("--symbol", required=True)
    pt.add_argument("--start", type=_d, required=True)
    pt.add_argument("--end", type=_d, required=True)

    rs = sub.add_parser("reset-disclosures",
                        help="delete disclosure-derived data (lake + MySQL) so KAP can be re-ingested")
    rs.add_argument("--source", default="sample", help="sample (default) or all")
    rs.add_argument("--yes", action="store_true")

    bk = sub.add_parser("backfill-kap", help="historical KAP disclosures (list data), newest first")
    bk.add_argument("--start", type=_d, required=True)
    bk.add_argument("--end", type=_d, required=True)
    bk.add_argument("--scorer", default="lexicon", choices=["lexicon", "xai", "anthropic"])
    bk.add_argument("--retry-from-log", help="first re-run the windows a previous backfill log reported as failed")

    lk = sub.add_parser("rebuild-lake", help="rewrite the S3 lake from MySQL + market sources (after losing the object store)")
    lk.add_argument("--start", type=_d, required=True)
    lk.add_argument("--end", type=_d, required=True)
    lk.add_argument("--parts", default="market,kap,patterns,index", help="comma list: market,kap,patterns,index")

    ex = sub.add_parser("export-snapshot", help="maintainer: dump serving DB + market files into a release folder")
    ex.add_argument("--out", default="data/snapshot_release")

    sd = sub.add_parser("seed", help="download the newest data-* GitHub release and load MySQL, market files and the lake")
    sd.add_argument("--tag", help="a specific release tag (default: newest data-*)")
    sd.add_argument("--no-lake", action="store_true", help="skip rebuilding the S3 lake")
    sd.add_argument("--keep-downloads", action="store_true")

    args = ap.parse_args(argv)
    settings = get_settings()

    if args.cmd == "export-snapshot":
        from .snapshot import export
        print(json.dumps(export(settings, Path(args.out)), indent=2))
        return
    if args.cmd == "seed":
        from .snapshot import seed
        print(json.dumps(seed(settings, tag=args.tag, lake=not args.no_lake, keep_downloads=args.keep_downloads),
                         indent=2, default=str))
        return
    if args.cmd == "rebuild-lake":
        from .lake_rebuild import rebuild
        print(json.dumps(rebuild(settings, args.start, args.end, parts=tuple(args.parts.split(","))), indent=2))
        return

    if args.cmd == "backfill-kap":
        import re
        from datetime import timedelta
        wins = []
        if args.retry_from_log:
            text = open(args.retry_from_log, encoding="utf-8", errors="ignore").read()
            done = set(re.findall(r"KAP (\d{4}-\d\d-\d\d)\.\.(\d{4}-\d\d-\d\d): \d+ new", text))
            failed = set(re.findall(r"KAP (\d{4}-\d\d-\d\d)\.\.(\d{4}-\d\d-\d\d)(?: attempt \d+)? failed", text)) - done
            wins += sorted(((_d(a), _d(b)) for a, b in failed), reverse=True)
        b = args.end
        while b >= args.start:
            a = max(args.start, b - timedelta(days=13))
            wins.append((a, b))
            b = a - timedelta(days=1)
        print(json.dumps(backfill_kap(settings, args.start, args.end, args.scorer, windows=wins), indent=2, default=str))
    elif args.cmd == "reset-disclosures":
        if not args.yes:
            raise SystemExit("refusing without --yes")
        print(json.dumps(reset_disclosures(settings, args.source), indent=2))
    elif args.cmd == "analyze":
        print(get_analyzer(settings).analyze(args.text).model_dump_json(indent=2))
    elif args.cmd == "patterns":
        from datetime import timedelta
        hist = market.extract_market(settings, args.start - timedelta(days=120), args.end, [args.symbol])
        out = patterns.detect_patterns(hist, only_from=args.start)
        print(out.to_string(index=False))
    elif args.cmd == "run":
        run_id = f"cli__{datetime.now():%Y%m%dT%H%M%S}"
        stats = {
            "market": jobs.ingest_market(settings, args.start, args.end, run_id),
            "kap": jobs.ingest_disclosures(settings, args.start, args.end, run_id),
        }
        stats["sentiment"] = jobs.score_sentiment(settings, args.start, args.end, run_id)
        stats["patterns"] = jobs.detect_patterns(settings, args.start, args.end, run_id)
        if not args.skip_mysql:
            stats["serving"] = jobs.load_serving_db(settings, args.start, args.end, run_id, stats)
        for s in stats.values():
            s.pop("dq_report", None)
        print(json.dumps(stats, indent=2, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
