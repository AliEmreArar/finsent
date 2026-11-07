"""Run the whole lakehouse flow in one Spark session (local / Airflow mode).

    python -m finsent_lakehouse.run_all [--skip-eval]
"""
from __future__ import annotations

import argparse
import json
import logging

from . import bronze, evaluate, features, silver
from .spark import LakePaths, get_spark


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-eval", action="store_true")
    ap.add_argument("--only", choices=["bronze", "silver", "gold", "evaluate"])
    args = ap.parse_args()

    spark = get_spark("finsent-lakehouse")
    paths = LakePaths.from_env()
    steps = {"bronze": bronze.run, "silver": silver.run, "gold": features.run, "evaluate": evaluate.run}
    if args.only:
        steps = {args.only: steps[args.only]}
    elif args.skip_eval:
        steps.pop("evaluate")
    out = {name: fn(spark, paths) for name, fn in steps.items()}
    print(json.dumps(out, indent=2, default=str))
    spark.stop()


if __name__ == "__main__":
    main()
