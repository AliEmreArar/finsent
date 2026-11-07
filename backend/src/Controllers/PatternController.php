<?php

declare(strict_types=1);

namespace FinSent\Controllers;

use FinSent\Db;
use FinSent\Http;
use FinSent\HttpError;

final class PatternController
{
    /** @return array<string,mixed> */
    public static function list(): array
    {
        $where = [];
        $params = [];
        if ($s = Http::query('symbol')) {
            $where[] = 'p.symbol = ?';
            $params[] = Http::symbol($s);
        }
        if ($dir = Http::query('direction')) {
            if (!in_array($dir, ['bullish', 'bearish', 'neutral'], true)) {
                throw new HttpError(400, 'direction must be bullish|bearish|neutral');
            }
            $where[] = 'p.direction = ?';
            $params[] = $dir;
        }
        if ($pat = Http::query('pattern')) {
            $where[] = 'p.pattern = ?';
            $params[] = $pat;
        }
        $date = Http::dateQuery('date');
        $from = Http::dateQuery('from');
        $to = Http::dateQuery('to');
        if ($date) {
            $where[] = 'p.trade_date = ?';
            $params[] = $date;
        } elseif ($from || $to) {
            $where[] = 'p.trade_date BETWEEN ? AND ?';
            $params[] = $from ?? '1900-01-01';
            $params[] = $to ?? '2999-12-31';
        } elseif (!Http::query('symbol')) {
            $where[] = 'p.trade_date = (SELECT MAX(trade_date) FROM patterns)';
        }
        $minStrength = (float) (Http::query('min_strength') ?? 0);
        $where[] = 'p.strength >= ?';
        $params[] = $minStrength;
        $limit = Http::intQuery('limit', 200, 1, 2000);
        $rows = Db::all(
            'SELECT p.symbol, p.trade_date, p.pattern, p.category, p.direction, p.strength, p.detail, m.close, m.pct_change
               FROM patterns p LEFT JOIN market_daily m ON m.symbol = p.symbol AND m.trade_date = p.trade_date
              WHERE ' . implode(' AND ', $where) . "
              ORDER BY p.trade_date DESC, p.strength DESC LIMIT $limit",
            $params
        );
        foreach ($rows as &$r) {
            $r['detail'] = json_decode((string) $r['detail'], true);
        }
        $summary = Db::all('SELECT pattern, direction, COUNT(*) AS n FROM patterns p WHERE '
            . implode(' AND ', $where) . ' GROUP BY pattern, direction ORDER BY n DESC', $params);
        return ['items' => $rows, 'summary' => $summary];
    }
}
