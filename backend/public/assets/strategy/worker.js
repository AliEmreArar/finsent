// Runs user / LLM strategy code off the main thread. The page sends the code, the market data
// and the settings; the worker answers with the backtest result or a readable error. Strategy
// code never touches the page's DOM, cookies or state. The page terminates the worker if it runs
// too long (an endless loop in the strategy).
/* global importScripts, FinSentEngine */
'use strict';
// Served as /assets/strategy/sandbox.js: engine.js + this file in one script (public/index.php), under a
// CSP with no 'self', so the strategy code cannot load any script or module. Loaded directly
// (e.g. in tests) it falls back to importing the engine.
if (typeof FinSentEngine === 'undefined') importScripts('engine.js');

// Network access is not part of the strategy API. The CSP header served with this file (see
// public/.htaccess) is the real barrier; removing the globals is defence in depth.
for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker', 'importScripts',
  'caches', 'indexedDB', 'BroadcastChannel', 'WebTransport', 'navigator']) {
  try { Object.defineProperty(self, name, { value: undefined, configurable: false, writable: false }); } catch { /* not present */ }
}
// keep our own messaging out of reach of the strategy code
const post = self.postMessage.bind(self);
try { Object.defineProperty(self, 'postMessage', { value: undefined, configurable: false, writable: false }); } catch { /* ignore */ }

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
      const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
      for (const [k, spec] of Object.entries(s.params || {}).slice(0, 40)) {
        if (!/^[A-Za-z_$][\w$]{0,40}$/.test(k)) continue;
        const o = spec && typeof spec === 'object' ? spec : { default: spec };
        const def = typeof o.default === 'boolean' ? o.default : num(o.default);
        if (def === undefined) continue;   // only numeric and boolean params become controls
        params[k] = { label: str(o.label, 80) || k, default: def, min: num(o.min), max: num(o.max), step: num(o.step) };
      }
      post({ id, ok: true, result: { name: str(s.name, 120), description: str(s.description, 600), params } });
    } else if (type === 'backtest') {
      const r = E.backtest(payload);
      post({ id, ok: true, result: slim(r) });
    } else if (type === 'sweep') {
      let last = 0;
      const r = E.sweep({ ...payload, onProgress: (f) => { if (f - last > 0.02 || f === 1) { last = f; post({ id, progress: f }); } } });
      post({ id, ok: true, result: r });
    } else if (type === 'rolling') {
      const { dates, equity, reference } = payload;
      post({ id, ok: true, result: { y1: E.rollingWindows(dates, equity, reference, 365), y3: E.rollingWindows(dates, equity, reference, 3 * 365) } });
    } else if (type === 'montecarlo') {
      post({ id, ok: true, result: E.monteCarlo(payload.equity, payload.options || {}) });
    } else if (type === 'walkforward') {
      const r = E.walkForward({ ...payload, onProgress: (f) => post({ id, progress: f }) });
      post({ id, ok: true, result: r });
    } else {
      throw new Error('unknown message type ' + type);
    }
  } catch (e) {
    post({ id, ok: false, error: errInfo(e) });
  }
};
