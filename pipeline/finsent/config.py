"""Runtime configuration, read from environment variables (see .env.example)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name)
    return value if value not in (None, "") else default


# Lexicon + labelled evaluation set ship inside the package (also mounted into the PHP app).
RESOURCES = Path(__file__).resolve().parent / "resources"


def _repo_root() -> Path:
    # pipeline/finsent/config.py -> repo root is two parents up from the package dir
    return Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Settings:
    # --- storage -----------------------------------------------------------
    s3_bucket: str = field(default_factory=lambda: _env("FINSENT_S3_BUCKET", "finsent-lake"))
    s3_endpoint_url: str | None = field(default_factory=lambda: _env("AWS_ENDPOINT_URL"))
    aws_region: str = field(default_factory=lambda: _env("AWS_DEFAULT_REGION", "eu-central-1"))

    # --- sources -----------------------------------------------------------
    market_source: str = field(default_factory=lambda: _env("FINSENT_MARKET_SOURCE", "auto"))
    market_sqlite_path: str = field(
        default_factory=lambda: _env(
            "FINSENT_MARKET_SQLITE", str(_repo_root().parent / "bist_model_ready.db")
        )
    )
    # Yahoo bars after the end of the original history (written by market_refresh)
    market_updates_path: str = field(
        default_factory=lambda: _env(
            "FINSENT_MARKET_UPDATES", str(_repo_root() / "data" / "market" / "bist_updates.db")
        )
    )
    kap_mode: str = field(default_factory=lambda: _env("FINSENT_KAP_MODE", "sample"))
    kap_sample_path: str = field(
        default_factory=lambda: _env(
            "FINSENT_KAP_SAMPLE", str(_repo_root() / "data" / "samples" / "kap_disclosures_sample.jsonl")
        )
    )
    kap_user_agent: str = field(
        default_factory=lambda: _env("FINSENT_KAP_USER_AGENT", "finsent/1.0 (research project)")
    )
    kap_request_interval_s: float = field(
        default_factory=lambda: float(_env("FINSENT_KAP_INTERVAL_S", "3.0"))
    )

    # --- LLM -----------------------------------------------------------------
    llm_provider: str = field(default_factory=lambda: _env("FINSENT_LLM_PROVIDER", "auto"))
    llm_model: str = field(default_factory=lambda: _env("FINSENT_LLM_MODEL", "claude-opus-5"))
    llm_effort: str = field(default_factory=lambda: _env("FINSENT_LLM_EFFORT", "low"))
    llm_max_workers: int = field(default_factory=lambda: int(_env("FINSENT_LLM_WORKERS", "4")))
    # xAI Grok: XAI_MODEL for search/insights, XAI_FAST_MODEL for bulk disclosure scoring
    xai_model: str = field(default_factory=lambda: _env("XAI_MODEL", "grok-4.7"))
    xai_fast_model: str = field(
        default_factory=lambda: _env("XAI_FAST_MODEL", "grok-4.20-0309-non-reasoning"))

    # --- social sentiment (Grok X search) ------------------------------------------
    social_symbols: str = field(default_factory=lambda: _env("FINSENT_SOCIAL_SYMBOLS", ""))
    social_top_n: int = field(default_factory=lambda: int(_env("FINSENT_SOCIAL_TOP_N", "10")))
    social_lookback_days: int = field(default_factory=lambda: int(_env("FINSENT_SOCIAL_LOOKBACK_DAYS", "3")))

    # --- KAP live ---------------------------------------------------------------------
    kap_fetch_body: str = field(default_factory=lambda: _env("FINSENT_KAP_FETCH_BODY", "relevant"))
    kap_max_bodies: int = field(default_factory=lambda: int(_env("FINSENT_KAP_MAX_BODIES", "150")))

    # --- serving DB (MySQL used by the PHP app) ------------------------------
    mysql_host: str = field(default_factory=lambda: _env("MYSQL_HOST", "localhost"))
    mysql_port: int = field(default_factory=lambda: int(_env("MYSQL_PORT", "3306")))
    mysql_user: str = field(default_factory=lambda: _env("MYSQL_USER", "finsent"))
    mysql_password: str = field(default_factory=lambda: _env("MYSQL_PASSWORD", "finsent"))
    mysql_database: str = field(default_factory=lambda: _env("MYSQL_DATABASE", "finsent"))

    # --- data quality ----------------------------------------------------------
    dq_max_missing_ratio: float = field(
        default_factory=lambda: float(_env("FINSENT_DQ_MAX_MISSING_RATIO", "0.05"))
    )
    dq_min_symbols_per_day: int = field(
        default_factory=lambda: int(_env("FINSENT_DQ_MIN_SYMBOLS", "50"))
    )

    @property
    def lexicon_path(self) -> Path:
        return Path(_env("FINSENT_LEXICON", str(RESOURCES / "lexicon_tr.json")))

    @property
    def labeled_eval_path(self) -> Path:
        return Path(
            _env("FINSENT_LABELED_EVAL", str(RESOURCES / "labeled_headlines_tr.jsonl"))
        )


def get_settings() -> Settings:
    return Settings()
