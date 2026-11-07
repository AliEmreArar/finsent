"""FinSent lakehouse DAG: bronze -> silver -> gold Delta tables -> MLflow evaluation.

``FINSENT_SPARK_TARGET=local`` (default) runs the PySpark jobs inside this
container against S3/LocalStack. ``FINSENT_SPARK_TARGET=databricks`` triggers
the ``finsent-lakehouse`` job deployed by the asset bundle in ``databricks/``
(needs a ``databricks_default`` Airflow connection and FINSENT_DATABRICKS_JOB_ID).
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta

import pendulum
from airflow import DAG
from airflow.operators.bash import BashOperator

TARGET = os.environ.get("FINSENT_SPARK_TARGET", "local")

with DAG(
    dag_id="finsent_lakehouse",
    description="Delta bronze/silver/gold + MLflow evaluation (local Spark or Databricks)",
    schedule=None,  # triggered by finsent_ingest
    start_date=datetime(2025, 1, 1, tzinfo=pendulum.timezone("Europe/Istanbul")),
    catchup=False,
    max_active_runs=1,
    default_args={"owner": "finsent", "retries": 2, "retry_delay": timedelta(minutes=3),
                  "execution_timeout": timedelta(hours=2)},
    tags=["finsent", "spark", "mlflow"],
) as dag:
    if TARGET == "databricks":
        from airflow.providers.databricks.operators.databricks import DatabricksRunNowOperator

        DatabricksRunNowOperator(
            task_id="databricks_lakehouse_job",
            job_id=int(os.environ["FINSENT_DATABRICKS_JOB_ID"]),
            databricks_conn_id="databricks_default",
        )
    else:
        steps = []
        for step in ("bronze", "silver", "gold", "evaluate"):
            steps.append(BashOperator(
                task_id=f"spark_{step}",
                bash_command=f"python -m finsent_lakehouse.run_all --only {step}",
                retries=0 if step == "evaluate" else 2,
            ))
        for upstream, downstream in zip(steps, steps[1:]):
            upstream >> downstream
