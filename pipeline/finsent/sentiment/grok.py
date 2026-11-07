"""xAI Grok provider: disclosure sentiment, pattern interpretation and social
(X / web) sentiment via Grok's server-side search tools.

* Sentiment / interpretation use ``POST /v1/chat/completions`` with a strict
  JSON schema (``response_format``).
* Social sentiment uses ``POST /v1/responses`` with the ``x_search`` (and
  optionally ``web_search``) tools plus ``text.format`` structured output, so
  the answer is schema-valid JSON and the cited posts come back as
  ``url_citation`` annotations.

Any API failure falls back to the lexicon analyzer for sentiment, so a run
never stops because the LLM is unavailable.
"""
from __future__ import annotations

import json
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

import requests

from .lexicon import LexiconAnalyzer
from .llm import PATTERN_SYSTEM, SENTIMENT_SYSTEM
from .schema import PATTERN_JSON_SCHEMA, SENTIMENT_JSON_SCHEMA, SentimentResult

log = logging.getLogger(__name__)

API_BASE = os.environ.get("XAI_BASE_URL", "https://api.x.ai/v1")

SOCIAL_SYSTEM = """You are a market-sentiment analyst for Borsa Istanbul (BIST). Use the search \
tools to find recent posts and news about the given stock and summarise what investors are \
saying. Focus on the listed company (ticker and company name), ignore unrelated uses of the \
same word, and discount obvious spam, bots and paid promotion ("VIP grup", "sinyal kanalı"). \
Report in Turkish. score: -1 very bearish .. +1 very bullish. label: overall tone. \
bullish_share / bearish_share: rough shares (0..1) of opinionated posts. themes: 2-6 short \
topics. notable_posts: up to 5 representative, informative posts with their URL (skip \
profanity, insults and pure hype). Do not give investment advice."""

SOCIAL_JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "label": {"type": "string", "enum": ["positive", "negative", "neutral", "mixed"]},
        "score": {"type": "number"},
        "bullish_share": {"type": "number"},
        "bearish_share": {"type": "number"},
        "post_volume": {"type": "string", "enum": ["none", "low", "medium", "high"]},
        "summary": {"type": "string"},
        "themes": {"type": "array", "items": {"type": "string"}},
        "notable_posts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"text": {"type": "string"}, "url": {"type": "string"},
                               "stance": {"type": "string", "enum": ["bullish", "bearish", "neutral"]}},
                "required": ["text", "url", "stance"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["label", "score", "bullish_share", "bearish_share", "post_volume", "summary",
                 "themes", "notable_posts"],
    "additionalProperties": False,
}


BRIEF_SYSTEM = """You are a Borsa Istanbul market strategist. Use web and X search to summarise \
what moved the Turkish equity market (BIST 100) on the given day and what investors are \
discussing: macro and policy news (CBRT/TCMB, inflation, FX), global drivers, sector moves and \
the stocks in focus. Write in Turkish, factual and concise; cite nothing you did not find. \
mood: overall risk appetite. stocks_in_focus: BIST tickers (without .IS) with a one-line reason. \
Do not give investment advice."""

BRIEF_JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "mood": {"type": "string", "enum": ["risk_on", "risk_off", "neutral", "mixed"]},
        "drivers": {"type": "array", "items": {"type": "string"}},
        "sectors_in_focus": {"type": "array", "items": {"type": "string"}},
        "stocks_in_focus": {
            "type": "array",
            "items": {"type": "object",
                      "properties": {"symbol": {"type": "string"}, "reason": {"type": "string"}},
                      "required": ["symbol", "reason"], "additionalProperties": False},
        },
        "risks": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["summary", "mood", "drivers", "sectors_in_focus", "stocks_in_focus", "risks"],
    "additionalProperties": False,
}


class GrokError(RuntimeError):
    pass


class GrokClient:
    def __init__(self, api_key: str | None = None, timeout: float = 300, max_retries: int = 3):
        self.api_key = api_key or os.environ.get("XAI_API_KEY", "")
        if not self.api_key:
            raise GrokError("XAI_API_KEY is not set")
        self.timeout = timeout
        self.max_retries = max_retries
        self.session = requests.Session()
        self.session.headers.update({"Authorization": f"Bearer {self.api_key}",
                                     "Content-Type": "application/json"})

    def post(self, path: str, body: dict) -> dict:
        delay = 2.0
        for attempt in range(1, self.max_retries + 2):
            try:
                resp = self.session.post(f"{API_BASE}{path}", json=body, timeout=self.timeout)
            except requests.RequestException as e:
                if attempt > self.max_retries:
                    raise GrokError(f"network error: {e}") from e
                time.sleep(delay)
                delay *= 2
                continue
            if resp.status_code == 200:
                return resp.json()
            if resp.status_code in (408, 409, 429, 500, 502, 503, 504) and attempt <= self.max_retries:
                wait = float(resp.headers.get("retry-after", delay))
                log.warning("xAI HTTP %s, retry %d in %.0fs", resp.status_code, attempt, wait)
                time.sleep(wait)
                delay *= 2
                continue
            raise GrokError(f"xAI HTTP {resp.status_code}: {resp.text[:300]}")
        raise GrokError("xAI retries exhausted")

    def chat_json(self, model: str, system: str, user: str, schema: dict, name: str) -> tuple[dict, dict]:
        data = self.post("/chat/completions", {
            "model": model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "response_format": {"type": "json_schema",
                                "json_schema": {"name": name, "schema": schema, "strict": True}},
        })
        choice = data["choices"][0]
        if choice.get("finish_reason") == "length":
            raise GrokError("structured output truncated")
        return json.loads(choice["message"]["content"]), data.get("usage", {})

    def search_json(self, model: str, system: str, user: str, schema: dict, name: str,
                    tools: list[dict], max_tool_calls: int = 4) -> tuple[dict, list[dict], dict]:
        data = self.post("/responses", {
            "model": model,
            "instructions": system,
            "input": [{"role": "user", "content": user}],
            "tools": tools,
            "max_tool_calls": max_tool_calls,
            "text": {"format": {"type": "json_schema", "name": name, "schema": schema, "strict": True}},
        })
        if data.get("error"):
            raise GrokError(str(data["error"]))
        text, citations = None, []
        for item in data.get("output", []):
            if item.get("type") != "message":
                continue
            for c in item.get("content", []):
                if c.get("type") == "output_text":
                    text = c.get("text")
                    for a in c.get("annotations") or []:
                        if a.get("type") == "url_citation" and a.get("url"):
                            citations.append({"url": a["url"], "title": a.get("title") or a["url"]})
        if text is None:
            raise GrokError("no output_text in response")
        seen, unique = set(), []
        for c in citations:
            if c["url"] not in seen:
                seen.add(c["url"])
                unique.append(c)
        return json.loads(text), unique, data.get("usage", {})


def usage_cost_usd(usage: dict) -> float | None:
    ticks = usage.get("cost_in_usd_ticks")
    return round(ticks / 1e10, 4) if ticks else None


class GrokAnalyzer:
    provider = "xai"

    def __init__(self, model: str, search_model: str | None = None, fallback: LexiconAnalyzer | None = None,
                 client: GrokClient | None = None, max_workers: int = 4):
        self.model = model
        self.search_model = search_model or model
        self.fallback = fallback
        self.client = client or GrokClient()
        self.max_workers = max_workers

    # --- disclosure sentiment ---------------------------------------------------------
    def analyze(self, text: str, symbol: str | None = None, subject: str | None = None) -> SentimentResult:
        header = [f"Symbol: {symbol}"] if symbol else []
        if subject:
            header.append(f"Disclosure subject: {subject}")
        user = "\n".join(header + ["Disclosure text:", text[:12000]])
        try:
            data, _ = self.client.chat_json(self.model, SENTIMENT_SYSTEM, user,
                                            SENTIMENT_JSON_SCHEMA, "disclosure_sentiment")
            return SentimentResult(**data, provider=self.provider, model=self.model).clamp()
        except (GrokError, ValueError, KeyError, TypeError) as e:
            if self.fallback is None:
                raise
            log.warning("Grok sentiment failed (%s); using lexicon fallback", e)
            return self.fallback.analyze(text)

    def analyze_batch(self, items: list[dict]) -> list[SentimentResult]:
        """Score up to ~25 disclosures in one request (same rubric, one result per id).

        Items: [{"id", "text", "symbol"?, "subject"?}]. Missing or malformed results fall back
        to single scoring, so the output always has one result per input, in order."""
        item_schema = {**SENTIMENT_JSON_SCHEMA,
                       "properties": {"id": {"type": "string"}, **SENTIMENT_JSON_SCHEMA["properties"]},
                       "required": ["id", *SENTIMENT_JSON_SCHEMA["required"]]}
        schema = {"type": "object", "properties": {"results": {"type": "array", "items": item_schema}},
                  "required": ["results"], "additionalProperties": False}
        payload = [{"id": str(it["id"]), "symbol": it.get("symbol"), "subject": it.get("subject"),
                    "text": it["text"][:3000]} for it in items]
        user = ("Score every disclosure below independently with the rubric. Return exactly one result per id, "
                "keeping the ids. Be brief: at most 2 key_points of a few words each and a rationale of at most "
                "12 words.\n" + json.dumps(payload, ensure_ascii=False))
        by_id: dict[str, SentimentResult] = {}
        try:
            data, _ = self.client.chat_json(self.model, SENTIMENT_SYSTEM, user, schema, "disclosure_sentiment_batch")
            for r in data.get("results", []):
                rid = str(r.pop("id", ""))
                try:
                    by_id[rid] = SentimentResult(**r, provider=self.provider, model=self.model).clamp()
                except (ValueError, TypeError):
                    continue
        except (GrokError, ValueError, KeyError, TypeError) as e:
            log.warning("Grok batch failed (%s); scoring items one by one", e)
        return [by_id.get(str(it["id"])) or self.analyze(it["text"], it.get("symbol"), it.get("subject")) for it in items]

    def analyze_many(self, items: list[dict]) -> list[SentimentResult]:
        with ThreadPoolExecutor(max_workers=self.max_workers) as pool:
            return list(pool.map(
                lambda it: self.analyze(it["text"], it.get("symbol"), it.get("subject")), items))

    def interpret_patterns(self, symbol: str, patterns: list[dict], disclosures: list[dict]) -> dict:
        user = json.dumps({"symbol": symbol, "patterns": patterns, "recent_disclosures": disclosures},
                          ensure_ascii=False, default=str)
        data, _ = self.client.chat_json(self.search_model, PATTERN_SYSTEM, user, PATTERN_JSON_SCHEMA,
                                        "pattern_insight")
        data["model"] = self.search_model
        return data

    # --- social sentiment (X + web) ------------------------------------------------------
    def social_sentiment(self, symbol: str, company: str | None, start: date, end: date,
                         include_web: bool = False, max_tool_calls: int = 3) -> dict:
        tools = [{"type": "x_search", "from_date": start.isoformat(), "to_date": end.isoformat()}]
        if include_web:
            tools.append({"type": "web_search"})
        who = f"${symbol} / #{symbol}" + (f" ({company})" if company else "")
        user = (f"Hisse: {who}, Borsa İstanbul. Dönem: {start.isoformat()} - {end.isoformat()}. "
                "Bu dönemde X'te (ve gerekiyorsa haberlerde) bu hisse hakkında ne konuşuluyor?")
        data, citations, usage = self.client.search_json(
            self.search_model, SOCIAL_SYSTEM, user, SOCIAL_JSON_SCHEMA, "social_sentiment",
            tools, max_tool_calls=max_tool_calls)
        data["score"] = max(-1.0, min(1.0, float(data["score"])))
        tool_usage = usage.get("server_side_tool_usage_details", {})
        return {**data, "citations": citations, "provider": self.provider, "model": self.search_model,
                "posts_fetched": tool_usage.get("x_posts_fetched"),
                "cost_usd": usage_cost_usd(usage)}

    def market_brief(self, day: date, index_move: dict | None = None, max_tool_calls: int = 6) -> dict:
        user = (f"Tarih: {day.isoformat()}. Borsa İstanbul (BIST 100) bu gün nasıl kapandı, neler "
                "etkiledi ve yatırımcılar neyi konuşuyor?")
        if index_move:
            user += f" Bizim verimiz: {json.dumps(index_move, ensure_ascii=False)}"
        tools = [{"type": "web_search"},
                 {"type": "x_search", "from_date": (day - timedelta(days=1)).isoformat(),
                  "to_date": day.isoformat()}]
        data, citations, usage = self.client.search_json(
            self.search_model, BRIEF_SYSTEM, user, BRIEF_JSON_SCHEMA, "market_brief", tools,
            max_tool_calls=max_tool_calls)
        return {**data, "citations": citations, "model": self.search_model,
                "cost_usd": usage_cost_usd(usage)}
