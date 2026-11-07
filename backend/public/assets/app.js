// FinSent dashboard - hash-routed single page app over the PHP API.
'use strict';

// ------------------------------------------------------------------ helpers
// A missing element yields a detached stand-in, so late responses from a page the user
// already left write into nothing instead of throwing.
const $ = (s, el = document) => el.querySelector(s) || document.createElement('div');
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = (d) => new Intl.NumberFormat('tr-TR', { minimumFractionDigits: d, maximumFractionDigits: d });
const num = (v, d = 2) => (v === null || v === undefined || isNaN(v) ? '–' : nf(d).format(Number(v)));
const pct = (v, d = 2, sign = true) => (v === null || v === undefined || isNaN(v) ? '–' : `${sign && v > 0 ? '+' : ''}${nf(d).format(v * 100)}%`);
const dirCls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
const arrow = (v) => (v > 0 ? '▲' : v < 0 ? '▼' : '•');
const chg = (v, d = 2) => `<span class="chg ${dirCls(v)} num">${arrow(v)} ${pct(v, d)}</span>`;
const money = (v) => {
  if (v === null || v === undefined) return '–';
  const a = Math.abs(v);
  if (a >= 1e9) return `${num(v / 1e9, 1)} mr ₺`;
  if (a >= 1e6) return `${num(v / 1e6, 1)} mn ₺`;
  return `${num(v, 0)} ₺`;
};
const MONTHS = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
const fdate = (s, time = false) => {
  if (!s) return '–';
  const d = new Date(String(s).replace(' ', 'T'));
  if (isNaN(d)) return esc(s);
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  return time ? `${base}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : base;
};

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
  return data;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2800);
}
function countUp(el, to, d = 2, dur = 700) {
  const start = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - start) / dur), e = 1 - Math.pow(1 - k, 3);
    el.textContent = num(to * e, d);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
const skel = (h = 120) => `<div class="skeleton" style="height:${h}px"></div>`;

// ------------------------------------------------------------------ vocabulary (no raw codes on screen)
const LABEL = { positive: ['Olumlu', 'pos'], negative: ['Olumsuz', 'neg'], neutral: ['Nötr', ''], mixed: ['Karışık', 'acc'] };
const labelPill = (l) => (LABEL[l] ? `<span class="pill ${LABEL[l][1]}">${LABEL[l][0]}</span>` : '');
const sentColor = (l) => (l === 'positive' ? css('--up') : l === 'negative' ? css('--down') : css('--neutral'));
const EVENT = {
  financial_report: 'Finansal rapor', dividend: 'Temettü', capital_increase: 'Sermaye artırımı', buyback: 'Pay geri alımı',
  new_business: 'Yeni iş / sözleşme', legal: 'Hukuki süreç', rating: 'Kredi notu', m_and_a: 'Birleşme / satın alma',
  debt: 'Borçlanma', governance: 'Yönetim / genel kurul', operations: 'Operasyon', investment: 'Yatırım',
  regulatory: 'Düzenleyici', other: 'Diğer',
};
const PATTERN = {
  doji: ['Doji', 'Açılış ve kapanış neredeyse aynı: alıcı ile satıcı arasında kararsızlık.'],
  hammer: ['Çekiç', 'Düşüş sonrası gün içi satış baskısı geri alındı; dönüş işareti olabilir.'],
  shooting_star: ['Kayan yıldız', 'Yükseliş sonrası yukarıda satış geldi; zayıflama işareti olabilir.'],
  bullish_engulfing: ['Yutan boğa', 'Yükselen mum bir önceki düşen mumu tamamen kapladı.'],
  bearish_engulfing: ['Yutan ayı', 'Düşen mum bir önceki yükselen mumu tamamen kapladı.'],
  golden_cross: ['Altın kesişim', '50 günlük ortalama 200 günlüğü yukarı kesti: uzun vadeli trend güçleniyor.'],
  death_cross: ['Ölüm kesişimi', '50 günlük ortalama 200 günlüğü aşağı kesti: uzun vadeli trend zayıflıyor.'],
  macd_bullish_cross: ['MACD al kesişimi', 'Momentum yukarı döndü.'],
  macd_bearish_cross: ['MACD sat kesişimi', 'Momentum aşağı döndü.'],
  rsi_oversold: ['Aşırı satım (RSI)', 'RSI 30 altına indi: satışlar aşırıya kaçmış olabilir.'],
  rsi_overbought: ['Aşırı alım (RSI)', 'RSI 70 üstüne çıktı: yükseliş aşırıya kaçmış olabilir.'],
  bollinger_breakout_up: ['Üst bant kırılımı', 'Fiyat Bollinger üst bandının üzerine çıktı: güçlü hareket.'],
  bollinger_breakout_down: ['Alt bant kırılımı', 'Fiyat Bollinger alt bandının altına indi: sert satış.'],
  volume_spike: ['Hacim patlaması', 'İşlem hacmi olağanın çok üzerinde.'],
};
const DIR = { bullish: ['Yükseliş', 'pos', '▲'], bearish: ['Düşüş', 'neg', '▼'], neutral: ['Kararsız', 'neu', '•'] };
function patternDetail(p) {
  const d = p.detail || {};
  if (d.volume_ratio) return `Hacim 20 günlük ortalamanın ${num(d.volume_ratio, 1)} katı`;
  if (d.rsi_14) return `RSI ${num(d.rsi_14, 0)}`;
  if (d.sma_50 && d.sma_200) return `50G ort. ${num(d.sma_50)} · 200G ort. ${num(d.sma_200)}`;
  if (d.bb_upper) return `Kapanış ${num(d.close)} · üst bant ${num(d.bb_upper)}`;
  if (d.bb_lower) return `Kapanış ${num(d.close)} · alt bant ${num(d.bb_lower)}`;
  return '';
}
const CHECK = {
  non_empty: ['Veri geldi', 'Kaynaktan kayıt alındı'], missing_market_days: ['Eksik işlem günü', 'Borsa açıkken verisi eksik gün'],
  missing_symbol_observations: ['Eksik hisse verisi', 'İşlem günlerinde eksik kalan hisse kayıtları'],
  null_close: ['Boş kapanış fiyatı', ''], non_positive_close: ['Geçersiz fiyat', 'Sıfır veya negatif kapanış'],
  ohlc_consistency: ['Fiyat tutarlılığı', 'Kapanış gün içi en düşük-en yüksek aralığında mı'],
  abnormal_daily_move_gt_25pct: ['Aşırı günlük hareket', '%25 üzeri değişim (bölünme/bedelsiz olabilir)'],
  duplicate_keys: ['Tekrarlanan kayıt', ''], missing_symbol: ['Sembolsüz bildirim', ''], missing_subject: ['Konusuz bildirim', ''],
  missing_published_at: ['Tarihsiz bildirim', ''], empty_text: ['Boş bildirim metni', ''],
  published_outside_window: ['Tarih aralığı dışında', ''], unknown_symbols: ['Tanınmayan sembol', 'Fiyat verisi olmayan kodlar (fon, tahvil ihraççısı vb.)'],
};
const TASK = { load_serving_db: 'Veritabanı güncellemesi' };
const STAT = { market_daily: 'fiyat', disclosures: 'bildirim', disclosure_sentiment: 'duygu skoru', event_returns: 'tepki ölçümü', patterns: 'sinyal' };

// ------------------------------------------------------------------ charts (Chart.js defaults)
Chart.defaults.color = '#6e6d68';
Chart.defaults.borderColor = 'rgba(255,255,255,.05)';
Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
Chart.defaults.font.size = 11;
Chart.defaults.animation.duration = 900;
Chart.defaults.animation.easing = 'easeOutQuart';
const tooltip = { backgroundColor: '#18181b', borderColor: '#2e2e32', borderWidth: 1, titleColor: '#f4f4f2', bodyColor: '#a3a29d', padding: 10, displayColors: false, cornerRadius: 8 };
const charts = {};
const INSTRUMENTS = new Set(['ALTIN', 'XAUUSD', 'GUMUS', 'XAGUSD', 'USDTRY', 'EURTRY', 'XU100']);
const USD_QUOTED = new Set(['XAUUSD', 'XAGUSD']);
const GOLDISH = new Set(['ALTIN', 'XAUUSD', 'GUMUS', 'XAGUSD']);
function spark(values, w = 120, h = 34) {
  if (!values?.length) return '';
  const mn = Math.min(...values), mx = Math.max(...values), r = mx - mn || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - ((v - mn) / r) * (h - 4) - 2}`).join(' ');
  const up = values.at(-1) >= values[0];
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block"><polyline points="${pts}" fill="none" stroke="${up ? css('--up') : css('--down')}" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
}
function chart(id, cfg) { charts[id]?.destroy(); const el = document.getElementById(id); if (el) charts[id] = new Chart(el, cfg); }
function areaGradient(ctx, color) {
  const g = ctx.createLinearGradient(0, 0, 0, ctx.canvas.clientHeight || 200);
  g.addColorStop(0, color + '40'); g.addColorStop(1, color + '00'); return g;
}
function lineChart(id, labels, values, color, opts = {}) {
  const el = document.getElementById(id); if (!el) return;
  chart(id, {
    type: 'line',
    data: { labels, datasets: [{ data: values, borderColor: color, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4,
      pointHoverBackgroundColor: color, fill: true, backgroundColor: (c) => areaGradient(c.chart.ctx, color), tension: 0.25 }] },
    options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { ...tooltip, callbacks: { label: (c) => num(c.parsed.y, opts.d ?? 2) } } },
      scales: { x: { display: opts.axes !== false, grid: { display: false }, ticks: { maxTicksLimit: 6, maxRotation: 0 } },
        y: { display: opts.axes !== false, position: 'right', grid: { color: 'rgba(255,255,255,.04)' }, ticks: { maxTicksLimit: 5 } } } },
  });
}

// ------------------------------------------------------------------ shared UI pieces
const symLink = (s) => `<a href="#/hisse/${esc(s)}" class="sym">${esc(s)}</a>`;
function moverRows(rows) {
  if (!rows?.length) return '<div class="empty">Veri yok</div>';
  return `<div class="rows">${rows.map((r) => `<a class="row" href="#/hisse/${esc(r.symbol)}">
      <span class="sym">${esc(r.symbol)}</span><span class="name">${esc(cleanTitle(r.title))}</span>
      <span class="px num">${num(r.close)}</span>${chg(r.pct_change)}</a>`).join('')}</div>`;
}
const cleanTitle = (t) => (t || '').replace(/\s*\(örnek veri\)/, '');
function meter(score) {
  const s = Math.max(-1, Math.min(1, Number(score) || 0));
  return `<div class="meter"><i style="left:${(s + 1) * 50}%;background:${s > 0.15 ? css('--up') : s < -0.15 ? css('--down') : css('--neutral')}"></i></div>
    <div class="meter-labels"><span>Olumsuz</span><span>Nötr</span><span>Olumlu</span></div>`;
}
function reactionText(d) {
  const v = d.car_3d ?? d.car_1d;
  if (v === null || v === undefined) return '';
  const h = d.car_3d !== null && d.car_3d !== undefined ? '3 günde' : '1 günde';
  return `<div class="reaction">Sonraki ${h} endekse göre <b class="${dirCls(v)}">${arrow(v)} ${pct(v, 1)}</b></div>`;
}
const looksLikeCode = (t) => !t || (t.replace(/[^A-Za-zÇĞİÖŞÜçğıöşü]/g, '').length / t.length) < 0.55;
function newsItem(d, showSym = true) {
  const title = looksLikeCode(d.summary) ? d.subject : d.summary;
  const sub = title === d.summary ? d.subject : '';
  const kp = (d.key_points || []).slice(0, 3);
  return `<div class="news">
    <div class="meta"><span class="sdot" style="background:${sentColor(d.label)}"></span>
      ${showSym ? symLink(d.symbol) : ''}<span>${fdate(d.published_at, true)}</span>${labelPill(d.label)}
      ${d.event_type ? `<span class="pill">${esc(EVENT[d.event_type] || 'Diğer')}</span>` : ''}</div>
    <div class="title">${esc(title)}</div>${sub ? `<div class="muted small" style="margin:-2px 0 4px">${esc(sub)}</div>` : ''}
    ${d.body ? `<div class="body" onclick="this.classList.toggle('open')">${esc(d.body)}</div>` : ''}
    ${kp.length ? `<div class="why">${kp.map(esc).join(' · ')}</div>` : ''}
    ${reactionText(d)}
    ${d.url ? `<div class="note" style="margin-top:6px"><a href="${esc(d.url)}" target="_blank" rel="noopener" class="muted">KAP'ta aç ↗</a></div>` : ''}
  </div>`;
}

// ------------------------------------------------------------------ page: market
async function pageMarket(v) {
  v.innerHTML = `
    <div class="page-head"><div><h1>Piyasa</h1><div class="sub" id="mk-sub">Borsa İstanbul günlük görünüm</div></div></div>
    <div class="grid g-hero">
      <div class="card reveal"><div class="card-head"><h2>BIST 100</h2><div class="seg" id="idx-range">
        <button data-d="30">1A</button><button data-d="90" class="on">3A</button><button data-d="365">1Y</button></div></div>
        <div class="hero-value num" id="idx-val">–</div><div class="hero-meta" id="idx-meta"></div>
        <div style="height:190px;margin-top:14px"><canvas id="idx-chart"></canvas></div></div>
      <div class="card reveal" style="animation-delay:.05s"><div class="card-head"><h2>Günün özeti</h2><span class="hint" id="brief-src"></span></div>
        <div id="brief">${skel(160)}</div></div>
    </div>
    <div class="tiles reveal" id="instr" style="margin-top:16px;animation-delay:.08s">${'<div class="tile"><div class="skeleton" style="height:56px"></div></div>'.repeat(5)}</div>
    <div class="grid g-3" style="margin-top:16px">
      <div class="card reveal" style="animation-delay:.1s"><div class="card-head"><h2>En çok yükselenler</h2></div><div id="gainers">${skel(200)}</div></div>
      <div class="card reveal" style="animation-delay:.14s"><div class="card-head"><h2>En çok düşenler</h2></div><div id="losers">${skel(200)}</div></div>
      <div class="card reveal" style="animation-delay:.18s"><div class="card-head"><h2>En çok işlem görenler</h2></div><div id="active">${skel(200)}</div></div>
    </div>
    <div class="grid g-2" style="margin-top:16px">
      <div class="card reveal" style="animation-delay:.22s"><div class="card-head"><h2>X'te konuşulanlar</h2><span class="hint">Grok X araması</span></div><div id="social">${skel(220)}</div></div>
      <div class="card reveal" style="animation-delay:.26s"><div class="card-head"><h2>Haberler fiyatı nasıl etkiledi?</h2><span class="hint">KAP bildirimi sonrası, endekse göre</span></div><div id="impact">${skel(220)}</div></div>
    </div>
    <div class="card reveal" style="margin-top:16px;animation-delay:.3s"><div class="card-head"><h2>Öne çıkan KAP bildirimleri</h2><a href="#/bildirimler" class="hint">Tümü →</a></div><div id="news">${skel(260)}</div></div>`;

  api('/instruments').then((tiles) => {
    $('#instr').innerHTML = tiles.map((t) => `<a class="tile" href="#/hisse/${t.symbol}">
      <div class="t-top"><span class="muted small">${esc(t.name)}</span><span class="${dirCls(t.change_1d)} small num">${arrow(t.change_1d)} ${pct(t.change_1d, 2)}</span></div>
      <div class="t-val num">${t.usd_quoted ? '$' : ''}${num(t.close, t.close > 100 ? 2 : 3)}${t.usd_quoted ? '' : ' ₺'}</div>
      <div class="t-bot"><span class="muted small">1Y ${pct(t.change_1y, 1)}</span>${spark(t.spark)}</div></a>`).join('');
  }).catch(() => { $('#instr').innerHTML = ''; });
  const [m, brief, social, es, ov] = await Promise.all([
    api('/market-summary'), api('/brief').catch(() => null), api('/social').catch(() => []), api('/event-study'), api('/overview')]);

  $('#asof').textContent = m.as_of ? `Son işlem günü: ${fdate(m.as_of)}` : '';
  // index hero
  const idx = m.index || [];
  const drawIdx = (days) => {
    const cut = idx.slice(-Math.round(days * 0.69));
    lineChart('idx-chart', cut.map((r) => fdate(r.d)), cut.map((r) => Number(r.v)), css('--accent'));
  };
  if (idx.length > 1) {
    const last = Number(idx.at(-1).v), prev = Number(idx.at(-2).v), ch = last / prev - 1;
    countUp($('#idx-val'), last, 2);
    const b = m.breadth || {};
    const tot = Number(b.up || 0) + Number(b.down || 0) + Number(b.flat || 0) || 1;
    $('#idx-meta').innerHTML = `${chg(ch)}<span class="muted small">${fdate(m.as_of)} kapanış · işlem hacmi ${money(Number(b.volume))}</span>`;
    $('#idx-meta').insertAdjacentHTML('afterend', `<div class="breadth"><span style="flex-grow:${b.up};background:var(--up)"></span>
      <span style="flex-grow:${b.flat};background:var(--neutral)"></span><span style="flex-grow:${b.down};background:var(--down)"></span></div>
      <div class="legend-row"><span><span class="sw" style="background:var(--up)"></span>${b.up} yükselen</span>
      <span><span class="sw" style="background:var(--neutral)"></span>${b.flat} değişmeyen</span>
      <span><span class="sw" style="background:var(--down)"></span>${b.down} düşen</span><span class="muted">${num(b.up / tot * 100, 0)}% yükselişte</span></div>`);
    drawIdx(90);
    $$('#idx-range button').forEach((btn) => btn.onclick = () => {
      $$('#idx-range button').forEach((x) => x.classList.toggle('on', x === btn)); drawIdx(Number(btn.dataset.d));
    });
  }
  $('#gainers').innerHTML = moverRows(m.gainers);
  $('#losers').innerHTML = moverRows(m.losers);
  $('#active').innerHTML = moverRows(m.active);

  // brief
  if (brief) {
    const p = brief.payload || {};
    const mood = { risk_on: ['Risk iştahı yüksek', 'pos'], risk_off: ['Riskten kaçış', 'neg'], neutral: ['Nötr', ''], mixed: ['Karışık', 'acc'] }[p.mood] || ['', ''];
    $('#brief-src').textContent = `${fdate(brief.as_of)} · Grok`;
    $('#brief').innerHTML = `<div class="chips" style="margin-bottom:10px"><span class="pill ${mood[1]}">${mood[0]}</span></div>
      <p class="clamp" id="brief-text" style="margin:0 0 6px;color:var(--text-2)">${esc(p.summary || brief.summary)}</p>
      <button class="linkbtn" onclick="document.getElementById('brief-text').classList.toggle('open');this.textContent=this.textContent==='Devamını oku'?'Daralt':'Devamını oku'">Devamını oku</button>
      ${(p.drivers || []).length ? `<div class="note" style="margin:12px 0 4px">Etkenler</div><ul class="clean">${p.drivers.slice(0, 4).map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}
      ${(p.stocks_in_focus || []).length ? `<div class="note" style="margin:12px 0 6px">Öne çıkan hisseler</div><div class="chips">${p.stocks_in_focus.slice(0, 8).map((s) =>
        `<a class="pill" href="#/hisse/${esc(s.symbol)}" title="${esc(s.reason)}">${esc(s.symbol)}</a>`).join('')}</div>` : ''}`;
  } else {
    $('#brief').innerHTML = '<div class="empty">Günlük özet henüz oluşturulmadı. Akşam pipeline çalışınca dolacak.</div>';
  }

  // social
  $('#social').innerHTML = social.length ? `<div class="rows">${social.slice(0, 8).map((r) => `<a class="row" href="#/hisse/${esc(r.symbol)}">
      <span class="sym">${esc(r.symbol)}</span>
      <span style="flex:1;min-width:0"><span class="name" style="display:block">${esc((r.themes || []).slice(0, 2).join(' · ') || r.summary)}</span></span>
      <span style="width:120px">${miniMeter(r.score)}</span></a>`).join('')}</div>` : '<div class="empty">Henüz X araması yok</div>';

  // impact (event study in plain words)
  const by = Object.fromEntries((es.by_label || []).map((r) => [r.label, r]));
  const imp = (l, txt) => {
    const r = by[l]; if (!r) return '';
    return `<div class="row" style="cursor:default"><span class="sdot" style="background:${sentColor(l)}"></span>
      <span style="flex:1">${txt}<div class="muted small">${num(r.n, 0)} bildirim</div></span>
      <span class="num ${dirCls(r.car_3d)}" style="font-weight:600">${arrow(r.car_3d)} ${pct(r.car_3d, 1)}</span></div>`;
  };
  $('#impact').innerHTML = `<div class="rows">${imp('negative', 'Olumsuz haber sonrası')}${imp('neutral', 'Nötr bildirim sonrası')}${imp('positive', 'Olumlu haber sonrası')}</div>
    <p class="note" style="margin:12px 0 0">Bildirimden sonraki 3 işlem gününde hissenin BIST 100'e göre ortalama getirisi. Grok'un bildirime verdiği etikete göre gruplandı.</p>`;

  // news
  $('#news').innerHTML = (ov.recent_signals || []).length ? ov.recent_signals.slice(0, 8).map((d) => newsItem(d)).join('') : '<div class="empty">Bildirim yok</div>';
}
function miniMeter(s) {
  s = Math.max(-1, Math.min(1, Number(s) || 0));
  const c = s > 0.15 ? css('--up') : s < -0.15 ? css('--down') : css('--neutral');
  return `<div style="display:flex;align-items:center;gap:8px"><div class="meter" style="flex:1"><i style="left:${(s + 1) * 50}%;background:${c};width:9px;height:9px"></i></div>
    <span class="num small" style="color:${c};width:36px;text-align:right">${s > 0 ? '+' : ''}${num(s, 2)}</span></div>`;
}

// ------------------------------------------------------------------ page: stock
let lw = null;
async function pageStock(v, sym) {
  if (!sym) {
    const list = await api('/symbols');
    sym = (list[0] && list[0].symbol) || 'ASELS';
    location.replace(`#/hisse/${sym}`); return;
  }
  sym = sym.toUpperCase();
  v.innerHTML = `
    <div class="page-head">
      <div><div class="muted small" id="st-name">&nbsp;</div><h1>${esc(sym)}</h1></div>
      <div style="text-align:right"><div class="hero-value num" id="st-price">–</div><div class="hero-meta" style="justify-content:flex-end" id="st-chg"></div></div>
    </div>
    <div class="stats reveal" id="st-stats">${'<div class="stat"><div class="skeleton" style="height:38px"></div></div>'.repeat(6)}</div>
    <div class="card reveal" style="margin-top:16px;animation-delay:.05s">
      <div class="card-head" style="flex-wrap:wrap"><h2>Fiyat</h2>
        <div class="toolbar" style="margin:0">
          <div class="seg" id="st-int">${['15m:15dk', '1h:1S', '4h:4S', '1d:G', '1w:H', '1mo:A'].map((x) => { const [k, l] = x.split(':'); return `<button data-i="${k}" class="${k === '1d' ? 'on' : ''}" title="${{ '15m': '15 dakikalık mum (son ~3 ay)', '1h': 'Saatlik mum (son ~3 yıl)', '4h': '4 saatlik mum (son ~3 yıl)', '1d': 'Günlük mum', '1w': 'Haftalık mum', '1mo': 'Aylık mum' }[k]}">${l}</button>`; }).join('')}</div>
          <div class="seg" id="st-range">${['1m:1A', '3m:3A', '6m:6A', '1y:1Y', '5y:5Y', 'all:Tümü'].map((x) => { const [k, l] = x.split(':'); return `<button data-r="${k}" class="${k === '1y' ? 'on' : ''}">${l}</button>`; }).join('')}</div>
          <div class="seg" id="st-cur"><button data-c="TRY" class="on">₺</button><button data-c="USD">$</button></div>
        </div></div>
      <div class="draw-bar" id="draw-bar">
        <button data-tool="select" class="on" title="Seç (çizime tıkla, Delete ile sil)"><svg viewBox="0 0 24 24"><path d="M5 3l12 9-5.5 1L15 20l-3 1.5-3.5-7L5 18z"/></svg></button>
        <button data-tool="trend" title="Trend çizgisi"><svg viewBox="0 0 24 24"><path d="M4 19L20 5"/><circle cx="4" cy="19" r="1.6"/><circle cx="20" cy="5" r="1.6"/></svg></button>
        <button data-tool="hline" title="Yatay çizgi"><svg viewBox="0 0 24 24"><path d="M3 12h18"/></svg></button>
        <button data-tool="channel" title="Kanal (paralel)"><svg viewBox="0 0 24 24"><path d="M3 15L17 5M7 20L21 10"/></svg></button>
        <button data-tool="fib" title="Fibonacci düzeltmesi"><svg viewBox="0 0 24 24"><path d="M4 5h16M4 9h16M4 12h16M4 15h16M4 19h16" opacity=".8"/></svg></button>
        <button data-tool="rect" title="Dikdörtgen"><svg viewBox="0 0 24 24"><rect x="4" y="6" width="16" height="12" rx="1"/></svg></button>
        <button data-tool="clear" title="Tüm çizimleri sil"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg></button>
        <span class="draw-hint" id="draw-hint"></span>
      </div>
      <div class="chart-wrap"><div id="st-legend" class="chart-legend"></div><div id="st-chart" class="price-chart"></div></div>
      <div class="chips" id="draw-list" style="margin-top:8px"></div>
      <div class="chart-note"><span><span class="line-key" style="background:#d4d3ce"></span><span id="ma1-l">50 günlük ort.</span></span>
        <span><span class="line-key" style="background:#6e6d68"></span><span id="ma2-l">200 günlük ort.</span></span>
        <span>▲▼ KAP bildirimi (yeşil olumlu, kırmızı olumsuz)</span>
        <span style="margin-left:auto">Grafik: <a href="https://www.tradingview.com/" target="_blank" rel="noopener">TradingView Lightweight Charts</a></span></div>
    </div>
    <div class="card reveal" id="fc-card" style="margin-top:16px;animation-delay:.08s"><div class="card-head"><h2>Sırada ne olabilir?</h2><span class="hint">Tüm BIST verisiyle eğitilmiş model · kalibre olasılıklar</span></div><div id="fc">${skel(150)}</div></div>
    <div class="grid g-2" style="margin-top:16px">
      <div class="card reveal" style="animation-delay:.1s"><div class="card-head"><h2>Yapay zekâ yorumu</h2><button class="btn" id="ins-go">
        <svg viewBox="0 0 24 24"><path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z"/></svg>Yorum üret</button></div>
        <div id="ins"><div class="empty">Teknik sinyaller, KAP haberleri ve X duygusunu birlikte yorumlatmak için "Yorum üret"e bas.</div></div></div>
      <div class="card reveal" style="animation-delay:.12s"><div class="card-head"><h2>X'te ne konuşuluyor?</h2><button class="btn" id="soc-go">
        <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>Şimdi ara</button></div><div id="soc">${skel(140)}</div></div>
    </div>
    <div class="grid g-2" style="margin-top:16px">
      <div class="card reveal" style="animation-delay:.14s"><div class="card-head"><h2>Teknik sinyaller</h2><span class="hint">Son 60 gün</span></div><div id="sig">${skel(220)}</div></div>
      <div class="card reveal" style="animation-delay:.16s"><div class="card-head"><h2>KAP bildirimleri</h2><span class="hint" id="kap-n"></span></div><div id="kap">${skel(220)}</div></div>
    </div>`;

  $$('#draw-bar [data-tool]').forEach((b) => b.onclick = () => {
    const t = b.dataset.tool;
    if (t === 'clear') { if (confirm('Bu hissedeki tüm çizimler silinsin mi?')) window.__draw?.clear(); return; }
    window.__draw?.setTool(t === 'select' ? null : t);
  });
  const st = { range: '1y', interval: '1d', currency: USD_QUOTED.has(sym) ? 'USD' : 'TRY' };
  if (st.currency === 'USD') $$('#st-cur button').forEach((x) => x.classList.toggle('on', x.dataset.c === 'USD'));
  const load = async () => {
    const intraday = ['15m', '1h', '4h'].includes(st.interval);
    $('#st-range').style.display = intraday ? 'none' : '';
    $('#st-chart').style.opacity = '.35';
    try {
      const m = await api(`/market/${sym}?range=${st.range}&interval=${st.interval}&currency=${st.currency}`);
      drawPrice(m);
      window.dispatchEvent(new Event('finsent:chart'));
      return m;
    } catch (e) { toast(e.message); throw e; } finally { $('#st-chart').style.opacity = '1'; }
  };
  window.__stock = { st, overlays: [], apply: async (actions) => {
    let reload = false;
    for (const a of actions || []) {
      if (a.type === 'clear') { window.__stock.overlays = []; window.__draw?.clear('agent'); }
      else if (a.type === 'set_view') {
        if (a.interval) st.interval = a.interval;
        if (a.range) st.range = a.range;
        if (a.currency) st.currency = a.currency;
        reload = true;
      } else if (['trendline', 'channel', 'fib'].includes(a.type) && Array.isArray(a.points) && window.__draw) {
        const pts = a.points.filter((q) => q && q.date && isFinite(q.price)).map((q) => ({ t: window.__draw.naiveMs(String(q.date).slice(0, 16)), p: Number(q.price) }));
        if (pts.length >= (a.type === 'channel' ? 3 : 2)) window.__draw.add([{ type: a.type === 'trendline' ? 'trend' : a.type, pts, label: a.label || null }]);
      } else if (a.type === 'hline' || a.type === 'marker') window.__stock.overlays.push(a);
    }
    if (reload) {
      $$('#st-int button').forEach((x) => x.classList.toggle('on', x.dataset.i === st.interval));
      $$('#st-range button').forEach((x) => x.classList.toggle('on', x.dataset.r === st.range));
      $$('#st-cur button').forEach((x) => x.classList.toggle('on', x.dataset.c === st.currency));
      await load().catch(() => {});
    } else renderOverlays();
    document.getElementById('st-chart')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } };
  let m;
  try { m = await load(); } catch (e) { v.innerHTML = `<div class="empty">${esc(sym)} için veri bulunamadı.</div>`; return; }
  if (window.__pendingChart?.length) { const q = window.__pendingChart.splice(0); window.__stock.apply(q); }
  const segBind = (id, key, attr) => $$(`#${id} button`).forEach((b) => b.onclick = async () => {
    $$(`#${id} button`).forEach((x) => x.classList.toggle('on', x === b));
    st[key] = b.dataset[attr];
    if (key === 'interval') {  // a sensible default window per candle size
      st.range = { '1w': '5y', '1mo': 'all' }[st.interval] || (st.interval === '1d' ? '1y' : st.range);
      $$('#st-range button').forEach((x) => x.classList.toggle('on', x.dataset.r === st.range));
    }
    await load().catch(() => {});
  });
  segBind('st-range', 'range', 'r');
  segBind('st-int', 'interval', 'i');
  segBind('st-cur', 'currency', 'c');
  $('#st-name').textContent = cleanTitle(m.title) || ' ';
  renderStats(m.stats);
  $('#asof').textContent = `Son kapanış: ${fdate(m.to)}`;

  loadQuote(sym, m.stats);
  if (INSTRUMENTS.has(sym)) {   // gold / FX / index: no KAP, forecast or X cards - show cross-asset analysis instead
    $('#fc-card').outerHTML = `<div class="card reveal" id="gold-card" style="margin-top:16px"><div class="card-head"><h2>${GOLDISH.has(sym) ? 'Altın analizi' : 'Karşılaştırmalı görünüm'}</h2>
      <span class="hint">Gram altın, ons, döviz ve borsa</span></div><div id="gold">${skel(260)}</div></div>`;
    document.querySelectorAll('#soc-go, #ins-go').forEach((b) => b.closest('.grid')?.remove());
    document.getElementById('sig')?.closest('.grid')?.remove();
    if (GOLD_FC.has(sym)) {
      $('#gold-card').insertAdjacentHTML('beforebegin', `<div class="card reveal" id="gfc-card" style="margin-top:16px"><div class="card-head"><h2>Sırada ne olabilir?</h2>
        <span class="hint">Oynaklık modeli · 2012–2026 ileri yürüyen testte kalibre</span></div><div id="gfc">${skel(220)}</div></div>`);
      renderGoldForecast(sym);
    }
    renderGold(sym);
    return;
  }
  loadForecast(sym);
  loadSocial(sym);
  $('#soc-go').onclick = () => runSocial(sym);
  $('#ins-go').onclick = () => runInsight(sym);

  const [pats, disc] = await Promise.all([api(`/patterns?symbol=${sym}&limit=40`), api(`/disclosures?symbol=${sym}&limit=15`)]);
  const recent = pats.items.filter((p) => (Date.parse(m.to) - Date.parse(p.trade_date)) / 864e5 <= 60);
  $('#sig').innerHTML = recent.length ? recent.slice(0, 10).map((p) => {
    const [name, desc] = PATTERN[p.pattern] || [p.pattern, ''];
    const [dl, dc, da] = DIR[p.direction] || DIR.neutral;
    const det = patternDetail(p);
    return `<div class="signal"><div class="ic ${dc}">${da}</div><div style="flex:1;min-width:0">
      <div class="t">${esc(name)} <span class="muted small" style="font-weight:400">· ${fdate(p.trade_date)}</span></div>
      <div class="d">${esc(desc)}${det ? ` <span class="muted">(${esc(det)})</span>` : ''}</div></div>
      <div title="Sinyal gücü"><div class="note">${dl}</div><div class="strength"><i style="width:${Math.round(p.strength * 100)}%"></i></div></div></div>`;
  }).join('') : '<div class="empty">Son 60 günde belirgin sinyal yok</div>';
  $('#kap-n').textContent = disc.total ? `${disc.total} bildirim` : '';
  $('#kap').innerHTML = disc.items.length ? disc.items.map((d) => newsItem(d, false)).join('') : '<div class="empty">Bu hisse için KAP bildirimi yok</div>';
}


const GOLD_FC = new Set(['ALTIN', 'XAUUSD']);
const HZ_NAME = { 1: 'Yarın', 5: '1 hafta', 20: '1 ay' };
async function renderGoldForecast(sym) {
  const box = $('#gfc');
  let f;
  try { f = await api(`/forecast/${sym}`); } catch { box.innerHTML = '<div class="empty">Tahmin henüz üretilmedi</div>'; return; }
  if (f.version !== 'gold-v1') { box.innerHTML = '<div class="empty">Tahmin henüz üretilmedi</div>'; return; }
  const cur = f.currency === 'USD' ? '$' : '₺', d = f.close > 1000 ? 0 : 2;
  const lo = Math.min(...f.horizons.map((h) => h.p05)), hi = Math.max(...f.horizons.map((h) => h.p95));
  const x = (v) => ((v - lo) / (hi - lo || 1)) * 100;
  const v = f.vol, h20 = f.horizons.find((h) => h.days === 20) || f.horizons.at(-1);
  const dirAuc = f.horizons.map((h) => h.direction_auc).filter((a) => a !== null && a !== undefined);
  const aucTxt = dirAuc.length ? dirAuc.map((a) => num(a, 2)).join(' / ') : '–';
  const unit = (r) => r.unit === 'pct' ? pct(r.value, 1) : r.unit === 'bp' ? `${r.value > 0 ? '+' : ''}${num(r.value * 100, 0)} bp` : num(r.value, r.unit === 'z' ? 2 : 1);
  const rules = Object.entries(f.rules || {});
  box.innerHTML = `
    <div class="gfc-rows">${f.horizons.map((h) => `
      <div class="gfc-row">
        <div class="gfc-h"><b>${HZ_NAME[h.days] || h.days + ' gün'}</b><span class="note">${h.days} işlem günü</span></div>
        <div class="gfc-track" title="Açık bant: %90 olasılık · koyu bant: %68 olasılık · çizgi: medyan · nokta: bugünkü fiyat">
          <i class="b90" style="left:${x(h.p05)}%;width:${x(h.p95) - x(h.p05)}%"></i>
          <i class="b68" style="left:${x(h.p16)}%;width:${x(h.p84) - x(h.p16)}%"></i>
          <i class="med" style="left:${x(h.p50)}%"></i><i class="now" style="left:${x(f.close)}%"></i>
        </div>
        <div class="gfc-n num"><div>${cur}${num(h.p16, d)} – ${cur}${num(h.p84, d)} <span class="note">%68</span></div>
          <div class="note">${cur}${num(h.p05, d)} – ${cur}${num(h.p95, d)} · %90</div></div>
        <div class="gfc-c note">Test kapsaması <b>%${num(h.coverage_90 * 100, 0)}</b> <span class="muted">(hedef %90)</span></div>
      </div>`).join('')}
    </div>
    <div class="gfc-legend note"><span><i class="sw b90"></i>%90 olasılık</span><span><i class="sw b68"></i>%68 olasılık</span><span><i class="sw med"></i>medyan</span><span><i class="sw now"></i>bugün ${cur}${num(f.close, d)}</span>
      <button class="btn" id="gfc-draw" style="margin-left:auto;padding:4px 10px;font-size:12px">1 aylık aralığı grafikte göster</button></div>
    <div class="stats" style="margin:18px 0 16px">
      <div class="stat"><div class="l">Beklenen oynaklık (yıllık)</div><div class="v num">${pct(v.forecast_ann, 1, false)}</div>
        <div class="d">son 5 yıl yüzdelik dilimi: ${num(v.pctile_5y * 100, 0)}</div></div>
      <div class="stat"><div class="l">1 ayda yükseliş sıklığı</div><div class="v num">${pct(h20.up_rate_10y, 0, false)}</div><div class="d">son 10 yıl, medyan ${pct(h20.median_move_10y, 1)}</div></div>
      <div class="stat"><div class="l">200 günlük ortalamaya göre</div><div class="v num ${dirCls(f.trend.d_sma200)}">${pct(f.trend.d_sma200, 1)}</div><div class="d">zirveden ${pct(f.trend.dist_hi, 1)} · RSI ${num(f.trend.rsi, 0)}</div></div>
    </div>
    <div class="gfc-honest"><b>Yön tahmini: güvenilir bir sinyal yok.</b> 28 makro ve teknik göstergeyle eğitilen yön modelleri (lojistik regresyon, gradient boosting)
      2012'den beri her yıl ileri yürüyerek test edildi. AUC ${aucTxt} (yarın / 1 hafta / 1 ay; 0,50 yazı-tura demek). Bu yüzden ok yerine aralık gösteriyoruz.
      Altında tahmin edilebilen şey fiyatın <i>ne kadar</i> oynayacağı, <i>hangi yöne</i> gideceği değil.</div>
    <div class="grid g-2" style="margin-top:18px">
      <div><div class="note" style="margin-bottom:8px">Makro tablo: bugünkü değer, son 5 yıldaki yeri</div>
        <table class="tbl"><tbody>${(f.drivers || []).map((r) => `<tr><td>${esc(r.label)}</td><td class="num">${unit(r)}</td>
          <td><div class="range-bar" style="margin:6px 0;min-width:70px"><i style="left:${r.pctile_5y * 100}%"></i></div></td>
          <td>${r.tilt ? `<span class="pill ${r.tilt === 'destek' ? 'pos' : 'neg'}">${r.tilt === 'destek' ? 'altına destek' : 'altına baskı'}</span>` : '<span class="note">normal</span>'}</td></tr>`).join('')}</tbody></table>
        <p class="note" style="margin:8px 0 0">"Destek / baskı" ders kitabı ilişkisidir (güçlü dolar ve yükselen faiz baskı yapar). Kısa vadeli yön için güvenilir değildir.</p></div>
      <div><div class="note" style="margin-bottom:8px">Basit kurallar · 2012–2026, %0,05 işlem maliyetiyle</div>
        <table class="tbl"><thead><tr><th>Kural</th><th>Yıllık</th><th>Sharpe</th><th>En kötü düşüş</th><th>Piyasada</th></tr></thead><tbody>
        ${rules.map(([k, r]) => `<tr${k === 'Al-tut' ? ' class="hl"' : ''}><td>${esc(k)}</td><td class="num ${dirCls(r.cagr)}">${pct(r.cagr, 1)}</td><td class="num">${num(r.sharpe, 2)}</td>
          <td class="num down">${pct(r.maxdd, 0)}</td><td class="num">${pct(r.time_in_market, 0, false)}</td></tr>`).join('')}</tbody></table>
        <p class="note" style="margin:8px 0 0">Hiçbir zamanlama kuralı al-tut stratejisini geçemedi. Bazıları en kötü düşüşü azalttı, ama getiriden daha fazlasını kaybettirdi.</p></div>
    </div>
    <p class="note" style="margin:12px 0 0">${esc(f.model.range)}. Veri: ${fdate(f.as_of)} kapanışı. ${esc(f.disclaimer)}</p>`;
  $('#gfc-draw').onclick = () => {
    const S = window.__stock;
    if (!S) return;
    S.overlays = (S.overlays || []).filter((o) => !o.gold);
    S.apply([...(S.st.currency !== f.currency ? [{ type: 'set_view', currency: f.currency }] : []),
      { type: 'hline', price: h20.p95, label: '1 ay %95', kind: 'resistance', gold: 1 }, { type: 'hline', price: h20.p84, label: '1 ay %84', kind: 'target', gold: 1 },
      { type: 'hline', price: h20.p16, label: '1 ay %16', kind: 'target', gold: 1 }, { type: 'hline', price: h20.p05, label: '1 ay %5', kind: 'support', gold: 1 }]);
  };
}

async function renderGold(sym) {
  const box = $('#gold');
  let d;
  try { d = await api('/gold-analysis'); } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const cols = [['ALTIN', 'Gram altın'], ['XAUUSD', 'Ons ($)'], ['USDTRY', 'Dolar/TL'], ['EURTRY', 'Euro/TL'], ['XU100', 'BIST 100'], ['XU100_in_gold', 'BIST altın bazında'], ['XU100_in_usd', 'BIST dolar bazında']];
  const c = d.correlations_1y, dec = d.decomposition;
  box.innerHTML = `
    <div class="stats" style="margin-bottom:16px">
      <div class="stat"><div class="l">Gram altın · 1 yıl</div><div class="v num ${dirCls(dec.gram_gold_change_1y)}">${pct(dec.gram_gold_change_1y, 1)}</div>
        <div class="d">ons ${pct(dec.from_ounce, 1)} · dolar ${pct(dec.from_usdtry, 1)}</div></div>
      <div class="stat"><div class="l">BIST 100 kaç gram altın?</div><div class="v num">${num(d.now.XU100 / d.now.ALTIN, 2)} gr</div><div class="d">endeks ÷ gram altın</div></div>
      <div class="stat"><div class="l">Altın / gümüş oranı</div><div class="v num">${num(d.now.XAUUSD / d.now.XAGUSD, 1)}</div><div class="d">1 ons altın = kaç ons gümüş</div></div>
      <div class="stat"><div class="l">1 yıllık korelasyon</div><div class="v num" style="font-size:14px">Altın~Dolar ${num(c['ALTIN~USDTRY'], 2)}</div><div class="d">Altın~BIST ${num(c['ALTIN~XU100'], 2)} · Altın~Gümüş ${num(c['XAUUSD~XAGUSD'], 2)}</div></div>
    </div>
    <div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Dönem</th>${cols.map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead><tbody>
      ${d.returns.map((r) => `<tr><td>${esc(r.period)}</td>${cols.map(([k]) => `<td class="num ${dirCls(r[k])}">${pct(r[k], 1)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    <div class="grid g-2" style="margin-top:18px">
      <div><div class="note" style="margin-bottom:6px">Borsa altın karşısında: BIST 100 kaç gram altın ediyor? (haftalık)</div><div style="height:220px"><canvas id="g-ratio"></canvas></div></div>
      <div><div class="note" style="margin-bottom:6px">Altın / gümüş oranı (haftalık)</div><div style="height:220px"><canvas id="g-gs"></canvas></div></div>
    </div>
    <p class="note" style="margin:12px 0 0">Gram altın = ons altın (COMEX vadeli, Yahoo) × USD/TRY ÷ 31,1035. Kuyumcu/banka fiyatları makas ve işçilik nedeniyle farklı olabilir. Getiriler nominaldir, temettü ve faiz dahil değildir.</p>`;
  const S = d.series, lbl = S.dates.map((x) => x.slice(0, 4));
  lineChart('g-ratio', S.dates.map((x) => fdate(x)), S.xu100_grams, css('--accent'), { d: 2 });
  lineChart('g-gs', S.dates.map((x) => fdate(x)), S.gold_silver, '#d4d3ce', { d: 1 });
  void lbl;
}

function renderStats(s) {
  const rsi = s.rsi_14;
  const rsiTxt = rsi === null || rsi === undefined ? '' : rsi < 30 ? 'Aşırı satım' : rsi > 70 ? 'Aşırı alım' : 'Nötr bölge';
  const pos52 = s.high_52w > s.low_52w ? (s.close - s.low_52w) / (s.high_52w - s.low_52w) : 0.5;
  const trend = s.above_sma_200 === null ? '–' : s.above_sma_200 ? (s.above_sma_50 ? 'Güçlü yukarı' : 'Yukarı, zayıflıyor') : (s.above_sma_50 ? 'Aşağı, toparlanıyor' : 'Aşağı');
  const ret = (l, v) => `<div class="stat"><div class="l">${l}</div><div class="v num ${dirCls(v)}">${arrow(v)} ${pct(v, 1)}</div></div>`;
  $('#st-stats').innerHTML = `${ret('1 hafta', s.change_1w)}${ret('1 ay', s.change_1m)}${ret('3 ay', s.change_3m)}${ret('1 yıl', s.change_1y)}
    <div class="stat"><div class="l">52 hafta aralığı</div><div class="range-bar"><i style="left:${Math.max(0, Math.min(1, pos52)) * 100}%"></i></div>
      <div class="d num">${num(s.low_52w)} – ${num(s.high_52w)}</div></div>
    <div class="stat"><div class="l">RSI · trend</div><div class="v num">${num(rsi, 0)} <span class="small muted" style="font-weight:400">${rsiTxt}</span></div><div class="d">${trend}</div></div>`;
}

const TZ_SHIFT = 3 * 3600;  // show Istanbul wall-clock time on the intraday axis
function barTime(b, intraday) {
  if (!intraday) return b.trade_date;
  return Math.floor(Date.parse(b.trade_date.replace(' ', 'T') + ':00Z') / 1000);
}
function sma(values, n) {
  const out = []; let sum = 0;
  values.forEach((v, i) => { sum += v; if (i >= n) sum -= values[i - n]; out.push(i >= n - 1 ? sum / n : null); });
  return out;
}
const OVERLAY_COLOR = { support: '#35ad6e', resistance: '#c2413b', stop: '#c2413b', target: '#dcae57', neutral: '#a3a29d' };
function renderOverlays() {
  const R = window.__chartRefs, O = window.__stock?.overlays || [];
  if (!R) return;
  R.lines.forEach((l) => { try { R.candle.removePriceLine(l); } catch { /* chart rebuilt */ } });
  R.lines = [];
  const agentMarkers = [];
  for (const o of O) {
    if (o.type === 'hline' && isFinite(o.price)) {
      R.lines.push(R.candle.createPriceLine({ price: Number(o.price), color: OVERLAY_COLOR[o.kind] || OVERLAY_COLOR.neutral, lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: o.label || '' }));
    } else if (o.type === 'marker' && o.date) {
      const t = R.barFor(String(o.date).slice(0, 10));
      if (t !== null && t !== undefined) agentMarkers.push({ time: t, position: o.direction === 'down' ? 'aboveBar' : 'belowBar',
        color: '#dcae57', shape: o.direction === 'down' ? 'arrowDown' : o.direction === 'up' ? 'arrowUp' : 'circle', text: o.text || '' });
    }
  }
  R.candle.setMarkers([...R.baseMarkers, ...agentMarkers].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0)));
}
function drawPrice(m) {
  const el = $('#st-chart');
  const intraday = ['15m', '1h', '4h'].includes(m.interval);
  const unit = { '15m': '15dk', '1h': 'saatlik', '4h': '4 saatlik', '1d': 'günlük', '1w': 'haftalık', '1mo': 'aylık' }[m.interval] || 'günlük';
  $('#ma1-l').textContent = `50 ${unit} ort.`;
  $('#ma2-l').textContent = `200 ${unit} ort.`;
  const cur = m.currency === 'USD' ? '$' : '₺';
  if (lw) { lw.remove(); lw = null; }
  lw = LightweightCharts.createChart(el, {
    autoSize: true,
    layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#6e6d68', fontFamily: 'Inter', fontSize: 11, attributionLogo: false },
    grid: { vertLines: { color: 'rgba(255,255,255,.025)' }, horzLines: { color: 'rgba(255,255,255,.04)' } },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.22 } },
    timeScale: { borderVisible: false, timeVisible: intraday, secondsVisible: false },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: { color: 'rgba(255,255,255,.18)', labelBackgroundColor: '#18181b' }, horzLine: { color: 'rgba(255,255,255,.18)', labelBackgroundColor: '#18181b' } },
    localization: { locale: 'tr-TR', priceFormatter: (p) => `${num(p, m.currency === 'USD' ? 3 : 2)}` },
  });
  const up = css('--up'), down = css('--down');
  const bars = m.bars.filter((b) => b.close !== null);
  const candle = lw.addCandlestickSeries({ upColor: up, downColor: down, borderVisible: false, wickUpColor: up, wickDownColor: down, priceLineColor: 'rgba(255,255,255,.25)' });
  const T = bars.map((b) => barTime(b, intraday));
  candle.setData(bars.map((b, i) => {
    const close = Number(b.close), open = b.open !== null ? Number(b.open) : close;
    return { time: T[i], open, high: Math.max(Number(b.high ?? close), open, close), low: Math.min(Number(b.low ?? close), open, close), close };
  }));
  const vol = lw.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
  lw.priceScale('vol').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
  vol.setData(bars.map((b, i) => ({ time: T[i], value: Number(b.volume_try || 0),
    color: Number(b.close) >= Number(b.open ?? b.close) ? 'rgba(53,173,110,.28)' : 'rgba(194,65,59,.28)' })));
  const closes = bars.map((b) => Number(b.close));
  const line = (n, color) => {
    const s = lw.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const v = sma(closes, n);
    s.setData(v.map((x, i) => ({ time: T[i], value: x })).filter((p) => p.value !== null));
  };
  line(50, 'rgba(212,211,206,.55)');
  line(200, 'rgba(110,109,104,.8)');
  // a disclosure belongs to the last bar starting on or before its event day
  const dayOf = bars.map((b) => b.trade_date.slice(0, 10));
  const barFor = (d) => { let k = -1; for (let i = 0; i < dayOf.length && dayOf[i] <= d; i++) k = i; return k < 0 ? null : T[k]; };
  const markers = (m.events || []).filter((e) => e.event_date && e.label && e.label !== 'neutral' && barFor(e.event_date) !== null)
    .map((e) => ({ time: barFor(e.event_date), position: e.label === 'positive' ? 'belowBar' : 'aboveBar',
      color: e.label === 'positive' ? up : down, shape: e.label === 'positive' ? 'arrowUp' : 'arrowDown' }))
    .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  const seen = new Set();
  const baseMarkers = markers.filter((x) => { const k = x.time + x.shape; if (seen.has(k)) return false; seen.add(k); return true; });
  candle.setMarkers(baseMarkers);
  window.__chartRefs = { candle, baseMarkers, barFor, lines: [], currency: m.currency };
  renderOverlays();
  window.__draw?.attach({ chart: lw, candle, el, symbol: m.symbol, currency: m.currency, intraday, interval: m.interval,
    times: bars.map((b) => window.__draw.naiveMs(b.trade_date)), lastClose: Number(bars.at(-1)?.close) });
  lw.timeScale().fitContent();
  const evByDate = {};
  (m.events || []).forEach((e) => { const t = e.event_date && barFor(e.event_date); if (t !== null && t !== undefined) (evByDate[t] ||= []).push(e); });
  const label = (t) => (intraday ? fdate(new Date((t - TZ_SHIFT) * 1000).toISOString(), true) : fdate(t));
  const legend = $('#st-legend');
  const show = (b, t) => {
    if (!b) return;
    const ch = b.close / b.open - 1;
    const ev = evByDate[t] || [];
    const d = m.currency === 'USD' ? 3 : 2;
    legend.innerHTML = `<span>${label(t)}</span><span>A <b>${cur}${num(b.open, d)}</b></span><span>Y <b>${num(b.high, d)}</b></span>
      <span>D <b>${num(b.low, d)}</b></span><span>K <b>${cur}${num(b.close, d)}</b></span><span class="${dirCls(ch)}">${arrow(ch)} ${pct(ch)}</span>
      ${ev.length ? `<span style="color:var(--accent-text)">${ev.length} KAP bildirimi: ${esc((ev[0].subject || '').slice(0, 60))}</span>` : ''}`;
  };
  const lastBar = bars.at(-1);
  if (lastBar) show({ open: Number(lastBar.open ?? lastBar.close), high: Number(lastBar.high), low: Number(lastBar.low), close: Number(lastBar.close) }, T[T.length - 1]);
  lw.subscribeCrosshairMove((p) => { if (p.time) show(p.seriesData.get(candle), p.time); });
}

async function loadQuote(sym, stats) {
  try {
    const q = await api(`/quote/${sym}`);
    $('#st-price').textContent = num(q.price);
    $('#st-chg').innerHTML = `${chg((q.change_pct ?? 0) / 100)}<span class="muted small">${esc(q.source)} · ${fdate(q.market_time, true)}</span>`;
  } catch {
    $('#st-price').textContent = num(stats.close);
    $('#st-chg').innerHTML = `${chg(stats.change_1d)}<span class="muted small">günlük kapanış</span>`;
  }
}

async function loadForecast(sym) {
  const box = $('#fc');
  charts['fc-chart']?.destroy(); delete charts['fc-chart'];
  try {
    const f = await api(`/forecast/${sym}`);
    renderForecast(box, f);
  } catch (e) {
    box.innerHTML = `<div class="empty">${e.status === 404 ? 'Bu hisse için henüz tahmin üretilmedi. Akşam pipeline çalışınca hazır olacak.' : esc(e.message)}</div>`;
  }
}
function trustText(auc) {
  if (auc === null || auc === undefined) return ['Model yok', ''];
  if (auc >= 0.58) return ['Güvenilirlik: iyi', 'pos'];
  if (auc >= 0.54) return ['Güvenilirlik: orta', 'acc'];
  return ['Güvenilirlik: zayıf', ''];
}
function rankWords(r) {
  if (r >= 0.9) return 'en güçlü %10';
  if (r >= 0.75) return 'üst çeyrek';
  if (r <= 0.1) return 'en zayıf %10';
  if (r <= 0.25) return 'alt çeyrek';
  return 'orta bölge';
}
function renderForecast(box, f) {
  const hz = (f.horizons || []);
  const LBL = { 1: 'Yarın', 5: '1 hafta', 20: '1 ay' };
  const v2 = f.version === 'v2';
  box.innerHTML = `
    <div class="fc-bars">${hz.map((h) => {
      const p = h.p_up, strong = Math.abs(p - 0.5) >= 0.05;
      const [tt, tc] = trustText(Math.max(h.model_auc || 0, h.beat_auc || 0) || h.model_auc);
      return `<div class="fc"><div class="h">${LBL[h.days] || h.days + ' gün'} <span class="muted">· ${h.days} işlem günü</span></div>
        <div class="p ${strong ? (p > 0.5 ? 'up' : 'down') : 'flat'}">${strong ? (p > 0.5 ? '▲ Yükseliş' : '▼ Düşüş') : '• Belirsiz'}
          <span class="num" style="font-size:15px;font-weight:500"> %${num(p * 100, 0)} yükseliş ihtimali</span></div>
        <div class="prob"><span style="width:${p * 100}%"></span></div>
        ${v2 ? `<div class="note" style="margin-top:10px">Endeksi geçme ihtimali <b class="num ${h.p_beat >= 0.5 ? 'up' : 'down'}">%${num(h.p_beat * 100, 0)}</b></div>
          <div class="note" style="margin-top:6px">Bugün tüm hisseler arasında: <b style="color:var(--text)">${rankWords(h.rank_pct)}</b></div>
          <div class="range-bar" title="Sıra: %${num(h.rank_pct * 100, 0)}"><i style="left:${h.rank_pct * 100}%"></i></div>
          <div class="legend-row" style="justify-content:space-between;font-size:11px"><span>zayıf</span><span>güçlü</span></div>`
        : `<div class="note" style="margin-top:8px">${esc(h.basis || '')}</div>`}
        <div style="margin-top:8px"><span class="pill ${tc}" title="Son 1 yılda, eğitimde görmediği verilerde ölçüldü. AUC ${num(h.model_auc, 3)} / endeks ${num(h.beat_auc, 3)} (0,5 = yazı-tura)">${tt}</span></div></div>`;
    }).join('')}</div>
    ${v2 && hz[1] ? `<p class="note" style="margin:14px 0 0">Geçmiş isabet (son 1 yıl, eğitimde görülmemiş veri): model 1 haftalık görünümde
      <b style="color:var(--text)">en üst %10'a</b> koyduğu hisselerin <b class="up">%${num(hz[1].top_decile_hit * 100, 0)}</b>'i endeksi geçti,
      <b style="color:var(--text)">en alt %10'dakilerin</b> ise yalnızca <b class="down">%${num(hz[1].bottom_decile_hit * 100, 0)}</b>'i.</p>` : ''}
    ${f.explanation ? `<p class="callout" style="margin:14px 0 0">${esc(f.explanation)}</p>` : ''}
    ${f.analogs?.length ? `<details class="analogs" style="margin-top:16px"><summary>Geçmişte buna benzeyen anlar <span class="muted small">· yalnızca bağlam</span></summary>
      <div class="grid g-hero" style="margin-top:12px;align-items:start">
      <div><div class="note" style="margin-bottom:8px">En benzer ${f.analogs.length} durumdan sonraki 20 gün (gri) ve medyanı (amber)</div>
        <div style="height:210px"><canvas id="fc-chart"></canvas></div></div>
      <div><div class="note" style="margin-bottom:8px">En benzer anlar · 5 ve 20 gün sonra</div><div class="rows">${f.analogs.slice(0, 6).map((a) => {
        const r5 = a.path[5], r20 = a.path[a.path.length - 1];
        return `<div class="row" style="cursor:default;padding:7px 2px"><span style="flex:1">${fdate(a.date)}</span>
          <span class="num small ${dirCls(r5)}">${pct(r5, 1)}</span>
          <span class="num small ${dirCls(r20)}" style="width:62px;text-align:right">${pct(r20, 1)}</span></div>`;
      }).join('')}</div></div></div>
      <p class="note" style="margin:10px 0 0">${esc(f.analogs_note || '')}</p></details>` : ''}
    <p class="note" style="margin:12px 0 0">${esc(f.disclaimer || 'Olasılıksal bir tahmindir; yatırım tavsiyesi değildir.')} · ${fdate(f.as_of)} kapanışına göre</p>`;
  const det = box.querySelector('details.analogs');
  if (det && f.analogs?.length) det.addEventListener('toggle', () => { if (det.open && !charts['fc-chart']) drawAnalogs(f); });
}
function drawAnalogs(f) {
  const days = f.analogs[0].path.map((_, i) => i);
  chart('fc-chart', {
    type: 'line',
    data: { labels: days.map((d) => (d === 0 ? 'Bugün' : `+${d}`)), datasets: [
      ...f.analogs.map((a) => ({ data: a.path.map((x) => x * 100), borderColor: 'rgba(163,162,157,.16)', borderWidth: 1, pointRadius: 0, tension: .25 })),
      { data: f.analog_median.map((x) => x * 100), borderColor: css('--accent'), borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 4, tension: .25 }] },
    options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      animation: { duration: 1100, easing: 'easeOutQuart' },
      plugins: { legend: { display: false },
        tooltip: { ...tooltip, filter: (i) => i.datasetIndex === f.analogs.length,
          callbacks: { title: (c) => (c[0].label === 'Bugün' ? 'Bugün' : `${c[0].label} işlem günü`), label: (c) => `Medyan ${pct(c.parsed.y / 100, 1)}` } } },
      scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 6 } },
        y: { position: 'right', ticks: { callback: (v) => `${v}%` }, grid: { color: (c) => (c.tick.value === 0 ? 'rgba(255,255,255,.18)' : 'rgba(255,255,255,.04)') } } } },
  });
}

function renderSocial(r) {
  const box = $('#soc');
  if (!r) { box.innerHTML = '<div class="empty">Bu hisse için henüz X araması yapılmadı.</div>'; return; }
  box.innerHTML = `<div style="display:flex;align-items:baseline;gap:10px;margin-bottom:10px">
      <span class="big-label ${r.label === 'positive' ? 'up' : r.label === 'negative' ? 'down' : r.label === 'mixed' ? 'acc' : 'flat'}">${(LABEL[r.label] || ['–'])[0]}</span>
      <span class="muted small">${fdate(r.as_of)}${r.posts_fetched ? ` · ${r.posts_fetched} gönderi tarandı` : ''}</span></div>
    ${meter(r.score)}
    <div class="legend-row" style="margin:12px 0"><span><span class="sw" style="background:var(--up)"></span>Boğa %${num((r.bullish_share || 0) * 100, 0)}</span>
      <span><span class="sw" style="background:var(--down)"></span>Ayı %${num((r.bearish_share || 0) * 100, 0)}</span></div>
    <p style="margin:0 0 12px;color:var(--text-2)">${esc(r.summary)}</p>
    ${(r.themes || []).length ? `<div class="chips" style="margin-bottom:12px">${r.themes.map((t) => `<span class="pill">${esc(t)}</span>`).join('')}</div>` : ''}
    ${(r.notable_posts || []).slice(0, 3).map((p) => `<div class="post">${esc(p.text)} ${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">↗</a>` : ''}</div>`).join('')}`;
}
async function loadSocial(sym) {
  try { const r = await api(`/social/${sym}`); renderSocial(r.history[0]); $('#soc-go').disabled = !r.grok; }
  catch { renderSocial(null); }
}
async function runSocial(sym) {
  const b = $('#soc-go'); b.disabled = true; b.innerHTML = '<span class="spinner"></span> Grok arıyor…';
  try { renderSocial(await api(`/social/${sym}`, { method: 'POST', body: '{}' })); }
  catch (e) { toast(e.message); }
  b.disabled = false; b.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>Şimdi ara';
}
async function runInsight(sym) {
  const b = $('#ins-go'), box = $('#ins'); b.disabled = true;
  box.innerHTML = '<div class="empty"><span class="spinner"></span> Yorum hazırlanıyor…</div>';
  try {
    const r = await api(`/insights/${sym}`, { method: 'POST', body: '{}' });
    const bias = { bullish: ['Olumlu görünüm', 'pos'], bearish: ['Olumsuz görünüm', 'neg'], neutral: ['Nötr', ''], mixed: ['Karışık sinyaller', 'acc'] }[r.bias] || ['', ''];
    box.innerHTML = `<div class="chips" style="margin-bottom:10px"><span class="pill ${bias[1]}">${bias[0]}</span></div>
      <p style="margin:0 0 14px;color:var(--text-2)">${esc(r.summary)}</p>
      <div class="grid g-2"><div><div class="note">Destekleyen sinyaller</div><ul class="clean">${r.signals.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>
      <div><div class="note">Riskler</div><ul class="clean">${r.risks.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div></div>
      <p class="note" style="margin:10px 0 0">${r.provider === 'rules' ? 'Kural tabanlı özet' : 'Grok'} · yatırım tavsiyesi değildir</p>`;
  } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  b.disabled = false;
}


// ------------------------------------------------------------------ page: pair analysis
const fshort = (x) => { const d = new Date(x); return `${MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`; };
async function pagePair(v, a, b) {
  a = (a || 'PGSUS').toUpperCase(); b = (b || 'THYAO').toUpperCase();
  v.innerHTML = `
    <div class="page-head"><div><h1>Çift analizi</h1><div class="sub">İki hisse birlikte nasıl hareket ediyor, biri diğerini takip ediyor mu, bundan para kazanılır mı?</div></div>
      <div class="toolbar" style="margin:0"><input class="field" id="p-a" value="${esc(a)}" style="width:96px"><span class="muted">vs</span>
        <input class="field" id="p-b" value="${esc(b)}" style="width:96px"><button class="btn" id="p-go">Karşılaştır</button>
        <div class="seg" id="p-range">${['1y:1Y', '3y:3Y', '5y:5Y', 'all:Tümü'].map((x) => { const [k, l] = x.split(':'); return `<button data-r="${k}" class="${k === '3y' ? 'on' : ''}">${l}</button>`; }).join('')}</div></div></div>
    <div class="stats reveal" id="p-stats">${'<div class="stat"><div class="skeleton" style="height:38px"></div></div>'.repeat(4)}</div>
    <div class="grid g-hero" style="margin-top:16px">
      <div class="card reveal"><div class="card-head"><h2>Fiyatlar (başlangıç = 100)</h2><span class="hint" id="p-legend"></span></div><div style="height:300px"><canvas id="p-price"></canvas></div></div>
      <div class="card reveal" style="animation-delay:.05s"><div class="card-head"><h2>Fiyat makası</h2><span class="hint">60 günlük z-skoru</span></div>
        <div style="height:220px"><canvas id="p-z"></canvas></div>
        <p class="note" id="p-z-note" style="margin:10px 0 0"></p></div>
    </div>
    <div id="p-research"></div>`;
  $('#p-go').onclick = () => { location.hash = `#/cift/${$('#p-a').value.trim().toUpperCase()}/${$('#p-b').value.trim().toUpperCase()}`; };
  let range = '3y';
  const load = async () => {
    let d;
    try { d = await api(`/pair/${a}/${b}?range=${range}`); } catch (e) { $('#p-stats').innerHTML = `<div class="stat"><div class="empty">${esc(e.message)}</div></div>`; return; }
    const S = d.summary, s = d.series, z = S.last_z;
    $('#p-stats').innerHTML = `
      <div class="stat"><div class="l">Getiri korelasyonu</div><div class="v num">${num(S.corr, 2)}</div><div class="d">${S.corr > 0.7 ? 'Çok güçlü' : S.corr > 0.5 ? 'Güçlü' : S.corr > 0.3 ? 'Orta' : 'Zayıf'} · ${num(S.days, 0)} gün</div></div>
      <div class="stat"><div class="l">Son 60 gün korelasyon</div><div class="v num">${num(S.last_corr, 2)}</div></div>
      <div class="stat"><div class="l">Beta (${esc(a)} / ${esc(b)})</div><div class="v num">${num(S.beta, 2)}</div><div class="d">${esc(b)} %1 oynayınca ${esc(a)} ort. %${num(S.beta, 2)}</div></div>
      <div class="stat"><div class="l">Makas şu an</div><div class="v num ${z > 1 ? 'down' : z < -1 ? 'up' : ''}">${z > 0 ? '+' : ''}${num(z, 2)}σ</div>
        <div class="d">${z > 1 ? `${esc(a)} göreceli pahalı` : z < -1 ? `${esc(a)} göreceli ucuz` : 'Normal aralıkta'}</div></div>`;
    $('#p-legend').innerHTML = `<span class="sw" style="background:var(--accent)"></span>${esc(a)} &nbsp; <span class="sw" style="background:#d4d3ce"></span>${esc(b)}`;
    chart('p-price', { type: 'line', data: { labels: s.dates.map((x) => fdate(x)), datasets: [
        { label: a, data: s.a, borderColor: css('--accent'), borderWidth: 1.8, pointRadius: 0, tension: .15 },
        { label: b, data: s.b, borderColor: '#d4d3ce', borderWidth: 1.4, pointRadius: 0, tension: .15 }] },
      options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: false }, tooltip: { ...tooltip, displayColors: true } },
        scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 7, maxRotation: 0 } }, y: { position: 'right', grid: { color: 'rgba(255,255,255,.04)' } } } } });
    chart('p-z', { type: 'line', data: { labels: s.dates.map(fshort), datasets: [
        { data: s.z, borderColor: '#d4d3ce', borderWidth: 1.2, pointRadius: 0, tension: .1 },
        { data: s.z.map(() => 2), borderColor: 'rgba(194,65,59,.5)', borderDash: [4, 4], borderWidth: 1, pointRadius: 0 },
        { data: s.z.map(() => -2), borderColor: 'rgba(53,173,110,.5)', borderDash: [4, 4], borderWidth: 1, pointRadius: 0 }] },
      options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { ...tooltip, filter: (i) => i.datasetIndex === 0, callbacks: { label: (c) => `z = ${num(c.parsed.y, 2)}` } } },
        scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 4, maxRotation: 0 } }, y: { position: 'right', grid: { color: (c) => (c.tick.value === 0 ? 'rgba(255,255,255,.18)' : 'rgba(255,255,255,.04)') } } } } });
    $('#p-z-note').textContent = `Makas = log(${a}) − beta × log(${b}). +2σ üstü: ${a} ${b}'ya göre pahalı; −2σ altı: ucuz. Kesikli çizgiler ±2σ.`;
    renderPairResearch(d);
  };
  $$('#p-range button').forEach((x) => x.onclick = () => { $$('#p-range button').forEach((y) => y.classList.toggle('on', y === x)); range = x.dataset.r; load(); });
  load();
}

function renderPairResearch(d) {
  const box = $('#p-research');
  const R = d.research;
  if (!R) { box.innerHTML = `<div class="card" style="margin-top:16px"><div class="empty">Bu çift için ayrıntılı araştırma (gecikme analizi, strateji testleri) henüz çalıştırılmadı.</div></div>`; return; }
  const [A, B] = R.pair, an = R.analysis, bt = R.backtest, dly = bt.daily;
  const TF = { '1d': 'Günlük', '60m': 'Saatlik', '15m': '15 dakika' };
  const tfRows = Object.entries(TF).filter(([k]) => an[k]).map(([k, l]) => {
    const x = an[k], lead = x.lead_lag['1'] ?? x.lead_lag[1], gp = Math.min(...Object.values(x.granger_thyao_to_pgsus_p));
    return `<tr><td>${l}</td><td class="num">${num(x.corr, 2)}</td><td class="num">${num(lead, 3)}</td>
      <td>${gp < 0.05 ? `<span class="pill acc">var (p=${num(gp, 3)})</span>` : `<span class="pill">yok (p=${num(gp, 2)})</span>`}</td>
      <td>${x.coint_p < 0.05 ? '<span class="pill pos">var</span>' : `<span class="pill">yok (p=${num(x.coint_p, 2)})</span>`}</td></tr>`;
  }).join('');
  const costs = ['0bps', '5bps', '10bps', '15bps'];
  const cu = bt['catch_up_5m'];
  box.innerHTML = `
    <div class="card reveal" style="margin-top:16px"><div class="card-head"><h2>${esc(B)} → ${esc(A)}: takip ediyor mu?</h2><span class="hint">Araştırma · ${fdate(R.generated_at, true)}</span></div>
      <table class="tbl"><thead><tr><th>Zaman dilimi</th><th>Aynı anda korelasyon</th><th>1 bar sonra (${esc(B)}→${esc(A)})</th><th>${esc(B)}, ${esc(A)}'u öngörüyor mu?</th><th>Makas ortalamaya dönüyor mu?</th></tr></thead><tbody>${tfRows}</tbody></table>
      <p class="callout" style="margin:14px 0 0">İki hisse <b>aynı anda</b> çok güçlü birlikte hareket ediyor. <b>Gecikmeli takip</b> günlük ve saatlik ölçekte yok;
        sadece birkaç dakikalık ölçekte zayıf bir izi var. Makas uzun vadede ortalamasına dönmüyor, yani "açılan makas kapanır" varsayımı bu çift için güvenilir değil.</p></div>

    <div class="card reveal" style="margin-top:16px"><div class="card-head"><h2>Günlük stratejiler · gerçek test (${esc(dly.out_of_sample[0].slice(0, 4))}–${esc(dly.out_of_sample[1].slice(0, 4))})</h2>
      <div class="seg" id="bt-cost">${costs.map((c, i) => `<button data-c="${c}" class="${i === 2 ? 'on' : ''}">${c.replace('bps', '')} bp</button>`).join('')}</div></div>
      <div class="grid g-hero" style="align-items:start"><div style="height:280px"><canvas id="bt-eq"></canvas></div><div id="bt-table"></div></div>
      <p class="note" style="margin:10px 0 0">Parametreler yalnızca ${esc(dly.in_sample[0].slice(0, 4))}–${esc(dly.in_sample[1].slice(0, 4))} verisiyle seçildi; grafik ve tablo hiç görülmemiş sonraki dönemi gösteriyor. Maliyet: işlem başına, her taraf için (bp = binde 0,1).</p></div>

    ${cu ? `<div class="card reveal" style="margin-top:16px"><div class="card-head"><h2>"${esc(A)} yetişir" stratejisi · 5 dakikalık</h2><span class="hint">Test: ${fdate(cu.out_of_sample[0])} – ${fdate(cu.out_of_sample[1])}</span></div>
      <p style="margin:0 0 12px;color:var(--text-2)">Kural: 5 dakikalık bir barda ${esc(B)}, ${esc(A)}'dan (beta düzeltmeli) <b>%${num(cu.best_in_sample.thr * 100, 1)}</b>'ten fazla öne geçerse ${esc(A)} alınır,
        <b>${cu.best_in_sample.hold * 5} dakika</b> sonra satılır. Gece pozisyon taşınmaz.</p>
      <div class="grid g-hero" style="align-items:start"><div style="height:220px"><canvas id="cu-eq"></canvas></div>
      <div class="rows">${cu.oos.long.by_cost.map((x) => `<div class="row" style="cursor:default"><span style="flex:1">${x.strategy.replace('long @ ', 'Maliyet ').replace('bps/side', ' bp')}<div class="muted small">${x.trades} işlem · kazanma %${num(x.win_rate * 100, 0)}</div></span>
        <span class="num ${dirCls(x.avg_trade)}">${pct(x.avg_trade, 3)}/işlem</span><b class="num ${dirCls(x.total_return)}" style="width:70px;text-align:right">${pct(x.total_return, 1)}</b></div>`).join('')}</div></div>
      <p class="callout" style="margin:14px 0 0">Brüt kazanç işlem başına ~%${num(cu.oos.long.gross_avg_trade * 100, 2)} (rastgele girişte %${num(cu.oos.long.random_entry_avg * 100, 2)}). Taraf başına ~${num(cu.oos.long.gross_avg_trade / 2 * 1e4, 0)} bp maliyete kadar kârlı;
        normal komisyonla zarar ediyor. Test sadece birkaç haftalık veriye dayanıyor (Yahoo 5 dk veriyi 60 gün tutuyor); sistem bundan sonra 5 dakikalık veriyi her gün biriktiriyor.</p></div>` : ''}`;
  const drawBt = (cost) => {
    const rows = [['Çift işlemi (al/sat)', dly.pairs_oos_by_cost[cost]], ['Ucuz olana geç', dly.switch_oos_by_cost[cost]],
      [`${B} tut`, dly.buy_hold_oos[B]], [`${A} tut`, dly.buy_hold_oos[A]]];
    $('#bt-table').innerHTML = `<table class="tbl"><thead><tr><th>Strateji</th><th>Yıllık</th><th>En büyük düşüş</th><th>Sharpe</th></tr></thead><tbody>
      ${rows.map(([n, x]) => `<tr><td>${esc(n)}</td><td class="num ${dirCls(x.annualised)}">${pct(x.annualised, 1)}</td><td class="num down">${pct(x.max_drawdown, 0)}</td><td class="num">${num(x.sharpe, 2)}</td></tr>`).join('')}</tbody></table>
      <p class="note" style="margin:10px 0 0">Ucuz olana geçiş stratejisi, sadece ${esc(B)} tutmaktan daha az kazandırdı ve daha riskliydi.</p>`;
  };
  drawBt('10bps');
  $$('#bt-cost button').forEach((x) => x.onclick = () => { $$('#bt-cost button').forEach((y) => y.classList.toggle('on', y === x)); drawBt(x.dataset.c); });
  const E = dly.equity_oos;
  const lines = [['pairs', 'Çift işlemi', css('--accent'), 2.2], ['switch', 'Ucuz olana geç', '#d4d3ce', 1.6], [B, `${B} tut`, '#8a8984', 1.2], [A, `${A} tut`, '#5a5955', 1.2]];
  chart('bt-eq', { type: 'line', data: { labels: E.dates.map((x) => fdate(x)), datasets: lines.map(([k, l, c, w]) => ({ label: l, data: E[k], borderColor: c, borderWidth: w, pointRadius: 0, tension: .15 })) },
    options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 2, color: '#a3a29d' } }, tooltip: { ...tooltip, displayColors: true, callbacks: { label: (c) => `${c.dataset.label}: ${num(c.parsed.y, 2)}x` } } },
      scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 6, maxRotation: 0 } }, y: { type: 'logarithmic', position: 'right', grid: { color: 'rgba(255,255,255,.04)' }, ticks: { callback: (v) => `${num(v, 1)}x` } } } } });
  if (cu?.oos_trades_long?.length) {
    let eq = 1; const pts = cu.oos_trades_long.map((t) => (eq *= 1 + t.r - 0.002));
    let eg = 1; const gross = cu.oos_trades_long.map((t) => (eg *= 1 + t.r));
    chart('cu-eq', { type: 'line', data: { labels: cu.oos_trades_long.map((t, i) => i + 1), datasets: [
        { label: 'Maliyetsiz', data: gross.map((x) => (x - 1) * 100), borderColor: '#d4d3ce', borderWidth: 1.4, pointRadius: 0, stepped: true },
        { label: '10 bp/taraf', data: pts.map((x) => (x - 1) * 100), borderColor: css('--accent'), borderWidth: 2, pointRadius: 0, stepped: true }] },
      options: { maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 2, color: '#a3a29d' } }, tooltip: { ...tooltip, callbacks: { title: (c) => `${c[0].label}. işlem`, label: (c) => `${c.dataset.label}: ${pct(c.parsed.y / 100, 1)}` } } },
        scales: { x: { grid: { display: false }, title: { display: true, text: 'işlem sırası', color: '#6e6d68' } }, y: { position: 'right', ticks: { callback: (v) => `${v}%` }, grid: { color: (c) => (c.tick.value === 0 ? 'rgba(255,255,255,.18)' : 'rgba(255,255,255,.04)') } } } } });
  }
}

// ------------------------------------------------------------------ page: KAP feed

async function pageNews(v, tab) {
  v.innerHTML = `<div class="page-head"><div><h1>KAP bildirimleri</h1><div class="sub">Bildirimler, Grok duygu analizi ve fiyata etkisi</div></div>
      <div class="seg" id="n-tab"><button data-t="akis" class="${tab !== 'etki' ? 'on' : ''}">Akış</button><button data-t="etki" class="${tab === 'etki' ? 'on' : ''}">Etki analizi</button></div></div>
    <div id="n-body"></div>`;
  $$('#n-tab button').forEach((b) => b.onclick = () => { location.hash = `#/bildirimler/${b.dataset.t}`; });
  const body = $('#n-body');
  if (tab === 'etki') return pageImpact(body);
  return pageNewsFeed(body);
}

async function pageImpact(v) {
  v.innerHTML = `<div class="toolbar"><input class="field" id="i-sym" placeholder="Hisse filtresi (boş = tüm borsa)" style="width:230px"><button class="btn" id="i-go">Uygula</button><span class="muted small" id="i-span"></span></div>
    <div class="stats" id="i-labels">${'<div class="stat"><div class="skeleton" style="height:48px"></div></div>'.repeat(3)}</div>
    <div class="grid g-hero" style="margin-top:16px;align-items:start">
      <div class="card"><div class="card-head"><h2>Bildirim türüne göre 3 günlük tepki</h2><span class="hint">Endekse göre ortalama, olumlu vs olumsuz</span></div><div id="i-chart-wrap" style="height:460px"><canvas id="i-chart"></canvas></div></div>
      <div class="card"><div class="card-head"><h2>Yıllara göre</h2><span class="hint">3 günlük ortalama tepki</span></div><div style="height:220px"><canvas id="i-year"></canvas></div>
        <p class="note" style="margin:12px 0 0">Her nokta o yıl Grok'un olumlu (yeşil) ya da olumsuz (kırmızı) bulduğu bildirimlerden sonraki 3 işlem gününde hissenin BIST 100'e göre ortalama getirisi.</p></div>
    </div>
    <div class="card" style="margin-top:16px"><div class="card-head"><h2>Ayrıntılı tablo</h2><span class="hint">En az 15 olay</span></div><div id="i-table"></div></div>`;
  const load = async () => {
    const sym = $('#i-sym').value.trim().toUpperCase();
    const d = await api(`/news-impact${sym ? `?symbol=${sym}` : ''}`);
    $('#i-span').textContent = `${num(d.span.n, 0)} olay · ${num(d.span.symbols, 0)} hisse · ${fdate(d.span.f)} – ${fdate(d.span.t)}`;
    const L = Object.fromEntries(d.by_label.map((r) => [r.label, r]));
    $('#i-labels').innerHTML = ['positive', 'negative', 'neutral'].map((l) => {
      const r = L[l]; if (!r) return '';
      return `<div class="stat"><div class="l">${LABEL[l][0]} bildirim sonrası <span class="muted">· ${num(r.n, 0)}</span></div>
        <div class="v num ${dirCls(r.car_3d)}">${arrow(r.car_3d)} ${pct(Number(r.car_3d), 2)} <span class="small muted" style="font-weight:400">3 gün</span></div>
        <div class="d num">1g ${pct(Number(r.car_1d), 2)} · 5g ${pct(Number(r.car_5d), 2)} · endeksi geçen %${num(r.pos_share * 100, 0)}</div></div>`;
    }).join('');
    const types = {};
    d.by_type.forEach((r) => { (types[r.event_type] ||= {})[r.label] = r; });
    const names = Object.keys(types).filter((t) => types[t].positive || types[t].negative)
      .sort((a, b) => ((types[b].positive?.n || 0) + (types[b].negative?.n || 0)) - ((types[a].positive?.n || 0) + (types[a].negative?.n || 0))).slice(0, 13);
    $('#i-chart-wrap').style.height = `${Math.max(220, names.length * 34 + 60)}px`;
    chart('i-chart', { type: 'bar', data: { labels: names.map((t) => EVENT[t] || t), datasets: [
        { label: 'Olumlu', data: names.map((t) => (types[t].positive ? Number(types[t].positive.car_3d) * 100 : null)), backgroundColor: css('--up'), borderRadius: 4, barThickness: 10 },
        { label: 'Olumsuz', data: names.map((t) => (types[t].negative ? Number(types[t].negative.car_3d) * 100 : null)), backgroundColor: css('--down'), borderRadius: 4, barThickness: 10 }] },
      options: { indexAxis: 'y', maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 8, boxHeight: 8, color: '#a3a29d' } },
          tooltip: { ...tooltip, displayColors: true, callbacks: { label: (c) => { const r = types[names[c.dataIndex]][c.datasetIndex ? 'negative' : 'positive']; return `${c.dataset.label}: ${pct(c.parsed.x / 100, 2)} · ${num(r?.n, 0)} olay`; } } } },
        scales: { x: { grid: { color: (c) => (c.tick.value === 0 ? 'rgba(255,255,255,.25)' : 'rgba(255,255,255,.04)') }, ticks: { callback: (x) => `${x}%` } },
          y: { grid: { display: false }, ticks: { color: '#a3a29d' } } } } });
    const years = [...new Set(d.by_year.map((r) => r.y))];
    const Y = (l) => years.map((y) => { const r = d.by_year.find((x) => x.y === y && x.label === l); return r && r.n >= 20 ? Number(r.car_3d) * 100 : null; });
    chart('i-year', { type: 'line', data: { labels: years, datasets: [
        { label: 'Olumlu', data: Y('positive'), borderColor: css('--up'), backgroundColor: css('--up'), borderWidth: 2, pointRadius: 3, tension: .25 },
        { label: 'Olumsuz', data: Y('negative'), borderColor: css('--down'), backgroundColor: css('--down'), borderWidth: 2, pointRadius: 3, tension: .25 }] },
      options: { maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 8, boxHeight: 8, color: '#a3a29d' } }, tooltip: { ...tooltip, displayColors: true, callbacks: { label: (c) => `${c.dataset.label}: ${pct(c.parsed.y / 100, 2)}` } } },
        scales: { x: { grid: { display: false } }, y: { position: 'right', ticks: { callback: (x) => `${x}%` }, grid: { color: (c) => (c.tick.value === 0 ? 'rgba(255,255,255,.25)' : 'rgba(255,255,255,.04)') } } } } });
    const cell = (r) => (r ? `<td class="num ${dirCls(r.car_3d)}">${pct(Number(r.car_3d), 2)}</td><td class="num muted">${num(r.n, 0)}</td>` : '<td class="muted">–</td><td></td>');
    $('#i-table').innerHTML = `<table class="tbl"><thead><tr><th>Bildirim türü</th><th>Olumlu → 3g</th><th>n</th><th>Olumsuz → 3g</th><th>n</th><th>Nötr → 3g</th><th>n</th></tr></thead><tbody>
      ${Object.keys(types).sort((a, b) => (EVENT[a] || a).localeCompare(EVENT[b] || b, 'tr')).map((t) => `<tr><td>${esc(EVENT[t] || t)}</td>${cell(types[t].positive)}${cell(types[t].negative)}${cell(types[t].neutral)}</tr>`).join('')}</tbody></table>
      <p class="note" style="margin:10px 0 0">Tepki: bildirimin piyasaya yansıdığı ilk günden önceki kapanıştan itibaren, hissenin BIST 100'e göre getirisi. Ortalama değerler aykırı olaylardan etkilenebilir.</p>`;
  };
  $('#i-go').onclick = load;
  $('#i-sym').onkeydown = (e) => { if (e.key === 'Enter') load(); };
  load();
}

async function pageNewsFeed(v) {
  v.innerHTML = `<div class="page-head"><div><h1>KAP bildirimleri</h1><div class="sub">Gerçek zamanlı bildirimler ve Grok duygu analizi</div></div></div>
    <div class="toolbar"><div class="seg" id="n-label"><button data-l="" class="on">Tümü</button><button data-l="positive">Olumlu</button>
      <button data-l="negative">Olumsuz</button><button data-l="neutral">Nötr</button></div>
      <input class="field" id="n-sym" placeholder="Sembol" style="width:110px"><input class="field" id="n-q" placeholder="Metinde ara" style="flex:1;min-width:160px">
      <span class="muted small" id="n-total"></span></div>
    <div class="card"><div id="n-list">${skel(400)}</div><div style="text-align:center;margin-top:12px"><button class="btn" id="n-more">Daha fazla</button></div></div>`;
  let offset = 0, label = '';
  const load = async (reset) => {
    if (reset) { offset = 0; $('#n-list').innerHTML = skel(400); }
    const p = new URLSearchParams({ limit: 25, offset });
    if (label) p.set('label', label);
    if ($('#n-sym').value.trim()) p.set('symbol', $('#n-sym').value.trim());
    if ($('#n-q').value.trim()) p.set('q', $('#n-q').value.trim());
    try {
      const r = await api(`/disclosures?${p}`);
      const html = r.items.map((d) => newsItem(d)).join('');
      if (reset) $('#n-list').innerHTML = html || '<div class="empty">Sonuç yok</div>'; else $('#n-list').insertAdjacentHTML('beforeend', html);
      offset += r.items.length;
      $('#n-total').textContent = `${num(r.total, 0)} bildirim`;
      $('#n-more').style.display = offset < r.total ? '' : 'none';
    } catch (e) { $('#n-list').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  };
  $$('#n-label button').forEach((b) => b.onclick = () => { $$('#n-label button').forEach((x) => x.classList.toggle('on', x === b)); label = b.dataset.l; load(true); });
  let t; ['#n-sym', '#n-q'].forEach((s) => $(s).oninput = () => { clearTimeout(t); t = setTimeout(() => load(true), 350); });
  $('#n-more').onclick = () => load(false);
  load(true);
}

// ------------------------------------------------------------------ page: signals
async function pageSignals(v) {
  v.innerHTML = `<div class="page-head"><div><h1>Teknik sinyaller</h1><div class="sub">Son işlem gününde tespit edilen formasyonlar</div></div></div>
    <div class="toolbar"><div class="seg" id="s-dir"><button data-d="directional" class="on">Yön bildirenler</button><button data-d="bullish">▲ Yükseliş</button><button data-d="bearish">▼ Düşüş</button><button data-d="neutral">• Kararsız</button></div>
      <div class="seg" id="s-str"><button data-s="0">Hepsi</button><button data-s="0.5" class="on">Güçlü</button><button data-s="0.8">Çok güçlü</button></div>
      <input class="field" type="date" id="s-date"></div>
    <div class="grid g-hero" style="align-items:start"><div class="card"><div class="card-head"><h2>Sinyaller</h2><span class="hint" id="s-count"></span></div><div id="s-list">${skel(420)}</div></div>
      <div class="card sticky"><div class="card-head"><h2>Dağılım</h2><span class="hint">Formasyon türüne göre</span></div><div style="height:340px"><canvas id="s-chart"></canvas></div></div></div>`;
  let dir = 'directional', str = '0.5', shown = 30;
  const load = async () => {
    const p = new URLSearchParams({ limit: 200, min_strength: str });
    if (dir && dir !== 'directional') p.set('direction', dir);
    if ($('#s-date').value) p.set('date', $('#s-date').value);
    const r = await api(`/patterns?${p}`);
    if (dir === 'directional') { r.items = r.items.filter((x) => x.direction !== 'neutral'); r.summary = r.summary.filter((x) => x.direction !== 'neutral'); }
    if (!$('#s-date').value && r.items[0]) $('#s-date').value = r.items[0].trade_date;
    $('#s-count').textContent = `${num(r.items.length, 0)} sinyal`;
    $('#s-list').innerHTML = r.items.length ? `<div class="rows">${r.items.slice(0, shown).map((x) => {
      const [name] = PATTERN[x.pattern] || [x.pattern]; const [dl, dc, da] = DIR[x.direction] || DIR.neutral;
      return `<a class="row" href="#/hisse/${esc(x.symbol)}"><span class="signal" style="padding:0;border:0"><span class="ic ${dc}">${da}</span></span>
        <span class="sym">${esc(x.symbol)}</span><span style="flex:1;min-width:0">${esc(name)}<div class="muted small">${esc(patternDetail(x))}</div></span>
        <span class="px num">${num(x.close)}</span>${chg(x.pct_change)}</a>`;
    }).join('')}</div>${r.items.length > shown ? '<div style="text-align:center;margin-top:12px"><button class="btn" id="s-more">Daha fazla göster</button></div>' : ''}`
      : '<div class="empty">Bu filtrede sinyal yok</div>';
    $('#s-more').onclick = () => { shown += 30; load(); };
    const agg = {};
    r.summary.forEach((s) => { const k = (PATTERN[s.pattern] || [s.pattern])[0]; agg[k] = agg[k] || { bullish: 0, bearish: 0, neutral: 0 }; agg[k][s.direction] += Number(s.n); });
    const names = Object.keys(agg).sort((a, b) => (agg[b].bullish + agg[b].bearish + agg[b].neutral) - (agg[a].bullish + agg[a].bearish + agg[a].neutral));
    chart('s-chart', { type: 'bar',
      data: { labels: names, datasets: [['bullish', css('--up'), 'Yükseliş'], ['bearish', css('--down'), 'Düşüş'], ['neutral', css('--neutral'), 'Kararsız']].map(([k, c, l]) => ({
        label: l, data: names.map((n) => agg[n][k]), backgroundColor: c, borderRadius: 4, borderSkipped: false, barThickness: 12 })) },
      options: { indexAxis: 'y', maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 8, boxHeight: 8, color: '#a3a29d' } }, tooltip },
        scales: { x: { stacked: true, grid: { color: 'rgba(255,255,255,.04)' } }, y: { stacked: true, grid: { display: false }, ticks: { color: '#a3a29d' } } } } });
  };
  $$('#s-dir button').forEach((b) => b.onclick = () => { $$('#s-dir button').forEach((x) => x.classList.toggle('on', x === b)); dir = b.dataset.d; shown = 30; load(); });
  $$('#s-str button').forEach((b) => b.onclick = () => { $$('#s-str button').forEach((x) => x.classList.toggle('on', x === b)); str = b.dataset.s; load(); });
  $('#s-date').onchange = load;
  load();
}

// ------------------------------------------------------------------ page: live analysis
function pageAnalyze(v) {
  v.innerHTML = `<div class="page-head"><div><h1>Canlı analiz</h1><div class="sub">Bir KAP bildirimini veya haberi yapıştır, yapay zekâ hisseye etkisini değerlendirsin.</div></div></div>
    <div class="grid g-hero"><div class="card">
      <textarea class="field" id="a-text">Şirketimiz ile yurt dışında yerleşik bir müşteri arasında 85 milyon USD tutarında, 3 yıl süreli tedarik sözleşmesi imzalanmıştır.</textarea>
      <div class="toolbar" style="margin:12px 0 0"><input class="field" id="a-sym" placeholder="Sembol (isteğe bağlı)" style="width:180px">
        <button class="btn primary" id="a-go">Analiz et</button></div></div>
      <div class="card" id="a-out"><div class="empty">Sonuç burada görünecek.</div></div></div>`;
  $('#a-go').onclick = async () => {
    const out = $('#a-out'), b = $('#a-go'); b.disabled = true;
    out.innerHTML = '<div class="empty"><span class="spinner"></span> Analiz ediliyor…</div>';
    try {
      const r = await api('/analyze', { method: 'POST', body: JSON.stringify({ text: $('#a-text').value, symbol: $('#a-sym').value }) });
      out.innerHTML = `<div class="card-head"><h2>Sonuç</h2><span class="hint">${r.provider === 'lexicon' ? 'Sözlük' : 'Grok'} · ${num(r.latency_ms / 1000, 1)} sn</span></div>
        <div class="big-label ${r.score > 0.2 ? 'up' : r.score < -0.2 ? 'down' : 'flat'}" style="margin-bottom:10px">${(LABEL[r.label] || ['–'])[0]}</div>
        ${meter(r.score)}
        <dl class="kv" style="margin-top:16px"><dt>Olay tipi</dt><dd>${esc(EVENT[r.event_type] || 'Diğer')}</dd>
          <dt>Güven</dt><dd>%${num(r.confidence * 100, 0)}</dd></dl>
        ${(r.key_points || []).length ? `<div class="note" style="margin:14px 0 6px">Öne çıkanlar</div><div class="chips">${r.key_points.map((k) => `<span class="pill">${esc(k)}</span>`).join('')}</div>` : ''}
        ${r.rationale && r.provider !== 'lexicon' ? `<p class="callout" style="margin:14px 0 0">${esc(r.rationale)}</p>` : ''}
        ${r.warning ? `<p class="note down" style="margin-top:10px">Yapay zekâya ulaşılamadı, sözlük kullanıldı.</p>` : ''}`;
    } catch (e) { out.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
    b.disabled = false;
  };
}

// ------------------------------------------------------------------ page: system
async function pageSystem(v) {
  v.innerHTML = `<div class="page-head"><div><h1>Sistem</h1><div class="sub">Veri akışı, veri kalitesi ve model başarımı</div></div></div>
    <div class="grid g-2"><div class="card"><div class="card-head"><h2>Model başarımı</h2><span class="hint">MLflow</span></div><div id="y-eval">${skel(200)}</div></div>
      <div class="card"><div class="card-head"><h2>Son veri güncellemeleri</h2></div><div id="y-runs">${skel(200)}</div></div></div>
    <div class="card" style="margin-top:16px"><div class="card-head"><h2>Veri kalitesi kontrolleri</h2><span class="hint">Hatalı veri yüklenmeden durdurulur</span></div><div id="y-dq">${skel(240)}</div></div>`;
  const r = await api('/pipeline');
  const e = r.evaluation;
  if (e) {
    const m = e.metrics, cls = m.classifier || {}, es = m.event_study || {}, rm = m.reaction_model;
    const best = Object.entries(cls).filter(([k]) => k !== 'lexicon').sort((a, b) => b[1].accuracy - a[1].accuracy)[0];
    $('#y-eval').innerHTML = `<div class="rows">
      ${best ? `<div class="row" style="cursor:default"><span style="flex:1">Bildirim duygu doğruluğu<div class="muted small">${esc(best[1].model)} · 80 etiketli örnek</div></span>
        <b class="num">%${num(best[1].accuracy * 100, 1)}</b></div>` : ''}
      ${cls.lexicon ? `<div class="row" style="cursor:default"><span style="flex:1">Sözlük (karşılaştırma)<div class="muted small">Yapay zekâsız temel yöntem</div></span><b class="num muted">%${num(cls.lexicon.accuracy * 100, 1)}</b></div>` : ''}
      ${es.car3d_mean_negative !== undefined ? `<div class="row" style="cursor:default"><span style="flex:1">Olumsuz haber sonrası 3 gün<div class="muted small">Endekse göre ortalama · ${num(es.n_events, 0)} olay</div></span>
        <b class="num ${dirCls(es.car3d_mean_negative)}">${pct(es.car3d_mean_negative, 1)}</b></div>
      <div class="row" style="cursor:default"><span style="flex:1">Olumlu haber sonrası 3 gün</span><b class="num ${dirCls(es.car3d_mean_positive)}">${pct(es.car3d_mean_positive, 1)}</b></div>
      <div class="row" style="cursor:default"><span style="flex:1">Fark istatistiksel olarak anlamlı mı?<div class="muted small">Welch t = ${num(es.car3d_welch_t, 1)}</div></span>
        <b>${Math.abs(es.car3d_welch_t) >= 2 ? '<span class="up">Evet</span>' : '<span class="muted">Hayır</span>'}</b></div>` : ''}
      ${rm ? `<div class="row" style="cursor:default"><span style="flex:1">Haber tepki modeli<div class="muted small">AUC ${num(rm.test_auc, 2)} · 0,5 = yazı-tura</div></span>
        <b>${rm.test_auc >= 0.55 ? '<span class="up">Kullanılabilir</span>' : '<span class="muted">Henüz güvenilir değil</span>'}</b></div>` : ''}
      </div><p class="note" style="margin:10px 0 0">Son değerlendirme: ${fdate(e.created_at, true)}</p>`;
  } else $('#y-eval').innerHTML = '<div class="empty">Henüz değerlendirme yok</div>';

  $('#y-runs').innerHTML = r.runs.length ? `<div class="rows">${r.runs.slice(0, 8).map((x) => {
    const parts = Object.entries(x.stats || {}).filter(([, n]) => n).map(([k, n]) => `${num(n, 0)} ${STAT[k] || k}`);
    return `<div class="row" style="cursor:default;align-items:flex-start"><span class="ci ${x.status === 'success' ? 'ok' : 'fail'}">${x.status === 'success' ? '✓' : '✕'}</span>
      <span style="flex:1;min-width:0">${esc(TASK[x.task] || x.task)} <span class="muted small">· ${fdate(x.window_start)} – ${fdate(x.window_end)}</span>
      <div class="muted small">${parts.join(' · ') || 'değişiklik yok'}</div></span><span class="muted small">${fdate(x.finished_at, true)}</span></div>`;
  }).join('')}</div>` : '<div class="empty">Henüz çalıştırma yok</div>';

  const latest = {};
  r.data_quality.forEach((d) => { if (!latest[d.dataset]) latest[d.dataset] = d; });
  $('#y-dq').innerHTML = Object.values(latest).length ? `<div class="grid g-2">${Object.values(latest).map((d) => `<div>
      <div style="display:flex;justify-content:space-between;margin-bottom:6px"><b>${d.dataset === 'market' ? 'Piyasa verisi' : 'KAP bildirimleri'}</b>
      <span class="muted small">${fdate(d.window_start)} – ${fdate(d.window_end)} · ${num(d.rows_checked, 0)} kayıt</span></div>
      ${d.checks.map((c) => {
        const [name, desc] = CHECK[c.name] || [c.name, ''];
        const st = c.passed ? 'ok' : c.severity === 'error' ? 'fail' : 'warn';
        const val = typeof c.value === 'number' && c.value > 0 && c.value < 1 ? `%${num(c.value * 100, 2)}` : num(c.value, 0);
        return `<div class="check"><span class="ci ${st}">${st === 'ok' ? '✓' : st === 'warn' ? '!' : '✕'}</span>
          <span style="flex:1">${esc(name)}${desc ? `<div class="muted small">${esc(desc)}</div>` : ''}</span><span class="muted small num">${c.passed && !c.value ? '' : val}</span></div>`;
      }).join('')}</div>`).join('')}</div>` : '<div class="empty">Henüz kalite raporu yok</div>';
}

// ------------------------------------------------------------------ search
let SYMBOLS = [];
async function initSearch() {
  try { SYMBOLS = await api('/symbols'); } catch { SYMBOLS = []; }
  const input = $('#search'), box = $('#search-results');
  let hl = 0, hits = [];
  const render = () => {
    box.innerHTML = hits.map((s, i) => `<a href="#/hisse/${esc(s.symbol)}" class="${i === hl ? 'hl' : ''}"><span><b>${esc(s.symbol)}</b>
      <span class="muted small"> ${esc(cleanTitle(s.title))}</span></span><span class="num ${dirCls(s.pct_change)}">${num(s.close)}</span></a>`).join('');
    box.classList.toggle('open', hits.length > 0);
  };
  input.oninput = () => {
    const q = input.value.trim().toUpperCase(); hl = 0;
    hits = q ? SYMBOLS.filter((s) => s.symbol.startsWith(q) || (s.title || '').toUpperCase().includes(q)).slice(0, 8) : [];
    render();
  };
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { hl = Math.min(hl + 1, hits.length - 1); render(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { hl = Math.max(hl - 1, 0); render(); e.preventDefault(); }
    if (e.key === 'Enter') { const s = hits[hl]?.symbol || input.value.trim().toUpperCase(); if (s) { location.hash = `#/hisse/${s}`; input.value = ''; hits = []; render(); input.blur(); } }
    if (e.key === 'Escape') { hits = []; render(); input.blur(); }
  };
  document.addEventListener('click', (e) => { if (!e.target.closest('.search')) { hits = []; render(); } });
  box.onclick = () => { input.value = ''; hits = []; render(); };
}

// ------------------------------------------------------------------ router
const ROUTES = { piyasa: pageMarket, hisse: pageStock, cift: (v, a) => pagePair(v, a, location.hash.split('/')[3]), bildirimler: (v, a) => pageNews(v, a), sinyaller: pageSignals, analiz: pageAnalyze, sistem: pageSystem };
async function route() {
  const [, name = 'piyasa', arg] = location.hash.split('/');
  const page = ROUTES[name] || pageMarket;
  $$('.sidebar nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === (ROUTES[name] ? name : 'piyasa')));
  if (lw && name !== 'hisse') { lw.remove(); lw = null; }
  if (name !== 'hisse') { window.__stock = null; window.__chartRefs = null; }
  const v = $('#view');
  v.classList.remove('enter'); void v.offsetWidth; v.classList.add('enter');
  window.scrollTo({ top: 0 });
  try { await page(v, arg); } catch (e) { console.error(e); v.innerHTML = `<div class="empty">Bir hata oluştu: ${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', route);

(async function boot() {
  try {
    const h = await api('/health');
    $('#llm-status').innerHTML = `<span class="dot"></span>Sistem çalışıyor<br><b>${h.llm_provider === 'xai' ? 'Grok' : h.llm_provider === 'anthropic' ? 'Claude' : 'Sözlük'}</b> ${h.llm_provider !== 'lexicon' ? esc(h.llm) : ''}`;
  } catch { $('#llm-status').textContent = 'API erişilemiyor'; }
  initSearch();
  route();
})();
