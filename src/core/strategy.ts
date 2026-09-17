/**
 * 模拟交易的策略语言 = JavaScript。用户代码在 `node:vm` 的干净上下文里求值成 `Strategy`（entry / step 两个钩子），
 * 整个模拟（读库 → analyze → simulate）跑在 worker 线程里，超时直接 terminate——vm 的 timeout 只管定义那一次执行，
 * 管不住之后每个采样回调里的死循环；监控主线程也不该被一次模拟顶住。
 *
 * 这不是安全沙箱：没有 require / process、字符串求值关掉、Math.random 禁用，防的是手滑不是攻击。策略只跑自己写的。
 */
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { Worker } from "node:worker_threads";
import { type SimResult, type Strategy, StrategyError } from "./analysis.js";

/** 整个 worker（含读库 + analyze）的时限 */
export const STRATEGY_TIMEOUT_MS = 15_000;
/** 策略里 console.log 最多带回这么多行 */
export const STRATEGY_LOG_LINES = 200;

export interface CompiledStrategy {
  strategy: Strategy;
  /** 策略代码里 console.log 的输出（定义期 + 运行期），按顺序 */
  logs: string[];
}

const fmt = (v: unknown): string => {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, (_, x) => (x instanceof Set ? [...x] : typeof x === "bigint" ? String(x) : x)) ?? String(v);
  } catch {
    return String(v);
  }
};

/** 从 V8 错误栈里抠出策略文件的行号 */
export function strategyLine(e: unknown): number | null {
  const m = /strategy\.js:(\d+)/.exec(e && typeof e === "object" && "stack" in e ? String((e as { stack: unknown }).stack ?? "") : "");
  return m ? Number(m[1]) : null;
}

/**
 * 把一段代码求值成策略。代码以一个对象结尾：`({ entry(t) {…}, step(s) {…} })`，或只给一个函数 = step。
 * 前面可以有 const / function 定义。语法或求值失败抛 StrategyError（phase = compile，message 带行号）
 */
export function compileStrategy(code: string): CompiledStrategy {
  const logs: string[] = [];
  const log = (...a: unknown[]) => {
    if (logs.length < STRATEGY_LOG_LINES) logs.push(a.map(fmt).join(" "));
    else if (logs.length === STRATEGY_LOG_LINES) logs.push(`… 超过 ${STRATEGY_LOG_LINES} 行，后面的不记了`);
  };
  const safeMath: Record<string, unknown> = Object.create(null);
  for (const k of Object.getOwnPropertyNames(Math)) safeMath[k] = (Math as unknown as Record<string, unknown>)[k];
  safeMath.random = () => {
    throw new Error("策略必须是确定的：不要用 Math.random");
  };
  const ctx = vm.createContext(
    { Math: Object.freeze(safeMath), console: Object.freeze({ log, info: log, warn: log, error: log }) },
    { codeGeneration: { strings: false, wasm: false } },
  );
  let script: vm.Script;
  try {
    script = new vm.Script(code, { filename: "strategy.js" });
  } catch (e) {
    const line = strategyLine(e);
    throw new StrategyError(`语法错误${line ? `（第 ${line} 行）` : ""}：${(e as Error).message}`, "compile", null, null, e);
  }
  let v: unknown;
  try {
    v = script.runInContext(ctx, { timeout: 1000 });
  } catch (e) {
    const line = strategyLine(e);
    throw new StrategyError(`策略定义执行失败${line ? `（第 ${line} 行）` : ""}：${e instanceof Error ? e.message : String(e)}`, "compile", null, null, e);
  }
  if (typeof v === "function") v = { step: v };
  if (!v || typeof v !== "object" || typeof (v as Strategy).step !== "function") {
    throw new StrategyError("策略要以一个对象结尾：({ entry(t) { … }, step(s) { … } })，step 必填；或者只写一个函数 (s) => { … } 当 step", "compile");
  }
  const entry = (v as Strategy).entry;
  if (entry !== undefined && typeof entry !== "function") throw new StrategyError("entry 要是函数：entry(t) { … }", "compile");
  return { strategy: v as Strategy, logs };
}

// ---------- worker 运行 ----------

export interface StrategyRunParams {
  dbPath: string;
  code: string;
  hours: number;
  win: number;
  tz: string;
  fee: number;
  stake: number;
}

export interface StrategyRunResult {
  strategy: SimResult;
  /** 同一个 step、entry 换成「全部合格币都按默认每单买」 */
  baseline: SimResult;
  cohort: { eligible: number; total: number; win: number };
  logs: string[];
  /** worker 里的耗时 ms */
  elapsed: number;
}

export interface StrategyRunError {
  message: string;
  phase: StrategyError["phase"] | "timeout" | "internal";
  token: string | null;
  ts: number | null;
  line: number | null;
}

export type WorkerMessage = { ok: true; result: StrategyRunResult } | { ok: false; error: StrategyRunError };

/**
 * 开发态（tsx 跑 .ts）：module.register 的钩子不会传给 worker，Node 22 自带的 strip-types 能读 .ts 却不认 `.js` → `.ts` 的 import 改写，
 * 所以 worker 用一段 eval 引导：先在 worker 线程里 `tsx/esm/api` register()，再 import 本目录的 sim-worker.ts。
 * 打包后是 esbuild 单独打出的 sim-worker.mjs，和 cli.mjs 并排，直接当 Worker 入口
 */
const DEV = import.meta.url.endsWith(".ts");
const WORKER_ENTRY = new URL(DEV ? "./sim-worker.ts" : "./sim-worker.mjs", import.meta.url);
const DEV_BOOTSTRAP = `import("tsx/esm/api").then(({ register }) => { register(); return import(${JSON.stringify(WORKER_ENTRY.href)}); });`;
const spawn = (workerData: StrategyRunParams): Worker =>
  DEV ? new Worker(DEV_BOOTSTRAP, { eval: true, workerData, name: "sim" }) : new Worker(fileURLToPath(WORKER_ENTRY), { workerData, name: "sim" });

export function describeStrategyError(e: unknown): StrategyRunError {
  if (e instanceof StrategyError) return { message: e.message, phase: e.phase, token: e.token, ts: e.ts, line: strategyLine(e.cause ?? e) };
  return { message: e instanceof Error ? e.message : String(e), phase: "internal", token: null, ts: null, line: strategyLine(e) };
}

/** 在 worker 里跑一遍策略；超时 terminate 并返回 timeout 错误 */
export function runStrategy(params: StrategyRunParams, timeoutMs = STRATEGY_TIMEOUT_MS): Promise<WorkerMessage> {
  return new Promise((resolve) => {
    const w = spawn(params);
    let done = false;
    const finish = (m: WorkerMessage) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(m);
      void w.terminate();
    };
    const timer = setTimeout(() => finish({ ok: false, error: { message: `超时（${Math.round(timeoutMs / 1000)}s）：step() 里有死循环，或者窗口太大`, phase: "timeout", token: null, ts: null, line: null } }), timeoutMs);
    w.once("message", (m: WorkerMessage) => finish(m));
    w.once("error", (e) => finish({ ok: false, error: describeStrategyError(e) }));
    w.once("exit", (code) => {
      if (!done) finish({ ok: false, error: { message: `模拟线程退出（code ${code}）`, phase: "internal", token: null, ts: null, line: null } });
    });
  });
}
