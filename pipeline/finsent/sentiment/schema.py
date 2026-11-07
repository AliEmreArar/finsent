from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Label = Literal["positive", "negative", "neutral"]
EventType = Literal[
    "financial_report", "dividend", "capital_increase", "buyback", "new_business",
    "legal", "rating", "m_and_a", "debt", "governance", "operations", "investment",
    "regulatory", "other",
]
EVENT_TYPES: list[str] = list(EventType.__args__)  # type: ignore[attr-defined]


class SentimentResult(BaseModel):
    label: Label
    score: float = Field(description="-1 (very negative) .. +1 (very positive)")
    confidence: float = Field(description="0..1")
    event_type: EventType = "other"
    key_points: list[str] = Field(default_factory=list)
    rationale: str = ""
    provider: str = ""
    model: str = ""

    def clamp(self) -> "SentimentResult":
        self.score = max(-1.0, min(1.0, float(self.score)))
        self.confidence = max(0.0, min(1.0, float(self.confidence)))
        return self


# JSON schema handed to Claude's structured outputs (provider/model are filled in locally).
SENTIMENT_JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "label": {"type": "string", "enum": ["positive", "negative", "neutral"]},
        "score": {"type": "number", "description": "-1 (very negative) to +1 (very positive)"},
        "confidence": {"type": "number", "description": "0 to 1"},
        "event_type": {"type": "string", "enum": EVENT_TYPES},
        "key_points": {"type": "array", "items": {"type": "string"}},
        "rationale": {"type": "string"},
    },
    "required": ["label", "score", "confidence", "event_type", "key_points", "rationale"],
    "additionalProperties": False,
}

PATTERN_JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "bias": {"type": "string", "enum": ["bullish", "bearish", "neutral", "mixed"]},
        "signals": {"type": "array", "items": {"type": "string"}},
        "risks": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["summary", "bias", "signals", "risks"],
    "additionalProperties": False,
}
