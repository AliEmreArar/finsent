"""Gold: sentiment features for modelling and the per-disclosure event study.

* ``gold_sentiment_features`` - one row per (symbol, event_date): aggregated
  disclosure sentiment that day, trailing 30-day sentiment (prior info only),
  event-type counts, technical context, and forward reaction targets.
* ``gold_event_study`` - one row per disclosure with its sentiment and the
  stock's abnormal return over 1/3/5 trading days.
"""
from __future__ import annotations

import json
import logging

from pyspark.sql import Window
from pyspark.sql import functions as F

from .spark import LakePaths, get_spark, overwrite, register_table

log = logging.getLogger(__name__)

EVENT_TYPES = ["financial_report", "dividend", "capital_increase", "buyback", "new_business",
               "legal", "rating", "m_and_a", "debt", "governance", "operations", "investment",
               "regulatory", "other"]
TARGETS = ["event_car_1d", "event_car_3d", "event_car_5d", "event_ret_1d", "pre_car_5d"]


def build(spark, paths: LakePaths):
    market = spark.read.format("delta").load(paths.delta("silver_market"))
    disc = spark.read.format("delta").load(paths.delta("silver_disclosures")) \
        .filter(F.col("event_date").isNotNull() & F.col("score").isNotNull())

    event_study = (disc.join(market.select("symbol", F.col("trade_date").alias("event_date"), *TARGETS),
                             ["symbol", "event_date"], "left")
                   .select("disclosure_id", "symbol", "event_date", "published_at", "subject",
                           "provider", "model", "label", "score", "confidence", "event_type", *TARGETS))

    daily = disc.groupBy("symbol", "event_date").agg(
        F.count("*").alias("n_disclosures"),
        F.avg("score").alias("sent_mean"),
        F.sum("score").alias("sent_sum"),
        F.min("score").alias("sent_min"),
        F.max("score").alias("sent_max"),
        (F.sum(F.col("score") * F.col("confidence")) / F.sum("confidence")).alias("sent_conf_weighted"),
        F.sum(F.when(F.col("label") == "positive", 1).otherwise(0)).alias("n_positive"),
        F.sum(F.when(F.col("label") == "negative", 1).otherwise(0)).alias("n_negative"),
        F.sum(F.when(F.col("label") == "neutral", 1).otherwise(0)).alias("n_neutral"),
        *[F.sum(F.when(F.col("event_type") == et, 1).otherwise(0)).alias(f"n_evt_{et}")
          for et in EVENT_TYPES],
    )
    # trailing sentiment over the prior 30 calendar days (excludes the event day itself)
    day_num = F.datediff("event_date", F.lit("1970-01-01"))
    w30 = Window.partitionBy("symbol").orderBy(day_num).rangeBetween(-30, -1)
    daily = (daily.withColumn("sent_mean_prior_30d", F.avg("sent_mean").over(w30))
                  .withColumn("n_disclosures_prior_30d", F.sum("n_disclosures").over(w30)))

    # Technical context must come from the day *before* the event: the event-day close is
    # already part of the reaction target (event_car_* is measured from the prior close).
    wm = Window.partitionBy("symbol").orderBy("trade_date")
    bb_pos = (F.col("close") - F.col("bb_lower")) / (F.col("bb_upper") - F.col("bb_lower"))
    tech = (market
            .withColumn("rsi_14", F.lag("rsi_14").over(wm))
            .withColumn("macd_hist", F.lag("macd_hist").over(wm))
            .withColumn("bb_position", F.lag(bb_pos).over(wm))
            .withColumn("volume_try", F.lag("volume_try").over(wm))
            .withColumn("abn_ret_1d", F.lag("abn_ret_1d").over(wm))
            .select("symbol", F.col("trade_date").alias("event_date"), "rsi_14", "macd_hist",
                    "bb_position", "volume_try", "abn_ret_1d", *TARGETS))
    features = (daily.join(tech, ["symbol", "event_date"], "left")
                .withColumn("year_month", F.date_format("event_date", "yyyy-MM")))
    return features, event_study


def run(spark=None, paths: LakePaths | None = None) -> dict:
    spark = spark or get_spark("finsent-gold")
    paths = paths or LakePaths.from_env()
    features, event_study = build(spark, paths)
    # gold is fully derived from silver, so rebuild it each run (Delta keeps prior versions)
    out = {
        "gold_sentiment_features": overwrite(features, paths.delta("gold_sentiment_features"),
                                             partition_by=["year_month"]),
        "gold_event_study": overwrite(event_study, paths.delta("gold_event_study")),
    }
    for name in out:
        register_table(spark, name, paths.delta(name))
    log.info("gold: %s", json.dumps(out))
    return out


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print(json.dumps(run(), indent=2))
