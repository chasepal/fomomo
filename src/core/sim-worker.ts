/**
 * 模拟交易的 worker 入口：自己开一个只读用途的 Store 连接读 analysisInput（SQLite WAL 多读者没问题，主线程不用 clone 几十 MB 采样过来），
 * analyze → 编译策略 → 跑策略 + 基准 → postMessage 回去。任何错误都包成 WorkerMessage 而不是让线程炸。
 * 打包时由 build-app.sh 用 esbuild 单独打成 sim-worker.mjs；开发态由 core/strategy.ts 直接指向本 .ts
 */
import { parentPort, workerData } from "node:worker_threads";
import { analyze, simulate } from "./analysis.js";
import { Store } from "./store.js";
import { compileStrategy, describeStrategyError, type StrategyRunParams, type WorkerMessage } from "./strategy.js";

const post = (m: WorkerMessage) => parentPort!.postMessage(m);
const p = workerData as StrategyRunParams;
const t0 = Date.now();
let store: Store | null = null;
try {
  const { strategy, logs } = compileStrategy(p.code);
  store = new Store(p.dbPath);
  const now = Math.floor(Date.now() / 1000);
  const input = store.analysisInput(now - p.hours * 3600, now);
  const report = analyze(input, { win: p.win, hours: p.hours });
  const env = { fee: p.fee, stake: p.stake };
  const result = simulate(input, report, strategy, env, p.tz);
  // 基准：同一个 step，不挑币、默认每单；页面不画基准的路径，省体积
  const baseline = simulate(input, report, { step: strategy.step }, env, p.tz, { path: false });
  post({
    ok: true,
    result: { strategy: result, baseline, cohort: { eligible: report.cohort.eligible, total: report.cohort.total, win: p.win }, logs, elapsed: Date.now() - t0 },
  });
} catch (e) {
  post({ ok: false, error: describeStrategyError(e) });
} finally {
  store?.db.close();
}
