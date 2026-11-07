<?php

declare(strict_types=1);

namespace FinSent\Controllers;

use FinSent\Config;
use FinSent\Db;
use FinSent\Http;

final class OverviewController
{
    /** @return array<string,mixed> */
    public static function health(): array
    {
        Db::one('SELECT 1');
        return ['status' => 'ok', 'llm_provider' => Config::llmProvider(),
                'llm' => Config::llmEnabled() ? Config::llmModel() : 'lexicon', 'grok_search' => Config::grokEnabled()];
    }

    /** @return array<string,mixed> */
    public static function overview(): array
    {
        $market = Db::one('SELECT COUNT(*) AS rows_, COUNT(DISTINCT symbol) AS symbols,
                                  MIN(trade_date) AS first_date, MAX(trade_date) AS last_date FROM market_daily');
        $disc = Db::one('SELECT COUNT(*) AS n, MIN(published_at) AS first_at, MAX(published_at) AS last_at,
                                SUM(source = "sample") AS sample_n FROM disclosures');
        $labels = Db::all('SELECT label, COUNT(*) AS n FROM v_sentiment GROUP BY label');
        $providers = Db::all('SELECT provider, model, COUNT(*) AS n FROM disclosure_sentiment GROUP BY provider, model');
        $patterns = Db::all('SELECT direction, COUNT(*) AS n FROM patterns
                             WHERE trade_date = (SELECT MAX(trade_date) FROM patterns) GROUP BY direction');
        // strongest recent company news for listed stocks (newest first, strong scores before weak ones)
        $movers = Db::all(
            'SELECT d.disclosure_id, d.symbol, d.subject, d.summary, d.url, d.published_at, s.label, s.score,
                    s.event_type, s.key_points, e.car_1d, e.car_3d
               FROM disclosures d JOIN v_sentiment s USING (disclosure_id)
               LEFT JOIN event_returns e USING (disclosure_id)
              WHERE s.label <> "neutral" AND ABS(s.score) >= 0.5
                AND d.published_at >= (SELECT DATE_SUB(MAX(published_at), INTERVAL 3 DAY) FROM disclosures)
                AND EXISTS (SELECT 1 FROM market_daily m WHERE m.symbol = d.symbol)
              ORDER BY DATE(d.published_at) DESC, ABS(s.score) DESC LIMIT 12'
        );
        foreach ($movers as &$mv) {
            $mv['key_points'] = $mv['key_points'] !== null ? json_decode((string) $mv['key_points'], true) : [];
        }
        unset($mv);
        return [
            'market' => $market,
            'disclosures' => $disc,
            'labels' => $labels,
            'providers' => $providers,
            'latest_patterns' => $patterns,
            'recent_signals' => $movers,
            'llm' => Config::llmEnabled() ? Config::llmModel() : null,
            'llm_provider' => Config::llmProvider(),
            'grok_search' => Config::grokEnabled(),
        ];
    }

    /** Market dashboard: BIST 100 series, breadth and movers on the latest trading day. */
    public static function market(): array
    {
        $last = Db::one('SELECT MAX(trade_date) AS d FROM market_daily WHERE source <> "instrument"')['d'];
        if ($last === null) {
            return ['as_of' => null];
        }
        $index = Db::all(
            'SELECT trade_date AS d, MAX(bist100) AS v FROM market_daily
              WHERE trade_date > DATE_SUB(?, INTERVAL 400 DAY) AND bist100 IS NOT NULL
              GROUP BY trade_date ORDER BY trade_date', [$last]);
        $breadth = Db::one(
            "SELECT SUM(pct_change > 0) AS up, SUM(pct_change < 0) AS down, SUM(pct_change = 0) AS flat,
                    SUM(volume_try) AS volume
               FROM market_daily WHERE trade_date = ? AND source <> 'instrument'", [$last]);
        // movers among reasonably liquid names (>= 50M TL traded) so penny spikes do not dominate
        $movers = fn(string $dir) => Db::all(
            "SELECT m.symbol, c.title, m.close, m.pct_change, m.volume_try
               FROM market_daily m LEFT JOIN companies c USING (symbol)
              WHERE m.trade_date = ? AND m.volume_try >= 50000000 AND m.pct_change IS NOT NULL AND m.source <> 'instrument'
              ORDER BY m.pct_change $dir LIMIT 6", [$last]);
        $active = Db::all(
            "SELECT m.symbol, c.title, m.close, m.pct_change, m.volume_try
               FROM market_daily m LEFT JOIN companies c USING (symbol)
              WHERE m.trade_date = ? AND m.source <> 'instrument' ORDER BY m.volume_try DESC LIMIT 6", [$last]);
        return ['as_of' => $last, 'index' => $index, 'breadth' => $breadth,
                'gainers' => $movers('DESC'), 'losers' => $movers('ASC'), 'active' => $active];
    }

    /** @return array<string,mixed> */
    public static function pipeline(): array
    {
        $runs = Db::all('SELECT run_id, task, window_start, window_end, status, stats, finished_at
                           FROM pipeline_runs ORDER BY finished_at DESC LIMIT 20');
        $dq = Db::all('SELECT run_id, dataset, window_start, window_end, status, rows_checked, report, created_at
                         FROM dq_reports ORDER BY created_at DESC LIMIT 20');
        foreach ($runs as &$r) {
            $r['stats'] = json_decode((string) $r['stats'], true);
        }
        foreach ($dq as &$d) {
            $rep = json_decode((string) $d['report'], true);
            $d['checks'] = array_map(fn($c) => [
                'name' => $c['name'], 'passed' => $c['passed'], 'severity' => $c['severity'],
                'value' => $c['value'], 'threshold' => $c['threshold'],
            ], $rep['checks'] ?? []);
            unset($d['report']);
        }
        $eval = Db::one('SELECT run_id, experiment, provider, metrics, created_at FROM model_evaluations
                          ORDER BY created_at DESC LIMIT 1');
        if ($eval) {
            $eval['metrics'] = json_decode((string) $eval['metrics'], true);
        }
        return ['runs' => $runs, 'data_quality' => $dq, 'evaluation' => $eval];
    }

    /** Average abnormal return by sentiment label and horizon (event study over the serving DB). */
    public static function eventStudy(): array
    {
        $rows = Db::all(
            'SELECT s.label, COUNT(*) AS n,
                    AVG(e.car_1d) AS car_1d, AVG(e.car_3d) AS car_3d, AVG(e.car_5d) AS car_5d,
                    STDDEV_SAMP(e.car_1d) AS sd_1d, STDDEV_SAMP(e.car_3d) AS sd_3d, STDDEV_SAMP(e.car_5d) AS sd_5d
               FROM event_returns e JOIN v_sentiment s USING (disclosure_id)
              WHERE e.car_1d IS NOT NULL
              GROUP BY s.label ORDER BY FIELD(s.label, "negative", "neutral", "positive")'
        );
        $byType = Db::all(
            'SELECT s.event_type, COUNT(*) AS n, AVG(s.score) AS avg_score, AVG(e.car_3d) AS car_3d
               FROM event_returns e JOIN v_sentiment s USING (disclosure_id)
              WHERE e.car_3d IS NOT NULL GROUP BY s.event_type ORDER BY n DESC'
        );
        return ['by_label' => $rows, 'by_event_type' => $byType];
    }

    /** Detailed news-impact study: event type x sentiment, per year, optional symbol filter. */
    public static function newsImpact(): array
    {
        $where = 'e.car_3d IS NOT NULL';
        $p = [];
        if ($s = Http::query('symbol')) {
            $where .= ' AND d.symbol = ?';
            $p[] = Http::symbol($s);
        }
        $base = "FROM event_returns e JOIN v_sentiment s USING (disclosure_id) JOIN disclosures d USING (disclosure_id) WHERE $where";
        $span = Db::one("SELECT COUNT(*) AS n, MIN(d.published_at) AS f, MAX(d.published_at) AS t, COUNT(DISTINCT d.symbol) AS symbols $base", $p);
        $byLabel = Db::all("SELECT s.label, COUNT(*) AS n, AVG(e.car_1d) AS car_1d, AVG(e.car_3d) AS car_3d, AVG(e.car_5d) AS car_5d,
                                   AVG(e.car_3d > 0) AS pos_share $base GROUP BY s.label", $p);
        $byType = Db::all("SELECT s.event_type, s.label, COUNT(*) AS n, AVG(e.car_1d) AS car_1d, AVG(e.car_3d) AS car_3d,
                                  AVG(e.car_5d) AS car_5d, AVG(e.car_3d > 0) AS pos_share, STDDEV_SAMP(e.car_3d) AS sd_3d
                             $base GROUP BY s.event_type, s.label HAVING n >= 15", $p);
        $byYear = Db::all("SELECT YEAR(d.published_at) AS y, s.label, COUNT(*) AS n, AVG(e.car_3d) AS car_3d $base
                            GROUP BY y, s.label ORDER BY y", $p);
        return ['span' => $span, 'by_label' => $byLabel, 'by_type' => $byType, 'by_year' => $byYear];
    }
}
