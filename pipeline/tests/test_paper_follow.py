"""Daily strategy following for paper portfolios (finsent.paper_follow)."""
from __future__ import annotations

import json
import threading
import time
from datetime import date
from pathlib import Path

import pytest

from finsent import paper_follow as pf


def test_engine_config_mirrors_the_lab_defaults():
    cfg = pf.engine_config({"commissionBps": 0, "timeframe": "1w", "adjustCorporateActions": False, "cashRatePct": 40}, "2025-01-02")
    assert cfg["commissionBps"] == 0.0          # an explicit 0 is kept, not replaced by the default
    assert cfg["slippageBps"] == 5.0
    assert cfg["timeframe"] == "1w"
    assert cfg["adjustCorporateActions"] is False
    assert cfg["startDate"] == "2025-01-02"
    assert cfg["cashRatePct"] == 40.0
    assert pf.engine_config({}, "x")["fill"] == "next_open"


def test_already_applied_matches_strategy_and_day():
    acc = {"trades": [{"note": "RSI: dip", "traded_at": "2026-11-26 19:41:00"}, {"note": "Diğer: x", "traded_at": "2026-11-27 10:00:00"}]}
    assert pf.already_applied(acc, "RSI", date(2026, 11, 26))
    assert not pf.already_applied(acc, "RSI", date(2026, 11, 27))
    assert not pf.already_applied(acc, "RS", date(2026, 11, 26))    # prefix includes the colon: "RS:" != "RSI:"
    assert not pf.already_applied({"trades": []}, "RSI", date(2026, 11, 26))


def _fake_runner(directory: Path, answer: dict, stop: threading.Event, seen: list):
    """Plays the strategy-runner: picks up in/*.json and writes out/<id>.json."""
    while not stop.is_set():
        for f in (directory / "in").glob("*.json"):
            job = json.loads(f.read_text())
            seen.append(job)
            f.unlink()
            (directory / "out").mkdir(exist_ok=True)
            (directory / "out" / f.name).write_text(json.dumps(answer))
        time.sleep(0.02)


def test_run_job_round_trip_and_timeout(tmp_path):
    stop, seen = threading.Event(), []
    t = threading.Thread(target=_fake_runner, args=(tmp_path, {"ok": True, "orders": []}, stop, seen), daemon=True)
    t.start()
    try:
        assert pf.run_job({"code": "x"}, tmp_path, timeout_s=5, poll_s=0.01) == {"ok": True, "orders": []}
        assert seen[0] == {"code": "x"}
        assert list((tmp_path / "out").glob("*.json")) == []     # result consumed
    finally:
        stop.set()
        t.join()
    with pytest.raises(TimeoutError):
        pf.run_job({"code": "y"}, tmp_path, timeout_s=0.1, poll_s=0.02)
    assert list((tmp_path / "in").glob("*.json")) == []          # unanswered job withdrawn


class FakeResp:
    def __init__(self, data, status=200):
        self._data, self.status_code = data, status
        self.ok = status < 400

    def json(self):
        return self._data

    def raise_for_status(self):
        if not self.ok:
            raise RuntimeError(self.status_code)


class FakeHttp:
    """Minimal stand-in for the PHP API."""

    def __init__(self, account, strategy):
        self.account, self.strategy, self.posted, self.data_params = account, strategy, [], None

    def get(self, url, params=None, timeout=None):
        if url.endswith("/api/paper"):
            return FakeResp({"accounts": [{"id": 1, "strategy_id": 7}, {"id": 2, "strategy_id": None}]})
        if "/api/paper/" in url:
            return FakeResp(self.account)
        if "/api/strategies/" in url:
            return FakeResp(self.strategy)
        if url.endswith("/api/strategy/data"):
            self.data_params = params
            return FakeResp({"from": params["from"], "series": {"THYAO": {"date": []}}})
        raise AssertionError(url)

    def post(self, url, json=None, timeout=None):
        self.posted.append((url, json))
        return FakeResp({"ok": True}) if json["symbol"] != "BAD" else FakeResp({"error": "yetersiz sanal bakiye"}, 400)


def test_follow_account_places_runner_orders(tmp_path, monkeypatch):
    http = FakeHttp({"id": 1, "strategy_id": 7, "value": 100000.0, "positions": [], "trades": []},
                    {"id": 7, "name": "Takip", "code": "const strategy={onBar(){}}", "config": {"symbols": ["THYAO", "BAD"], "timeframe": "1w"}})
    answer = {"ok": True, "asOf": "2026-11-06", "signals": [{}, {}],
              "orders": [{"symbol": "THYAO", "side": "buy", "amount": 30000, "reason": "hedef"}, {"symbol": "BAD", "side": "buy", "amount": 1, "reason": ""}]}
    monkeypatch.setattr(pf, "run_job", lambda job, d: answer if job["config"]["timeframe"] == "1w" else {"ok": False})
    out = pf.follow_account(http, "http://web", 1, tmp_path, date(2026, 11, 26))
    assert out["status"] == "applied"
    assert http.data_params["warmup_days"] == 1800 and http.data_params["currency"] == "TRY"
    assert [p[1]["symbol"] for p in http.posted] == ["THYAO", "BAD"]
    assert http.posted[0][1] == {"symbol": "THYAO", "side": "buy", "amount": 30000, "note": "Takip: hedef"}
    assert len(out["placed"]) == 1 and out["failed"][0]["error"] == "yetersiz sanal bakiye"


def test_follow_account_skips_when_already_applied_or_broken(tmp_path, monkeypatch):
    strategy = {"id": 7, "name": "Takip", "code": "x", "config": {"symbols": ["THYAO"]}}
    done = FakeHttp({"id": 1, "strategy_id": 7, "value": 1, "positions": [], "trades": [{"note": "Takip: x", "traded_at": "2026-11-26 19:40:00"}]}, strategy)
    assert pf.follow_account(done, "http://web", 1, tmp_path, date(2026, 11, 26))["status"] == "already_applied"
    broken = FakeHttp({"id": 1, "strategy_id": 7, "value": 1, "positions": [], "trades": []}, strategy)
    monkeypatch.setattr(pf, "run_job", lambda job, d: {"ok": False, "error": "onBar() hatası"})
    out = pf.follow_account(broken, "http://web", 1, tmp_path, date(2026, 11, 26))
    assert out == {"account": 1, "strategy": "Takip", "status": "strategy_error", "error": "onBar() hatası"}
    assert broken.posted == []


def test_run_only_follows_linked_accounts_and_survives_errors(tmp_path, monkeypatch):
    calls = []

    def fake_follow(http, base, account_id, directory, today):
        calls.append(account_id)
        raise RuntimeError("boom")

    monkeypatch.setattr(pf, "follow_account", fake_follow)
    monkeypatch.setattr(pf.requests, "Session", lambda: FakeHttp({}, {}))
    out = pf.run(base="http://web", directory=tmp_path, today=date(2026, 11, 26))
    assert calls == [1]
    assert out["linked"] == 1 and out["results"][0]["status"] == "error"
