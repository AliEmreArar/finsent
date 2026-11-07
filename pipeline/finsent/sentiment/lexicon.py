"""Offline Turkish financial sentiment scorer (no network, deterministic).

Used when no LLM credentials are configured, as the baseline in evaluation,
and as the fallback when an LLM call fails. The PHP backend implements the
same algorithm over the same ``finsent/resources/lexicon_tr.json``.
"""
from __future__ import annotations

import json
import math
import re
from pathlib import Path

from .schema import SentimentResult

_CONTRAST = re.compile(r"\b(rağmen|karşın|ancak|fakat|ama|buna karşılık)\b")


def tr_lower(text: str) -> str:
    return text.replace("I", "ı").replace("İ", "i").lower()


def tokenize(text: str) -> list[str]:
    return re.findall(r"[0-9a-zçğıöşüâîû%]+", tr_lower(text))


class LexiconAnalyzer:
    provider = "lexicon"

    def __init__(self, lexicon_path: Path):
        lex = json.loads(Path(lexicon_path).read_text(encoding="utf-8"))
        self.version = lex.get("version", "0")
        terms = {**lex["positive"], **lex["negative"]}
        # longest phrases first so "net zarar" wins over "zarar"
        self.terms = sorted(((tokenize(k), float(v)) for k, v in terms.items()),
                            key=lambda t: -len(t[0]))
        self.negators = set(lex["negators"])
        self.intensifiers = {tuple(tokenize(k)): float(v) for k, v in lex["intensifiers"].items()}
        self.event_terms = sorted(((tokenize(k), v) for k, v in lex["neutral_event_types"].items()),
                                  key=lambda t: -len(t[0]))

    @staticmethod
    def _match(tokens: list[str], i: int, phrase: list[str]) -> bool:
        if i + len(phrase) > len(tokens):
            return False
        return all(tokens[i + j].startswith(p) for j, p in enumerate(phrase))

    def _score_tokens(self, tokens: list[str]) -> tuple[float, list[str]]:
        total, hits, i = 0.0, [], 0
        while i < len(tokens):
            for phrase, weight in self.terms:
                if self._match(tokens, i, phrase):
                    w = weight
                    window_before = tokens[max(0, i - 3):i]
                    for intens, mult in self.intensifiers.items():
                        n = len(intens)
                        if any(tuple(window_before[k:k + n]) == intens
                               for k in range(len(window_before) - n + 1)):
                            w *= mult
                    after = tokens[i + len(phrase):i + len(phrase) + 3]
                    if any(t in self.negators for t in after):
                        w = -w * 0.8
                    total += w
                    hits.append(" ".join(tokens[i:i + len(phrase)]))
                    i += len(phrase)
                    break
            else:
                i += 1
        return total, hits

    def event_type(self, text: str) -> str:
        tokens = tokenize(text)
        for i in range(len(tokens)):
            for phrase, etype in self.event_terms:
                if self._match(tokens, i, phrase):
                    return etype
        return "other"

    def analyze(self, text: str) -> SentimentResult:
        lowered = tr_lower(text)
        m = _CONTRAST.search(lowered)
        if m:  # the clause after a contrast marker carries the main message
            before, after = lowered[:m.start()], lowered[m.end():]
            s1, h1 = self._score_tokens(tokenize(before))
            s2, h2 = self._score_tokens(tokenize(after))
            if m.group(1) in ("rağmen", "karşın"):
                raw, hits = 0.4 * s1 + 1.2 * s2, h1 + h2
            else:
                raw, hits = 0.6 * s1 + 1.2 * s2, h1 + h2
        else:
            raw, hits = self._score_tokens(tokenize(lowered))

        score = math.tanh(raw / 1.5)
        label = "positive" if score > 0.2 else "negative" if score < -0.2 else "neutral"
        confidence = min(1.0, 0.35 + 0.2 * len(hits)) if hits else 0.3
        return SentimentResult(
            label=label, score=round(score, 4), confidence=round(confidence, 3),
            event_type=self.event_type(text), key_points=hits[:5],
            rationale=f"lexicon hits: {', '.join(hits[:5]) or 'none'}",
            provider=self.provider, model=f"lexicon-tr-{self.version}",
        )
