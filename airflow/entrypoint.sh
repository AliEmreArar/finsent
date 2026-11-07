#!/usr/bin/env bash
# Single-container Airflow (scheduler + webserver + triggerer) backed by MySQL.
set -euo pipefail

airflow db migrate
airflow users create --role Admin --username "${AIRFLOW_ADMIN_USER:-admin}" \
  --password "${AIRFLOW_ADMIN_PASSWORD:-admin}" --firstname FinSent --lastname Admin \
  --email admin@example.com >/dev/null 2>&1 || true

exec airflow standalone
