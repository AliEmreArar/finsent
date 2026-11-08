"""FinSent ingestion DAG.

Yahoo refresh -> market data + KAP disclosures -> S3 raw zone (dedup +
data-quality gates) -> LLM sentiment (Grok/Claude/lexicon) + pattern detection
-> MySQL serving DB -> Grok X-search social sentiment + daily market brief
-> lakehouse DAG.

Scheduled on weekdays after Borsa Istanbul closes. For backfills trigger it
manually with params, e.g. ``{"start": "2025-06-02", "end": "2025-11-21"}``.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta

import pendulum
from airflow.decorators import dag, task
from airflow.exceptions import AirflowSkipException
from airflow.models.param import Param
from airflow.operators.trigger_dagrun import TriggerDagRunOperator

TZ = pendulum.timezone("Europe/Istanbul")

DEFAULT_ARGS = {
    "owner": "finsent",
    "retries": 3,
    "retry_delay": timedelta(minutes=2),
    "retry_exponential_backoff": True,
    "max_retry_delay": timedelta(minutes=30),
    "execution_timeout": timedelta(hours=2),
}


def _window(context) -> tuple[date, date]:
    params = context["params"]
    if params.get("start") and params.get("end"):
        return date.fromisoformat(params["start"]), date.fromisoformat(params["end"])
    day = context["data_interval_end"].in_timezone(TZ).date()
    return day, day


def _run_id(context) -> str:
    return context["run_id"].replace(":", "_").replace("+", "_")


@dag(
    dag_id="finsent_ingest",
    description="Market data + KAP disclosures -> S3 -> sentiment/patterns -> MySQL",
    schedule="30 19 * * 1-5",
    start_date=datetime(2025, 1, 1, tzinfo=TZ),
    catchup=False,
    max_active_runs=1,
    default_args=DEFAULT_ARGS,
    params={
        "start": Param(None, type=["null", "string"], format="date", description="window start (backfill)"),
        "end": Param(None, type=["null", "string"], format="date", description="window end (backfill)"),
        "trigger_lakehouse": Param(True, type="boolean"),
        "grok_search": Param(True, type="boolean",
                             description="run Grok X/web search tasks (only for windows ending in the last 3 days)"),
    },
    tags=["finsent", "ingestion"],
)
def finsent_ingest():

    @task
    def plan_window(**context) -> dict:
        from finsent.quality import expected_trading_days

        start, end = _window(context)
        if not expected_trading_days(start, end):
            raise AirflowSkipException(f"no BIST trading day in {start}..{end}")
        return {"start": start.isoformat(), "end": end.isoformat(), "run_id": _run_id(context)}

    @task
    def refresh_market(win: dict) -> dict:
        from finsent import jobs
        from finsent.config import get_settings

        return jobs.refresh_market(get_settings(), date.fromisoformat(win["start"]),
                                   date.fromisoformat(win["end"]), win["run_id"])

    @task
    def ingest_market(win: dict, _refresh: dict) -> dict:
        from finsent import jobs
        from finsent.config import get_settings

        return jobs.ingest_market(get_settings(), date.fromisoformat(win["start"]),
                                  date.fromisoformat(win["end"]), win["run_id"])

    @task
    def ingest_kap(win: dict) -> dict:
        from finsent import jobs
        from finsent.config import get_settings

        return jobs.ingest_disclosures(get_settings(), date.fromisoformat(win["start"]),
                                       date.fromisoformat(win["end"]), win["run_id"])

    @task(retries=2, execution_timeout=timedelta(hours=3))
    def score_sentiment(win: dict, kap_stats: dict) -> dict:
        from finsent import jobs
        from finsent.config import get_settings

        # Scores whatever raw files this run_id wrote (a no-op when nothing new was ingested);
        # deciding from the lake rather than from XCom keeps task re-runs safe.
        return jobs.score_sentiment(get_settings(), date.fromisoformat(win["start"]),
                                    date.fromisoformat(win["end"]), win["run_id"])

    @task
    def detect_patterns(win: dict, market_stats: dict) -> dict:
        from finsent import jobs
        from finsent.config import get_settings

        return jobs.detect_patterns(get_settings(), date.fromisoformat(win["start"]),
                                    date.fromisoformat(win["end"]), win["run_id"])

    @task
    def load_serving_db(win: dict, market_stats: dict, kap_stats: dict, _s: dict, _p: dict) -> dict:
        from finsent import jobs
        from finsent.config import get_settings

        return jobs.load_serving_db(get_settings(), date.fromisoformat(win["start"]),
                                    date.fromisoformat(win["end"]), win["run_id"],
                                    {"market": market_stats, "kap": kap_stats})

    @task.short_circuit(ignore_downstream_trigger_rules=False)
    def grok_search_enabled(win: dict, **context) -> bool:
        import os

        recent = date.fromisoformat(win["end"]) >= date.today() - timedelta(days=3)
        return bool(context["params"].get("grok_search", True)) and recent and bool(os.environ.get("XAI_API_KEY"))

    @task(retries=1, execution_timeout=timedelta(hours=1))
    def social_sentiment(win: dict) -> dict:
        from finsent import jobs
        from finsent.config import get_settings

        return jobs.social_sentiment(get_settings(), date.fromisoformat(win["start"]),
                                     date.fromisoformat(win["end"]), win["run_id"])

    @task(retries=1, execution_timeout=timedelta(minutes=30))
    def market_brief(win: dict) -> dict:
        from finsent import jobs
        from finsent.config import get_settings

        return jobs.market_brief(get_settings(), date.fromisoformat(win["start"]),
                                 date.fromisoformat(win["end"]), win["run_id"])

    @task(retries=1, execution_timeout=timedelta(hours=1))
    def direction_forecast(win: dict) -> dict:
        from finsent import forecast
        from finsent.config import get_settings

        if date.fromisoformat(win["end"]) < date.today() - timedelta(days=7):
            return {"skipped": "backfill window - forecasts are for the latest day only"}
        # retrain weekly (about 10 min, ~3 GB); other days reuse the saved models
        return forecast.run(get_settings(), as_of=date.fromisoformat(win["end"]), retrain_after_days=7)

    @task(retries=2)
    def refresh_instruments() -> dict:
        from finsent import instruments

        return instruments.refresh()

    @task(retries=2, execution_timeout=timedelta(minutes=30))
    def gold_forecast(win: dict) -> dict:
        from finsent import gold_forecast as gf

        if date.fromisoformat(win["end"]) < date.today() - timedelta(days=7):
            return {"skipped": "backfill window"}
        path = gf._study_path()
        stale = not path.exists() or (date.today() - date.fromtimestamp(path.stat().st_mtime)).days >= 7
        if stale:   # weekly walk-forward re-evaluation (a few minutes); daily runs only refit + forecast
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(gf.research(), indent=1, default=float))
        return gf.run()

    @task(retries=2)
    def collect_intraday() -> dict:
        from finsent import intraday
        from finsent.config import get_settings

        return intraday.collect(get_settings())

    @task(retries=2, trigger_rule="all_done")
    def jarvis_push() -> dict:
        # runs after the day's outputs even if a Grok-search step was skipped or failed
        from finsent import jarvis_push as jp
        from finsent.config import get_settings

        return jp.push(get_settings())

    @task.short_circuit
    def lakehouse_enabled(**context) -> bool:
        return bool(context["params"].get("trigger_lakehouse", True))

    win = plan_window()
    m = ingest_market(win, refresh_market(win))
    k = ingest_kap(win)
    s = score_sentiment(win, k)
    p = detect_patterns(win, m)
    loaded = load_serving_db(win, m, k, s, p)

    trigger = TriggerDagRunOperator(
        task_id="trigger_lakehouse",
        trigger_dag_id="finsent_lakehouse",
        conf={"source_run_id": "{{ run_id }}"},
        wait_for_completion=False,
    )
    loaded >> lakehouse_enabled() >> trigger
    fc = direction_forecast(win)
    loaded >> fc
    win >> collect_intraday()
    gfc = gold_forecast(win)
    win >> refresh_instruments() >> gfc
    gate = grok_search_enabled(win)
    soc, brief = social_sentiment(win), market_brief(win)
    loaded >> gate >> [soc, brief]
    [fc, gfc, soc, brief] >> jarvis_push()


finsent_ingest()
