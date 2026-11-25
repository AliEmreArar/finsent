<?php

declare(strict_types=1);

namespace FinSent\Controllers;

use FinSent\Config;
use FinSent\Db;
use FinSent\Http;
use FinSent\HttpError;
use FinSent\Services\StrategyAi;

/**
 * Strategy lab: market data for the in-browser backtester, Grok code generation / fixing /
 * review, and saved strategies. The backtest itself runs in the browser (Web Worker).
 */
final class StrategyController
{
    public const MAX_SYMBOLS = 40;
    private const WARMUP_DAYS = 420;   // calendar days of extra history for indicator warm-up (≈ 290 bars)

    // ------------------------------------------------------------------ data
    /** @return list<string> */
    public static function parseSymbols(?string $raw): array
    {
        $out = [];
        foreach (preg_split('/[\s,;]+/', strtoupper((string) $raw)) ?: [] as $s) {
            $s = str_replace('.IS', '', trim($s));
            if ($s === '') {
                continue;
            }
            if (!preg_match('/^[A-Z0-9]{2,12}$/', $s)) {
                throw new HttpError(400, "geçersiz sembol: $s");
            }
            $out[$s] = true;
        }
        $out = array_keys($out);
        if (!$out) {
            throw new HttpError(400, 'en az bir sembol seçin');
        }
        if (count($out) > self::MAX_SYMBOLS) {
            throw new HttpError(400, 'en fazla ' . self::MAX_SYMBOLS . ' sembol');
        }
        return $out;
    }

    /**
     * Columnar daily bars for several symbols plus a benchmark and daily KAP sentiment.
     * GET /api/strategy/data?symbols=THYAO,ASELS&from=2018-01-01&to=2026-11-01&currency=TRY&benchmark=XU100&sentiment=1
     * @return array<string,mixed>
     */
    public static function data(): array
    {
        $symbols = self::parseSymbols(Http::query('symbols'));
        $currency = strtoupper(Http::query('currency', 'TRY'));
        if (!in_array($currency, ['TRY', 'USD'], true)) {
            throw new HttpError(400, 'currency: TRY|USD');
        }
        $to = Http::dateQuery('to') ?? (Db::one('SELECT MAX(trade_date) AS d FROM market_daily WHERE symbol = ?', ['XU100'])['d'] ?? date('Y-m-d'));
        $from = Http::dateQuery('from') ?? (new \DateTimeImmutable($to))->modify('-5 years')->format('Y-m-d');
        if ($from >= $to) {
            throw new HttpError(400, 'from must be before to');
        }
        $warmFrom = (new \DateTimeImmutable($from))->modify('-' . self::WARMUP_DAYS . ' days')->format('Y-m-d');
        $withSentiment = Http::query('sentiment', '1') !== '0';

        $series = [];
        $missing = [];
        foreach ($symbols as $sym) {
            try {
                $bars = MarketController::loadBars($sym, '1d', 'all', $currency, $warmFrom, $to)['bars'];
            } catch (HttpError) {
                $bars = [];
            }
            if (!$bars) {
                $missing[] = $sym;
                continue;
            }
            $series[$sym] = self::columnar($bars) + ['instrument' => MarketController::isInstrument($sym)];
            if (MarketController::isInstrument($sym)) {
                $series[$sym]['noAdjust'] = true;   // FX / gold / index: big moves are real, never corporate actions
            }
            if ($withSentiment && !MarketController::isInstrument($sym)) {
                $series[$sym]['sentiment'] = self::dailySentiment($sym, $series[$sym]['date'], $warmFrom, $to);
            }
        }
        if (!$series) {
            throw new HttpError(404, 'seçilen semboller için veri yok: ' . implode(', ', $missing));
        }

        $benchmark = null;
        $bmSym = strtoupper(Http::query('benchmark', 'XU100'));
        if ($bmSym !== 'NONE' && preg_match('/^[A-Z0-9]{2,12}$/', $bmSym)) {
            try {
                $b = MarketController::loadBars($bmSym, '1d', 'all', $currency, $warmFrom, $to)['bars'];
                if ($b) {
                    $c = self::columnar($b);
                    $benchmark = ['name' => $bmSym, 'date' => $c['date'], 'close' => $c['close']];
                }
            } catch (HttpError) {
                $benchmark = null;
            }
        }
        $titles = [];
        foreach (Db::all('SELECT symbol, title FROM companies WHERE symbol IN (' . implode(',', array_fill(0, count($symbols), '?')) . ')', $symbols) as $r) {
            $titles[$r['symbol']] = $r['title'];
        }
        return ['from' => $from, 'to' => $to, 'warmup_from' => $warmFrom, 'currency' => $currency,
                'series' => $series, 'benchmark' => $benchmark, 'missing' => $missing, 'titles' => $titles];
    }

    /** @param list<array<string,mixed>> $bars @return array<string,mixed> */
    public static function columnar(array $bars): array
    {
        $d = $o = $h = $l = $c = $v = [];
        foreach ($bars as $b) {
            if ($b['close'] === null) {
                continue;
            }
            $close = (float) $b['close'];
            $d[] = substr((string) $b['trade_date'], 0, 10);
            // pre-2025-11 history has no real open: the stored open is the previous close (open_is_estimated)
            $o[] = $b['open'] !== null ? round((float) $b['open'], 4) : round($close, 4);
            $h[] = $b['high'] !== null ? round((float) $b['high'], 4) : round($close, 4);
            $l[] = $b['low'] !== null ? round((float) $b['low'], 4) : round($close, 4);
            $c[] = round($close, 4);
            $v[] = $b['volume_try'] !== null ? (int) round((float) $b['volume_try']) : 0;
        }
        return ['date' => $d, 'open' => $o, 'high' => $h, 'low' => $l, 'close' => $c, 'volume' => $v];
    }

    /**
     * Average sentiment of the disclosures that became tradable on each bar. A disclosure's
     * event_date (first trading day the market could react, after 18:00 → next day) is used when
     * known; otherwise the first bar on or after its publication date.
     * @param list<string> $dates
     * @return list<float|null>
     */
    private static function dailySentiment(string $symbol, array $dates, string $from, string $to): array
    {
        $rows = Db::all(
            'SELECT COALESCE(e.event_date, DATE(d.published_at)) AS day, HOUR(d.published_at) AS hr, e.event_date IS NOT NULL AS exact, s.score
               FROM disclosures d JOIN v_sentiment s USING (disclosure_id)
               LEFT JOIN event_returns e USING (disclosure_id)
              WHERE d.symbol = ? AND d.published_at BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)',
            [$symbol, $from, $to]
        );
        return self::alignSentiment($dates, $rows);
    }

    /**
     * @param list<string> $dates trading days, ascending
     * @param list<array{day:string,hr:int|string|null,exact:int|string|bool,score:float|string}> $rows
     * @return list<float|null>
     */
    public static function alignSentiment(array $dates, array $rows): array
    {
        $sum = $cnt = [];
        $n = count($dates);
        foreach ($rows as $r) {
            $day = (string) $r['day'];
            // without a stored event date, news published after the 18:00 close counts for the next session
            $strictlyAfter = !$r['exact'] && (int) ($r['hr'] ?? 0) >= 18;
            $lo = 0;
            $hi = $n;
            while ($lo < $hi) {   // first index with date >= day (or > day when strictlyAfter)
                $mid = intdiv($lo + $hi, 2);
                if ($dates[$mid] < $day || ($strictlyAfter && $dates[$mid] === $day)) {
                    $lo = $mid + 1;
                } else {
                    $hi = $mid;
                }
            }
            if ($lo >= $n) {
                continue;
            }
            $sum[$lo] = ($sum[$lo] ?? 0) + (float) $r['score'];
            $cnt[$lo] = ($cnt[$lo] ?? 0) + 1;
        }
        $out = array_fill(0, $n, null);
        foreach ($sum as $k => $s) {
            $out[$k] = round($s / $cnt[$k], 4);
        }
        return $out;
    }

    /**
     * The most liquid stocks as of a date (by average traded value over the prior ~6 months), so a
     * basket can be picked without survivorship bias from today's winners.
     * @return array<string,mixed>
     */
    public static function universe(): array
    {
        $n = Http::intQuery('n', 20, 2, self::MAX_SYMBOLS);
        $asOf = Http::dateQuery('as_of') ?? (Db::one('SELECT MAX(trade_date) AS d FROM market_daily')['d'] ?? date('Y-m-d'));
        $rows = Db::all(
            "SELECT m.symbol, c.title, AVG(m.volume_try) AS avg_value, COUNT(*) AS days
               FROM market_daily m LEFT JOIN companies c ON c.symbol = m.symbol
              WHERE m.trade_date BETWEEN DATE_SUB(?, INTERVAL 182 DAY) AND ? AND m.source <> 'instrument'
              GROUP BY m.symbol, c.title HAVING days >= 60
              ORDER BY avg_value DESC LIMIT $n",
            [$asOf, $asOf]
        );
        return ['as_of' => $asOf, 'symbols' => array_column($rows, 'symbol'), 'rows' => $rows];
    }

    // ------------------------------------------------------------------ LLM
    /** @return array<string,mixed> */
    public static function generate(): array
    {
        $b = Http::body();
        $prompt = trim((string) ($b['prompt'] ?? ''));
        if ($prompt === '') {
            throw new HttpError(400, 'strateji açıklaması boş');
        }
        if (!StrategyAi::enabled()) {
            return ['fallback' => true, 'reason' => 'XAI_API_KEY tanımlı değil: tarayıcıdaki kural tabanlı çevirici kullanılacak.'];
        }
        $symbols = [];
        foreach ((array) ($b['symbols'] ?? []) as $s) {
            if (is_string($s) && preg_match('/^[A-Z0-9]{2,12}$/', strtoupper($s))) {
                $symbols[] = strtoupper($s);
            }
        }
        $history = array_values(array_filter((array) ($b['history'] ?? []), 'is_array'));
        $ai = new StrategyAi();
        $t = microtime(true);
        try {
            $out = $ai->generate($prompt, isset($b['code']) ? (string) $b['code'] : null, array_slice($symbols, 0, self::MAX_SYMBOLS), $history);
        } catch (\Throwable $e) {
            error_log('[finsent] strategy generate failed: ' . $e->getMessage());
            return ['fallback' => true, 'reason' => 'Grok\'a ulaşılamadı: kural tabanlı çevirici kullanılacak.'];
        }
        return $out + ['model' => $ai->model(), 'latency_ms' => (int) round((microtime(true) - $t) * 1000)];
    }

    /** @return array<string,mixed> */
    public static function fix(): array
    {
        $b = Http::body();
        $code = (string) ($b['code'] ?? '');
        $error = (string) ($b['error'] ?? '');
        if (trim($code) === '' || trim($error) === '') {
            throw new HttpError(400, 'code ve error gerekli');
        }
        if (!StrategyAi::enabled()) {
            throw new HttpError(503, 'Otomatik düzeltme için XAI_API_KEY gerekli');
        }
        $ai = new StrategyAi();
        try {
            return $ai->fix($code, $error) + ['model' => $ai->model()];
        } catch (\Throwable $e) {
            error_log('[finsent] strategy fix failed: ' . $e->getMessage());
            throw new HttpError(502, 'Grok\'a ulaşılamadı');
        }
    }

    /** @return array<string,mixed> */
    public static function review(): array
    {
        $report = Http::body();
        if (!isset($report['metrics']) || !is_array($report['metrics'])) {
            throw new HttpError(400, 'metrics gerekli');
        }
        if (isset($report['code'])) {
            $report['code'] = mb_substr((string) $report['code'], 0, 12000);
        }
        if (StrategyAi::enabled() && Http::query('offline') !== '1') {
            try {
                return (new StrategyAi())->review($report);
            } catch (\Throwable $e) {
                error_log('[finsent] strategy review failed: ' . $e->getMessage());
            }
        }
        return StrategyAi::offlineReview($report);
    }

    /** @return array<string,mixed> */
    public static function status(): array
    {
        return ['llm' => StrategyAi::enabled(), 'model' => StrategyAi::enabled() ? (string) Config::get('XAI_STRATEGY_MODEL', Config::xaiModel()) : null,
                'max_symbols' => self::MAX_SYMBOLS];
    }

    // ------------------------------------------------------------------ saved strategies
    private static bool $ensured = false;

    /** The table is in schema.sql; this also creates it on databases initialised before it existed. */
    public static function ensureTable(): void
    {
        if (self::$ensured) {
            return;
        }
        Db::exec("CREATE TABLE IF NOT EXISTS strategies (
            id          BIGINT AUTO_INCREMENT PRIMARY KEY,
            name        VARCHAR(120) NOT NULL,
            description TEXT         NULL,
            prompt      TEXT         NULL,
            code        MEDIUMTEXT   NOT NULL,
            config      JSON         NOT NULL,
            last_result JSON         NULL,
            created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB");
        self::$ensured = true;
    }

    /** @return array<string,mixed> */
    public static function list(): array
    {
        self::ensureTable();
        $rows = Db::all('SELECT id, name, description, config, last_result, created_at, updated_at FROM strategies ORDER BY updated_at DESC LIMIT 200');
        foreach ($rows as &$r) {
            $r['config'] = json_decode((string) $r['config'], true);
            $r['last_result'] = $r['last_result'] !== null ? json_decode((string) $r['last_result'], true) : null;
        }
        return ['strategies' => $rows];
    }

    /** @return array<string,mixed> */
    public static function show(string $id): array
    {
        self::ensureTable();
        $row = Db::one('SELECT * FROM strategies WHERE id = ?', [(int) $id]);
        if (!$row) {
            throw new HttpError(404, 'strateji bulunamadı');
        }
        $row['config'] = json_decode((string) $row['config'], true);
        $row['last_result'] = $row['last_result'] !== null ? json_decode((string) $row['last_result'], true) : null;
        return $row;
    }

    /** Create (no id) or update (id) a strategy. @return array<string,mixed> */
    public static function save(): array
    {
        self::ensureTable();
        $b = Http::body();
        $name = trim((string) ($b['name'] ?? ''));
        $code = (string) ($b['code'] ?? '');
        if ($name === '' || trim($code) === '') {
            throw new HttpError(400, 'isim ve kod gerekli');
        }
        if (strlen($code) > 200000) {
            throw new HttpError(400, 'kod çok uzun');
        }
        $config = is_array($b['config'] ?? null) ? $b['config'] : [];
        $result = is_array($b['last_result'] ?? null) ? $b['last_result'] : null;
        $json = fn($v) => $v === null ? null : json_encode($v, JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
        $args = [mb_substr($name, 0, 120), isset($b['description']) ? mb_substr((string) $b['description'], 0, 2000) : null,
                 isset($b['prompt']) ? mb_substr((string) $b['prompt'], 0, 8000) : null, $code, $json($config), $json($result)];
        if (!empty($b['id'])) {
            $n = Db::exec('UPDATE strategies SET name = ?, description = ?, prompt = ?, code = ?, config = ?, last_result = ? WHERE id = ?',
                [...$args, (int) $b['id']]);
            if ($n === 0 && !Db::one('SELECT 1 FROM strategies WHERE id = ?', [(int) $b['id']])) {
                throw new HttpError(404, 'strateji bulunamadı');
            }
            return ['id' => (int) $b['id'], 'saved' => true];
        }
        Db::exec('INSERT INTO strategies (name, description, prompt, code, config, last_result) VALUES (?, ?, ?, ?, ?, ?)', $args);
        return ['id' => (int) Db::pdo()->lastInsertId(), 'saved' => true];
    }

    /** @return array<string,mixed> */
    public static function delete(string $id): array
    {
        self::ensureTable();
        return ['deleted' => Db::exec('DELETE FROM strategies WHERE id = ?', [(int) $id]) > 0];
    }
}
