<?php

declare(strict_types=1);

namespace FinSent\Controllers;

use FinSent\Db;
use FinSent\Http;
use FinSent\HttpError;

/** Two-stock comparison: rebased prices, rolling correlation, spread z-score and stored research. */
final class PairController
{
    private const WIN = 60;

    /** @return array<string,mixed> */
    public static function show(string $a, string $b): array
    {
        $a = Http::symbol($a);
        $b = Http::symbol($b);
        if ($a === $b) {
            throw new HttpError(400, 'iki farklı hisse seçin');
        }
        $ranges = ['1y' => '-1 year', '3y' => '-3 years', '5y' => '-5 years', 'all' => '-40 years'];
        $range = Http::query('range', '3y');
        if (!isset($ranges[$range])) {
            throw new HttpError(400, 'range: 1y|3y|5y|all');
        }
        $to = Db::one('SELECT MAX(trade_date) AS d FROM market_daily WHERE symbol = ?', [$a])['d'];
        if (!$to) {
            throw new HttpError(404, "$a için veri yok");
        }
        $from = (new \DateTimeImmutable($to))->modify($ranges[$range])->format('Y-m-d');
        // extra history so the rolling windows are defined from the first charted day
        $warm = (new \DateTimeImmutable($from))->modify('-140 days')->format('Y-m-d');
        $rows = Db::all(
            'SELECT x.trade_date, x.close AS ca, y.close AS cb FROM market_daily x
               JOIN market_daily y ON y.trade_date = x.trade_date AND y.symbol = ?
              WHERE x.symbol = ? AND x.trade_date BETWEEN ? AND ? ORDER BY x.trade_date', [$b, $a, $warm, $to]);
        if (count($rows) < self::WIN + 5) {
            throw new HttpError(404, 'ortak işlem günü yetersiz');
        }
        $n = count($rows);
        $la = $lb = $ra = $rb = [];
        foreach ($rows as $i => $r) {
            $la[$i] = log((float) $r['ca']);
            $lb[$i] = log((float) $r['cb']);
            $ra[$i] = $i ? $la[$i] - $la[$i - 1] : null;
            $rb[$i] = $i ? $lb[$i] - $lb[$i - 1] : null;
        }
        $out = ['dates' => [], 'a' => [], 'b' => [], 'corr' => [], 'z' => []];
        $baseA = $baseB = null;
        $spreads = [];
        for ($i = 0; $i < $n; $i++) {
            $corr = $z = null;
            if ($i > self::WIN) {
                $xs = array_slice($rb, $i - self::WIN + 1, self::WIN);
                $ys = array_slice($ra, $i - self::WIN + 1, self::WIN);
                [$corr, $beta] = self::corrBeta($ys, $xs);
                $spreads[$i] = $la[$i] - $beta * $lb[$i];
                $window = array_filter(array_slice($spreads, -self::WIN, self::WIN, true), fn($k) => $k > $i - self::WIN, ARRAY_FILTER_USE_KEY);
                if (count($window) >= 20) {
                    $m = array_sum($window) / count($window);
                    $sd = sqrt(array_sum(array_map(fn($v) => ($v - $m) ** 2, $window)) / (count($window) - 1));
                    $z = $sd > 0 ? ($spreads[$i] - $m) / $sd : null;
                }
            }
            if ($rows[$i]['trade_date'] < $from) {
                continue;
            }
            $baseA ??= (float) $rows[$i]['ca'];
            $baseB ??= (float) $rows[$i]['cb'];
            $out['dates'][] = $rows[$i]['trade_date'];
            $out['a'][] = round((float) $rows[$i]['ca'] / $baseA * 100, 3);
            $out['b'][] = round((float) $rows[$i]['cb'] / $baseB * 100, 3);
            $out['corr'][] = $corr !== null ? round($corr, 4) : null;
            $out['z'][] = $z !== null ? round($z, 3) : null;
        }
        $all = array_values(array_filter(array_map(null, $ra, $rb), fn($p) => $p[0] !== null && $p[1] !== null));
        [$fullCorr, $fullBeta] = self::corrBeta(array_column($all, 0), array_column($all, 1));
        $research = Db::one('SELECT payload, updated_at FROM research_results WHERE rkey = ?', ["pairs:$a:$b"]);
        return [
            'a' => $a, 'b' => $b, 'range' => $range, 'window' => self::WIN, 'series' => $out,
            'summary' => ['corr' => $fullCorr, 'beta' => $fullBeta, 'days' => count($all),
                          'last_z' => end($out['z']) ?: null, 'last_corr' => end($out['corr']) ?: null],
            'research' => $research ? json_decode((string) $research['payload'], true) + ['updated_at' => $research['updated_at']] : null,
        ];
    }

    /** Pearson correlation and OLS slope of y on x. @return array{0: ?float, 1: float} */
    private static function corrBeta(array $y, array $x): array
    {
        $n = count($x);
        if ($n < 3) {
            return [null, 1.0];
        }
        $mx = array_sum($x) / $n;
        $my = array_sum($y) / $n;
        $sxy = $sxx = $syy = 0.0;
        for ($i = 0; $i < $n; $i++) {
            $dx = $x[$i] - $mx;
            $dy = $y[$i] - $my;
            $sxy += $dx * $dy;
            $sxx += $dx * $dx;
            $syy += $dy * $dy;
        }
        return [$sxx > 0 && $syy > 0 ? $sxy / sqrt($sxx * $syy) : null, $sxx > 0 ? $sxy / $sxx : 1.0];
    }
}
