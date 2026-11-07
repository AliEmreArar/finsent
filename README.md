# FinSent: Financial Sentiment & Pattern Analysis Tool

> 📘 **Türkçe eğitim rehberi:** [docs/EGITIM.md](docs/EGITIM.md) explains every technology in the project, what it is for and how it is used, with architecture diagrams.
> 🤝 **Agent handoff:** [AGENT_HANDOFF.md](AGENT_HANDOFF.md) gives the current state, decisions, findings and open tasks.
> ⚠️ Research and education project. Nothing here is investment advice.

FinSent brings Borsa Istanbul market data and KAP (Kamuyu Aydınlatma Platformu) company disclosures into one analysis application. It has four parts:

| Layer | What it does | Where |
|---|---|---|
| **PHP/MySQL backend** | REST API plus a dashboard over market data, disclosures, sentiment, chart patterns and event studies. It also does real-time LLM sentiment for any text and writes LLM interpretations of a symbol's signals. | `backend/` |
| **LLM sentiment & pattern recognition** | xAI Grok (or Claude) with structured outputs scores each KAP disclosure: label, score, confidence, event type and key points. Grok's X and web search tools add per-stock social sentiment and a daily market brief. An offline Turkish finance lexicon is the baseline and the fallback. Rule-based detectors find candlestick, trend, momentum, volatility and volume patterns. | `pipeline/finsent/sentiment`, `pipeline/finsent/patterns.py` |
| **Airflow pipeline → S3** | Loads market data and disclosures into the S3 raw zone. It deduplicates, retries with exponential backoff and runs data-quality gates (including checks for missing observations). It then scores sentiment, detects patterns and loads MySQL. | `airflow/dags`, `pipeline/finsent` |
| **Databricks / PySpark** | Builds Delta bronze → silver → gold tables and sentiment features, runs an event study and a reaction model, and tracks everything in MLflow. It ships as a Databricks Asset Bundle and also runs locally on Spark. | `databricks/` |

```
 Yahoo Finance ─► market_refresh ─► data/market/bist_updates.db ┐
 bist_model_ready.db (1996-2025, read-only) ────────────────────┴─► market.py (auto)
 KAP public API (list + notice text) ─► kap_live.py
                                    ┌──────────────────────── Airflow: finsent_ingest (weekdays 19:30) ──────────┐
                                    │ refresh_market ─► ingest_market ─ dedup ─ DQ gate ─► s3://…/raw/market/     │
                                    │ ingest_kap ── noise filter ─ dedup ─ DQ gate ─ notice text ─► raw/kap/      │
                                    │   score_sentiment (Grok fast model | Claude | lexicon) ─► curated/sentiment │
                                    │   detect_patterns ─► curated/patterns                                      │
                                    │   load_serving_db ─► MySQL ──► PHP API + dashboard (:8080)                 │
                                    │   social_sentiment (Grok x_search) · market_brief (Grok web + X search)    │
                                    └───────────────┬────────────────────────────────────────────────────────────┘
                                                    ▼ trigger
                                    ┌──── Airflow: finsent_lakehouse (local Spark  |  Databricks job) ───────────┐
                                    │ bronze (Delta) ─► silver ─► gold_sentiment_features / gold_event_study     │
                                    │ evaluate ─► MLflow (:5000) + model_evaluations (MySQL)                     │
                                    └────────────────────────────────────────────────────────────────────────────┘
```

## Quick start

Requirements: Docker Desktop with about 6 GB of RAM. The market history at `../bist_model_ready.db` (one level above this folder) is mounted read-only.

```bash
cp .env.example .env              # put XAI_API_KEY (Grok) and/or ANTHROPIC_API_KEY here
docker compose up -d --build
```

| Service | URL |
|---|---|
| Dashboard / API | http://localhost:8080 (API under `/api/...`) |
| Airflow | http://localhost:8081 (`admin` / `admin`) |
| MLflow | http://localhost:5000 |
| MySQL | `localhost:3307`, `finsent` / `finsent` |
| LocalStack S3 | http://localhost:4566, bucket `finsent-lake` |

Run a backfill by triggering the ingestion DAG with a window. It triggers the lakehouse DAG when it finishes:

```bash
docker compose exec airflow airflow dags unpause finsent_ingest
docker compose exec airflow airflow dags unpause finsent_lakehouse
docker compose exec airflow airflow dags trigger finsent_ingest \
  --conf '{"start": "2026-11-02", "end": "2026-11-06"}'
```

The scheduled run (weekdays at 19:30 Istanbul time, after the close) processes the current day: it refreshes prices from Yahoo, pulls that day's KAP disclosures, scores them with Grok, runs the X search for the most active stocks and writes the market brief. Keep backfills to a week or two per run. Each run downloads at most `FINSENT_KAP_MAX_BODIES` notice texts (default 400), spaced `FINSENT_KAP_INTERVAL_S` apart (default 2 s). The Grok search tasks only run when the window ends within the last 3 days.

## Data sources

- **Market history (real, read-only):** the BIST daily history in `../bist_model_ready.db` (1996 → 2025-11-21, 586 symbols, with indicators). FinSent never writes to this file. It has no opening price, so `open` is set to the previous close and flagged `open_is_estimated`. Candlestick detectors then use stricter thresholds and half strength.
- **Market updates (real, Yahoo Finance):** `python -m finsent.market_refresh` (or the DAG's `refresh_market` task) downloads every active symbol plus XU100 and USDTRY from Yahoo with `yfinance`. It starts at the day after the history ends and writes `data/market/bist_updates.db` with the same columns plus a real open. Indicators are computed on the Yahoo series with about 300 days of warm-up. In the default `FINSENT_MARKET_SOURCE=auto` mode, the pipeline serves the history up to 2025-11-21 and the updates after it; the seam is continuous. Market-cap columns are not available from Yahoo. Symbols that were delisted in the meantime are reported as missing (for example KOZAA and KOZAL).
- **Intraday quote:** `GET /api/quote/{symbol}` uses Yahoo's chart API (BIST data is about 15 minutes delayed, cached for 60 s). The symbol page shows it with an intraday chart.
- **KAP disclosures (real):** with `FINSENT_KAP_MODE=live`, `kap_live.py` calls the same public endpoints www.kap.org.tr's own UI uses. It makes one list request per weekday (`POST /tr/api/disclosure/members/byCriteria`, memberType `IGS`). Mechanical notices are dropped (circuit breakers, debt-instrument notices, company info forms, BISTECH announcements). A notice naming several stocks becomes one row per stock. For new, price-relevant notices (special situations, new business, M&A, buybacks, capital increases, dividends, ratings, lawsuits…), the full text is read from `/tr/Bildirim/{index}`. Requests are throttled, retried and sent with an honest User-Agent (`FINSENT_KAP_USER_AGENT`). Respect KAP's terms of use.
- **KAP history:** `python -m finsent.cli backfill-kap --start 2021-01-01 --end 2026-10-02 --scorer lexicon` pulls past disclosures newest-first, in two-week windows of list data only, with 4 s between requests. It scores them and loads them into MySQL. It is safe to stop and re-run: dedup skips what is already stored, and windows that hit KAP's rate limit are simply retried on the next run. Rescoring the history with Grok (`--scorer xai`) costs about $0.0005 per disclosure.
- **Sample mode (`FINSENT_KAP_MODE=sample`):** `scripts/generate_kap_sample.py` writes about 1,450 synthetic disclosures flagged `source="sample"`, for offline development. `python -m finsent.cli reset-disclosures --source sample --yes` removes them again.

## LLM integration

The provider is picked by `FINSENT_LLM_PROVIDER` (`auto` → Anthropic if `ANTHROPIC_API_KEY` is set, else xAI if `XAI_API_KEY` is set, else the lexicon).

**xAI Grok** (`pipeline/finsent/sentiment/grok.py`, `backend/src/Services/GrokClient.php`):

| Task | Model (env) | API |
|---|---|---|
| Bulk KAP disclosure scoring (pipeline) | `XAI_FAST_MODEL` = `grok-4.20-0309-non-reasoning` (~$0.0005/notice) | `/v1/chat/completions` + strict `json_schema` |
| Live analysis, symbol insight | `XAI_MODEL` = `grok-4.7` | `/v1/chat/completions` + strict `json_schema` |
| Social sentiment per stock (X posts) | `XAI_MODEL` | `/v1/responses` + `x_search` tool (date window) + `text.format` JSON schema; cited posts come back as `url_citation` annotations (~$0.10–0.15 per stock) |
| Daily market brief | `XAI_MODEL` | `/v1/responses` + `web_search` + `x_search` |

- The DAG runs social sentiment for `FINSENT_SOCIAL_SYMBOLS`, or for the `FINSENT_SOCIAL_TOP_N` (default 10) stocks with the most disclosures in the past week, topped up with the most traded names. The dashboard's **Grok ile X'te ara** button runs it on demand; results are cached for the day in `social_sentiment`.
- Symbol insights also see the latest X sentiment.

**Anthropic Claude** (`llm.py`, `ClaudeClient.php`): the official SDKs, structured outputs, `effort: low` and server-side refusal fallbacks. Used when `ANTHROPIC_API_KEY` is set.

**Fallbacks:** if there is no key, the API errors or the model refuses, every path falls back to the lexicon (`finsent/resources/lexicon_tr.json`). Python and PHP implement the same algorithm on the same file and agree on all 80 labelled examples. Insights fall back to a rule-based summary. The MLflow classifier benchmark compares the lexicon with every configured LLM model on the labelled set.

## Direction forecasts (v2)

`pipeline/finsent/forecast.py` (DAG task `direction_forecast`, or `python -m finsent.forecast [--predict-only]`) gives each stock three numbers for **1, 5 and 20 trading days**:

- **P(up):** probability of a positive absolute return.
- **P(beat BIST 100):** probability of beating the index.
- **Rank:** today's position among all stocks.

**How it works**

- **Model:** a gradient-boosted classifier per target and horizon, on about 40 features plus their daily cross-sectional percentiles. Features cover momentum and reversal at several lengths, volatility, liquidity, size, beta and residual momentum, distance to highs and averages, RSI/MACD/Bollinger, and the market regime including USD/TRY.
- **Calibration:** isotonic, fitted on the year before the model is used.
- **Training data:** all BIST stocks since 2008, roughly 1.5M stock-days.
- **Retraining:** weekly, in about 10 minutes. Models are saved to `data/models/forecast_v2.joblib`; other days reuse them.
- **Analogs:** nearest past days of the same stock are shown for context only. Their backtest showed no out-of-sample skill.

**How it was chosen**

16 variants were compared with walk-forward evaluation over 2022–2026. The study is in [`docs/forecast_research.md`](docs/forecast_research.md) and in MLflow under `finsent-forecast-research`. Each production run also logs a last-365-days holdout to MLflow (`finsent-forecast`).

Holdout on the last year (never trained on):

| | 1 day | 5 days | 20 days |
|---|---|---|---|
| Absolute AUC (v1 → v2) | 0.527 → 0.541 | 0.515 → 0.536 | 0.514 → 0.524 |
| Beat-index AUC | 0.548 | 0.543 | 0.551 |
| Daily rank IC | 0.10 | 0.09 | 0.10 |
| Top decile beat the index | 52 % | 47 % | 41 % |
| Bottom decile beat the index | 38 % | 35 % | 32 % |

**Reading the results:** ranking stocks against each other works consistently. Predicting the absolute direction of a single stock stays close to a coin flip, and the UI says so.

## Grok agent (right-hand panel)

Click **Asistan** (or press Ctrl+K) to open a chat with a Grok agent. The agent knows what you are looking at: the page, stock, candle size and currency.

How it works:

- **Server-side loop:** `backend/src/Controllers/AgentController.php` runs the loop on the xAI Responses API, at most 8 steps.
- **Streaming:** `POST /api/agent` streams NDJSON, and the panel shows each tool call live.
- **Tool calls:** Grok can call several tools in parallel. It can also use its own `web_search` and `x_search`.

| Tool | What it does |
|---|---|
| `get_price_history` | OHLCV for any interval (15m … monthly) and TL/USD, with a summary |
| `get_technical_indicators` | RSI with its recent path, MACD, SMA 50/200, Bollinger bands, returns, 52-week range, volume vs. average |
| `find_support_resistance` | Swing-point levels clustered within 1.5 %, with touch counts |
| `get_patterns` / `get_kap_disclosures` / `get_social_sentiment` / `get_forecast` | Stored signals, KAP news with reactions, X sentiment, model forecast with its reliability |
| `news_impact_study` | Historical average reaction to KAP news, by sentiment and event type, optionally per stock |
| `compare_stocks` | Correlation, beta, relative performance and spread z-score |
| `screen_stocks` | Filters on RSI, the 200-day average, daily change, volume, a pattern or the forecast rank |
| `backtest_strategy` | SMA cross, RSI mean reversion or breakout on one stock vs. buy-and-hold, with costs |
| `market_overview` | Index, breadth, movers and the AI brief |
| `chart_actions` | Draws on your chart: support/resistance/target lines, date markers, interval/range/currency changes. Opens the stock first if needed. |
| `create_alert` / `list_alerts` / `delete_alert` | "THYAO 310'u geçerse haber ver" |

Extras:

- **Chart screenshot:** the 📷 button attaches a screenshot of the chart to your next message, and Grok reads it visually (vision input).
- **Alerts:** these are price, RSI or daily-change thresholds (table `alerts`). The bell in the top bar lists them. While the dashboard is open, it checks them every minute against Yahoo's delayed quote, then shows a toast and a browser notification when one fires.
- **Model:** set with `XAI_AGENT_MODEL` (default `XAI_MODEL`, `grok-4.7`). Typical answers take 10–20 s.

## Gold, FX and the index

`python -m finsent.instruments` (DAG task `refresh_instruments`) loads the full Yahoo daily history of these instruments into `market_daily` with `source = 'instrument'`:

| Symbol | Instrument |
|---|---|
| `XAUUSD` | Ounce gold (GC=F), from 2000 |
| `XAGUSD` | Ounce silver |
| `USDTRY`, `EURTRY` | FX rates |
| `XU100` | BIST 100 index |
| `ALTIN`, `GUMUS` | Gram gold / silver in TL, derived as ounce × USD/TRY ÷ 31.1035 |

How they behave in the app:

- **Charts:** every chart feature works on them. Gold trades round the clock, so its 4-hour candles are true 4-hour blocks.
- **Intraday:** gram gold's intraday price and quote are derived from the ounce and USD/TRY on matching timestamps.
- **Currency:** ounce prices default to USD.
- **Excluded from equity-only views:** screens, breadth and movers.
- **Gold analysis card:** on the gold pages (`/api/gold-analysis`). It shows returns over 1 month to 10 years for gram gold, ounce, USD, EUR, BIST 100, BIST in gold and BIST in USD. It also shows BIST 100 priced in grams of gold over time, the gold/silver ratio, and 1-year correlations and volatility.
- **Market tiles:** the market page shows tiles with 3-month sparklines.

### Gold forecast (`finsent.gold_forecast`)

A separate model for ounce gold (`XAUUSD`) and gram gold (`ALTIN`). It uses gold's own price action plus macro drivers from Yahoo: DXY, US 10-year yield, VIX, oil, S&P 500, copper, the gold/silver ratio and USD/TRY.

What the walk-forward study (each year 2012–2026 tested on a model trained only on earlier data) found:

| Question | Result |
|---|---|
| Can the *direction* be predicted (1/5/20 days)? | **No.** Logistic regression, gradient boosting and their average all score AUC 0.48–0.53, and accuracy is below "always up". |
| Does a timing rule beat buy-and-hold (P(up) > 0.5, price > 50/200-day average, 3/12-month momentum, DXY < 200-day average)? | **No.** Some cut drawdowns, but all lost more return than they saved. |
| Can the *range* be predicted? | **Yes.** The 90% bands covered 88–90% of outcomes and the 68% bands 65–70%. |

So production forecasts **price ranges**, not arrows:

- A log-volatility regression (5/20/60-day realised volatility + VIX) predicts the next month's volatility.
- Empirical quantiles of volatility-scaled returns from the last 10 years turn that into p05/p16/p50/p84/p95 prices for 1, 5 and 20 days. These quantiles carry gram gold's drift and its fat tails.

The `forecasts` row (payload `gold-v1`) also carries:

- the expected volatility and its 5-year percentile;
- a macro driver table;
- the trend-rule backtests;
- the direction study.

The gold page shows it as the "Sırada ne olabilir?" card. Its "1 aylık aralığı grafikte göster" button draws the bands on the chart. The agent's `get_forecast` tool returns the same data and is told not to make gold direction calls.

The DAG task `gold_forecast` runs after `refresh_instruments`: it refits daily and re-runs the walk-forward study weekly (results go to `data/models/gold_study.json` and the MLflow experiment `finsent-gold-forecast`). To run it by hand, use `python -m finsent.gold_forecast --research`; the research scratch script is `scripts/gold_lab.py`.

## Chart drawing tools

The toolbar above the price chart provides these tools:

- **Seç:** click a drawing, then press Delete to remove it.
- **Trend:** two clicks; the line is extended to the right.
- **Yatay çizgi:** one click.
- **Kanal:** two clicks for the base line, a third click for the parallel side. The channel is shaded and its midline is shown.
- **Fibonacci:** levels at 0 / 23.6 / 38.2 / 50 / 61.8 / 78.6 / 100 %.
- **Dikdörtgen**
- **Temizle**

Esc cancels a drawing, and holding Shift keeps the tool armed for several drawings.

How drawings are stored and shown:

- **Anchors:** each point is stored as a time and a price. Drawings therefore stay put when you zoom or switch between 15-minute and monthly candles.
- **Currency:** drawings are kept per currency.
- **Storage:** they are saved per symbol (`drawings` table, `GET/POST /api/drawings/{symbol}`).

**The agent sees them.** Every question carries a numeric summary of the visible drawings in its context:

- a trend line's value today, its slope, and the price's distance to it;
- a channel's upper and lower band today, its width, and where the price sits inside it;
- Fibonacci level prices;
- box bounds.

The agent can also fetch them with `get_user_drawings` and draw trend lines, channels and Fibonacci levels itself (`chart_actions`). The 📷 screenshot includes the drawings.

## Pair analysis (e.g. PGSUS vs THYAO)

The dashboard page **Çift** (`#/cift/PGSUS/THYAO`, API `GET /api/pair/{a}/{b}`) shows any two stocks with:

- rebased prices;
- rolling 60-day correlation;
- the z-score of the log-price spread.

For PGSUS/THYAO it also shows the stored study, produced by `scripts/pairs_analysis.py` and `scripts/pairs_backtest.py`:

- **Correlation:** 0.74 daily, 0.73 hourly, 0.72 at 15 minutes.
- **No lead-lag at daily or hourly bars.** Granger test p ≥ 0.18 at both.
- **No cointegration.** A daily market-neutral pairs trade made +2.4 %/yr out-of-sample. A long-only "switch to the cheaper one" strategy made less than simply holding THYAO.
- **5-minute "PGSUS catches up with THYAO":** a real but small gross edge, +0.17 % per trade versus +0.01 % for random entries, with 98 % of parameter sets positive out-of-sample. Break-even is about 8 bp per side, so it loses money at normal brokerage costs. Only 5 weeks of 5-minute history exist.

`finsent.intraday` (DAG task `collect_intraday`) now stores 1/5/15-minute bars every day in `data/market/intraday.db`. Re-run the backtest after a few months to get a meaningful sample.

## Data quality and dedup

`pipeline/finsent/quality.py` produces a report for every run. It is stored in S3 under `quality/` and in MySQL in `dq_reports`, and the dashboard shows it. `error` checks fail the Airflow task before anything is written to the raw zone:

- **Missing market days:** an expected BIST trading day (weekday, not in the holiday calendar) with fewer than `FINSENT_DQ_MIN_SYMBOLS` symbols.
- **Missing symbol observations:** for each symbol active in the window, trading days with no row. The task fails when the ratio exceeds `FINSENT_DQ_MAX_MISSING_RATIO` (5%).
- Null or non-positive closes and duplicate keys (errors). OHLC consistency and daily moves above 25% (warnings). On real data these warnings flag things like the −86% SILVR print on 2025-09-26.
- For disclosures: missing fields, records published outside the window, empty text and unknown symbols.

Dedup works at two levels:

- **Market rows:** keyed by (symbol, trade_date). Each day is a single overwritten S3 object, so reruns are idempotent.
- **Disclosures:** checked by `disclosure_id` and by a SHA-256 hash of the normalized content, which catches re-publications under a new index. The index of seen records persists in `state/kap_dedup_index.json`. MySQL enforces `UNIQUE(content_hash)`, and the Delta tables use MERGE.

Retries: every task gets 3 retries with exponential backoff (up to 30 minutes), the Anthropic SDK retries on its own, and the KAP client backs off on 429 and 5xx responses.

## Lakehouse (Databricks / PySpark)

| Table | Contents |
|---|---|
| `bronze_market`, `bronze_disclosures`, `bronze_sentiment` | Raw zone as Delta, plus `_ingested_at` and `_source_file` |
| `silver_market` | Returns, abnormal returns versus BIST100, event-window targets `event_car_{1,3,5}d`, `pre_car_5d` |
| `silver_disclosures` | Disclosure + preferred score (LLM over lexicon) + `event_date`, the first trading day the market could react; after 18:00 that is the next day |
| `gold_sentiment_features` | Per (symbol, day): counts, mean/min/max/confidence-weighted sentiment, trailing 30-day sentiment, event-type counts, technical context from the day before the event (avoids leaking into the target), targets |
| `gold_event_study` | One row per disclosure with sentiment and its CARs |

`evaluate.py` logs three nested MLflow runs:

1. `classifier_benchmark_*`: accuracy, macro-F1, per-class precision and recall, a confusion matrix and the misclassified rows. It scores the lexicon, and Claude when a key is set, on a hand-labelled set of 80 Turkish disclosure sentences (`resources/labeled_headlines_tr.jsonl`).
2. `event_study`: mean CAR for each label and horizon, positive-minus-negative spread, Welch t-statistic, sign hit rate and Spearman IC.
3. `reaction_model`: logistic regression predicting `event_car_3d > 0`, with a chronological 70/30 split. It logs AUC, accuracy, coefficients and the model.

On Databricks:

```bash
cd databricks
databricks bundle deploy -t dev --var instance_profile_arn=arn:aws:iam::...:instance-profile/finsent
databricks bundle run finsent_lakehouse -t dev
```

To have Airflow trigger it, set `FINSENT_SPARK_TARGET=databricks` and `FINSENT_DATABRICKS_JOB_ID`, and add a `databricks_default` connection.

## Using without Airflow

```bash
python -m venv .venv && .venv/Scripts/pip install -e "pipeline[test]"
.venv/Scripts/python -m pytest pipeline                       # unit + moto-S3 tests
.venv/Scripts/python -m finsent.cli analyze "Şirketimiz 50 milyon USD tutarında ihale kazanmıştır."
.venv/Scripts/python -m finsent.cli patterns --symbol ASELS --start 2025-09-01 --end 2025-11-21
```

## API

| Method & path | Description |
|---|---|
| `GET /api/health` | DB status and active LLM |
| `GET /api/overview` | KPIs, label distribution, recent directional disclosures |
| `GET /api/symbols?q=` | Symbols with last close and disclosure sentiment |
| `GET /api/quote/{symbol}` | Delayed intraday quote from Yahoo Finance |
| `GET /api/forecast/{symbol}` | Direction forecast: probabilities, analog paths and model reliability |
| `GET /api/market-summary` | BIST 100 series, breadth and movers on the latest day |
| `GET /api/social` / `GET /api/social/{symbol}` | Latest X sentiment per stock / history for one stock |
| `POST /api/social/{symbol}?days=3&web=0&force=0` | Run a Grok X search now (cached per day) |
| `GET /api/brief` | Latest daily market brief |
| `GET /api/market/{symbol}?range=…&interval=15m\|1h\|4h\|1d\|1w\|1mo&currency=TRY\|USD` | Candles (daily history since 1996; intraday from Yahoo: ~3 years hourly, ~60 days 15-minute), KAP markers, headline stats |
| `GET /api/pair/{a}/{b}?range=1y\|3y\|5y\|all` | Two-stock comparison and stored pair research |
| `GET /api/disclosures?symbol&label&event_type&from&to&q&limit&offset` | Disclosures with sentiment and CARs |
| `GET /api/disclosures/{id}` | One disclosure with all provider scores |
| `GET /api/sentiment/{symbol}/daily` | Daily sentiment aggregate |
| `GET /api/patterns?symbol&date&from&to&direction&pattern&min_strength` | Detected patterns |
| `GET /api/event-study` | Mean CAR by label and by event type |
| `GET /api/pipeline` | Pipeline runs, DQ reports and the latest MLflow evaluation |
| `POST /api/analyze` `{text, symbol?}` | Real-time sentiment |
| `POST /api/insights/{symbol}` | LLM (or rule-based) interpretation of patterns and disclosures |

## Layout

```
finsent/
├── backend/            PHP 8.3 app (public/index.php, src/, sql/schema.sql, Dockerfile)
├── pipeline/           Python package `finsent` (+ tests/)
├── airflow/            Airflow image + DAGs (finsent_ingest, finsent_lakehouse)
├── databricks/         PySpark/Delta/MLflow jobs + Databricks Asset Bundle
├── scripts/            sample-data generator
├── data/samples/       generated sample disclosures
└── docker-compose.yml
```

Nothing in this project is investment advice.
