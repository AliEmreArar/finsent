<?php

declare(strict_types=1);

namespace FinSent\Controllers;

use FinSent\Db;
use FinSent\Http;
use FinSent\HttpError;

/** Chart drawings per symbol (stored as anchors: time in naive-UTC ms + price). */
final class DrawingController
{
    private const TYPES = ['trend', 'hline', 'channel', 'fib', 'rect'];

    /** @return array<string,mixed> */
    public static function show(string $symbol): array
    {
        $symbol = Http::symbol($symbol);
        $row = Db::one('SELECT payload, updated_at FROM drawings WHERE symbol = ?', [$symbol]);
        return ['symbol' => $symbol, 'drawings' => $row ? json_decode((string) $row['payload'], true) : [], 'updated_at' => $row['updated_at'] ?? null];
    }

    /** @return array<string,mixed> */
    public static function save(string $symbol): array
    {
        $symbol = Http::symbol($symbol);
        $list = Http::body()['drawings'] ?? null;
        if (!is_array($list) || count($list) > 200) {
            throw new HttpError(400, 'drawings must be a list (max 200)');
        }
        $clean = [];
        foreach ($list as $d) {
            if (!in_array($d['type'] ?? '', self::TYPES, true) || !is_array($d['pts'] ?? null)) {
                continue;
            }
            $pts = array_values(array_filter(array_map(fn($p) => is_numeric($p['t'] ?? null) && is_numeric($p['p'] ?? null)
                ? ['t' => (float) $p['t'], 'p' => (float) $p['p']] : null, array_slice($d['pts'], 0, 3))));
            if (!$pts) {
                continue;
            }
            $clean[] = ['id' => substr((string) ($d['id'] ?? uniqid()), 0, 40), 'type' => $d['type'], 'pts' => $pts,
                        'ccy' => ($d['ccy'] ?? 'TRY') === 'USD' ? 'USD' : 'TRY', 'src' => ($d['src'] ?? 'user') === 'agent' ? 'agent' : 'user',
                        'label' => isset($d['label']) ? mb_substr((string) $d['label'], 0, 60) : null];
        }
        Db::exec('REPLACE INTO drawings (symbol, payload) VALUES (?, ?)', [$symbol, json_encode($clean, JSON_UNESCAPED_UNICODE)]);
        return ['symbol' => $symbol, 'saved' => count($clean)];
    }

    /**
     * Drawings with their meaning against today's daily close (for the agent):
     * trend/channel value now, slope, where price sits; Fibonacci levels; box bounds.
     * @return array<string,mixed>
     */
    public static function summarise(string $symbol): array
    {
        $list = self::show($symbol)['drawings'];
        if (!$list) {
            return ['symbol' => $symbol, 'drawings' => [], 'note' => 'Kullanıcı bu hisse üzerinde çizim yapmamış.'];
        }
        $last = Db::one('SELECT trade_date, close, usd_try FROM market_daily WHERE symbol = ? ORDER BY trade_date DESC LIMIT 1', [$symbol]);
        $nowMs = strtotime($last['trade_date'] . ' 00:00:00 UTC') * 1000;
        $closeTry = (float) $last['close'];
        $fmt = fn(float $ms) => gmdate('Y-m-d H:i', (int) ($ms / 1000));
        $at = fn(array $a, array $b, float $ms) => $a['p'] + ($b['p'] - $a['p']) * (($ms - $a['t']) / (($b['t'] - $a['t']) ?: 1));
        $out = [];
        foreach ($list as $d) {
            $close = $d['ccy'] === 'USD' && in_array($symbol, MarketController::USD_QUOTED, true) === false
                ? $closeTry / max(1e-9, (float) $last['usd_try']) : $closeTry;
            $rel = fn(float $v) => $v ? round(($close / $v - 1) * 100, 2) : null;
            $o = ['type' => $d['type'], 'by' => $d['src'], 'label' => $d['label'], 'currency' => $d['ccy'],
                  'points' => array_map(fn($p) => ['time' => $fmt($p['t']), 'price' => round($p['p'], 4)], $d['pts'])];
            [$a, $b] = [$d['pts'][0], $d['pts'][1] ?? null];
            if ($d['type'] === 'hline') {
                $o += ['level' => $a['p'], 'price_vs_level_pct' => $rel($a['p'])];
            } elseif (($d['type'] === 'trend' || $d['type'] === 'channel') && $b) {
                $now = $at($a, $b, $nowMs);
                $perDay = ($b['p'] - $a['p']) / ((($b['t'] - $a['t']) ?: 1) / 864e5);
                $o += ['line_value_now' => round($now, 4), 'slope_per_day' => round($perDay, 4), 'price_vs_line_pct' => $rel($now)];
                if ($d['type'] === 'channel' && isset($d['pts'][2])) {
                    $off = $d['pts'][2]['p'] - $at($a, $b, $d['pts'][2]['t']);
                    $o += ['other_line_now' => round($now + $off, 4), 'channel_width_pct' => round(abs($off) / max(1e-9, abs($now)) * 100, 2),
                           'position_in_channel_pct' => round(($close - min($now, $now + $off)) / abs($off ?: 1) * 100, 1)];
                }
            } elseif ($d['type'] === 'fib' && $b) {
                $o['levels'] = array_map(fn($f) => ['ratio' => $f, 'price' => round($b['p'] - ($b['p'] - $a['p']) * $f, 4)], [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]);
            } elseif ($d['type'] === 'rect' && $b) {
                $o += ['top' => max($a['p'], $b['p']), 'bottom' => min($a['p'], $b['p']), 'from' => $fmt(min($a['t'], $b['t'])), 'to' => $fmt(max($a['t'], $b['t']))];
            }
            $out[] = $o;
        }
        return ['symbol' => $symbol, 'as_of' => $last['trade_date'], 'close' => $closeTry, 'drawings' => $out];
    }
}
