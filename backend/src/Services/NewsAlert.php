<?php

declare(strict_types=1);

namespace FinSent\Services;

use FinSent\Db;

/**
 * Strongly negative KAP disclosure in the last 20 trading days.
 *
 * Event study (scripts/negative_news_study.py, xAI scores 2021-01 .. 2026-11, abnormal return vs
 * BIST 100, demeaned by same-month neutral disclosures): after a disclosure scored <= -0.7 the
 * stock lagged by -1.6% over the next 20 trading days (n=565, month-clustered t = -2.3, negative
 * in 5 of 6 years). Mild/medium negatives lagged only -0.4% (n=8,436, t = -1.1), so they do not
 * raise the badge.
 */
final class NewsAlert
{
    public const THRESHOLD = -0.7;
    public const WINDOW_TRADING_DAYS = 20;
    public const STUDY = [
        'n' => 565, 'excess_20d' => -0.0159, 'excess_5d' => -0.0088, 't_month_clustered' => -2.27,
        'years_negative' => '5/6', 'mild_excess_20d' => -0.0041, 'mild_t' => -1.14, 'period' => '2021-01 – 2026-11',
    ];

    /** @return array<string,mixed> */
    public static function forSymbol(string $symbol): array
    {
        $since = Db::one('SELECT trade_date FROM market_daily WHERE symbol = ? ORDER BY trade_date DESC LIMIT 1 OFFSET ' . self::WINDOW_TRADING_DAYS,
                         [$symbol]);
        $from = $since['trade_date'] ?? date('Y-m-d', strtotime('-30 days'));
        $rows = Db::all(
            'SELECT d.disclosure_id, d.published_at, d.subject, d.summary, d.url, s.score, s.event_type, s.key_points,
                    COALESCE(e.event_date, DATE(d.published_at)) AS event_date
               FROM disclosures d JOIN v_sentiment s USING (disclosure_id) LEFT JOIN event_returns e USING (disclosure_id)
              WHERE d.symbol = ? AND s.label = "negative" AND s.provider <> "lexicon" AND s.score <= ?
                AND COALESCE(e.event_date, DATE(d.published_at)) > ?
              ORDER BY d.published_at DESC, s.score ASC LIMIT 20',
            [$symbol, self::THRESHOLD, $from]
        );
        // v_sentiment has one row per LLM provider: keep each disclosure once (its most negative score)
        $seen = [];
        $rows = array_slice(array_values(array_filter($rows, function ($r) use (&$seen) {
            if (isset($seen[$r['disclosure_id']])) {
                return false;
            }
            return $seen[$r['disclosure_id']] = true;
        })), 0, 5);
        foreach ($rows as &$r) {
            $r['key_points'] = $r['key_points'] !== null ? json_decode((string) $r['key_points'], true) : [];
            $r['score'] = $r['score'] !== null ? (float) $r['score'] : null;
            $r['trading_days_ago'] = (int) (Db::one('SELECT COUNT(*) AS n FROM market_daily WHERE symbol = ? AND trade_date > ?',
                                                    [$symbol, $r['event_date']])['n'] ?? 0);
        }
        return ['symbol' => $symbol, 'active' => (bool) $rows, 'items' => $rows, 'window_trading_days' => self::WINDOW_TRADING_DAYS,
                'threshold' => self::THRESHOLD, 'study' => self::STUDY];
    }
}
