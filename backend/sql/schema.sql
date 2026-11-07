-- FinSent serving schema (MySQL 8). Loaded automatically by the mysql container on first start.
SET NAMES utf8mb4;

CREATE DATABASE IF NOT EXISTS finsent CHARACTER SET utf8mb4 COLLATE utf8mb4_turkish_ci;
CREATE DATABASE IF NOT EXISTS airflow CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON finsent.* TO 'finsent'@'%';
GRANT ALL PRIVILEGES ON airflow.* TO 'finsent'@'%';
FLUSH PRIVILEGES;

USE finsent;

CREATE TABLE IF NOT EXISTS companies (
    symbol        VARCHAR(12)  NOT NULL PRIMARY KEY,
    title         VARCHAR(255) NULL,
    updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS market_daily (
    symbol            VARCHAR(12) NOT NULL,
    trade_date        DATE        NOT NULL,
    open              DECIMAL(18,4) NULL,
    high              DECIMAL(18,4) NULL,
    low               DECIMAL(18,4) NULL,
    close             DECIMAL(18,4) NOT NULL,
    volume_try        DOUBLE NULL,
    market_cap_try    DOUBLE NULL,
    bist100           DECIMAL(18,4) NULL,
    usd_try           DECIMAL(12,4) NULL,
    pct_change        DOUBLE NULL,
    rsi_14            DOUBLE NULL,
    macd              DOUBLE NULL,
    macd_signal       DOUBLE NULL,
    macd_hist         DOUBLE NULL,
    sma_50            DOUBLE NULL,
    sma_200           DOUBLE NULL,
    bb_lower          DOUBLE NULL,
    bb_mid            DOUBLE NULL,
    bb_upper          DOUBLE NULL,
    open_is_estimated TINYINT(1) NOT NULL DEFAULT 0,
    source            VARCHAR(16) NOT NULL,
    PRIMARY KEY (symbol, trade_date),
    KEY idx_market_date (trade_date)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS disclosures (
    disclosure_id     VARCHAR(40)  NOT NULL PRIMARY KEY,
    disclosure_index  BIGINT       NOT NULL,
    symbol            VARCHAR(12)  NOT NULL,
    company_title     VARCHAR(255) NULL,
    published_at      DATETIME     NOT NULL,
    disclosure_class  VARCHAR(16)  NULL,
    subject           VARCHAR(255) NOT NULL,
    summary           TEXT         NULL,
    body              MEDIUMTEXT   NULL,
    url               VARCHAR(255) NULL,
    source            VARCHAR(16)  NOT NULL,
    content_hash      CHAR(64)     NOT NULL,
    UNIQUE KEY uq_content_hash (content_hash),
    KEY idx_disc_symbol_time (symbol, published_at),
    KEY idx_disc_time (published_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS disclosure_sentiment (
    disclosure_id  VARCHAR(40)  NOT NULL,
    provider       VARCHAR(16)  NOT NULL,
    model          VARCHAR(64)  NOT NULL,
    label          ENUM('positive','negative','neutral') NOT NULL,
    score          DOUBLE       NOT NULL,
    confidence     DOUBLE       NOT NULL,
    event_type     VARCHAR(32)  NOT NULL,
    key_points     JSON         NULL,
    rationale      TEXT         NULL,
    scored_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (disclosure_id, provider),
    KEY idx_sent_label (label),
    CONSTRAINT fk_sent_disc FOREIGN KEY (disclosure_id) REFERENCES disclosures (disclosure_id)
        ON DELETE CASCADE
) ENGINE=InnoDB;

-- One score per disclosure: an LLM score (anthropic / xai) when present, otherwise the lexicon baseline.
CREATE OR REPLACE VIEW v_sentiment AS
SELECT s.* FROM disclosure_sentiment s
WHERE s.provider <> 'lexicon'
   OR NOT EXISTS (SELECT 1 FROM disclosure_sentiment a
                  WHERE a.disclosure_id = s.disclosure_id AND a.provider <> 'lexicon');

CREATE TABLE IF NOT EXISTS event_returns (
    disclosure_id  VARCHAR(40) NOT NULL PRIMARY KEY,
    symbol         VARCHAR(12) NOT NULL,
    event_date     DATE        NULL,
    ret_1d DOUBLE NULL, ret_3d DOUBLE NULL, ret_5d DOUBLE NULL,
    car_1d DOUBLE NULL, car_3d DOUBLE NULL, car_5d DOUBLE NULL,
    pre_car_5d DOUBLE NULL,
    CONSTRAINT fk_evt_disc FOREIGN KEY (disclosure_id) REFERENCES disclosures (disclosure_id)
        ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS patterns (
    symbol      VARCHAR(12) NOT NULL,
    trade_date  DATE        NOT NULL,
    pattern     VARCHAR(40) NOT NULL,
    category    VARCHAR(16) NOT NULL,
    direction   ENUM('bullish','bearish','neutral') NOT NULL,
    strength    DOUBLE      NOT NULL,
    detail      JSON        NULL,
    PRIMARY KEY (symbol, trade_date, pattern, direction),
    KEY idx_pat_date (trade_date)
) ENGINE=InnoDB;

-- LLM interpretations requested from the UI are cached here (keyed by symbol + day + inputs hash).
CREATE TABLE IF NOT EXISTS llm_insights (
    id           BIGINT AUTO_INCREMENT PRIMARY KEY,
    symbol       VARCHAR(12) NOT NULL,
    as_of        DATE        NOT NULL,
    input_hash   CHAR(64)    NOT NULL,
    provider     VARCHAR(16) NOT NULL,
    model        VARCHAR(64) NOT NULL,
    payload      JSON        NOT NULL,
    created_at   TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_insight (symbol, as_of, input_hash)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS pipeline_runs (
    run_id       VARCHAR(80) NOT NULL,
    task         VARCHAR(64) NOT NULL,
    window_start DATE        NOT NULL,
    window_end   DATE        NOT NULL,
    status       VARCHAR(16) NOT NULL,
    stats        JSON        NULL,
    finished_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (run_id, task)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS dq_reports (
    run_id       VARCHAR(80) NOT NULL,
    dataset      VARCHAR(16) NOT NULL,
    window_start DATE        NOT NULL,
    window_end   DATE        NOT NULL,
    status       ENUM('pass','warn','fail') NOT NULL,
    rows_checked INT         NOT NULL,
    report       JSON        NOT NULL,
    created_at   TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (run_id, dataset)
) ENGINE=InnoDB;

-- Model evaluation summaries exported from the Databricks/MLflow workflow.
CREATE TABLE IF NOT EXISTS model_evaluations (
    run_id       VARCHAR(64) NOT NULL PRIMARY KEY,
    experiment   VARCHAR(128) NOT NULL,
    provider     VARCHAR(16) NOT NULL,
    metrics      JSON        NOT NULL,
    created_at   TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Social (X / web) sentiment per symbol from Grok's search tools.
CREATE TABLE IF NOT EXISTS social_sentiment (
    symbol         VARCHAR(12) NOT NULL,
    as_of          DATE        NOT NULL,
    window_start   DATE        NOT NULL,
    window_end     DATE        NOT NULL,
    label          VARCHAR(10) NOT NULL,
    score          DOUBLE      NOT NULL,
    bullish_share  DOUBLE      NULL,
    bearish_share  DOUBLE      NULL,
    post_volume    VARCHAR(8)  NULL,
    summary        TEXT        NULL,
    themes         JSON        NULL,
    notable_posts  JSON        NULL,
    citations      JSON        NULL,
    provider       VARCHAR(16) NOT NULL,
    model          VARCHAR(64) NOT NULL,
    posts_fetched  INT         NULL,
    cost_usd       DOUBLE      NULL,
    created_at     TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, as_of),
    KEY idx_social_date (as_of)
) ENGINE=InnoDB;

-- Daily market brief (Grok web + X search).
CREATE TABLE IF NOT EXISTS market_briefs (
    as_of       DATE        NOT NULL PRIMARY KEY,
    mood        VARCHAR(10) NOT NULL,
    summary     TEXT        NOT NULL,
    payload     JSON        NOT NULL,
    model       VARCHAR(64) NOT NULL,
    cost_usd    DOUBLE      NULL,
    created_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Direction forecasts per symbol (analogs + gradient-boosted model), written by finsent.forecast.
CREATE TABLE IF NOT EXISTS forecasts (
    symbol      VARCHAR(12) NOT NULL,
    as_of       DATE        NOT NULL,
    payload     JSON        NOT NULL,
    created_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, as_of)
) ENGINE=InnoDB;

-- Research outputs shown in the dashboard (e.g. pairs:PGSUS:THYAO from scripts/pairs_backtest.py).
CREATE TABLE IF NOT EXISTS research_results (
    rkey        VARCHAR(64) NOT NULL PRIMARY KEY,
    payload     JSON        NOT NULL,
    updated_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Price / indicator alerts created from the UI or by the agent; checked while the app is open.
CREATE TABLE IF NOT EXISTS alerts (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    symbol          VARCHAR(12) NOT NULL,
    kind            ENUM('price_above','price_below','rsi_above','rsi_below','change_above','change_below') NOT NULL,
    value           DOUBLE      NOT NULL,
    note            VARCHAR(255) NULL,
    active          TINYINT(1)  NOT NULL DEFAULT 1,
    created_at      TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    triggered_at    TIMESTAMP   NULL,
    triggered_value DOUBLE      NULL,
    seen            TINYINT(1)  NOT NULL DEFAULT 0,
    KEY idx_alert_active (active)
) ENGINE=InnoDB;

-- Chart drawings per symbol (user and agent): trend lines, channels, Fibonacci, rectangles.
CREATE TABLE IF NOT EXISTS drawings (
    symbol      VARCHAR(12) NOT NULL PRIMARY KEY,
    payload     JSON        NOT NULL,
    updated_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;
