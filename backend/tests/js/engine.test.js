// Unit tests for the strategy engine: node --test backend/tests/js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../../public/assets/strategy/engine.js');
const TEMPLATES = require('../../public/assets/strategy/templates.js');
const { ta } = E;

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// deterministic business-day series
function makeSeries(closes, start = '2020-01-01', extra = {}) {
  const date = [];
  const d = new Date(start + 'T00:00:00Z');
  while (date.length < closes.length) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) date.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return {
    date,
    open: closes.map((c, i) => (i ? closes[i - 1] : c)),
    high: closes.map((c, i) => Math.max(c, i ? closes[i - 1] : c) * 1.01),
    low: closes.map((c, i) => Math.min(c, i ? closes[i - 1] : c) * 0.99),
    close: closes.slice(),
    volume: closes.map(() => 1000),
    ...extra,
  };
}
function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; }
function randomWalk(n, seed = 1, drift = 0.0004, vol = 0.02) {
  const r = rng(seed); const out = [100];
  for (let i = 1; i < n; i++) out.push(out[i - 1] * (1 + drift + vol * (r() - 0.5) * 2));
  return out;
}

// ------------------------------------------------------------------ indicators
test('sma and ema basics', () => {
  const s = ta.sma([1, 2, 3, 4, 5], 3);
  assert.ok(Number.isNaN(s[1]));
  assert.deepEqual(s.slice(2), [2, 3, 4]);
  const e = ta.ema([1, 2, 3, 4, 5], 3);
  close(e[2], 2); close(e[3], 3); close(e[4], 4);
});

test('rsi is 100 on a straight rise and 0 on a straight fall, ~50 on alternation', () => {
  const up = ta.rsi(Array.from({ length: 30 }, (_, i) => 100 + i), 14);
  close(up.at(-1), 100);
  const dn = ta.rsi(Array.from({ length: 30 }, (_, i) => 100 - i), 14);
  close(dn.at(-1), 0);
  const alt = ta.rsi(Array.from({ length: 200 }, (_, i) => 100 + (i % 2)), 14);
  assert.ok(Math.abs(alt.at(-1) - 50) < 5);
});

test('highest/lowest/ref/crossover do not look ahead', () => {
  const x = [1, 3, 2, 5, 4];
  assert.deepEqual(ta.highest(x, 2).slice(1), [3, 3, 5, 5]);
  assert.deepEqual(ta.lowest(x, 2).slice(1), [1, 2, 2, 4]);
  assert.deepEqual(ta.ref(x, 1).slice(1), [1, 3, 2, 5]);
  assert.deepEqual(ta.crossover([1, 2, 3, 2, 4], 2.5), [false, false, true, false, true]);
  assert.deepEqual(ta.crossunder([3, 2, 1], [2, 2, 2]), [false, false, true]);
});

test('macd, bollinger, atr, stochastic, adx, obv, zscore produce aligned arrays', () => {
  const c = randomWalk(300, 7);
  const s = makeSeries(c);
  const m = ta.macd(c);
  assert.equal(m.macd.length, 300);
  assert.ok(Number.isFinite(m.hist.at(-1)));
  const b = ta.bollinger(c, 20, 2);
  assert.ok(b.upper.at(-1) > b.mid.at(-1) && b.mid.at(-1) > b.lower.at(-1));
  assert.ok(ta.atr(s.high, s.low, s.close).at(-1) > 0);
  const st = ta.stochastic(s.high, s.low, s.close);
  assert.ok(st.k.at(-1) >= 0 && st.k.at(-1) <= 100);
  const ad = ta.adx(s.high, s.low, s.close);
  assert.ok(ad.adx.at(-1) >= 0 && ad.adx.at(-1) <= 100);
  assert.equal(ta.obv(c, s.volume).length, 300);
  assert.ok(Number.isFinite(ta.zscore(c, 20).at(-1)));
});

// ------------------------------------------------------------------ data prep
test('corporate actions (2:1 bonus issue) are back-adjusted', () => {
  const c = [100, 102, 104, 52, 53, 54];
  const s = makeSeries(c);
  const r = E.adjustCorporateActions(s);
  assert.equal(r.events.length, 1);
  close(r.series.close[2], 52);
  close(r.series.close[3], 52);
  close(r.series.volume[0], 2000);
});

test('a normal 9% limit-down day is not treated as a corporate action', () => {
  const r = E.adjustCorporateActions(makeSeries([100, 91, 83, 76]));
  assert.equal(r.events.length, 0);
});

test('alignSeries puts symbols on one calendar and carries prices over gaps', () => {
  const a = makeSeries([10, 11, 12, 13]);
  const b = { ...makeSeries([20, 21, 22, 23]) };
  // b misses the 2nd day
  const bb = Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.filter((_, i) => i !== 1)]));
  const { dates, series } = E.alignSeries({ A: a, B: bb });
  assert.equal(dates.length, 4);
  assert.equal(series.B.has[1], false);
  assert.equal(series.B.close[1], 20);
});

// ------------------------------------------------------------------ backtester
const BUY_FIRST_DAY = `const strategy = { onBar(ctx) { if (!ctx.state.d) { ctx.buy('A', { percent: 100 }); ctx.state.d = 1; } } };`;

test('buy on day one fills at next open, with commission and slippage', () => {
  const c = [100, 100, 110, 121];
  const data = { A: makeSeries(c) };
  const r = E.backtest({ code: BUY_FIRST_DAY, data, config: { initialCapital: 10000, commissionBps: 0, slippageBps: 0, adjustCorporateActions: false } });
  assert.equal(r.fills.length, 1);
  assert.equal(r.fills[0].date, data.A.date[1]);
  assert.equal(r.fills[0].price, 100);   // open of bar 1 = close of bar 0
  close(r.equity.at(-1), 12100);
  close(r.metrics.totalReturn, 0.21);

  const r2 = E.backtest({ code: BUY_FIRST_DAY, data, config: { initialCapital: 10000, commissionBps: 10, slippageBps: 10, adjustCorporateActions: false } });
  assert.ok(r2.equity.at(-1) < 12100);
  assert.ok(r2.totalCommission > 0);
});

test('fill=close executes on the signal bar', () => {
  const data = { A: makeSeries([100, 110, 121]) };
  const r = E.backtest({ code: BUY_FIRST_DAY, data, config: { initialCapital: 1000, commissionBps: 0, slippageBps: 0, fill: 'close' } });
  assert.equal(r.fills[0].date, data.A.date[0]);
  close(r.equity.at(-1), 1210);
});

test('shares are whole lots and cash never goes negative', () => {
  const data = { A: makeSeries([333, 333, 340]) };
  const r = E.backtest({ code: BUY_FIRST_DAY, data, config: { initialCapital: 1000, commissionBps: 20, slippageBps: 5 } });
  assert.equal(r.fills[0].shares, 2);
  assert.ok(r.finalCash >= 0);
});

test('stop loss exits at the stop price (or the open on a gap)', () => {
  const c = [100, 100, 100, 95, 85, 80];
  const s = makeSeries(c);
  s.low = c.map((x) => x * 0.99);
  const code = `const strategy = { onBar(ctx) { if (!ctx.state.d) { ctx.buy('A', { percent: 100, stopLoss: 0.1 }); ctx.state.d = 1; } } };`;
  const r = E.backtest({ code, data: { A: s }, config: { initialCapital: 10000, commissionBps: 0, slippageBps: 0, adjustCorporateActions: false } });
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].reason, 'zarar kes');
  // bar 4: open 95, low 84.15 -> stop at 90
  close(r.trades[0].exitPrice, 90);
});

test('take profit and trailing stop', () => {
  const c = [100, 100, 105, 125, 130, 140, 120, 110];
  const s = makeSeries(c);
  const tp = `const strategy = { onBar(ctx) { if (!ctx.state.d) { ctx.buy('A', { percent: 100, takeProfit: 20 }); ctx.state.d = 1; } } };`;
  const r = E.backtest({ code: tp, data: { A: s }, config: { commissionBps: 0, slippageBps: 0, adjustCorporateActions: false } });
  assert.equal(r.trades[0].reason, 'kâr al');
  close(r.trades[0].exitPrice, 120);
  const tr = `const strategy = { onBar(ctx) { if (!ctx.state.d) { ctx.buy('A', { percent: 100, trailingStop: 0.1 }); ctx.state.d = 1; } } };`;
  const r2 = E.backtest({ code: tr, data: { A: s }, config: { commissionBps: 0, slippageBps: 0, adjustCorporateActions: false } });
  assert.equal(r2.trades[0].reason, 'iz süren stop');
  assert.ok(r2.trades[0].exitPrice > 120);
});

test('targetPercent rebalances down', () => {
  const data = { A: makeSeries([100, 100, 100, 100, 100]) };
  const code = `const strategy = { onBar(ctx) { if (ctx.i === 0) ctx.targetPercent('A', 80); if (ctx.i === 2) ctx.targetPercent('A', 40); } };`;
  const r = E.backtest({ code, data, config: { initialCapital: 10000, commissionBps: 0, slippageBps: 0 } });
  const pos = r.openPositions[0];
  assert.equal(pos.shares, 40);
});

test('no look-ahead: a strategy that peeks at tomorrow cannot, because fills happen next open', () => {
  // signal on bar i uses close[i]; the fill is at open[i+1] which equals close[i] here, so a
  // perfect-foresight-looking rule earns nothing on a random walk with zero drift beyond noise
  const c = randomWalk(500, 3, 0, 0.02);
  const code = `const strategy = { indicators(s){ return { up: s.close.map((v,i)=> i>0 && v > s.close[i-1]) }; },
    onBar(ctx){ const p = ctx.position('A'); if (ctx.ind('A','up') && !p) ctx.buy('A',{percent:100}); else if (!ctx.ind('A','up') && p) ctx.sell('A'); } };`;
  const r = E.backtest({ code, data: { A: makeSeries(c) }, config: { commissionBps: 0, slippageBps: 0 } });
  assert.ok(r.metrics.totalReturn < 3, 'implausibly high return suggests look-ahead');
});

test('errors in strategy code are reported with phase and date', () => {
  const data = { A: makeSeries([1, 2, 3]) };
  assert.throws(() => E.backtest({ code: 'const x = 1;', data }), /strategy/);
  assert.throws(() => E.backtest({ code: 'const strategy = { onBar(ctx){ ctx.buy("ZZZ") } };', data }), /Bilinmeyen sembol/);
  try {
    E.backtest({ code: 'const strategy = { onBar(ctx){ if (ctx.i===1) null.x; } };', data });
    assert.fail('should throw');
  } catch (e) {
    assert.equal(e.phase, 'onBar');
    assert.equal(e.date, data.A.date[1]);
  }
  assert.throws(() => E.backtest({ code: 'const strategy = { onBar(ctx){ ctx.ind("A","nope") } };', data }), /göstergesi/);
  try { E.backtest({ code: 'const strategy = { onBar(ctx){ ctx.ind("A","nope") } };', data }); } catch (e) { assert.equal(e.phase, 'onBar'); assert.equal(e.date, data.A.date[0]); }
});

test('params: defaults, clamping and overrides', () => {
  const s = E.compileStrategy('const strategy = { params: { a: { default: 5, min: 1, max: 10 }, b: true, c: 3 }, onBar(){} };');
  assert.deepEqual(E.resolveParams(s), { a: 5, b: true, c: 3 });
  assert.deepEqual(E.resolveParams(s, { a: 50, b: 'false', c: '7' }), { a: 10, b: false, c: 7 });
});

test('metrics: drawdown, CAGR, sharpe on a known curve', () => {
  const dates = ['2020-01-01', '2020-07-01', '2021-01-01'];
  const m = E.computeMetrics(dates, [100, 50, 121], []);
  close(m.maxDrawdown, -0.5);
  close(m.totalReturn, 0.21);
  assert.ok(Math.abs(m.cagr - 0.21) < 0.01);
});

test('period returns chain to the total return', () => {
  const c = randomWalk(600, 11);
  const s = makeSeries(c);
  const pr = E.periodReturns(s.date, c);
  const chained = Object.values(pr.yearly).reduce((a, r) => a * (1 + r), 1) - 1;
  close(chained, c.at(-1) / c[0] - 1, 1e-9);
  const chainedM = Object.values(pr.monthly).reduce((a, r) => a * (1 + r), 1) - 1;
  close(chainedM, c.at(-1) / c[0] - 1, 1e-9);
});

test('startDate keeps earlier bars as warm-up only', () => {
  const c = randomWalk(400, 5);
  const s = makeSeries(c);
  const code = TEMPLATES.find((t) => t.id === 'sma_cross').code;
  const r = E.backtest({ code, data: { A: s }, params: { fast: 20, slow: 100 }, config: { startDate: s.date[200] } });
  assert.equal(r.dates[0], s.date[200]);
  assert.equal(r.equity.length, 200);
});

test('benchmark is rebased to the initial capital', () => {
  const s = makeSeries(randomWalk(100, 2));
  const bm = { name: 'XU100', ...makeSeries(randomWalk(100, 9)) };
  const r = E.backtest({ code: BUY_FIRST_DAY, data: { A: s }, benchmark: bm, config: { initialCapital: 5000 } });
  close(r.benchmark.equity[0], 5000);
  assert.ok(r.benchmark.metrics.totalReturn !== undefined);
});

test('signals placed on the last bar are reported as today\'s signals', () => {
  const s = makeSeries([1, 2, 3, 4]);
  const code = `const strategy = { onBar(ctx) { if (ctx.isLastBar) ctx.buy('A', { percent: 50, reason: 'sinyal' }); } };`;
  const r = E.backtest({ code, data: { A: s } });
  assert.deepEqual(r.signals, [{ sym: 'A', side: 'buy', reason: 'sinyal', percent: 50 }]);
});

// ------------------------------------------------------------------ sweep / walk-forward
test('sweep runs the grid and walk-forward picks in-sample best', () => {
  const c = randomWalk(700, 21, 0.0006);
  const data = { A: makeSeries(c) };
  const code = TEMPLATES.find((t) => t.id === 'sma_cross').code;
  const sw = E.sweep({ code, data, grid: { fast: { min: 10, max: 30, step: 10 }, slow: { min: 50, max: 100, step: 50 } } });
  assert.equal(sw.rows.length, 6);
  assert.ok(sw.rows.every((r) => !r.error));
  const wf = E.walkForward({ code, data, grid: { fast: { min: 10, max: 30, step: 10 } }, splitDate: data.A.date[450] });
  assert.ok(wf.best.params.fast);
  assert.ok(Number.isFinite(wf.outOfSample.metrics.totalReturn));
});

test('sweep refuses huge grids', () => {
  const data = { A: makeSeries(randomWalk(50)) };
  const code = TEMPLATES[0].code;
  assert.throws(() => E.sweep({ code, data, grid: { fast: { min: 1, max: 60, step: 1 }, slow: { min: 1, max: 60, step: 1 } }, maxRuns: 100 }), /Çok fazla/);
});

// ------------------------------------------------------------------ templates
test('every template compiles and runs on multi-symbol random data', () => {
  const syms = ['THYAO', 'ASELS', 'BIMAS', 'EREGL'];
  const data = {};
  syms.forEach((s, k) => {
    const c = randomWalk(800, 100 + k, 0.0005, 0.03);
    data[s] = makeSeries(c, '2019-01-01', { sentiment: c.map((_, i) => (i % 37 === 0 ? 0.8 : null)) });
  });
  for (const t of TEMPLATES) {
    const r = E.backtest({ code: t.code, data, config: { initialCapital: 100000 } });
    assert.equal(r.equity.length, 800, t.id);
    assert.ok(r.equity.every((v) => Number.isFinite(v) && v > 0), t.id);
    assert.ok(r.finalCash >= -1e-6, `${t.id} negative cash`);
    if (t.id !== 'buy_hold' && t.id !== 'dca') assert.ok(r.metrics.trades + r.openPositions.length > 0, `${t.id} never traded`);
  }
});

test('template params all declare label and default', () => {
  for (const t of TEMPLATES) {
    const s = E.compileStrategy(t.code);
    for (const [k, spec] of Object.entries(s.params || {})) {
      assert.ok(spec.label, `${t.id}.${k} label`);
      assert.ok('default' in spec, `${t.id}.${k} default`);
    }
  }
});

// ------------------------------------------------------------------ offline Turkish parser
const NLP = require('../../public/assets/strategy/nlp.js');

test('offline parser maps Turkish descriptions to templates with numbers', () => {
  const cases = [
    ["THYAO'da RSI 25'in altına inince al, 65 üstünde sat, %7 zarar kes", 'rsi_reversion', { buyBelow: 25, sellAbove: 65, stopLoss: 7 }],
    ['50 günlük ortalama 200 günlüğü yukarı kesince al', 'sma_cross', { fast: 50, slow: 200 }],
    ['55 günlük zirveyi kırınca al 20 günlük dibin altına inince sat', 'donchian', { entry: 55, exit: 20 }],
    ['Son 6 aylık getiriye göre en güçlü 4 hisseyi her ay al', 'momentum_rotation', { top: 4, lookback: 126 }],
    ['olumlu KAP haberi gelince al 3 gün tut', 'kap_sentiment', { hold: 3 }],
    ['Her ay altın al 36 ayda tamamla', 'dca', { months: 36 }],
  ];
  for (const [q, id, expect] of cases) {
    const r = NLP.parse(q, { knownSymbols: ['THYAO'] });
    assert.equal(r.templateId, id, q);
    const p = E.resolveParams(E.compileStrategy(r.code));
    for (const [k, v] of Object.entries(expect)) assert.equal(p[k], v, `${q} -> ${k}`);
  }
});

test('offline parser injects risk params into templates that lack them, and they work', () => {
  const r = NLP.parse('20 günlük EMA ile 50 günlük EMA kesişimi, %15 kâr al, iz süren stop %10');
  assert.match(r.code, /ta\.ema\(/);
  const s = E.compileStrategy(r.code);
  const p = E.resolveParams(s);
  assert.equal(p.riskTarget, 15);
  assert.equal(p.riskTrail, 10);
  const data = { A: makeSeries(randomWalk(600, 4, 0.001, 0.03)) };
  const res = E.backtest({ strategy: s, data });
  assert.ok(res.trades.some((t) => t.reason === 'kâr al' || t.reason === 'iz süren stop'));
});

test('offline parser: symbols, warnings, unknown text', () => {
  const r = NLP.parse('ASELS ve THYAO için açığa satış yap, RSI 30', { knownSymbols: ['ASELS', 'THYAO'] });
  assert.deepEqual(r.symbols, ['ASELS', 'THYAO']);
  assert.ok(r.warnings.length >= 1);
  const u = NLP.parse('bir şeyler yap');
  assert.equal(u.templateId, 'sma_cross');
  assert.equal(u.assumptions.length, 1);
});

// ------------------------------------------------------------------ cash interest and Monte Carlo
test('idle cash earns the configured annual rate, compounded by calendar day', () => {
  const s = makeSeries(new Array(262).fill(100));   // ~1 year of business days, flat price
  const code = 'const strategy = { onBar() {} };';
  const r = E.backtest({ code, data: { A: s }, config: { initialCapital: 100000, cashRatePct: 40 } });
  const days = (Date.parse(s.date.at(-1)) - Date.parse(s.date[0])) / 864e5;
  close(r.equity.at(-1), 100000 * Math.pow(1.4, days / 365), 1e-6);
  close(r.metrics.interest, r.equity.at(-1) - 100000, 1e-6);
  close(r.deposit.equity.at(-1), r.equity.at(-1), 1e-6);
  const r0 = E.backtest({ code, data: { A: s }, config: { initialCapital: 100000 } });
  assert.equal(r0.equity.at(-1), 100000);
  assert.equal(r0.deposit, undefined);
});

test('invested cash earns no interest', () => {
  const s = makeSeries(new Array(100).fill(50));
  const r = E.backtest({ code: BUY_FIRST_DAY, data: { A: s }, config: { initialCapital: 10000, cashRatePct: 50, commissionBps: 0, slippageBps: 0 } });
  // only the leftover cash (< one share) and the first day before the fill earn interest
  assert.ok(r.metrics.interest < 50 * 0.5 + 10000 * 0.002, `interest ${r.metrics.interest}`);
});

test('monteCarlo: percentiles are ordered and reproducible', () => {
  const eq = randomWalk(800, 13, 0.0005, 0.02);
  const a = E.monteCarlo(eq, { runs: 300 });
  const b = E.monteCarlo(eq, { runs: 300 });
  assert.deepEqual(a.totalReturn, b.totalReturn);
  const t = a.totalReturn;
  assert.ok(t.p5 <= t.p25 && t.p25 <= t.p50 && t.p50 <= t.p75 && t.p75 <= t.p95);
  assert.ok(a.maxDrawdown.p5 <= a.maxDrawdown.p95 && a.maxDrawdown.p95 <= 0);
  assert.ok(a.probLoss >= 0 && a.probLoss <= 1);
  assert.equal(a.paths.length, 60);
  assert.equal(E.monteCarlo([1, 2, 3]), null);
});

test('Sharpe uses excess returns over the deposit rate: pure deposit has ~0 Sharpe', () => {
  const s = makeSeries(new Array(300).fill(100));
  const r = E.backtest({ code: 'const strategy = { onBar() {} };', data: { A: s }, config: { cashRatePct: 40 } });
  assert.ok(Math.abs(r.metrics.sharpe ?? 0) < 1e-6 || r.metrics.sharpe === null, `sharpe ${r.metrics.sharpe}`);
  const up = makeSeries(randomWalk(300, 5, 0.002, 0.01));
  const a = E.backtest({ code: BUY_FIRST_DAY, data: { A: up } });
  const b = E.backtest({ code: BUY_FIRST_DAY, data: { A: up }, config: { cashRatePct: 40 } });
  assert.ok(b.metrics.sharpe < a.metrics.sharpe);
});

test('rollingWindows: counts windows and beat rate against a reference', () => {
  const st = makeSeries(new Array(600).fill(0).map((_, i) => 100 * Math.pow(1.001, i)));
  const ref = st.close.map((_, i) => 100 * Math.pow(1.0005, i));
  const r = E.rollingWindows(st.date, st.close, ref, 365);
  assert.ok(r.windows > 300);
  assert.equal(r.beatRate, 1);
  assert.equal(r.positiveRate, 1);
  assert.ok(r.worst <= r.median && r.median <= r.best);
  assert.equal(E.rollingWindows(st.date.slice(0, 50), st.close.slice(0, 50), null, 365), null);
});

test('aggregateBars: weekly and monthly OHLCV, labelled by the last trading day', () => {
  const s = makeSeries([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], '2024-01-01', { sentiment: [null, 0.5, null, 1, null, null, null, null, null, -1, null] });
  const w = E.aggregateBars(s, '1w');
  assert.deepEqual(w.date, ['2024-01-05', '2024-01-12', '2024-01-15']);
  assert.deepEqual(w.close, [14, 19, 20]);
  assert.equal(w.open[0], s.open[0]);
  assert.equal(w.high[1], Math.max(...s.high.slice(5, 10)));
  assert.equal(w.volume[0], 5000);
  assert.deepEqual(w.sentiment, [0.75, -1, null]);
  const m = E.aggregateBars(makeSeries(randomWalk(70)), '1mo');
  assert.equal(m.date.length, 4);
  assert.equal(E.aggregateBars(s, '1d'), s);
});

test('weekly backtest runs on weekly bars and fills on the next weekly bar', () => {
  const s = makeSeries(randomWalk(400, 3));
  const r = E.backtest({ code: BUY_FIRST_DAY, data: { A: s }, config: { timeframe: '1w' } });
  assert.ok(r.dates.length > 75 && r.dates.length < 85);
  assert.equal(r.fills[0].date, r.dates[1]);
});

test('offline parser: "kapanış" is not KAP news; weekly averages are read', () => {
  const r = NLP.parse('Haftalık kapanış 10 haftalık ortalamanın üstündeyse al, 30 haftalık ortalamanın altına inince sat');
  assert.equal(r.templateId, 'sma_cross');
  assert.equal(r.timeframe, '1w');
  const p = E.resolveParams(E.compileStrategy(r.code));
  assert.equal(p.fast, 10); assert.equal(p.slow, 30);
  assert.equal(NLP.parse("KAP'ta olumlu haber gelince al").templateId, 'kap_sentiment');
});

test('drawdown duration is measured in calendar days, not bars', () => {
  const m = E.computeMetrics(['2020-01-01', '2020-01-08', '2020-01-15', '2020-01-22'], [100, 90, 95, 101], []);
  assert.equal(m.maxDrawdownDays, 14);
});

test('riskPercent sizes the position so the stop loses that share of equity', () => {
  const s = makeSeries(new Array(30).fill(100));
  const code = `const strategy = { onBar(ctx) { if (!ctx.state.d) { ctx.buy('A', { riskPercent: 1, stopLoss: 0.05 }); ctx.state.d = 1; } } };`;
  const r = E.backtest({ code, data: { A: s }, config: { initialCapital: 100000, commissionBps: 0, slippageBps: 0 } });
  assert.equal(r.fills[0].shares, 200);   // 1% of 100k = 1000 TL risk / (100 * 5%) = 200 shares
});

test('relative metrics: a 2x levered copy has beta 2 and correlation 1', () => {
  const b = randomWalk(500, 8, 0.0003, 0.01);
  const a = [100];
  for (let k = 1; k < b.length; k++) a.push(a[k - 1] * (1 + 2 * (b[k] / b[k - 1] - 1)));
  const dates = makeSeries(b).date;
  const m = E.relativeMetrics(dates, a, b);
  close(m.beta, 2, 1e-9);
  close(m.correlation, 1, 1e-9);
  assert.ok(Number.isFinite(m.alpha) && Number.isFinite(m.informationRatio));
  assert.equal(E.relativeMetrics(dates.slice(0, 5), a.slice(0, 5), b.slice(0, 5)), null);
});
