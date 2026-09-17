import assert from "node:assert/strict";
import { NativePriceFeed, WRAPPED_NATIVE } from "../src/core/native-price.js";

// 全部走注入的假 fetch，不打 DexScreener。关注点：一轮只拉四个包装币（USDC 恒 1 不拉）、首轮拉到触发一次 onChange、同值不触发、单币失败 / 拿不到价保留旧值且不触发。

const FETCHED = Object.keys(WRAPPED_NATIVE) as (keyof typeof WRAPPED_NATIVE)[];
const table: Record<string, number | null> = { ETH: 2469, BNB: 716, SOL: 100, MON: 0.024 };
const symbolOf = (address: string) => FETCHED.find((s) => WRAPPED_NATIVE[s].address === address)!;
const calls: string[] = [];
let failing: string | null = null;
const feed = new NativePriceFeed({
  everyMs: 60_000,
  fetch: async (dexChain, address) => {
    const s = symbolOf(address);
    assert.equal(dexChain, WRAPPED_NATIVE[s].dexChain, "链 slug 与包装币表一致");
    calls.push(s);
    if (failing === s) throw new Error("dexscreener 500");
    return table[s];
  },
});
let changes = 0;
feed.onChange = () => changes++;

// 拉之前包装币全是 null；USDC 不拉也恒为 1
for (const s of FETCHED) assert.equal(feed.get(s), null);
assert.equal(feed.get("USDC"), 1, "USDC 美元价恒 1，不等任何请求");

// 首轮：四个币并行各拉一次，拉到就触发一次 onChange
await feed.refresh();
assert.deepEqual([...calls].sort(), [...FETCHED].sort(), "一轮拉四个币，不含 USDC");
assert.equal(changes, 1, "首轮拉到触发一次");
assert.equal(feed.get("BNB"), 716);
assert.equal(feed.get("MON"), 0.024);

// 同值：不触发
await feed.refresh();
assert.equal(changes, 1, "价没变不触发");

// 单币失败 / 拿不到价：该币保留旧值，其余照常更新，onChange 只因变化触发
failing = "BNB";
table.SOL = null;
table.ETH = 2500;
await feed.refresh();
assert.equal(feed.get("BNB"), 716, "拉失败保留旧值");
assert.equal(feed.get("SOL"), 100, "没拿到价保留旧值");
assert.equal(feed.get("ETH"), 2500, "其他币照常更新");
assert.equal(changes, 2, "有变化才触发");

// 全部失败：什么都不动、不触发
failing = null;
for (const s of FETCHED) table[s] = null;
await feed.refresh();
assert.equal(feed.get("ETH"), 2500);
assert.equal(changes, 2, "全轮无价不触发");

// start/close：start 立刻拉一轮（等 onChange 而不是猜时长），close 后不再有定时器（进程能退出）
table.BNB = 720;
const n = calls.length;
const round = Promise.withResolvers<void>();
feed.onChange = () => round.resolve();
feed.start();
await round.promise;
assert.equal(calls.length, n + FETCHED.length, "start 立刻拉一轮");
assert.equal(feed.get("BNB"), 720);
feed.close();

console.log("native-price: ok");
