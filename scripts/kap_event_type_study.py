"""KAP event-type study on the release Parquet files (method: pipeline/finsent/kap_topics.py).

    python scripts/kap_event_type_study.py /path/to/release_dir [out.json]

Production runs the same study from MySQL weekly (`finsent kap-topics`, DAG task `kap_topics`).
"""
import json
import sys

from finsent import kap_topics


def main(d: str, out: str | None = None) -> dict:
    res = kap_topics.study(*kap_topics.load_parquet(d))
    for r in res["rows"]:
        print(f"{r['topic'][:28]:28s} {str(r['label'] or 'hepsi'):9s} n={r['n']:6d}  tepki {r['reaction']:+.4f} (t {r['t_reaction']:+5.1f})"
              f"  5g {r['drift5']:+.4f}  20g {r['drift20']:+.4f} (t {r['t_drift20']:+5.1f}, aynı yön {r['years_same_sign_20']}/{r['years']})"
              f"  -> {r['verdict']}")
    if out:
        with open(out, "w") as f:
            json.dump(res, f, ensure_ascii=False, indent=1)
    return res


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
