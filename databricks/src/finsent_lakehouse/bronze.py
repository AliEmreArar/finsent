"""Bronze: land the raw S3 zone (written by Airflow) into Delta tables, unchanged
apart from typing and lineage columns. MERGE keys make re-runs idempotent."""
from __future__ import annotations

import json
import logging

from pyspark.sql import functions as F

from .spark import LakePaths, get_spark, merge_into, register_table

log = logging.getLogger(__name__)


def _with_lineage(df):
    return df.withColumn("_ingested_at", F.current_timestamp()) \
             .withColumn("_source_file", F.input_file_name())


def run(spark=None, paths: LakePaths | None = None) -> dict:
    spark = spark or get_spark("finsent-bronze")
    paths = paths or LakePaths.from_env()
    out = {}

    # recursiveFileLookup: the partition column also exists inside the files
    market = spark.read.option("recursiveFileLookup", "true").parquet(paths.raw_market)
    market = _with_lineage(market).withColumn("trade_date", F.to_date("trade_date"))
    out["bronze_market"] = merge_into(spark, market, paths.delta("bronze_market"),
                                      ["symbol", "trade_date"])

    kap = (spark.read.option("recursiveFileLookup", "true").json(paths.raw_kap)
           .withColumn("published_at", F.to_timestamp("published_at"))
           .withColumn("disclosure_index", F.col("disclosure_index").cast("long")))
    kap = _with_lineage(kap)
    out["bronze_disclosures"] = merge_into(spark, kap, paths.delta("bronze_disclosures"),
                                           ["disclosure_id"])

    sent = spark.read.option("recursiveFileLookup", "true").parquet(paths.curated_sentiment)
    sent = _with_lineage(sent)
    out["bronze_sentiment"] = merge_into(spark, sent, paths.delta("bronze_sentiment"),
                                         ["disclosure_id", "provider"])

    for name in ("bronze_market", "bronze_disclosures", "bronze_sentiment"):
        register_table(spark, name, paths.delta(name))
    log.info("bronze: %s", json.dumps(out))
    return out


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print(json.dumps(run(), indent=2))
