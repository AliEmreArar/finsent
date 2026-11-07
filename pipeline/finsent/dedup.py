"""Deduplication for market rows and KAP disclosures.

* Market rows are keyed by (symbol, trade_date). Within a batch the last row
  wins; across runs each trade_date partition is overwritten, so re-running a
  day is idempotent.
* Disclosures are deduplicated twice: by ``disclosure_id`` (same notice fetched
  again) and by ``content_hash`` (same text re-published under a new index,
  e.g. corrections that repeat the original). Seen keys persist in
  ``state/kap_dedup_index.json`` in the lake.
"""
from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

DEDUP_INDEX_KEY = "state/kap_dedup_index.json"


@dataclass
class DedupStats:
    input_rows: int
    in_batch_duplicates: int
    already_seen: int
    output_rows: int

    def as_dict(self) -> dict:
        return self.__dict__.copy()


def dedup_market(df: pd.DataFrame) -> tuple[pd.DataFrame, DedupStats]:
    before = len(df)
    out = df.drop_duplicates(subset=["symbol", "trade_date"], keep="last")
    stats = DedupStats(before, before - len(out), 0, len(out))
    return out.reset_index(drop=True), stats


def dedup_disclosures(df: pd.DataFrame, index: dict | None) -> tuple[pd.DataFrame, dict, DedupStats]:
    """Return (new rows, updated index, stats). ``index`` = {"ids": [...], "hashes": {hash: id}}."""
    index = index or {"ids": [], "hashes": {}}
    seen_ids = set(index["ids"])
    seen_hashes = dict(index["hashes"])

    before = len(df)
    batch = df.sort_values("published_at").drop_duplicates("disclosure_id", keep="first")
    batch = batch.drop_duplicates("content_hash", keep="first")
    in_batch = before - len(batch)

    mask_new = ~batch["disclosure_id"].isin(seen_ids) & ~batch["content_hash"].isin(seen_hashes)
    new = batch[mask_new]
    already_seen = len(batch) - len(new)

    seen_ids.update(new["disclosure_id"])
    seen_hashes.update(dict(zip(new["content_hash"], new["disclosure_id"])))
    updated = {"ids": sorted(seen_ids), "hashes": seen_hashes}
    stats = DedupStats(before, in_batch, already_seen, len(new))
    return new.reset_index(drop=True), updated, stats
