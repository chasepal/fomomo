import assert from "node:assert/strict";
import { mock } from "node:test";
import type { JsonResponse } from "../src/core/proxy.js";
import { OkxClient, OkxError, OKX_API_BASE, type OkxClientOptions } from "../src/core/okx.js";

// 全部走注入的假 request，不发真实请求。关注点：只打固定端点、不带凭据、只发 OKX 原样参数（不附加自有字段）、错误码归类、响应解析、串行限速。

const TS = "2020-12-08T09:08:57.715Z";
const PATH_SWAP = "/api/v6/dex/aggregator/swap";
const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const MEME = "0x1111111111111111111111111111111111111111";

interface Call { url: URL; headers: Record<string, string> }
/** 假 request：记录每次调用，按脚本依次返回响应；脚本用完则回 code 0 空 data */
function fake(script: Array<JsonResponse | (() => Promise<JsonResponse>)>, calls: Call[]): OkxClientOptions["request"] {
  return async (url, opts) => {
    calls.push({ url: new URL(url), headers: opts.headers ?? {} });
    const next = script.shift();
    if (!next) return ok({});
    return typeof next === "function" ? next() : next;
  };
}
const ok = (data: unknown, status = 200): JsonResponse => ({ status, json: { code: "0", msg: "", data: [data] } });
const err = (code: string, msg: string, status = 200): JsonResponse => ({ status, json: { code, msg, data: [] } });

function client(script: Array<JsonResponse | (() => Promise<JsonResponse>)>, calls: Call[], extra: Partial<OkxClientOptions> = {}): OkxClient {
  return new OkxClient({ request: fake(script, calls), minIntervalMs: 0, rateLimitRetryMs: 0, now: () => new Date(TS), ...extra });
}

const EVM_TX = { to: "0x6e2a35a7ad683cf634d91492d73bb7ff774c6919", data: "0xabcdef", value: "1000", gas: "210000", gasPrice: "30", slippagePercent: "1.2" };
const ROUTE = {
  toTokenAmount: "1000", fromTokenAmount: "1000000", priceImpactPercent: "-1.5", estimateGasFee: "42", tradeFee: "0.12",
  fromToken: { tokenContractAddress: NATIVE, tokenSymbol: "ETH", decimal: "18", isHoneyPot: false, taxRate: "0", tokenUnitPrice: "3000.5" },
  toToken: { tokenContractAddress: MEME, tokenSymbol: "MEME", decimal: "9", isHoneyPot: true, taxRate: "0.05" },
  dexRouterList: [{ subRouterList: [{ dexProtocol: [{ dexName: "Uniswap V3" }, { dexName: "Uniswap V3" }] }, { dexProtocol: [{ dexName: "Curve" }] }] }],
};
const swapReq = { chain: "eth" as const, fromToken: NATIVE, toToken: MEME, amountRaw: 1000000n, userWalletAddress: "0x2222222222222222222222222222222222222222" };

// ① 请求形状：默认打固定的接口地址、不带任何 OKX 凭据头、swap 默认参数齐全；baseUrl 只给测试覆盖
{
  const calls: Call[] = [];
  await client([ok({ routerResult: ROUTE, tx: EVM_TX })], calls).swap(swapReq);
  const [c] = calls;
  assert.ok(c);
  assert.equal(c.url.origin + c.url.pathname, OKX_API_BASE + PATH_SWAP);
  assert.equal(Object.keys(c.headers).length, 0, "客户端不持有凭据：没有 OK-ACCESS-*，也没有 app key");
  const p = c.url.searchParams;
  assert.equal(p.get("chainIndex"), "1");
  assert.equal(p.get("slippagePercent"), "0.5");
  assert.equal(p.get("autoSlippage"), "true");
  assert.equal(p.get("maxAutoSlippagePercent"), "15");
  assert.equal(p.get("gasLevel"), "fast");
  assert.equal(p.get("swapMode"), "exactIn");
  assert.equal([...p.keys()].every((k) => !/fomomo/i.test(k)), true, "没有任何自定义参数");
  const dev: Call[] = [];
  await client([ok({ chainName: "Ethereum" })], dev, { baseUrl: "http://127.0.0.1:8787/" }).supportedChain("eth");
  assert.equal(dev[0]?.url.href, "http://127.0.0.1:8787/api/v6/dex/aggregator/supported/chain?chainIndex=1");
}

// ② 请求只有 OKX 自己的参数：不带任何费参数、不带买卖侧之类的私有参数（quote / swap / sell 三种都查）
{
  const calls: Call[] = [];
  const c = client([ok({ routerResult: ROUTE, tx: EVM_TX }), ok({ routerResult: ROUTE, tx: EVM_TX }), ok(ROUTE)], calls);
  await c.swap(swapReq);
  await c.swap({ ...swapReq, fromToken: MEME, toToken: NATIVE });
  await c.quote({ chain: "bsc", fromToken: NATIVE, toToken: MEME, amountRaw: 1n, priceImpactProtectionPercent: 30 });
  const [, sell, quote] = calls.map((x) => x.url.searchParams);
  assert.equal(sell?.get("approveTransaction"), null, "approve 走独立的 approve-transaction 接口，不随 swap 一起要");
  assert.equal(quote?.get("chainIndex"), "56");
  assert.equal(quote?.get("priceImpactProtectionPercent"), "30");
  assert.equal(quote?.get("userWalletAddress"), null, "quote 不带钱包地址");
  for (const k of calls) {
    assert.equal(k.url.searchParams.get("feePercent"), null, "只发 OKX 原样参数，不附加自有字段");
    assert.equal(k.url.searchParams.get("fromTokenReferrerWalletAddress"), null);
    assert.equal(k.url.searchParams.get("toTokenReferrerWalletAddress"), null);
    assert.equal([...k.url.searchParams.keys()].every((key) => !/fomomo/i.test(key)), true);
  }
  // 82004 原样到达时 → 客户端归类 fee-unsupported、不重发
  const rej: Call[] = [];
  await assert.rejects(client([err("82004", "Four.meme")], rej).swap({ ...swapReq, chain: "bsc" }), (e: unknown) => e instanceof OkxError && e.kind === "fee-unsupported" && e.code === "82004");
  assert.equal(rej.length, 1);
}

// ③ 错误码归类（OKX 的 body / 状态码原样到客户端）
{
  const q = { chain: "eth" as const, fromToken: NATIVE, toToken: MEME, amountRaw: 1n };
  const kindOf = async (res: JsonResponse | (() => Promise<JsonResponse>)) => {
    try {
      await client([res], []).quote(q);
      return "no-error";
    } catch (e) {
      return e instanceof OkxError ? `${e.kind}:${e.code}:${e.httpStatus}` : "other";
    }
  };
  assert.equal(await kindOf(err("82112", "price impact")), "price-impact:82112:200");
  // 限流：等一下重试一次；再撞就抛 rate-limit
  assert.equal(await kindOf(err("50011", "Rate limit reached", 429)), "no-error", "单次 50011 → 重试后成功");
  {
    const calls: Call[] = [];
    await assert.rejects(client([err("50011", "x", 429), err("50011", "x", 429)], calls).quote(q), (e: unknown) => e instanceof OkxError && e.kind === "rate-limit" && e.code === "50011" && e.httpStatus === 429);
    assert.equal(calls.length, 2, "只重试一次");
  }
  assert.equal(await kindOf(err("50113", "Invalid Sign", 401)), "auth:50113:401");
  assert.equal(await kindOf(err("50112", "Invalid OK-ACCESS-TIMESTAMP", 401)), "auth:50112:401");
  assert.equal(await kindOf({ status: 401, json: null, text: "<html>unauthorized</html>" }), "auth:null:401");
  assert.equal(await kindOf({ status: 200, json: null, text: "<html>challenge</html>" }), "network:null:200");
  assert.equal(await kindOf({ status: 0, json: null }), "network:null:null");
  assert.equal(await kindOf(async () => { throw new Error("socket hang up"); }), "network:null:null");
  assert.equal(await kindOf(err("51000", "Parameter amount error", 400)), "params:51000:400");
  assert.equal(await kindOf(err("50014", "Parameter chainIndex cannot be empty", 400)), "params:50014:400");
  assert.equal(await kindOf(err("82000", "Insufficient liquidity")), "liquidity:82000:200");
  assert.equal(await kindOf(err("82104", "token not supported")), "unsupported:82104:200");
  assert.equal(await kindOf(err("82105", "chain not supported")), "unsupported:82105:200");
  assert.equal(await kindOf(err("80000", "Repeated request")), "api:80000:200");
  assert.equal(await kindOf({ status: 500, json: { code: "0", msg: "", data: [] } }), "api:0:500", "HTTP 非 200 即使 code 0 也算失败");
}

// ④ 响应解析：EVM（maxPriorityFeePerGas 缺失 → legacy）与 Solana
{
  const r = await client([ok({ routerResult: ROUTE, tx: EVM_TX })], []).swap({ ...swapReq, fromToken: MEME, toToken: NATIVE });
  assert.equal(r.sol, null);
  assert.ok(r.evm);
  assert.deepEqual(r.evm.tx, { to: EVM_TX.to, data: "0xabcdef", value: 1000n, gas: 210000n, gasPrice: 30n, maxPriorityFeePerGas: null });
  assert.equal(r.slippagePercent, "1.2", "autoSlippage 时以响应 tx.slippagePercent 为准");
  assert.deepEqual(r.route, {
    toTokenAmount: 1000n, priceImpactPercent: -1.5, estimateGasFee: 42n,
    fromToken: { symbol: "ETH", decimals: 18, isHoneyPot: false, taxRate: 0, unitPriceUsd: 3000.5 },
    toToken: { symbol: "MEME", decimals: 9, isHoneyPot: true, taxRate: 0.05, unitPriceUsd: null },
    dexNames: ["Uniswap V3", "Curve"],
  });

  // EIP-1559 字段、缺失可选字段 → null
  const r2 = await client([ok({ routerResult: { toTokenAmount: "1" }, tx: { ...EVM_TX, maxPriorityFeePerGas: "5" } })], []).swap(swapReq);
  assert.equal(r2.evm?.tx.maxPriorityFeePerGas, 5n);
  assert.equal(r2.route.priceImpactPercent, null);
  assert.equal(r2.route.estimateGasFee, null);
  assert.equal(r2.route.fromToken.isHoneyPot, null);
  assert.deepEqual(r2.route.dexNames, []);

  // Solana：tx.data 就是 base58 完整交易
  const s = await client([ok({ routerResult: ROUTE, tx: { data: "3BxsAbCdEf", slippagePercent: "0.5" } })], []).swap({ ...swapReq, chain: "sol" });
  assert.equal(s.evm, null);
  assert.deepEqual(s.sol, { txBase58: "3BxsAbCdEf" });

  // tx 残缺 → api 错，不返回半个交易
  await assert.rejects(client([ok({ routerResult: ROUTE, tx: { to: EVM_TX.to } })], []).swap(swapReq), (e: unknown) => e instanceof OkxError && e.kind === "api");

  // approve-transaction / supported/chain
  const calls: Call[] = [];
  const a = await client([ok({ data: "0x095ea7b3aa", dexContractAddress: "0x42170295f1173c9e5874ea9d00c6d137e1a4f53d", gasLimit: "50000", gasPrice: "12" })], calls).approveTransaction("robinhood", MEME, 123n);
  assert.deepEqual(a, { to: MEME, data: "0x095ea7b3aa", spender: "0x42170295f1173c9e5874ea9d00c6d137e1a4f53d", gasLimit: 50000n, gasPrice: 12n });
  assert.equal(calls[0]?.url.pathname, "/api/v6/dex/aggregator/approve-transaction");
  assert.equal(calls[0]?.url.searchParams.get("chainIndex"), "4663");
  assert.equal(calls[0]?.url.searchParams.get("tokenContractAddress"), MEME);
  assert.equal(calls[0]?.url.searchParams.get("approveAmount"), "123");
  const sc = await client([ok({ chainIndex: "143", chainName: "Monad", dexTokenApproveAddress: "0xf534" })], []).supportedChain("monad");
  assert.deepEqual(sc, { chainName: "Monad", dexTokenApproveAddress: "0xf534" });
}

// ⑤ 发送间隔 ≥ minIntervalMs，但响应可以重叠：假时钟（mock.timers 接管 setTimeout + Date），三个并发请求按到达顺序占槽 T0 / T0+I / T0+2I，
//    前一个响应没回来**不**挡后面的（连点快捷额时新报价不排在旧报价后面）
{
  const INTERVAL = 40;
  const T0 = 1_000_000;
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  try {
    const starts: number[] = [];
    const gates: Array<() => void> = [];
    const gated = () => async () => {
      starts.push(Date.now());
      const { promise, resolve } = Promise.withResolvers<void>();
      gates.push(resolve);
      await promise;
      return ok(ROUTE);
    };
    // setImmediate 没被接管：用它把已就绪的 microtask/宏任务都跑完
    const flush = async () => {
      for (let i = 0; i < 5; i++) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setImmediate(resolve);
        await promise;
      }
    };
    const c = client([gated(), gated(), gated()], [], { minIntervalMs: INTERVAL, now: () => new Date() });
    const q = { chain: "eth" as const, fromToken: NATIVE, toToken: MEME, amountRaw: 1n };
    const all = Promise.all([c.quote(q), c.quote(q), c.quote(q)]);
    await flush();
    assert.deepEqual(starts, [T0], "第一个立即发出，其余等各自的槽");
    mock.timers.tick(INTERVAL - 1);
    await flush();
    assert.equal(starts.length, 1, "间隔未满不发");
    mock.timers.tick(1);
    await flush();
    assert.deepEqual(starts, [T0, T0 + INTERVAL], "第一个还没回，第二个到槽就发");
    mock.timers.tick(INTERVAL);
    await flush();
    assert.deepEqual(starts, [T0, T0 + INTERVAL, T0 + INTERVAL * 2], "第三个同样不等前两个的响应");
    for (const g of gates) g();
    assert.equal((await all).length, 3);
    // 空闲很久之后再来一个：立刻发（槽不会攒到未来）
    mock.timers.tick(INTERVAL * 10);
    const c2starts: number[] = [];
    const c2 = client([async () => { c2starts.push(Date.now()); return ok(ROUTE); }], [], { minIntervalMs: INTERVAL, now: () => new Date() });
    void c2.quote(q);
    await flush();
    assert.deepEqual(c2starts, [Date.now()]);
  } finally {
    mock.timers.reset();
  }
  // 队列里前一个失败不卡后续
  const q = { chain: "eth" as const, fromToken: NATIVE, toToken: MEME, amountRaw: 1n };
  const c2 = client([err("82112", "impact"), ok(ROUTE)], []);
  const [a, b] = await Promise.allSettled([c2.quote(q), c2.quote(q)]);
  assert.equal(a.status, "rejected");
  assert.equal(b.status, "fulfilled");
}

console.log("okx-client: ok");
