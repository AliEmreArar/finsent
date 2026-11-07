"""FinSent lakehouse jobs (bronze -> silver -> gold Delta tables, MLflow evaluation).

The same modules run on Databricks (as job tasks, see ``databricks.yml``) and
locally in the Airflow container (``python -m finsent_lakehouse.run_all``).
"""
