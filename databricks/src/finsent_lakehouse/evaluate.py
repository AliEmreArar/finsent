"""Evaluation tracked in MLflow.

Three runs per invocation, grouped under one parent run:

1. ``classifier_benchmark`` - sentiment classifiers (lexicon baseline, and
   Claude when credentials exist) on the hand-labelled Turkish headline set:
   accuracy, macro-F1, per-class precision/recall, confusion matrix.
2. ``event_study`` - do sentiment labels line up with the market's reaction?
   Mean abnormal return per label, long-short spread, Welch t-stat, sign hit
   rate and Spearman information coefficient for 1/3/5-day horizons.
3. ``reaction_model`` - logistic regression on gold features predicting a
   positive 3-day abnormal return, with a chronological train/test split.

A JSON summary is written to the lake and, when MYSQL_HOST is set, to the
``model_evaluations`` table that the dashboard reads.
"""
from __future__ import annotations

import json
import logging
import math
import os
import tempfile
from pathlib import Path

import mlflow
import numpy as np
import pandas as pd

from .spark import LakePaths, get_spark, on_databricks

log = logging.getLogger(__name__)
LABELS = ["negative", "neutral", "positive"]


def _experiment() -> str:
    name = os.environ.get("FINSENT_MLFLOW_EXPERIMENT", "finsent-sentiment-eval")
    if on_databricks() and not name.startswith("/"):
        name = f"/Shared/{name}"
    mlflow.set_experiment(name)
    return name


def classification_metrics(y_true: list[str], y_pred: list[str]) -> tuple[dict, pd.DataFrame]:
    t, p = np.array(y_true), np.array(y_pred)
    cm = pd.DataFrame(0, index=LABELS, columns=LABELS)
    for a, b in zip(t, p):
        cm.loc[a, b] += 1
    metrics = {"accuracy": float((t == p).mean()), "n": int(len(t))}
    f1s = []
    for lab in LABELS:
        tp = int(((t == lab) & (p == lab)).sum())
        prec = tp / max(int((p == lab).sum()), 1)
        rec = tp / max(int((t == lab).sum()), 1)
        f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
        metrics.update({f"precision_{lab}": prec, f"recall_{lab}": rec, f"f1_{lab}": f1})
        f1s.append(f1)
    metrics["macro_f1"] = float(np.mean(f1s))
    return metrics, cm


def welch_t(a: pd.Series, b: pd.Series) -> float:
    a, b = a.dropna(), b.dropna()
    if len(a) < 2 or len(b) < 2:
        return float("nan")
    se = math.sqrt(a.var(ddof=1) / len(a) + b.var(ddof=1) / len(b))
    return float((a.mean() - b.mean()) / se) if se else float("nan")


def _log_df(df: pd.DataFrame, name: str) -> None:
    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / name
        df.to_csv(path, index=True)
        mlflow.log_artifact(str(path))


def run_classifier_benchmark(summary: dict) -> None:
    from finsent.config import get_settings
    from finsent.sentiment import LexiconAnalyzer

    settings = get_settings()
    rows = [json.loads(l) for l in settings.labeled_eval_path.read_text(encoding="utf-8").splitlines()
            if l.strip()]
    texts, gold = [r["text"] for r in rows], [r["label"] for r in rows]

    analyzers = [("lexicon", LexiconAnalyzer(settings.lexicon_path))]
    if os.environ.get("ANTHROPIC_API_KEY"):
        from finsent.sentiment.llm import ClaudeAnalyzer
        analyzers.append(("anthropic", ClaudeAnalyzer(settings.llm_model, settings.llm_effort,
                                                      fallback=None, max_workers=settings.llm_max_workers)))
    if os.environ.get("XAI_API_KEY"):
        from finsent.sentiment.grok import GrokAnalyzer
        # benchmark both the bulk-scoring model and the flagship model
        for model in dict.fromkeys([settings.xai_fast_model, settings.xai_model]):
            analyzers.append((f"xai:{model}", GrokAnalyzer(model, fallback=None,
                                                           max_workers=settings.llm_max_workers)))

    for name, analyzer in analyzers:
        safe = name.replace(":", "_").replace("/", "_")
        with mlflow.start_run(run_name=f"classifier_benchmark_{safe}", nested=True):
            if hasattr(analyzer, "analyze_many"):
                preds = [r.label for r in analyzer.analyze_many([{"text": t} for t in texts])]
                model = analyzer.model
            else:
                preds = [analyzer.analyze(t).label for t in texts]
                model = f"lexicon-tr-{analyzer.version}"
            metrics, cm = classification_metrics(gold, preds)
            mlflow.log_params({"provider": name.split(":")[0], "model": model, "dataset": settings.labeled_eval_path.name,
                               "n_examples": len(rows)})
            mlflow.log_metrics({k: v for k, v in metrics.items() if k != "n"})
            _log_df(cm, f"confusion_matrix_{safe}.csv")
            errors = pd.DataFrame({"text": texts, "gold": gold, "pred": preds})
            _log_df(errors[errors.gold != errors.pred], f"misclassified_{safe}.csv")
            summary.setdefault("classifier", {})[name] = {
                "model": model, "accuracy": metrics["accuracy"], "macro_f1": metrics["macro_f1"]}


def run_event_study(ev: pd.DataFrame, summary: dict) -> None:
    with mlflow.start_run(run_name="event_study", nested=True):
        providers = ev["provider"].value_counts().to_dict()
        mlflow.log_params({"n_events": len(ev), "providers": json.dumps(providers),
                           "sample_data": bool((ev["model"].str.startswith("lexicon")).all()),
                           "window_start": str(ev["event_date"].min()),
                           "window_end": str(ev["event_date"].max())})
        result = {}
        table = []
        for h in (1, 3, 5):
            col = f"event_car_{h}d"
            d = ev.dropna(subset=[col])
            if d.empty:
                continue
            by = d.groupby("label")[col].agg(["mean", "count"])
            pos = d.loc[d.label == "positive", col]
            neg = d.loc[d.label == "negative", col]
            directional = d[d.label != "neutral"]
            hit = float((np.sign(directional["score"]) == np.sign(directional[col])).mean()) \
                if len(directional) else float("nan")
            ic = float(d["score"].corr(d[col], method="spearman")) if len(d) > 2 else float("nan")
            m = {f"car{h}d_mean_positive": float(pos.mean()) if len(pos) else float("nan"),
                 f"car{h}d_mean_negative": float(neg.mean()) if len(neg) else float("nan"),
                 f"car{h}d_spread_pos_minus_neg": float(pos.mean() - neg.mean()) if len(pos) and len(neg) else float("nan"),
                 f"car{h}d_welch_t": welch_t(pos, neg),
                 f"car{h}d_hit_rate": hit,
                 f"car{h}d_spearman_ic": ic}
            mlflow.log_metrics({k: v for k, v in m.items() if not math.isnan(v)})
            result.update(m)
            for lab, r in by.iterrows():
                table.append({"horizon_days": h, "label": lab, "mean_car": r["mean"], "n": int(r["count"])})
        tdf = pd.DataFrame(table)
        if not tdf.empty:
            _log_df(tdf.set_index(["horizon_days", "label"]), "car_by_label.csv")
            by_type = ev.dropna(subset=["event_car_3d"]).groupby("event_type")["event_car_3d"] \
                .agg(["mean", "count"]).sort_values("count", ascending=False)
            _log_df(by_type, "car3d_by_event_type.csv")
        summary["event_study"] = {k: (None if isinstance(v, float) and math.isnan(v) else v)
                                  for k, v in result.items()}
        summary["event_study"]["n_events"] = int(len(ev))


def run_reaction_model(feat: pd.DataFrame, summary: dict) -> None:
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import accuracy_score, roc_auc_score
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    cols = ["sent_mean", "sent_min", "sent_max", "sent_conf_weighted", "n_disclosures", "n_positive",
            "n_negative", "sent_mean_prior_30d", "rsi_14", "macd_hist", "bb_position", "pre_car_5d"]
    cols += [c for c in feat.columns if c.startswith("n_evt_")]
    d = feat.dropna(subset=["event_car_3d"]).sort_values("event_date").copy()
    d[cols] = d[cols].astype(float).fillna(0.0)
    y = (d["event_car_3d"] > 0).astype(int)
    if len(d) < 100 or y.nunique() < 2:
        log.warning("reaction_model skipped: %d rows", len(d))
        return
    split = int(len(d) * 0.7)
    X_tr, X_te, y_tr, y_te = d[cols][:split], d[cols][split:], y[:split], y[split:]
    with mlflow.start_run(run_name="reaction_model", nested=True):
        model = make_pipeline(StandardScaler(), LogisticRegression(max_iter=1000, C=0.5))
        model.fit(X_tr, y_tr)
        proba = model.predict_proba(X_te)[:, 1]
        m = {"test_auc": float(roc_auc_score(y_te, proba)) if y_te.nunique() > 1 else float("nan"),
             "test_accuracy": float(accuracy_score(y_te, proba > 0.5)),
             "test_base_rate": float(y_te.mean()), "n_train": len(X_tr), "n_test": len(X_te)}
        mlflow.log_params({"model": "logistic_regression", "C": 0.5, "target": "event_car_3d>0",
                           "split": "chronological_70_30", "features": ",".join(cols)})
        mlflow.log_metrics({k: v for k, v in m.items() if not (isinstance(v, float) and math.isnan(v))})
        coefs = pd.Series(model[-1].coef_[0], index=cols).sort_values()
        _log_df(coefs.to_frame("coef"), "coefficients.csv")
        mlflow.sklearn.log_model(model, artifact_path="model", input_example=X_te.head(3))
        summary["reaction_model"] = m


def _publish_summary(summary: dict, paths: LakePaths, parent_run_id: str, experiment: str) -> None:
    try:
        from finsent.config import get_settings
        from finsent.storage import Lake
        Lake(get_settings()).put_json("curated/evaluations/latest.json", summary)
    except Exception as e:  # noqa: BLE001
        log.warning("could not write summary to lake: %s", e)
    if os.environ.get("MYSQL_HOST"):
        import pymysql
        conn = pymysql.connect(host=os.environ["MYSQL_HOST"], port=int(os.environ.get("MYSQL_PORT", 3306)),
                               user=os.environ.get("MYSQL_USER", "finsent"),
                               password=os.environ.get("MYSQL_PASSWORD", "finsent"),
                               database=os.environ.get("MYSQL_DATABASE", "finsent"), charset="utf8mb4")
        with conn, conn.cursor() as cur:
            llms = [k for k in summary.get("classifier", {}) if k != "lexicon"]
            provider = llms[0].split(":")[0] if llms else "lexicon"
            cur.execute("REPLACE INTO model_evaluations (run_id, experiment, provider, metrics) "
                        "VALUES (%s,%s,%s,%s)", (parent_run_id, experiment, provider,
                                                 json.dumps(summary, default=str)))
            conn.commit()


def run(spark=None, paths: LakePaths | None = None) -> dict:
    spark = spark or get_spark("finsent-evaluate")
    paths = paths or LakePaths.from_env()
    experiment = _experiment()
    ev = spark.read.format("delta").load(paths.delta("gold_event_study")).toPandas()
    feat = spark.read.format("delta").load(paths.delta("gold_sentiment_features")).toPandas()

    summary: dict = {}
    with mlflow.start_run(run_name="finsent_evaluation") as parent:
        mlflow.set_tags({"pipeline": "finsent", "stage": "evaluation"})
        run_classifier_benchmark(summary)
        if not ev.empty:
            run_event_study(ev, summary)
        if not feat.empty:
            run_reaction_model(feat, summary)
        mlflow.log_dict(summary, "summary.json")
        summary["mlflow_run_id"] = parent.info.run_id
    _publish_summary(summary, paths, summary["mlflow_run_id"], experiment)
    return summary


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print(json.dumps(run(), indent=2, default=str))
