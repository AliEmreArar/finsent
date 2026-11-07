<?php

declare(strict_types=1);

namespace FinSent\Controllers;

use FinSent\Db;

/** Gold, silver, FX and index tiles plus a gold-centred cross-asset analysis. */
final class InstrumentController
{
    private const TILES = ['ALTIN' => 'Gram altın', 'XAUUSD' => 'Ons altın', 'GUMUS' => 'Gram gümüş', 'USDTRY' => 'Dolar/TL', 'EURTRY' => 'Euro/TL'];

    /** Last price, changes and a 3-month sparkline for each instrument. @return list<array<string,mixed>> */
    public static function tiles(): array
    {
        $out = [];
        foreach (self::TILES as $sym => $name) {
            $rows = Db::all('SELECT trade_date, close FROM market_daily WHERE symbol = ? ORDER BY trade_date DESC LIMIT 260', [$sym]);
            if (!$rows) {
                continue;
            }
            $c = array_map(fn($r) => (float) $r['close'], $rows);
            $chg = fn(int $k) => isset($c[$k]) && $c[$k] > 0 ? $c[0] / $c[$k] - 1 : null;
            $out[] = ['symbol' => $sym, 'name' => $name, 'as_of' => $rows[0]['trade_date'], 'close' => $c[0],
                      'change_1d' => $chg(1), 'change_1m' => $chg(21), 'change_1y' => $chg(min(250, count($c) - 1)),
                      'spark' => array_reverse(array_slice($c, 0, 63)), 'usd_quoted' => in_array($sym, MarketController::USD_QUOTED, true)];
        }
        return $out;
    }

    /** Aligned daily closes for several symbols (only days where all exist). @return array<string, array<string,float>> */
    private static function closes(array $symbols, string $from): array
    {
        $in = implode(',', array_fill(0, count($symbols), '?'));
        $rows = Db::all("SELECT symbol, trade_date, close FROM market_daily WHERE symbol IN ($in) AND trade_date >= ? ORDER BY trade_date",
                        [...$symbols, $from]);
        $by = [];
        foreach ($rows as $r) {
            $by[$r['trade_date']][$r['symbol']] = (float) $r['close'];
        }
        return array_filter($by, fn($d) => count($d) === count($symbols));
    }

    /** @return array<string,mixed> */
    public static function goldAnalysis(): array
    {
        $syms = ['ALTIN', 'XAUUSD', 'USDTRY', 'EURTRY', 'XU100', 'GUMUS', 'XAGUSD'];
        $all = self::closes($syms, '2005-01-01');
        $dates = array_keys($all);
        $last = end($dates);
        $at = function (string $date) use ($all, $dates): ?array {   // last row on or before $date
            $best = null;
            foreach ($dates as $d) {
                if ($d > $date) break;
                $best = $d;
            }
            return $best ? $all[$best] : null;
        };
        $periods = ['1 ay' => '-1 month', '3 ay' => '-3 months', '1 yıl' => '-1 year', '3 yıl' => '-3 years', '5 yıl' => '-5 years', '10 yıl' => '-10 years'];
        $now = $all[$last];
        $table = [];
        foreach ($periods as $label => $mod) {
            $then = $at((new \DateTimeImmutable($last))->modify($mod)->format('Y-m-d'));
            if (!$then) continue;
            $r = fn(string $s) => $now[$s] / $then[$s] - 1;
            $table[] = ['period' => $label, 'ALTIN' => $r('ALTIN'), 'XAUUSD' => $r('XAUUSD'), 'USDTRY' => $r('USDTRY'),
                        'EURTRY' => $r('EURTRY'), 'XU100' => $r('XU100'),
                        'XU100_in_gold' => ($now['XU100'] / $now['ALTIN']) / ($then['XU100'] / $then['ALTIN']) - 1,
                        'XU100_in_usd' => ($now['XU100'] / $now['USDTRY']) / ($then['XU100'] / $then['USDTRY']) - 1];
        }
        // weekly series for long-horizon ratio charts
        $weekly = [];
        foreach ($all as $d => $v) {
            $weekly[(new \DateTimeImmutable($d))->format('o-W')] = [$d, $v];
        }
        $series = ['dates' => [], 'xu100_grams' => [], 'gold_silver' => [], 'gram_gold' => []];
        foreach ($weekly as [$d, $v]) {
            $series['dates'][] = $d;
            $series['xu100_grams'][] = round($v['XU100'] / $v['ALTIN'], 3);   // BIST 100 priced in grams of gold
            $series['gold_silver'][] = round($v['XAUUSD'] / $v['XAGUSD'], 2);
            $series['gram_gold'][] = round($v['ALTIN'], 2);
        }
        // 1-year daily return correlations
        $yr = array_slice($all, -252, null, true);
        $ret = [];
        $prev = null;
        foreach ($yr as $v) {
            if ($prev) {
                foreach ($syms as $s) {
                    $ret[$s][] = $v[$s] / $prev[$s] - 1;
                }
            }
            $prev = $v;
        }
        $corr = function (array $x, array $y): float {
            $n = count($x); $mx = array_sum($x) / $n; $my = array_sum($y) / $n;
            $sxy = $sxx = $syy = 0.0;
            for ($i = 0; $i < $n; $i++) { $sxy += ($x[$i] - $mx) * ($y[$i] - $my); $sxx += ($x[$i] - $mx) ** 2; $syy += ($y[$i] - $my) ** 2; }
            return $sxx && $syy ? $sxy / sqrt($sxx * $syy) : 0.0;
        };
        $vol = fn(array $x) => sqrt(array_sum(array_map(fn($r) => $r * $r, $x)) / count($x) * 252);
        return [
            'as_of' => $last, 'now' => $now,
            'decomposition' => ['gram_gold_change_1y' => $table[2]['ALTIN'] ?? null,
                                'from_ounce' => $table[2]['XAUUSD'] ?? null, 'from_usdtry' => $table[2]['USDTRY'] ?? null],
            'returns' => $table,
            'correlations_1y' => ['ALTIN~USDTRY' => $corr($ret['ALTIN'], $ret['USDTRY']), 'ALTIN~XU100' => $corr($ret['ALTIN'], $ret['XU100']),
                                  'XAUUSD~XU100' => $corr($ret['XAUUSD'], $ret['XU100']), 'XAUUSD~XAGUSD' => $corr($ret['XAUUSD'], $ret['XAGUSD'])],
            'volatility_1y' => ['ALTIN' => $vol($ret['ALTIN']), 'XAUUSD' => $vol($ret['XAUUSD']), 'XU100' => $vol($ret['XU100']), 'USDTRY' => $vol($ret['USDTRY'])],
            'series' => $series,
        ];
    }
}
