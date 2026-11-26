// Ready-made strategies. They double as examples of the strategy API for users and for Grok.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FinSentTemplates = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const T = [];
  const add = (id, name, category, summary, symbols, code) => T.push({ id, name, category, summary, symbols, code: code.trim() + '\n' });

  add('sma_cross', 'Hareketli ortalama kesişimi', 'Trend', 'Kısa ortalama uzun ortalamanın üstündeyken pozisyonda kal, altına inince çık.', ['THYAO'], `
const strategy = {
  name: 'Hareketli ortalama kesişimi',
  description: 'Hızlı SMA yavaş SMA\\'nın üzerindeyken hissede kal, altına inince nakde geç.',
  params: {
    fast: { label: 'Hızlı ortalama (gün)', default: 50, min: 5, max: 150, step: 5 },
    slow: { label: 'Yavaş ortalama (gün)', default: 200, min: 20, max: 300, step: 10 },
  },
  indicators(s, p, ta) {
    return { fast: ta.sma(s.close, p.fast), slow: ta.sma(s.close, p.slow) };
  },
  onBar(ctx, p) {
    const weight = 100 / ctx.symbols.length;
    for (const sym of ctx.symbols) {
      const f = ctx.ind(sym, 'fast'), sl = ctx.ind(sym, 'slow');
      if (!ta.isNum(f) || !ta.isNum(sl)) continue;
      const pos = ctx.position(sym);
      if (!pos && f > sl) ctx.buy(sym, { percent: weight, reason: 'hızlı ort. yavaşın üstünde' });
      else if (pos && f < sl) ctx.sell(sym, { reason: 'hızlı ort. yavaşın altına indi' });
    }
  },
};`);

  add('rsi_reversion', 'RSI ile dipten alım', 'Ortalamaya dönüş', 'RSI aşırı satım bölgesine inince al, toparlanınca veya stop olunca sat.', ['ASELS'], `
const strategy = {
  name: 'RSI ile dipten alım',
  description: 'RSI eşik altına inince al; RSI çıkış seviyesini geçince, zarar kes veya süre dolunca sat.',
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
      if (!ta.isNum(rsi)) continue;
      const pos = ctx.position(sym);
      if (!pos && rsi < p.buyBelow) {
        ctx.buy(sym, { percent: weight, stopLoss: p.stopLoss > 0 ? p.stopLoss / 100 : null, reason: 'RSI ' + rsi.toFixed(0) });
      } else if (pos && (rsi > p.sellAbove || pos.barsHeld >= p.maxDays)) {
        ctx.sell(sym, { reason: rsi > p.sellAbove ? 'RSI toparlandı' : 'süre doldu' });
      }
    }
  },
};`);

  add('donchian', 'Kanal kırılımı (Turtle)', 'Trend', 'N günlük zirve kırılınca al, M günlük dibin altına inince veya ATR stopla sat.', ['EREGL'], `
const strategy = {
  name: 'Kanal kırılımı',
  description: 'Kapanış önceki N günün en yükseğini aşınca al; M günlük en düşüğün altına inince ya da ATR tabanlı iz süren stopla çık.',
  params: {
    entry: { label: 'Giriş kanalı (gün)', default: 55, min: 10, max: 120, step: 5 },
    exit: { label: 'Çıkış kanalı (gün)', default: 20, min: 5, max: 60, step: 5 },
    atrMult: { label: 'ATR stop çarpanı', default: 3, min: 1, max: 6, step: 0.5 },
  },
  indicators(s, p, ta) {
    return {
      upper: ta.ref(ta.highest(s.high, p.entry), 1),
      lower: ta.ref(ta.lowest(s.low, p.exit), 1),
      atr: ta.atr(s.high, s.low, s.close, 20),
    };
  },
  onBar(ctx, p) {
    const weight = 100 / ctx.symbols.length;
    for (const sym of ctx.symbols) {
      const c = ctx.close(sym), up = ctx.ind(sym, 'upper'), lo = ctx.ind(sym, 'lower'), atr = ctx.ind(sym, 'atr');
      if (!ta.isNum(up) || !ta.isNum(lo) || !ta.isNum(atr)) continue;
      const pos = ctx.position(sym);
      if (!pos && c > up) {
        ctx.buy(sym, { percent: weight, trailingStop: Math.min(0.5, (p.atrMult * atr) / c), reason: p.entry + ' günlük zirve kırıldı' });
      } else if (pos && c < lo) {
        ctx.sell(sym, { reason: p.exit + ' günlük dip kırıldı' });
      }
    }
  },
};`);

  add('macd_trend', 'MACD momentum + trend filtresi', 'Momentum', 'MACD sinyal çizgisini yukarı kesince al (fiyat 200 günlüğün üstündeyse), aşağı kesince sat.', ['BIMAS'], `
const strategy = {
  name: 'MACD momentum',
  description: 'Fiyat uzun ortalamanın üstündeyken MACD al kesişiminde gir, sat kesişiminde çık.',
  params: {
    fast: { label: 'MACD hızlı', default: 12, min: 3, max: 30, step: 1 },
    slow: { label: 'MACD yavaş', default: 26, min: 10, max: 60, step: 1 },
    signal: { label: 'Sinyal', default: 9, min: 3, max: 20, step: 1 },
    trend: { label: 'Trend filtresi (gün, 0=kapalı)', default: 200, min: 0, max: 300, step: 10 },
  },
  indicators(s, p, ta) {
    const m = ta.macd(s.close, p.fast, p.slow, p.signal);
    return {
      up: ta.crossover(m.macd, m.signal),
      down: ta.crossunder(m.macd, m.signal),
      trend: p.trend > 0 ? ta.sma(s.close, p.trend) : s.close.map(() => 0),
    };
  },
  onBar(ctx, p) {
    const weight = 100 / ctx.symbols.length;
    for (const sym of ctx.symbols) {
      const pos = ctx.position(sym);
      const trendOk = ctx.close(sym) > ctx.ind(sym, 'trend');
      if (!pos && ctx.ind(sym, 'up') && trendOk) ctx.buy(sym, { percent: weight, reason: 'MACD al kesişimi' });
      else if (pos && ctx.ind(sym, 'down')) ctx.sell(sym, { reason: 'MACD sat kesişimi' });
    }
  },
};`);

  add('bollinger', 'Bollinger alt bant dönüşü', 'Ortalamaya dönüş', 'Fiyat alt bandın altına inince al, orta banda dönünce sat.', ['TUPRS'], `
const strategy = {
  name: 'Bollinger dönüşü',
  description: 'Kapanış alt Bollinger bandının altına inince al, orta banda ulaşınca veya kâr al / zarar kes ile çık.',
  params: {
    len: { label: 'Periyot', default: 20, min: 10, max: 50, step: 1 },
    mult: { label: 'Bant genişliği (σ)', default: 2, min: 1, max: 3.5, step: 0.25 },
    stopLoss: { label: 'Zarar kes (%)', default: 10, min: 0, max: 30, step: 1 },
  },
  indicators(s, p, ta) {
    const b = ta.bollinger(s.close, p.len, p.mult);
    return { lower: b.lower, mid: b.mid };
  },
  onBar(ctx, p) {
    const weight = 100 / ctx.symbols.length;
    for (const sym of ctx.symbols) {
      const c = ctx.close(sym), lo = ctx.ind(sym, 'lower'), mid = ctx.ind(sym, 'mid');
      if (!ta.isNum(lo)) continue;
      const pos = ctx.position(sym);
      if (!pos && c < lo) ctx.buy(sym, { percent: weight, stopLoss: p.stopLoss / 100 || null, reason: 'alt bant altı' });
      else if (pos && c >= mid) ctx.sell(sym, { reason: 'orta banda döndü' });
    }
  },
};`);

  add('momentum_rotation', 'Momentum rotasyonu (çoklu hisse)', 'Portföy', 'Her ay son N ayın en güçlü K hissesini eşit ağırlıkla tut.', ['THYAO', 'ASELS', 'BIMAS', 'EREGL', 'TUPRS', 'KCHOL', 'SAHOL', 'AKBNK', 'GARAN', 'SISE'], `
const strategy = {
  name: 'Momentum rotasyonu',
  description: 'Her ayın ilk işlem gününde son "lookback" günün getirisine göre en güçlü "top" hisseyi seç, eşit ağırlıkla tut. İsteğe bağlı mutlak momentum filtresi: getirisi negatif olan hisse yerine nakit.',
  params: {
    lookback: { label: 'Momentum süresi (gün)', default: 126, min: 20, max: 252, step: 21 },
    top: { label: 'Tutulacak hisse sayısı', default: 3, min: 1, max: 10, step: 1 },
    absolute: { label: 'Negatif momentumda nakit', default: true },
  },
  indicators(s, p, ta) {
    return { mom: ta.roc(s.close, p.lookback) };
  },
  onBar(ctx, p) {
    const prev = ctx.bar(ctx.symbols[0], 1);
    const newMonth = !prev || prev.date.slice(0, 7) !== ctx.date.slice(0, 7);
    if (!newMonth) return;
    const ranked = ctx.symbols
      .filter((s) => ctx.has(s) && ta.isNum(ctx.ind(s, 'mom')))
      .sort((a, b) => ctx.ind(b, 'mom') - ctx.ind(a, 'mom'));
    let picks = ranked.slice(0, p.top);
    if (p.absolute) picks = picks.filter((s) => ctx.ind(s, 'mom') > 0);
    for (const sym of ctx.symbols) {
      if (!picks.includes(sym) && ctx.position(sym)) ctx.sell(sym, { reason: 'momentum sıralamasından düştü' });
    }
    const w = 99 / p.top;
    for (const sym of picks) ctx.targetPercent(sym, w, { reason: 'momentum ilk ' + p.top });
  },
};`);

  add('kap_sentiment', 'KAP haber duygusu', 'Haber', 'Olumlu KAP bildirimi (yapay zekâ skoru) gelen hisseyi al, birkaç gün tut.', ['THYAO', 'ASELS', 'BIMAS', 'EREGL', 'TUPRS', 'SISE'], `
const strategy = {
  name: 'KAP haber duygusu',
  description: 'Bir hissenin o günkü KAP bildirimlerinin ortalama duygu skoru eşiği geçerse ertesi açılışta al, "hold" gün sonra sat. Not: sinyal bildirimin yayımlandığı günün kapanışında oluşur; işlem ertesi gün yapılır.',
  params: {
    minScore: { label: 'En düşük duygu skoru', default: 0.6, min: 0.1, max: 1, step: 0.05 },
    hold: { label: 'Tutma süresi (gün)', default: 5, min: 1, max: 30, step: 1 },
    maxPositions: { label: 'En fazla pozisyon', default: 3, min: 1, max: 10, step: 1 },
    stopLoss: { label: 'Zarar kes (%)', default: 7, min: 0, max: 25, step: 1 },
  },
  onBar(ctx, p) {
    for (const pos of ctx.positions()) {
      if (pos.barsHeld >= p.hold) ctx.sell(pos.sym, { reason: p.hold + ' gün doldu' });
    }
    let open = ctx.positions().length;
    for (const sym of ctx.symbols) {
      const s = ctx.sentiment(sym);
      if (s === null || s < p.minScore || ctx.position(sym) || open >= p.maxPositions) continue;
      ctx.buy(sym, { percent: 99 / p.maxPositions, stopLoss: p.stopLoss / 100 || null, reason: 'olumlu KAP (' + s.toFixed(2) + ')' });
      open++;
    }
  },
};`);

  add('buy_hold', 'Al ve tut', 'Temel', 'İlk gün eşit ağırlıkla al ve hiç satma. Diğer stratejiler için kıyas.', ['XU100'], `
const strategy = {
  name: 'Al ve tut',
  description: 'İlk işlem gününde tüm hisseleri eşit ağırlıkla al ve sonuna kadar tut.',
  params: {},
  onBar(ctx) {
    if (ctx.state.done) return;
    for (const sym of ctx.symbols) ctx.buy(sym, { percent: 99 / ctx.symbols.length, reason: 'al ve tut' });
    ctx.state.done = true;
  },
};`);

  add('dca', 'Düzenli birikim (aylık alım)', 'Temel', 'Sermayeyi N aya bölüp her ay aynı tutarda al; ortalama maliyet etkisini gör.', ['ALTIN'], `
const strategy = {
  name: 'Düzenli birikim',
  description: 'Başlangıç sermayesini "months" eşit parçaya böl, her ayın ilk işlem gününde bir parça ile alım yap.',
  params: {
    months: { label: 'Kaç ayda tamamlansın', default: 24, min: 2, max: 120, step: 1 },
  },
  onBar(ctx, p) {
    const prev = ctx.bar(ctx.symbols[0], 1);
    const newMonth = !prev || prev.date.slice(0, 7) !== ctx.date.slice(0, 7);
    ctx.state.n = ctx.state.n || 0;
    if (!newMonth || ctx.state.n >= p.months) return;
    if (!ctx.state.slice) ctx.state.slice = ctx.cash / p.months;
    for (const sym of ctx.symbols) ctx.buy(sym, { amount: ctx.state.slice / ctx.symbols.length, reason: 'aylık alım ' + (ctx.state.n + 1) });
    ctx.state.n++;
  },
};`);

  return T;
});
