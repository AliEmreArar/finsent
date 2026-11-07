"""Claude-backed sentiment analysis and pattern interpretation.

Structured outputs (``output_config.format``) guarantee schema-valid JSON.
Requests opt into server-side refusal fallbacks (``fallbacks="default"``), and
any API failure degrades to the lexicon analyzer so a pipeline run never stops
because the LLM is unavailable.
"""
from __future__ import annotations

import json
import logging
from concurrent.futures import ThreadPoolExecutor

import anthropic

from .lexicon import LexiconAnalyzer
from .schema import PATTERN_JSON_SCHEMA, SENTIMENT_JSON_SCHEMA, SentimentResult

log = logging.getLogger(__name__)

SENTIMENT_SYSTEM = """You are a financial analyst covering Borsa Istanbul. You read company \
disclosures published on KAP (Kamuyu Aydınlatma Platformu), usually in Turkish, and judge \
their likely effect on the company's share price from a shareholder's point of view.

Score guidance: +1 = clearly value-accretive news (large contract win, strong earnings beat, \
bonus issue), 0 = routine/administrative notice with no price relevance, -1 = clearly \
value-destructive news (large loss, bankruptcy filing, regulatory ban). Routine filings \
(general assembly notices, responsibility statements, address changes) are neutral even when \
they mention words like "kâr" or "dava". Denials of negative rumours and dismissed lawsuits \
are positive. When a sentence contrasts two facts ("...rağmen..."), weigh the main clause.

key_points: up to 4 short phrases, in Turkish, quoting or paraphrasing the facts that drove \
the score. rationale: one or two sentences in Turkish."""

PATTERN_SYSTEM = """You are a technical and fundamental analyst for Borsa Istanbul. You get \
detected chart patterns and recent KAP disclosure sentiment for one stock. Write a short, \
balanced interpretation in Turkish: what the signals suggest together, where they conflict, \
and the main risks. Do not give investment advice or price targets; describe the evidence."""

FALLBACK_BETA = "server-side-fallback-2026-07-01"


class ClaudeAnalyzer:
    provider = "anthropic"

    def __init__(self, model: str, effort: str = "low", fallback: LexiconAnalyzer | None = None,
                 client: anthropic.Anthropic | None = None, max_workers: int = 4):
        self.model = model
        self.effort = effort
        self.fallback = fallback
        self.client = client or anthropic.Anthropic(max_retries=3)
        self.max_workers = max_workers

    def _structured(self, system: str, user: str, schema: dict, max_tokens: int) -> dict:
        response = self.client.beta.messages.create(
            model=self.model,
            max_tokens=max_tokens,
            betas=[FALLBACK_BETA],
            fallbacks="default",
            system=system,
            output_config={"effort": self.effort, "format": {"type": "json_schema", "schema": schema}},
            messages=[{"role": "user", "content": user}],
        )
        if response.stop_reason == "refusal":
            raise RuntimeError(f"model refused (request {response._request_id})")
        if response.stop_reason == "max_tokens":
            raise RuntimeError("structured output truncated at max_tokens")
        text = next(b.text for b in response.content if b.type == "text")
        return json.loads(text)

    def analyze(self, text: str, symbol: str | None = None, subject: str | None = None) -> SentimentResult:
        header = []
        if symbol:
            header.append(f"Symbol: {symbol}")
        if subject:
            header.append(f"Disclosure subject: {subject}")
        user = "\n".join(header + ["Disclosure text:", text[:12000]])
        try:
            data = self._structured(SENTIMENT_SYSTEM, user, SENTIMENT_JSON_SCHEMA, 4000)
            return SentimentResult(**data, provider=self.provider, model=self.model).clamp()
        except (anthropic.APIError, RuntimeError, ValueError, StopIteration) as e:
            if self.fallback is None:
                raise
            log.warning("LLM sentiment failed (%s); using lexicon fallback", e)
            return self.fallback.analyze(text)

    def analyze_many(self, items: list[dict]) -> list[SentimentResult]:
        """items: [{"text":..., "symbol":..., "subject":...}] - order is preserved."""
        with ThreadPoolExecutor(max_workers=self.max_workers) as pool:
            return list(pool.map(
                lambda it: self.analyze(it["text"], it.get("symbol"), it.get("subject")), items
            ))

    def interpret_patterns(self, symbol: str, patterns: list[dict], disclosures: list[dict]) -> dict:
        user = json.dumps({"symbol": symbol, "patterns": patterns,
                           "recent_disclosures": disclosures}, ensure_ascii=False, default=str)
        data = self._structured(PATTERN_SYSTEM, user, PATTERN_JSON_SCHEMA, 6000)
        data["model"] = self.model
        return data
