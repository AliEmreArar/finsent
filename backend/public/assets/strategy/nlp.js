// Offline fallback for "describe your strategy": when no LLM key is configured (or Grok fails),
// a rule-based Turkish parser picks the closest template and fills its parameters from the
// numbers in the text ("RSI 25'in altına inince al, 65 üstünde sat, %7 zarar kes").
(function (root, factory) {
  const api = factory(root.FinSentTemplates || (typeof require === 'function' ? require('./templates.js') : []));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FinSentNlp = api;
})(typeof self !== 'undefined' ? self : this, function (TEMPLATES) {
  'use strict';

  // İ -> i explicitly; plain I stays i so acronyms like RSI keep working
  const lower = (s) => s.replace(/İ/g, 'i').toLowerCase();
  const toNum = (s) => Number(String(s).replace(',', '.'));

  // first number found by any of the regexes (group 1)
  function grab(text, regexes) {
    for (const re of regexes) {
      const m = re.exec(text);
      if (m) return toNum(m[1]);
    }
    return null;
  }

  function setDefault(code, key, value) {
    const re = new RegExp('(\\b' + key + ':\\s*\\{[^}]*?default:\\s*)([^,}]+)');
    return re.test(code) ? code.replace(re, (_, a) => a + value) : code;
  }

  function setRange(code, key, value) {
    // widen min/max so the extracted value stays inside the slider range
    const block = new RegExp('\\b' + key + ':\\s*\\{[^}]*\\}');
    return code.replace(block, (b) => b
      .replace(/min:\s*([\d.]+)/, (m, v) => (value < Number(v) ? `min: ${value}` : m))
      .replace(/max:\s*([\d.]+)/, (m, v) => (value > Number(v) ? `max: ${value}` : m)));
  }

  const RULES = [
    { id: 'momentum_rotation', re: /(rotasyon|en güçlü|en çok (yükselen|kazandıran)|momentum.*(ilk|en iyi)|(ilk|en iyi) \d+ hisse)/ },
    { id: 'kap_sentiment', re: /\b(kap|haber|bildirim|duygu|sentiment|olumlu)/ },
    { id: 'dca', re: /(her ay|aylık al|düzenli (al|birikim)|birikim|dca)/ },
    { id: 'buy_hold', re: /(al[- ]ve[- ]tut|al[- ]tut|buy and hold)/ },
    { id: 'macd_trend', re: /\bmacd\b/ },
    { id: 'bollinger', re: /bollinger|alt bant|üst bant/ },
    { id: 'rsi_reversion', re: /\brsi\b/ },
    { id: 'donchian', re: /(kırılım|kırınca|kırarsa|zirve|kanal|donchian|turtle|en yüksek)/ },
    { id: 'sma_cross', re: /(ortalama|sma|ema|hareketli|kesişim|golden cross|altın kesişim)/ },
  ];

  function parse(text, opts = {}) {
    const t = lower(text || '');
    const assumptions = [], warnings = [];
    let rule = RULES.find((r) => r.re.test(t));
    if (!rule) {
      rule = { id: 'sma_cross' };
      assumptions.push('Açıklamada tanınan bir kural bulunamadı; varsayılan olarak hareketli ortalama kesişimi kullanıldı.');
    }
    const tpl = TEMPLATES.find((x) => x.id === rule.id);
    let code = tpl.code;
    const hasParam = (key) => new RegExp('\\b' + key + ':\\s*\\{[^}]*default:').test(code);
    const set = (key, v) => {
      if (v === null || !Number.isFinite(v) || !hasParam(key)) return false;
      code = setRange(code, key, v); code = setDefault(code, key, v); return true;
    };

    if (rule.id === 'rsi_reversion') {
      set('rsiLen', grab(t, [/(\d+)\s*(?:günlük|periyotlu|periyot)\s*rsi/, /rsi\s*\(?\s*(\d+)\s*\)/]));
      set('buyBelow', grab(t, [/rsi[^.,;]*?(\d+(?:[.,]\d+)?)\s*['’]?\s*(?:\w+\s)?(?:altı|altına|altında|aşağı|den düşük|dan düşük|in altına|un altına|ün altına|ın altına)/, /(\d+)\s*['’]?\s*\w*\s*alt[ıi]na?\s*(?:in|düş)/, /(\d+)\s*(?:altı|altına|altında)/]));
      set('sellAbove', grab(t, [/(\d+(?:[.,]\d+)?)\s*['’]?\s*\w*\s*(?:üstü|üstüne|üstünde|üzeri|üzerine|üzerinde|yukarı|geçince|aşınca)/]));
    } else if (rule.id === 'sma_cross') {
      const nums = [...t.matchAll(/(\d+)\s*(?:günlük|gün|'lük|’lük|lik|lük|luk)/g)].map((m) => toNum(m[1])).filter((n) => n >= 2 && n <= 400);
      if (nums.length >= 2) { const [a, b] = nums.slice(0, 2).sort((x, y) => x - y); set('fast', a); set('slow', b); }
      else if (nums.length === 1) { set('slow', nums[0]); set('fast', Math.max(2, Math.round(nums[0] / 4))); assumptions.push(`Tek ortalama verildi (${nums[0]} gün); hızlı ortalama ${Math.max(2, Math.round(nums[0] / 4))} gün varsayıldı.`); }
      if (/\bema\b|üssel/.test(t)) {
        code = code.replace(/ta\.sma\(/g, 'ta.ema(');
        assumptions.push('Basit yerine üssel hareketli ortalama (EMA) kullanıldı.');
      }
    } else if (rule.id === 'donchian') {
      set('entry', grab(t, [/(\d+)\s*(?:günlük|gün)\w*\s*(?:zirve|en yüksek|tepe|direnç)/, /(?:zirve|en yüksek)\w*\s*(\d+)/]));
      set('exit', grab(t, [/(\d+)\s*(?:günlük|gün)\w*\s*(?:dip|en düşük|taban|destek)/, /(?:dip|en düşük)\w*\s*(\d+)/]));
    } else if (rule.id === 'macd_trend') {
      const m = /macd\s*\(?\s*(\d+)\s*[,/ ]\s*(\d+)\s*[,/ ]\s*(\d+)/.exec(t);
      if (m) { set('fast', toNum(m[1])); set('slow', toNum(m[2])); set('signal', toNum(m[3])); }
      if (/filtre(siz)? ?yok|trend filtresi olmadan|filtresiz/.test(t)) set('trend', 0);
    } else if (rule.id === 'bollinger') {
      set('len', grab(t, [/(\d+)\s*(?:günlük|gün|periyot)\w*\s*bollinger/, /bollinger\s*\(?\s*(\d+)/]));
      set('mult', grab(t, [/(\d+(?:[.,]\d+)?)\s*(?:standart sapma|sigma|σ)/]));
    } else if (rule.id === 'momentum_rotation') {
      set('top', grab(t, [/(?:ilk|en iyi|en güçlü)\s*(\d+)/, /(\d+)\s*hisse(?:yi)?\s*(?:tut|seç|al)/]));
      const months = grab(t, [/(?:son\s*)?(\d+)\s*ay(?:lık)?\s*(?:getiri|momentum|performans)/]);
      const days = grab(t, [/(?:son\s*)?(\d+)\s*gün(?:lük)?\s*(?:getiri|momentum|performans)/]);
      if (months) set('lookback', Math.round(months * 21)); else if (days) set('lookback', days);
    } else if (rule.id === 'kap_sentiment') {
      set('hold', grab(t, [/(\d+)\s*(?:gün|işlem günü)\s*(?:tut|bekle|elde)/, /(?:tut|bekle)\w*\s*(\d+)\s*gün/]));
      set('minScore', grab(t, [/(?:skor|puan)\w*\s*(\d+(?:[.,]\d+)?)/]));
      set('maxPositions', grab(t, [/en fazla\s*(\d+)\s*(?:pozisyon|hisse)/]));
    } else if (rule.id === 'dca') {
      set('months', grab(t, [/(\d+)\s*ay(?:da|a||\s)/]));
    }

    // risk rules, for any template
    const trRe = [/(?:iz süren|takip eden|trailing)\s*(?:stop)?\w*\s*%?\s*(\d+(?:[.,]\d+)?)/, /%\s*(\d+(?:[.,]\d+)?)\s*(?:iz süren|takip eden|trailing)\s*(?:stop)?/];
    const tr = grab(t, trRe);
    const tNoTrail = trRe.reduce((acc, re) => acc.replace(new RegExp(re.source, 'g'), ' '), t);
    const sl = grab(tNoTrail, [/%\s*(\d+(?:[.,]\d+)?)\s*(?:zarar|stop|kayıp)/, /(?:zarar ?kes|stop ?loss|zarar durdur|stop)\w*\s*%?\s*(\d+(?:[.,]\d+)?)/, /(\d+(?:[.,]\d+)?)\s*%\s*(?:zarar|stop|kayıp)/]);
    const tp = grab(t, [/%\s*(\d+(?:[.,]\d+)?)\s*(?:kâr|kar|kazanç)\s*(?:al|realize|hedef)/, /(?:kâr ?al|kar ?al|take ?profit|hedef)\w*\s*%?\s*(\d+(?:[.,]\d+)?)/]);
    if (sl !== null && !set('stopLoss', sl)) code = injectRisk(code, 'riskStop', 'Zarar kes (%)', sl, 'stopLoss');
    if (tp !== null && !set('takeProfit', tp)) code = injectRisk(code, 'riskTarget', 'Kâr al (%)', tp, 'takeProfit');
    if (tr !== null && !set('trailingStop', tr)) code = injectRisk(code, 'riskTrail', 'İz süren stop (%)', tr, 'trailingStop');

    if (/açığa|short|kaldıraç|vadeli|opsiyon|viop/.test(t)) warnings.push('Açığa satış, kaldıraç ve türev ürünler desteklenmiyor; strateji yalnızca alım yönlü (long) test edilir.');
    if (/dakika|saatlik|gün içi|intraday/.test(t)) warnings.push('Gün içi (dakikalık/saatlik) test henüz yok; günlük kapanış verisiyle test edilir.');

    const symbols = extractSymbols(text, opts.knownSymbols);
    return {
      provider: 'rules', templateId: tpl.id, name: tpl.name,
      summary: tpl.summary + ' (Kural tabanlı çevirici: Grok bağlı değilken en yakın hazır şablon seçildi ve sayılar metinden alındı.)',
      code, symbols, assumptions, warnings,
    };
  }

  function injectRisk(code, key, label, value, field) {
    const v = value > 1 ? value : value * 100;
    code = code.replace(/params:\s*\{/, `params: {\n    ${key}: { label: '${label}', default: ${v}, min: 0, max: ${Math.max(50, v)}, step: 1 },`);
    // add the option to every buy order
    const opt = `${field}: p.${key} > 0 ? p.${key} / 100 : null,`;
    return code
      .replace(/ctx\.buy\(([^,]+),\s*\{/g, `ctx.buy($1, { ${opt}`)
      .replace(/ctx\.targetPercent\(([^,]+),([^,]+),\s*\{/g, `ctx.targetPercent($1,$2, { ${opt}`);
  }

  function extractSymbols(text, known) {
    const set = known ? new Set(known) : null;
    const out = [];
    for (const m of String(text || '').matchAll(/\b([A-ZÇĞİÖŞÜ]{3,6}[0-9]?)\b/g)) {
      const s = m[1].replace(/[ÇĞİÖŞÜ]/g, (c) => ({ Ç: 'C', Ğ: 'G', İ: 'I', Ö: 'O', Ş: 'S', Ü: 'U' }[c]));
      if (['RSI', 'SMA', 'EMA', 'MACD', 'KAP', 'BIST', 'ATR', 'ADX', 'OBV', 'USD', 'TL', 'TRY'].includes(s)) continue;
      if (set ? set.has(s) : true) if (!out.includes(s)) out.push(s);
    }
    return out;
  }

  return { parse, extractSymbols, setDefault };
});
