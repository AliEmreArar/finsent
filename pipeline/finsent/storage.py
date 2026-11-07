"""S3 data-lake helpers (works against AWS S3 or LocalStack via AWS_ENDPOINT_URL).

Lake layout::

    raw/market/trade_date=YYYY-MM-DD/market.parquet       one object per day (idempotent overwrite)
    raw/kap/published_date=YYYY-MM-DD/<run_id>.jsonl      only *new* disclosures (post-dedup)
    curated/sentiment/published_date=YYYY-MM-DD/<run_id>.parquet
    curated/patterns/trade_date=YYYY-MM-DD/patterns.parquet
    quality/<dataset>/run_date=YYYY-MM-DD/<run_id>.json   data-quality reports
    state/kap_dedup_index.json                            content-hash -> disclosure_id
"""
from __future__ import annotations

import io
import json
import logging

import pandas as pd

from .config import Settings

log = logging.getLogger(__name__)


class Lake:
    def __init__(self, settings: Settings, client=None):
        import boto3

        self.settings = settings
        self.bucket = settings.s3_bucket
        self.s3 = client or boto3.client(
            "s3", endpoint_url=settings.s3_endpoint_url, region_name=settings.aws_region
        )

    # --- bucket -------------------------------------------------------------
    def ensure_bucket(self) -> None:
        from botocore.exceptions import ClientError

        try:
            self.s3.head_bucket(Bucket=self.bucket)
        except ClientError:
            kwargs = {"Bucket": self.bucket}
            if self.settings.aws_region != "us-east-1":
                kwargs["CreateBucketConfiguration"] = {"LocationConstraint": self.settings.aws_region}
            self.s3.create_bucket(**kwargs)
            log.info("created bucket s3://%s", self.bucket)

    # --- primitives ---------------------------------------------------------
    def put_bytes(self, key: str, data: bytes, content_type: str) -> str:
        self.s3.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type)
        return f"s3://{self.bucket}/{key}"

    def get_bytes(self, key: str) -> bytes | None:
        from botocore.exceptions import ClientError

        try:
            return self.s3.get_object(Bucket=self.bucket, Key=key)["Body"].read()
        except ClientError as e:
            if e.response["Error"]["Code"] in ("NoSuchKey", "404"):
                return None
            raise

    def list_keys(self, prefix: str) -> list[str]:
        keys: list[str] = []
        for page in self.s3.get_paginator("list_objects_v2").paginate(Bucket=self.bucket, Prefix=prefix):
            keys.extend(o["Key"] for o in page.get("Contents", []))
        return keys

    # --- typed helpers --------------------------------------------------------
    def put_parquet(self, key: str, df: pd.DataFrame, schema=None) -> str:
        """``schema`` (pyarrow) pins column types so every partition file agrees -
        e.g. a list column that happens to be all-empty would otherwise be typed null."""
        buf = io.BytesIO()
        df.to_parquet(buf, index=False, schema=schema)
        return self.put_bytes(key, buf.getvalue(), "application/vnd.apache.parquet")

    def read_parquet(self, key: str) -> pd.DataFrame:
        data = self.get_bytes(key)
        return pd.read_parquet(io.BytesIO(data)) if data else pd.DataFrame()

    def read_parquet_prefix(self, prefix: str) -> pd.DataFrame:
        frames = [self.read_parquet(k) for k in self.list_keys(prefix) if k.endswith(".parquet")]
        frames = [f for f in frames if not f.empty]
        return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()

    def put_jsonl(self, key: str, records: list[dict]) -> str:
        body = "\n".join(json.dumps(r, ensure_ascii=False, default=str) for r in records)
        return self.put_bytes(key, body.encode("utf-8"), "application/x-ndjson")

    def read_jsonl_prefix(self, prefix: str) -> list[dict]:
        out: list[dict] = []
        for key in self.list_keys(prefix):
            if key.endswith(".jsonl"):
                text = (self.get_bytes(key) or b"").decode("utf-8")
                out.extend(json.loads(line) for line in text.splitlines() if line.strip())
        return out

    def put_json(self, key: str, obj) -> str:
        return self.put_bytes(
            key, json.dumps(obj, ensure_ascii=False, indent=2, default=str).encode("utf-8"),
            "application/json",
        )

    def get_json(self, key: str, default=None):
        data = self.get_bytes(key)
        return json.loads(data) if data else default
