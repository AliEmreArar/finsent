// Turns a backtest's "today's signals" into paper-portfolio orders with the same meaning as in the
// backtest: target weights become a buy or a sell of the difference, partial sells keep their
// share, fixed amounts / share counts pass through. Used by the lab page, the portfolio page and
// the server-side strategy runner, so all three apply a strategy identically.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FinSentApply = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * @param signals  [{sym, side: 'buy'|'sell'|'target', percent, targetPercent, shares, amount, reason}]
   * @param account  {value, positions: [{symbol, shares, value, price}]}
   * @param symbolCount number of symbols the strategy trades (default sizing for a bare buy)
   * @returns orders [{symbol, side: 'buy'|'sell', shares?, amount?, reason}], sells first
   */
  function signalsToOrders(signals, account, symbolCount) {
    const value = Number(account && account.value) || 0;
    const positions = (account && account.positions) || [];
    const held = (sym) => positions.find((p) => p.symbol === sym);
    const toOrder = (s) => {
      const h = held(s.sym);
      if (s.side === 'sell') {
        if (!h) return null;
        if (s.shares) return { side: 'sell', shares: Math.floor(s.shares) };
        if (s.percent) return { side: 'sell', shares: Math.floor((h.shares * s.percent) / 100) };
        return { side: 'sell' };
      }
      if (s.side === 'target') {
        const diff = (value * s.targetPercent) / 100 - (h ? h.value : 0);
        if (Math.abs(diff) < value * 0.002) return null;   // already at target (within 0.2 %)
        if (diff > 0) return { side: 'buy', amount: Math.floor(diff) };
        return h && h.price > 0 ? { side: 'sell', shares: Math.floor(-diff / h.price) } : null;
      }
      if (s.shares) return { side: 'buy', shares: Math.floor(s.shares) };
      if (s.amount) return { side: 'buy', amount: Math.floor(s.amount) };
      return { side: 'buy', amount: Math.floor((value * (s.percent != null ? s.percent : 100 / Math.max(1, symbolCount || 1))) / 100) };
    };
    const out = [];
    for (const s of signals || []) {
      const o = toOrder(s);
      if (!o || o.shares === 0 || o.amount === 0) continue;
      out.push({ symbol: s.sym, ...o, reason: s.reason || '' });
    }
    out.sort((a, b) => (a.side === 'sell' ? 0 : 1) - (b.side === 'sell' ? 0 : 1));   // sells fund buys
    return out;
  }

  return { signalsToOrders };
});
