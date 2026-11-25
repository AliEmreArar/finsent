// Runs user / LLM strategy code off the main thread. The page sends the code, the market data
// and the settings; the worker answers with the backtest result or a readable error. Strategy
// code never touches the page's DOM, cookies or state. The page terminates the worker if it runs
// too long (an endless loop in the strategy).
/* global importScripts, FinSentEngine */
'use strict';
importScripts('engine.js');

// network access is not part of the strategy API; block it so code stays a pure function of data
self.fetch = undefined;
self.XMLHttpRequest = undefined;
self.WebSocket = undefined;
self.importScripts = undefined;

const E = FinSentEngine;

// keep the payload small: drop arrays the UI does not need for very long runs
function slim(r) {
  return {
    dates: r.dates, equity: r.equity, exposure: r.exposure, drawdown: r.drawdown,
    trades: r.trades.slice(-2000), tradesTotal: r.trades.length, fills: r.fills.slice(-3000), fillsTotal: r.fills.length,
    logs: r.logs, signals: r.signals, openPositions: r.openPositions,
    params: r.params, symbols: r.symbols, corporateActions: r.corporateActions, warnings: r.warnings,
    totalCommission: r.totalCommission, totalInterest: r.totalInterest, finalCash: r.finalCash, metrics: r.metrics, deposit: r.deposit,
    buyHold: r.buyHold, benchmark: r.benchmark, relative: r.relative, periodReturns: r.periodReturns, elapsedMs: r.elapsedMs,
  };
}

function errInfo(e) {
  let line = null;
  const m = /<anonymous>:(\d+):(\d+)/.exec(e && e.stack ? e.stack : '');
  if (m) line = Math.max(1, Number(m[1]) - 3);   // Function() wraps the code with 2 header lines (+1 for 1-based)
  return { message: e && e.message ? e.message : String(e), phase: e.phase || 'compile', date: e.date || null, line };
}

self.onmessage = (ev) => {
  const { id, type, payload } = ev.data || {};
  try {
    if (type === 'inspect') {
      const s = E.compileStrategy(payload.code);
      const params = {};
      for (const [k, spec] of Object.entries(s.params || {})) {
        const o = spec && typeof spec === 'object' ? spec : { default: spec };
        params[k] = { label: o.label || k, default: o.default, min: o.min, max: o.max, step: o.step, options: o.options };
      }
      self.postMessage({ id, ok: true, result: { name: s.name || null, description: s.description || null, params } });
    } else if (type === 'backtest') {
      const r = E.backtest(payload);
      self.postMessage({ id, ok: true, result: slim(r) });
    } else if (type === 'sweep') {
      let last = 0;
      const r = E.sweep({ ...payload, onProgress: (f) => { if (f - last > 0.02 || f === 1) { last = f; self.postMessage({ id, progress: f }); } } });
      self.postMessage({ id, ok: true, result: r });
    } else if (type === 'rolling') {
      const { dates, equity, reference } = payload;
      self.postMessage({ id, ok: true, result: { y1: E.rollingWindows(dates, equity, reference, 365), y3: E.rollingWindows(dates, equity, reference, 3 * 365) } });
    } else if (type === 'montecarlo') {
      self.postMessage({ id, ok: true, result: E.monteCarlo(payload.equity, payload.options || {}) });
    } else if (type === 'walkforward') {
      const r = E.walkForward({ ...payload, onProgress: (f) => self.postMessage({ id, progress: f }) });
      self.postMessage({ id, ok: true, result: r });
    } else {
      throw new Error('unknown message type ' + type);
    }
  } catch (e) {
    self.postMessage({ id, ok: false, error: errInfo(e) });
  }
};
