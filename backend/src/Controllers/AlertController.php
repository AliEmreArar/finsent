<?php

declare(strict_types=1);

namespace FinSent\Controllers;

use FinSent\Db;
use FinSent\Http;
use FinSent\HttpError;

/**
 * Price / indicator alerts. Created from the UI or by the agent; evaluated by
 * POST /api/alerts/check, which the dashboard calls every minute while it is open
 * (prices: Yahoo delayed quote, cached 60 s; RSI: latest daily value).
 */
final class AlertController
{
    public const KINDS = ['price_above', 'price_below', 'rsi_above', 'rsi_below', 'change_above', 'change_below'];

    /** @return array<string,mixed> */
    public static function create(string $symbol, string $kind, float $value, ?string $note = null): array
    {
        $symbol = Http::symbol($symbol);
        if (!in_array($kind, self::KINDS, true)) {
            throw new HttpError(400, 'kind: ' . implode('|', self::KINDS));
        }
        if (!Db::one('SELECT 1 FROM market_daily WHERE symbol = ? LIMIT 1', [$symbol])) {
            throw new HttpError(404, "$symbol bulunamadı");
        }
        Db::exec('INSERT INTO alerts (symbol, kind, value, note) VALUES (?, ?, ?, ?)', [$symbol, $kind, $value, $note ? mb_substr($note, 0, 250) : null]);
        $id = (int) Db::pdo()->lastInsertId();
        return ['id' => $id, 'symbol' => $symbol, 'kind' => $kind, 'value' => $value, 'note' => $note, 'text' => self::describe($symbol, $kind, $value)];
    }

    public static function describe(string $symbol, string $kind, float $value): string
    {
        $v = rtrim(rtrim(number_format($value, 2, ',', '.'), '0'), ',');
        return match ($kind) {
            'price_above' => "$symbol fiyatı $v üzerine çıkarsa",
            'price_below' => "$symbol fiyatı $v altına inerse",
            'rsi_above' => "$symbol RSI $v üzerine çıkarsa",
            'rsi_below' => "$symbol RSI $v altına inerse",
            'change_above' => "$symbol gün içinde %$v üzeri yükselirse",
            'change_below' => "$symbol gün içinde %$v üzeri düşerse",
        };
    }

    /** @return array<string,mixed> */
    public static function list(): array
    {
        $rows = Db::all('SELECT id, symbol, kind, value, note, active, created_at, triggered_at, triggered_value, seen
                           FROM alerts WHERE active = 1 OR triggered_at > DATE_SUB(NOW(), INTERVAL 7 DAY) ORDER BY active DESC, created_at DESC LIMIT 100');
        foreach ($rows as &$r) {
            $r['text'] = self::describe($r['symbol'], $r['kind'], (float) $r['value']);
        }
        return ['alerts' => $rows, 'unseen' => count(array_filter($rows, fn($r) => $r['triggered_at'] && !$r['seen']))];
    }

    /** @return array<string,mixed> */
    public static function createFromBody(): array
    {
        $b = Http::body();
        return self::create((string) ($b['symbol'] ?? ''), (string) ($b['kind'] ?? ''), (float) ($b['value'] ?? 0), $b['note'] ?? null);
    }

    /** @return array<string,mixed> */
    public static function delete(string $id): array
    {
        Db::exec('DELETE FROM alerts WHERE id = ?', [(int) $id]);
        return ['deleted' => (int) $id];
    }

    /** @return array<string,mixed> */
    public static function markSeen(): array
    {
        Db::exec('UPDATE alerts SET seen = 1 WHERE triggered_at IS NOT NULL');
        return ['ok' => true];
    }

    /** Evaluate active alerts; returns the ones that fired now. @return array<string,mixed> */
    public static function check(): array
    {
        $active = Db::all('SELECT * FROM alerts WHERE active = 1');
        $fired = [];
        $quotes = [];
        foreach ($active as $a) {
            $sym = $a['symbol'];
            $v = (float) $a['value'];
            $current = null;
            if (str_starts_with($a['kind'], 'rsi')) {
                $current = (float) (Db::one('SELECT rsi_14 FROM market_daily WHERE symbol = ? ORDER BY trade_date DESC LIMIT 1', [$sym])['rsi_14'] ?? 0);
            } else {
                if (!array_key_exists($sym, $quotes)) {
                    try {
                        $quotes[$sym] = MarketController::quote($sym);
                    } catch (\Throwable) {
                        $quotes[$sym] = null;
                    }
                }
                $q = $quotes[$sym];
                if (!$q) {
                    continue;
                }
                $current = str_starts_with($a['kind'], 'price') ? (float) $q['price'] : (float) $q['change_pct'];
            }
            $hit = match ($a['kind']) {
                'price_above', 'rsi_above' => $current > $v,
                'price_below', 'rsi_below' => $current < $v,
                'change_above' => $current >= $v,
                'change_below' => $current <= -abs($v),
            };
            if ($hit) {
                Db::exec('UPDATE alerts SET active = 0, triggered_at = NOW(), triggered_value = ? WHERE id = ?', [$current, $a['id']]);
                $fired[] = ['id' => (int) $a['id'], 'symbol' => $sym, 'kind' => $a['kind'], 'value' => $v, 'current' => round($current, 2),
                            'note' => $a['note'], 'text' => self::describe($sym, $a['kind'], $v)];
            }
        }
        return ['checked' => count($active), 'fired' => $fired];
    }
}
