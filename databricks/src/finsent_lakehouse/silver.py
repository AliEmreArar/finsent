"""Silver: cleaned, conformed tables.

* ``silver_market``      - daily bars + returns, abnormal returns vs BIST100 and
                           event-window reaction targets (from the prior close).
* ``silver_disclosures`` - disclosures joined with their preferred sentiment
                           score (LLM over lexicon) and mapped to the first
                           trading day on which the market could react.
"""
from __future__ import annotations

import json
import logging

from pyspark.sql import Window
from pyspark.sql import functions as F

from .spark import LakePaths, get_spark, merge_into, register_table

log = logging.getLogger(__name__)
HORIZONS = (1, 3, 5)
MARKET_CLOSE_HOUR = 18


def build_market(spark, paths: LakePaths):
    bronze = spark.read.format("delta").load(paths.delta("bronze_market"))
    w = Window.partitionBy("symbol").orderBy("trade_date")
    df = (bronze.drop("_ingested_at", "_source_file")
          .filter(F.col("close").isNotNull() & (F.col("close") > 0))
          .withColumn("ret_1d", F.col("close") / F.lag("close").over(w) - 1)
          .withColumn("idx_ret_1d", F.col("bist100") / F.lag("bist100").over(w) - 1)
          .withColumn("abn_ret_1d", F.col("ret_1d") - F.col("idx_ret_1d")))
    prev_close, prev_idx = F.lag("close").over(w), F.lag("bist100").over(w)
    for h in HORIZONS:
        # reaction measured from the close *before* the event day through day h-1 after it
        stock = F.lead("close", h - 1).over(w) / prev_close - 1
        index = F.lead("bist100", h - 1).over(w) / prev_idx - 1
        df = df.withColumn(f"event_ret_{h}d", stock).withColumn(f"event_car_{h}d", stock - index)
    pre_stock = prev_close / F.lag("close", 6).over(w) - 1
    pre_index = prev_idx / F.lag("bist100", 6).over(w) - 1
    return df.withColumn("pre_car_5d", pre_stock - pre_index) \
             .withColumn("year_month", F.date_format("trade_date", "yyyy-MM"))


def build_disclosures(spark, paths: LakePaths, market):
    from finsent.kap_live import NOISE_SUBJECTS

    # mechanical notices (also dropped at ingestion now) may exist from earlier runs
    kap = spark.read.format("delta").load(paths.delta("bronze_disclosures")) \
        .drop("_ingested_at", "_source_file") \
        .filter(~F.col("subject").isin(sorted(NOISE_SUBJECTS)))
    sent = spark.read.format("delta").load(paths.delta("bronze_sentiment")) \
        .drop("_ingested_at", "_source_file")
    # one score per disclosure: prefer an LLM provider (anthropic / xai) over the lexicon baseline
    pref = Window.partitionBy("disclosure_id").orderBy(
        F.when(F.col("provider") != "lexicon", 0).otherwise(1))
    sent = sent.withColumn("_rk", F.row_number().over(pref)).filter("_rk = 1").drop("_rk")

    cal = market.select("trade_date").distinct()
    cand = kap.withColumn(
        "candidate_date",
        F.when(F.hour("published_at") >= MARKET_CLOSE_HOUR, F.date_add(F.to_date("published_at"), 1))
         .otherwise(F.to_date("published_at")))
    event = (cand.join(cal, cal.trade_date >= cand.candidate_date, "left")
             .groupBy("disclosure_id").agg(F.min("trade_date").alias("event_date")))
    return (kap.join(event, "disclosure_id", "left")
            .join(sent.select("disclosure_id", "provider", "model", "label", "score", "confidence",
                              "event_type", "key_points"), "disclosure_id", "left")
            .withColumn("published_date", F.to_date("published_at")))


def run(spark=None, paths: LakePaths | None = None) -> dict:
    spark = spark or get_spark("finsent-silver")
    paths = paths or LakePaths.from_env()
    market = build_market(spark, paths).cache()
    out = {"silver_market": merge_into(spark, market, paths.delta("silver_market"),
                                       ["symbol", "trade_date"], partition_by=["year_month"])}
    disc = build_disclosures(spark, paths, market)
    out["silver_disclosures"] = merge_into(spark, disc, paths.delta("silver_disclosures"),
                                           ["disclosure_id"])
    for name in ("silver_market", "silver_disclosures"):
        register_table(spark, name, paths.delta(name))
    market.unpersist()
    log.info("silver: %s", json.dumps(out))
    return out


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print(json.dumps(run(), indent=2))
