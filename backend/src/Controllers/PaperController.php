<?php

declare(strict_types=1);

namespace FinSent\Controllers;

use FinSent\Db;
use FinSent\Http;
use FinSent\HttpError;

/**
 * Virtual (paper) portfolios: start with virtual TL, buy and sell at the latest price (Yahoo
 * delayed quote while the market is open, otherwise the last stored close), track positions,
 * P&L and the equity curve against BIST 100. Positions are derived from the trade log.
 */
final class PaperController
{
    public const DEFAULT_FEE_BPS = 10.0;
    private static bool $ensured = false;

    public static function ensureTables(): void
    {
        if (self::$ensured) {
            return;
        }
        Db::exec("CREATE TABLE IF NOT EXISTS paper_accounts (
            id           BIGINT AUTO_INCREMENT PRIMARY KEY,
            name         VARCHAR(120) NOT NULL,
            initial_cash DOUBLE       NOT NULL,
            fee_bps      DOUBLE       NOT NULL DEFAULT 10,
            strategy_id  BIGINT       NULL,
            created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB");
        Db::exec("CREATE TABLE IF NOT EXISTS paper_trades (
            id          BIGINT AUTO_INCREMENT PRIMARY KEY,
            account_id  BIGINT       NOT NULL,
            symbol      VARCHAR(12)  NOT NULL,
            side        ENUM('buy','sell') NOT NULL,
            shares      DOUBLE       NOT NULL,
            price       DOUBLE       NOT NULL,
            fee         DOUBLE       NOT NULL,
            price_source VARCHAR(16) NOT NULL,
            note        VARCHAR(255) NULL,
            traded_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
            KEY idx_paper_acc (account_id, traded_at),
            CONSTRAINT fk_paper_acc FOREIGN KEY (account_id) REFERENCES paper_accounts (id) ON DELETE CASCADE
        ) ENGINE=InnoDB");
        self::$ensured = true;
    }

    // ------------------------------------------------------------------ pure portfolio maths (tested)
    /**
     * Replays trades into cash and positions (average-cost basis, realised P&L per sale).
     * @param list<array{symbol:string,side:string,shares:float|int|string,price:float|int|string,fee:float|int|string}> $trades
     * @return array{cash: float, positions: array<string, array{shares: float, cost: float, avg_price: float}>, realised: float, fees: float}
     */
    public static function replay(float $initialCash, array $trades): array
    {
        $cash = $initialCash;
        $pos = [];
        $realised = 0.0;
        $fees = 0.0;
        foreach ($trades as $t) {
            $sym = $t['symbol'];
            $n = (float) $t['shares'];
            $px = (float) $t['price'];
            $fee = (float) $t['fee'];
            $fees += $fee;
            if ($t['side'] === 'buy') {
                $cash -= $n * $px + $fee;
                $p = $pos[$sym] ?? ['shares' => 0.0, 'cost' => 0.0];
                $p['shares'] += $n;
                $p['cost'] += $n * $px + $fee;
                $pos[$sym] = $p;
            } else {
                $p = $pos[$sym] ?? null;
                if (!$p || $p['shares'] <= 0) {
                    continue;
                }
                $n = min($n, $p['shares']);
                $costPart = $p['cost'] * $n / $p['shares'];
                $cash += $n * $px - $fee;
                $realised += $n * $px - $fee - $costPart;
                $p['shares'] -= $n;
                $p['cost'] -= $costPart;
                if ($p['shares'] <= 1e-9) {
                    unset($pos[$sym]);
                } else {
                    $pos[$sym] = $p;
                }
            }
        }
        foreach ($pos as &$p) {
            $p['avg_price'] = $p['shares'] > 0 ? $p['cost'] / $p['shares'] : 0.0;
        }
        return ['cash' => $cash, 'positions' => $pos, 'realised' => $realised, 'fees' => $fees];
    }

    /**
     * Validates an order against the current state and returns the fill (whole shares).
     * @param array{cash: float, positions: array<string, array{shares: float}>} $state
     * @return array{shares: int, fee: float, gross: float}
     */
    public static function sizeOrder(array $state, string $symbol, string $side, float $price, ?float $shares, ?float $amount, float $feeBps): array
    {
        if ($price <= 0) {
            throw new HttpError(400, 'geçersiz fiyat');
        }
        $k = $feeBps / 1e4;
        if ($side === 'buy') {
            $n = $shares !== null ? floor($shares) : floor(min((float) $amount, $state['cash']) / ($price * (1 + $k)));
            if ($n <= 0) {
                throw new HttpError(400, 'tutar en az 1 lot almaya yetmiyor');
            }
            $gross = $n * $price;
            if ($gross * (1 + $k) > $state['cash'] + 1e-6) {
                throw new HttpError(400, 'yetersiz sanal bakiye');
            }
        } elseif ($side === 'sell') {
            $held = $state['positions'][$symbol]['shares'] ?? 0.0;
            if ($held <= 0) {
                throw new HttpError(400, "$symbol pozisyonu yok");
            }
            $n = $shares !== null ? floor($shares) : ($amount !== null ? floor($amount / $price) : $held);
            $n = min($n, $held);
            if ($n <= 0) {
                throw new HttpError(400, 'satılacak adet 0');
            }
            $gross = $n * $price;
        } else {
            throw new HttpError(400, 'side: buy|sell');
        }
        return ['shares' => (int) $n, 'fee' => round($gross * $k, 4), 'gross' => $gross];
    }

    // ------------------------------------------------------------------ prices
    /** @return array{price: float, source: string, as_of: string} */
    public static function price(string $symbol): array
    {
        $last = Db::one('SELECT trade_date, close FROM market_daily WHERE symbol = ? ORDER BY trade_date DESC LIMIT 1', [$symbol]);
        if (!$last) {
            throw new HttpError(404, "$symbol için fiyat yok");
        }
        if (Http::query('live', '1') !== '0') {
            try {
                $q = MarketController::quote($symbol);
                if (!empty($q['price']) && !empty($q['market_time']) && substr((string) $q['market_time'], 0, 10) >= (string) $last['trade_date']) {
                    return ['price' => (float) $q['price'], 'source' => 'gecikmeli canlı', 'as_of' => (string) $q['market_time']];
                }
            } catch (\Throwable) {
                // Yahoo unreachable: fall back to the stored close
            }
        }
        return ['price' => (float) $last['close'], 'source' => 'son kapanış', 'as_of' => (string) $last['trade_date']];
    }

    // ------------------------------------------------------------------ endpoints
    /** @return array<string,mixed> */
    public static function list(): array
    {
        self::ensureTables();
        $out = [];
        foreach (Db::all('SELECT * FROM paper_accounts ORDER BY created_at DESC') as $a) {
            $out[] = self::summary($a, false);
        }
        return ['accounts' => $out];
    }

    /** @return array<string,mixed> */
    public static function create(): array
    {
        self::ensureTables();
        $b = Http::body();
        $name = trim((string) ($b['name'] ?? '')) ?: 'Sanal portföy';
        $cash = (float) ($b['initial_cash'] ?? 100000);
        $fee = isset($b['fee_bps']) ? (float) $b['fee_bps'] : self::DEFAULT_FEE_BPS;
        if ($cash < 1000 || $cash > 1e10) {
            throw new HttpError(400, 'başlangıç bakiyesi 1.000 ile 10 milyar arasında olmalı');
        }
        if ($fee < 0 || $fee > 200) {
            throw new HttpError(400, 'komisyon 0-200 binde arası');
        }
        Db::exec('INSERT INTO paper_accounts (name, initial_cash, fee_bps, strategy_id) VALUES (?, ?, ?, ?)',
            [mb_substr($name, 0, 120), $cash, $fee, isset($b['strategy_id']) ? (int) $b['strategy_id'] : null]);
        return ['id' => (int) Db::pdo()->lastInsertId()];
    }

    /** @return array<string,mixed> */
    private static function account(string $id): array
    {
        self::ensureTables();
        $a = Db::one('SELECT * FROM paper_accounts WHERE id = ?', [(int) $id]);
        if (!$a) {
            throw new HttpError(404, 'portföy bulunamadı');
        }
        return $a;
    }

    /** @return list<array<string,mixed>> */
    private static function trades(int $id): array
    {
        return Db::all('SELECT id, symbol, side, shares, price, fee, price_source, note, traded_at FROM paper_trades WHERE account_id = ? ORDER BY traded_at, id', [$id]);
    }

    /** @return array<string,mixed> */
    public static function show(string $id): array
    {
        return self::summary(self::account($id), true);
    }

    /** @param array<string,mixed> $a @return array<string,mixed> */
    private static function summary(array $a, bool $full): array
    {
        $id = (int) $a['id'];
        $trades = self::trades($id);
        $st = self::replay((float) $a['initial_cash'], $trades);
        $positions = [];
        $value = $st['cash'];
        foreach ($st['positions'] as $sym => $p) {
            $last = Db::one('SELECT trade_date, close, pct_change FROM market_daily WHERE symbol = ? ORDER BY trade_date DESC LIMIT 1', [$sym]);
            $px = $last ? (float) $last['close'] : $p['avg_price'];
            $mv = $p['shares'] * $px;
            $value += $mv;
            $positions[] = ['symbol' => $sym, 'shares' => $p['shares'], 'avg_price' => $p['avg_price'], 'cost' => $p['cost'],
                            'price' => $px, 'as_of' => $last['trade_date'] ?? null, 'day_change' => $last['pct_change'] ?? null,
                            'value' => $mv, 'pnl' => $mv - $p['cost'], 'pnl_pct' => $p['cost'] > 0 ? $mv / $p['cost'] - 1 : null];
        }
        usort($positions, fn($x, $y) => $y['value'] <=> $x['value']);
        foreach ($positions as &$p) {
            $p['weight'] = $value > 0 ? $p['value'] / $value : 0;
        }
        unset($p);
        $out = ['id' => $id, 'name' => $a['name'], 'initial_cash' => (float) $a['initial_cash'], 'fee_bps' => (float) $a['fee_bps'],
                'created_at' => $a['created_at'], 'cash' => $st['cash'], 'value' => $value, 'pnl' => $value - (float) $a['initial_cash'],
                'return' => $value / (float) $a['initial_cash'] - 1, 'realised' => $st['realised'], 'fees' => $st['fees'],
                'positions' => $positions, 'trade_count' => count($trades), 'strategy_id' => $a['strategy_id'] !== null ? (int) $a['strategy_id'] : null];
        if ($full) {
            $out['trades'] = array_reverse($trades);
            $out['history'] = self::history($a, $trades);
        }
        return $out;
    }

    /**
     * Daily equity from the account's start, valued at stored closes, and BIST 100 rebased.
     * @param array<string,mixed> $a
     * @param list<array<string,mixed>> $trades
     * @return array<string,mixed>
     */
    public static function history(array $a, array $trades): array
    {
        $start = substr((string) $a['created_at'], 0, 10);
        if ($trades) {
            $start = min($start, substr((string) $trades[0]['traded_at'], 0, 10));
        }
        $syms = array_values(array_unique(array_column($trades, 'symbol')));
        $closes = [];
        foreach (array_merge($syms, ['XU100']) as $s) {
            foreach (Db::all('SELECT trade_date, close FROM market_daily WHERE symbol = ? AND trade_date >= DATE_SUB(?, INTERVAL 45 DAY) ORDER BY trade_date', [$s, $start]) as $r) {
                $closes[$s][(string) $r['trade_date']] = (float) $r['close'];
            }
        }
        $days = array_keys($closes['XU100'] ?? []);
        $days = array_values(array_filter($days, fn($d) => $d >= $start));
        $days[] = date('Y-m-d');
        $days = array_values(array_unique($days));
        $dates = $equity = $bench = [];
        $k = 0;
        $lastPx = [];
        $bm0 = null;
        $bmLast = null;
        $applied = [];
        foreach ($days as $d) {
            while ($k < count($trades) && substr((string) $trades[$k]['traded_at'], 0, 10) <= $d) {
                $applied[] = $trades[$k++];
            }
            $st = self::replay((float) $a['initial_cash'], $applied);
            $v = $st['cash'];
            foreach ($st['positions'] as $s => $p) {
                if (isset($closes[$s][$d])) {
                    $lastPx[$s] = $closes[$s][$d];
                }
                $v += $p['shares'] * ($lastPx[$s] ?? $p['avg_price']);
            }
            if (isset($closes['XU100'][$d])) {
                $bmLast = $closes['XU100'][$d];
            } elseif ($bmLast === null && !empty($closes['XU100'])) {
                $prev = array_filter(array_keys($closes['XU100']), fn($x) => $x <= $d);
                $bmLast = $prev ? $closes['XU100'][max($prev)] : null;
            }
            $bm0 ??= $bmLast;
            $dates[] = $d;
            $equity[] = round($v, 2);
            $bench[] = $bm0 ? round((float) $a['initial_cash'] * $bmLast / $bm0, 2) : null;
        }
        return ['dates' => $dates, 'equity' => $equity, 'benchmark' => $bench];
    }

    /** POST /api/paper/{id}/order {symbol, side, shares?|amount?, note?, preview?} @return array<string,mixed> */
    public static function order(string $id): array
    {
        $a = self::account($id);
        $b = Http::body();
        $symbol = Http::symbol((string) ($b['symbol'] ?? ''));
        $side = (string) ($b['side'] ?? '');
        $shares = isset($b['shares']) && $b['shares'] !== '' && $b['shares'] !== null ? (float) $b['shares'] : null;
        $amount = isset($b['amount']) && $b['amount'] !== '' && $b['amount'] !== null ? (float) $b['amount'] : null;
        if ($side === 'buy' && $shares === null && $amount === null) {
            throw new HttpError(400, 'adet veya tutar girin');
        }
        $px = self::price($symbol);   // outside the transaction: may call Yahoo
        $preview = !empty($b['preview']);
        $pdo = Db::pdo();
        if (!$preview) {
            // serialise orders per account so two simultaneous orders cannot both spend the same cash
            $pdo->beginTransaction();
            Db::one('SELECT id FROM paper_accounts WHERE id = ? FOR UPDATE', [(int) $a['id']]);
        }
        try {
            $st = self::replay((float) $a['initial_cash'], self::trades((int) $a['id']));
            $fill = self::sizeOrder($st, $symbol, $side, $px['price'], $shares, $amount, (float) $a['fee_bps']);
            $res = ['symbol' => $symbol, 'side' => $side, 'shares' => $fill['shares'], 'price' => $px['price'], 'price_source' => $px['source'],
                    'as_of' => $px['as_of'], 'fee' => $fill['fee'], 'total' => $side === 'buy' ? $fill['gross'] + $fill['fee'] : $fill['gross'] - $fill['fee']];
            if ($preview) {
                return $res + ['preview' => true];
            }
            Db::exec('INSERT INTO paper_trades (account_id, symbol, side, shares, price, fee, price_source, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [(int) $a['id'], $symbol, $side, $fill['shares'], $px['price'], $fill['fee'], mb_substr($px['source'], 0, 16),
                 isset($b['note']) ? mb_substr((string) $b['note'], 0, 250) : null]);
            $res['id'] = (int) $pdo->lastInsertId();
            $pdo->commit();
            return $res;
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    /** @return array<string,mixed> */
    public static function delete(string $id): array
    {
        self::ensureTables();
        return ['deleted' => Db::exec('DELETE FROM paper_accounts WHERE id = ?', [(int) $id]) > 0];
    }

    /** Clears all trades: back to the initial cash. @return array<string,mixed> */
    public static function reset(string $id): array
    {
        $a = self::account($id);
        Db::exec('DELETE FROM paper_trades WHERE account_id = ?', [(int) $a['id']]);
        Db::exec('UPDATE paper_accounts SET created_at = CURRENT_TIMESTAMP WHERE id = ?', [(int) $a['id']]);
        return ['reset' => true];
    }
}
