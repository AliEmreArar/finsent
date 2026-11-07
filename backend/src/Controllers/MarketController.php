<?php

declare(strict_types=1);

namespace FinSent\Controllers;

use FinSent\Db;
use FinSent\Http;
use FinSent\HttpError;

final class MarketController
{
    /** @return list<array<string,mixed>> */
    public static function symbols(): array
    {
        $q = Http::query('q');
        $params = [];
        $where = '';
        if ($q !== null) {
            $where = 'WHERE m.symbol LIKE ?';
            $params[] = strtoupper($q) . '%';
        }
        return Db::all(
            "SELECT m.symbol, c.title, m.close, m.pct_change, m.trade_date,
                    COALESCE(ds.n, 0) AS disclosures, ds.avg_score
               FROM market_daily m
               JOIN (SELECT symbol, MAX(trade_date) AS d FROM market_daily GROUP BY symbol) last
                 ON last.symbol = m.symbol AND last.d = m.trade_date
               LEFT JOIN companies c ON c.symbol = m.symbol
               LEFT JOIN (SELECT d.symbol, COUNT(*) AS n, AVG(s.score) AS avg_score
                            FROM disclosures d JOIN v_sentiment s USING (disclosure_id)
                           GROUP BY d.symbol) ds ON ds.symbol = m.symbol
               $where
              ORDER BY disclosures DESC, m.market_cap_try DESC
              LIMIT 600",
            $params
        );
    }

    /**
     * Intraday quote from Yahoo Finance's chart API (free, ~15 min delayed for BIST).
     * Cached for 60 s in a temp file.
     * @return array<string,mixed>
     */
    public static function quote(string $symbol): array
    {
        $symbol = Http::symbol($symbol);
        $cache = sys_get_temp_dir() . "/finsent_quote_$symbol.json";
        if (is_file($cache) && time() - filemtime($cache) < 60) {
            return json_decode((string) file_get_contents($cache), true) + ['cached' => true];
        }
        $data = self::rowsFor($symbol, '5m', '1d', 60);
        $res = ['meta' => $data['meta'], 'timestamp' => array_column($data['rows'], 0),
                'indicators' => ['quote' => [['close' => array_column($data['rows'], 4)]]]];
        if (isset($res['meta']['chartPreviousClose'], $res['meta']['regularMarketPrice']) && empty($res['meta']['regularMarketChangePercent'])) {
            $res['meta']['regularMarketChangePercent'] = ($res['meta']['regularMarketPrice'] / $res['meta']['chartPreviousClose'] - 1) * 100;
        }
        $m = $res['meta'];
        $closes = $res['indicators']['quote'][0]['close'] ?? [];
        $points = [];
        foreach ($res['timestamp'] ?? [] as $i => $ts) {
            if (isset($closes[$i])) {
                $points[] = ['t' => date('c', $ts), 'p' => round((float) $closes[$i], 4)];
            }
        }
        $out = [
            'symbol' => $symbol,
            'price' => $m['regularMarketPrice'] ?? null,
            'previous_close' => $m['chartPreviousClose'] ?? $m['previousClose'] ?? null,
            'change_pct' => $m['regularMarketChangePercent'] ?? null,
            'day_high' => $m['regularMarketDayHigh'] ?? null,
            'day_low' => $m['regularMarketDayLow'] ?? null,
            'volume' => $m['regularMarketVolume'] ?? null,
            'market_time' => isset($m['regularMarketTime']) ? date('c', (int) $m['regularMarketTime']) : null,
            'name' => $m['longName'] ?? $m['shortName'] ?? null,
            'source' => 'Yahoo Finance (gecikmeli)',
            'intraday' => $points,
        ];
        file_put_contents($cache, json_encode($out, JSON_UNESCAPED_UNICODE));
        return $out + ['cached' => false];
    }

    /** Latest direction forecast (analogs + model) written by the pipeline. @return array<string,mixed> */
    public static function forecast(string $symbol): array
    {
        $symbol = Http::symbol($symbol);
        $row = Db::one('SELECT as_of, payload, created_at FROM forecasts WHERE symbol = ? ORDER BY as_of DESC LIMIT 1', [$symbol]);
        if (!$row) {
            throw new HttpError(404, "$symbol için tahmin yok");
        }
        return ['symbol' => $symbol, 'created_at' => $row['created_at']] + json_decode((string) $row['payload'], true);
    }

    /** Non-equity instruments (gold, silver, FX, index): Yahoo tickers and derived gram prices. */
    public const YAHOO = ['XAUUSD' => 'GC=F', 'XAGUSD' => 'SI=F', 'USDTRY' => 'USDTRY=X', 'EURTRY' => 'EURTRY=X', 'XU100' => 'XU100.IS'];
    public const DERIVED = ['ALTIN' => ['XAUUSD', 'USDTRY'], 'GUMUS' => ['XAGUSD', 'USDTRY']];
    public const USD_QUOTED = ['XAUUSD', 'XAGUSD'];
    private const OZ = 31.1034768;

    public static function isInstrument(string $symbol): bool
    {
        return isset(self::YAHOO[$symbol]) || isset(self::DERIVED[$symbol]);
    }

    public static function yahooTicker(string $symbol): string
    {
        return self::YAHOO[$symbol] ?? "$symbol.IS";
    }

    /** Raw Yahoo chart rows [ts, o, h, l, c, v], cached. */
    private static function yahooRaw(string $ticker, string $yInt, string $yRange, int $ttl = 600): array
    {
        $cache = sys_get_temp_dir() . '/finsent_bars_' . preg_replace('/[^A-Za-z0-9]/', '_', $ticker) . "_{$yInt}_{$yRange}.json";
        if (is_file($cache) && time() - filemtime($cache) < $ttl) {
            return json_decode((string) file_get_contents($cache), true);
        }
        $client = new \GuzzleHttp\Client(['timeout' => 20, 'headers' => ['User-Agent' => 'finsent/1.0 (personal research project)']]);
        try {
            $resp = $client->get('https://query1.finance.yahoo.com/v8/finance/chart/' . rawurlencode($ticker),
                ['query' => ['interval' => $yInt, 'range' => $yRange]]);
        } catch (\GuzzleHttp\Exception\GuzzleException $e) {
            throw new HttpError(502, 'Yahoo Finance verisi alınamadı');
        }
        $res = json_decode((string) $resp->getBody(), true)['chart']['result'][0] ?? null;
        if (!$res || empty($res['timestamp'])) {
            throw new HttpError(404, "$ticker için gün içi veri yok");
        }
        $q = $res['indicators']['quote'][0];
        $raw = [];
        foreach ($res['timestamp'] as $i => $ts) {
            if (isset($q['close'][$i])) {
                $raw[] = [$ts, $q['open'][$i], $q['high'][$i], $q['low'][$i], $q['close'][$i], $q['volume'][$i] ?? 0];
            }
        }
        file_put_contents($cache, json_encode(['meta' => $res['meta'], 'rows' => $raw]));
        return ['meta' => $res['meta'], 'rows' => $raw];
    }

    /** Rows for any symbol; gram gold/silver = ounce x USD/TRY / 31.1 on matching timestamps. */
    private static function rowsFor(string $symbol, string $yInt, string $yRange, int $ttl = 600): array
    {
        if (!isset(self::DERIVED[$symbol])) {
            return self::yahooRaw(self::yahooTicker($symbol), $yInt, $yRange, $ttl);
        }
        [$oz, $fx] = self::DERIVED[$symbol];
        $a = self::yahooRaw(self::yahooTicker($oz), $yInt, $yRange, $ttl);
        $b = self::yahooRaw(self::yahooTicker($fx), $yInt, $yRange, $ttl);
        $fxRows = $b['rows'];
        $k = 0;
        $rate = null;
        $rows = [];
        foreach ($a['rows'] as [$ts, $o, $h, $l, $c, $v]) {
            while ($k < count($fxRows) && $fxRows[$k][0] <= $ts) {
                $rate = $fxRows[$k++][4];
            }
            $rate ??= $fxRows[0][4] ?? null;
            if ($rate) {
                $f = $rate / self::OZ;
                $rows[] = [$ts, $o * $f, $h * $f, $l * $f, $c * $f, 0];
            }
        }
        $meta = $a['meta'];
        $fxNow = (float) ($b['meta']['regularMarketPrice'] ?? end($fxRows)[4]);
        foreach (['regularMarketPrice', 'chartPreviousClose', 'previousClose', 'regularMarketDayHigh', 'regularMarketDayLow'] as $f) {
            if (isset($meta[$f])) {
                $meta[$f] = $meta[$f] * $fxNow / self::OZ;
            }
        }
        $meta['longName'] = $symbol === 'ALTIN' ? 'Gram altın (TL)' : 'Gram gümüş (TL)';
        return ['meta' => $meta, 'rows' => $rows];
    }

    public const RANGES = ['1m' => '-1 month', '3m' => '-3 months', '6m' => '-6 months', '1y' => '-1 year',
                           '3y' => '-3 years', '5y' => '-5 years', 'all' => '-40 years'];
    public const INTERVALS = ['15m', '1h', '4h', '1d', '1w', '1mo'];

    /**
     * Candles for any interval / currency (shared by the chart API and the agent tools).
     * @return array{bars: list<array<string,mixed>>, from: string, to: string}
     */
    public static function loadBars(string $symbol, string $interval = '1d', string $range = '6m',
                                    string $currency = 'TRY', ?string $from = null, ?string $to = null): array
    {
        $to ??= Db::one('SELECT MAX(trade_date) AS d FROM market_daily WHERE symbol = ?', [$symbol])['d'];
        if ($to === null) {
            throw new HttpError(404, "$symbol için piyasa verisi yok");
        }
        if (!isset(self::RANGES[$range])) {
            throw new HttpError(400, 'range must be one of ' . implode(', ', array_keys(self::RANGES)));
        }
        $currency = strtoupper($currency);
        if (!in_array($interval, self::INTERVALS, true) || !in_array($currency, ['TRY', 'USD'], true)) {
            throw new HttpError(400, 'interval: 15m|1h|4h|1d|1w|1mo, currency: TRY|USD');
        }
        $from ??= (new \DateTimeImmutable($to))->modify(self::RANGES[$range])->format('Y-m-d');
        if (in_array($interval, ['15m', '1h', '4h'], true)) {
            // intraday history is limited by Yahoo: ~3 years of hourly, ~60 days of 15-minute bars
            $bars = self::intradayBars($symbol, $interval);
            $from = $bars ? substr($bars[0]['trade_date'], 0, 10) : $from;
        } else {
            $bars = Db::all(
                'SELECT trade_date, open, high, low, close, volume_try, usd_try, open_is_estimated
                   FROM market_daily WHERE symbol = ? AND trade_date BETWEEN ? AND ? ORDER BY trade_date',
                [$symbol, $from, $to]
            );
            if ($interval !== '1d') {
                $bars = self::aggregate($bars, $interval);
            }
        }
        $usdQuoted = in_array($symbol, self::USD_QUOTED, true);
        if ($currency === 'USD' && !$usdQuoted) {
            $bars = self::toUsd($bars, $from, $to, $symbol);
        } elseif ($currency === 'TRY' && $usdQuoted) {
            $bars = self::toUsd($bars, $from, $to, 'USDTRY', true);
        }
        return ['bars' => $bars, 'from' => $from, 'to' => $to];
    }

    /** @return array<string,mixed> */
    public static function series(string $symbol): array
    {
        $symbol = Http::symbol($symbol);
        $range = Http::query('range', '6m');
        $interval = Http::query('interval', '1d');
        $currency = strtoupper(Http::query('currency', in_array($symbol, self::USD_QUOTED, true) ? 'USD' : 'TRY'));
        ['bars' => $bars, 'from' => $from, 'to' => $to] = self::loadBars(
            $symbol, $interval, $range, $currency, Http::dateQuery('from'), Http::dateQuery('to'));
        $events = Db::all(
            'SELECT d.disclosure_id, d.published_at, d.subject, s.label, s.score, e.event_date, e.car_1d, e.car_3d
               FROM disclosures d LEFT JOIN v_sentiment s USING (disclosure_id)
               LEFT JOIN event_returns e USING (disclosure_id)
              WHERE d.symbol = ? AND d.published_at BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)
              ORDER BY d.published_at',
            [$symbol, $from, $to]
        );
        $company = Db::one('SELECT title FROM companies WHERE symbol = ?', [$symbol]);
        return ['symbol' => $symbol, 'title' => $company['title'] ?? null, 'from' => $from, 'to' => $to,
                'range' => $range, 'interval' => $interval, 'currency' => $currency,
                'instrument' => self::isInstrument($symbol), 'usd_quoted' => in_array($symbol, self::USD_QUOTED, true),
                'bars' => $bars, 'events' => $events, 'stats' => self::stats($symbol, $to)];
    }

    /** Daily bars -> weekly / monthly OHLCV (open first, close last, high max, low min, volume sum). */
    private static function aggregate(array $bars, string $interval): array
    {
        $out = [];
        foreach ($bars as $b) {
            $d = new \DateTimeImmutable($b['trade_date']);
            $key = $interval === '1w' ? $d->modify('monday this week')->format('Y-m-d') : $d->format('Y-m-01');
            if (!isset($out[$key])) {
                $out[$key] = ['trade_date' => $key, 'open' => $b['open'] ?? $b['close'], 'high' => $b['high'], 'low' => $b['low'],
                              'close' => $b['close'], 'volume_try' => 0.0, 'usd_try' => $b['usd_try'], 'open_is_estimated' => 0];
            }
            $o = &$out[$key];
            $o['high'] = max((float) $o['high'], (float) $b['high']);
            $o['low'] = min((float) $o['low'], (float) $b['low']);
            $o['close'] = $b['close'];
            $o['usd_try'] = $b['usd_try'] ?? $o['usd_try'];
            $o['volume_try'] += (float) $b['volume_try'];
            unset($o);
        }
        return array_values($out);
    }

    /** Convert OHLC to USD with each bar's day USD/TRY (intraday bars use their day's rate). */
    private static function toUsd(array $bars, string $from, string $to, string $symbol = 'XU100', bool $multiply = false): array
    {
        // USD/TRY is the same for every stock: read it from one symbol via the primary key (fast)
        $fx = [];
        foreach (Db::all('SELECT trade_date, usd_try FROM market_daily WHERE symbol = ? AND trade_date BETWEEN DATE_SUB(?, INTERVAL 10 DAY) AND ?
                           AND usd_try IS NOT NULL ORDER BY trade_date', [$symbol, $from, $to]) as $r) {
            $fx[$r['trade_date']] = (float) $r['usd_try'];
        }
        $days = array_keys($fx);
        $k = 0;
        $last = null;
        $out = [];
        foreach ($bars as $b) {   // bars are in time order: carry the latest known rate forward
            $day = substr($b['trade_date'], 0, 10);
            while ($k < count($days) && $days[$k] <= $day) {
                $last = $fx[$days[$k++]];
            }
            $rate = (float) ($b['usd_try'] ?? 0) ?: $last;
            if (!$rate) {
                continue;
            }
            $last = $rate;
            $k2 = $multiply ? $rate : 1 / $rate;   // USD -> TRY for USD-quoted instruments
            foreach (['open', 'high', 'low', 'close'] as $field) {
                $b[$field] = $b[$field] !== null ? (float) $b[$field] * $k2 : null;
            }
            $b['volume_try'] = (float) $b['volume_try'] * $k2;
            $out[] = $b;
        }
        return $out;
    }

    /** Hourly / 15-minute bars from Yahoo's chart API, 4h built from hourly. Cached 10 minutes. */
    private static function intradayBars(string $symbol, string $interval): array
    {
        [$yInt, $yRange] = $interval === '15m' ? ['15m', '60d'] : ['60m', '730d'];
        $raw = self::rowsFor($symbol, $yInt, $yRange)['rows'];
        $tz = new \DateTimeZone('Europe/Istanbul');
        $bars = [];
        foreach ($raw as [$ts, $o, $h, $l, $c, $v]) {
            $dt = (new \DateTimeImmutable("@$ts"))->setTimezone($tz);
            // 4h: two sessions per day (morning / afternoon), labelled 10:00 and 14:00
            if ($interval === '4h') {
                // BIST stocks: morning / afternoon session; round-the-clock instruments: 4-hour blocks
                $key = self::isInstrument($symbol) && $symbol !== 'XU100'
                    ? $dt->format('Y-m-d ') . sprintf('%02d:00', intdiv((int) $dt->format('H'), 4) * 4)
                    : $dt->format('Y-m-d') . ((int) $dt->format('H') < 14 ? ' 10:00' : ' 14:00');
            } else {
                $key = $dt->format('Y-m-d H:i');
            }
            if (!isset($bars[$key])) {
                $bars[$key] = ['trade_date' => $key, 'open' => $o, 'high' => $h, 'low' => $l, 'close' => $c, 'volume_try' => 0.0,
                               'usd_try' => null, 'open_is_estimated' => 0];
            }
            $b = &$bars[$key];
            $b['high'] = max($b['high'], $h);
            $b['low'] = min($b['low'], $l);
            $b['close'] = $c;
            $b['volume_try'] += $v * $c;
            unset($b);
        }
        return array_values($bars);
    }

    /** Headline numbers for the symbol page, independent of the charted range. @return array<string,mixed> */
    public static function stats(string $symbol, string $to): array
    {
        $last = Db::one('SELECT close, pct_change, rsi_14, sma_50, sma_200, volume_try FROM market_daily
                          WHERE symbol = ? AND trade_date = ?', [$symbol, $to]);
        $ret = function (string $interval) use ($symbol, $to, $last): ?float {
            $row = Db::one("SELECT close FROM market_daily WHERE symbol = ? AND trade_date <= DATE_SUB(?, INTERVAL $interval)
                             ORDER BY trade_date DESC LIMIT 1", [$symbol, $to]);
            return $row && $last && (float) $row['close'] > 0 ? (float) $last['close'] / (float) $row['close'] - 1 : null;
        };
        $year = Db::one('SELECT MAX(high) AS hi, MIN(low) AS lo, AVG(volume_try) AS avg_vol FROM market_daily
                          WHERE symbol = ? AND trade_date > DATE_SUB(?, INTERVAL 1 YEAR)', [$symbol, $to]);
        return [
            'close' => $last ? (float) $last['close'] : null,
            'change_1d' => $last['pct_change'] ?? null,
            'change_1w' => $ret('7 DAY'), 'change_1m' => $ret('1 MONTH'),
            'change_3m' => $ret('3 MONTH'), 'change_1y' => $ret('1 YEAR'),
            'high_52w' => $year['hi'] !== null ? (float) $year['hi'] : null,
            'low_52w' => $year['lo'] !== null ? (float) $year['lo'] : null,
            'avg_volume_1y' => $year['avg_vol'] !== null ? (float) $year['avg_vol'] : null,
            'rsi_14' => $last['rsi_14'] ?? null,
            'above_sma_50' => $last && $last['sma_50'] !== null ? $last['close'] > $last['sma_50'] : null,
            'above_sma_200' => $last && $last['sma_200'] !== null ? $last['close'] > $last['sma_200'] : null,
        ];
    }
}
