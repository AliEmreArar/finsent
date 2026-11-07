# Direction forecast: research notes (v1 → v2)

Every experiment is logged in MLflow under the experiment **`finsent-forecast-research`** at http://localhost:5000. The harness lives in `scripts/forecast_lab.py`.

## Set-up

- **Data:** BIST daily bars, 2004 → 2026-11-06, 635 symbols, about 2.0M stock-days. The bars come from the original history plus Yahoo updates.
- **Walk-forward evaluation:** four yearly test folds: 2022, 2023, 2024 and 2025–26. Each fold trains only on data before the fold (from 2008). The gap between training and test is 1.5 × horizon, so no training target overlaps the test year. Training rows are thinned to every third day per stock to reduce overlapping targets.
- **Corporate actions:** stock-days within 60 days after, or 20 days before, a move of more than 25 % (splits and bonus issues in the unadjusted history) are excluded.
- **Metrics** (averaged over the four folds):
  - **AUC**
  - **Brier skill vs. climatology** (BSS): above 0 means better than always predicting the training base rate.
  - **Daily rank IC:** Spearman correlation between predictions and realised returns across stocks, each day.
  - **Top − bottom decile spread** of realised returns.
  - **Top/bottom-decile hit rate**
  - **Calibration gap:** weighted |predicted − realised| over probability bins.

## Results

AUC / rank IC by horizon (1 / 5 / 20 trading days):

| # | Variant | AUC | Rank IC | Notes |
|---|---|---|---|---|
| E0 | v1 features, absolute target | .522 / .552 / .560 | .054 / .080 / .080 | the 20-day AUC is driven by one fold (2023: .646) |
| E2 | + extended features | .547 / .533 / .535 | .093 / .092 / .101 | |
| E5 | + cross-sectional ranks | .557 / .548 / .537 | .105 / .104 / .101 | |
| E7 | E5, regularised | .559 / .546 / .533 | .095 / .096 / .107 | BSS > 0 at 1 and 5 days |
| **E8** | **E7 + isotonic calibration** | **.554 / .560 / .565** | .088 / .094 / .103 | **chosen: absolute** |
| E12 | E8 with a bigger model | .550 / .549 / .550 | .101 / .100 / .100 | worse, 3× slower |
| E13 | E8 + time-decay weights | .562 / .538 / .567 | .095 / .096 / .099 | inconsistent |
| E1 | v1 features, beat-index target | .523 / .524 / .547 | .068 / .077 / .083 | |
| E4 | extended + cs, beat-index | .549 / .538 / .537 | .115 / .107 / .100 | |
| **E9** | **E4 regularised + isotonic** | .541 / .541 / .538 | **.109 / .101 / .094** | **chosen: beat-index**; calibration gap 2–3 pp |
| E14 | E9 with a bigger model | .541 / .543 / .531 | .113 / .106 / .091 | within noise, 3× slower |
| E15 | E9 + time-decay weights | .542 / .533 / .528 | .109 / .099 / .088 | no gain |
| E6/E10 | liquid stocks only | ≈ E4/E9 | ≈ | widest 20-day spread (4.7 %) |

The chosen models in plain terms (E9, 5-day horizon): of the stocks the model puts in its top 10 % on a given day, **51 %** beat BIST 100 over the next week. Of those it puts in the bottom 10 %, **37 %** did. The unconditional rate is 44 %.

## The analog method has no skill

The v1 production forecast leaned 70–85 % on "nearest past days of the same stock". We backtested it without look-ahead: 3,600 random liquid stock-days in 2022–2026, with analogs searched only in history that had ended before each point.

| Horizon | Analog AUC | Stock's own base-rate AUC |
|---|---|---|
| 1 day | 0.514 | 0.508 |
| 5 days | 0.497 | 0.510 |
| 20 days | 0.519 | 0.521 |
| 20 days, beat-index | 0.522 | – |

Analogs are no better than the stock's long-run up-rate. In v2 they are shown as context only and never enter the probabilities.

## Decisions (v2)

1. Use the extended features (momentum and short-term reversal at several lengths, liquidity, size, beta and residual momentum, market regime, USD/TRY) plus their daily cross-sectional percentiles.
2. Predict two targets: absolute up/down, and beating BIST 100. Beating the index is far better calibrated, because market-wide direction shifts from year to year and no model here forecasts it.
3. Use a regularised gradient-boosted model (200 iterations, 15 leaves, at least 3,000 samples per leaf, L2 = 5). Calibrate it with isotonic regression fitted on the year that precedes its use.
4. Production evaluates on a last-365-days holdout every run and logs it to the MLflow experiment `finsent-forecast`. The UI shows these holdout numbers.
5. Show each stock's rank among all stocks today. This is the most reliable output (rank IC ≈ 0.10, t > 18 in every fold).

## Honest limits

- Absolute direction stays close to a coin flip: AUC 0.55–0.57, and calibration is off by 4–8 pp depending on the market regime.
- Part of the 1-day effect is short-term reversal in closing prices (bid/ask bounce, price limits). Not all of it can be traded.
- KAP sentiment was tested as a model feature once the 2021–2026 history was loaded (see below). It does not help, so it is not in the production model. X sentiment is still untested because it has no history.

## KAP news: A/B test and event study (2026-11-08)

The KAP history from 2021-01 to 2026-11 is now loaded: about 252 k disclosures, all scored by Grok.

### A/B test

`scripts/forecast_news_lab.py` compares two models on the same walk-forward folds (2023, 2024, 2025–26; both trained from 2021):

- **BASE:** the production feature set.
- **BASE + NEWS:** the same set plus nine per-stock news features. These are counts, positive and negative shares, and mean sentiment over 5 and 20 days, plus days since the last disclosure and since the last negative one. They are aligned to the information day: a notice published after 18:00 counts for the next session.

| Target | h | AUC base → +news | Rank IC base → +news |
|---|---|---|---|
| absolute | 1 / 5 / 20 | .537 / .536 / .547 → .537 / .537 / .546 | .072 / .075 / .091 → .071 / .075 / .090 |
| beat index | 1 / 5 / 20 | .521 / .508 / .523 → .522 / .508 / .523 | .063 / .070 / .090 → .064 / .071 / .090 |

All differences are within ±0.001, with mixed signs. **Decision: news features are not added.**

### Event study

`scripts/news_event_study.py` measures the excess return over BIST 100 per stock-day event, with the label taken from mean Grok score at a threshold of ±0.15. Each row covers one label (or strong subgroup) and three windows:

- **Day 0:** the information day itself.
- **Days 1–5:** the post-event drift over the next 5 trading days.
- **Days 1–20:** the post-event drift over the next 20 trading days.

| Label | Events | Day 0 | Days 1–5 | Days 1–20 |
|---|---|---|---|---|
| positive | 33,292 | **+0.43 %** (t = 21) | −0.09 % (t = −2.0) | −0.10 % (t = −1.1) |
| strong positive (score ≥ 0.6) | 3,857 | **+0.96 %** (t = 15) | −0.22 % (t = −1.5) | – |
| neutral | 66,387 | −0.03 % | −0.06 % | +0.11 % |
| negative | 8,687 | −0.04 % (t = −1.0) | **−0.24 %** (t = −2.4) | **−0.53 %** (t = −2.7) |

How to read this:

- **Good news is priced on the same day.** Nothing tradable is left after the disclosure is read.
- **Bad news is absorbed slowly.** This is the known under-reaction to negative news. The effect is real but small (about 0.5 % over a month), and it affects only about 4 % of stock-days with news. That is why it does not lift a model that ranks every stock every day.
- **What it is good for:** a warning flag on the stock page ("recent negative disclosure: historically −0.5 % vs the index over the next month"), not a model feature.
