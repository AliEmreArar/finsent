<?php

declare(strict_types=1);

namespace FinSent\Services;

use FinSent\Config;
use GuzzleHttp\Client;
use GuzzleHttp\Exception\GuzzleException;

/**
 * Grok as a strategy programmer: turns a Turkish (or English) description of a trading idea into
 * code for the FinSent strategy engine (backend/public/assets/strategy/engine.js), fixes code that
 * failed, and reviews backtest results. The code runs in the user's browser inside a Web Worker,
 * never on the server.
 */
final class StrategyAi
{
    /** The strategy API, as the model must use it. Kept in sync with engine.js. */
    public const API_DOC = <<<'TXT'
FinSent STRATEGY API (JavaScript, runs in a sandboxed Web Worker, daily bars, long-only)

The code must define exactly one object `const strategy = { ... }` with:
  name: string (Turkish)
  description: string (Turkish, 1-3 sentences, what the rules are)
  params: { key: { label: 'Türkçe etiket', default: number|boolean, min, max, step } }
     Every tunable number in the rules must be a param (periods, thresholds, stop %, holding days...).
     The UI builds sliders from these and runs parameter sweeps over min..max.
  indicators(s, p, ta, sym)  [optional] called once per symbol BEFORE the loop.
     s = { date[], open[], high[], low[], close[], volume[], sentiment[] } aligned arrays, oldest first.
       sentiment[i] = average AI sentiment score (-1..+1) of that stock's KAP disclosures that became
       tradable on day i, or null when there was no disclosure.
     Return an object of arrays (same length as s.close), e.g. { rsi: ta.rsi(s.close, p.rsiLen) }.
     Values at index i must only depend on data up to i (no look-ahead). Use ta.ref(x, 1) for "yesterday".
  onBar(ctx, p)  called on every bar after the close. Decide and place orders.
     Orders placed on bar i are filled at bar i+1's OPEN (no look-ahead), with commission + slippage.

ctx (read):
  ctx.symbols (string[]), ctx.i (bar index), ctx.date ('YYYY-MM-DD'), ctx.cash, ctx.equity, ctx.isLastBar,
  ctx.has(sym) -> did the stock trade today, ctx.close(sym, ago=0), ctx.bar(sym, ago=0) -> {date,open,high,low,close,volume,sentiment} | null,
  ctx.ind(sym, 'name', ago=0) -> value of a series returned by indicators() at this bar (NaN during warm-up),
  ctx.sentiment(sym, ago=0) -> number | null, ctx.series(sym) -> full aligned arrays,
  ctx.position(sym) -> null | { shares, avgPrice, entryDate, barsHeld, value, pnlPct },
  ctx.positions() -> [{ sym, ...position }], ctx.state -> a plain object you may use to remember things between bars.
ctx (orders):
  ctx.buy(sym, { percent: 25 })            // spend 25% of current equity (capped by cash)
  ctx.buy(sym, { amount: 10000 })          // spend 10 000 TL
  ctx.buy(sym, { shares: 100 })
  options on buy: stopLoss: 0.08 (8% below entry), takeProfit: 0.2, trailingStop: 0.1 (10% below the highest high since entry),
                  reason: 'Türkçe kısa gerekçe' (shown in the trade list)
  ctx.sell(sym)                            // sell all;  ctx.sell(sym, { percent: 50 }) or { shares: n }; reason allowed
  ctx.targetPercent(sym, 30)               // rebalance the position to 30% of equity (0 = close)
  ctx.closeAll(), ctx.setStop(sym, { stopLoss, takeProfit, trailingStop }), ctx.log('text', value)
Stops/targets are checked every bar against the high/low; the engine handles them, do not re-implement them in onBar.

ta helpers (all return arrays aligned with the input, NaN while warming up):
  ta.sma(x,n) ta.ema(x,n) ta.rma(x,n) ta.rsi(x,n=14) ta.stdev(x,n) ta.roc(x,n) (fractional change) ta.change(x,n)
  ta.highest(x,n) ta.lowest(x,n) ta.ref(x,n) ta.zscore(x,n)
  ta.macd(x,fast=12,slow=26,signal=9) -> {macd, signal, hist}
  ta.bollinger(x,n=20,mult=2) -> {upper, mid, lower, width}
  ta.atr(high,low,close,n=14) ta.trueRange(h,l,c) ta.stochastic(h,l,c,k=14,d=3) -> {k,d}
  ta.adx(h,l,c,n=14) -> {adx, plusDI, minusDI}  ta.obv(close, volume)
  ta.crossover(a, b) ta.crossunder(a, b) -> boolean arrays (b can be a number or an array)
  ta.isNum(v) -> finite number check. ALWAYS guard: if (!ta.isNum(v)) continue;

Rules:
- Pure JavaScript (ES2020). No imports, no fetch/network, no DOM, no Date.now()/Math.random() in rules.
- Never read future bars (no s.close[i+1] in indicators, no ctx.bar(sym, -1)).
- Size positions so the portfolio cannot exceed 100% (e.g. percent: 100 / ctx.symbols.length or 99 / maxPositions).
- If the user gives a stock list, the strategy must work for any number of symbols (loop over ctx.symbols).
- Monthly / weekly rebalancing: detect a new period with ctx.bar(ctx.symbols[0], 1)?.date.slice(0,7) !== ctx.date.slice(0,7).
- Use Turkish for name, description, labels, reasons and comments.
- Keep it readable: short comments explaining each rule.
TXT;

    private const EXAMPLE = <<<'JS'
const strategy = {
  name: 'RSI ile dipten alım',
  description: 'RSI eşik altına inince al; RSI çıkış seviyesini geçince veya süre dolunca sat. %8 zarar kes.',
  params: {
    rsiLen: { label: 'RSI periyodu', default: 14, min: 2, max: 30, step: 1 },
    buyBelow: { label: 'Alış eşiği (RSI <)', default: 30, min: 5, max: 50, step: 1 },
    sellAbove: { label: 'Satış eşiği (RSI >)', default: 60, min: 40, max: 90, step: 1 },
    stopLoss: { label: 'Zarar kes (%)', default: 8, min: 0, max: 30, step: 1 },
    maxDays: { label: 'En uzun bekleme (gün)', default: 30, min: 3, max: 120, step: 1 },
  },
  indicators(s, p, ta) {
    return { rsi: ta.rsi(s.close, p.rsiLen) };
  },
  onBar(ctx, p) {
    const weight = 100 / ctx.symbols.length;
    for (const sym of ctx.symbols) {
      const rsi = ctx.ind(sym, 'rsi');
      if (!ta.isNum(rsi)) continue;            // gösterge henüz hazır değil
      const pos = ctx.position(sym);
      if (!pos && rsi < p.buyBelow) {          // aşırı satım: al
        ctx.buy(sym, { percent: weight, stopLoss: p.stopLoss > 0 ? p.stopLoss / 100 : null, reason: 'RSI ' + rsi.toFixed(0) });
      } else if (pos && (rsi > p.sellAbove || pos.barsHeld >= p.maxDays)) {
        ctx.sell(sym, { reason: rsi > p.sellAbove ? 'RSI toparlandı' : 'süre doldu' });
      }
    }
  },
};
JS;

    private const GENERATE_SYSTEM = <<<'TXT'
You are FinSent's strategy programmer for Borsa Istanbul (BIST). The user describes a trading
strategy in plain language (usually Turkish). Translate it faithfully into code for the FinSent
strategy API below, so the user can backtest it on historical daily data with virtual money.

- Implement what the user asked, not a different strategy. When something is ambiguous, pick a
  sensible, common interpretation and list it in "assumptions" (Turkish).
- If the user is modifying an existing strategy (current code is given), change only what they asked
  and keep the rest, including parameter names.
- Things the API cannot do (intraday bars, short selling, options, leverage, fundamentals other than
  KAP disclosure sentiment) go into "warnings" with the closest feasible approximation implemented.
- Point out obvious risks in "warnings" (e.g. very few trades expected, overfitting-prone rules).
- "symbols": BIST tickers the strategy is meant for if the user named any (e.g. THYAO, ASELS) or if
  it needs a basket; otherwise an empty array. Use plain tickers without ".IS". XU100 is the index,
  ALTIN is gram gold in TL.
- "summary": explain the rules to a non-programmer in Turkish, 2-5 short sentences.
- "code": the full JavaScript, nothing else (no markdown fences).
- This is a research tool, not investment advice; never promise returns.

TXT;

    private const FIX_SYSTEM = <<<'TXT'
You fix FinSent strategy code that failed to compile or run. Keep the strategy's intent, its
parameter names and its structure; change only what is needed to fix the error. Return the full
corrected code. Explain the fix briefly in Turkish in "summary".

TXT;

    private const REVIEW_SYSTEM = <<<'TXT'
You review a backtest of a trading strategy on Borsa Istanbul for a retail user, in Turkish.
You get the strategy description and code, the settings (symbols, period, costs) and the results
(metrics of the strategy, buy-and-hold of the same stocks, and the benchmark index; yearly returns;
trade statistics). Be honest and concrete:
- Did it beat buy-and-hold and the index after costs, and at what risk (max drawdown, volatility)?
- Is the sample meaningful (number of trades, years, one lucky period)? Flag overfitting risk.
- Turkish lira returns are inflated by inflation; when the period is long, compare with the index
  and mention real (USD / gold) terms if relevant.
- Suggest 2-4 specific, testable improvements (parameter ranges, filters, risk rules).
Never give investment advice or promise future returns.
TXT;

    private Client $http;
    private string $model;

    public function __construct()
    {
        $this->model = (string) Config::get('XAI_STRATEGY_MODEL', Config::xaiModel());
        $this->http = new Client([
            'base_uri' => rtrim((string) Config::get('XAI_BASE_URL', 'https://api.x.ai/v1'), '/') . '/',
            'timeout' => 180,
            'headers' => ['Authorization' => 'Bearer ' . Config::get('XAI_API_KEY'), 'Content-Type' => 'application/json'],
        ]);
    }

    public static function enabled(): bool
    {
        return Config::grokEnabled();
    }

    public function model(): string
    {
        return $this->model;
    }

    /** @return array<string,mixed> */
    private static function codeSchema(): array
    {
        return [
            'type' => 'object',
            'properties' => [
                'name' => ['type' => 'string'],
                'summary' => ['type' => 'string'],
                'code' => ['type' => 'string'],
                'symbols' => ['type' => 'array', 'items' => ['type' => 'string']],
                'assumptions' => ['type' => 'array', 'items' => ['type' => 'string']],
                'warnings' => ['type' => 'array', 'items' => ['type' => 'string']],
            ],
            'required' => ['name', 'summary', 'code', 'symbols', 'assumptions', 'warnings'],
            'additionalProperties' => false,
        ];
    }

    /**
     * @param list<array{role:string,content:string}> $history earlier turns of this strategy chat
     * @return array<string,mixed>
     */
    public function generate(string $prompt, ?string $currentCode, array $symbols, array $history = []): array
    {
        $system = self::GENERATE_SYSTEM . self::API_DOC . "\n\nEXAMPLE:\n" . self::EXAMPLE;
        $messages = [['role' => 'system', 'content' => $system]];
        foreach (array_slice($history, -8) as $h) {
            if (in_array($h['role'] ?? '', ['user', 'assistant'], true) && is_string($h['content'] ?? null)) {
                $messages[] = ['role' => $h['role'], 'content' => mb_substr($h['content'], 0, 4000)];
            }
        }
        $user = '';
        if ($currentCode !== null && trim($currentCode) !== '') {
            $user .= "Current strategy code:\n" . mb_substr($currentCode, 0, 20000) . "\n\n";
        }
        if ($symbols) {
            $user .= 'Stocks currently selected in the UI: ' . implode(', ', $symbols) . "\n\n";
        }
        $user .= "Request:\n" . mb_substr($prompt, 0, 4000);
        $messages[] = ['role' => 'user', 'content' => $user];
        return $this->clean($this->chat($messages, self::codeSchema(), 'strategy_code'));
    }

    /** @return array<string,mixed> */
    public function fix(string $code, string $error): array
    {
        $messages = [
            ['role' => 'system', 'content' => self::FIX_SYSTEM . self::API_DOC],
            ['role' => 'user', 'content' => "Code:\n" . mb_substr($code, 0, 20000) . "\n\nError:\n" . mb_substr($error, 0, 2000)],
        ];
        return $this->clean($this->chat($messages, self::codeSchema(), 'strategy_fix'));
    }

    /** @param array<string,mixed> $report @return array<string,mixed> */
    public function review(array $report): array
    {
        $schema = [
            'type' => 'object',
            'properties' => [
                'verdict' => ['type' => 'string', 'enum' => ['promising', 'mixed', 'weak', 'insufficient_data']],
                'summary' => ['type' => 'string'],
                'strengths' => ['type' => 'array', 'items' => ['type' => 'string']],
                'weaknesses' => ['type' => 'array', 'items' => ['type' => 'string']],
                'suggestions' => ['type' => 'array', 'items' => ['type' => 'string']],
            ],
            'required' => ['verdict', 'summary', 'strengths', 'weaknesses', 'suggestions'],
            'additionalProperties' => false,
        ];
        $messages = [
            ['role' => 'system', 'content' => self::REVIEW_SYSTEM],
            ['role' => 'user', 'content' => (string) json_encode($report, JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION)],
        ];
        return $this->chat($messages, $schema, 'backtest_review') + ['provider' => 'xai', 'model' => $this->model];
    }

    /** @return array<string,mixed> */
    private function chat(array $messages, array $schema, string $name): array
    {
        try {
            $resp = $this->http->post('chat/completions', ['json' => [
                'model' => $this->model,
                'messages' => $messages,
                'response_format' => ['type' => 'json_schema', 'json_schema' => ['name' => $name, 'schema' => $schema, 'strict' => true]],
            ]]);
        } catch (GuzzleException $e) {
            throw new \RuntimeException('xAI request failed: ' . $e->getMessage(), 0, $e);
        }
        $data = json_decode((string) $resp->getBody(), true, flags: JSON_THROW_ON_ERROR);
        $choice = $data['choices'][0] ?? null;
        if (!$choice || ($choice['finish_reason'] ?? '') === 'length') {
            throw new \RuntimeException('no complete structured output');
        }
        $out = json_decode((string) $choice['message']['content'], true, flags: JSON_THROW_ON_ERROR);
        $out['cost_usd'] = GrokClient::costUsd($data['usage'] ?? []);
        return $out;
    }

    /** Normalises model output: strips markdown fences, upper-cases tickers. @return array<string,mixed> */
    public static function clean(array $out): array
    {
        $code = trim((string) ($out['code'] ?? ''));
        if (preg_match('/^```(?:javascript|js)?\s*\n(.*?)\n```\s*$/s', $code, $m)) {
            $code = $m[1];
        }
        $out['code'] = $code . "\n";
        $syms = [];
        foreach ((array) ($out['symbols'] ?? []) as $s) {
            $s = strtoupper(trim(str_replace('.IS', '', (string) $s)));
            if (preg_match('/^[A-Z0-9]{2,12}$/', $s)) {
                $syms[] = $s;
            }
        }
        $out['symbols'] = array_values(array_unique($syms));
        foreach (['assumptions', 'warnings'] as $k) {
            $out[$k] = array_values(array_filter(array_map('strval', (array) ($out[$k] ?? [])), fn($v) => trim($v) !== ''));
        }
        $out['provider'] = 'xai';
        return $out;
    }

    /**
     * Rule-based review used when no LLM is configured or it fails.
     * @param array<string,mixed> $report
     * @return array<string,mixed>
     */
    public static function offlineReview(array $report): array
    {
        $m = $report['metrics'] ?? [];
        $bh = $report['buy_hold'] ?? [];
        $bm = $report['benchmark'] ?? null;
        $pct = fn($v) => $v === null ? '–' : ((float) $v < 0 ? '-%' : '%') . number_format(abs((float) $v) * 100, 1, ',', '.');
        $trades = (int) ($m['trades'] ?? 0);
        $years = (float) ($m['years'] ?? 0);
        $strengths = $weaknesses = $suggestions = [];
        $beatBh = isset($m['cagr'], $bh['cagr']) && $m['cagr'] > $bh['cagr'];
        $lessDd = isset($m['maxDrawdown'], $bh['maxDrawdown']) && $m['maxDrawdown'] > $bh['maxDrawdown'];

        if ($beatBh) {
            $strengths[] = 'Yıllık getiri ' . $pct($m['cagr']) . ', aynı hisseleri al-tut ' . $pct($bh['cagr'] ?? null) . ': strateji al-tut\'u geçmiş.';
        } else {
            $weaknesses[] = 'Yıllık getiri ' . $pct($m['cagr'] ?? null) . ', al-tut ' . $pct($bh['cagr'] ?? null) . ': strateji al-tut\'un gerisinde.';
        }
        if ($lessDd) {
            $strengths[] = 'En büyük düşüş ' . $pct($m['maxDrawdown']) . ', al-tut\'ta ' . $pct($bh['maxDrawdown'] ?? null) . ': risk daha düşük.';
        } elseif (isset($m['maxDrawdown'])) {
            $weaknesses[] = 'En büyük düşüş ' . $pct($m['maxDrawdown']) . ': sermayenin bu kadarını geçici olarak kaybetmeyi kaldırabilir misin?';
        }
        if ($bm && isset($bm['cagr'], $m['cagr'])) {
            $line = 'Endeks (' . ($report['benchmark_name'] ?? 'BIST 100') . ') yıllık ' . $pct($bm['cagr']) . '.';
            if ($m['cagr'] > $bm['cagr']) {
                $strengths[] = $line . ' Strateji endeksi geçmiş.';
            } else {
                $weaknesses[] = $line . ' Strateji endeksin gerisinde.';
            }
        }
        if ($trades < 20) {
            $weaknesses[] = "Sadece $trades işlem var: sonuç tesadüf olabilir, istatistiksel olarak zayıf.";
            $suggestions[] = 'Daha uzun bir dönem veya daha fazla hisse ile test et.';
        }
        if ($years < 3) {
            $weaknesses[] = 'Test süresi 3 yıldan kısa; farklı piyasa koşullarını kapsamıyor olabilir.';
        }
        if (isset($m['exposure']) && $m['exposure'] < 0.3) {
            $strengths[] = 'Zamanın yalnızca ' . $pct($m['exposure']) . ' kadarında piyasada: nakitte beklerken faiz getirisi de değerlendirilebilir.';
        }
        $suggestions[] = 'Parametre taramasıyla sonucun tek bir değere mi bağlı yoksa geniş bir aralıkta mı tuttuğunu kontrol et.';
        $suggestions[] = 'Eğitim/test ayrımı (ileri yürüyüş) ile görmediği dönemdeki başarısına bak.';
        if ($years >= 3) {
            $suggestions[] = 'TL enflasyonu getirileri şişirir: USD bazında da test et.';
        }
        $verdict = $trades < 10 ? 'insufficient_data' : ($beatBh && $lessDd ? 'promising' : ($beatBh || $lessDd ? 'mixed' : 'weak'));
        $summary = match ($verdict) {
            'promising' => 'Strateji bu dönemde al-tut\'tan hem daha çok kazandırmış hem daha az düşmüş. Yine de aşırı uyum riskini kontrol et.',
            'mixed' => 'Strateji bazı açılardan al-tut\'tan iyi, bazı açılardan kötü. Getiri-risk dengesine göre değerlendir.',
            'weak' => 'Strateji bu dönemde al-tut\'un gerisinde kalmış ve riski azaltmamış.',
            default => 'Değerlendirme için işlem sayısı çok az.',
        };
        return ['verdict' => $verdict, 'summary' => $summary, 'strengths' => $strengths, 'weaknesses' => $weaknesses,
                'suggestions' => $suggestions, 'provider' => 'rules'];
    }
}
