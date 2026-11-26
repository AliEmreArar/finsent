// Server-side strategy runner (strategy-runner/runner.js) and the shared signal->order logic.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { signalsToOrders } = require('../../public/assets/strategy/apply.js');

const RUNNER = path.join(__dirname, '..', '..', '..', 'strategy-runner', 'runner.js');
const { runJob } = require(RUNNER);

function series(closes, start = '2024-01-01') {
  const date = [];
  const d = new Date(start + 'T00:00:00Z');
  while (date.length < closes.length) {
    if (d.getUTCDay() % 6) date.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return { date, open: closes, high: closes, low: closes, close: closes, volume: closes.map(() => 1000) };
}
const job = (code, extra = {}) => JSON.stringify({ code, data: { A: series([10, 11, 12, 13, 14]) }, params: {}, config: {},
  account: { value: 100000, positions: [] }, ...extra });

test('signalsToOrders: targets, partial sells, amounts, sells first', () => {
  const account = { value: 100000, positions: [{ symbol: 'A', shares: 100, value: 50000, price: 500 }, { symbol: 'B', shares: 10, value: 1000, price: 100 }] };
  const orders = signalsToOrders([
    { sym: 'C', side: 'buy', percent: 10, reason: 'r1' },
    { sym: 'A', side: 'target', targetPercent: 30, reason: 'r2' },
    { sym: 'B', side: 'sell', percent: 50, reason: 'r3' },
    { sym: 'D', side: 'target', targetPercent: 20 },
    { sym: 'E', side: 'sell' },                         // not held: dropped
    { sym: 'B', side: 'target', targetPercent: 1.001 }, // already at target: dropped
  ], account, 4);
  assert.deepEqual(orders, [
    { symbol: 'A', side: 'sell', shares: 40, reason: 'r2' },
    { symbol: 'B', side: 'sell', shares: 5, reason: 'r3' },
    { symbol: 'C', side: 'buy', amount: 10000, reason: 'r1' },
    { symbol: 'D', side: 'buy', amount: 20000, reason: '' },
  ]);
});

test('runner: a strategy produces today\'s signals and paper orders', () => {
  const out = JSON.parse(runJob(job(`const strategy = { onBar(ctx) { if (ctx.isLastBar) ctx.targetPercent('A', 25, { reason: 'hedef' }); } };`)));
  assert.equal(out.ok, true);
  assert.equal(out.asOf, '2024-01-05');
  assert.deepEqual(out.orders, [{ symbol: 'A', side: 'buy', amount: 25000, reason: 'hedef' }]);
});

test('runner: strategy errors come back as data', () => {
  const out = JSON.parse(runJob(job(`const strategy = { onBar(ctx) { ctx.ind('A', 'nope'); } };`)));
  assert.equal(out.ok, false);
  assert.match(out.error, /göstergesi/);
  assert.equal(out.phase, 'onBar');
});

test('runner sandbox: no process, require, fetch or host objects, even via constructors', () => {
  const code = `
    const probes = {
      process: typeof process, require: typeof require, fetch: typeof fetch, setTimeout: typeof setTimeout,
      module: typeof module, globalProcess: typeof globalThis.process,
      viaFunction: (function () {}).constructor('return typeof process')(),
      viaArrayCtor: [].constructor.constructor('return typeof require')(),
    };
    const strategy = { onBar(ctx) {
      for (const [k, v] of Object.entries(probes)) if (v !== 'undefined') throw new Error('leak: ' + k + ' = ' + v);
    } };`;
  const out = JSON.parse(runJob(job(code)));
  assert.equal(out.ok, true, out.error);
});

test('runner --once: processes the queue, times out endless loops, writes results atomically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finsent-jobs-'));
  fs.mkdirSync(path.join(dir, 'in'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'in', 'good.json'), job(`const strategy = { onBar(ctx) { if (ctx.isLastBar) ctx.buy('A', { percent: 10 }); } };`));
  fs.writeFileSync(path.join(dir, 'in', 'loop.json'), job(`const strategy = { onBar() { for (;;) {} } };`));
  fs.writeFileSync(path.join(dir, 'in', '../evil.json'), '{}');   // outside in/: never read
  const r = spawnSync(process.execPath, [RUNNER, '--once'], { env: { JOBS_DIR: dir, STRATEGY_TIMEOUT_MS: '500' }, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  const good = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'good.json'), 'utf8'));
  assert.equal(good.ok, true);
  assert.equal(good.orders[0].amount, 10000);
  const loop = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'loop.json'), 'utf8'));
  assert.equal(loop.ok, false);
  assert.equal(loop.phase, 'timeout');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'in')), []);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'work')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
