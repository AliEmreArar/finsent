<?php

declare(strict_types=1);

namespace FinSent\Controllers;

use FinSent\Config;
use FinSent\Db;
use FinSent\Http;
use FinSent\HttpError;
use FinSent\Services\ClaudeClient;
use FinSent\Services\GrokClient;
use FinSent\Services\LexiconSentiment;

/** Real-time analysis: sentiment for arbitrary text and LLM interpretation of a symbol's signals. */
final class AnalysisController
{
    private static function lexicon(): LexiconSentiment
    {
        return new LexiconSentiment(Config::resourcesDir() . '/lexicon_tr.json');
    }

    /** The configured LLM client (Claude or Grok); both expose sentiment() and insight(). */
    private static function llm(): ClaudeClient|GrokClient
    {
        return Config::llmProvider() === 'xai'
            ? new GrokClient(Config::xaiModel(), Config::xaiModel())
            : new ClaudeClient(Config::llmModel());
    }

    /** @return array<string,mixed> */
    public static function analyze(): array
    {
        $body = Http::body();
        $text = trim((string) ($body['text'] ?? ''));
        if ($text === '' || mb_strlen($text) > 20000) {
            throw new HttpError(400, 'text is required (max 20000 chars)');
        }
        $symbol = isset($body['symbol']) && $body['symbol'] !== '' ? Http::symbol((string) $body['symbol']) : null;
        $started = microtime(true);
        $result = null;
        $warning = null;
        if (Config::llmEnabled() && ($body['provider'] ?? 'auto') !== 'lexicon') {
            try {
                $result = self::llm()->sentiment($text, $symbol);
            } catch (\Throwable $e) {
                $warning = 'LLM unavailable, used lexicon fallback: ' . $e->getMessage();
                error_log('[finsent] ' . $warning);
            }
        }
        $result ??= self::lexicon()->analyze($text);
        $result['latency_ms'] = (int) round((microtime(true) - $started) * 1000);
        if ($warning) {
            $result['warning'] = $warning;
        }
        return $result;
    }

    /** @return array<string,mixed> */
    public static function insight(string $symbol): array
    {
        $symbol = Http::symbol($symbol);
        $asOf = Db::one('SELECT MAX(trade_date) AS d FROM market_daily WHERE symbol = ?', [$symbol])['d'];
        if ($asOf === null) {
            throw new HttpError(404, "no market data for $symbol");
        }
        $bars = Db::all('SELECT trade_date, close, pct_change, rsi_14, macd_hist, sma_50, sma_200, bb_lower, bb_upper
                           FROM market_daily WHERE symbol = ? AND trade_date <= ? ORDER BY trade_date DESC LIMIT 60',
                        [$symbol, $asOf]);
        $last = $bars[0];
        $first = end($bars);
        $patterns = Db::all('SELECT trade_date, pattern, direction, ROUND(strength, 2) AS strength FROM patterns
                              WHERE symbol = ? AND trade_date > DATE_SUB(?, INTERVAL 30 DAY)
                              ORDER BY trade_date DESC LIMIT 25', [$symbol, $asOf]);
        $disclosures = Db::all('SELECT DATE(d.published_at) AS day, d.subject, s.label, ROUND(s.score, 2) AS score,
                                       s.event_type, s.key_points
                                  FROM disclosures d JOIN v_sentiment s USING (disclosure_id)
                                 WHERE d.symbol = ? AND d.published_at > DATE_SUB(?, INTERVAL 60 DAY)
                                 ORDER BY d.published_at DESC LIMIT 15', [$symbol, $asOf]);
        foreach ($disclosures as &$d) {
            $d['key_points'] = json_decode((string) $d['key_points'], true);
        }
        unset($d);
        $social = Db::one('SELECT as_of, label, ROUND(score, 2) AS score, summary, themes FROM social_sentiment
                            WHERE symbol = ? ORDER BY as_of DESC LIMIT 1', [$symbol]);
        if ($social) {
            $social['themes'] = json_decode((string) $social['themes'], true);
        }
        $context = [
            'symbol' => $symbol,
            'as_of' => $asOf,
            'price' => [
                'close' => (float) $last['close'],
                'return_60d' => $first ? round($last['close'] / $first['close'] - 1, 4) : null,
                'rsi_14' => $last['rsi_14'] !== null ? round((float) $last['rsi_14'], 1) : null,
                'above_sma_50' => $last['sma_50'] !== null ? $last['close'] > $last['sma_50'] : null,
                'above_sma_200' => $last['sma_200'] !== null ? $last['close'] > $last['sma_200'] : null,
                'macd_hist' => $last['macd_hist'] !== null ? round((float) $last['macd_hist'], 4) : null,
            ],
            'patterns_last_30d' => $patterns,
            'disclosures_last_60d' => $disclosures,
            'social_sentiment_x' => $social,
            'direction_forecast' => self::forecastContext($symbol),
        ];
        $hash = hash('sha256', (string) json_encode($context, JSON_UNESCAPED_UNICODE));
        $useLlm = Config::llmEnabled();
        $provider = $useLlm ? Config::llmProvider() : 'rules';

        $cached = Db::one('SELECT payload, created_at FROM llm_insights
                            WHERE symbol = ? AND as_of = ? AND input_hash = ? AND provider = ?',
                          [$symbol, $asOf, $hash, $provider]);
        if ($cached) {
            return ['cached' => true, 'context' => $context] + json_decode((string) $cached['payload'], true);
        }

        $payload = null;
        if ($useLlm) {
            try {
                $payload = self::llm()->insight($context);
            } catch (\Throwable $e) {
                error_log('[finsent] insight LLM failed: ' . $e->getMessage());
            }
        }
        $payload ??= self::ruleBasedInsight($context);
        Db::exec('INSERT IGNORE INTO llm_insights (symbol, as_of, input_hash, provider, model, payload)
                  VALUES (?, ?, ?, ?, ?, ?)',
                 [$symbol, $asOf, $hash, $payload['provider'], $payload['model'],
                  json_encode($payload, JSON_UNESCAPED_UNICODE)]);
        return ['cached' => false, 'context' => $context] + $payload;
    }

    /** Compact view of the stored forecast for the LLM (probabilities + analog medians). */
    private static function forecastContext(string $symbol): ?array
    {
        $row = Db::one('SELECT payload FROM forecasts WHERE symbol = ? ORDER BY as_of DESC LIMIT 1', [$symbol]);
        if (!$row) {
            return null;
        }
        $f = json_decode((string) $row['payload'], true);
        return array_map(fn($h) => [
            'days' => $h['days'], 'p_up' => round($h['p_up'], 2),
            'p_up_model' => isset($h['p_up_model']) ? round($h['p_up_model'], 2) : null,
            'model_out_of_sample_auc' => isset($h['model_auc']) ? round($h['model_auc'], 3) : null,
            'analog_p_up' => isset($h['p_up_analog']) ? round($h['p_up_analog'], 2) : null,
            'analog_median_return' => isset($h['analog_median']) ? round($h['analog_median'], 4) : null,
        ], $f['horizons'] ?? []);
    }

    /** Deterministic summary used when no LLM is configured. @return array<string,mixed> */
    private static function ruleBasedInsight(array $ctx): array
    {
        $bull = $bear = 0.0;
        $signals = [];
        foreach ($ctx['patterns_last_30d'] as $p) {
            if ($p['direction'] === 'bullish') {
                $bull += (float) $p['strength'];
            } elseif ($p['direction'] === 'bearish') {
                $bear += (float) $p['strength'];
            }
        }
        $sent = array_sum(array_map(fn($d) => (float) $d['score'], $ctx['disclosures_last_60d']));
        $price = $ctx['price'];
        if ($price['above_sma_200'] !== null) {
            $signals[] = $price['above_sma_200'] ? 'Fiyat 200 günlük ortalamanın üzerinde (uzun vadeli trend pozitif).'
                                                 : 'Fiyat 200 günlük ortalamanın altında (uzun vadeli trend negatif).';
        }
        if ($price['rsi_14'] !== null) {
            $rsi = $price['rsi_14'];
            $signals[] = $rsi > 70 ? "RSI $rsi: aşırı alım bölgesi." : ($rsi < 30 ? "RSI $rsi: aşırı satım bölgesi." : "RSI $rsi: nötr bölge.");
        }
        $signals[] = sprintf('Son 30 günde formasyon skoru: yükseliş %.2f / düşüş %.2f.', $bull, $bear);
        $signals[] = sprintf('Son 60 günde %d KAP bildirimi, toplam duygu skoru %.2f.', count($ctx['disclosures_last_60d']), $sent);
        $tech = $bull - $bear;
        $bias = ($tech > 0.5 && $sent >= 0) || ($sent > 0.5 && $tech >= 0) ? 'bullish'
            : ((($tech < -0.5 && $sent <= 0) || ($sent < -0.5 && $tech <= 0)) ? 'bearish'
            : (abs($tech) < 0.5 && abs($sent) < 0.5 ? 'neutral' : 'mixed'));
        return [
            'summary' => "{$ctx['symbol']} için teknik formasyonlar ve KAP bildirim duygusu kural tabanlı olarak birleştirildi "
                . "(LLM yapılandırılmadığı için). Genel görünüm: $bias.",
            'bias' => $bias,
            'signals' => $signals,
            'risks' => ['Kural tabanlı özet; haber içeriğinin bağlamını değerlendirmez.',
                        'Açılış fiyatları önceki kapanıştan tahmin edildiği için mum formasyonlarının güvenilirliği sınırlıdır.'],
            'provider' => 'rules',
            'model' => 'rules-v1',
        ];
    }
}
