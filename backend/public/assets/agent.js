// Grok agent panel: streams the server-side tool loop and applies chart actions.
'use strict';
(function () {
  const $a = (s) => document.querySelector(s);
  const KEY = 'finsent.agent.history.v1';
  const TOOL = {
    get_price_history: 'Fiyat geçmişi', get_technical_indicators: 'İndikatörler', find_support_resistance: 'Destek / direnç',
    get_patterns: 'Formasyonlar', get_kap_disclosures: 'KAP bildirimleri', news_impact_study: 'Haber etki analizi',
    get_forecast: 'Model tahmini', get_social_sentiment: 'X duygusu', compare_stocks: 'Hisse karşılaştırma',
    screen_stocks: 'Hisse taraması', backtest_strategy: 'Strateji testi', market_overview: 'Piyasa özeti', chart_actions: 'Grafiğe çizim', get_user_drawings: 'Çizimlerin okunuyor', create_alert: 'Alarm kuruluyor', list_alerts: 'Alarmlar', delete_alert: 'Alarm siliniyor',
  };
  const SUGGEST = {
    hisse: (s) => [`${s} için destek ve direnç seviyelerini bul, grafiğe çiz`, `${s}'da RSI ve MACD ne söylüyor? Trend güçlü mü?`,
      `${s}'ın son KAP haberleri fiyatı nasıl etkiledi?`, `${s}'da 50/200 SMA kesişim stratejisi son 5 yılda al-tut'u yener miydi?`,
      `${s}'ı 4 saatlik ve dolar bazında göster, ne görüyorsun?`],
    default: () => ['Bugün piyasada ne oldu? Öne çıkan hisseler hangileri?', 'RSI 35 altında ama 200 günlük ortalamanın üzerinde olan likit hisseleri bul',
      'Olumsuz KAP haberlerinden sonra hisseler ortalama ne kadar düşüyor?', 'PGSUS ile THYAO ne kadar birlikte hareket ediyor?'],
  };
  let history = [];
  let busy = false;
  let snap = false;
  try { history = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { history = []; }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(history.slice(-30))); } catch { /* private mode */ } };

  // ---------------------------------------------------------------- context
  function context() {
    const [, page = 'piyasa', a, b] = location.hash.split('/');
    const ctx = { page };
    if (page === 'hisse' && a) {
      Object.assign(ctx, { symbol: a.toUpperCase() }, window.__stock?.st || {});
      const dr = window.__draw?.summary?.() || [];
      if (dr.length) ctx.drawings = dr;
    }
    if (page === 'cift') ctx.pair = [a, b];
    return ctx;
  }
  function renderCtx() {
    const c = context();
    const parts = [c.drawings?.length ? `${c.drawings.length} çizim` : null, c.symbol, c.interval && { '15m': '15dk', '1h': '1S', '4h': '4S', '1d': 'Günlük', '1w': 'Haftalık', '1mo': 'Aylık' }[c.interval],
      c.currency === 'USD' ? 'USD' : c.symbol ? 'TL' : null, c.pair && c.pair.join(' / ')].filter(Boolean);
    $a('#agent-ctx').textContent = parts.length ? `Bağlam: ${parts.join(' · ')}` : 'Bağlam: piyasa geneli';
  }

  // ---------------------------------------------------------------- tiny markdown
  function md(src) {
    const e = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const inline = (s) => e(s)
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>').replace(/`([^`]+)`/g, '<code>$1</code>');
    const lines = src.replace(/\r/g, '').split('\n');
    let html = '', list = null, table = [];
    const flushList = () => { if (list) { html += `</${list}>`; list = null; } };
    const flushTable = () => {
      if (!table.length) return;
      const rows = table.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r)).map((r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim())));
      html += `<table><thead><tr>${rows[0].map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.slice(1).map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      table = [];
    };
    for (const raw of lines) {
      const l = raw.trimEnd();
      if (/^\s*\|.*\|\s*$/.test(l)) { flushList(); table.push(l); continue; }
      flushTable();
      let m;
      if ((m = l.match(/^\s*[-*•]\s+(.*)/))) { if (list !== 'ul') { flushList(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[1])}</li>`; continue; }
      if ((m = l.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { flushList(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(m[1])}</li>`; continue; }
      flushList();
      if ((m = l.match(/^#{1,4}\s+(.*)/))) { html += `<h4>${inline(m[1])}</h4>`; continue; }
      if (l.trim()) html += `<p>${inline(l)}</p>`;
    }
    flushList(); flushTable();
    return html;
  }

  // ---------------------------------------------------------------- rendering
  const body = () => $a('#agent-body');
  function scroll() { body().scrollTop = body().scrollHeight; }
  function renderHistory() {
    body().innerHTML = '';
    if (!history.length) {
      const c = context();
      const list = c.page === 'hisse' && c.symbol ? SUGGEST.hisse(c.symbol) : SUGGEST.default();
      body().innerHTML = `<div class="msg bot"><p>Merhaba! Grafik, indikatörler, KAP haberleri, model tahmini ve geçmiş verilerle strateji testleri hakkında soru sorabilirsin.
        Gerekirse grafiğe seviye çizerim, web ve X'te güncel haber ararım.</p></div>
        <div class="suggest">${list.map((q) => `<button type="button">${q}</button>`).join('')}</div>`;
      body().querySelectorAll('.suggest button').forEach((btn) => btn.onclick = () => send(btn.textContent));
      return;
    }
    for (const h of history) {
      const d = document.createElement('div');
      d.className = `msg ${h.role === 'user' ? 'user' : 'bot'}`;
      if (h.role === 'user') d.textContent = h.content; else d.innerHTML = md(h.content) + (h.meta ? `<div class="meta-line">${h.meta}</div>` : '');
      body().appendChild(d);
    }
    scroll();
  }

  // ---------------------------------------------------------------- chart actions
  window.__pendingChart = window.__pendingChart || [];
  function applyChart(symbol, actions) {
    const cur = context();
    if (symbol && (cur.page !== 'hisse' || (cur.symbol || '').toUpperCase() !== symbol.toUpperCase())) {
      window.__pendingChart.push(...actions);
      location.hash = `#/hisse/${symbol.toUpperCase()}`;
      return;
    }
    if (window.__stock?.apply) window.__stock.apply(actions);
    else window.__pendingChart.push(...actions);
  }

  // ---------------------------------------------------------------- send
  async function send(text) {
    text = (text || '').trim();
    if (!text || busy) return;
    busy = true;
    $a('#agent-send').disabled = true;
    if (!history.length) body().innerHTML = '';
    history.push({ role: 'user', content: text });
    const u = document.createElement('div'); u.className = 'msg user'; u.textContent = text; body().appendChild(u);
    const bot = document.createElement('div'); bot.className = 'msg bot';
    bot.innerHTML = '<div class="steps"></div><div class="answer"><span class="typing"><i></i><i></i><i></i></span></div>';
    body().appendChild(bot); scroll();
    const steps = bot.querySelector('.steps'), answer = bot.querySelector('.answer');
    const stepEls = {};
    const t0 = performance.now();
    try {
      let image = null;
      if (snap && typeof lw !== 'undefined' && lw) {
        try { const shot = lw.takeScreenshot(); image = (window.__draw?.composite(shot) || shot).toDataURL('image/png'); } catch { image = null; }
        snap = false; $a('#agent-snap').classList.remove('on');
      }
      const res = await fetch('/api/agent', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, context: context(), history: history.slice(0, -1).slice(-10), image }) });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || res.statusText);
      }
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = '', done = false;
      while (!done) {
        const r = await reader.read();
        if (r.done) break;
        buf += dec.decode(r.value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line);
          if (ev.type === 'tool') {
            const label = ev.label || TOOL[ev.name] || ev.name;
            const arg = ev.args ? [ev.args.symbol, ev.args.a && `${ev.args.a}/${ev.args.b}`, ev.args.interval, ev.args.strategy].filter(Boolean).join(' · ') : '';
            const el = document.createElement('div'); el.className = 'step';
            el.innerHTML = `<span class="s-ic"><span class="spinner" style="width:10px;height:10px;border-width:1.5px"></span></span><span>${label}</span><span class="s-arg">${arg}</span>`;
            steps.appendChild(el); stepEls[ev.name] = el; scroll();
            if (ev.server) setTimeout(() => { el.classList.add('done'); el.querySelector('.s-ic').textContent = '✓'; }, 400);
          } else if (ev.type === 'tool_done') {
            if (ev.name === 'create_alert' || ev.name === 'delete_alert') window.dispatchEvent(new Event('finsent:alerts'));
            const el = stepEls[ev.name];
            if (el) { el.classList.add(ev.ok ? 'done' : 'fail'); el.querySelector('.s-ic').textContent = ev.ok ? '✓' : '!'; }
          } else if (ev.type === 'chart') {
            applyChart(ev.symbol, ev.actions || []);
          } else if (ev.type === 'answer') {
            const secs = ((performance.now() - t0) / 1000).toFixed(0);
            const meta = `${ev.usage?.tool_calls || 0} araç · ${secs} sn · ${ev.model || 'Grok'}`;
            answer.innerHTML = md(ev.text) + (ev.citations?.length ? `<div class="cites">${ev.citations.slice(0, 6).map((c) => {
              let host = c.url; try { host = new URL(c.url).hostname.replace('www.', ''); } catch { /* keep url */ }
              return `<a href="${c.url}" target="_blank" rel="noopener" title="${c.title || ''}">${host}</a>`; }).join('')}</div>` : '')
              + `<div class="meta-line">${meta}</div>`;
            history.push({ role: 'assistant', content: ev.text, meta }); save();
            done = true;
          } else if (ev.type === 'error') {
            throw new Error(ev.text);
          }
        }
      }
      if (!done) throw new Error('Bağlantı yanıt gelmeden kapandı.');
    } catch (e) {
      answer.innerHTML = `<div class="msg err">${String(e.message || e).replace(/</g, '&lt;')}</div>`;
      history.pop(); save();
    }
    busy = false;
    $a('#agent-send').disabled = false;
    scroll();
  }

  // ---------------------------------------------------------------- wiring
  function toggle(open) {
    document.body.classList.toggle('agent-open', open ?? !document.body.classList.contains('agent-open'));
    if (document.body.classList.contains('agent-open')) { renderCtx(); renderHistory(); setTimeout(() => $a('#agent-text').focus(), 300); }
    try { localStorage.setItem('finsent.agent.open', document.body.classList.contains('agent-open') ? '1' : '0'); } catch { /* ignore */ }
    window.dispatchEvent(new Event('resize'));
  }
  $a('#agent-toggle').onclick = () => toggle();
  $a('#agent-close').onclick = () => toggle(false);
  $a('#agent-new').onclick = () => { history = []; save(); renderHistory(); };
  $a('#agent-snap').onclick = () => {
    if (typeof lw === 'undefined' || !lw) { toast('Grafik görüntüsü için bir hisse sayfası açık olmalı'); return; }
    snap = !snap; $a('#agent-snap').classList.toggle('on', snap);
    toast(snap ? 'Grafik görüntüsü bir sonraki mesaja eklenecek' : 'Grafik görüntüsü kaldırıldı');
  };
  const ta = $a('#agent-text');
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(140, ta.scrollHeight)}px`; });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $a('#agent-form').requestSubmit(); } });
  $a('#agent-form').onsubmit = (e) => { e.preventDefault(); const t = ta.value; ta.value = ''; ta.style.height = 'auto'; send(t); };
  document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); toggle(); } });
  window.addEventListener('hashchange', () => { if (document.body.classList.contains('agent-open')) { renderCtx(); if (!history.length) renderHistory(); } });
  window.addEventListener('finsent:chart', renderCtx);
  try { if (localStorage.getItem('finsent.agent.open') === '1') toggle(true); } catch { /* ignore */ }

  // ---------------------------------------------------------------- alerts
  const KIND_ICON = { price_above: '▲', price_below: '▼', rsi_above: 'RSI ▲', rsi_below: 'RSI ▼', change_above: '% ▲', change_below: '% ▼' };
  async function refreshAlerts() {
    let r;
    try { r = await fetch('/api/alerts').then((x) => x.json()); } catch { return; }
    const n = $a('#bell-n');
    n.textContent = r.unseen || ''; n.classList.toggle('on', r.unseen > 0);
    const menu = $a('#bell-menu');
    menu.innerHTML = r.alerts.length ? r.alerts.map((a) => `<div class="al ${a.triggered_at ? 'fired' : ''}"><span class="ai"></span>
        <div><div><a href="#/hisse/${a.symbol}"><b>${a.symbol}</b></a> ${KIND_ICON[a.kind] || ''} ${a.text.replace(a.symbol + ' ', '')}</div>
        <div class="muted small">${a.triggered_at ? `Tetiklendi: ${a.triggered_at.slice(0, 16)} · değer ${a.triggered_value}` : 'Bekliyor'}${a.note ? ` · ${a.note}` : ''}</div></div>
        <button class="x" data-id="${a.id}" title="Sil">✕</button></div>`).join('')
      : `<div class="empty">Alarm yok. Asistana "THYAO 310 TL'yi geçerse haber ver" diyebilirsin.</div>`;
    menu.querySelectorAll('.x').forEach((b) => b.onclick = async (e) => { e.stopPropagation(); await fetch(`/api/alerts/${b.dataset.id}/delete`, { method: 'POST' }); refreshAlerts(); });
  }
  async function checkAlerts() {
    try {
      const r = await fetch('/api/alerts/check', { method: 'POST' }).then((x) => x.json());
      for (const f of r.fired || []) {
        toast(`🔔 ${f.text} — şu an ${f.current}`);
        try { if (window.Notification && Notification.permission === 'granted') new Notification('FinSent alarmı', { body: `${f.text} (şu an ${f.current})${f.note ? ' · ' + f.note : ''}` }); } catch { /* ignore */ }
      }
      if ((r.fired || []).length) refreshAlerts();
    } catch { /* offline */ }
  }
  $a('#bell').onclick = async (e) => {
    e.stopPropagation();
    const m = $a('#bell-menu'); m.classList.toggle('open');
    if (m.classList.contains('open')) {
      await refreshAlerts();
      fetch('/api/alerts/seen', { method: 'POST' }).then(() => { $a('#bell-n').classList.remove('on'); });
      try { if (window.Notification && Notification.permission === 'default') Notification.requestPermission(); } catch { /* ignore */ }
    }
  };
  document.addEventListener('click', (e) => { if (!e.target.closest('.bell-wrap')) $a('#bell-menu').classList.remove('open'); });
  window.addEventListener('finsent:alerts', refreshAlerts);
  refreshAlerts(); checkAlerts(); setInterval(checkAlerts, 60000);
})();
