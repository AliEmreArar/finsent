<?php

// Dependency-free tests for the strategy-lab PHP code: php backend/tests/php/run.php

declare(strict_types=1);

require dirname(__DIR__, 2) . '/vendor/autoload.php';

use FinSent\Controllers\StrategyController as SC;
use FinSent\HttpError;
use FinSent\Services\StrategyAi;

$failed = 0;
$passed = 0;
function check(string $name, callable $fn): void
{
    global $failed, $passed;
    try {
        $fn();
        $passed++;
        echo "ok   $name\n";
    } catch (\Throwable $e) {
        $failed++;
        echo "FAIL $name: {$e->getMessage()}\n";
    }
}
function eq(mixed $a, mixed $b, string $msg = ''): void
{
    if ($a !== $b) {
        throw new \RuntimeException(($msg ? "$msg: " : '') . var_export($a, true) . ' !== ' . var_export($b, true));
    }
}
function throwsHttp(callable $fn, int $status): void
{
    try {
        $fn();
    } catch (HttpError $e) {
        eq($e->status, $status, 'status');
        return;
    }
    throw new \RuntimeException('expected HttpError');
}

check('parseSymbols normalises, dedups and validates', function () {
    eq(SC::parseSymbols(' thyao, ASELS.IS;thyao  eregl '), ['THYAO', 'ASELS', 'EREGL']);
    throwsHttp(fn() => SC::parseSymbols(''), 400);
    throwsHttp(fn() => SC::parseSymbols('THY-AO'), 400);
    throwsHttp(fn() => SC::parseSymbols(implode(',', array_map(fn($i) => "S$i" . 'X', range(1, SC::MAX_SYMBOLS + 1)))), 400);
});

check('columnar keeps the stored open and fills missing high/low from close', function () {
    $c = SC::columnar([
        ['trade_date' => '2024-01-02', 'open' => '10.0', 'high' => null, 'low' => null, 'close' => '11.0', 'volume_try' => '1000.4', 'open_is_estimated' => 1],
        ['trade_date' => '2024-01-03', 'open' => null, 'high' => '12', 'low' => '10.5', 'close' => '11.5', 'volume_try' => null, 'open_is_estimated' => 0],
        ['trade_date' => '2024-01-04', 'open' => null, 'high' => null, 'low' => null, 'close' => null, 'volume_try' => null],
    ]);
    eq($c['date'], ['2024-01-02', '2024-01-03']);
    eq($c['open'], [10.0, 11.5]);
    eq($c['high'], [11.0, 12.0]);
    eq($c['volume'], [1000, 0]);
});

check('alignSentiment maps disclosures to the first tradable bar', function () {
    $dates = ['2024-01-02', '2024-01-03', '2024-01-05'];
    $rows = [
        ['day' => '2024-01-02', 'hr' => 10, 'exact' => 0, 'score' => 0.5],
        ['day' => '2024-01-02', 'hr' => 11, 'exact' => 0, 'score' => -0.1],
        ['day' => '2024-01-02', 'hr' => 19, 'exact' => 0, 'score' => 0.9],   // after the close -> next session
        ['day' => '2024-01-04', 'hr' => 9, 'exact' => 1, 'score' => 0.3],    // holiday -> next trading day
        ['day' => '2024-01-09', 'hr' => 9, 'exact' => 1, 'score' => 0.3],    // after the window: dropped
        ['day' => '2024-01-03', 'hr' => 20, 'exact' => 1, 'score' => -0.4],  // exact event date wins over the hour
    ];
    eq(SC::alignSentiment($dates, $rows), [0.2, 0.25, 0.3]);
});

check('StrategyAi::clean strips fences and normalises tickers', function () {
    $o = StrategyAi::clean(['code' => "```javascript\nconst strategy = {};\n```", 'symbols' => ['thyao.is', 'bad ticker!', 'THYAO', 'asels'],
                            'assumptions' => ['a', ' ', ''], 'warnings' => []]);
    eq($o['code'], "const strategy = {};\n");
    eq($o['symbols'], ['THYAO', 'ASELS']);
    eq($o['assumptions'], ['a']);
});

check('offlineReview verdicts', function () {
    $good = StrategyAi::offlineReview(['metrics' => ['cagr' => 0.4, 'maxDrawdown' => -0.2, 'trades' => 50, 'years' => 6, 'exposure' => 0.5],
        'buy_hold' => ['cagr' => 0.3, 'maxDrawdown' => -0.5], 'benchmark' => ['cagr' => 0.25], 'benchmark_name' => 'XU100']);
    eq($good['verdict'], 'promising');
    eq($good['provider'], 'rules');
    $few = StrategyAi::offlineReview(['metrics' => ['cagr' => 0.4, 'maxDrawdown' => -0.2, 'trades' => 3, 'years' => 1], 'buy_hold' => ['cagr' => 0.1, 'maxDrawdown' => -0.3]]);
    eq($few['verdict'], 'insufficient_data');
    $bad = StrategyAi::offlineReview(['metrics' => ['cagr' => 0.05, 'maxDrawdown' => -0.6, 'trades' => 40, 'years' => 5], 'buy_hold' => ['cagr' => 0.3, 'maxDrawdown' => -0.4]]);
    eq($bad['verdict'], 'weak');
});

check('API doc mentions every ctx method the engine exposes', function () {
    $engine = (string) file_get_contents(dirname(__DIR__, 2) . '/public/assets/strategy/engine.js');
    preg_match('/const ctx = \{(.*?)\n    \};/s', $engine, $m);
    preg_match_all('/^\s{6}(?:get\s+)?([a-zA-Z]+)[\(,:]/m', $m[1] ?? '', $names);
    $names = array_unique(array_diff($names[1], ['ta', 'state', 'params', 'symbols', 'indicators', 'series']));
    if (count($names) < 15) {
        throw new \RuntimeException('could not parse ctx');
    }
    foreach ($names as $n) {
        if (!str_contains(StrategyAi::API_DOC, "ctx.$n")) {
            throw new \RuntimeException("API_DOC misses ctx.$n");
        }
    }
});

echo "\n$passed passed, $failed failed\n";
exit($failed ? 1 : 0);
