"""Sentiment analyzers. ``get_analyzer`` picks an LLM provider when credentials
exist (Anthropic, then xAI Grok), otherwise the offline lexicon analyzer."""
from __future__ import annotations

import logging
import os

from ..config import Settings
from .lexicon import LexiconAnalyzer
from .schema import SentimentResult

log = logging.getLogger(__name__)

__all__ = ["get_analyzer", "get_grok", "LexiconAnalyzer", "SentimentResult", "llm_available",
           "active_provider"]


def _anthropic_key() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


def _xai_key() -> bool:
    return bool(os.environ.get("XAI_API_KEY"))


def active_provider(settings: Settings) -> str:
    p = settings.llm_provider
    if p in ("anthropic", "xai", "lexicon"):
        return p
    if _anthropic_key():
        return "anthropic"
    if _xai_key():
        return "xai"
    return "lexicon"


def llm_available() -> bool:
    return _anthropic_key() or _xai_key()


def get_grok(settings: Settings):
    from .grok import GrokAnalyzer

    return GrokAnalyzer(settings.xai_fast_model, settings.xai_model,
                        fallback=LexiconAnalyzer(settings.lexicon_path),
                        max_workers=settings.llm_max_workers)


def get_analyzer(settings: Settings):
    lexicon = LexiconAnalyzer(settings.lexicon_path)
    provider = active_provider(settings)
    log.info("sentiment provider: %s", provider)
    if provider == "anthropic":
        from .llm import ClaudeAnalyzer
        return ClaudeAnalyzer(settings.llm_model, settings.llm_effort, fallback=lexicon,
                              max_workers=settings.llm_max_workers)
    if provider == "xai":
        return get_grok(settings)
    return lexicon


def analyze_many(analyzer, items: list[dict]) -> list[SentimentResult]:
    if hasattr(analyzer, "analyze_many"):
        return analyzer.analyze_many(items)
    return [analyzer.analyze(it["text"]) for it in items]
