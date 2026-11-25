// FinSent strategy engine: technical-analysis helpers, an event-driven daily backtester and
// performance metrics. Pure JavaScript with no DOM access, so it runs in the browser's Web
// Worker (strategy code is isolated from the page) and under Node for the unit tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FinSentEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------ technical analysis (ta)
  // Every function takes arrays aligned with the bars and returns an array of the same length,
  // with NaN where there is not enough history yet. Values at index i only use data up to i,
  // so reading ind[i] on bar i never looks into the future.
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const nanArr = (n) => new Array(n).fill(NaN);

  function sma(src, len) {
    const out = nanArr(src.length);
    let sum = 0, cnt = 0;
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      if (isNum(v)) { sum += v; cnt++; }
      if (i >= len) { const o = src[i - len]; if (isNum(o)) { sum -= o; cnt--; } }
      if (i >= len - 1 && cnt === len) out[i] = sum / len;
    }
    return out;
  }

  function ema(src, len) {
    const out = nanArr(src.length);
    const k = 2 / (len + 1);
    let prev = NaN, seed = 0, seen = 0;
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      if (!isNum(v)) { out[i] = prev; continue; }
      if (!isNum(prev)) {
        seed += v; seen++;
        if (seen === len) { prev = seed / len; out[i] = prev; }
        continue;
      }
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  // Wilder smoothing (RSI, ATR, ADX)
  function rma(src, len) {
    const out = nanArr(src.length);
    let prev = NaN, seed = 0, seen = 0;
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      if (!isNum(v)) { out[i] = prev; continue; }
      if (!isNum(prev)) {
        seed += v; seen++;
        if (seen === len) { prev = seed / len; out[i] = prev; }
        continue;
      }
      prev = (prev * (len - 1) + v) / len;
      out[i] = prev;
    }
    return out;
  }

  function change(src, n = 1) {
    return src.map((v, i) => (i >= n && isNum(v) && isNum(src[i - n]) ? v - src[i - n] : NaN));
  }

  function roc(src, n = 1) {
    return src.map((v, i) => (i >= n && isNum(v) && isNum(src[i - n]) && src[i - n] !== 0 ? v / src[i - n] - 1 : NaN));
  }

  function rsi(src, len = 14) {
    const ch = change(src, 1);
    const up = rma(ch.map((c) => (isNum(c) ? Math.max(c, 0) : NaN)), len);
    const dn = rma(ch.map((c) => (isNum(c) ? Math.max(-c, 0) : NaN)), len);
    return up.map((u, i) => {
      const d = dn[i];
      if (!isNum(u) || !isNum(d)) return NaN;
      if (d === 0) return u === 0 ? 50 : 100;
      return 100 - 100 / (1 + u / d);
    });
  }

  function stdev(src, len) {
    const out = nanArr(src.length);
    for (let i = len - 1; i < src.length; i++) {
      let s = 0, s2 = 0, ok = true;
      for (let j = i - len + 1; j <= i; j++) {
        const v = src[j];
        if (!isNum(v)) { ok = false; break; }
        s += v; s2 += v * v;
      }
      if (ok) out[i] = Math.sqrt(Math.max(0, s2 / len - (s / len) ** 2));
    }
    return out;
  }

  function macd(src, fast = 12, slow = 26, signal = 9) {
    const f = ema(src, fast), s = ema(src, slow);
    const line = f.map((v, i) => (isNum(v) && isNum(s[i]) ? v - s[i] : NaN));
    const sig = ema(line, signal);
    return { macd: line, signal: sig, hist: line.map((v, i) => (isNum(v) && isNum(sig[i]) ? v - sig[i] : NaN)) };
  }

  function bollinger(src, len = 20, mult = 2) {
    const mid = sma(src, len), sd = stdev(src, len);
    return {
      mid,
      upper: mid.map((m, i) => (isNum(m) ? m + mult * sd[i] : NaN)),
      lower: mid.map((m, i) => (isNum(m) ? m - mult * sd[i] : NaN)),
      width: mid.map((m, i) => (isNum(m) && m !== 0 ? (2 * mult * sd[i]) / m : NaN)),
    };
  }

  function highest(src, len) {
    const out = nanArr(src.length);
    for (let i = len - 1; i < src.length; i++) {
      let m = -Infinity;
      for (let j = i - len + 1; j <= i; j++) if (isNum(src[j]) && src[j] > m) m = src[j];
      out[i] = m === -Infinity ? NaN : m;
    }
    return out;
  }

  function lowest(src, len) {
    const out = nanArr(src.length);
    for (let i = len - 1; i < src.length; i++) {
      let m = Infinity;
      for (let j = i - len + 1; j <= i; j++) if (isNum(src[j]) && src[j] < m) m = src[j];
      out[i] = m === Infinity ? NaN : m;
    }
    return out;
  }

  function trueRange(high, low, close) {
    return high.map((h, i) => {
      if (!isNum(h) || !isNum(low[i])) return NaN;
      if (i === 0 || !isNum(close[i - 1])) return h - low[i];
      return Math.max(h - low[i], Math.abs(h - close[i - 1]), Math.abs(low[i] - close[i - 1]));
    });
  }

  function atr(high, low, close, len = 14) {
    return rma(trueRange(high, low, close), len);
  }

  function stochastic(high, low, close, k = 14, d = 3) {
    const hh = highest(high, k), ll = lowest(low, k);
    const kk = close.map((c, i) => (isNum(hh[i]) && hh[i] !== ll[i] ? ((c - ll[i]) / (hh[i] - ll[i])) * 100 : NaN));
    return { k: kk, d: sma(kk, d) };
  }

  function adx(high, low, close, len = 14) {
    const n = high.length;
    const plusDM = nanArr(n), minusDM = nanArr(n);
    for (let i = 1; i < n; i++) {
      const up = high[i] - high[i - 1], dn = low[i - 1] - low[i];
      plusDM[i] = up > dn && up > 0 ? up : 0;
      minusDM[i] = dn > up && dn > 0 ? dn : 0;
    }
    const tr = rma(trueRange(high, low, close).map((v, i) => (i === 0 ? NaN : v)), len);
    const p = rma(plusDM, len), m = rma(minusDM, len);
    const plusDI = p.map((v, i) => (isNum(v) && tr[i] ? (100 * v) / tr[i] : NaN));
    const minusDI = m.map((v, i) => (isNum(v) && tr[i] ? (100 * v) / tr[i] : NaN));
    const dx = plusDI.map((v, i) => (isNum(v) && isNum(minusDI[i]) && v + minusDI[i] > 0 ? (100 * Math.abs(v - minusDI[i])) / (v + minusDI[i]) : NaN));
    return { adx: rma(dx, len), plusDI, minusDI };
  }

  function obv(close, volume) {
    const out = nanArr(close.length);
    let acc = 0;
    for (let i = 0; i < close.length; i++) {
      if (i > 0 && isNum(close[i]) && isNum(close[i - 1])) {
        const v = isNum(volume[i]) ? volume[i] : 0;
        acc += close[i] > close[i - 1] ? v : close[i] < close[i - 1] ? -v : 0;
      }
      out[i] = acc;
    }
    return out;
  }

  function zscore(src, len) {
    const m = sma(src, len), sd = stdev(src, len);
    return src.map((v, i) => (isNum(m[i]) && sd[i] > 0 ? (v - m[i]) / sd[i] : NaN));
  }

  // true on the bar where a moves from <= b to > b (b may be a number or an array)
  function crossover(a, b) {
    const bv = (i) => (Array.isArray(b) ? b[i] : b);
    return a.map((v, i) => i > 0 && isNum(v) && isNum(a[i - 1]) && isNum(bv(i)) && isNum(bv(i - 1)) && a[i - 1] <= bv(i - 1) && v > bv(i));
  }

  function crossunder(a, b) {
    const bv = (i) => (Array.isArray(b) ? b[i] : b);
    return a.map((v, i) => i > 0 && isNum(v) && isNum(a[i - 1]) && isNum(bv(i)) && isNum(bv(i - 1)) && a[i - 1] >= bv(i - 1) && v < bv(i));
  }

  // value of src n bars ago, aligned (ref(close, 1)[i] === close[i-1])
  function ref(src, n = 1) {
    return src.map((_, i) => (i >= n ? src[i - n] : NaN));
  }

  const ta = { sma, ema, rma, rsi, macd, bollinger, stdev, highest, lowest, atr, trueRange, stochastic, adx, obv, roc, change, zscore, crossover, crossunder, ref, isNum };

  // ------------------------------------------------------------------ data preparation
  // BIST equities have a ±10% daily price limit, so an overnight move beyond the threshold is
  // almost always a corporate action (bonus issue, split, rights issue) in unadjusted data.
  // Prices before such a jump are scaled so the series is continuous; volume is scaled inversely.
  function adjustCorporateActions(series, threshold = 0.3) {
    const c = series.close;
    const n = c.length;
    const factor = new Array(n).fill(1);
    const events = [];
    for (let i = n - 1; i > 0; i--) {
      factor[i - 1] = factor[i];
      if (!isNum(c[i]) || !isNum(c[i - 1]) || c[i - 1] <= 0) continue;
      const r = c[i] / c[i - 1] - 1;
      if (r < -threshold || r > threshold * 2.5) {
        const f = c[i] / c[i - 1];
        factor[i - 1] = factor[i] * f;
        events.push({ date: series.date[i], ratio: f });
      }
    }
    if (!events.length) return { series, events };
    const scale = (arr) => arr && arr.map((v, i) => (isNum(v) ? v * factor[i] : v));
    return {
      series: {
        ...series,
        open: scale(series.open), high: scale(series.high), low: scale(series.low), close: scale(series.close),
        volume: series.volume && series.volume.map((v, i) => (isNum(v) ? v / factor[i] : v)),
      },
      events: events.reverse(),
    };
  }

  // Daily bars -> weekly ('1w', week labelled by its last trading day) or monthly ('1mo') bars.
  // Sentiment becomes the mean of the period's non-null daily values.
  function aggregateBars(s, timeframe) {
    if (!timeframe || timeframe === '1d') return s;
    const key = (d) => {
      if (timeframe === '1mo') return d.slice(0, 7);
      const t = new Date(d + 'T00:00:00Z');
      const monday = new Date(t.getTime() - ((t.getUTCDay() + 6) % 7) * 864e5);
      return monday.toISOString().slice(0, 10);
    };
    const out = { date: [], open: [], high: [], low: [], close: [], volume: [], sentiment: [] };
    let cur = null, sSum = 0, sN = 0;
    const flush = () => {
      if (!cur) return;
      out.sentiment.push(sN ? sSum / sN : null);
      sSum = 0; sN = 0;
    };
    s.date.forEach((d, i) => {
      const k = key(d);
      if (!cur || cur !== k) {
        flush();
        cur = k;
        out.date.push(d); out.open.push(s.open?.[i] ?? s.close[i]); out.high.push(s.high?.[i] ?? s.close[i]);
        out.low.push(s.low?.[i] ?? s.close[i]); out.close.push(s.close[i]); out.volume.push(s.volume?.[i] ?? 0);
      } else {
        const j = out.date.length - 1;
        out.date[j] = d;   // label with the last trading day, so fills happen after the period closes
        out.high[j] = Math.max(out.high[j], s.high?.[i] ?? s.close[i]);
        out.low[j] = Math.min(out.low[j], s.low?.[i] ?? s.close[i]);
        out.close[j] = s.close[i];
        out.volume[j] += s.volume?.[i] ?? 0;
      }
      const sv = s.sentiment?.[i];
      if (isNum(sv)) { sSum += sv; sN++; }
    });
    flush();
    return { ...s, ...out };
  }

  // Aligns several symbols on one calendar (the union of their trading days). A symbol with no
  // bar on a day gets null there and cannot be traded that day.
  function alignSeries(raw, calendar) {
    const dates = calendar || [...new Set(Object.values(raw).flatMap((s) => s.date))].sort();
    const pos = new Map(dates.map((d, i) => [d, i]));
    const out = {};
    for (const [sym, s] of Object.entries(raw)) {
      const blank = () => new Array(dates.length).fill(null);
      const a = { date: dates, open: blank(), high: blank(), low: blank(), close: blank(), volume: blank(), sentiment: blank(), has: new Array(dates.length).fill(false) };
      s.date.forEach((d, k) => {
        const i = pos.get(d);
        if (i === undefined) return;
        a.open[i] = isNum(s.open?.[k]) ? s.open[k] : s.close[k];
        a.high[i] = isNum(s.high?.[k]) ? s.high[k] : s.close[k];
        a.low[i] = isNum(s.low?.[k]) ? s.low[k] : s.close[k];
        a.close[i] = s.close[k];
        a.volume[i] = isNum(s.volume?.[k]) ? s.volume[k] : 0;
        a.sentiment[i] = isNum(s.sentiment?.[k]) ? s.sentiment[k] : null;
        a.has[i] = isNum(s.close[k]);
      });
      // carry the last close forward over gaps so indicators and valuation stay defined
      let last = null;
      for (let i = 0; i < dates.length; i++) {
        if (a.has[i]) { last = a.close[i]; continue; }
        if (last !== null) { a.open[i] = a.high[i] = a.low[i] = a.close[i] = last; a.volume[i] = 0; }
      }
      out[sym] = a;
    }
    return { dates, series: out };
  }

  // ------------------------------------------------------------------ strategy compilation
  // The strategy is plain JavaScript that defines `const strategy = { params, indicators, onBar }`.
  function compileStrategy(code) {
    if (typeof code !== 'string' || !code.trim()) throw new Error('Strateji kodu boş.');
    // eslint-disable-next-line no-new-func
    const factory = new Function('ta', '"use strict";\n' + code + '\n;return (typeof strategy !== "undefined") ? strategy : undefined;');
    const s = factory(ta);
    if (!s || typeof s !== 'object') throw new Error('Kod `const strategy = { ... }` nesnesini tanımlamalı.');
    if (typeof s.onBar !== 'function') throw new Error('strategy.onBar(ctx, p) fonksiyonu tanımlı değil.');
    if (s.indicators !== undefined && typeof s.indicators !== 'function') throw new Error('strategy.indicators bir fonksiyon olmalı.');
    return s;
  }

  function resolveParams(strategy, overrides = {}) {
    const p = {};
    for (const [k, spec] of Object.entries(strategy.params || {})) {
      const def = spec && typeof spec === 'object' && 'default' in spec ? spec.default : spec;
      let v = k in overrides ? overrides[k] : def;
      if (typeof def === 'number') {
        v = Number(v);
        if (!Number.isFinite(v)) v = def;
        if (spec && isNum(spec.min)) v = Math.max(spec.min, v);
        if (spec && isNum(spec.max)) v = Math.min(spec.max, v);
      } else if (typeof def === 'boolean') v = v === true || v === 'true';
      p[k] = v;
    }
    for (const [k, v] of Object.entries(overrides)) if (!(k in p)) p[k] = v;
    return p;
  }

  // ------------------------------------------------------------------ backtester
  const DEFAULTS = {
    initialCapital: 100000,
    commissionBps: 10,   // per side, 0.10%
    slippageBps: 5,      // per side, applied against you
    fill: 'next_open',   // 'next_open' (default, no look-ahead) | 'close'
    lotSize: 1,
    maxBarsOps: 5e7,
    adjustCorporateActions: true,
    startDate: null,     // trading begins here; earlier bars are indicator warm-up only
    cashRatePct: 0,
    timeframe: '1d',     // '1d' | '1w' | '1mo': bars are aggregated before indicators run      // annual interest on idle cash (TL deposit / money-market fund), compounded per calendar day
  };

  class StrategyError extends Error {
    constructor(message, info = {}) { super(message); this.name = 'StrategyError'; Object.assign(this, info); }
  }

  function backtest({ code, strategy, data, params = {}, config = {}, benchmark = null }) {
    const cfg = { ...DEFAULTS, ...config };
    const strat = strategy || compileStrategy(code);
    const p = resolveParams(strat, params);
    const warnings = [];
    const t0 = Date.now();

    // corporate-action adjustment per symbol, then alignment
    const raw = {};
    const corporateActions = {};
    for (const [sym, s0] of Object.entries(data)) {
      if (!s0 || !s0.date || !s0.date.length) { warnings.push(`${sym}: veri yok, atlandı.`); continue; }
      let s = s0;
      if (cfg.adjustCorporateActions && !s.noAdjust) {
        const r = adjustCorporateActions(s);
        s = r.series;
        if (r.events.length) corporateActions[sym] = r.events;
      }
      raw[sym] = aggregateBars(s, cfg.timeframe);
    }
    const symbols = Object.keys(raw);
    if (!symbols.length) throw new StrategyError('Seçilen hisseler için veri bulunamadı.');
    const { dates, series } = alignSeries(raw);
    const n = dates.length;
    let start = 0;
    if (cfg.startDate) {
      // with weekly / monthly bars, the first bar whose period ends on or after the start date
      start = dates.findIndex((d) => d >= cfg.startDate);
      if (start < 0) throw new StrategyError('Başlangıç tarihinden sonra veri yok.');
    }
    if (n - start < 2) throw new StrategyError('Test için yeterli bar yok.');

    // indicators, computed once per symbol on the full (adjusted) history
    const ind = {};
    for (const sym of symbols) {
      if (!strat.indicators) { ind[sym] = {}; continue; }
      try {
        const s = series[sym];
        const res = strat.indicators({ date: s.date, open: s.open, high: s.high, low: s.low, close: s.close, volume: s.volume, sentiment: s.sentiment }, p, ta, sym);
        ind[sym] = res && typeof res === 'object' ? res : {};
      } catch (e) {
        throw new StrategyError(`indicators() hatası (${sym}): ${e.message}`, { phase: 'indicators', stack: e.stack });
      }
    }

    // ---- portfolio state
    let cash = cfg.initialCapital;
    const positions = {};   // sym -> {shares, avgPrice, entryIndex, entryDate, stopLoss, takeProfit, trailingStop, peak, cost}
    const trades = [];      // closed round trips
    const fills = [];       // every executed order
    const logs = [];
    const equity = new Array(n).fill(null);
    const exposure = new Array(n).fill(null);
    let pending = [];
    const state = {};
    const comm = cfg.commissionBps / 1e4, slip = cfg.slippageBps / 1e4;
    const lot = Math.max(1, cfg.lotSize | 0);
    let totalCommission = 0;
    let totalInterest = 0;
    const dailyRate = cfg.cashRatePct > 0 ? Math.pow(1 + cfg.cashRatePct / 100, 1 / 365) - 1 : 0;
    let i = start;

    const px = (sym, k = i) => series[sym].close[k];
    const valueAt = (k) => {
      let v = cash;
      for (const [sym, pos] of Object.entries(positions)) v += pos.shares * (px(sym, k) ?? pos.avgPrice);
      return v;
    };

    function execute(order, k, priceField) {
      const s = series[order.sym];
      if (!s.has[k]) return false;  // no trading on a day the stock did not trade
      const base = s[priceField][k];
      if (!isNum(base) || base <= 0) return false;
      const pos = positions[order.sym];
      if (order.side === 'buy') {
        const price = base * (1 + slip);
        const eq = valueAt(k - (priceField === 'open' ? 1 : 0));
        let budget;
        if (order.shares != null) budget = order.shares * price * (1 + comm);
        else if (order.amount != null) budget = order.amount;
        else if (order.riskPercent != null && order.stopLoss) budget = (eq * order.riskPercent) / 100 / order.stopLoss;   // lose riskPercent of equity if the stop is hit
        else if (order.percent != null) budget = (eq * order.percent) / 100;
        else if (order.targetPercent != null) {
          const cur = pos ? pos.shares * base : 0;
          budget = (eq * order.targetPercent) / 100 - cur;
          if (budget < 0) return execute({ ...order, side: 'sell', shares: Math.floor(-budget / base / lot) * lot, reason: order.reason || 'hedef ağırlık' }, k, priceField);
        } else budget = cash;
        budget = Math.min(budget, cash);
        let shares = Math.floor(budget / (price * (1 + comm)) / lot) * lot;
        if (order.shares != null) shares = Math.min(shares, Math.floor(order.shares / lot) * lot);
        if (shares <= 0) return false;
        const gross = shares * price, fee = gross * comm;
        cash -= gross + fee;
        totalCommission += fee;
        if (pos) {
          pos.avgPrice = (pos.avgPrice * pos.shares + gross) / (pos.shares + shares);
          pos.shares += shares;
          pos.cost += gross + fee;
        } else {
          positions[order.sym] = { shares, avgPrice: price, entryIndex: k, entryDate: dates[k], cost: gross + fee, peak: price,
            stopLoss: order.stopLoss ?? null, takeProfit: order.takeProfit ?? null, trailingStop: order.trailingStop ?? null };
        }
        const np = positions[order.sym];
        if (order.stopLoss != null) np.stopLoss = order.stopLoss;
        if (order.takeProfit != null) np.takeProfit = order.takeProfit;
        if (order.trailingStop != null) np.trailingStop = order.trailingStop;
        fills.push({ date: dates[k], sym: order.sym, side: 'buy', shares, price, fee, reason: order.reason || '' });
        return true;
      }
      // sell
      if (!pos) return false;
      let shares = order.shares != null ? Math.floor(order.shares / lot) * lot
        : order.percent != null ? Math.floor((pos.shares * order.percent) / 100 / lot) * lot : pos.shares;
      shares = Math.min(shares, pos.shares);
      if (shares <= 0) return false;
      const price = (order.price ?? base) * (1 - slip);
      const gross = shares * price, fee = gross * comm;
      cash += gross - fee;
      totalCommission += fee;
      const costPart = (pos.cost * shares) / pos.shares;
      const pnl = gross - fee - costPart;
      fills.push({ date: dates[k], sym: order.sym, side: 'sell', shares, price, fee, reason: order.reason || '' });
      trades.push({ sym: order.sym, entryDate: pos.entryDate, exitDate: dates[k], shares, entryPrice: pos.avgPrice, exitPrice: price,
        pnl, returnPct: pnl / costPart, bars: k - pos.entryIndex, reason: order.reason || '' });
      pos.cost -= costPart;
      pos.shares -= shares;
      if (pos.shares <= 0) delete positions[order.sym];
      return true;
    }

    // protective exits during bar k, using its high/low (stop first: the conservative assumption)
    function checkStops(k) {
      for (const [sym, pos] of Object.entries(positions)) {
        const s = series[sym];
        if (!s.has[k]) continue;
        const o = s.open[k], h = s.high[k], l = s.low[k];
        const fixed = pos.stopLoss != null ? pos.avgPrice * (1 - pos.stopLoss) : null;
        const trail = pos.trailingStop != null ? pos.peak * (1 - pos.trailingStop) : null;
        const stop = fixed == null ? trail : trail == null ? fixed : Math.max(fixed, trail);
        const tp = pos.takeProfit != null ? pos.avgPrice * (1 + pos.takeProfit) : null;
        if (stop != null && l <= stop) {
          const reason = trail != null && stop === trail ? 'iz süren stop' : 'zarar kes';
          execute({ sym, side: 'sell', price: Math.min(o, stop), reason }, k, 'close');
          continue;
        }
        if (tp != null && h >= tp) {
          execute({ sym, side: 'sell', price: Math.max(o, tp), reason: 'kâr al' }, k, 'close');
          continue;
        }
        if (h > pos.peak) pos.peak = h;
      }
    }

    const posView = (sym) => {
      const pos = positions[sym];
      if (!pos) return null;
      const c = px(sym);
      return { shares: pos.shares, avgPrice: pos.avgPrice, entryDate: pos.entryDate, barsHeld: i - pos.entryIndex,
        value: pos.shares * c, pnlPct: c / pos.avgPrice - 1, stopLoss: pos.stopLoss, takeProfit: pos.takeProfit, trailingStop: pos.trailingStop };
    };
    const checkSym = (sym) => {
      if (!series[sym]) throw new StrategyError(`Bilinmeyen sembol: ${sym}. Seçili hisseler: ${symbols.join(', ')}`);
      return sym;
    };
    const ctx = {
      symbols, params: p, state, ta, timeframe: cfg.timeframe || '1d',
      get i() { return i; },
      get date() { return dates[i]; },
      get cash() { return cash; },
      get equity() { return valueAt(i); },
      get isLastBar() { return i === n - 1; },
      bar(sym, ago = 0) {
        checkSym(sym);
        const k = i - ago, s = series[sym];
        if (k < 0 || !s.has[k]) return null;
        return { date: dates[k], open: s.open[k], high: s.high[k], low: s.low[k], close: s.close[k], volume: s.volume[k], sentiment: s.sentiment[k] };
      },
      has(sym) { return series[checkSym(sym)].has[i]; },
      close(sym, ago = 0) { checkSym(sym); return i - ago >= 0 ? series[sym].close[i - ago] : NaN; },
      series(sym) { return series[checkSym(sym)]; },
      ind(sym, name, ago = 0) {
        checkSym(sym);
        const arr = ind[sym][name];
        if (arr === undefined) throw new StrategyError(`'${name}' göstergesi indicators() içinde döndürülmedi.`);
        if (Array.isArray(arr)) return i - ago >= 0 ? arr[i - ago] : NaN;
        return arr;
      },
      indicators(sym) { return ind[checkSym(sym)]; },
      sentiment(sym, ago = 0) { checkSym(sym); return series[sym].sentiment[i - ago] ?? null; },
      position(sym) { return posView(checkSym(sym)); },
      positions() { return Object.keys(positions).map((s) => ({ sym: s, ...posView(s) })); },
      buy(sym, opts = {}) { pending.push({ ...normOpts(opts), sym: checkSym(sym), side: 'buy' }); },
      sell(sym, opts = {}) { pending.push({ ...normOpts(opts), sym: checkSym(sym), side: 'sell' }); },
      targetPercent(sym, pct, opts = {}) {
        checkSym(sym);
        if (pct <= 0) pending.push({ ...normOpts(opts), sym, side: 'sell' });
        else pending.push({ ...normOpts(opts), sym, side: 'buy', targetPercent: pct });
      },
      closeAll(reason = 'tümünü kapat') { for (const s of Object.keys(positions)) pending.push({ sym: s, side: 'sell', reason }); },
      setStop(sym, { stopLoss, takeProfit, trailingStop } = {}) {
        const pos = positions[checkSym(sym)];
        if (!pos) return;
        if (stopLoss !== undefined) pos.stopLoss = stopLoss;
        if (takeProfit !== undefined) pos.takeProfit = takeProfit;
        if (trailingStop !== undefined) pos.trailingStop = trailingStop;
      },
      log(...a) { if (logs.length < 500) logs.push({ date: dates[i], msg: a.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ') }); },
    };
    function normOpts(o) {
      if (typeof o === 'number') return { percent: o };
      const out = { ...o };
      for (const k of ['stopLoss', 'takeProfit', 'trailingStop']) {
        if (out[k] != null) {
          let v = Number(out[k]);
          if (v > 1) v = v / 100;   // "8" means 8 %
          out[k] = v > 0 && v < 1 ? v : null;
        }
      }
      return out;
    }

    // ---- main loop
    const priceField = cfg.fill === 'close' ? 'close' : 'open';
    for (i = start; i < n; i++) {
      if (dailyRate && i > start && cash > 0) {
        const days = Math.max(0, Math.round((Date.parse(dates[i]) - Date.parse(dates[i - 1])) / 864e5));
        const interest = cash * (Math.pow(1 + dailyRate, days) - 1);
        cash += interest;
        totalInterest += interest;
      }
      if (priceField === 'open' && pending.length) {
        // sells first so their cash funds the buys
        const orders = pending; pending = [];
        orders.filter((o) => o.side === 'sell').forEach((o) => execute(o, i, 'open'));
        orders.filter((o) => o.side === 'buy').forEach((o) => execute(o, i, 'open'));
      }
      checkStops(i);
      try {
        strat.onBar(ctx, p);
      } catch (e) {
        if (e instanceof StrategyError) { if (!e.phase) { e.phase = 'onBar'; e.date = dates[i]; e.stack = e.stack || ''; } throw e; }
        throw new StrategyError(`onBar() hatası (${dates[i]}): ${e.message}`, { phase: 'onBar', date: dates[i], stack: e.stack });
      }
      if (priceField === 'close' && pending.length) {
        const orders = pending; pending = [];
        orders.filter((o) => o.side === 'sell').forEach((o) => execute(o, i, 'close'));
        orders.filter((o) => o.side === 'buy').forEach((o) => execute(o, i, 'close'));
      }
      equity[i] = valueAt(i);
      exposure[i] = equity[i] > 0 ? 1 - cash / equity[i] : 0;
    }
    i = n - 1;
    // orders placed on the last bar: these are "today's signals"
    const signals = pending.map((o) => ({ sym: o.sym, side: o.side, reason: o.reason || '', percent: o.percent ?? o.targetPercent ?? null }));
    const open = Object.keys(positions).map((s) => ({ sym: s, ...posView(s) }));

    const eqDates = dates.slice(start), eqVals = equity.slice(start);
    const result = {
      dates: eqDates, equity: eqVals, exposure: exposure.slice(start),
      trades, fills, logs, signals, openPositions: open,
      params: p, symbols, corporateActions, warnings, config: cfg,
      totalCommission, totalInterest, finalCash: cash,
    };
    const rf = cfg.cashRatePct || 0;
    result.metrics = computeMetrics(eqDates, eqVals, trades, { exposure: exposure.slice(start), initial: cfg.initialCapital, commission: totalCommission, rfAnnualPct: rf });
    result.metrics.interest = totalInterest;
    if (dailyRate) {
      // the same cash rate as a benchmark: what parking all the money in deposits would have earned
      const d0 = Date.parse(eqDates[0]);
      const dep = eqDates.map((d) => cfg.initialCapital * Math.pow(1 + dailyRate, Math.round((Date.parse(d) - d0) / 864e5)));
      result.deposit = { equity: dep, metrics: computeMetrics(eqDates, dep, [], { initial: cfg.initialCapital, rfAnnualPct: rf }) };
    }

    // benchmarks: buy-and-hold of the strategy's stocks (equal weight) and an optional index
    const bh = buyAndHold(series, symbols, start, cfg);
    result.buyHold = { equity: bh, metrics: computeMetrics(eqDates, bh, [], { initial: cfg.initialCapital, rfAnnualPct: rf }) };
    if (benchmark && benchmark.date && benchmark.date.length) {
      // the benchmark stays daily: alignBenchmark samples it on the strategy's bar dates
      const bm = alignBenchmark(benchmark, eqDates, cfg.initialCapital);
      if (bm) {
        result.benchmark = { name: benchmark.name || 'Endeks', equity: bm, metrics: computeMetrics(eqDates, bm, [], { initial: cfg.initialCapital, rfAnnualPct: rf }) };
        result.relative = relativeMetrics(eqDates, eqVals, bm);
      }
    }
    result.periodReturns = periodReturns(eqDates, eqVals);
    result.drawdown = drawdownSeries(eqVals);
    result.elapsedMs = Date.now() - t0;
    if (trades.length === 0 && open.length === 0) warnings.push('Strateji test süresince hiç işlem yapmadı. Koşulları veya parametreleri gözden geçir.');
    return result;
  }

  function buyAndHold(series, symbols, start, cfg) {
    const per = cfg.initialCapital / symbols.length;
    const comm = cfg.commissionBps / 1e4;
    const units = symbols.map((s) => {
      const k = series[s].has.findIndex((h, j) => h && j >= start);
      return k < 0 ? { k: Infinity, u: 0 } : { k, u: (per * (1 - comm)) / series[s].close[k] };
    });
    const out = [];
    for (let k = start; k < series[symbols[0]].close.length; k++) {
      let v = 0;
      symbols.forEach((s, j) => { v += k >= units[j].k ? units[j].u * series[s].close[k] : per; });
      out.push(v);
    }
    return out;
  }

  function alignBenchmark(b, dates, initial) {
    const map = new Map(b.date.map((d, k) => [d, b.close[k]]));
    let last = null, first = null;
    const vals = dates.map((d) => {
      const v = map.get(d);
      if (isNum(v)) { last = v; if (first === null) first = v; }
      return last;
    });
    if (first === null) {
      // benchmark starts before the window: take the last value before the first date
      for (let k = b.date.length - 1; k >= 0; k--) if (b.date[k] <= dates[0]) { first = b.close[k]; break; }
      if (first === null) return null;
    }
    return vals.map((v) => (v === null ? initial : (initial * v) / first));
  }

  // ------------------------------------------------------------------ metrics
  function drawdownSeries(eq) {
    let peak = -Infinity;
    return eq.map((v) => { if (v > peak) peak = v; return peak > 0 ? v / peak - 1 : 0; });
  }

  function yearsBetween(a, b) {
    return (new Date(b) - new Date(a)) / (365.25 * 864e5);
  }

  function computeMetrics(dates, eq, trades, extra = {}) {
    const n = eq.length;
    const initial = extra.initial ?? eq[0];
    const final = eq[n - 1];
    const rets = [];
    for (let k = 1; k < n; k++) if (eq[k - 1] > 0) rets.push(eq[k] / eq[k - 1] - 1);
    const years = Math.max(yearsBetween(dates[0], dates[n - 1]), 1 / 365);
    const periodsPerYear = rets.length / years || 252;
    // Sharpe / Sortino on returns in excess of the risk-free (deposit) rate when one is given
    const rfDaily = extra.rfAnnualPct ? Math.pow(1 + extra.rfAnnualPct / 100, 1 / 365) - 1 : 0;
    const ex = [];
    for (let k = 1, j = 0; k < n; k++) {
      if (!(eq[k - 1] > 0)) continue;
      const days = rfDaily ? Math.max(0, Math.round((Date.parse(dates[k]) - Date.parse(dates[k - 1])) / 864e5)) : 0;
      ex.push(rets[j++] - (rfDaily ? Math.pow(1 + rfDaily, days) - 1 : 0));
    }
    const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
    const exMean = ex.reduce((a, b) => a + b, 0) / (ex.length || 1);
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1));
    const downs = ex.filter((r) => r < 0);
    const dsd = Math.sqrt(downs.reduce((a, b) => a + b * b, 0) / Math.max(1, ex.length));
    const dd = drawdownSeries(eq);
    let maxDD = 0, ddStart = 0, maxDur = 0, curStart = 0;
    for (let k = 0; k < n; k++) {
      if (dd[k] === 0) curStart = k;
      else { const dur = Math.round((Date.parse(dates[k]) - Date.parse(dates[curStart])) / 864e5); if (dur > maxDur) { maxDur = dur; ddStart = curStart; } }
      if (dd[k] < maxDD) maxDD = dd[k];
    }
    const totalReturn = final / initial - 1;
    const cagr = final > 0 ? Math.pow(final / initial, 1 / years) - 1 : -1;
    const vol = sd * Math.sqrt(periodsPerYear);
    const wins = trades.filter((t) => t.pnl > 0), losses = trades.filter((t) => t.pnl <= 0);
    const grossWin = wins.reduce((a, t) => a + t.pnl, 0), grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
    const exp = extra.exposure ? extra.exposure.filter(isNum) : null;
    return {
      initial, final, totalReturn, cagr, years,
      volatility: vol,
      sharpe: sd > 0 ? (exMean / sd) * Math.sqrt(periodsPerYear) : null,
      sortino: dsd > 0 ? (exMean / dsd) * Math.sqrt(periodsPerYear) : null,
      maxDrawdown: maxDD,
      maxDrawdownDays: maxDur,
      maxDrawdownStart: dates[ddStart] ?? null,
      calmar: maxDD < 0 ? cagr / -maxDD : null,
      trades: trades.length,
      winRate: trades.length ? wins.length / trades.length : null,
      avgTrade: trades.length ? trades.reduce((a, t) => a + t.returnPct, 0) / trades.length : null,
      avgWin: wins.length ? wins.reduce((a, t) => a + t.returnPct, 0) / wins.length : null,
      avgLoss: losses.length ? losses.reduce((a, t) => a + t.returnPct, 0) / losses.length : null,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : wins.length ? Infinity : null,
      bestTrade: trades.length ? Math.max(...trades.map((t) => t.returnPct)) : null,
      worstTrade: trades.length ? Math.min(...trades.map((t) => t.returnPct)) : null,
      avgBarsHeld: trades.length ? trades.reduce((a, t) => a + t.bars, 0) / trades.length : null,
      exposure: exp && exp.length ? exp.reduce((a, b) => a + b, 0) / exp.length : null,
      commission: extra.commission ?? null,
      bestDay: rets.length ? Math.max(...rets) : null,
      worstDay: rets.length ? Math.min(...rets) : null,
    };
  }

  // beta, annualised alpha (Jensen, vs the benchmark), correlation, tracking error, information ratio
  function relativeMetrics(dates, eq, bench) {
    const a = [], b = [];
    for (let k = 1; k < eq.length; k++) {
      if (eq[k - 1] > 0 && bench[k - 1] > 0 && isNum(bench[k]) && isNum(eq[k])) { a.push(eq[k] / eq[k - 1] - 1); b.push(bench[k] / bench[k - 1] - 1); }
    }
    const n = a.length;
    if (n < 20) return null;
    const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
    let cov = 0, va = 0, vb = 0, te = 0;
    for (let k = 0; k < n; k++) { cov += (a[k] - ma) * (b[k] - mb); va += (a[k] - ma) ** 2; vb += (b[k] - mb) ** 2; te += (a[k] - b[k] - (ma - mb)) ** 2; }
    const years = Math.max(yearsBetween(dates[0], dates[dates.length - 1]), 1 / 365);
    const ppy = n / years;
    const beta = vb > 0 ? cov / vb : null;
    const teAnn = Math.sqrt(te / Math.max(1, n - 1)) * Math.sqrt(ppy);
    return {
      beta,
      alpha: beta !== null ? (ma - beta * mb) * ppy : null,
      correlation: va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : null,
      trackingError: teAnn,
      informationRatio: teAnn > 0 ? ((ma - mb) * ppy) / teAnn : null,
    };
  }

  function periodReturns(dates, eq) {
    const monthly = {}, yearly = {};
    let prevM = null, prevY = null, baseM = eq[0], baseY = eq[0];
    for (let k = 0; k < dates.length; k++) {
      const y = dates[k].slice(0, 4), m = dates[k].slice(0, 7);
      if (prevM !== null && m !== prevM) { monthly[prevM] = eq[k - 1] / baseM - 1; baseM = eq[k - 1]; }
      if (prevY !== null && y !== prevY) { yearly[prevY] = eq[k - 1] / baseY - 1; baseY = eq[k - 1]; }
      prevM = m; prevY = y;
    }
    if (prevM) monthly[prevM] = eq.at(-1) / baseM - 1;
    if (prevY) yearly[prevY] = eq.at(-1) / baseY - 1;
    return { monthly, yearly };
  }

  // ------------------------------------------------------------------ parameter sweep
  // Cartesian grid over the given ranges, capped. Returns one row per combination with the
  // key metrics; the caller decides how to display it.
  function gridValues({ min, max, step }) {
    const out = [];
    const st = step > 0 ? step : 1;
    for (let v = min; v <= max + 1e-9 && out.length < 60; v += st) out.push(Math.round(v * 1e6) / 1e6);
    return out;
  }

  function sweep({ code, data, params = {}, config = {}, grid, maxRuns = 400, onProgress }) {
    const strat = compileStrategy(code);
    const keys = Object.keys(grid);
    const axes = keys.map((k) => gridValues(grid[k]));
    const combos = axes.reduce((acc, vals, j) => acc.flatMap((c) => vals.map((v) => ({ ...c, [keys[j]]: v }))), [{}]);
    if (combos.length > maxRuns) throw new StrategyError(`Çok fazla kombinasyon (${combos.length}). En fazla ${maxRuns}.`);
    const rows = [];
    combos.forEach((c, j) => {
      try {
        const r = backtest({ strategy: strat, data, params: { ...params, ...c }, config });
        const m = r.metrics;
        rows.push({ params: c, totalReturn: m.totalReturn, cagr: m.cagr, sharpe: m.sharpe, maxDrawdown: m.maxDrawdown, trades: m.trades, winRate: m.winRate });
      } catch (e) {
        rows.push({ params: c, error: e.message });
      }
      if (onProgress) onProgress((j + 1) / combos.length);
    });
    return { keys, axes, rows };
  }

  // In-sample / out-of-sample split: the best parameters on the first part, evaluated on the rest.
  function walkForward({ code, data, params = {}, config = {}, grid, splitDate, metric = 'sharpe', onProgress }) {
    const inCfg = { ...config, endDate: splitDate };
    const trimmed = {};
    for (const [s, d] of Object.entries(data)) {
      const k = d.date.findIndex((x) => x >= splitDate);
      const end = k < 0 ? d.date.length : k;
      trimmed[s] = Object.fromEntries(Object.entries(d).map(([f, arr]) => [f, Array.isArray(arr) ? arr.slice(0, end) : arr]));
    }
    const ins = sweep({ code, data: trimmed, params, config: inCfg, grid, onProgress });
    const valid = ins.rows.filter((r) => !r.error && isNum(r[metric]));
    if (!valid.length) throw new StrategyError('Eğitim döneminde geçerli sonuç yok.');
    valid.sort((a, b) => b[metric] - a[metric]);
    const best = valid[0];
    const out = backtest({ code, data, params: { ...params, ...best.params }, config: { ...config, startDate: splitDate } });
    return { best, inSample: ins, outOfSample: { metrics: out.metrics, buyHold: out.buyHold.metrics } };
  }

  // ------------------------------------------------------------------ Monte Carlo
  // Block bootstrap of the strategy's daily returns: shuffles 20-day blocks to build many
  // alternative histories of the same length. Shows how much of the result is the luck of the
  // order of returns, and what drawdowns are plausible.
  function monteCarlo(equity, { runs = 1000, block = 20, seed = 7 } = {}) {
    const rets = [];
    for (let k = 1; k < equity.length; k++) if (equity[k - 1] > 0) rets.push(equity[k] / equity[k - 1] - 1);
    const n = rets.length;
    if (n < block * 2) return null;
    let st = seed >>> 0;
    const rnd = () => { st = (st * 1664525 + 1013904223) >>> 0; return st / 4294967296; };
    const finals = [], dds = [], paths = [];
    const keepEvery = Math.max(1, Math.floor(n / 120));
    for (let r = 0; r < runs; r++) {
      let v = 1, peak = 1, mdd = 0, k = 0;
      const path = r < 60 ? [1] : null;
      while (k < n) {
        const b0 = Math.floor(rnd() * (n - block + 1));
        for (let j = 0; j < block && k < n; j++, k++) {
          v *= 1 + rets[b0 + j];
          if (v > peak) peak = v;
          const dd = v / peak - 1;
          if (dd < mdd) mdd = dd;
          if (path && k % keepEvery === 0) path.push(v);
        }
      }
      finals.push(v - 1);
      dds.push(mdd);
      if (path) paths.push(path);
    }
    const q = (arr, p) => { const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))))]; };
    return {
      runs, block, days: n,
      totalReturn: { p5: q(finals, 0.05), p25: q(finals, 0.25), p50: q(finals, 0.5), p75: q(finals, 0.75), p95: q(finals, 0.95) },
      maxDrawdown: { p5: q(dds, 0.05), p50: q(dds, 0.5), p95: q(dds, 0.95) },
      probLoss: finals.filter((x) => x < 0).length / runs,
      finals, paths,
    };
  }

  // ------------------------------------------------------------------ rolling windows
  // Return of every window of `days` calendar days (one per bar start), for the strategy and a
  // reference curve: how often the strategy was ahead, and the worst / best window.
  function rollingWindows(dates, eq, ref, days = 365) {
    const t = dates.map((d) => Date.parse(d));
    const rows = [];
    let j = 0;
    for (let i = 0; i < dates.length; i++) {
      while (j < dates.length && t[j] - t[i] < days * 864e5) j++;
      if (j >= dates.length) break;
      const a = eq[j] / eq[i] - 1;
      const b = ref ? ref[j] / ref[i] - 1 : null;
      rows.push({ start: dates[i], end: dates[j], strategy: a, reference: b });
    }
    if (!rows.length) return null;
    const s = rows.map((r) => r.strategy).sort((x, y) => x - y);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
    return {
      days, windows: rows.length,
      beatRate: ref ? rows.filter((r) => r.strategy > r.reference).length / rows.length : null,
      positiveRate: rows.filter((r) => r.strategy > 0).length / rows.length,
      worst: s[0], median: q(0.5), best: s[s.length - 1],
      rows,
    };
  }

  return { ta, backtest, monteCarlo, rollingWindows, aggregateBars, relativeMetrics, compileStrategy, resolveParams, computeMetrics, adjustCorporateActions, alignSeries, sweep, walkForward, gridValues, periodReturns, drawdownSeries, StrategyError, DEFAULTS };
});
