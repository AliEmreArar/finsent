<?php

declare(strict_types=1);

namespace FinSent\Services;

use FinSent\Controllers\AlertController;
use FinSent\Controllers\DrawingController;
use FinSent\Controllers\MarketController;
use FinSent\Controllers\PairController;
use FinSent\Db;
use FinSent\HttpError;

/**
 * Function tools the Grok agent can call. Each tool returns a compact, JSON-serialisable
 * array (numbers rounded, long series trimmed) so tool results stay cheap in context.
 */
final class AgentTools
{
    /** Tool declarations for the xAI Responses API. */
    public static function definitions(): array
    {
        $sym = ['type' => 'string', 'description' => 'BIST ticker without .IS, e.g. THYAO'];
        $fn = fn(string $name, string $desc, array $props, array $req = []) => [
            'type' => 'function', 'name' => $name, 'description' => $desc,
            'parameters' => ['type' => 'object', 'properties' => (object) $props, 'required' => $req],
        ];
        return [
            $fn('get_price_history', 'OHLCV candles for a stock plus a summary (change, high/low with dates, volatility). Use for any question about price action, trend or levels.', [
                'symbol' => $sym,
                'interval' => ['type' => 'string', 'enum' => MarketController::INTERVALS, 'description' => 'candle size; intraday history: ~3y hourly/4h, ~60d 15m'],
                'range' => ['type' => 'string', 'enum' => array_keys(MarketController::RANGES), 'description' => 'window for 1d/1w/1mo'],
                'currency' => ['type' => 'string', 'enum' => ['TRY', 'USD']],
                'max_bars' => ['type' => 'integer', 'description' => 'most recent bars to return (default 120, max 400)'],
            ], ['symbol']),
            $fn('get_technical_indicators', 'Latest technical snapshot: RSI(14) with recent path, MACD, SMA50/200, Bollinger bands, returns over 1w/1m/3m/1y, 52-week range, volume vs average.', ['symbol' => $sym], ['symbol']),
            $fn('find_support_resistance', 'Support and resistance levels from swing highs/lows with how many times each was touched.', [
                'symbol' => $sym, 'lookback_days' => ['type' => 'integer', 'description' => 'default 180'],
            ], ['symbol']),
            $fn('get_patterns', 'Detected chart patterns (candlesticks, MA crosses, RSI extremes, Bollinger breakouts, volume spikes).', [
                'symbol' => $sym, 'days' => ['type' => 'integer', 'description' => 'look back, default 30'],
            ], ['symbol']),
            $fn('get_kap_disclosures', 'Company disclosures from KAP with AI sentiment and the stock\'s abnormal return after each one.', [
                'symbol' => $sym, 'days' => ['type' => 'integer', 'description' => 'default 90'],
                'only_important' => ['type' => 'boolean', 'description' => 'only positive/negative ones'],
            ], ['symbol']),
            $fn('news_impact_study', 'Historical average stock reaction (vs BIST 100) after KAP disclosures, grouped by sentiment and event type. Optionally for one stock or one event type.', [
                'symbol' => ['type' => 'string'], 'event_type' => ['type' => 'string', 'description' => 'e.g. new_business, dividend, buyback, legal, financial_report'],
            ]),
            $fn('get_forecast', 'Model forecast: probabilities of rising and of beating BIST 100 over 1/5/20 days, today\'s rank among all stocks, and the model\'s measured out-of-sample reliability. For ALTIN / XAUUSD it returns the gold model instead: calibrated price ranges (p05/p16/p50/p84/p95) for 1/5/20 days, expected volatility, macro driver table, trend-rule backtests and the direction study (gold direction is NOT predictable, AUC ~0.50: say so and talk in ranges, never make a gold direction call).', ['symbol' => $sym], ['symbol']),
            $fn('get_social_sentiment', 'Latest stored X (Twitter) sentiment summary for a stock.', ['symbol' => $sym], ['symbol']),
            $fn('compare_stocks', 'Compare two stocks: return correlation, beta, relative performance and the current spread z-score.', [
                'a' => $sym, 'b' => $sym, 'range' => ['type' => 'string', 'enum' => ['1y', '3y', '5y', 'all']],
            ], ['a', 'b']),
            $fn('screen_stocks', 'Screen all BIST stocks on the latest day. Combine any filters.', [
                'rsi_below' => ['type' => 'number'], 'rsi_above' => ['type' => 'number'],
                'above_sma200' => ['type' => 'boolean'], 'below_sma200' => ['type' => 'boolean'],
                'min_change_pct' => ['type' => 'number', 'description' => 'daily change in %, e.g. 3'],
                'max_change_pct' => ['type' => 'number'],
                'min_volume_try' => ['type' => 'number', 'description' => 'daily traded value in TL, default 20,000,000'],
                'pattern' => ['type' => 'string', 'description' => 'e.g. golden_cross, rsi_oversold, volume_spike, bullish_engulfing'],
                'sort' => ['type' => 'string', 'enum' => ['change', 'volume', 'rsi', 'forecast']],
                'limit' => ['type' => 'integer'],
            ]),
            $fn('backtest_strategy', 'Backtest a simple long/flat daily strategy on one stock vs buy-and-hold, with costs. sma_cross: long when SMA(fast) > SMA(slow). rsi_reversion: buy when RSI < low, sell when RSI > high. breakout: buy on N-day high close, sell on M-day low close.', [
                'symbol' => $sym,
                'strategy' => ['type' => 'string', 'enum' => ['sma_cross', 'rsi_reversion', 'breakout']],
                'fast' => ['type' => 'integer'], 'slow' => ['type' => 'integer'],
                'low' => ['type' => 'number'], 'high' => ['type' => 'number'],
                'entry_days' => ['type' => 'integer'], 'exit_days' => ['type' => 'integer'],
                'years' => ['type' => 'integer', 'description' => 'history length, default 5'],
                'cost_bps' => ['type' => 'number', 'description' => 'per side, default 10'],
            ], ['symbol', 'strategy']),
            $fn('market_overview', 'BIST 100 level and change, breadth, top movers and the latest AI market brief.', []),
            $fn('chart_actions', 'Change or draw on the user\'s price chart. Use whenever the user asks to show, draw, mark or switch something on the chart, and after finding levels the user would want to see.', [
                'symbol' => ['type' => 'string', 'description' => 'open this stock first (optional)'],
                'actions' => ['type' => 'array', 'items' => ['type' => 'object', 'properties' => (object) [
                    'type' => ['type' => 'string', 'enum' => ['set_view', 'hline', 'marker', 'trendline', 'channel', 'fib', 'clear']],
                    'points' => ['type' => 'array', 'description' => 'trendline: 2 points, channel: 3 points (2 on the base line + 1 on the parallel line), fib: 2 points (swing start, swing end)',
                                 'items' => ['type' => 'object', 'properties' => (object) ['date' => ['type' => 'string', 'description' => 'YYYY-MM-DD or YYYY-MM-DD HH:MM'], 'price' => ['type' => 'number']]]],
                    'interval' => ['type' => 'string', 'enum' => MarketController::INTERVALS],
                    'range' => ['type' => 'string', 'enum' => array_keys(MarketController::RANGES)],
                    'currency' => ['type' => 'string', 'enum' => ['TRY', 'USD']],
                    'price' => ['type' => 'number'], 'label' => ['type' => 'string'],
                    'kind' => ['type' => 'string', 'enum' => ['support', 'resistance', 'target', 'stop', 'neutral']],
                    'date' => ['type' => 'string', 'description' => 'YYYY-MM-DD for markers'],
                    'text' => ['type' => 'string'], 'direction' => ['type' => 'string', 'enum' => ['up', 'down', 'neutral']],
                ]]],
            ], ['actions']),
            $fn('get_user_drawings', 'The trend lines, channels, Fibonacci retracements, horizontal levels and boxes the user drew on this stock\'s chart, with what they mean now (line value today, slope, price distance to the line, position inside a channel). Call this whenever the user refers to "çizdiğim", "kanal", "trend çizgisi", "fibo" or asks about their drawings.', ['symbol' => $sym], ['symbol']),
            $fn('create_alert', 'Create an alert the dashboard checks every minute while open (price: delayed quote, RSI: daily). Use when the user says "haber ver", "uyar", "alarm kur".', [
                'symbol' => $sym, 'kind' => ['type' => 'string', 'enum' => AlertController::KINDS],
                'value' => ['type' => 'number', 'description' => 'price level, RSI level, or daily % change'],
                'note' => ['type' => 'string', 'description' => 'why the alert matters, shown when it fires'],
            ], ['symbol', 'kind', 'value']),
            $fn('list_alerts', 'List active and recently triggered alerts.', []),
            $fn('delete_alert', 'Delete an alert by id.', ['id' => ['type' => 'integer']], ['id']),
            ['type' => 'web_search'],
            ['type' => 'x_search'],
        ];
    }

    /** @return array<string,mixed> */
    public static function call(string $name, array $a): array
    {
        $sym = fn(string $k = 'symbol') => self::symbol((string) ($a[$k] ?? ''));
        return match ($name) {
            'get_price_history' => self::priceHistory($sym(), $a),
            'get_technical_indicators' => self::indicators($sym()),
            'find_support_resistance' => self::levels($sym(), (int) ($a['lookback_days'] ?? 180)),
            'get_patterns' => self::patterns($sym(), (int) ($a['days'] ?? 30)),
            'get_kap_disclosures' => self::disclosures($sym(), (int) ($a['days'] ?? 90), (bool) ($a['only_important'] ?? false)),
            'news_impact_study' => self::newsImpact(isset($a['symbol']) && $a['symbol'] ? $sym() : null, $a['event_type'] ?? null),
            'get_forecast' => self::forecast($sym()),
            'get_social_sentiment' => self::social($sym()),
            'compare_stocks' => self::compare($sym('a'), $sym('b'), (string) ($a['range'] ?? '3y')),
            'screen_stocks' => self::screen($a),
            'backtest_strategy' => self::backtest($sym(), $a),
            'market_overview' => self::overview(),
            'get_user_drawings' => DrawingController::summarise($sym()),
            'create_alert' => AlertController::create($sym(), (string) ($a['kind'] ?? ''), (float) ($a['value'] ?? 0), $a['note'] ?? null),
            'list_alerts' => AlertController::list(),
            'delete_alert' => AlertController::delete((string) ($a['id'] ?? 0)),
            'chart_actions' => ['ok' => true, 'applied' => count($a['actions'] ?? []), 'note' => 'Actions are applied in the user\'s browser.'],
            default => ['error' => "unknown tool $name"],
        };
    }

    private static function symbol(string $s): string
    {
        $s = strtoupper(trim(str_replace('.IS', '', $s)));
        if (!preg_match('/^[A-Z0-9]{2,8}$/', $s)) {
            throw new HttpError(400, "geçersiz sembol: $s");
        }
        return $s;
    }

    private static function r(?float $v, int $d = 2): ?float
    {
        return $v === null ? null : round($v, $d);
    }

    // ------------------------------------------------------------------ price & indicators
    private static function priceHistory(string $symbol, array $a): array
    {
        $interval = (string) ($a['interval'] ?? '1d');
        $data = MarketController::loadBars($symbol, $interval, (string) ($a['range'] ?? '1y'), (string) ($a['currency'] ?? 'TRY'));
        $bars = $data['bars'];
        if (!$bars) {
            return ['error' => 'no data'];
        }
        $n = max(10, min(400, (int) ($a['max_bars'] ?? 120)));
        $closes = array_map(fn($b) => (float) $b['close'], $bars);
        $rets = [];
        for ($i = 1; $i < count($closes); $i++) {
            $rets[] = $closes[$i] / $closes[$i - 1] - 1;
        }
        $hi = $lo = null;
        foreach ($bars as $b) {
            if ($hi === null || (float) $b['high'] > (float) $hi['high']) $hi = $b;
            if ($lo === null || (float) $b['low'] < (float) $lo['low']) $lo = $b;
        }
        $mean = $rets ? array_sum($rets) / count($rets) : 0;
        $sd = $rets ? sqrt(array_sum(array_map(fn($r) => ($r - $mean) ** 2, $rets)) / max(1, count($rets) - 1)) : 0;
        $tail = array_slice($bars, -$n);
        return [
            'symbol' => $symbol, 'interval' => $interval, 'currency' => strtoupper((string) ($a['currency'] ?? 'TRY')),
            'from' => $bars[0]['trade_date'], 'to' => end($bars)['trade_date'], 'bars_total' => count($bars),
            'summary' => [
                'first_close' => self::r($closes[0], 4), 'last_close' => self::r(end($closes), 4),
                'change_pct' => self::r((end($closes) / $closes[0] - 1) * 100),
                'high' => self::r((float) $hi['high'], 4), 'high_at' => $hi['trade_date'],
                'low' => self::r((float) $lo['low'], 4), 'low_at' => $lo['trade_date'],
                'volatility_per_bar_pct' => self::r($sd * 100, 3),
            ],
            'columns' => ['time', 'open', 'high', 'low', 'close', 'volume_try'],
            'bars' => array_map(fn($b) => [$b['trade_date'], self::r((float) $b['open'], 4), self::r((float) $b['high'], 4),
                self::r((float) $b['low'], 4), self::r((float) $b['close'], 4), (int) round((float) $b['volume_try'])], $tail),
        ];
    }

    private static function indicators(string $symbol): array
    {
        $rows = Db::all('SELECT trade_date, close, high, low, volume_try, rsi_14, macd, macd_signal, macd_hist, sma_50, sma_200,
                                bb_lower, bb_mid, bb_upper FROM market_daily WHERE symbol = ? ORDER BY trade_date DESC LIMIT 30', [$symbol]);
        if (!$rows) {
            return ['error' => 'no data'];
        }
        $l = $rows[0];
        $vols = array_map(fn($r) => (float) $r['volume_try'], array_slice($rows, 1, 20));
        $avgVol = $vols ? array_sum($vols) / count($vols) : null;
        $stats = MarketController::stats($symbol, $l['trade_date']);
        $c = (float) $l['close'];
        return [
            'symbol' => $symbol, 'as_of' => $l['trade_date'], 'close' => $c,
            'returns_pct' => ['1w' => self::r(($stats['change_1w'] ?? 0) * 100), '1m' => self::r(($stats['change_1m'] ?? 0) * 100),
                              '3m' => self::r(($stats['change_3m'] ?? 0) * 100), '1y' => self::r(($stats['change_1y'] ?? 0) * 100)],
            'rsi_14' => self::r((float) $l['rsi_14'], 1),
            'rsi_last_10' => array_map(fn($r) => self::r((float) $r['rsi_14'], 1), array_reverse(array_slice($rows, 0, 10))),
            'macd' => ['macd' => self::r((float) $l['macd'], 3), 'signal' => self::r((float) $l['macd_signal'], 3), 'hist' => self::r((float) $l['macd_hist'], 3)],
            'sma_50' => self::r((float) $l['sma_50']), 'sma_200' => self::r((float) $l['sma_200']),
            'pct_vs_sma50' => $l['sma_50'] ? self::r(($c / $l['sma_50'] - 1) * 100) : null,
            'pct_vs_sma200' => $l['sma_200'] ? self::r(($c / $l['sma_200'] - 1) * 100) : null,
            'bollinger' => ['lower' => self::r((float) $l['bb_lower']), 'mid' => self::r((float) $l['bb_mid']), 'upper' => self::r((float) $l['bb_upper'])],
            'range_52w' => ['low' => $stats['low_52w'], 'high' => $stats['high_52w']],
            'volume_vs_20d_avg' => $avgVol ? self::r((float) $l['volume_try'] / $avgVol, 2) : null,
        ];
    }

    /** Swing-point levels clustered within 1.5 %, ranked by touches. */
    private static function levels(string $symbol, int $days): array
    {
        $days = max(30, min(1500, $days));
        $rows = Db::all('SELECT trade_date, high, low, close FROM market_daily WHERE symbol = ?
                          AND trade_date > DATE_SUB((SELECT MAX(trade_date) FROM market_daily WHERE symbol = ?), INTERVAL ? DAY)
                          ORDER BY trade_date', [$symbol, $symbol, $days]);
        $n = count($rows);
        if ($n < 20) {
            return ['error' => 'not enough data'];
        }
        $pts = [];
        $w = 5;
        for ($i = $w; $i < $n - $w; $i++) {
            $h = (float) $rows[$i]['high'];
            $lo = (float) $rows[$i]['low'];
            $isHi = $isLo = true;
            for ($j = $i - $w; $j <= $i + $w; $j++) {
                if ((float) $rows[$j]['high'] > $h) $isHi = false;
                if ((float) $rows[$j]['low'] < $lo) $isLo = false;
            }
            if ($isHi) $pts[] = [$h, $rows[$i]['trade_date'], 'high'];
            if ($isLo) $pts[] = [$lo, $rows[$i]['trade_date'], 'low'];
        }
        usort($pts, fn($x, $y) => $x[0] <=> $y[0]);
        $clusters = [];
        foreach ($pts as $p) {
            $k = count($clusters) - 1;
            if ($k >= 0 && abs($p[0] / $clusters[$k]['price'] - 1) < 0.015) {
                $clusters[$k]['points'][] = $p;
                $clusters[$k]['price'] = array_sum(array_column($clusters[$k]['points'], 0)) / count($clusters[$k]['points']);
            } else {
                $clusters[] = ['price' => $p[0], 'points' => [$p]];
            }
        }
        $close = (float) end($rows)['close'];
        $levels = array_map(fn($c) => [
            'price' => self::r($c['price']), 'touches' => count($c['points']),
            'kind' => $c['price'] < $close ? 'support' : 'resistance',
            'distance_pct' => self::r(($c['price'] / $close - 1) * 100),
            'last_touch' => max(array_column($c['points'], 1)),
        ], $clusters);
        usort($levels, fn($x, $y) => [$y['touches'], -abs($y['distance_pct'])] <=> [$x['touches'], -abs($x['distance_pct'])]);
        return ['symbol' => $symbol, 'close' => $close, 'lookback_days' => $days, 'levels' => array_slice($levels, 0, 8)];
    }

    // ------------------------------------------------------------------ signals, news, forecast
    private static function patterns(string $symbol, int $days): array
    {
        $rows = Db::all('SELECT trade_date, pattern, direction, ROUND(strength, 2) AS strength FROM patterns WHERE symbol = ?
                          AND trade_date > DATE_SUB((SELECT MAX(trade_date) FROM patterns WHERE symbol = ?), INTERVAL ? DAY)
                          ORDER BY trade_date DESC LIMIT 40', [$symbol, $symbol, max(1, min(365, $days))]);
        return ['symbol' => $symbol, 'patterns' => $rows];
    }

    private static function disclosures(string $symbol, int $days, bool $important): array
    {
        $rows = Db::all('SELECT DATE(d.published_at) AS day, d.subject, d.summary, LEFT(d.body, 400) AS body, s.label, ROUND(s.score, 2) AS score,
                                s.event_type, s.key_points, ROUND(e.car_1d * 100, 2) AS car_1d_pct, ROUND(e.car_3d * 100, 2) AS car_3d_pct
                           FROM disclosures d LEFT JOIN v_sentiment s USING (disclosure_id) LEFT JOIN event_returns e USING (disclosure_id)
                          WHERE d.symbol = ? AND d.published_at > DATE_SUB(NOW(), INTERVAL ? DAY)'
                         . ($important ? " AND s.label <> 'neutral'" : '') . ' ORDER BY d.published_at DESC LIMIT 25',
                         [$symbol, max(1, min(3650, $days))]);
        foreach ($rows as &$r) {
            $r['key_points'] = $r['key_points'] ? json_decode((string) $r['key_points'], true) : [];
        }
        return ['symbol' => $symbol, 'count' => count($rows), 'disclosures' => $rows,
                'note' => 'car_*_pct = return vs BIST 100 over 1/3 trading days after the disclosure'];
    }

    private static function newsImpact(?string $symbol, ?string $eventType): array
    {
        $where = ['e.car_3d IS NOT NULL'];
        $p = [];
        if ($symbol) { $where[] = 'd.symbol = ?'; $p[] = $symbol; }
        if ($eventType) { $where[] = 's.event_type = ?'; $p[] = $eventType; }
        $w = implode(' AND ', $where);
        $byLabel = Db::all("SELECT s.label, COUNT(*) AS n, ROUND(AVG(e.car_1d)*100, 2) AS avg_car_1d_pct, ROUND(AVG(e.car_3d)*100, 2) AS avg_car_3d_pct,
                                   ROUND(AVG(e.car_5d)*100, 2) AS avg_car_5d_pct, ROUND(AVG(e.car_3d > 0)*100, 1) AS pct_positive_3d
                              FROM event_returns e JOIN v_sentiment s USING (disclosure_id) JOIN disclosures d USING (disclosure_id)
                             WHERE $w GROUP BY s.label", $p);
        $byType = Db::all("SELECT s.event_type, s.label, COUNT(*) AS n, ROUND(AVG(e.car_3d)*100, 2) AS avg_car_3d_pct
                             FROM event_returns e JOIN v_sentiment s USING (disclosure_id) JOIN disclosures d USING (disclosure_id)
                            WHERE $w GROUP BY s.event_type, s.label HAVING n >= 10 ORDER BY n DESC LIMIT 25", $p);
        $span = Db::one("SELECT MIN(d.published_at) AS f, MAX(d.published_at) AS t FROM event_returns e JOIN disclosures d USING (disclosure_id)
                          JOIN v_sentiment s USING (disclosure_id) WHERE $w", $p);
        return ['scope' => ['symbol' => $symbol, 'event_type' => $eventType, 'from' => $span['f'] ?? null, 'to' => $span['t'] ?? null],
                'by_label' => $byLabel, 'by_event_type' => $byType];
    }

    private static function forecast(string $symbol): array
    {
        $row = Db::one('SELECT payload FROM forecasts WHERE symbol = ? ORDER BY as_of DESC LIMIT 1', [$symbol]);
        if (!$row) {
            return ['error' => 'no forecast for this symbol'];
        }
        $f = json_decode((string) $row['payload'], true);
        if (($f['version'] ?? '') === 'gold-v1') {
            unset($f['disclaimer']);
            return ['symbol' => $symbol] + $f + ['reliability_note' => 'Ranges are calibrated (90% band covered ~88-90% of outcomes in 2012-2026 walk-forward). '
                . 'Direction models scored AUC ~0.50 (coin flip) and no timing rule beat buy-and-hold, so give ranges/volatility, not a direction call.'];
        }
        return ['symbol' => $symbol, 'as_of' => $f['as_of'], 'horizons' => array_map(fn($h) => [
            'days' => $h['days'], 'p_up' => self::r($h['p_up'], 3), 'p_beat_index' => self::r($h['p_beat'] ?? null, 3),
            'rank_among_all_stocks_pct' => isset($h['rank_pct']) ? self::r($h['rank_pct'] * 100, 0) : null,
            'model_auc_abs' => self::r($h['model_auc'] ?? null, 3), 'model_auc_beat' => self::r($h['beat_auc'] ?? null, 3),
        ], $f['horizons']), 'reliability_note' => 'AUC 0.5 = coin flip; absolute direction ~0.53-0.54, ranking vs index ~0.55. Treat as weak evidence.'];
    }

    private static function social(string $symbol): array
    {
        $r = Db::one('SELECT as_of, label, score, bullish_share, bearish_share, post_volume, summary, themes FROM social_sentiment
                       WHERE symbol = ? ORDER BY as_of DESC LIMIT 1', [$symbol]);
        if (!$r) {
            return ['error' => 'no stored X sentiment; use x_search for live posts'];
        }
        $r['themes'] = json_decode((string) $r['themes'], true);
        return $r;
    }

    private static function compare(string $a, string $b, string $range): array
    {
        $_GET['range'] = in_array($range, ['1y', '3y', '5y', 'all'], true) ? $range : '3y';
        $d = PairController::show($a, $b);
        $s = $d['series'];
        $research = $d['research']['analysis'] ?? null;
        return ['a' => $a, 'b' => $b, 'range' => $d['range'], 'summary' => $d['summary'],
                'relative_performance_pct' => ['a' => self::r(end($s['a']) - 100), 'b' => self::r(end($s['b']) - 100)],
                'lead_lag_study' => $research ? array_map(fn($x) => ['corr' => self::r($x['corr'], 3),
                    'granger_b_to_a_min_p' => self::r(min($x['granger_thyao_to_pgsus_p']), 4), 'cointegration_p' => self::r($x['coint_p'], 3)], $research) : null];
    }

    private static function screen(array $f): array
    {
        $where = ["m.source <> 'instrument'", 'm.trade_date = (SELECT MAX(trade_date) FROM market_daily WHERE source <> "instrument")', 'm.volume_try >= ?'];
        $p = [(float) ($f['min_volume_try'] ?? 2e7)];
        foreach (['rsi_below' => 'm.rsi_14 < ?', 'rsi_above' => 'm.rsi_14 > ?'] as $k => $sql) {
            if (isset($f[$k])) { $where[] = $sql; $p[] = (float) $f[$k]; }
        }
        if (!empty($f['above_sma200'])) $where[] = 'm.close > m.sma_200';
        if (!empty($f['below_sma200'])) $where[] = 'm.close < m.sma_200';
        if (isset($f['min_change_pct'])) { $where[] = 'm.pct_change >= ?'; $p[] = (float) $f['min_change_pct'] / 100; }
        if (isset($f['max_change_pct'])) { $where[] = 'm.pct_change <= ?'; $p[] = (float) $f['max_change_pct'] / 100; }
        $join = '';
        if (!empty($f['pattern'])) {
            $join = 'JOIN patterns pt ON pt.symbol = m.symbol AND pt.trade_date = m.trade_date AND pt.pattern = ?';
            array_unshift($p, (string) $f['pattern']);
        }
        $order = ['change' => 'change_pct DESC', 'volume' => 'volume_mn_try DESC', 'rsi' => 'rsi ASC',
                  'forecast' => 'forecast_rank_5d DESC'][$f['sort'] ?? 'volume'] ?? 'volume_mn_try DESC';
        $limit = max(1, min(40, (int) ($f['limit'] ?? 15)));
        $rows = Db::all("SELECT DISTINCT m.symbol, ROUND(m.close, 2) AS close, ROUND(m.pct_change*100, 2) AS change_pct, ROUND(m.rsi_14, 1) AS rsi,
                                ROUND(m.close / m.sma_200 * 100 - 100, 1) AS pct_vs_sma200, ROUND(m.volume_try / 1e6, 1) AS volume_mn_try,
                                ROUND(JSON_EXTRACT(fc.payload, '$.horizons[1].rank_pct') * 100) AS forecast_rank_5d
                           FROM market_daily m $join
                           LEFT JOIN forecasts fc ON fc.symbol = m.symbol AND fc.as_of = m.trade_date
                          WHERE " . implode(' AND ', $where) . " ORDER BY $order LIMIT $limit", $p);
        return ['as_of' => Db::one('SELECT MAX(trade_date) AS d FROM market_daily WHERE source <> "instrument"')['d'], 'filters' => $f, 'count' => count($rows), 'stocks' => $rows];
    }

    // ------------------------------------------------------------------ backtest
    private static function backtest(string $symbol, array $a): array
    {
        $years = max(1, min(25, (int) ($a['years'] ?? 5)));
        $cost = (float) ($a['cost_bps'] ?? 10) / 1e4;
        $rows = Db::all('SELECT trade_date, close, rsi_14 FROM market_daily WHERE symbol = ? AND trade_date >
                          DATE_SUB((SELECT MAX(trade_date) FROM market_daily WHERE symbol = ?), INTERVAL ? YEAR) ORDER BY trade_date',
                        [$symbol, $symbol, $years + 1]);
        $n = count($rows);
        if ($n < 260) {
            return ['error' => 'not enough history'];
        }
        $c = array_map(fn($r) => (float) $r['close'], $rows);
        $strategy = (string) $a['strategy'];
        $sma = function (int $k) use ($c, $n): array {
            $out = array_fill(0, $n, null);
            $sum = 0.0;
            for ($i = 0; $i < $n; $i++) {
                $sum += $c[$i];
                if ($i >= $k) $sum -= $c[$i - $k];
                if ($i >= $k - 1) $out[$i] = $sum / $k;
            }
            return $out;
        };
        $signal = array_fill(0, $n, 0);   // desired position at the close of day i (traded next day)
        $params = [];
        if ($strategy === 'sma_cross') {
            $fast = max(2, (int) ($a['fast'] ?? 50));
            $slow = max($fast + 1, (int) ($a['slow'] ?? 200));
            $params = compact('fast', 'slow');
            [$sf, $ss] = [$sma($fast), $sma($slow)];
            for ($i = 0; $i < $n; $i++) $signal[$i] = ($sf[$i] !== null && $ss[$i] !== null && $sf[$i] > $ss[$i]) ? 1 : 0;
        } elseif ($strategy === 'rsi_reversion') {
            $low = (float) ($a['low'] ?? 30);
            $high = (float) ($a['high'] ?? 60);
            $params = compact('low', 'high');
            $pos = 0;
            for ($i = 0; $i < $n; $i++) {
                $r = $rows[$i]['rsi_14'];
                if ($r !== null) {
                    if (!$pos && $r < $low) $pos = 1;
                    elseif ($pos && $r > $high) $pos = 0;
                }
                $signal[$i] = $pos;
            }
        } else {
            $entry = max(5, (int) ($a['entry_days'] ?? 55));
            $exit = max(3, (int) ($a['exit_days'] ?? 20));
            $params = ['entry_days' => $entry, 'exit_days' => $exit];
            $pos = 0;
            for ($i = $entry; $i < $n; $i++) {
                $hi = max(array_slice($c, $i - $entry, $entry));
                $lo = min(array_slice($c, $i - $exit, $exit));
                if (!$pos && $c[$i] > $hi) $pos = 1;
                elseif ($pos && $c[$i] < $lo) $pos = 0;
                $signal[$i] = $pos;
            }
        }
        // evaluate only the requested window (the extra year warms up the indicators)
        $start = max(1, $n - $years * 252);
        $eq = $bh = 1.0;
        $peak = $bhPeak = 1.0;
        $dd = $bhDd = 0.0;
        $trades = [];
        $open = null;
        $inMkt = 0;
        $rets = [];
        for ($i = $start; $i < $n; $i++) {
            $r = $c[$i] / $c[$i - 1] - 1;
            $pos = $signal[$i - 1];
            $prev = $i - 2 >= 0 ? $signal[$i - 2] : 0;
            $day = $pos * $r - ($pos !== $prev ? $cost : 0);
            $eq *= 1 + $day;
            $bh *= 1 + $r;
            $rets[] = $day;
            $inMkt += $pos;
            $peak = max($peak, $eq);
            $dd = min($dd, $eq / $peak - 1);
            $bhPeak = max($bhPeak, $bh);
            $bhDd = min($bhDd, $bh / $bhPeak - 1);
            if ($pos && !$prev) $open = $c[$i - 1];
            if (!$pos && $prev && $open) { $trades[] = $c[$i - 1] / $open - 1 - 2 * $cost; $open = null; }
        }
        $days = $n - $start;
        $mean = array_sum($rets) / max(1, count($rets));
        $sd = sqrt(array_sum(array_map(fn($x) => ($x - $mean) ** 2, $rets)) / max(1, count($rets) - 1));
        $ann = fn(float $g) => $g > 0 ? pow($g, 252 / $days) - 1 : -1;
        return [
            'symbol' => $symbol, 'strategy' => $strategy, 'params' => $params, 'years' => $years, 'cost_bps_per_side' => $cost * 1e4,
            'period' => [$rows[$start]['trade_date'], $rows[$n - 1]['trade_date']],
            'strategy_result' => ['total_return_pct' => self::r(($eq - 1) * 100, 1), 'annualised_pct' => self::r($ann($eq) * 100, 1),
                'max_drawdown_pct' => self::r($dd * 100, 1), 'sharpe' => $sd > 0 ? self::r($mean / $sd * sqrt(252), 2) : null,
                'time_in_market_pct' => self::r($inMkt / $days * 100, 0), 'closed_trades' => count($trades),
                'win_rate_pct' => $trades ? self::r(count(array_filter($trades, fn($t) => $t > 0)) / count($trades) * 100, 0) : null],
            'buy_and_hold' => ['total_return_pct' => self::r(($bh - 1) * 100, 1), 'annualised_pct' => self::r($ann($bh) * 100, 1),
                'max_drawdown_pct' => self::r($bhDd * 100, 1)],
            'currently_in_position' => (bool) $signal[$n - 1],
            'caveat' => 'In-sample test of a hand-picked rule; past results do not guarantee future returns. Prices are not dividend-adjusted.',
        ];
    }

    private static function overview(): array
    {
        $last = Db::one('SELECT MAX(trade_date) AS d FROM market_daily WHERE source <> "instrument"')['d'];
        $idx = Db::all('SELECT trade_date, MAX(bist100) AS v FROM market_daily WHERE trade_date > DATE_SUB(?, INTERVAL 40 DAY)
                         AND bist100 IS NOT NULL GROUP BY trade_date ORDER BY trade_date DESC LIMIT 21', [$last]);
        $b = Db::one("SELECT SUM(pct_change > 0) AS up, SUM(pct_change < 0) AS down FROM market_daily WHERE trade_date = ? AND source <> 'instrument'", [$last]);
        $mv = fn(string $dir) => Db::all("SELECT symbol, ROUND(pct_change*100, 2) AS change_pct FROM market_daily WHERE trade_date = ?
                                          AND volume_try >= 5e7 AND source <> 'instrument' ORDER BY pct_change $dir LIMIT 5", [$last]);
        $brief = Db::one('SELECT as_of, mood, summary FROM market_briefs ORDER BY as_of DESC LIMIT 1');
        return ['as_of' => $last, 'bist100' => self::r((float) $idx[0]['v']),
                'bist100_change_1d_pct' => count($idx) > 1 ? self::r(($idx[0]['v'] / $idx[1]['v'] - 1) * 100) : null,
                'bist100_change_20d_pct' => count($idx) > 20 ? self::r(($idx[0]['v'] / $idx[20]['v'] - 1) * 100) : null,
                'breadth' => $b, 'top_gainers' => $mv('DESC'), 'top_losers' => $mv('ASC'), 'ai_brief' => $brief];
    }
}
