// FinSent virtual portfolio ("Sanal portföy"): trade with virtual TL at the latest price and
// follow the result over time against BIST 100. Also receives "today's signals" from the lab.
'use strict';

(function () {
  const LS_ACC = 'finsent.paper.account';
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
  const tl = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : `${num(v, Math.abs(v) >= 1000 ? 0 : 2)} ₺`);
  const symsList = () => (typeof SYMBOLS !== 'undefined' && Array.isArray(SYMBOLS) ? SYMBOLS : []);

  window.paperApi = {
    async accounts() { return (await api('/paper')).accounts; },
    async ensureAccount() {
      const list = await this.accounts();
      if (list.length) return list.find((a) => String(a.id) === lsGet(LS_ACC)) || list[0];
      const { id } = await api('/paper', { method: 'POST', body: JSON.stringify({ name: 'Sanal portföy', initial_cash: 100000 }) });
      return { id, name: 'Sanal portföy' };
    },
    order(id, o) { return api(`/paper/${id}/order`, { method: 'POST', body: JSON.stringify(o) }); },
  };

  window.pagePaper = async function pagePaper(v, arg) {
    v.innerHTML = `<div class="page-head"><div><h1>Sanal portföy</h1><div class="sub">Sanal parayla al-sat, gerçek fiyatlarla takip et. Gerçek para yok, risk yok.</div></div>
      <div class="toolbar" style="margin:0"><select class="field" id="pp-acc"></select>
        <button class="btn" id="pp-new"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Yeni portföy</button></div></div>
      <div id="pp-body">${skel(300)}</div>`;
    let accounts = await window.paperApi.accounts();
    if (!accounts.length) {
      await api('/paper', { method: 'POST', body: JSON.stringify({ name: 'Sanal portföy', initial_cash: 100000 }) });
      accounts = await window.paperApi.accounts();
    }
    const want = arg || lsGet(LS_ACC);
    let cur = accounts.find((a) => String(a.id) === String(want)) || accounts[0];
    const sel = $('#pp-acc');
    sel.innerHTML = accounts.map((a) => `<option value="${a.id}" ${a.id === cur.id ? 'selected' : ''}>${esc(a.name)} · ${pct(a.return, 1)}</option>`).join('');
    sel.onchange = () => { location.hash = `#/portfoy/${sel.value}`; };
    $('#pp-new').onclick = async () => {
      const name = prompt('Portföy adı?', 'Sanal portföy ' + (accounts.length + 1));
      if (!name) return;
      const cash = Number(prompt('Başlangıç sanal bakiyesi (₺)?', '100000'));
      if (!(cash >= 1000)) { toast('En az 1.000 ₺'); return; }
      const { id } = await api('/paper', { method: 'POST', body: JSON.stringify({ name, initial_cash: cash }) });
      location.hash = `#/portfoy/${id}`;
    };
    lsSet(LS_ACC, String(cur.id));
    await render(cur.id);
  };

  // "Stratejiyi takip et": link a saved strategy and apply its signals for the latest day
  async function renderFollow(a) {
    const box = $('#pp-follow');
    let list = [];
    try { list = (await api('/strategies')).strategies; } catch { list = []; }
    const linked = list.find((x) => x.id === a.strategy_id);
    box.innerHTML = `<div class="card-head"><h2>Stratejiyi takip et</h2><span class="hint">bağlı strateji her gün son kapanışa göre sinyal üretir</span></div>
      <div class="toolbar" style="margin:0 0 10px"><select class="field" id="pp-strat"><option value="">(strateji bağlı değil)</option>
        ${list.map((x) => `<option value="${x.id}" ${x.id === a.strategy_id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
        ${list.length ? '' : '<span class="muted small">Önce Strateji Laboratuvarı\'nda bir strateji kaydet.</span>'}</div>
      <div id="pp-sig">${linked ? '<div class="empty"><span class="spinner"></span> Sinyaller hesaplanıyor…</div>' : '<div class="muted small">Bir strateji bağlarsan, bu sayfayı her açtığında o stratejinin bugünkü al/sat sinyallerini görür ve tek tıkla bu portföye uygularsın. Gerçek emir iletilmez.</div>'}</div>`;
    $('#pp-strat').onchange = async (e) => {
      await api(`/paper/${a.id}/link`, { method: 'POST', body: JSON.stringify({ strategy_id: e.target.value || null }) });
      a.strategy_id = e.target.value ? Number(e.target.value) : null;
      renderFollow(a);
    };
    if (!linked) return;
    if (!window.labSignalsFor) { $('#pp-sig').innerHTML = '<div class="muted small">Strateji motoru yüklenemedi.</div>'; return; }
    try {
      const r = await window.labSignalsFor(linked.id);
      // applied already = a trade of this strategy carries these signals' data day (set by the lab and the daily runner)
      const already = a.trades.some((t) => (t.note || '').startsWith(`${r.name}:`) && (t.note || '').includes(`[veri ${r.asOf}]`));
      const tag = (s) => (s.side === 'buy' ? ['AL', 'pos'] : s.side === 'sell' ? ['SAT', 'neg'] : ['HEDEF', 'acc']);
      $('#pp-sig').innerHTML = `<div class="muted small" style="margin-bottom:8px">${esc(r.name)} · son veri ${fdate(r.asOf)}${already ? ' · <span class="up">bu günün sinyalleri zaten uygulandı</span>' : ''}</div>
        ${r.signals.length ? `<div class="rows">${r.signals.map((s) => `<div class="row" style="cursor:default"><span class="pill ${tag(s)[1]}">${tag(s)[0]}</span><b>${esc(s.sym)}</b>
          <span class="muted small" style="flex:1">${esc(s.reason)}</span>${Number.isFinite(s.targetPercent) ? `<span class="num small">ağırlık %${num(s.targetPercent, 0)}</span>` : Number.isFinite(s.percent) ? `<span class="num small">%${num(s.percent, 0)}</span>` : ''}</div>`).join('')}</div>
          <div class="toolbar" style="margin:10px 0 0"><button class="btn sm primary" id="pp-apply" ${already ? 'disabled' : ''}>Sinyalleri uygula</button></div>`
          : '<div class="muted small">Bugün için yeni sinyal yok: strateji mevcut pozisyonları korur.</div>'}`;
      const btn = $('#pp-apply');
      if (btn) btn.onclick = async () => {
        btn.disabled = true;
        const res = await window.labApplySignals(a.id, r.signals, r.symbols.length, r.name, r.asOf);
        toast(`${res.done.length} emir uygulandı${res.failed.length ? `, ${res.failed.length} başarısız` : ''}`);
        render(a.id);
      };
    } catch (e) { $('#pp-sig').innerHTML = `<div class="down small">${esc(e.message)}</div>`; }
  }

  async function render(id) {
    const a = await api(`/paper/${id}`);
    const body = $('#pp-body');
    const bm = a.history.benchmark.filter((x) => x !== null);
    const bmRet = bm.length > 1 ? bm.at(-1) / bm[0] - 1 : null;
    body.innerHTML = `
      <div class="lab-kpis" style="grid-template-columns:repeat(5,minmax(0,1fr))">
        <div class="stat"><div class="l">Toplam değer</div><div class="v num">${tl(a.value)}</div><div class="d">Başlangıç ${tl(a.initial_cash)}</div></div>
        <div class="stat"><div class="l">Kâr / zarar</div><div class="v num ${dirCls(a.pnl)}">${tl(a.pnl)}</div><div class="d">${chg(a.return, 2)}</div></div>
        <div class="stat"><div class="l">BIST 100 (aynı dönem)</div><div class="v num">${pct(bmRet, 2)}</div><div class="d">${bmRet !== null ? (a.return > bmRet ? '<span class="up">Endeksin önünde</span>' : '<span class="down">Endeksin gerisinde</span>') : ''}</div></div>
        <div class="stat"><div class="l">Nakit</div><div class="v num">${tl(a.cash)}</div><div class="d">%${num(a.value > 0 ? (a.cash / a.value) * 100 : 0, 0)} nakitte</div></div>
        <div class="stat"><div class="l">Gerçekleşen K/Z</div><div class="v num ${dirCls(a.realised)}">${tl(a.realised)}</div><div class="d">${a.trade_count} işlem · ${tl(a.fees)} komisyon</div></div>
      </div>
      <div class="grid g-hero">
        <div class="card"><div class="card-head"><h2>Değer</h2><div class="chart-legend" style="position:static"><span><i class="line-key" style="background:${css('--accent')}"></i>Portföy</span><span><i class="line-key" style="background:#8a8984"></i>BIST 100</span></div></div>
          <div style="height:240px"><canvas id="pp-chart"></canvas></div>
          ${a.history.dates.length < 3 ? '<p class="muted small">Grafik birkaç işlem günü sonra anlamlı hale gelir. Değerleme günlük kapanışla yapılır.</p>' : ''}</div>
        <div class="card"><div class="card-head"><h2>Emir ver</h2><span class="hint">komisyon binde ${num(a.fee_bps, 1)}</span></div>
          <div class="pp-form">
            <div class="sym-input" style="min-height:38px"><input id="pp-sym" placeholder="Sembol (THYAO, ALTIN…)" autocomplete="off"><div class="search-results" id="pp-res"></div></div>
            <div class="seg" id="pp-side"><button data-v="buy" class="on">Al</button><button data-v="sell">Sat</button></div>
            <div class="seg" id="pp-mode"><button data-v="amount" class="on">Tutar (₺)</button><button data-v="shares">Adet</button></div>
            <input type="number" class="field" id="pp-qty" placeholder="10000" min="0">
            <div class="chips" id="pp-quick"></div>
            <div id="pp-preview" class="muted small"></div>
            <button class="btn primary" id="pp-go">Emri gönder</button>
          </div>
          <p class="muted small" style="margin:10px 0 0">Fiyat: piyasa açıkken Yahoo'nun ~15 dk gecikmeli fiyatı, değilse son kapanış. Gerçek emir iletilmez.</p></div>
      </div>
      <div class="card" style="margin-top:16px" id="pp-follow"></div>
      <div class="card" style="margin-top:16px"><div class="card-head"><h2>Pozisyonlar</h2><span class="hint">son kapanış fiyatıyla</span></div>
        ${a.positions.length ? `<div class="tbl-wrap"><table class="tbl"><tr><th>Sembol</th><th>Adet</th><th>Ort. maliyet</th><th>Fiyat</th><th>Gün</th><th>Değer</th><th>Ağırlık</th><th>K/Z</th><th></th></tr>
          ${a.positions.map((p) => `<tr><td><a href="#/hisse/${esc(p.symbol)}"><b>${esc(p.symbol)}</b></a></td><td class="num">${num(p.shares, 0)}</td><td class="num">${num(p.avg_price)}</td>
            <td class="num">${num(p.price)}</td><td>${p.day_change !== null ? chg(p.day_change, 1) : ''}</td><td class="num">${tl(p.value)}</td><td class="num">%${num(p.weight * 100, 0)}</td>
            <td class="num ${dirCls(p.pnl)}">${tl(p.pnl)} <span class="small">(${pct(p.pnl_pct, 1)})</span></td>
            <td><button class="linkbtn pp-sellall" data-s="${esc(p.symbol)}">Tümünü sat</button></td></tr>`).join('')}</table></div>` : '<div class="empty">Henüz pozisyon yok. Sağdaki formdan ilk alımını yap ya da Strateji Laboratuvarı\'ndaki sinyalleri buraya uygula.</div>'}</div>
      <div class="card" style="margin-top:16px"><div class="card-head"><h2>İşlem geçmişi</h2>
        <div class="toolbar" style="margin:0;gap:6px"><button class="btn sm" id="pp-reset">Sıfırla</button><button class="btn sm" id="pp-del">Portföyü sil</button></div></div>
        ${a.trades.length ? `<div class="tbl-wrap" style="max-height:420px;overflow:auto"><table class="tbl"><tr><th>Zaman</th><th>Sembol</th><th>Yön</th><th>Adet</th><th>Fiyat</th><th>Tutar</th><th>Komisyon</th><th>Fiyat kaynağı</th><th>Not</th></tr>
          ${a.trades.map((t) => `<tr><td>${fdate(t.traded_at, true)}</td><td><b>${esc(t.symbol)}</b></td><td><span class="pill ${t.side === 'buy' ? 'pos' : 'neg'}">${t.side === 'buy' ? 'AL' : 'SAT'}</span></td>
            <td class="num">${num(t.shares, 0)}</td><td class="num">${num(t.price)}</td><td class="num">${tl(t.shares * t.price)}</td><td class="num">${num(t.fee)}</td><td class="muted small">${esc(t.price_source)}</td><td class="muted small">${esc(t.note || '')}</td></tr>`).join('')}</table></div>` : '<div class="empty">İşlem yok.</div>'}</div>`;

    renderFollow(a);
    const h = a.history;
    chart('pp-chart', {
      type: 'line',
      data: { labels: h.dates, datasets: [
        { data: h.equity, borderColor: css('--accent'), borderWidth: 2, pointRadius: h.dates.length < 20 ? 2 : 0, fill: false, tension: 0 },
        { data: h.benchmark, borderColor: '#8a8984', borderWidth: 1.2, borderDash: [4, 3], pointRadius: 0, fill: false, tension: 0 }] },
      options: { maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false }, tooltip: { ...tooltip, callbacks: { title: (it) => fdate(it[0].label), label: (c) => `${c.datasetIndex ? 'BIST 100' : 'Portföy'}: ${tl(c.parsed.y)}` } } },
        scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 6, maxRotation: 0 } }, y: { position: 'right', grid: { color: 'rgba(255,255,255,.04)' }, ticks: { maxTicksLimit: 5, callback: (x) => tl(x) } } } },
    });

    // ---- order form
    let side = 'buy', mode = 'amount', sym = '';
    const input = $('#pp-sym'), res = $('#pp-res');
    const segSet = (id, val) => $$(`#${id} button`).forEach((b) => b.classList.toggle('on', b.dataset.v === val));
    const held = (s) => a.positions.find((p) => p.symbol === s);
    const quick = () => {
      const q = $('#pp-quick');
      if (side === 'buy') q.innerHTML = [0.1, 0.25, 0.5, 1].map((f) => `<button class="pill lab-ex" data-a="${Math.floor(a.cash * f * 0.998)}">%${f * 100} nakit</button>`).join('');
      else q.innerHTML = held(sym) ? [0.25, 0.5, 1].map((f) => `<button class="pill lab-ex" data-sh="${Math.floor(held(sym).shares * f)}">%${f * 100} pozisyon</button>`).join('') : '';
      $$('[data-a]', q).forEach((b) => (b.onclick = () => { mode = 'amount'; segSet('pp-mode', mode); $('#pp-qty').value = b.dataset.a; preview(); }));
      $$('[data-sh]', q).forEach((b) => (b.onclick = () => { mode = 'shares'; segSet('pp-mode', mode); $('#pp-qty').value = b.dataset.sh; preview(); }));
    };
    const payload = (prev) => {
      const q = Number($('#pp-qty').value);
      return { symbol: sym, side, preview: prev, ...(mode === 'amount' ? { amount: q } : { shares: q }) };
    };
    let pt;
    const preview = () => {
      clearTimeout(pt);
      const box = $('#pp-preview');
      if (!sym || !(Number($('#pp-qty').value) > 0)) { box.textContent = ''; return; }
      pt = setTimeout(async () => {
        try {
          const r = await window.paperApi.order(a.id, payload(true));
          box.innerHTML = `${r.side === 'buy' ? 'Alınacak' : 'Satılacak'}: <b>${num(r.shares, 0)} adet ${esc(r.symbol)}</b> × ${num(r.price)} (${esc(r.price_source)}) = <b>${tl(r.total)}</b> <span class="muted">komisyon dahil</span>`;
        } catch (e) { box.innerHTML = `<span class="down">${esc(e.message)}</span>`; }
      }, 250);
    };
    const pick = (s) => { sym = s; input.value = s; res.classList.remove('open'); quick(); preview(); };
    input.oninput = () => {
      const q = input.value.trim().toUpperCase();
      sym = q;
      const extra = [{ symbol: 'ALTIN', title: 'Gram altın' }, { symbol: 'USDTRY', title: 'Dolar/TL' }, { symbol: 'EURTRY', title: 'Euro/TL' }];
      const hits = q ? [...extra, ...symsList()].filter((s) => s.symbol.startsWith(q)).slice(0, 7) : [];
      res.innerHTML = hits.map((s) => `<a data-s="${esc(s.symbol)}"><span><b>${esc(s.symbol)}</b> <span class="muted small">${esc((s.title || '').slice(0, 34))}</span></span></a>`).join('');
      res.classList.toggle('open', hits.length > 0);
      $$('a', res).forEach((x) => (x.onmousedown = (e) => { e.preventDefault(); pick(x.dataset.s); }));
      quick(); preview();
    };
    input.onblur = () => setTimeout(() => res.classList.remove('open'), 120);
    $$('#pp-side button').forEach((b) => (b.onclick = () => { side = b.dataset.v; segSet('pp-side', side); quick(); preview(); }));
    $$('#pp-mode button').forEach((b) => (b.onclick = () => { mode = b.dataset.v; segSet('pp-mode', mode); $('#pp-qty').placeholder = mode === 'amount' ? '10000' : '100'; preview(); }));
    $('#pp-qty').oninput = preview;
    $('#pp-go').onclick = async () => {
      if (!sym) { input.focus(); return; }
      const btn = $('#pp-go'); btn.disabled = true;
      try {
        const r = await window.paperApi.order(a.id, payload(false));
        toast(`${r.side === 'buy' ? 'Alındı' : 'Satıldı'}: ${num(r.shares, 0)} ${r.symbol} × ${num(r.price)}`);
        await render(a.id);
      } catch (e) { toast(e.message); btn.disabled = false; }
    };
    quick();
    $$('.pp-sellall').forEach((b) => (b.onclick = async () => {
      if (!confirm(`${b.dataset.s} pozisyonunun tamamı satılsın mı?`)) return;
      try { await window.paperApi.order(a.id, { symbol: b.dataset.s, side: 'sell' }); await render(a.id); } catch (e) { toast(e.message); }
    }));
    $('#pp-reset').onclick = async () => { if (confirm('Tüm işlemler silinip başlangıç bakiyesine dönülsün mü?')) { await api(`/paper/${a.id}/reset`, { method: 'POST', body: '{}' }); render(a.id); } };
    $('#pp-del').onclick = async () => { if (confirm(`"${a.name}" silinsin mi?`)) { await api(`/paper/${a.id}/delete`, { method: 'POST', body: '{}' }); lsSet(LS_ACC, ''); location.hash = '#/portfoy'; window.pagePaper($('#view')); } };
  }
})();
