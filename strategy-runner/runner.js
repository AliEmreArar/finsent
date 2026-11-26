// FinSent strategy runner: runs saved strategies server-side for the daily "follow a strategy"
// task, so a linked paper portfolio is updated even when no browser is open.
//
// Isolation (two layers):
//  1. The container has no network (network_mode: none), no database credentials, a read-only
//     root filesystem and no Linux capabilities. Its only writable place is the jobs volume.
//  2. Each job runs in a fresh `vm` context that receives nothing from this process except a JSON
//     string: no `process`, `require`, timers or file system. Engine, strategy and order logic all
//     live inside that context, and the result leaves it as a JSON string. A synchronous timeout
//     stops endless loops.
//
// Protocol (shared volume, default /jobs):
//   in/<id>.json   written by Airflow (atomically: tmp file + rename)
//   out/<id>.json  written here: {ok, asOf, signals, orders, metrics} or {ok: false, error}
//
// Usage: node runner.js            poll forever
//        node runner.js --once     process what is in in/ and exit (tests)
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JOBS = process.env.JOBS_DIR || '/jobs';
const ENGINE_DIR = process.env.ENGINE_DIR || path.join(__dirname, '..', 'backend', 'public', 'assets', 'strategy');
const TIMEOUT_MS = Number(process.env.STRATEGY_TIMEOUT_MS || 60000);
const POLL_MS = 1000;

const ENGINE_SRC = fs.readFileSync(path.join(ENGINE_DIR, 'engine.js'), 'utf8');
const APPLY_SRC = fs.readFileSync(path.join(ENGINE_DIR, 'apply.js'), 'utf8');

// Runs inside the context. Reads the job from the global __job string, returns a JSON string.
const RUN_IN_CONTEXT = `(function () {
  var job = JSON.parse(__job);
  try {
    var r = FinSentEngine.backtest({ code: job.code, data: job.data, params: job.params || {}, config: job.config || {} });
    var orders = FinSentApply.signalsToOrders(r.signals, job.account || { value: 0, positions: [] }, r.symbols.length);
    var m = r.metrics;
    return JSON.stringify({ ok: true, asOf: r.dates[r.dates.length - 1], signals: r.signals, orders: orders,
      warnings: r.warnings, metrics: { totalReturn: m.totalReturn, cagr: m.cagr, maxDrawdown: m.maxDrawdown, trades: m.trades } });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e && e.message || e), phase: e && e.phase || null, date: e && e.date || null });
  }
})()`;

function runJob(jobText) {
  // an empty, null-prototype sandbox: the context gets only the standard JS built-ins
  const sandbox = Object.create(null);
  const ctx = vm.createContext(sandbox, { name: 'strategy', codeGeneration: { strings: true, wasm: false } });
  vm.runInContext(ENGINE_SRC + '\n;\n' + APPLY_SRC, ctx, { timeout: 5000, filename: 'engine.js' });
  sandbox.__job = String(jobText);
  const out = vm.runInContext(RUN_IN_CONTEXT, ctx, { timeout: TIMEOUT_MS, filename: 'job.js', microtaskMode: 'afterEvaluate' });
  if (typeof out !== 'string') throw new Error('runner: unexpected result type');
  return out;
}

function ensureDirs() {
  for (const d of ['in', 'out', 'work']) {
    const p = path.join(JOBS, d);
    fs.mkdirSync(p, { recursive: true });
    try { fs.chmodSync(p, 0o777); } catch { /* not the owner: fine if writable */ }
  }
}

function writeOut(id, text) {
  const tmp = path.join(JOBS, 'out', `.${id}.tmp`);
  fs.writeFileSync(tmp, text);
  try { fs.chmodSync(tmp, 0o666); } catch { /* ignore */ }
  fs.renameSync(tmp, path.join(JOBS, 'out', `${id}.json`));
}

function processPending() {
  let n = 0;
  for (const f of fs.readdirSync(path.join(JOBS, 'in'))) {
    if (!/^[A-Za-z0-9_-]{1,80}\.json$/.test(f)) continue;
    const id = f.slice(0, -5);
    const work = path.join(JOBS, 'work', f);
    try { fs.renameSync(path.join(JOBS, 'in', f), work); } catch { continue; }   // claimed by someone else
    const t0 = Date.now();
    let result;
    try {
      result = runJob(fs.readFileSync(work, 'utf8'));
    } catch (e) {
      const timeout = /timed out/i.test(String(e && e.message));
      result = JSON.stringify({ ok: false, error: timeout ? `Strateji ${Math.round(TIMEOUT_MS / 1000)} saniyede bitmedi (sonsuz döngü olabilir).` : String(e && e.message || e), phase: timeout ? 'timeout' : 'runner' });
    }
    writeOut(id, result);
    try { fs.unlinkSync(work); } catch { /* ignore */ }
    console.log(`[runner] ${id} ${JSON.parse(result).ok ? 'ok' : 'error'} ${Date.now() - t0} ms`);
    n++;
  }
  return n;
}

if (require.main === module) {
  ensureDirs();
  if (process.argv.includes('--once')) {
    processPending();
  } else {
    console.log(`[runner] watching ${JOBS}/in`);
    setInterval(() => { try { processPending(); } catch (e) { console.error('[runner]', e); } }, POLL_MS);
  }
}

module.exports = { runJob, processPending, ensureDirs };
