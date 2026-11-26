"""Daily "follow a strategy" for virtual (paper) portfolios.

A paper portfolio can be linked to a saved Strategy Lab strategy (paper_accounts.strategy_id). In
the browser the portfolio page computes today's signals on open; this module does the same every
evening after the market data is loaded, so linked portfolios update even when no browser is open.

Flow per linked account (all through the PHP API, so prices, sizing and validation are the same
as in the UI):
  1. GET the strategy, its market data (last year + indicator warm-up, TL) and the account.
  2. Skip if this strategy already traded the account today.
  3. Write a job file for the strategy runner (a separate container with no network or secrets,
     see strategy-runner/runner.js) and wait for its result: today's signals translated to orders.
  4. POST the orders to /api/paper/{id}/order, sells first.

Strategy code never runs in this Python process or in the Airflow container.
"""
from __future__ import annotations

import json
import logging
import os
import time
import uuid
from datetime import date, timedelta
from pathlib import Path

import requests

log = logging.getLogger(__name__)

WARMUP_DAYS = {"1w": 1800, "1mo": 4500}


def web_url() -> str:
    return (os.environ.get("FINSENT_WEB_URL") or "http://web").rstrip("/")


def jobs_dir() -> Path:
    return Path(os.environ.get("FINSENT_STRATEGY_JOBS") or "/jobs")


def engine_config(cfg: dict, data_from: str) -> dict:
    """The lab's engine settings for a saved strategy config (mirrors engineConfig in lab.js)."""
    tf = cfg.get("timeframe") or "1d"
    return {
        "initialCapital": float(cfg.get("initialCapital") or 100000),
        "commissionBps": float(cfg.get("commissionBps") if cfg.get("commissionBps") is not None else 10),
        "slippageBps": float(cfg.get("slippageBps") if cfg.get("slippageBps") is not None else 5),
        "fill": cfg.get("fill") or "next_open",
        "adjustCorporateActions": cfg.get("adjustCorporateActions", True) is not False,
        "startDate": data_from,
        "timeframe": tf,
        "cashRatePct": float(cfg.get("cashRatePct") or 0),
    }


def already_applied(account: dict, strategy_name: str, today: date) -> bool:
    prefix = f"{strategy_name}:"
    day = today.isoformat()
    return any((t.get("note") or "").startswith(prefix) and str(t.get("traded_at", ""))[:10] == day
               for t in account.get("trades") or [])


def run_job(job: dict, directory: Path, timeout_s: float = 120.0, poll_s: float = 0.5) -> dict:
    """Hands a job to the strategy runner via the shared volume and waits for the result."""
    job_id = uuid.uuid4().hex
    inbox, outbox = directory / "in", directory / "out"
    inbox.mkdir(parents=True, exist_ok=True)
    tmp = inbox / f".{job_id}.tmp"
    tmp.write_text(json.dumps(job, ensure_ascii=False), encoding="utf-8")
    tmp.rename(inbox / f"{job_id}.json")        # atomic: the runner only picks up *.json
    result = outbox / f"{job_id}.json"
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if result.exists():
            data = json.loads(result.read_text(encoding="utf-8"))
            try:
                result.unlink()
            except OSError:
                pass
            return data
        time.sleep(poll_s)
    # still queued? withdraw it so a late run cannot place orders twice
    try:
        (inbox / f"{job_id}.json").unlink()
    except OSError:
        pass
    raise TimeoutError("strategy runner did not answer (is the strategy-runner service running?)")


def follow_account(http: requests.Session, base: str, account_id: int, directory: Path, today: date) -> dict:
    account = http.get(f"{base}/api/paper/{account_id}", timeout=60).json()
    sid = account.get("strategy_id")
    if not sid:
        return {"account": account_id, "status": "not_linked"}
    strategy = http.get(f"{base}/api/strategies/{sid}", timeout=60).json()
    name = strategy.get("name") or f"strateji {sid}"
    if already_applied(account, name, today):
        return {"account": account_id, "strategy": name, "status": "already_applied"}
    cfg = strategy.get("config") or {}
    symbols = [s for s in cfg.get("symbols") or [] if isinstance(s, str)]
    if not symbols:
        return {"account": account_id, "strategy": name, "status": "no_symbols"}
    data_from = (today - timedelta(days=365)).isoformat()
    params = {"symbols": ",".join(symbols), "from": data_from, "to": today.isoformat(), "currency": "TRY",
              "benchmark": "NONE", "warmup_days": WARMUP_DAYS.get(cfg.get("timeframe") or "1d", 420)}
    resp = http.get(f"{base}/api/strategy/data", params=params, timeout=120)
    resp.raise_for_status()
    data = resp.json()
    job = {"code": strategy.get("code") or "", "data": data["series"], "params": cfg.get("params") or {},
           "config": engine_config(cfg, data["from"]), "account": {"value": account["value"], "positions": account["positions"]}}
    out = run_job(job, directory)
    if not out.get("ok"):
        return {"account": account_id, "strategy": name, "status": "strategy_error", "error": out.get("error")}
    placed, failed = [], []
    for o in out.get("orders") or []:
        body = {k: v for k, v in o.items() if k in ("symbol", "side", "shares", "amount")}
        body["note"] = f"{name}: {o.get('reason') or 'otomatik'}"[:250]
        r = http.post(f"{base}/api/paper/{account_id}/order", json=body, timeout=60)
        (placed if r.ok else failed).append({**body, **({"error": r.json().get("error")} if not r.ok else {})})
    return {"account": account_id, "strategy": name, "status": "applied", "as_of": out.get("asOf"),
            "signals": len(out.get("signals") or []), "placed": placed, "failed": failed}


def run(base: str | None = None, directory: Path | None = None, today: date | None = None) -> dict:
    base = base or web_url()
    directory = directory or jobs_dir()
    today = today or date.today()
    http = requests.Session()
    accounts = http.get(f"{base}/api/paper", timeout=60).json().get("accounts", [])
    results = []
    for a in accounts:
        if not a.get("strategy_id"):
            continue
        try:
            results.append(follow_account(http, base, int(a["id"]), directory, today))
        except Exception as e:  # one broken strategy must not stop the others
            log.exception("paper follow failed for account %s", a.get("id"))
            results.append({"account": a.get("id"), "status": "error", "error": str(e)[:300]})
    summary = {"linked": len(results), "applied": sum(r["status"] == "applied" for r in results),
               "orders": sum(len(r.get("placed", [])) for r in results), "results": results}
    log.info("paper follow: %s", {k: v for k, v in summary.items() if k != "results"})
    return summary
