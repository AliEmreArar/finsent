"""Data-quality checks for market data and disclosures.

Each check yields a ``Check`` with a severity. A report fails when any
``error``-severity check fails; Airflow turns that into a task failure so bad
data never reaches the curated layer.

The central market check is *missing observations*: for every symbol that is
active in the window (between its first and last row), each BIST trading day
on which the market traded but the symbol has no row counts as missing. Days
on which (almost) nothing traded are reported as missing market days unless
they are known exchange holidays.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import date

import pandas as pd

# Borsa Istanbul full-day closures (official + religious holidays), 2024-2026.
BIST_HOLIDAYS = {
    date(2021, 1, 1), date(2021, 4, 23), date(2021, 5, 13), date(2021, 5, 14),
    date(2021, 5, 19), date(2021, 7, 15), date(2021, 7, 20), date(2021, 7, 21),
    date(2021, 7, 22), date(2021, 7, 23), date(2021, 8, 30), date(2021, 10, 29),
    date(2022, 5, 2), date(2022, 5, 3), date(2022, 5, 4), date(2022, 5, 19),
    date(2022, 7, 11), date(2022, 7, 12), date(2022, 7, 15), date(2022, 8, 30),
    # 2023-02-08..14: market closed after the Kahramanmaraş earthquakes
    date(2023, 2, 8), date(2023, 2, 9), date(2023, 2, 10), date(2023, 2, 13), date(2023, 2, 14),
    date(2023, 4, 21), date(2023, 5, 1), date(2023, 5, 19), date(2023, 6, 28),
    date(2023, 6, 29), date(2023, 6, 30), date(2023, 8, 30),
    date(2024, 1, 1), date(2024, 4, 10), date(2024, 4, 11), date(2024, 4, 12),
    date(2024, 4, 23), date(2024, 5, 1), date(2024, 6, 17), date(2024, 6, 18),
    date(2024, 6, 19), date(2024, 7, 15), date(2024, 8, 30), date(2024, 10, 29),
    date(2025, 1, 1), date(2025, 3, 31), date(2025, 4, 1), date(2025, 4, 23),
    date(2025, 5, 1), date(2025, 5, 19), date(2025, 6, 6), date(2025, 6, 9),
    date(2025, 7, 15), date(2025, 10, 29),
    date(2026, 1, 1), date(2026, 3, 20), date(2026, 4, 23), date(2026, 5, 1),
    date(2026, 5, 19), date(2026, 5, 27), date(2026, 5, 28), date(2026, 5, 29),
    date(2026, 7, 15), date(2026, 10, 29),
}


@dataclass
class Check:
    name: str
    passed: bool
    severity: str  # "error" | "warn"
    value: float | int | None = None
    threshold: float | int | None = None
    detail: dict = field(default_factory=dict)


@dataclass
class QualityReport:
    dataset: str
    window_start: str
    window_end: str
    rows: int
    checks: list[Check]

    @property
    def status(self) -> str:
        if any(not c.passed and c.severity == "error" for c in self.checks):
            return "fail"
        if any(not c.passed for c in self.checks):
            return "warn"
        return "pass"

    def as_dict(self) -> dict:
        d = asdict(self)
        d["status"] = self.status
        return d


def expected_trading_days(start: date, end: date) -> list[date]:
    days = pd.bdate_range(start, end).date
    return [d for d in days if d not in BIST_HOLIDAYS]


def check_market(df: pd.DataFrame, start: date, end: date, max_missing_ratio: float,
                 min_symbols_per_day: int) -> QualityReport:
    checks: list[Check] = []
    rows = len(df)
    checks.append(Check("non_empty", rows > 0, "error", rows, 1))
    if rows == 0:
        return QualityReport("market", str(start), str(end), 0, checks)

    # 1) market-level missing days
    per_day = df.groupby("trade_date")["symbol"].nunique()
    expected = expected_trading_days(start, end)
    thin_days = [d for d in expected if per_day.get(d, 0) < min_symbols_per_day]
    checks.append(Check(
        "missing_market_days", not thin_days, "error", len(thin_days), 0,
        {"days": [str(d) for d in thin_days[:30]]},
    ))

    # 2) symbol-level missing observations on days the market traded
    traded_days = sorted(d for d in expected if per_day.get(d, 0) >= min_symbols_per_day)
    have = set(zip(df["symbol"], df["trade_date"]))
    span = df.groupby("symbol")["trade_date"].agg(["min", "max"])
    missing: dict[str, list[str]] = {}
    expected_obs = 0
    for sym, (first, last) in span.iterrows():
        days = [d for d in traded_days if first <= d <= last]
        expected_obs += len(days)
        gaps = [str(d) for d in days if (sym, d) not in have]
        if gaps:
            missing[sym] = gaps
    n_missing = sum(len(v) for v in missing.values())
    ratio = n_missing / expected_obs if expected_obs else 0.0
    worst = sorted(missing.items(), key=lambda kv: -len(kv[1]))[:15]
    checks.append(Check(
        "missing_symbol_observations", ratio <= max_missing_ratio, "error",
        round(ratio, 5), max_missing_ratio,
        {"missing": n_missing, "expected": expected_obs,
         "worst_symbols": {k: v[:10] for k, v in worst}},
    ))

    # 3) value checks
    null_close = int(df["close"].isna().sum())
    checks.append(Check("null_close", null_close == 0, "error", null_close, 0))
    non_positive = int((df["close"] <= 0).sum())
    checks.append(Check("non_positive_close", non_positive == 0, "error", non_positive, 0))
    bad_range = df[(df["high"] < df["low"]) |
                   (df["close"] > df["high"] * 1.0001) | (df["close"] < df["low"] * 0.9999)]
    checks.append(Check("ohlc_consistency", len(bad_range) == 0, "warn", len(bad_range), 0,
                        {"sample": bad_range[["symbol", "trade_date"]].astype(str).head(10)
                         .to_dict("records")}))
    jumps = df[df["pct_change"].abs() > 0.25]
    checks.append(Check("abnormal_daily_move_gt_25pct", len(jumps) == 0, "warn", len(jumps), 0,
                        {"sample": jumps[["symbol", "trade_date", "pct_change"]].astype(str)
                         .head(10).to_dict("records")}))
    dupes = int(df.duplicated(["symbol", "trade_date"]).sum())
    checks.append(Check("duplicate_keys", dupes == 0, "error", dupes, 0))
    return QualityReport("market", str(start), str(end), rows, checks)


def check_disclosures(df: pd.DataFrame, start: date, end: date,
                      known_symbols: set[str] | None = None) -> QualityReport:
    checks: list[Check] = []
    rows = len(df)
    checks.append(Check("non_empty", rows > 0, "warn", rows, 1))
    if rows == 0:
        return QualityReport("kap", str(start), str(end), 0, checks)

    for col in ("symbol", "subject", "published_at"):
        n = int((df[col].isna() | (df[col].astype(str).str.strip() == "")).sum())
        checks.append(Check(f"missing_{col}", n == 0, "error", n, 0))
    empty_text = int(((df["summary"].str.len() == 0) & (df["body"].str.len() == 0)).sum())
    checks.append(Check("empty_text", empty_text / rows <= 0.02, "warn", empty_text, int(rows * 0.02)))
    pub = pd.to_datetime(df["published_at"]).dt.date
    out_of_window = int(((pub < start) | (pub > end)).sum())
    checks.append(Check("published_outside_window", out_of_window == 0, "error", out_of_window, 0))
    if known_symbols:
        unknown = sorted(set(df["symbol"]) - known_symbols)
        checks.append(Check("unknown_symbols", not unknown, "warn", len(unknown), 0,
                            {"symbols": unknown[:20]}))
    return QualityReport("kap", str(start), str(end), rows, checks)
