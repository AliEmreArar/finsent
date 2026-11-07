"""Spark session + lake paths that work both on Databricks and locally."""
from __future__ import annotations

import os
from dataclasses import dataclass

from pyspark.sql import DataFrame, SparkSession


def on_databricks() -> bool:
    return "DATABRICKS_RUNTIME_VERSION" in os.environ


def get_spark(app: str = "finsent") -> SparkSession:
    if on_databricks():
        return SparkSession.builder.getOrCreate()

    endpoint = os.environ.get("AWS_ENDPOINT_URL", "")
    builder = (
        SparkSession.builder.appName(app)
        .master(os.environ.get("SPARK_MASTER", "local[*]"))
        .config("spark.driver.memory", os.environ.get("SPARK_DRIVER_MEMORY", "2g"))
        .config("spark.sql.shuffle.partitions", os.environ.get("SPARK_SHUFFLE_PARTITIONS", "8"))
        .config("spark.sql.session.timeZone", "Europe/Istanbul")
        .config("spark.sql.extensions", "io.delta.sql.DeltaSparkSessionExtension")
        .config("spark.sql.catalog.spark_catalog", "org.apache.spark.sql.delta.catalog.DeltaCatalog")
        .config("spark.hadoop.fs.s3a.impl", "org.apache.hadoop.fs.s3a.S3AFileSystem")
        .config("spark.hadoop.fs.s3a.aws.credentials.provider",
                "com.amazonaws.auth.EnvironmentVariableCredentialsProvider")
        .config("spark.ui.showConsoleProgress", "false")
    )
    if endpoint:  # LocalStack / MinIO
        builder = (
            builder.config("spark.hadoop.fs.s3a.endpoint", endpoint)
            .config("spark.hadoop.fs.s3a.path.style.access", "true")
            .config("spark.hadoop.fs.s3a.connection.ssl.enabled", str(endpoint.startswith("https")).lower())
        )
    extra = os.environ.get("SPARK_JARS_PACKAGES")  # only needed when jars are not baked into the image
    if extra:
        builder = builder.config("spark.jars.packages", extra)
    spark = builder.getOrCreate()
    spark.sparkContext.setLogLevel("WARN")
    return spark


@dataclass(frozen=True)
class LakePaths:
    root: str  # e.g. s3a://finsent-lake (local) or s3://finsent-lake (Databricks)

    @classmethod
    def from_env(cls) -> "LakePaths":
        bucket = os.environ.get("FINSENT_S3_BUCKET", "finsent-lake")
        scheme = "s3" if on_databricks() else "s3a"
        return cls(os.environ.get("FINSENT_LAKE_ROOT", f"{scheme}://{bucket}"))

    # raw zone written by the Airflow ingestion DAG
    @property
    def raw_market(self) -> str: return f"{self.root}/raw/market/"
    @property
    def raw_kap(self) -> str: return f"{self.root}/raw/kap/"
    @property
    def curated_sentiment(self) -> str: return f"{self.root}/curated/sentiment/"

    def delta(self, name: str) -> str:
        return f"{self.root}/delta/{name}"


def register_table(spark: SparkSession, name: str, path: str) -> None:
    """Expose a path-based Delta table in the metastore / Unity Catalog when configured."""
    schema = os.environ.get("FINSENT_UC_SCHEMA")  # e.g. "main.finsent"
    if schema:
        spark.sql(f"CREATE TABLE IF NOT EXISTS {schema}.{name} USING DELTA LOCATION '{path}'")


def overwrite(df: DataFrame, path: str, partition_by: list[str] | None = None) -> dict:
    """Full rebuild for derived tables (gold), allowing the schema to evolve."""
    writer = df.write.format("delta").mode("overwrite").option("overwriteSchema", "true")
    if partition_by:
        writer = writer.partitionBy(*partition_by)
    writer.save(path)
    return {"overwritten": True, "rows": df.sparkSession.read.format("delta").load(path).count()}


def merge_into(spark: SparkSession, df: DataFrame, path: str, keys: list[str],
               partition_by: list[str] | None = None) -> dict:
    """Idempotent upsert into a Delta table at ``path`` (created on first write)."""
    from delta.tables import DeltaTable

    if not DeltaTable.isDeltaTable(spark, path):
        writer = df.write.format("delta").mode("overwrite")
        if partition_by:
            writer = writer.partitionBy(*partition_by)
        writer.save(path)
        return {"created": True, "rows": df.count()}

    target = DeltaTable.forPath(spark, path)
    cond = " AND ".join(f"t.`{k}` = s.`{k}`" for k in keys)
    (target.alias("t").merge(df.alias("s"), cond)
     .whenMatchedUpdateAll().whenNotMatchedInsertAll().execute())
    metrics = target.history(1).select("operationMetrics").collect()[0][0] or {}
    return {"created": False, **{k: int(v) for k, v in metrics.items() if v.isdigit()}}
