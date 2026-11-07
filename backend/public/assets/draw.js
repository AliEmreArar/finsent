// Chart drawing tools (trend line, horizontal line, channel, Fibonacci, rectangle) on top of
// lightweight-charts. Anchors are stored as (time, price) so drawings survive zooming and
// switching candle sizes; they are saved per symbol on the server, where the Grok agent reads them.
'use strict';
(function () {
  const COLORS = { user: '#dcae57', agent: '#d4d3ce' };
  const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const NEED = { trend: 2, hline: 1, channel: 3, fib: 2, rect: 2 };
  const NAMES = { trend: 'Trend çizgisi', hline: 'Yatay çizgi', channel: 'Kanal', fib: 'Fibonacci', rect: 'Dikdörtgen' };
  let R = null;            // chart refs from app.js
  let canvas, ctx2d, times = [], dur = 864e5;
  let drawings = [], tool = null, pending = [], hover = null, selected = null, saveTimer = null, loadedFor = null;

  // ---------------------------------------------------------------- time <-> logical index
  const naiveMs = (s) => Date.parse(String(s).replace(' ', 'T') + (String(s).length <= 10 ? 'T00:00:00Z' : ':00Z'));
  function logicalOf(ms) {
    const n = times.length;
    if (!n) return 0;
    if (ms <= times[0]) return (ms - times[0]) / dur;
    if (ms >= times[n - 1]) return n - 1 + (ms - times[n - 1]) / dur;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (times[m] <= ms) lo = m; else hi = m; }
    return lo + (ms - times[lo]) / (times[hi] - times[lo]);
  }
  function msOf(logical) {
    const n = times.length;
    if (logical <= 0) return times[0] + logical * dur;
    if (logical >= n - 1) return times[n - 1] + (logical - (n - 1)) * dur;
    const i = Math.floor(logical), f = logical - i;
    return times[i] + f * (times[i + 1] - times[i]);
  }
  const X = (ms) => R.chart.timeScale().logicalToCoordinate(logicalOf(ms));
  const Y = (p) => R.candle.priceToCoordinate(p);
  const fmtT = (ms) => { const d = new Date(ms); const iso = d.toISOString(); return R?.intraday ? iso.slice(0, 16).replace('T', ' ') : iso.slice(0, 10); };

  // ---------------------------------------------------------------- render
  function resize() {
    if (!canvas || !R) return;
    const r = R.el.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    canvas.width = r.width * dpr; canvas.height = r.height * dpr;
    canvas.style.width = `${r.width}px`; canvas.style.height = `${r.height}px`;
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    render();
  }
  function line(x1, y1, x2, y2, color, width = 1.5, dash = []) {
    ctx2d.strokeStyle = color; ctx2d.lineWidth = width; ctx2d.setLineDash(dash);
    ctx2d.beginPath(); ctx2d.moveTo(x1, y1); ctx2d.lineTo(x2, y2); ctx2d.stroke(); ctx2d.setLineDash([]);
  }
  function label(text, x, y, color) {
    ctx2d.font = '11px Inter, system-ui, sans-serif';
    const w = ctx2d.measureText(text).width + 8;
    ctx2d.fillStyle = 'rgba(18,18,20,.85)'; ctx2d.fillRect(x, y - 9, w, 16);
    ctx2d.fillStyle = color; ctx2d.fillText(text, x + 4, y + 3);
  }
  const plotRight = () => R.el.clientWidth - (R.chart.priceScale('right').width() || 60);
  function extend(x1, y1, x2, y2) {   // ray from p1 through p2 to the right edge
    const xr = plotRight();
    if (x2 === x1) return [x2, y2];
    return [xr, y1 + (y2 - y1) * ((xr - x1) / (x2 - x1))];
  }
  function drawOne(d, preview = false) {
    const c = d === selected ? '#ffffff' : COLORS[d.src] || COLORS.user;
    const P = d.pts.map((q) => [X(q.t), Y(q.p)]);
    if (P.some(([x, y]) => x === null || y === null)) return;
    const w = d === selected ? 2.2 : 1.6;
    if (d.type === 'hline') {
      line(0, P[0][1], plotRight(), P[0][1], c, w, [6, 4]);
      label(`${d.label ? d.label + ' ' : ''}${num(d.pts[0].p)}`, 6, P[0][1] - 8, c);
    } else if (d.type === 'trend' && P.length >= 2) {
      line(P[0][0], P[0][1], P[1][0], P[1][1], c, w);
      const [xe, ye] = extend(...P[0], ...P[1]);
      if (xe > P[1][0]) line(P[1][0], P[1][1], xe, ye, c, 1, [3, 4]);
      if (d.label) label(d.label, P[1][0] + 4, P[1][1] - 10, c);
    } else if (d.type === 'channel' && P.length >= 2) {
      const off = P[2] ? P[2][1] - (P[0][1] + (P[1][1] - P[0][1]) * ((P[2][0] - P[0][0]) / ((P[1][0] - P[0][0]) || 1))) : 0;
      const [xe, ye] = extend(...P[0], ...P[1]);
      ctx2d.fillStyle = 'rgba(220,174,87,.07)';
      ctx2d.beginPath(); ctx2d.moveTo(P[0][0], P[0][1]); ctx2d.lineTo(xe, ye); ctx2d.lineTo(xe, ye + off); ctx2d.lineTo(P[0][0], P[0][1] + off); ctx2d.closePath(); ctx2d.fill();
      line(P[0][0], P[0][1], xe, ye, c, w);
      if (P[2]) {
        line(P[0][0], P[0][1] + off, xe, ye + off, c, w);
        line(P[0][0], P[0][1] + off / 2, xe, ye + off / 2, c, 1, [2, 4]);
      }
      if (d.label) label(d.label, P[0][0] + 4, P[0][1] - 10, c);
    } else if (d.type === 'fib' && P.length >= 2) {
      const [a, b] = d.pts, xr = plotRight(), x0 = Math.min(P[0][0], P[1][0]);
      line(P[0][0], P[0][1], P[1][0], P[1][1], c, 1, [2, 3]);
      FIB.forEach((f) => {
        const p = b.p - (b.p - a.p) * f, y = Y(p);
        line(x0, y, xr, y, f === 0.5 || f === 0.618 ? c : 'rgba(220,174,87,.55)', 1);
        label(`${(f * 100).toFixed(1).replace('.0', '')}%  ${num(p)}`, x0 + 2, y - 8, c);
      });
    } else if (d.type === 'rect' && P.length >= 2) {
      ctx2d.fillStyle = 'rgba(220,174,87,.08)';
      ctx2d.fillRect(Math.min(P[0][0], P[1][0]), Math.min(P[0][1], P[1][1]), Math.abs(P[1][0] - P[0][0]), Math.abs(P[1][1] - P[0][1]));
      ctx2d.strokeStyle = c; ctx2d.lineWidth = w; ctx2d.setLineDash([]);
      ctx2d.strokeRect(Math.min(P[0][0], P[1][0]), Math.min(P[0][1], P[1][1]), Math.abs(P[1][0] - P[0][0]), Math.abs(P[1][1] - P[0][1]));
    }
    if (preview || d === selected) P.forEach(([x, y]) => { ctx2d.fillStyle = c; ctx2d.beginPath(); ctx2d.arc(x, y, 3.5, 0, 7); ctx2d.fill(); });
  }
  function render() {
    if (!ctx2d || !R) return;
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    drawings.filter((d) => (d.ccy || 'TRY') === R.currency).forEach((d) => drawOne(d));
    if (tool && pending.length) drawOne({ type: tool, pts: [...pending, ...(hover ? [hover] : [])], src: 'user' }, true);
  }

  // ---------------------------------------------------------------- interaction
  function pointFromEvent(e) {
    const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const lg = R.chart.timeScale().coordinateToLogical(x), p = R.candle.coordinateToPrice(y);
    if (lg === null || p === null) return null;
    return { t: msOf(lg), p: Number(p.toFixed(4)) };
  }
  function distToSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / L)) : 0;
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }
  function hit(e) {
    const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null, bd = 7;
    for (const d of drawings.filter((q) => (q.ccy || 'TRY') === R.currency)) {
      const P = d.pts.map((q) => [X(q.t), Y(q.p)]);
      let dist = Infinity;
      if (d.type === 'hline') dist = Math.abs(y - P[0][1]);
      else if (d.type === 'rect') { const [a, b] = P; dist = Math.min(distToSeg(x, y, a[0], a[1], b[0], a[1]), distToSeg(x, y, a[0], b[1], b[0], b[1]), distToSeg(x, y, a[0], a[1], a[0], b[1]), distToSeg(x, y, b[0], a[1], b[0], b[1])); }
      else if (d.type === 'fib') dist = Math.min(...FIB.map((f) => Math.abs(y - Y(d.pts[1].p - (d.pts[1].p - d.pts[0].p) * f)))) + (x < Math.min(P[0][0], P[1][0]) ? 99 : 0);
      else { const [xe, ye] = extend(...P[0], ...P[1]); dist = distToSeg(x, y, P[0][0], P[0][1], xe, ye);
        if (d.type === 'channel' && P[2]) { const off = P[2][1] - (P[0][1] + (P[1][1] - P[0][1]) * ((P[2][0] - P[0][0]) / ((P[1][0] - P[0][0]) || 1))); dist = Math.min(dist, distToSeg(x, y, P[0][0], P[0][1] + off, xe, ye + off)); } }
      if (dist < bd) { bd = dist; best = d; }
    }
    return best;
  }
  function onClick(e) {
    if (!R) return;
    if (!tool) {   // select mode
      selected = hit(e); render(); updateList(); return;
    }
    const pt = pointFromEvent(e);
    if (!pt) return;
    pending.push(pt);
    if (pending.length >= NEED[tool]) {
      drawings.push({ id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, type: tool, pts: pending, ccy: R.currency, src: 'user' });
      pending = []; hover = null;
      if (!e.shiftKey) setTool(null);   // shift keeps the tool armed for several drawings
      save();
    }
    render();
  }
  function onMove(e) { if (tool && pending.length) { hover = pointFromEvent(e); render(); } }
  function setTool(t) {
    tool = t; pending = []; hover = null;
    canvas.style.pointerEvents = t ? 'auto' : 'none';
    canvas.style.cursor = t ? 'crosshair' : 'default';
    document.querySelectorAll('#draw-bar [data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === (t || 'select')));
    const hint = document.getElementById('draw-hint');
    if (hint) hint.textContent = t ? `${NAMES[t]}: ${NEED[t] === 1 ? 'fiyata tıkla' : NEED[t] === 3 ? '2 nokta ile taban çizgisi, 3. tık kanal genişliği' : '2 noktaya tıkla'} · Esc iptal · Shift ile art arda çiz` : '';
  }

  // ---------------------------------------------------------------- persistence
  async function load(symbol) {
    loadedFor = symbol;
    try { drawings = (await fetch(`/api/drawings/${symbol}`).then((r) => r.json())).drawings || []; } catch { drawings = []; }
    updateList(); render();
  }
  function save() {
    updateList();
    clearTimeout(saveTimer);
    const sym = loadedFor;
    saveTimer = setTimeout(() => fetch(`/api/drawings/${sym}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ drawings }) }).catch(() => {}), 300);
  }
  function updateList() {
    const box = document.getElementById('draw-list');
    if (!box) return;
    const mine = drawings.filter((d) => !R || (d.ccy || 'TRY') === R.currency);
    box.innerHTML = mine.map((d) => `<span class="pill ${d === selected ? 'acc' : ''}" data-id="${d.id}" title="${fmtT(d.pts[0].t)}">${d.src === 'agent' ? '✦ ' : ''}${NAMES[d.type]}${d.label ? ': ' + d.label : ''}
      <button class="pill-x" data-del="${d.id}" title="Sil">✕</button></span>`).join('');
    box.querySelectorAll('[data-del]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); drawings = drawings.filter((d) => d.id !== b.dataset.del); selected = null; save(); render(); });
    box.querySelectorAll('[data-id]').forEach((b) => b.onclick = () => { selected = drawings.find((d) => d.id === b.dataset.id) || null; render(); updateList(); });
  }

  // ---------------------------------------------------------------- summary for the agent
  function summary() {
    if (!R || !drawings.length) return [];
    const lastMs = times[times.length - 1], close = R.lastClose;
    const at = (a, b, ms) => a.p + (b.p - a.p) * ((ms - a.t) / ((b.t - a.t) || 1));
    const rel = (v) => (close && v ? Number(((close / v - 1) * 100).toFixed(2)) : null);
    return drawings.filter((d) => (d.ccy || 'TRY') === R.currency).slice(0, 15).map((d) => {
      const pts = d.pts.map((q) => ({ time: fmtT(q.t), price: Number(q.p.toFixed(4)) }));
      const o = { type: d.type, by: d.src === 'agent' ? 'agent' : 'user', label: d.label || null, points: pts };
      if (d.type === 'hline') Object.assign(o, { level: d.pts[0].p, price_vs_level_pct: rel(d.pts[0].p) });
      if (d.type === 'trend' || d.type === 'channel') {
        const [a, b] = d.pts, now = at(a, b, lastMs), perDay = (b.p - a.p) / (((b.t - a.t) || 1) / 864e5);
        Object.assign(o, { line_value_now: Number(now.toFixed(4)), slope_per_day: Number(perDay.toFixed(4)),
          slope_pct_per_month: Number((perDay * 21 / now * 100).toFixed(2)), price_vs_line_pct: rel(now) });
        if (d.type === 'channel' && d.pts[2]) {
          const off = d.pts[2].p - at(a, b, d.pts[2].t), other = now + off;
          Object.assign(o, { other_line_now: Number(other.toFixed(4)), channel_width_pct: Number((Math.abs(off) / now * 100).toFixed(2)),
            position_in_channel_pct: close ? Number((((close - Math.min(now, other)) / Math.abs(off)) * 100).toFixed(1)) : null });
        }
      }
      if (d.type === 'fib') o.levels = FIB.map((f) => ({ ratio: f, price: Number((d.pts[1].p - (d.pts[1].p - d.pts[0].p) * f).toFixed(4)) }));
      if (d.type === 'rect') Object.assign(o, { top: Math.max(d.pts[0].p, d.pts[1].p), bottom: Math.min(d.pts[0].p, d.pts[1].p) });
      return o;
    });
  }

  // ---------------------------------------------------------------- public API
  window.__draw = {
    attach(refs) {
      R = refs;
      times = refs.times; const diffs = times.slice(-60).map((t, i, a) => (i ? t - a[i - 1] : null)).filter(Boolean).sort((a, b) => a - b);
      dur = diffs.length ? diffs[Math.floor(diffs.length / 2)] : 864e5;
      if (!canvas || !refs.el.contains(canvas)) {
        canvas = document.createElement('canvas'); canvas.className = 'draw-layer'; ctx2d = canvas.getContext('2d');
        refs.el.appendChild(canvas);
        canvas.addEventListener('click', onClick); canvas.addEventListener('mousemove', onMove);
        new ResizeObserver(resize).observe(refs.el);
      }
      refs.chart.timeScale().subscribeVisibleLogicalRangeChange(render);
      refs.chart.subscribeCrosshairMove(() => { if (!tool) render(); });
      // clicks on the chart itself select drawings when no tool is armed
      if (!refs.el.__drawClick) {
        refs.el.__drawClick = true;
        refs.el.addEventListener('click', (e) => { if (!tool && e.target !== canvas && R) { selected = hit(e); render(); updateList(); } });
      }
      setTool(tool);
      resize();
      if (loadedFor !== refs.symbol) load(refs.symbol); else { updateList(); render(); }
    },
    setTool, render, summary,
    add(list, src = 'agent') {   // drawings from the agent's chart_actions
      list.forEach((d) => drawings.push({ id: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, ccy: R?.currency || 'TRY', src, ...d }));
      save(); render();
    },
    clear(src) { drawings = src ? drawings.filter((d) => d.src !== src) : []; selected = null; save(); render(); },
    naiveMs,
    composite(base) {   // screenshot of chart + drawings (for the agent's vision input)
      if (!canvas) return base;
      const out = document.createElement('canvas'); out.width = base.width; out.height = base.height;
      const g = out.getContext('2d'); g.drawImage(base, 0, 0); g.drawImage(canvas, 0, 0, out.width, out.height);
      return out;
    },
  };
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea')) return;
    if (e.key === 'Escape') { setTool(null); selected = null; render(); updateList(); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected) { drawings = drawings.filter((d) => d !== selected); selected = null; save(); render(); }
  });
  function num(v) { return new Intl.NumberFormat('tr-TR', { maximumFractionDigits: v >= 100 ? 2 : 4 }).format(v); }
})();
