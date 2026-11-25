// FinSent strategy lab: describe a strategy, let Grok write the code, edit it, and backtest it
// on historical data with virtual money. Backtests run in a Web Worker (assets/strategy/worker.js).
/* global FinSentTemplates, FinSentNlp, CodeMirror, LightweightCharts, Chart */
'use strict';

(function () {
  const LS_KEY = 'finsent.lab.draft.v1';
  const TEMPLATES = window.FinSentTemplates || [];
  const allSyms = () => (typeof SYMBOLS !== 'undefined' && Array.isArray(SYMBOLS) ? SYMBOLS : []);
  const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
  // ASCII file names: some browsers drop a non-ASCII download name and save as "download"
  const TR = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', Ç: 'C', Ğ: 'G', İ: 'I', Ö: 'O', Ş: 'S', Ü: 'U' };
  const fileSlug = (s) => (String(s || 'strateji').replace(/[çğıöşüÇĞİÖŞÜ]/g, (c) => TR[c]).replace(/[^A-Za-z0-9-]+/g, '_').replace(/^_+|_+$/g, '') || 'strateji').slice(0, 80);

  // ------------------------------------------------------------------ worker
  // Two workers: 'main' for backtests / sweeps, 'inspect' for the quick compile check that runs
  // while the user types, so a timeout of one never kills the other.
  let seq = 0;
  const pools = {};
  function getPool(name) {
    if (pools[name]) return pools[name];
    const pool = { worker: new Worker('/assets/strategy/sandbox.js'), waiting: new Map() };
    pool.worker.onmessage = (ev) => {
      const { id, progress } = ev.data;
      const w = pool.waiting.get(id);
      if (!w) return;
      if (progress !== undefined) { w.onProgress?.(progress); return; }
      clearTimeout(w.timer);
      pool.waiting.delete(id);
      ev.data.ok ? w.resolve(ev.data.result) : w.reject(Object.assign(new Error(ev.data.error.message), ev.data.error));
    };
    pool.worker.onerror = (e) => { e.preventDefault(); killPool(name, new Error(e.message || 'Worker hatası')); };
    pools[name] = pool;
    return pool;
  }
  function killPool(name, err) {
    const pool = pools[name];
    if (!pool) return;
    pool.worker.terminate();
    delete pools[name];
    for (const w of pool.waiting.values()) { clearTimeout(w.timer); w.reject(err); }
  }
  function run(type, payload, { timeoutMs = 30000, onProgress } = {}) {
    const id = ++seq;
    const name = type === 'inspect' ? 'inspect' : 'main';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => killPool(name, Object.assign(new Error(`Strateji ${Math.round(timeoutMs / 1000)} saniyede bitmedi (sonsuz döngü olabilir), durduruldu.`), { phase: 'timeout' })), timeoutMs);
      getPool(name).waiting.set(id, { resolve, reject, timer, onProgress });
      pools[name].worker.postMessage({ id, type, payload });
    });
  }

  // ------------------------------------------------------------------ state
  const today = new Date().toISOString().slice(0, 10);
  const yearsAgo = (n) => { const d = new Date(); d.setFullYear(d.getFullYear() - n); return d.toISOString().slice(0, 10); };
  const defaultState = () => ({
    id: null, name: TEMPLATES[0]?.name || 'Yeni strateji', prompt: '', code: TEMPLATES[0]?.code || '',
    chat: [],
    config: { symbols: TEMPLATES[0]?.symbols || ['THYAO'], from: yearsAgo(5), to: today, initialCapital: 100000,
      commissionBps: 10, slippageBps: 5, fill: 'next_open', currency: 'TRY', benchmark: 'XU100', adjustCorporateActions: true, cashRatePct: 0, timeframe: '1d', params: {} },
  });
  let S = defaultState();
  let meta = null;          // inspected strategy {name, description, params}
  let lastResult = null;
  let lastData = null;
  let editor = null;
  let status = { llm: false };
  let priceChart = null;
  const dataCache = new Map();

  const saveDraft = () => lsSet(LS_KEY, { ...S, chat: S.chat.slice(-20) });
  const getCode = () => (editor ? editor.getValue() : $('#lab-code').value);
  const setCode = (c) => { S.code = c; if (editor) editor.setValue(c); else $('#lab-code').value = c; };
  const cur = () => (S.config.currency === 'USD' ? '$' : '₺');
  const fmtMoney = (v) => {
    if (v === null || v === undefined || !Number.isFinite(v)) return '–';
    const a = Math.abs(v), c = cur();
    if (a >= 1e9) return `${num(v / 1e9, 2)} mr ${c}`;
    if (a >= 1e6) return `${num(v / 1e6, 2)} mn ${c}`;
    return `${num(v, 0)} ${c}`;
  };
  const ratio = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : num(v, d));

  // ------------------------------------------------------------------ page
  window.pageLab = async function pageLab(v, arg) {
    const draft = lsGet(LS_KEY);
    S = draft && draft.code ? { ...defaultState(), ...draft, config: { ...defaultState().config, ...draft.config } } : defaultState();
    lastResult = null;
    v.innerHTML = `
      <div class="page-head"><div><h1>Strateji Laboratuvarı</h1>
        <div class="sub">Stratejini anlat, Grok koda döksün; geçmiş verilerle sanal parayla test et, parametrelerle oyna.</div></div>
        <div class="toolbar" style="margin:0">
          <button class="btn" id="lab-new" title="Boş sayfa"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Yeni</button>
          <a class="btn" href="#/stratejiler"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg>Kayıtlı stratejiler</a>
          <button class="btn primary" id="lab-save"><svg viewBox="0 0 24 24"><path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/></svg>Kaydet</button>
        </div></div>
      <div class="lab-top">
        <div class="card lab-chat-card">
          <div class="card-head"><h2><span class="stepn">1</span>Stratejini anlat</h2><span class="hint" id="lab-llm"></span></div>
          <div class="lab-chat" id="lab-chat"></div>
          <form class="lab-ask" id="lab-ask">
            <textarea class="field" id="lab-prompt" rows="3" placeholder="Örn: THYAO ve PGSUS'ta 20 günlük ortalama 50 günlüğü yukarı kesince al, aşağı kesince sat. %8 zarar kes."></textarea>
            <div class="lab-ask-row"><div class="chips" id="lab-examples"></div>
              <button class="btn primary" type="submit" id="lab-gen"><svg viewBox="0 0 24 24"><path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z"/></svg>Koda dök</button></div>
          </form>
          <div class="note" style="margin-top:12px">Hazır şablonlar</div>
          <div class="chips" id="lab-templates" style="margin-top:6px"></div>
        </div>
        <div class="card lab-code-card">
          <div class="card-head"><h2><span class="stepn">2</span>Kod</h2>
            <div class="toolbar" style="margin:0;gap:6px">
              <button class="btn sm" id="lab-check" title="Derle ve parametreleri oku">Kontrol et</button>
              <button class="btn sm" id="lab-fix" style="display:none" title="Hatayı Grok düzeltsin">Grok ile düzelt</button>
              <button class="btn sm" id="lab-copy" title="Kodu kopyala">Kopyala</button>
              <button class="btn sm" id="lab-export" title="Stratejiyi ayarlarıyla dosyaya kaydet">Dışa aktar</button>
              <label class="btn sm" title="Dışa aktarılmış .json veya .js dosyasını yükle">İçe aktar<input type="file" id="lab-import" accept=".json,.js,.txt,application/json,text/javascript" hidden></label>
              <button class="btn sm" id="lab-help-btn" title="Strateji API'si">API</button>
            </div></div>
          <div class="lab-strat-name"><input class="field" id="lab-name" placeholder="Strateji adı"><span class="muted small" id="lab-desc"></span></div>
          <div class="lab-editor"><textarea id="lab-code" spellcheck="false"></textarea></div>
          <div id="lab-err" class="lab-err" style="display:none"></div>
          <div id="lab-help" class="lab-help" style="display:none"></div>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-head"><h2><span class="stepn">3</span>Test ayarları</h2><span class="hint">Sanal para ile, işlem maliyetleri dahil</span></div>
        <div class="lab-settings">
          <div class="lab-field lab-wide"><label>Hisseler / varlıklar</label>
            <div class="sym-input" id="lab-syms"><input id="lab-sym-in" placeholder="Sembol ekle (THYAO, ALTIN, XU100…)" autocomplete="off"><div class="search-results" id="lab-sym-res"></div></div>
            <div class="toolbar" style="margin:6px 0 0;gap:6px"><button class="linkbtn" id="lab-liq10">En likit 10</button><button class="linkbtn" id="lab-liq20">En likit 20</button>
              <span class="muted small">(başlangıç tarihindeki işlem hacmine göre: bugünün kazananlarını seçme yanılgısı olmaz)</span><button class="linkbtn" id="lab-symclear">Temizle</button></div></div>
          <div class="lab-field"><label>Dönem</label>
            <div class="lab-dates"><input type="date" class="field" id="lab-from"><span class="muted">→</span><input type="date" class="field" id="lab-to"></div>
            <div class="seg" id="lab-range" style="margin-top:6px"><button data-y="1">1Y</button><button data-y="3">3Y</button><button data-y="5">5Y</button><button data-y="10">10Y</button><button data-y="20">20Y</button><button data-y="99">Tümü</button></div></div>
          <div class="lab-field"><label>Sanal sermaye</label><input type="number" class="field" id="lab-cap" min="1000" step="1000"></div>
          <div class="lab-field"><label>Komisyon (binde, tek yön)</label><input type="number" class="field" id="lab-comm" min="0" max="100" step="0.5"><span class="muted small" id="lab-comm-pct"></span></div>
          <div class="lab-field"><label>Kayma (binde)</label><input type="number" class="field" id="lab-slip" min="0" max="100" step="0.5"></div>
          <div class="lab-field"><label>Zaman dilimi</label><div class="seg" id="lab-tf"><button data-v="1d">Günlük</button><button data-v="1w">Haftalık</button><button data-v="1mo">Aylık</button></div></div>
          <div class="lab-field"><label>İşlem fiyatı</label><div class="seg" id="lab-fill"><button data-v="next_open">Ertesi açılış</button><button data-v="close">Sinyal kapanışı</button></div></div>
          <div class="lab-field"><label>Para birimi</label><div class="seg" id="lab-cur"><button data-v="TRY">TL</button><button data-v="USD">USD</button></div></div>
          <div class="lab-field"><label>Nakit faizi (yıllık %)</label><input type="number" class="field" id="lab-rate" min="0" max="200" step="1">
            <span class="muted small">Boştaki TL'nin mevduat / para piyasası getirisi. 0 = faizsiz.</span></div>
          <div class="lab-field"><label>Kıyas</label><select class="field" id="lab-bm"><option value="XU100">BIST 100</option><option value="ALTIN">Gram altın</option><option value="USDTRY">Dolar (USD/TRY)</option><option value="NONE">Yok</option></select></div>
          <div class="lab-field"><label class="check-l"><input type="checkbox" id="lab-adj"> Bedelsiz / bölünme düzeltmesi</label>
            <span class="muted small">BIST'te günlük limit %10; ±%30 üzeri gece sıçramaları sermaye işlemi sayılır ve geçmiş fiyatlar düzeltilir.</span></div>
        </div>
        <div class="note" style="margin:16px 0 8px">Parametreler <span class="muted small" id="lab-param-hint">(koddaki <code>params</code> bölümünden)</span></div>
        <div class="lab-params" id="lab-params"><div class="muted small">Kod kontrol edilince burada kaydırıcılar çıkar.</div></div>
        <div class="toolbar" style="margin:18px 0 0">
          <button class="btn primary lg" id="lab-run"><svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg>Testi çalıştır</button>
          <span class="muted small">Ctrl + Enter</span><span id="lab-run-status" class="muted small"></span></div>
      </div>

      <div id="lab-results" style="margin-top:16px"></div>`;

    status = await api('/strategy/status').catch(() => ({ llm: false }));
    $('#lab-llm').textContent = status.llm ? `Grok · ${status.model}` : 'Grok bağlı değil: kural tabanlı çevirici';
    initEditor();
    renderChat();
    renderExamples();
    renderTemplates();
    bindSettings();
    renderSymbols();
    $('#lab-name').value = S.name || '';
    $('#lab-name').oninput = (e) => { S.name = e.target.value; saveDraft(); };
    $('#lab-ask').onsubmit = (e) => { e.preventDefault(); generate(); };
    $('#lab-prompt').onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); generate(); } };
    $('#lab-check').onclick = () => inspect(true);
    $('#lab-fix').onclick = () => fixWithGrok(false);
    $('#lab-copy').onclick = () => { navigator.clipboard?.writeText(getCode()); toast('Kod kopyalandı'); };
    $('#lab-help-btn').onclick = toggleHelp;
    $('#lab-export').onclick = exportStrategy;
    $('#lab-import').onchange = (e) => { const f = e.target.files[0]; if (f) importStrategy(f); e.target.value = ''; };
    $('#lab-run').onclick = runBacktest;
    $('#lab-save').onclick = saveStrategy;
    $('#lab-new').onclick = () => {
      if (!confirm('Mevcut taslak silinsin mi?')) return;
      S = defaultState(); S.code = ''; S.name = 'Yeni strateji';
      setCode(starterCode()); S.code = getCode(); saveDraft(); location.hash = '#/strateji'; window.pageLab(v);
    };
    v.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.id !== 'lab-prompt') { e.preventDefault(); runBacktest(); } };

    if (arg && /^\d+$/.test(arg)) await loadSaved(Number(arg));
    else if (arg && arg.startsWith('t-')) loadTemplate(arg.slice(2));
    await inspect(false);
    window.__pageCleanup = () => { if (priceChart) { priceChart.remove(); priceChart = null; } };
    window.labReceive();
  };

  // a strategy sent from the Grok assistant panel (open_strategy_lab tool)
  window.labReceive = function labReceive() {
    const h = window.__labHandoff;
    if (!h || !h.description) return;
    window.__labHandoff = null;
    const syms = (h.symbols || []).map((s) => String(s).toUpperCase().replace('.IS', '')).filter((s) => /^[A-Z0-9]{2,12}$/.test(s));
    if (syms.length) { S.config.symbols = syms.slice(0, 40); renderSymbols(); }
    const okDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
    if (okDate(h.from)) { S.config.from = h.from; $('#lab-from').value = h.from; }
    if (okDate(h.to)) { S.config.to = h.to; $('#lab-to').value = h.to; }
    markRange(); saveDraft();
    $('#lab-prompt').value = h.description;
    toast('Asistandan gelen strateji koda dökülüyor');
    generate();
  };

  function starterCode() {
    return `const strategy = {
  name: 'Yeni strateji',
  description: 'Kurallarını buraya yaz.',
  params: {
    len: { label: 'Periyot', default: 20, min: 5, max: 100, step: 1 },
  },
  indicators(s, p, ta) {
    return { avg: ta.sma(s.close, p.len) };
  },
  onBar(ctx, p) {
    for (const sym of ctx.symbols) {
      const avg = ctx.ind(sym, 'avg');
      if (!ta.isNum(avg)) continue;
      const pos = ctx.position(sym);
      if (!pos && ctx.close(sym) > avg) ctx.buy(sym, { percent: 100 / ctx.symbols.length, reason: 'ortalamanın üstü' });
      else if (pos && ctx.close(sym) < avg) ctx.sell(sym, { reason: 'ortalamanın altı' });
    }
  },
};
`;
  }

  // ------------------------------------------------------------------ editor
  function initEditor() {
    const ta = $('#lab-code');
    ta.value = S.code;
    editor = null;
    if (window.CodeMirror) {
      editor = CodeMirror.fromTextArea(ta, {
        mode: 'javascript', lineNumbers: true, matchBrackets: true, tabSize: 2, indentUnit: 2, lineWrapping: false, theme: 'finsent',
        extraKeys: { 'Ctrl-Enter': runBacktest, 'Cmd-Enter': runBacktest, 'Ctrl-S': (cm) => { saveStrategy(); }, Tab: (cm) => cm.replaceSelection('  ') },
      });
      let t;
      editor.on('change', () => { S.code = editor.getValue(); saveDraft(); clearTimeout(t); t = setTimeout(() => inspect(false), 700); });
    } else {
      ta.classList.add('field', 'lab-code-plain');
      let t;
      ta.oninput = () => { S.code = ta.value; saveDraft(); clearTimeout(t); t = setTimeout(() => inspect(false), 700); };
    }
  }

  let errMark = null;
  function showError(err) {
    const box = $('#lab-err');
    if (!err) { box.style.display = 'none'; $('#lab-fix').style.display = 'none'; if (errMark) { editor?.removeLineClass(errMark, 'background', 'cm-err-line'); errMark = null; } return; }
    box.style.display = 'block';
    const where = err.phase === 'indicators' ? 'Göstergeler hesaplanırken' : err.phase === 'onBar' ? `İşlem kuralları çalışırken${err.date ? ` (${fdate(err.date)})` : ''}` : err.phase === 'timeout' ? 'Zaman aşımı' : 'Kod derlenirken';
    box.innerHTML = `<b>${esc(where)}</b>${err.line ? ` · satır ${err.line}` : ''}<div>${esc(err.message)}</div>`;
    $('#lab-fix').style.display = status.llm ? '' : 'none';
    if (editor && err.line) {
      if (errMark !== null) editor.removeLineClass(errMark, 'background', 'cm-err-line');
      errMark = err.line - 1;
      editor.addLineClass(errMark, 'background', 'cm-err-line');
    }
    S.lastError = `${where}${err.line ? ` (satır ${err.line})` : ''}: ${err.message}`;
  }

  async function inspect(explicit) {
    try {
      meta = await run('inspect', { code: getCode() }, { timeoutMs: 5000 });
      showError(null);
      $('#lab-desc').textContent = meta.description || '';
      if (meta.name && (!S.name || S.name === 'Yeni strateji')) { S.name = meta.name; $('#lab-name').value = meta.name; }
      renderParams();
      if (explicit) toast('Kod geçerli');
      return true;
    } catch (e) {
      showError(e);
      return false;
    }
  }

  function toggleHelp() {
    const h = $('#lab-help');
    if (h.style.display === 'none') {
      h.style.display = 'block';
      h.innerHTML = `<div class="card-head" style="margin-bottom:8px"><h2>Strateji API'si</h2><button class="linkbtn" onclick="this.closest('.lab-help').style.display='none'">Kapat</button></div>
        <dl class="kv lab-api">
          <dt><code>params</code></dt><dd>Ayarlanabilir sayılar: <code>{ ad: { label, default, min, max, step } }</code>. Kaydırıcılar ve parametre taraması bunlardan yapılır.</dd>
          <dt><code>indicators(s, p, ta)</code></dt><dd>Her hisse için bir kez çalışır. <code>s.close</code>, <code>s.high</code>, <code>s.low</code>, <code>s.volume</code>, <code>s.sentiment</code> dizileriyle gösterge dizileri döndür.</dd>
          <dt><code>onBar(ctx, p)</code></dt><dd>Her günün kapanışında çalışır. Emirler ertesi günün açılışında gerçekleşir (geleceği görme yok).</dd>
          <dt>Okuma</dt><dd><code>ctx.symbols, ctx.date, ctx.cash, ctx.equity, ctx.close(sym), ctx.bar(sym, önceki=0), ctx.ind(sym,'ad'), ctx.sentiment(sym), ctx.position(sym), ctx.positions(), ctx.state</code></dd>
          <dt>Emir</dt><dd><code>ctx.buy(sym, { percent | amount | shares | riskPercent, stopLoss, takeProfit, trailingStop, reason })</code> (<code>riskPercent: 1, stopLoss: 0.05</code> = stop olursa sermayenin %1'i kaybedilecek büyüklük), <code>ctx.sell(sym, { percent })</code>, <code>ctx.targetPercent(sym, 30)</code>, <code>ctx.closeAll()</code>, <code>ctx.log(...)</code></dd>
          <dt><code>ta</code></dt><dd>sma, ema, rsi, macd, bollinger, atr, stochastic, adx, obv, highest, lowest, roc, stdev, zscore, ref, crossover, crossunder, isNum</dd>
        </dl>
        <p class="muted small" style="margin:8px 0 0">Kod tarayıcında, sayfadan yalıtılmış bir Web Worker içinde çalışır; ağ erişimi kapalıdır.</p>`;
    } else h.style.display = 'none';
  }

  // ------------------------------------------------------------------ chat (Grok)
  function renderChat() {
    const box = $('#lab-chat');
    if (!S.chat.length) {
      box.innerHTML = `<div class="lab-chat-empty"><b>Stratejini kendi cümlelerinle yaz.</b><br>Grok onu çalıştırılabilir koda çevirir, varsayımlarını söyler. Sonra "zarar kesi %5 yap" gibi değişiklikler isteyebilirsin.</div>`;
      return;
    }
    box.innerHTML = S.chat.map((m) => m.role === 'user'
      ? `<div class="lab-msg user">${esc(m.content)}</div>`
      : `<div class="lab-msg bot">${m.pending ? '<span class="spinner"></span> Grok stratejini koda döküyor…' : `
          <div class="lab-msg-head">${esc(m.name || 'Strateji')}<span class="muted small">${m.provider === 'rules' ? 'kural tabanlı' : 'Grok'}${m.latency ? ` · ${num(m.latency / 1000, 1)} sn` : ''}</span></div>
          <div>${esc(m.summary || '')}</div>
          ${m.assumptions?.length ? `<div class="lab-msg-sub">Varsayımlar</div><ul>${m.assumptions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}
          ${m.warnings?.length ? `<div class="lab-msg-sub warn">Dikkat</div><ul>${m.warnings.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}
          ${m.symbols?.length ? `<div class="muted small" style="margin-top:6px">Önerilen semboller: ${m.symbols.map(esc).join(', ')}</div>` : ''}`}</div>`).join('');
    box.scrollTop = box.scrollHeight;
  }

  const EXAMPLES = [
    'RSI 30\'un altına inince al, 70 üstünde sat, %8 zarar kes',
    'Fiyat 200 günlük ortalamanın üstündeyken tut, altına inince sat',
    '20 günlük zirve kırılınca al, %10 iz süren stop kullan',
    'Her ay en çok yükselen 3 hisseyi tut',
    'Olumlu KAP haberi gelen hisseyi al 5 gün tut',
  ];
  function renderExamples() {
    $('#lab-examples').innerHTML = EXAMPLES.map((e, i) => `<button type="button" class="pill lab-ex" data-i="${i}">${esc(e.length > 34 ? e.slice(0, 32) + '…' : e)}</button>`).join('');
    $$('.lab-ex').forEach((b) => (b.onclick = () => { $('#lab-prompt').value = EXAMPLES[b.dataset.i]; $('#lab-prompt').focus(); }));
  }
  function renderTemplates() {
    $('#lab-templates').innerHTML = TEMPLATES.map((t) => `<button class="pill lab-tpl" data-id="${t.id}" title="${esc(t.summary)}"><span class="muted">${esc(t.category)}</span> ${esc(t.name)}</button>`).join('');
    $$('.lab-tpl').forEach((b) => (b.onclick = () => { loadTemplate(b.dataset.id); inspect(false); }));
  }
  function loadTemplate(id) {
    const t = TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    S.id = null; S.name = t.name; S.prompt = ''; S.config.params = {};
    if (t.symbols?.length) S.config.symbols = t.symbols.slice();
    setCode(t.code); $('#lab-name').value = t.name;
    renderSymbols(); saveDraft();
    toast(`Şablon yüklendi: ${t.name}`);
  }

  async function generate() {
    const prompt = $('#lab-prompt').value.trim();
    if (!prompt) { $('#lab-prompt').focus(); return; }
    const btn = $('#lab-gen'); btn.disabled = true;
    const isEdit = S.chat.length > 0;
    S.chat.push({ role: 'user', content: prompt });
    S.chat.push({ role: 'assistant', pending: true });
    renderChat();
    $('#lab-prompt').value = '';
    const history = S.chat.filter((m) => !m.pending).slice(0, -1).map((m) => ({ role: m.role, content: m.role === 'user' ? m.content : `${m.name}: ${m.summary}` }));
    let out;
    try {
      out = await api('/strategy/generate', { method: 'POST', body: JSON.stringify({ prompt, code: isEdit ? getCode() : null, symbols: S.config.symbols, history }) });
    } catch (e) {
      out = { fallback: true, reason: e.message };
    }
    if (out.fallback) {
      out = { ...window.FinSentNlp.parse(prompt, { knownSymbols: allSyms().map((s) => s.symbol).concat(['ALTIN', 'XU100', 'USDTRY', 'XAUUSD', 'GUMUS', 'EURTRY']) }), note: out.reason };
      if (out.note) out.warnings = [out.note, ...out.warnings];
    }
    S.chat.pop();
    S.chat.push({ role: 'assistant', name: out.name, summary: out.summary, assumptions: out.assumptions, warnings: out.warnings, symbols: out.symbols, provider: out.provider, latency: out.latency_ms });
    S.prompt = [S.prompt, prompt].filter(Boolean).join('\n');
    if (out.code) { setCode(out.code); S.config.params = {}; }
    if (out.name) { S.name = out.name; $('#lab-name').value = out.name; }
    if (out.symbols?.length) { S.config.symbols = out.symbols.slice(0, status.max_symbols || 40); renderSymbols(); }
    if (out.timeframe && out.timeframe !== (S.config.timeframe || '1d')) { S.config.timeframe = out.timeframe; bindSettings(); }
    saveDraft();
    renderChat();
    btn.disabled = false;
    let ok = await inspect(false);
    if (!ok && out.provider === 'xai') ok = await fixWithGrok(true);
    if (ok) {
      const err = await runBacktest();
      if (err && err.phase && err.phase !== 'timeout' && out.provider === 'xai' && await fixWithGrok(true)) await runBacktest();
    }
  }

  // auto = called right after generation: no backtest here (the caller runs it), returns success
  async function fixWithGrok(auto = false) {
    const btn = $('#lab-fix'); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Düzeltiliyor';
    let ok = false;
    if (auto) { S.chat.push({ role: 'assistant', pending: true }); renderChat(); }
    try {
      const out = await api('/strategy/fix', { method: 'POST', body: JSON.stringify({ code: getCode(), error: S.lastError || '' }) });
      if (auto) S.chat.pop();
      setCode(out.code);
      S.chat.push({ role: 'assistant', name: auto ? 'Kod hata verdi, Grok otomatik düzeltti' : 'Kod düzeltildi', summary: out.summary, assumptions: [], warnings: out.warnings || [], provider: 'xai' });
      renderChat(); saveDraft();
      ok = await inspect(false);
      if (ok && !auto) runBacktest();
    } catch (e) {
      if (auto) { S.chat.pop(); renderChat(); }
      toast(e.message);
    }
    btn.disabled = false; btn.textContent = 'Grok ile düzelt';
    return ok;
  }

  // ------------------------------------------------------------------ settings
  function bindSettings() {
    const c = S.config;
    $('#lab-from').value = c.from; $('#lab-to').value = c.to;
    $('#lab-cap').value = c.initialCapital; $('#lab-comm').value = c.commissionBps; $('#lab-slip').value = c.slippageBps;
    $('#lab-bm').value = c.benchmark; $('#lab-adj').checked = c.adjustCorporateActions; $('#lab-rate').value = c.cashRatePct || 0;
    const commPct = () => { $('#lab-comm-pct').textContent = `= %${num(c.commissionBps / 100, 2)} her alım ve satımda`; };
    commPct();
    const segSet = (id, val) => $$(`#${id} button`).forEach((b) => b.classList.toggle('on', b.dataset.v === val));
    segSet('lab-fill', c.fill); segSet('lab-cur', c.currency); segSet('lab-tf', c.timeframe || '1d');
    const upd = () => saveDraft();
    $('#lab-from').onchange = (e) => { c.from = e.target.value; markRange(); upd(); };
    $('#lab-to').onchange = (e) => { c.to = e.target.value; markRange(); upd(); };
    $('#lab-cap').onchange = (e) => { c.initialCapital = Math.max(1000, Number(e.target.value) || 100000); upd(); };
    $('#lab-comm').oninput = (e) => { c.commissionBps = Math.max(0, Number(e.target.value) || 0); commPct(); upd(); };
    $('#lab-slip').oninput = (e) => { c.slippageBps = Math.max(0, Number(e.target.value) || 0); upd(); };
    $('#lab-bm').onchange = (e) => { c.benchmark = e.target.value; upd(); };
    $('#lab-rate').onchange = (e) => { c.cashRatePct = Math.max(0, Math.min(200, Number(e.target.value) || 0)); e.target.value = c.cashRatePct; upd(); };
    $('#lab-adj').onchange = (e) => { c.adjustCorporateActions = e.target.checked; upd(); };
    $$('#lab-fill button').forEach((b) => (b.onclick = () => { c.fill = b.dataset.v; segSet('lab-fill', c.fill); upd(); }));
    $$('#lab-cur button').forEach((b) => (b.onclick = () => { c.currency = b.dataset.v; segSet('lab-cur', c.currency); upd(); }));
    $$('#lab-tf button').forEach((b) => (b.onclick = () => { c.timeframe = b.dataset.v; segSet('lab-tf', c.timeframe); upd(); }));
    $$('#lab-range button').forEach((b) => (b.onclick = () => {
      const y = Number(b.dataset.y);
      c.to = today; c.from = y >= 99 ? '1997-01-01' : yearsAgo(y);
      $('#lab-from').value = c.from; $('#lab-to').value = c.to; markRange(); upd();
    }));
    markRange();
    // symbols
    const input = $('#lab-sym-in'), res = $('#lab-sym-res');
    let hits = [], hl = 0;
    const extra = [{ symbol: 'XU100', title: 'BIST 100 endeksi' }, { symbol: 'ALTIN', title: 'Gram altın (TL)' }, { symbol: 'USDTRY', title: 'Dolar/TL' },
      { symbol: 'EURTRY', title: 'Euro/TL' }, { symbol: 'XAUUSD', title: 'Ons altın' }, { symbol: 'GUMUS', title: 'Gram gümüş' }];
    const pool = () => { const seen = new Set(); return [...extra, ...allSyms()].filter((s) => !seen.has(s.symbol) && seen.add(s.symbol)); };
    const renderHits = () => {
      res.innerHTML = hits.map((s, i) => `<a data-s="${esc(s.symbol)}" class="${i === hl ? 'hl' : ''}"><span><b>${esc(s.symbol)}</b> <span class="muted small">${esc((s.title || '').slice(0, 40))}</span></span></a>`).join('');
      res.classList.toggle('open', hits.length > 0);
      $$('a', res).forEach((a) => (a.onmousedown = (e) => { e.preventDefault(); addSym(a.dataset.s); }));
    };
    input.oninput = () => {
      const q = input.value.trim().toUpperCase(); hl = 0;
      hits = q ? pool().filter((s) => s.symbol.startsWith(q) || (s.title || '').toUpperCase().includes(q)).slice(0, 8) : [];
      renderHits();
    };
    input.onkeydown = (e) => {
      if (e.key === 'ArrowDown') { hl = Math.min(hl + 1, hits.length - 1); renderHits(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { hl = Math.max(hl - 1, 0); renderHits(); e.preventDefault(); }
      else if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
        e.preventDefault();
        const raw = input.value.trim().toUpperCase();
        if (hits[hl] && raw && hits[hl].symbol.startsWith(raw)) addSym(hits[hl].symbol); else raw.split(/[\s,;]+/).forEach(addSym);
      } else if (e.key === 'Backspace' && !input.value && S.config.symbols.length) { S.config.symbols.pop(); renderSymbols(); saveDraft(); }
    };
    input.onblur = () => setTimeout(() => { hits = []; renderHits(); }, 100);
    function addSym(s) {
      s = String(s || '').toUpperCase().replace('.IS', '').trim();
      if (!/^[A-Z0-9]{2,12}$/.test(s)) return;
      if (!S.config.symbols.includes(s)) S.config.symbols.push(s);
      input.value = ''; hits = []; renderHits(); renderSymbols(); saveDraft();
    }
    const liquid = async (n) => {
      try {
        const u = await api(`/strategy/universe?n=${n}&as_of=${c.from}`);
        S.config.symbols = u.symbols; renderSymbols(); saveDraft();
        toast(`${fdate(u.as_of)} itibarıyla en likit ${u.symbols.length} hisse seçildi`);
      } catch (e) { toast(e.message); }
    };
    $('#lab-liq10').onclick = () => liquid(10);
    $('#lab-liq20').onclick = () => liquid(20);
    $('#lab-symclear').onclick = () => { S.config.symbols = []; renderSymbols(); saveDraft(); };
  }
  function markRange() {
    const c = S.config;
    $$('#lab-range button').forEach((b) => {
      const y = Number(b.dataset.y);
      b.classList.toggle('on', c.to === today && (y >= 99 ? c.from <= '1997-12-31' : c.from === yearsAgo(y)));
    });
  }
  function renderSymbols() {
    const box = $('#lab-syms'), input = $('#lab-sym-in');
    $$('.sym-chip', box).forEach((x) => x.remove());
    S.config.symbols.forEach((s) => {
      const chip = document.createElement('span');
      chip.className = 'pill sym-chip';
      chip.innerHTML = `${esc(s)}<button class="pill-x" title="Çıkar">✕</button>`;
      chip.querySelector('button').onclick = () => { S.config.symbols = S.config.symbols.filter((x) => x !== s); renderSymbols(); saveDraft(); };
      box.insertBefore(chip, input);
    });
  }

  function renderParams() {
    const box = $('#lab-params');
    const entries = Object.entries(meta?.params || {});
    if (!entries.length) { box.innerHTML = '<div class="muted small">Bu stratejinin ayarlanabilir parametresi yok.</div>'; return; }
    box.innerHTML = entries.map(([k, sp]) => {
      const val = S.config.params[k] ?? sp.default;
      if (typeof sp.default === 'boolean') {
        return `<label class="lab-param bool"><input type="checkbox" data-k="${esc(k)}" ${val ? 'checked' : ''}><span>${esc(sp.label)}</span></label>`;
      }
      const n = (x, d) => (Number.isFinite(Number(x)) ? Number(x) : d);   // attribute values are always plain numbers
      const def = n(sp.default, 0), v = n(val, def);
      const min = n(sp.min, Math.min(0, def)), max = n(sp.max, Math.max(def * 3, 10)), step = n(sp.step, Number.isInteger(def) ? 1 : 0.1);
      return `<div class="lab-param"><div class="lab-param-head"><span>${esc(sp.label)}</span>
          <input type="number" class="lab-param-num" data-k="${esc(k)}" value="${v}" min="${min}" max="${max}" step="${step}"></div>
        <input type="range" data-k="${esc(k)}" value="${v}" min="${min}" max="${max}" step="${step}">
        <div class="lab-param-foot"><span>${min}</span>${v !== def ? `<button class="linkbtn" data-reset="${esc(k)}">varsayılan: ${def}</button>` : ''}<span>${max}</span></div></div>`;
    }).join('');
    $$('input[data-k]', box).forEach((inp) => {
      const k = inp.dataset.k;
      const apply = (v) => { S.config.params[k] = v; saveDraft(); };
      if (inp.type === 'checkbox') inp.onchange = () => apply(inp.checked);
      else if (inp.type === 'range') inp.oninput = () => { const n = Number(inp.value); $(`.lab-param-num[data-k="${k}"]`, box).value = n; apply(n); };
      else inp.onchange = () => { const n = Number(inp.value); $(`input[type=range][data-k="${k}"]`, box).value = n; apply(n); };
    });
    $$('[data-reset]', box).forEach((b) => (b.onclick = () => { delete S.config.params[b.dataset.reset]; saveDraft(); renderParams(); }));
    $$('input[type=range]', box).forEach((r) => (r.onchange = () => renderParams()));
  }

  // ------------------------------------------------------------------ data + run
  async function loadData(c = S.config) {
    if (!c.symbols.length) throw new Error('En az bir sembol ekle.');
    const warm = { '1w': 1800, '1mo': 4500 }[c.timeframe] || 420;
    const key = [c.symbols.join(','), c.from, c.to, c.currency, c.benchmark, warm].join('|');
    if (dataCache.has(key)) return dataCache.get(key);
    const q = new URLSearchParams({ symbols: c.symbols.join(','), from: c.from, to: c.to, currency: c.currency, benchmark: c.benchmark, warmup_days: warm });
    const d = await api(`/strategy/data?${q}`);
    if (dataCache.size > 6) dataCache.delete(dataCache.keys().next().value);
    dataCache.set(key, d);
    return d;
  }

  function engineConfig(data, c = S.config) {
    return { initialCapital: c.initialCapital, commissionBps: c.commissionBps, slippageBps: c.slippageBps, fill: c.fill,
      adjustCorporateActions: c.adjustCorporateActions, startDate: data.from, timeframe: c.timeframe || '1d', cashRatePct: c.currency === 'TRY' ? (c.cashRatePct || 0) : 0 };
  }

  async function runBacktest() {
    const btn = $('#lab-run'), st = $('#lab-run-status');
    btn.disabled = true;
    st.innerHTML = '<span class="spinner"></span> Veri yükleniyor…';
    try {
      const data = await loadData();
      lastData = data;
      st.innerHTML = '<span class="spinner"></span> Test ediliyor…';
      const res = await run('backtest', { code: getCode(), data: data.series, params: S.config.params, config: engineConfig(data), benchmark: data.benchmark }, { timeoutMs: 45000 });
      showError(null);
      lastResult = res;
      if (data.missing?.length) res.warnings.unshift(`Verisi olmayan semboller atlandı: ${data.missing.join(', ')}`);
      st.textContent = `${num(res.dates.length, 0)} ${{ '1w': 'haftalık', '1mo': 'aylık' }[S.config.timeframe] ? `${{ '1w': 'haftalık', '1mo': 'aylık' }[S.config.timeframe]} mum` : 'gün'} · ${num(res.elapsedMs, 0)} ms`;
      renderResults(res, data);
      saveDraft();
    } catch (e) {
      st.textContent = '';
      if (e.phase || e.line) showError(e); else toast(e.message);
      if (e.phase) $('#lab-err').scrollIntoView({ behavior: 'smooth', block: 'center' });
      btn.disabled = false;
      return e;
    }
    btn.disabled = false;
    return null;
  }

  // ------------------------------------------------------------------ results
  const COLORS = () => ({ strat: css('--accent'), bh: '#8a8984', bm: '#d8d6cf' });

  function renderResults(r, data) {
    const m = r.metrics, bh = r.buyHold.metrics, bm = r.benchmark?.metrics;
    const bmName = { XU100: 'BIST 100', ALTIN: 'Gram altın', USDTRY: 'Dolar' }[r.benchmark?.name] || r.benchmark?.name || '';
    const cmp = (a, b, higherBetter = true) => (a === null || b === null || a === undefined || b === undefined ? '' : (higherBetter ? a > b : a < b) ? 'up' : 'down');
    const out = $('#lab-results');
    out.innerHTML = `
      <div class="card reveal">
        <div class="card-head"><h2><span class="stepn">4</span>Sonuçlar <span class="muted small" style="font-weight:400">· ${esc(S.name)} · ${fdate(r.dates[0])} – ${fdate(r.dates.at(-1))} · ${r.symbols.length} varlık${S.config.timeframe === '1w' ? ' · haftalık' : S.config.timeframe === '1mo' ? ' · aylık' : ''}</span></h2>
          <div class="toolbar" style="margin:0;gap:6px"><button class="btn sm" id="lab-review"><svg viewBox="0 0 24 24"><path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z"/></svg>Grok yorumlasın</button>
          <button class="btn sm" id="lab-csv">İşlemleri indir (CSV)</button></div></div>
        ${r.warnings.length ? `<div class="lab-warn">${r.warnings.map((w) => `<div>! ${esc(w)}</div>`).join('')}</div>` : ''}
        <div class="lab-kpis">
          ${kpi('Son değer', fmtMoney(m.final), `Başlangıç ${fmtMoney(m.initial)}`)}
          ${kpi('Toplam getiri', `<span class="${dirCls(m.totalReturn)}">${pct(m.totalReturn, 1)}</span>`, `Al-tut <b class="${cmp(bh.totalReturn, m.totalReturn)}">${pct(bh.totalReturn, 1)}</b>${bm ? ` · ${esc(bmName)} <b>${pct(bm.totalReturn, 1)}</b>` : ''}${r.deposit ? ` · Mevduat <b class="${cmp(r.deposit.metrics.totalReturn, m.totalReturn)}">${pct(r.deposit.metrics.totalReturn, 1)}</b>` : ''}`)}
          ${kpi('Yıllık getiri', `<span class="${dirCls(m.cagr)}">${pct(m.cagr, 1)}</span>`, `Al-tut ${pct(bh.cagr, 1)}${bm ? ` · ${esc(bmName)} ${pct(bm.cagr, 1)}` : ''}`)}
          ${kpi('En büyük düşüş', `<span class="down">${pct(m.maxDrawdown, 1)}</span>`, `Al-tut ${pct(bh.maxDrawdown, 1)} · ${num(m.maxDrawdownDays, 0)} gün sürdü`)}
          ${kpi('Sharpe', ratio(m.sharpe), `Al-tut ${ratio(bh.sharpe)} · Sortino ${ratio(m.sortino)}`)}
          ${kpi('İşlemler', num(m.trades, 0), m.trades ? `Kazanma %${num(m.winRate * 100, 0)} · ort. ${pct(m.avgTrade, 1)}` : 'Kapanmış işlem yok')}
        </div>
        <div class="seg lab-tabs" id="lab-tabs"><button data-t="sum" class="on">Özet</button><button data-t="trades">İşlemler</button><button data-t="months">Aylık / yıllık</button><button data-t="opt">Optimizasyon</button><button data-t="wf">Eğitim / test</button><button data-t="roll">Tutarlılık</button><button data-t="mc">Risk (Monte Carlo)</button><button data-t="log">Günlük</button></div>
        <div id="lab-tab"></div>
      </div>
      <div class="card reveal" id="lab-review-card" style="margin-top:16px;display:none"></div>`;
    $$('#lab-tabs button').forEach((b) => (b.onclick = () => { $$('#lab-tabs button').forEach((x) => x.classList.toggle('on', x === b)); showTab(b.dataset.t); }));
    $('#lab-review').onclick = review;
    $('#lab-csv').onclick = () => downloadCsv(r);
    showTab('sum');
  }
  const kpi = (l, v, d) => `<div class="stat"><div class="l">${l}</div><div class="v num">${v}</div><div class="d">${d}</div></div>`;

  function showTab(t) {
    const r = lastResult, box = $('#lab-tab');
    if (priceChart && t !== 'sum') { priceChart.remove(); priceChart = null; }
    if (t === 'sum') return tabSummary(r, box);
    if (t === 'trades') return tabTrades(r, box);
    if (t === 'months') return tabMonths(r, box);
    if (t === 'opt') return tabOptimize(box);
    if (t === 'wf') return tabWalkForward(box);
    if (t === 'mc') return tabMonteCarlo(r, box);
    if (t === 'roll') return tabRolling(r, box);
    if (t === 'log') return tabLog(r, box);
  }

  function tabSummary(r, box) {
    const m = r.metrics;
    box.innerHTML = `
      <div class="lab-chart-head"><div class="chart-legend" id="lab-eq-legend"></div>
        <div class="seg" id="lab-eq-scale"><button data-v="linear" class="on">Doğrusal</button><button data-v="log">Logaritmik</button></div></div>
      <div style="height:300px"><canvas id="lab-eq"></canvas></div>
      <div class="note" style="margin:14px 0 6px">Zirveden düşüş</div>
      <div style="height:110px"><canvas id="lab-dd"></canvas></div>
      <div class="grid lab-sum-grid" style="margin-top:18px">
        <div>
          <div class="card-head" style="margin-bottom:8px"><h2>Bugün ne yapardı?</h2><span class="hint">son veri: ${fdate(r.dates.at(-1))}</span></div>
          ${signalsHtml(r)}
          <div class="note" style="margin:14px 0 6px">Açık pozisyonlar</div>
          ${r.openPositions.length ? `<table class="tbl"><tr><th>Sembol</th><th>Adet</th><th>Maliyet</th><th>Değer</th><th>K/Z</th><th>Gün</th></tr>
            ${r.openPositions.map((p) => `<tr><td><b>${esc(p.sym)}</b></td><td class="num">${num(p.shares, 0)}</td><td class="num">${num(p.avgPrice)}</td><td class="num">${fmtMoney(p.value)}</td><td>${chg(p.pnlPct, 1)}</td><td class="num">${num(p.barsHeld, 0)}</td></tr>`).join('')}</table>`
            : '<div class="muted small">Tamamen nakitte.</div>'}
        </div>
        <div>
          <div class="card-head" style="margin-bottom:8px"><h2>Ayrıntılı ölçümler</h2></div>
          <dl class="kv lab-kv">
            <dt>Yıllık oynaklık</dt><dd>${pct(m.volatility, 1, false)}</dd>
            <dt>Calmar (getiri / düşüş)</dt><dd>${ratio(m.calmar)}</dd>
            <dt>Piyasada kalma süresi</dt><dd>${m.exposure !== null ? `%${num(m.exposure * 100, 0)}` : '–'}</dd>
            <dt>Kâr faktörü</dt><dd>${m.profitFactor === Infinity ? '∞' : ratio(m.profitFactor)}</dd>
            <dt>Ortalama kazanç / kayıp</dt><dd>${pct(m.avgWin, 1)} / ${pct(m.avgLoss, 1)}</dd>
            <dt>En iyi / en kötü işlem</dt><dd>${pct(m.bestTrade, 1)} / ${pct(m.worstTrade, 1)}</dd>
            <dt>Ortalama tutma</dt><dd>${m.avgBarsHeld !== null ? `${num(m.avgBarsHeld, 0)} gün` : '–'}</dd>
            <dt>En iyi / en kötü gün</dt><dd>${pct(m.bestDay, 1)} / ${pct(m.worstDay, 1)}</dd>
            <dt>Ödenen komisyon</dt><dd>${fmtMoney(r.totalCommission)}</dd>
            ${r.totalInterest ? `<dt>Nakitte kazanılan faiz</dt><dd>${fmtMoney(r.totalInterest)}</dd>` : ''}
            <dt>Süre</dt><dd>${num(m.years, 1)} yıl</dd>
            ${r.relative ? `<dt title="1 = endeksle aynı oynaklık; 0 = endeksten bağımsız">Beta (${esc(r.benchmark.name)})</dt><dd>${ratio(r.relative.beta)}</dd>
            <dt title="Endeks riskinin açıklayamadığı yıllık getiri">Alfa (yıllık)</dt><dd class="${dirCls(r.relative.alpha)}">${pct(r.relative.alpha, 1)}</dd>
            <dt>Endeksle korelasyon</dt><dd>${ratio(r.relative.correlation)}</dd>
            <dt title="Endeksi geçme getirisinin, ondan sapma riskine oranı">Bilgi oranı</dt><dd>${ratio(r.relative.informationRatio)}</dd>` : ''}
          </dl>
          ${Object.keys(r.corporateActions).length ? `<p class="muted small" style="margin:10px 0 0">Sermaye işlemi düzeltmesi: ${Object.entries(r.corporateActions).map(([s, ev]) => `${esc(s)} (${ev.length})`).join(', ')}</p>` : ''}
        </div>
      </div>
      <div class="lab-chart-head" style="margin-top:22px"><h2 style="margin:0">Fiyat ve işlemler</h2>
        <select class="field sm" id="lab-px-sym">${r.symbols.map((s) => `<option>${esc(s)}</option>`).join('')}</select></div>
      <div id="lab-px" style="height:340px"></div>
      <p class="muted small" style="margin:6px 0 0">▲ alım · ▼ satım. Grafik ham (düzeltilmemiş) kapanış fiyatlarını gösterir; işlem fiyatları ${S.config.adjustCorporateActions ? 'sermaye işlemi düzeltmeli seriden gelir, bu yüzden eski tarihlerde farklı görünebilir' : 'aynı seriden gelir'}.</p>`;
    drawEquity(r, 'linear');
    $$('#lab-eq-scale button').forEach((b) => (b.onclick = () => { $$('#lab-eq-scale button').forEach((x) => x.classList.toggle('on', x === b)); drawEquity(r, b.dataset.v); }));
    drawPriceTrades(r, r.symbols[0]);
    $('#lab-apply').onclick = () => applySignals(r);
    $('#lab-px-sym').onchange = (e) => drawPriceTrades(r, e.target.value);
  }

  function signalsHtml(r) {
    if (!r.signals.length) return '<div class="muted small">Son kapanışa göre yeni bir al/sat sinyali yok.</div>';
    const tag = (s) => (s.side === 'buy' ? ['AL', 'pos'] : s.side === 'sell' ? ['SAT', 'neg'] : ['HEDEF', 'acc']);
    return `<div class="rows">${r.signals.map((s) => `<div class="row" style="cursor:default"><span class="pill ${tag(s)[1]}">${tag(s)[0]}</span>
      <b>${esc(s.sym)}</b><span class="muted small" style="flex:1">${esc(s.reason)}</span>${Number.isFinite(s.targetPercent) ? `<span class="num small">ağırlık %${num(s.targetPercent, 0)}</span>` : Number.isFinite(s.percent) ? `<span class="num small">%${num(s.percent, 0)}</span>` : ''}</div>`).join('')}</div>
      <div class="toolbar" style="margin:10px 0 0"><button class="btn sm primary" id="lab-apply">Sanal portföye uygula</button>
        <span class="muted small">Alımlar portföy değerinin sinyaldeki yüzdesiyle, satışlar pozisyonun tamamıyla yapılır.</span></div>
      <p class="muted small" style="margin:6px 0 0">Sinyaller bir sonraki seansın açılışında uygulanırdı. Yatırım tavsiyesi değildir.</p>`;
  }

  async function applySignals(r) {
    if (!window.paperApi) return;
    if (S.config.currency !== 'TRY') { toast('Sanal portföy TL bazlı: para birimini TL yapıp yeniden test et.'); return; }
    const btn = $('#lab-apply'); btn.disabled = true;
    try {
      const acc = await window.paperApi.ensureAccount();
      const full = await api(`/paper/${acc.id}`);
      if (!confirm(`${r.signals.length} sinyal "${full.name}" portföyüne uygulansın mı?`)) { btn.disabled = false; return; }
      const done = [], failed = [];
      const held = (sym) => full.positions.find((p) => p.symbol === sym);
      // translate each signal into a paper order with the same meaning as in the backtest
      const toOrder = (s) => {
        const h = held(s.sym);
        if (s.side === 'sell') {
          if (!h) return null;
          if (s.shares) return { side: 'sell', shares: s.shares };
          if (s.percent) return { side: 'sell', shares: Math.floor((h.shares * s.percent) / 100) };
          return { side: 'sell' };
        }
        if (s.side === 'target') {
          const diff = (full.value * s.targetPercent) / 100 - (h ? h.value : 0);
          if (Math.abs(diff) < full.value * 0.002) return null;   // already at target
          return diff > 0 ? { side: 'buy', amount: Math.floor(diff) } : (h ? { side: 'sell', shares: Math.floor(-diff / h.price) } : null);
        }
        if (s.shares) return { side: 'buy', shares: s.shares };
        if (s.amount) return { side: 'buy', amount: Math.floor(s.amount) };
        return { side: 'buy', amount: Math.floor((full.value * (s.percent ?? 100 / r.symbols.length)) / 100) };
      };
      const orders = r.signals.map((s) => ({ s, o: toOrder(s) })).filter((x) => x.o && !(x.o.shares === 0));
      orders.sort((a, b) => (a.o.side === 'sell' ? 0 : 1) - (b.o.side === 'sell' ? 0 : 1));   // sells fund buys
      for (const { s, o } of orders) {
        try {
          const res = await window.paperApi.order(acc.id, { symbol: s.sym, ...o, note: `${S.name}: ${s.reason}`.slice(0, 250) });
          done.push(`${res.side === 'buy' ? 'AL' : 'SAT'} ${res.shares} ${res.symbol}`);
        } catch (e) { failed.push(`${s.sym}: ${e.message}`); }
      }
      toast(`${done.length} emir uygulandı${failed.length ? `, ${failed.length} başarısız` : ''}`);
      if (failed.length) console.warn(failed);
      if (done.length && confirm('Sanal portföye gidilsin mi?')) location.hash = `#/portfoy/${acc.id}`;
    } catch (e) { toast(e.message); }
    btn.disabled = false;
  }

  function drawEquity(r, scale) {
    const C = COLORS();
    const ds = [
      { label: S.name || 'Strateji', data: r.equity, borderColor: C.strat, borderWidth: 2, pointRadius: 0, fill: false, tension: 0 },
      { label: 'Al-tut', data: r.buyHold.equity, borderColor: C.bh, borderWidth: 1.4, pointRadius: 0, fill: false, borderDash: [4, 3], tension: 0 },
    ];
    if (r.benchmark) ds.push({ label: { XU100: 'BIST 100', ALTIN: 'Gram altın', USDTRY: 'Dolar' }[r.benchmark.name] || r.benchmark.name, data: r.benchmark.equity, borderColor: C.bm, borderWidth: 1.2, pointRadius: 0, fill: false, tension: 0 });
    if (r.deposit) ds.push({ label: `Mevduat %${num(S.config.cashRatePct, 0)}`, data: r.deposit.equity, borderColor: '#6e6d68', borderWidth: 1, borderDash: [2, 3], pointRadius: 0, fill: false, tension: 0 });
    $('#lab-eq-legend').innerHTML = ds.map((d) => `<span><i class="line-key" style="background:${d.borderColor}"></i>${esc(d.label)} <b class="num">${fmtMoney(d.data.at(-1))}</b></span>`).join('');
    const step = Math.max(1, Math.floor(r.dates.length / 1500));
    const pick = (a) => a.filter((_, i) => i % step === 0 || i === a.length - 1);
    chart('lab-eq', {
      type: 'line',
      data: { labels: pick(r.dates), datasets: ds.map((d) => ({ ...d, data: pick(d.data) })) },
      options: { maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false }, tooltip: { ...tooltip, displayColors: true, callbacks: { title: (it) => fdate(it[0].label), label: (c) => ` ${c.dataset.label}: ${fmtMoney(c.parsed.y)}` } } },
        scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0, callback(v) { return String(this.getLabelForValue(v)).slice(0, 7); } } },
          y: { type: scale === 'log' ? 'logarithmic' : 'linear', position: 'right', grid: { color: 'rgba(255,255,255,.04)' }, ticks: { maxTicksLimit: 6, callback: (v) => fmtMoney(v) } } } },
    });
    chart('lab-dd', {
      type: 'line',
      data: { labels: pick(r.dates), datasets: [{ data: pick(r.drawdown).map((x) => x * 100), borderColor: css('--down'), borderWidth: 1.2, pointRadius: 0, fill: true, backgroundColor: 'rgba(194,65,59,.18)', tension: 0 }] },
      options: { maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false }, tooltip: { ...tooltip, callbacks: { title: (it) => fdate(it[0].label), label: (c) => `%${num(c.parsed.y, 1)}` } } },
        scales: { x: { display: false }, y: { position: 'right', max: 0, grid: { color: 'rgba(255,255,255,.04)' }, ticks: { maxTicksLimit: 3, callback: (v) => `%${v}` } } } },
    });
  }

  function drawPriceTrades(r, sym) {
    const el = $('#lab-px');
    if (!el.isConnected || !window.LightweightCharts) return;
    if (priceChart) { priceChart.remove(); priceChart = null; }
    const s = lastData?.series?.[sym];
    if (!s) { el.innerHTML = '<div class="empty">Veri yok</div>'; return; }
    priceChart = LightweightCharts.createChart(el, {
      autoSize: true,
      layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#6e6d68', fontFamily: 'Inter', fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: 'rgba(255,255,255,.025)' }, horzLines: { color: 'rgba(255,255,255,.04)' } },
      rightPriceScale: { borderColor: '#232326' }, timeScale: { borderColor: '#232326' }, crosshair: { mode: 0 },
    });
    const line = priceChart.addLineSeries({ color: '#d8d6cf', lineWidth: 1.5, priceLineVisible: false });
    const from = r.dates[0];
    const pts = [];
    s.date.forEach((d, i) => { if (d >= from) pts.push({ time: d, value: s.close[i] }); });
    line.setData(pts);
    const up = css('--up'), down = css('--down');
    const markers = r.fills.filter((f) => f.sym === sym).map((f) => ({
      time: f.date, position: f.side === 'buy' ? 'belowBar' : 'aboveBar', color: f.side === 'buy' ? up : down,
      shape: f.side === 'buy' ? 'arrowUp' : 'arrowDown', text: f.side === 'buy' ? 'AL' : (f.reason === 'zarar kes' ? 'STOP' : f.reason === 'kâr al' ? 'KÂR' : 'SAT'),
    }));
    line.setMarkers(markers.slice(-600));
    priceChart.timeScale().fitContent();
  }

  function tabTrades(r, box) {
    const rows = r.trades.slice().reverse();
    let page = 0;
    const per = 50;
    const draw = () => {
      const part = rows.slice(page * per, (page + 1) * per);
      box.innerHTML = `${r.tradesTotal > r.trades.length ? `<p class="muted small">Son ${num(r.trades.length, 0)} işlem gösteriliyor (toplam ${num(r.tradesTotal, 0)}).</p>` : ''}
        ${rows.length ? `<div class="tbl-wrap"><table class="tbl"><tr><th>Sembol</th><th>Giriş</th><th>Çıkış</th><th>Adet</th><th>Giriş fiyatı</th><th>Çıkış fiyatı</th><th>Gün</th><th>K/Z</th><th>Getiri</th><th>Çıkış nedeni</th></tr>
          ${part.map((t) => `<tr><td><b>${esc(t.sym)}</b></td><td>${fdate(t.entryDate)}</td><td>${fdate(t.exitDate)}</td><td class="num">${num(t.shares, 0)}</td>
            <td class="num">${num(t.entryPrice)}</td><td class="num">${num(t.exitPrice)}</td><td class="num">${num(t.bars, 0)}</td>
            <td class="num ${dirCls(t.pnl)}">${fmtMoney(t.pnl)}</td><td>${chg(t.returnPct, 1)}</td><td class="muted small">${esc(t.reason)}</td></tr>`).join('')}</table></div>
          <div class="toolbar" style="margin:10px 0 0">${page > 0 ? '<button class="btn sm" id="tp-prev">← Önceki</button>' : ''}
            <span class="muted small">${page * per + 1}–${Math.min(rows.length, (page + 1) * per)} / ${rows.length}</span>
            ${(page + 1) * per < rows.length ? '<button class="btn sm" id="tp-next">Sonraki →</button>' : ''}</div>` : '<div class="empty">Kapanmış işlem yok.</div>'}`;
      $('#tp-prev').onclick = () => { page--; draw(); };
      $('#tp-next').onclick = () => { page++; draw(); };
    };
    draw();
  }

  function tabMonths(r, box) {
    const { monthly, yearly } = r.periodReturns;
    const years = Object.keys(yearly).sort();
    const bhYear = yearlyOf(r.dates, r.buyHold.equity);
    const bmYear = r.benchmark ? yearlyOf(r.dates, r.benchmark.equity) : {};
    const cell = (v) => {
      if (v === undefined) return '<td></td>';
      const a = Math.min(1, Math.abs(v) / 0.15);
      const bg = v >= 0 ? `rgba(53,173,110,${0.08 + a * 0.45})` : `rgba(194,65,59,${0.08 + a * 0.45})`;
      return `<td class="num hm" style="background:${bg}">${num(v * 100, 1)}</td>`;
    };
    box.innerHTML = `
      <div style="height:220px"><canvas id="lab-years"></canvas></div>
      <div class="tbl-wrap" style="margin-top:16px"><table class="tbl hm-tbl"><tr><th>Yıl</th>${MONTHS.map((m) => `<th>${m}</th>`).join('')}<th>Yıl</th><th>Al-tut</th>${r.benchmark ? '<th>Kıyas</th>' : ''}</tr>
        ${years.map((y) => `<tr><td><b>${y}</b></td>${MONTHS.map((_, i) => cell(monthly[`${y}-${String(i + 1).padStart(2, '0')}`])).join('')}
          <td class="num ${dirCls(yearly[y])}"><b>${pct(yearly[y], 1)}</b></td><td class="num muted">${pct(bhYear[y], 1)}</td>${r.benchmark ? `<td class="num muted">${pct(bmYear[y], 1)}</td>` : ''}</tr>`).join('')}</table></div>
      <p class="muted small">Hücreler aylık getiri (%). TL bazındaki getiriler enflasyon içerir; reel karşılaştırma için para birimini USD yap veya altını kıyas seç.</p>`;
    const C = COLORS();
    const sets = [{ label: 'Strateji', data: years.map((y) => yearly[y] * 100), backgroundColor: C.strat, borderRadius: 3 },
      { label: 'Al-tut', data: years.map((y) => (bhYear[y] ?? 0) * 100), backgroundColor: '#5a5955', borderRadius: 3 }];
    if (r.benchmark) sets.push({ label: 'Kıyas', data: years.map((y) => (bmYear[y] ?? 0) * 100), backgroundColor: '#a3a29d', borderRadius: 3 });
    chart('lab-years', {
      type: 'bar', data: { labels: years, datasets: sets },
      options: { maintainAspectRatio: false, animation: false, plugins: { legend: { display: true, labels: { boxWidth: 10, boxHeight: 10 } }, tooltip: { ...tooltip, displayColors: true, callbacks: { label: (c) => ` ${c.dataset.label}: %${num(c.parsed.y, 1)}` } } },
        scales: { x: { grid: { display: false } }, y: { position: 'right', grid: { color: 'rgba(255,255,255,.04)' }, ticks: { callback: (v) => `%${v}` } } } },
    });
  }
  function yearlyOf(dates, eq) {
    const out = {}; let base = eq[0], prev = dates[0].slice(0, 4);
    for (let k = 1; k < dates.length; k++) {
      const y = dates[k].slice(0, 4);
      if (y !== prev) { out[prev] = eq[k - 1] / base - 1; base = eq[k - 1]; prev = y; }
    }
    out[prev] = eq.at(-1) / base - 1;
    return out;
  }

  // ------------------------------------------------------------------ optimisation
  const METRICS = { sharpe: ['Sharpe', (v) => ratio(v)], cagr: ['Yıllık getiri', (v) => pct(v, 1)], totalReturn: ['Toplam getiri', (v) => pct(v, 1)], maxDrawdown: ['En büyük düşüş', (v) => pct(v, 1)] };
  function numericParams() { return Object.entries(meta?.params || {}).filter(([, sp]) => typeof sp.default === 'number'); }
  function axisDefaults(sp) {
    const n = (x, d) => (Number.isFinite(Number(x)) ? Number(x) : d);
    const def = n(sp.default, 1);
    const min = n(sp.min, Math.max(1, Math.round(def / 2))), max = n(sp.max, def * 2);
    let step = n(sp.step, 1) > 0 ? n(sp.step, 1) : 1;
    while ((max - min) / step > 14) step *= 2;
    return { min, max, step };
  }
  function tabOptimize(box) {
    const ps = numericParams();
    if (!ps.length) { box.innerHTML = '<div class="empty">Taranacak sayısal parametre yok.</div>'; return; }
    const sel = (id, idx) => `<select class="field sm" id="${id}">${id === 'op-p2' ? '<option value="">(yok)</option>' : ''}${ps.map(([k, sp], i) => `<option value="${esc(k)}" ${i === idx ? 'selected' : ''}>${esc(sp.label)}</option>`).join('')}</select>`;
    box.innerHTML = `<p class="muted small" style="margin-top:0">Bir veya iki parametrenin farklı değerlerini dener. Tek bir değerde parlayıp komşularında çöken sonuç büyük olasılıkla <b>aşırı uyumdur</b> (geçmişe ezber). Geniş bir bölgede iyi olan ayar daha güvenilirdir.</p>
      <div class="lab-opt-row">
        <div><label>1. parametre</label>${sel('op-p1', 0)}<div class="lab-axis" id="op-a1"></div></div>
        <div><label>2. parametre</label>${sel('op-p2', ps.length > 1 ? 1 : -1)}<div class="lab-axis" id="op-a2"></div></div>
        <div><label>Ölçüt</label><select class="field sm" id="op-metric">${Object.entries(METRICS).map(([k, [l]]) => `<option value="${k}">${l}</option>`).join('')}</select>
          <button class="btn primary" id="op-run" style="margin-top:10px">Taramayı başlat</button><div class="muted small" id="op-status" style="margin-top:6px"></div></div>
      </div><div id="op-out"></div>`;
    const axisUi = (selId, boxId) => {
      const k = $(`#${selId}`).value, b = $(`#${boxId}`);
      if (!k) { b.innerHTML = ''; return; }
      const d = axisDefaults(meta.params[k]);
      b.innerHTML = `<input type="number" class="field sm" data-f="min" value="${d.min}" title="en az"><input type="number" class="field sm" data-f="max" value="${d.max}" title="en çok"><input type="number" class="field sm" data-f="step" value="${d.step}" title="adım">`;
    };
    axisUi('op-p1', 'op-a1'); axisUi('op-p2', 'op-a2');
    $('#op-p1').onchange = () => axisUi('op-p1', 'op-a1');
    $('#op-p2').onchange = () => axisUi('op-p2', 'op-a2');
    $('#op-run').onclick = async () => {
      const grid = {};
      for (const [selId, boxId] of [['op-p1', 'op-a1'], ['op-p2', 'op-a2']]) {
        const k = $(`#${selId}`).value;
        if (!k || grid[k]) continue;
        const g = {};
        $$(`#${boxId} input`).forEach((i) => (g[i.dataset.f] = Number(i.value)));
        grid[k] = g;
      }
      const metric = $('#op-metric').value;
      const btn = $('#op-run'); btn.disabled = true;
      const stt = $('#op-status');
      try {
        const data = lastData || await loadData();
        const res = await run('sweep', { code: getCode(), data: data.series, params: S.config.params, config: engineConfig(data), grid, maxRuns: 400 },
          { timeoutMs: 300000, onProgress: (f) => { stt.textContent = `%${Math.round(f * 100)}`; } });
        stt.textContent = `${res.rows.length} kombinasyon denendi`;
        renderSweep(res, metric);
      } catch (e) { stt.textContent = ''; toast(e.message); }
      btn.disabled = false;
    };
  }

  function renderSweep(res, metric) {
    const [label, fmt] = METRICS[metric];
    const valid = res.rows.filter((r) => !r.error && Number.isFinite(r[metric]));
    const best = valid.slice().sort((a, b) => b[metric] - a[metric])[0];
    const lo = Math.min(...valid.map((r) => r[metric])), hi = Math.max(...valid.map((r) => r[metric]));
    const shade = (v) => {
      if (!Number.isFinite(v)) return 'transparent';
      const t = hi > lo ? (v - lo) / (hi - lo) : 0.5;
      return t >= 0.5 ? `rgba(53,173,110,${(t - 0.5) * 1.1 + 0.05})` : `rgba(194,65,59,${(0.5 - t) * 1.1 + 0.05})`;
    };
    const lab = (k) => meta.params[k]?.label || k;
    const apply = (params) => { Object.assign(S.config.params, params); saveDraft(); renderParams(); runBacktest(); toast('Parametreler uygulandı'); };
    let html = '';
    if (res.keys.length === 2) {
      const [k1, k2] = res.keys;
      const at = (a, b) => res.rows.find((r) => r.params[k1] === a && r.params[k2] === b);
      html = `<div class="tbl-wrap"><table class="tbl hm-tbl opt"><tr><th>${esc(lab(k1))} ↓ / ${esc(lab(k2))} →</th>${res.axes[1].map((b) => `<th class="num">${b}</th>`).join('')}</tr>
        ${res.axes[0].map((a) => `<tr><th class="num">${a}</th>${res.axes[1].map((b) => { const r = at(a, b); const v = r?.[metric];
          return `<td class="num hm opt-cell ${r === best ? 'best' : ''}" style="background:${shade(v)}" data-a="${a}" data-b="${b}" title="${r?.error ? esc(r.error) : `${r?.trades ?? 0} işlem`}">${r?.error ? '!' : fmt(v)}</td>`; }).join('')}</tr>`).join('')}</table></div>`;
    } else {
      const [k1] = res.keys;
      html = `<div style="height:220px"><canvas id="op-chart"></canvas></div>
        <div class="tbl-wrap"><table class="tbl"><tr><th>${esc(lab(k1))}</th><th>${label}</th><th>Toplam</th><th>Düşüş</th><th>İşlem</th></tr>
        ${valid.map((r) => `<tr class="opt-row ${r === best ? 'hl' : ''}" data-a="${r.params[k1]}" style="cursor:pointer"><td class="num">${r.params[k1]}</td><td class="num">${fmt(r[metric])}</td><td class="num">${pct(r.totalReturn, 1)}</td><td class="num">${pct(r.maxDrawdown, 1)}</td><td class="num">${r.trades}</td></tr>`).join('')}</table></div>`;
    }
    const robust = robustness(res, metric, best);
    $('#op-out').innerHTML = `<div class="lab-opt-best">${best ? `En iyi ${label.toLowerCase()}: <b>${fmt(best[metric])}</b> · ${res.keys.map((k) => `${esc(lab(k))} = <b>${best.params[k]}</b>`).join(', ')}
      <button class="btn sm primary" id="op-apply">Bu ayarları uygula</button>` : 'Geçerli sonuç yok.'}</div>
      ${robust ? `<p class="small ${robust.ok ? 'up' : 'down'}" style="margin:6px 0 10px">${esc(robust.text)}</p>` : ''}
      ${html}<p class="muted small">Bir hücreye tıklayınca o ayarlarla tam test çalışır.</p>`;
    if (best) $('#op-apply').onclick = () => apply(best.params);
    $$('.opt-cell').forEach((c) => (c.onclick = () => apply({ [res.keys[0]]: Number(c.dataset.a), [res.keys[1]]: Number(c.dataset.b) })));
    $$('.opt-row').forEach((c) => (c.onclick = () => apply({ [res.keys[0]]: Number(c.dataset.a) })));
    if (res.keys.length === 1) {
      chart('op-chart', { type: 'bar', data: { labels: valid.map((r) => r.params[res.keys[0]]), datasets: [{ data: valid.map((r) => (metric === 'sharpe' ? r[metric] : r[metric] * 100)), backgroundColor: valid.map((r) => (r === best ? css('--accent') : '#5a5955')), borderRadius: 3 }] },
        options: { maintainAspectRatio: false, animation: false, plugins: { legend: { display: false }, tooltip: { ...tooltip } }, scales: { x: { grid: { display: false } }, y: { position: 'right', grid: { color: 'rgba(255,255,255,.04)' } } } } });
    }
  }

  // how much of the grid is within 25% of the best: a crude plateau check against overfitting
  function robustness(res, metric, best) {
    if (!best || res.rows.length < 4) return null;
    const valid = res.rows.filter((r) => !r.error && Number.isFinite(r[metric]));
    const sorted = valid.map((r) => r[metric]).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const positive = valid.filter((r) => r.totalReturn > 0).length / valid.length;
    const ok = positive >= 0.7;
    return { ok, text: `Kârlı ayar oranı: %${Math.round(positive * 100)}; ortanca ${METRICS[metric][0].toLowerCase()} ${METRICS[metric][1](median)}. ${ok ? 'Sonuç geniş bir parametre bölgesinde tutuyor.' : 'Sonuç parametre seçimine çok bağlı: aşırı uyum riski yüksek.'}` };
  }

  function tabWalkForward(box) {
    const ps = numericParams();
    const d0 = lastResult.dates[0], d1 = lastResult.dates.at(-1);
    const split = lastResult.dates[Math.floor(lastResult.dates.length * 0.7)];
    box.innerHTML = `<p class="muted small" style="margin-top:0">Dönemi ikiye böler: en iyi parametreler yalnızca <b>eğitim</b> döneminde aranır, sonra stratejinin hiç görmediği <b>test</b> döneminde denenir. Gerçek hayattaki performansa en yakın tahmin budur.</p>
      ${ps.length ? `<div class="lab-opt-row">
        <div><label>Ayrım tarihi</label><input type="date" class="field sm" id="wf-split" value="${split}" min="${d0}" max="${d1}"><div class="muted small">Eğitim: ${fdate(d0)} → ayrım · Test: ayrım → ${fdate(d1)}</div></div>
        <div><label>Taranan parametre</label><select class="field sm" id="wf-p">${ps.map(([k, sp]) => `<option value="${esc(k)}">${esc(sp.label)}</option>`).join('')}</select><div class="lab-axis" id="wf-a"></div></div>
        <div><label>Ölçüt</label><select class="field sm" id="wf-metric">${Object.entries(METRICS).filter(([k]) => k !== 'maxDrawdown').map(([k, [l]]) => `<option value="${k}">${l}</option>`).join('')}</select>
          <button class="btn primary" id="wf-run" style="margin-top:10px">Çalıştır</button><div class="muted small" id="wf-status"></div></div></div>
        <div id="wf-out"></div>` : '<div class="empty">Taranacak sayısal parametre yok.</div>'}`;
    if (!ps.length) return;
    const axis = () => { const d = axisDefaults(meta.params[$('#wf-p').value]); $('#wf-a').innerHTML = `<input type="number" class="field sm" data-f="min" value="${d.min}"><input type="number" class="field sm" data-f="max" value="${d.max}"><input type="number" class="field sm" data-f="step" value="${d.step}">`; };
    axis(); $('#wf-p').onchange = axis;
    $('#wf-run').onclick = async () => {
      const g = {}; $$('#wf-a input').forEach((i) => (g[i.dataset.f] = Number(i.value)));
      const btn = $('#wf-run'); btn.disabled = true;
      try {
        const data = lastData || await loadData();
        const res = await run('walkforward', { code: getCode(), data: data.series, params: S.config.params, config: engineConfig(data), grid: { [$('#wf-p').value]: g }, splitDate: $('#wf-split').value, metric: $('#wf-metric').value },
          { timeoutMs: 300000, onProgress: (f) => { $('#wf-status').textContent = `%${Math.round(f * 100)}`; } });
        $('#wf-status').textContent = '';
        const o = res.outOfSample.metrics, b = res.outOfSample.buyHold, i = res.best;
        const k = Object.keys(i.params)[0];
        $('#wf-out').innerHTML = `<div class="grid g-2" style="margin-top:12px">
          <div class="lab-wf"><div class="note">Eğitim dönemi (en iyi ayar)</div><div class="lab-wf-v">${esc(meta.params[k]?.label || k)} = <b>${i.params[k]}</b></div>
            <dl class="kv"><dt>Yıllık getiri</dt><dd>${pct(i.cagr, 1)}</dd><dt>Sharpe</dt><dd>${ratio(i.sharpe)}</dd><dt>En büyük düşüş</dt><dd>${pct(i.maxDrawdown, 1)}</dd><dt>İşlem</dt><dd>${i.trades}</dd></dl></div>
          <div class="lab-wf"><div class="note">Test dönemi (hiç görmediği veri)</div><div class="lab-wf-v ${dirCls(o.cagr - b.cagr)}">${o.cagr > b.cagr ? 'Al-tut\'u geçti' : 'Al-tut\'un gerisinde'}</div>
            <dl class="kv"><dt>Yıllık getiri</dt><dd>${pct(o.cagr, 1)} <span class="muted">(al-tut ${pct(b.cagr, 1)})</span></dd><dt>Sharpe</dt><dd>${ratio(o.sharpe)} <span class="muted">(${ratio(b.sharpe)})</span></dd>
            <dt>En büyük düşüş</dt><dd>${pct(o.maxDrawdown, 1)} <span class="muted">(${pct(b.maxDrawdown, 1)})</span></dd><dt>İşlem</dt><dd>${o.trades}</dd></dl></div></div>
          <p class="muted small">Eğitimdeki sonuç testte büyük ölçüde korunuyorsa strateji daha güvenilirdir. Testte çöküyorsa eğitimdeki başarı büyük olasılıkla tesadüf veya aşırı uyumdur.</p>`;
      } catch (e) { toast(e.message); }
      btn.disabled = false;
    };
  }

  async function tabRolling(r, box) {
    box.innerHTML = '<div class="empty"><span class="spinner"></span> Kayan pencereler hesaplanıyor…</div>';
    let res;
    try { res = await run('rolling', { dates: r.dates, equity: r.equity, reference: r.buyHold.equity }, { timeoutMs: 30000 }); } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    const block = (w, label) => !w ? `<div class="lab-wf"><div class="note">${label}</div><div class="muted small" style="margin-top:8px">Bu pencere için dönem çok kısa.</div></div>` : `
      <div class="lab-wf"><div class="note">${label} · ${num(w.windows, 0)} pencere</div>
        <div class="lab-wf-v ${w.beatRate >= 0.5 ? 'up' : 'down'}">Al-tut'u geçen pencere: %${num(w.beatRate * 100, 0)}</div>
        <dl class="kv lab-kv"><dt>Kârlı pencere oranı</dt><dd>%${num(w.positiveRate * 100, 0)}</dd><dt>En kötü pencere</dt><dd class="${dirCls(w.worst)}">${pct(w.worst, 1)}</dd>
          <dt>Ortanca pencere</dt><dd class="${dirCls(w.median)}">${pct(w.median, 1)}</dd><dt>En iyi pencere</dt><dd class="${dirCls(w.best)}">${pct(w.best, 1)}</dd></dl></div>`;
    box.innerHTML = `<p class="muted small" style="margin-top:0">Test dönemindeki her günü başlangıç kabul edip sonraki 1 ve 3 yılın getirisine bakar. Stratejiye "yanlış zamanda" başlayan biri ne yaşardı? Tek bir şanslı dönemde kazanan strateji burada ortaya çıkar.</p>
      <div class="grid g-2">${block(res.y1, '1 yıllık pencereler')}${block(res.y3, '3 yıllık pencereler')}</div>
      ${res.y1 ? `<div class="note" style="margin:16px 0 6px">Kayan 1 yıllık getiri</div><div style="height:240px"><canvas id="roll-chart"></canvas></div>` : ''}`;
    if (!res.y1) return;
    const C = COLORS();
    const rows = res.y1.rows;
    const step = Math.max(1, Math.floor(rows.length / 800));
    const pick = rows.filter((_, i) => i % step === 0);
    chart('roll-chart', { type: 'line', data: { labels: pick.map((x) => x.end), datasets: [
      { label: 'Strateji', data: pick.map((x) => x.strategy * 100), borderColor: C.strat, borderWidth: 1.8, pointRadius: 0, tension: 0, fill: false },
      { label: 'Al-tut', data: pick.map((x) => x.reference * 100), borderColor: C.bh, borderWidth: 1.2, borderDash: [4, 3], pointRadius: 0, tension: 0, fill: false }] },
      options: { maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: true, labels: { boxWidth: 10, boxHeight: 2 } }, tooltip: { ...tooltip, displayColors: true, callbacks: { title: (it) => `${fdate(pick[it[0].dataIndex].start)} → ${fdate(it[0].label)}`, label: (c) => ` ${c.dataset.label}: %${num(c.parsed.y, 1)}` } } },
        scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0, callback(v) { return String(this.getLabelForValue(v)).slice(0, 7); } } },
          y: { position: 'right', grid: { color: 'rgba(255,255,255,.04)' }, ticks: { callback: (v) => `%${v}` } } } } });
  }

  async function tabMonteCarlo(r, box) {
    box.innerHTML = '<div class="empty"><span class="spinner"></span> 1.000 alternatif geçmiş üretiliyor…</div>';
    let mc;
    try { mc = await run('montecarlo', { equity: r.equity, options: { runs: 1000, block: 20 } }, { timeoutMs: 60000 }); } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    if (!mc) { box.innerHTML = '<div class="empty">Monte Carlo için dönem çok kısa (en az 40 gün).</div>'; return; }
    const t = mc.totalReturn, d = mc.maxDrawdown, actual = r.metrics.totalReturn;
    const rank = mc.finals.filter((x) => x < actual).length / mc.finals.length;
    box.innerHTML = `<p class="muted small" style="margin-top:0">Stratejinin günlük getirileri 20 günlük bloklar halinde karıştırılarak ${num(mc.runs, 0)} alternatif geçmiş üretildi. Aynı kurallar, farklı şans: sonuç bu bantta herhangi bir yere düşebilirdi.</p>
      <div class="lab-kpis" style="grid-template-columns:repeat(5,minmax(0,1fr))">
        ${kpi('Kötü senaryo (%5)', `<span class="${dirCls(t.p5)}">${pct(t.p5, 1)}</span>`, `20 geçmişten 1'i bundan kötü`)}
        ${kpi('Ortanca', `<span class="${dirCls(t.p50)}">${pct(t.p50, 1)}</span>`, `Gerçekleşen ${pct(actual, 1)}`)}
        ${kpi('İyi senaryo (%95)', `<span class="${dirCls(t.p95)}">${pct(t.p95, 1)}</span>`, '20 geçmişten 1\'i bundan iyi')}
        ${kpi('Zarar olasılığı', `%${num(mc.probLoss * 100, 0)}`, 'dönem sonunda başlangıcın altında')}
        ${kpi('Olası en büyük düşüş', `<span class="down">${pct(d.p50, 1)}</span>`, `kötü senaryoda ${pct(d.p5, 1)}`)}
      </div>
      <div class="grid g-2"><div><div class="note" style="margin-bottom:6px">Alternatif sermaye yolları (60 örnek)</div><div style="height:240px"><canvas id="mc-paths"></canvas></div></div>
        <div><div class="note" style="margin-bottom:6px">Dönem sonu getirisinin dağılımı</div><div style="height:240px"><canvas id="mc-hist"></canvas></div></div></div>
      <p class="muted small">Gerçekleşen sonuç dağılımın %${num(rank * 100, 0)}. yüzdeliğinde. ${rank > 0.9 ? 'Gerçek sonuç alternatiflerin çoğundan iyi: getirilerin sırası lehine işlemiş olabilir.' : rank < 0.1 ? 'Gerçek sonuç alternatiflerin çoğundan kötü: sıralama aleyhine işlemiş.' : 'Gerçek sonuç tipik bir senaryo.'} Bu yöntem getirilerin dağılımını korur; kuralların gelecekte de aynı getiriyi üreteceğini varsayar.</p>`;
    const C = COLORS();
    chart('mc-paths', { type: 'line', data: { labels: mc.paths[0].map((_, i) => i), datasets: mc.paths.map((p, i) => ({ data: p.map((x) => (x - 1) * 100), borderColor: i === 0 ? C.strat : 'rgba(163,162,157,.18)', borderWidth: i === 0 ? 1.6 : 1, pointRadius: 0, tension: 0 })) },
      options: { maintainAspectRatio: false, animation: false, events: [], plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { display: false }, y: { position: 'right', grid: { color: 'rgba(255,255,255,.04)' }, ticks: { callback: (v) => `%${v}` } } } } });
    const lo = Math.min(...mc.finals), hi = Math.max(...mc.finals), bins = 30, w = (hi - lo) / bins || 1;
    const counts = new Array(bins).fill(0);
    mc.finals.forEach((x) => counts[Math.min(bins - 1, Math.floor((x - lo) / w))]++);
    const labels = counts.map((_, i) => lo + (i + 0.5) * w);
    const ai = Math.min(bins - 1, Math.max(0, Math.floor((actual - lo) / w)));
    chart('mc-hist', { type: 'bar', data: { labels: labels.map((x) => `%${num(x * 100, 0)}`), datasets: [{ data: counts, backgroundColor: labels.map((x, i) => (i === ai ? C.strat : x < 0 ? 'rgba(194,65,59,.55)' : 'rgba(53,173,110,.45)')), borderRadius: 2, barPercentage: 1, categoryPercentage: 0.95 }] },
      options: { maintainAspectRatio: false, animation: false, plugins: { legend: { display: false }, tooltip: { ...tooltip, callbacks: { label: (c) => `${c.parsed.y} senaryo` } } },
        scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 7, maxRotation: 0 } }, y: { display: false } } } });
  }

  function tabLog(r, box) {
    box.innerHTML = `${r.logs.length ? `<div class="lab-log">${r.logs.map((l) => `<div><span class="muted">${esc(l.date)}</span> ${esc(l.msg)}</div>`).join('')}</div>` : '<div class="empty">Kod <code>ctx.log(...)</code> ile buraya not yazabilir.</div>'}
      <div class="note" style="margin:14px 0 6px">Tüm emirler (son ${num(r.fills.length, 0)})</div>
      <div class="tbl-wrap" style="max-height:360px;overflow:auto"><table class="tbl"><tr><th>Tarih</th><th>Sembol</th><th>Yön</th><th>Adet</th><th>Fiyat</th><th>Komisyon</th><th>Neden</th></tr>
      ${r.fills.slice().reverse().map((f) => `<tr><td>${fdate(f.date)}</td><td><b>${esc(f.sym)}</b></td><td><span class="pill ${f.side === 'buy' ? 'pos' : 'neg'}">${f.side === 'buy' ? 'AL' : 'SAT'}</span></td>
        <td class="num">${num(f.shares, 0)}</td><td class="num">${num(f.price)}</td><td class="num">${num(f.fee)}</td><td class="muted small">${esc(f.reason)}</td></tr>`).join('')}</table></div>`;
  }

  function downloadCsv(r) {
    const head = 'sembol;giris_tarihi;cikis_tarihi;adet;giris_fiyati;cikis_fiyati;gun;kar_zarar;getiri;neden\n';
    const body = r.trades.map((t) => [t.sym, t.entryDate, t.exitDate, t.shares, t.entryPrice.toFixed(4), t.exitPrice.toFixed(4), t.bars, t.pnl.toFixed(2), (t.returnPct * 100).toFixed(2), `"${(t.reason || '').replace(/"/g, "'")}"`].join(';')).join('\n');
    const blob = new Blob(['﻿' + head + body], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${fileSlug(S.name)}_islemler.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ------------------------------------------------------------------ review
  function reportFor(r) {
    const pick = (m) => m && ({ totalReturn: m.totalReturn, cagr: m.cagr, volatility: m.volatility, sharpe: m.sharpe, sortino: m.sortino, maxDrawdown: m.maxDrawdown,
      maxDrawdownDays: m.maxDrawdownDays, calmar: m.calmar, trades: m.trades, winRate: m.winRate, avgTrade: m.avgTrade, profitFactor: Number.isFinite(m.profitFactor) ? m.profitFactor : null,
      exposure: m.exposure, years: m.years, avgBarsHeld: m.avgBarsHeld });
    return {
      name: S.name, description: meta?.description, code: getCode(),
      settings: { symbols: r.symbols, from: r.dates[0], to: r.dates.at(-1), currency: S.config.currency, commission_bps: S.config.commissionBps, slippage_bps: S.config.slippageBps, fill: S.config.fill, params: r.params },
      metrics: pick(r.metrics), buy_hold: pick(r.buyHold.metrics), benchmark: pick(r.benchmark?.metrics), benchmark_name: r.benchmark?.name,
      deposit: r.deposit ? { annual_rate_pct: S.config.cashRatePct, totalReturn: r.deposit.metrics.totalReturn, cagr: r.deposit.metrics.cagr } : null,
      yearly: r.periodReturns.yearly,
      relative_to_benchmark: r.relative || null,
    };
  }
  async function review() {
    const card = $('#lab-review-card');
    card.style.display = 'block';
    card.innerHTML = '<div class="empty"><span class="spinner"></span> Grok sonuçları inceliyor…</div>';
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    try {
      const r = await api('/strategy/review', { method: 'POST', body: JSON.stringify(reportFor(lastResult)) });
      const V = { promising: ['Umut verici', 'pos'], mixed: ['Karışık', 'acc'], weak: ['Zayıf', 'neg'], insufficient_data: ['Veri yetersiz', ''] }[r.verdict] || ['–', ''];
      card.innerHTML = `<div class="card-head"><h2>Değerlendirme</h2><span class="hint">${r.provider === 'rules' ? 'Kural tabanlı' : `Grok · ${esc(r.model || '')}`}</span></div>
        <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px"><span class="pill ${V[1]}">${V[0]}</span><span>${esc(r.summary)}</span></div>
        <div class="grid g-3">
          <div><div class="note up">Güçlü yanlar</div><ul class="lab-ul">${(r.strengths || []).map((x) => `<li>${esc(x)}</li>`).join('') || '<li class="muted">–</li>'}</ul></div>
          <div><div class="note down">Zayıf yanlar</div><ul class="lab-ul">${(r.weaknesses || []).map((x) => `<li>${esc(x)}</li>`).join('') || '<li class="muted">–</li>'}</ul></div>
          <div><div class="note">Denenebilecekler</div><ul class="lab-ul">${(r.suggestions || []).map((x) => `<li><button class="linkbtn lab-sugg">${esc(x)}</button></li>`).join('') || '<li class="muted">–</li>'}</ul></div>
        </div><p class="muted small" style="margin:10px 0 0">Bir öneriye tıklarsan Grok'a stratejiyi o yönde değiştirmesini söyleyen bir istek hazırlanır. Yatırım tavsiyesi değildir.</p>`;
      $$('.lab-sugg').forEach((b) => (b.onclick = () => { $('#lab-prompt').value = b.textContent; $('#lab-prompt').focus(); window.scrollTo({ top: 0, behavior: 'smooth' }); }));
    } catch (e) { card.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }

  // ------------------------------------------------------------------ export / import
  function exportStrategy() {
    const doc = { format: 'finsent-strategy', version: 1, exported_at: new Date().toISOString(), name: S.name, description: meta?.description || null,
      prompt: S.prompt || null, code: getCode(), config: { ...S.config } };
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${fileSlug(S.name)}.finsent.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  async function importStrategy(file) {
    if (file.size > 500000) { toast('Dosya çok büyük'); return; }
    const text = await file.text();
    let doc = null;
    try { doc = JSON.parse(text); } catch { /* plain code */ }
    if (doc && typeof doc === 'object') {
      if (doc.format !== 'finsent-strategy' || typeof doc.code !== 'string') { toast('Tanınmayan dosya biçimi'); return; }
      S = { ...defaultState(), name: String(doc.name || 'İçe aktarılan strateji').slice(0, 120), prompt: String(doc.prompt || ''), code: doc.code, chat: [],
        config: { ...defaultState().config, ...(doc.config && typeof doc.config === 'object' ? doc.config : {}) } };
      S.config.symbols = (Array.isArray(S.config.symbols) ? S.config.symbols : []).map(String).filter((x) => /^[A-Z0-9]{2,12}$/.test(x)).slice(0, 40);
    } else {
      S.id = null; S.code = text; S.name = file.name.replace(/\.(js|txt)$/i, '');
    }
    setCode(S.code); $('#lab-name').value = S.name;
    bindSettings(); renderSymbols(); renderChat(); saveDraft();
    if (await inspect(false)) toast('Strateji içe aktarıldı. Kaydetmek için "Kaydet"e bas.');
  }

  // ------------------------------------------------------------------ save / load
  function summaryOf(r) {
    if (!r) return null;
    const m = r.metrics;
    return { from: r.dates[0], to: r.dates.at(-1), totalReturn: m.totalReturn, cagr: m.cagr, maxDrawdown: m.maxDrawdown, sharpe: m.sharpe, trades: m.trades, winRate: m.winRate,
      buyHoldCagr: r.buyHold.metrics.cagr, benchmarkCagr: r.benchmark?.metrics.cagr ?? null, final: m.final, currency: S.config.currency, at: new Date().toISOString(),
      spark: r.equity.filter((_, i) => i % Math.max(1, Math.floor(r.equity.length / 60)) === 0) };
  }
  async function saveStrategy() {
    const name = ($('#lab-name').value || S.name || '').trim() || prompt('Strateji adı?');
    if (!name) return;
    S.name = name; $('#lab-name').value = name;
    try {
      const out = await api('/strategies', { method: 'POST', body: JSON.stringify({ id: S.id, name, description: meta?.description || null, prompt: S.prompt || null, code: getCode(), config: S.config, last_result: summaryOf(lastResult) }) });
      S.id = out.id; saveDraft();
      if (location.hash !== `#/strateji/${out.id}`) history.replaceState(null, '', `#/strateji/${out.id}`);
      toast('Strateji kaydedildi');
    } catch (e) { toast(`Kaydedilemedi: ${e.message}`); }
  }
  async function loadSaved(id) {
    try {
      const s = await api(`/strategies/${id}`);
      S = { ...defaultState(), id: s.id, name: s.name, prompt: s.prompt || '', code: s.code, chat: [], config: { ...defaultState().config, ...(s.config || {}) } };
      setCode(s.code); $('#lab-name').value = s.name;
      bindSettings(); renderSymbols(); renderChat(); saveDraft();
    } catch (e) { toast(e.message); }
  }

  // ------------------------------------------------------------------ saved list page
  window.pageStrategies = async function pageStrategies(v) {
    v.innerHTML = `<div class="page-head"><div><h1>Kayıtlı stratejiler</h1><div class="sub">Birkaçını seçip aynı dönemde yan yana test edebilirsin.</div></div>
      <a class="btn primary" href="#/strateji">Laboratuvara git</a></div><div class="card" id="sl-list">${skel(240)}</div>
      <div class="card" id="sl-cmp" style="margin-top:16px;display:none"></div>`;
    const { strategies } = await api('/strategies');
    const box = $('#sl-list');
    if (!strategies.length) { box.innerHTML = '<div class="empty">Henüz kayıtlı strateji yok. Laboratuvarda bir strateji test edip "Kaydet"e bas.</div>'; return; }
    box.innerHTML = `<div class="toolbar" style="margin:0 0 12px"><span class="muted small">Karşılaştırma dönemi</span>
        <input type="date" class="field sm" id="sl-from" value="${yearsAgo(5)}"><span class="muted">→</span><input type="date" class="field sm" id="sl-to" value="${today}">
        <button class="btn sm primary" id="sl-go" disabled>Seçilenleri karşılaştır</button><span class="muted small" id="sl-st"></span></div>
      <div class="tbl-wrap"><table class="tbl"><tr><th></th><th>Strateji</th><th>Semboller</th><th>Dönem</th><th>Yıllık</th><th>Al-tut</th><th>Düşüş</th><th>Sharpe</th><th>İşlem</th><th></th><th></th></tr>
      ${strategies.map((st) => { const r = st.last_result || {}; const c = st.config || {};
        return `<tr><td><input type="checkbox" class="sl-pick" value="${st.id}" style="accent-color:var(--accent)"></td><td><a href="#/strateji/${st.id}"><b>${esc(st.name)}</b></a><div class="muted small clamp">${esc(st.description || '')}</div></td>
          <td class="small">${esc((c.symbols || []).slice(0, 5).join(', '))}${(c.symbols || []).length > 5 ? ` +${c.symbols.length - 5}` : ''}</td>
          <td class="small muted">${r.from ? `${fdate(r.from)} – ${fdate(r.to)}` : '–'}</td>
          <td class="num ${dirCls(r.cagr)}">${pct(r.cagr, 1)}</td><td class="num muted">${pct(r.buyHoldCagr, 1)}</td><td class="num down">${pct(r.maxDrawdown, 1)}</td>
          <td class="num">${ratio(r.sharpe)}</td><td class="num">${Number.isFinite(r.trades) ? num(r.trades, 0) : '–'}</td><td>${r.spark ? spark(r.spark, 90, 26) : ''}</td>
          <td><button class="linkbtn sl-del" data-id="${st.id}" title="Sil">Sil</button></td></tr>`; }).join('')}</table></div>`;
    const picks = () => $$('.sl-pick').filter((x) => x.checked).map((x) => Number(x.value));
    $$('.sl-pick').forEach((x) => (x.onchange = () => { $('#sl-go').disabled = picks().length < 1; }));
    $$('.sl-del').forEach((b) => (b.onclick = async () => {
      if (!confirm('Strateji silinsin mi?')) return;
      await api(`/strategies/${b.dataset.id}/delete`, { method: 'POST', body: '{}' });
      window.pageStrategies(v);
    }));
    $('#sl-go').onclick = () => compare(strategies.filter((x) => picks().includes(x.id)), $('#sl-from').value, $('#sl-to').value);
  };

  // runs each picked strategy with its own stocks, parameters and costs, over one common period
  async function compare(list, from, to) {
    const out = $('#sl-cmp'), st = $('#sl-st');
    out.style.display = 'block';
    out.innerHTML = `<div class="empty"><span class="spinner"></span> ${list.length} strateji test ediliyor…</div>`;
    const rows = [];
    for (const [k, item] of list.entries()) {
      st.textContent = `${k + 1}/${list.length}: ${item.name}`;
      try {
        const full = await api(`/strategies/${item.id}`);
        const c = { ...defaultState().config, ...(full.config || {}), from, to };
        const data = await loadData(c);
        const r = await run('backtest', { code: full.code, data: data.series, params: c.params || {}, config: engineConfig(data, c), benchmark: data.benchmark }, { timeoutMs: 60000 });
        rows.push({ name: full.name, r, c });
      } catch (e) { rows.push({ name: item.name, error: e.message }); }
    }
    st.textContent = '';
    const ok = rows.filter((x) => x.r);
    const palette = [css('--accent'), '#d8d6cf', '#7fbf8f', '#e08f6a', '#a3a29d', '#c9a227', '#6e9c87', '#b5655a'];
    const bm = ok.find((x) => x.r.benchmark)?.r.benchmark;
    out.innerHTML = `<div class="card-head"><h2>Karşılaştırma · ${fdate(from)} – ${fdate(to)}</h2><span class="hint">her strateji kendi hisseleri, parametreleri ve maliyetleriyle</span></div>
      <div class="chart-legend" style="position:static;margin-bottom:8px">${ok.map((x, i) => `<span><i class="line-key" style="background:${palette[i % palette.length]}"></i>${esc(x.name)}</span>`).join('')}${bm ? '<span><i class="line-key" style="background:#5a5955"></i>BIST 100</span>' : ''}</div>
      <div style="height:300px"><canvas id="sl-chart"></canvas></div>
      <div class="tbl-wrap" style="margin-top:14px"><table class="tbl"><tr><th>Strateji</th><th>Toplam</th><th>Yıllık</th><th>Al-tut yıllık</th><th>Düşüş</th><th>Sharpe</th><th>Sortino</th><th>İşlem</th><th>Kazanma</th><th>Piyasada</th></tr>
        ${rows.map((x) => x.error ? `<tr><td><b>${esc(x.name)}</b></td><td colspan="9" class="down small">${esc(x.error)}</td></tr>` : (() => { const m = x.r.metrics;
          return `<tr><td><b>${esc(x.name)}</b><div class="muted small">${esc(x.r.symbols.slice(0, 4).join(', '))}${x.r.symbols.length > 4 ? '…' : ''}</div></td><td class="num ${dirCls(m.totalReturn)}">${pct(m.totalReturn, 1)}</td>
            <td class="num ${dirCls(m.cagr)}"><b>${pct(m.cagr, 1)}</b></td><td class="num muted">${pct(x.r.buyHold.metrics.cagr, 1)}</td><td class="num down">${pct(m.maxDrawdown, 1)}</td>
            <td class="num">${ratio(m.sharpe)}</td><td class="num">${ratio(m.sortino)}</td><td class="num">${m.trades}</td><td class="num">${m.winRate !== null ? `%${num(m.winRate * 100, 0)}` : '–'}</td>
            <td class="num">${m.exposure !== null ? `%${num(m.exposure * 100, 0)}` : '–'}</td></tr>`; })()).join('')}</table></div>
      <p class="muted small">Eğriler aynı başlangıç sermayesine göre ölçeklendi. Farklı hisse sepetleri karşılaştırılıyorsa fark stratejiden çok hisse seçiminden gelebilir.</p>`;
    if (!ok.length) return;
    // union calendar, each curve rebased to 100
    const dates = [...new Set(ok.flatMap((x) => x.r.dates))].sort();
    const series = ok.map((x) => { const m = new Map(x.r.dates.map((d, i) => [d, x.r.equity[i]])); let last = null; const base = x.r.equity[0];
      return dates.map((d) => { if (m.has(d)) last = m.get(d); return last === null ? null : (last / base) * 100; }); });
    const ds = series.map((data, i) => ({ label: ok[i].name, data, borderColor: palette[i % palette.length], borderWidth: i === 0 ? 2 : 1.5, pointRadius: 0, fill: false, tension: 0, spanGaps: true }));
    if (bm) { const bmap = new Map(); const ref = ok.find((x) => x.r.benchmark).r; ref.dates.forEach((d, i) => bmap.set(d, ref.benchmark.equity[i]));
      let last = null; const base = ref.benchmark.equity[0];
      ds.push({ label: 'BIST 100', data: dates.map((d) => { if (bmap.has(d)) last = bmap.get(d); return last === null ? null : (last / base) * 100; }), borderColor: '#5a5955', borderWidth: 1.2, borderDash: [4, 3], pointRadius: 0, fill: false, tension: 0, spanGaps: true }); }
    chart('sl-chart', { type: 'line', data: { labels: dates, datasets: ds },
      options: { maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false }, tooltip: { ...tooltip, displayColors: true, callbacks: { title: (it) => fdate(it[0].label), label: (c) => ` ${c.dataset.label}: ${num(c.parsed.y, 1)}` } } },
        scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0, callback(v) { return String(this.getLabelForValue(v)).slice(0, 7); } } },
          y: { type: 'logarithmic', position: 'right', grid: { color: 'rgba(255,255,255,.04)' }, ticks: { maxTicksLimit: 6, callback: (x) => num(x, 0) } } } } });
  }
})();
