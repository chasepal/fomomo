import assert from "node:assert/strict";
import { encodeEventTopics, encodeAbiParameters, erc20Abi, type Log } from "viem";
import type { NativePrices } from "../src/core/native-price.js";
import { NATIVE_TOKEN, OkxError, type OkxClient, type QuoteRequest, type RouteInfo, type SwapRequest, type SwapResult, type TokenInfo } from "../src/core/okx.js";
import { Store } from "../src/core/store.js";
import { MIN_USD, TradeService, fromRaw, toRaw } from "../src/core/trade.js";
import { DEFAULT_SETTINGS, type OutEvent, type TradeEvent, type TradeQuoteEvent, type TradeSettings } from "../src/core/types.js";
import type { BurnerWallet, EvmReceipt } from "../src/core/wallet.js";

/**
 * TradeService 的合约测试：OKX 客户端与钱包全用假实现（不联网、不签名），Store 用内存库，原生币美元价用可拨的假缓存（默认 BNB=$700，可拨成 null 模拟 DexScreener 挂了）。
 * 只断言消费者能观察到的：事件序列、账本行、余额/限额判定、OKX 被调了几次、锁与重放。买入按 BNB 数量计价，`bnb(usd)` 只是把老的 USD 直觉换成数量。
 */

const ME = "0x2222222222222222222222222222222222222222" as const;
const MEME = "0xabc0000000000000000000000000000000000001";
const NATIVE_BNB = NATIVE_TOKEN.bsc;
const BNB_USD = 700;
/** 按 $700 折的 BNB 数量：让用例里的限额数字（$10 / $60…）读起来还是美元 */
const bnb = (usd: number) => usd / BNB_USD;
const HASH = "0x9999999999999999999999999999999999999999999999999999999999999999" as const;

const token = (symbol: string, decimals: number, unitPriceUsd: number | null): TokenInfo => ({ symbol, decimals, isHoneyPot: false, taxRate: 0, unitPriceUsd });
const route = (from: TokenInfo, to: TokenInfo, toAmount: bigint): RouteInfo => ({ toTokenAmount: toAmount, priceImpactPercent: 0.4, estimateGasFee: 100_000n, fromToken: from, toToken: to, dexNames: ["PancakeSwap V3"] });

/** 假 OKX：native→MEME 按 MEME=$0.001、BNB=$700 折算；记录每次调用 */
class FakeOkx {
  quotes: QuoteRequest[] = [];
  swaps: SwapRequest[] = [];
  approves = 0;
  failSwap: OkxError | null = null;
  async quote(q: QuoteRequest) {
    this.quotes.push(q);
    return this.routeFor(q);
  }
  async swap(s: SwapRequest): Promise<SwapResult> {
    this.swaps.push(s);
    if (this.failSwap) throw this.failSwap;
    const r = this.routeFor(s);
    return { route: r, slippagePercent: "1.0", evm: { tx: { to: "0x1111111111111111111111111111111111111111", data: "0xdead", value: s.fromToken === NATIVE_BNB ? s.amountRaw : 0n, gas: 200_000n, gasPrice: 1_000_000_000n, maxPriorityFeePerGas: null } }, sol: null };
  }
  async approveTransaction() {
    this.approves++;
    return { to: MEME as `0x${string}`, data: "0xa9059cbb" as const, spender: "0x4217000000000000000000000000000000000000" as `0x${string}`, gasLimit: 60_000n, gasPrice: null };
  }
  async supportedChain() {
    return { chainName: "BNB chain", dexTokenApproveAddress: "0x4217000000000000000000000000000000000000" };
  }
  warms = 0;
  warm() { this.warms++; }
  private routeFor(q: QuoteRequest): RouteInfo {
    const bnbTok = token("BNB", 18, BNB_USD);
    const meme = token("MEME", 9, 0.001);
    if (q.fromToken === NATIVE_BNB) return route(bnbTok, meme, toRaw((fromRaw(q.amountRaw, 18) * BNB_USD) / 0.001, 9));
    return route(meme, bnbTok, toRaw((fromRaw(q.amountRaw, 9) * 0.001) / BNB_USD, 18));
  }
}

/** 假钱包：余额可设；sendEvm 记录并按脚本返回回执（可挂起模拟等待）；Transfer 日志给到账解析 */
class FakeWallet {
  readonly evmAddress = ME;
  readonly solAddress = "11111111111111111111111111111111";
  native = new Map<string, bigint>([["bsc", toRaw(0.05, 18)]]);
  memeBalance = 0n;
  allowance = 0n;
  sent: Array<{ to: string; value: bigint }> = [];
  /** 下一笔 sendEvm 的行为：默认立刻成功；"hang" = 广播后不回回执（模拟超时）；"revert" = 回执 reverted */
  next: "ok" | "hang" | "revert" = "ok";
  receivedRaw = toRaw(7_000_000, 9);
  nativeReads = 0;
  erc20Reads = 0;
  async nativeBalance(chain: string) { this.nativeReads++; return this.native.get(chain) ?? 0n; }
  async erc20Balance() { this.erc20Reads++; return this.memeBalance; }
  async erc20Decimals() { return 9; }
  async erc20Allowance() { return this.allowance; }
  gasPriceCalls = 0;
  async gasPrice() { this.gasPriceCalls++; return 1_000_000_000n; }
  async splBalance() { return { amount: 0n, decimals: null }; }
  async sendEvm(_chain: string, tx: { to: string; value: bigint }, onSubmitted?: (h: `0x${string}`) => void): Promise<EvmReceipt> {
    this.sent.push({ to: tx.to, value: tx.value });
    onSubmitted?.(HASH);
    if (this.next === "hang") return new Promise<EvmReceipt>(() => undefined);
    const reverted = this.next === "revert";
    this.next = "ok";
    return { hash: HASH, status: reverted ? "reverted" : "success", logs: reverted ? [] : [this.transferLog()] };
  }
  /** 对账脚本：默认节点直接给成功回执；"null" = 节点说还没上链；"throw" = 节点报错（限流 / 403） */
  receipt: "ok" | "null" | "throw" = "ok";
  receiptCalls = 0;
  async receiptEvm(): Promise<EvmReceipt | null> {
    this.receiptCalls++;
    if (this.receipt === "throw") throw new Error("HTTP 403 archive");
    if (this.receipt === "null") return null;
    return { hash: HASH, status: "success", logs: [this.transferLog()] };
  }
  async sendSol() { throw new Error("not in this test"); }
  async solStatus() { return "pending" as const; }
  private transferLog(): Log {
    const [t0, t1, t2] = encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: "0x1111111111111111111111111111111111111111", to: ME } });
    return { address: MEME as `0x${string}`, topics: [t0, t1!, t2!], data: encodeAbiParameters([{ type: "uint256" }], [this.receivedRaw]), blockNumber: 1n, blockHash: HASH, transactionHash: HASH, transactionIndex: 0, logIndex: 0, removed: false } as Log;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting");
    await sleep(5);
  }
}

function harness(overrides: Partial<TradeSettings> = {}, seed?: (store: Store) => void, nativePrice: number | null = BNB_USD) {
  const store = new Store(":memory:");
  seed?.(store);
  const settings: TradeSettings = { ...DEFAULT_SETTINGS.trade, ...overrides };
  const events: OutEvent[] = [];
  const okx = new FakeOkx();
  const wallet = new FakeWallet();
  /** 假原生币价缓存：所有符号同一个价；测试可拨 value / 手动触发 onChange */
  const prices: NativePrices & { value: number | null } = { value: nativePrice, get: () => prices.value, onChange: null };
  const svc = new TradeService({
    store,
    bridge: { emit: (e) => events.push(e) },
    settings: () => settings,
    okx: () => okx as unknown as OkxClient,
    wallet: async () => wallet as unknown as BurnerWallet,
    priceOf: (a, chain) => (a === MEME && chain === "bsc" ? 0.001 : null),
    meta: (a) => (a === MEME ? { symbol: "MEME", name: "Meme Coin", logo: null } : null),
    nativePrices: prices,
    timing: { receiptMs: 150, reconcileEveryMs: 20, reconcileGiveUpMs: 60_000, balancesEveryMs: 60_000, focusEveryMs: 10 },
  });
  const trades = () => events.filter((e): e is TradeEvent => e.t === "trade");
  const statuses = (id: string) => trades().filter((e) => e.id === id).map((e) => e.status);
  const quotes = () => events.filter((e): e is TradeQuoteEvent => e.t === "trade_quote");
  return { store, settings, events, okx, wallet, prices, svc, trades, statuses, quotes };
}

// ① 报价只问一次、不学价：买入按 BNB 数量直接问 OKX（每次 1 次）；估值 / 余额 USD 来自原生币价缓存；缓存变了重推 trade_state。事件字段可读
{
  const h = harness();
  await h.svc.start();
  assert.equal(h.events.filter((e) => e.t === "trade_state").length >= 1, true, "启动推 trade_state");
  const st = h.svc.state();
  assert.equal(st.ready, true);
  assert.equal(st.balances.bsc.native, 0.05);
  assert.equal(st.balances.bsc.price, BNB_USD, "余额带原生币价");
  assert.equal(st.balances.bsc.usd, 0.05 * BNB_USD, "余额 USD = 数量 × 缓存价");
  assert.deepEqual(st.presets, DEFAULT_SETTINGS.trade.presets, "快捷额按原生币分组透传");

  h.svc.quote({ address: MEME, chain: "bsc", side: "buy", amount: bnb(10) });
  await until(() => h.quotes().length === 1);
  assert.equal(h.okx.quotes.length, 1, "不学价：只报一次");
  const q = h.quotes()[0];
  assert.equal(q.ok, true);
  assert.equal(q.amount, bnb(10), "事件回传请求的原生币数量");
  assert.equal(q.usd, 10, "估值 = 数量 × 缓存价");
  assert.equal(q.outSymbol, "MEME");
  assert.equal(q.minUsd, MIN_USD);
  assert.ok(q.outAmount && q.outAmount > 0);
  // gasPrice 不挂在报价路径上：没缓存时网络费先 null、后台去拉（正常流程弹卡 focusChanged 时就预热了）；下一次报价就有
  assert.equal(q.networkFeeUsd, null, "首次没 gasPrice 缓存 → 网络费 null，不等节点");
  await until(() => h.wallet.gasPriceCalls === 1);

  h.svc.quote({ address: MEME, chain: "bsc", side: "buy", amount: bnb(20) });
  await until(() => h.quotes().length === 2);
  assert.equal(h.okx.quotes.length, 2, "第二次还是只 1 次");
  const q2 = h.quotes()[1];
  assert.ok(q2.networkFeeUsd !== null && q2.networkFeeUsd > 0, "有 gasPrice 缓存后网络费按缓存价折 USD");
  assert.equal(h.wallet.gasPriceCalls, 1, "60s 内不重拉 gasPrice");
  // 期间没有任何定时刷新
  await sleep(120);
  assert.equal(h.okx.quotes.length, 2, "没有周期性报价");
  // 原生币价变了 → 重推 state
  const states0 = h.events.filter((e) => e.t === "trade_state").length;
  h.prices.value = 1400;
  h.prices.onChange?.();
  assert.equal(h.events.filter((e) => e.t === "trade_state").length, states0 + 1, "价变了推一次 trade_state");
  assert.equal(h.svc.state().balances.bsc.usd, 0.05 * 1400);
  // 数量非法 → 不问 OKX
  h.svc.quote({ address: MEME, chain: "bsc", side: "buy", amount: -1 });
  await until(() => h.quotes().length === 3);
  assert.equal(h.quotes()[2].ok, false);
  assert.equal(h.okx.quotes.length, 2, "数量 ≤0 不问 OKX");
  h.svc.close();
  console.log("ok quote once: native amount, no price bootstrap, no polling, state re-emitted on price change");
}

// ② 买入全程：validating → submitting → submitted → confirmed；账本记 in/out raw（到账按 Transfer 日志）；持仓/日限额随之更新；同一 quoteId 重放拒绝
{
  const h = harness();
  await h.svc.start();
  h.svc.quote({ address: MEME, chain: "bsc", side: "buy", amount: bnb(10) });
  await until(() => h.quotes().length === 1);
  const q = h.quotes()[0];
  h.svc.trade({ address: MEME, chain: "bsc", side: "buy", amount: bnb(10), quoteId: q.id });
  const id = h.trades()[0].id;
  assert.equal(h.trades()[0].usd, 10, "账本估值 = 数量 × 缓存价");
  await until(() => h.statuses(id).includes("confirmed"));
  assert.deepEqual([...new Set(h.statuses(id))], ["validating", "submitting", "submitted", "confirmed"]);
  assert.equal(h.okx.swaps.length, 1);
  assert.equal(h.okx.swaps[0].userWalletAddress, ME);
  assert.equal(h.wallet.sent.length, 1, "买入只有一笔 swap 交易，不需要 approve");
  assert.equal(h.wallet.sent[0].value, toRaw(bnb(10), 18), "value = 请求的 BNB 数量");
  const row = h.store.tradeById(id)!;
  assert.equal(row.ev.txHash, HASH);
  assert.equal(row.exec.inRaw, toRaw(bnb(10), 18).toString());
  assert.equal(row.exec.outRaw, h.wallet.receivedRaw.toString(), "到账按回执 Transfer 日志，不是估算");
  assert.equal(row.exec.decimals, 9);
  assert.equal(h.store.buyUsdSince(0), 10, "日限额计入已上链买入（USD 估值）");
  // 成交后补读余额：钱包里现在有 MEME → 持仓出现
  h.wallet.memeBalance = h.wallet.receivedRaw;
  await h.svc.refreshBalances();
  const hold = h.svc.holdings();
  assert.equal(hold.length, 1);
  assert.equal(hold[0].symbol, "MEME");
  assert.equal(hold[0].amount, 7_000_000);
  assert.equal(hold[0].usd, 7000);
  assert.equal(hold[0].boughtUsd, 10);
  assert.equal(hold[0].pnlUsd, 6990);
  assert.ok(hold[0].tradePrices?.buy && Math.abs(hold[0].tradePrices.buy - 10 / 7_000_000) < 1e-12, "买入均价 = usd / 到账数量");
  assert.deepEqual(h.svc.positionOf(MEME, "bsc"), { amount: 7_000_000, usd: 7000 });
  // 同一份报价再点一次：拒绝，不再调 OKX
  h.svc.trade({ address: MEME, chain: "bsc", side: "buy", amount: bnb(10), quoteId: q.id });
  const replay = h.trades().filter((e) => e.id !== id);
  await until(() => replay.length > 0 && h.trades().some((e) => e.id === replay[0].id && e.status === "failed"));
  assert.match(h.trades().find((e) => e.id === replay[0].id && e.status === "failed")!.error ?? "", /已被执行过|报价已更新/);
  assert.equal(h.okx.swaps.length, 1);
  h.svc.close();
  console.log("ok buy lifecycle: statuses, ledger raw amounts from receipt, holdings/pnl, quote replay refused");
}

// ③ 限额与余额：超单笔 / 超日限 / 最低额 / 余额不足都在调 OKX swap 之前就 failed；数量与报价不一致拒绝
{
  const h = harness({ maxUsdPerTrade: 50, maxUsdPerDay: 60 });
  await h.svc.start();
  const quoteFor = async (amount: number) => {
    const before = h.quotes().length;
    h.svc.quote({ address: MEME, chain: "bsc", side: "buy", amount });
    await until(() => h.quotes().length === before + 1);
    return h.quotes()[before];
  };
  const q60 = await quoteFor(bnb(60));
  h.svc.trade({ address: MEME, chain: "bsc", side: "buy", amount: bnb(60), quoteId: q60.id });
  let last = h.trades().at(-1)!;
  assert.equal(last.status, "failed");
  assert.match(last.error ?? "", /超单笔上限 \$50/);

  const q40 = await quoteFor(bnb(40));
  h.svc.trade({ address: MEME, chain: "bsc", side: "buy", amount: bnb(41), quoteId: q40.id });
  last = h.trades().at(-1)!;
  assert.match(last.error ?? "", /数量与报价不一致/);

  const qTiny = await quoteFor(bnb(0.5));
  h.svc.trade({ address: MEME, chain: "bsc", side: "buy", amount: bnb(0.5), quoteId: qTiny.id });
  last = h.trades().at(-1)!;
  assert.match(last.error ?? "", /最低 \$1/);

  // 余额 0.05 BNB ≈ $35：买 $40 → 余额不足，swap 未调用
  const q40b = await quoteFor(bnb(40));
  h.svc.trade({ address: MEME, chain: "bsc", side: "buy", amount: bnb(40), quoteId: q40b.id });
  const id = h.trades().at(-1)!.id;
  await until(() => h.statuses(id).includes("failed"));
  assert.match(h.trades().find((e) => e.id === id && e.status === "failed")!.error ?? "", /余额不足/);
  assert.equal(h.okx.swaps.length, 0, "余额不够就不问 OKX swap");

  // 充够钱：先买 $30 成功，再买 $31 → 超日限 60
  h.wallet.native.set("bsc", toRaw(1, 18));
  await h.svc.refreshBalances();
  const q30 = await quoteFor(bnb(30));
  h.svc.trade({ address: MEME, chain: "bsc", side: "buy", amount: bnb(30), quoteId: q30.id });
  const okId = h.trades().at(-1)!.id;
  await until(() => h.statuses(okId).includes("confirmed"));
  const q31 = await quoteFor(bnb(31));
  h.svc.trade({ address: MEME, chain: "bsc", side: "buy", amount: bnb(31), quoteId: q31.id });
  last = h.trades().at(-1)!;
  assert.match(last.error ?? "", /超今日上限 \$60/);
  assert.equal(h.svc.state().limits.dayUsed, 30);
  h.svc.close();
  console.log("ok limits: per-trade, per-day, min, balance and amount/quote mismatch refused before swap");
}

// ④ 卖出只按百分比：现读持仓；allowance 不够 → 先 approve（额度=卖出量）再 swap（两笔链上交易）；usd 按现价折算；没给 pct 直接拒
{
  const h = harness();
  await h.svc.start();
  h.wallet.memeBalance = toRaw(1_000_000, 9);
  h.svc.quote({ address: MEME, chain: "bsc", side: "sell", pct: 50 });
  await until(() => h.quotes().length === 1);
  const q = h.quotes()[0];
  assert.equal(q.ok, true);
  assert.equal(q.amount, 0, "sell 事件 amount 固定 0");
  assert.equal(q.pct, 50);
  assert.equal(q.outSymbol, "BNB");
  assert.equal(q.usd, 500, "卖出估值 = 数量 × 引擎现价");
  h.svc.trade({ address: MEME, chain: "bsc", side: "sell", amount: 0, pct: 50, quoteId: q.id });
  const id = h.trades()[0].id;
  assert.equal(h.trades()[0].usd, 500, "账本估值沿用报价里的现价估值");
  await until(() => h.statuses(id).includes("confirmed"));
  assert.equal(h.okx.approves, 1, "allowance 0 → 一次 approve-transaction");
  assert.equal(h.wallet.sent.length, 2, "approve + swap 两笔");
  assert.equal(h.wallet.sent[0].to.toLowerCase(), MEME, "approve 发给代币合约");
  assert.equal(h.okx.swaps[0].amountRaw, toRaw(500_000, 9));
  const details = h.trades().filter((e) => e.id === id).map((e) => e.detail);
  assert.ok(details.includes("授权中…") && details.some((d) => d?.startsWith("已授权")), "授权进度对用户可见");
  // 第二次卖：allowance 足够 → 不再 approve
  h.wallet.allowance = toRaw(1_000_000, 9);
  h.svc.quote({ address: MEME, chain: "bsc", side: "sell", pct: 100 });
  await until(() => h.quotes().length === 2);
  h.svc.trade({ address: MEME, chain: "bsc", side: "sell", amount: 0, pct: 100, quoteId: h.quotes()[1].id });
  const id2 = h.trades().find((e) => e.id !== id)!.id;
  await until(() => h.statuses(id2).includes("confirmed"));
  assert.equal(h.okx.approves, 1);
  assert.equal(h.wallet.sent.length, 3);
  // 没给 pct：不再有「按 USD 卖」的路径
  h.svc.quote({ address: MEME, chain: "bsc", side: "sell" });
  await until(() => h.quotes().length === 3);
  assert.equal(h.quotes()[2].ok, false);
  assert.match(h.quotes()[2].error ?? "", /按持仓百分比/);
  h.svc.close();
  console.log("ok sell: pct only, fresh position read, approve only when allowance short, usd valuation");
}

// ⑤ 地址锁 + 回执超时 → unknown → 对账 confirmed；期间同地址新意图只回放当前记录、不新建
{
  const h = harness();
  await h.svc.start();
  h.wallet.next = "hang";
  h.svc.quote({ address: MEME, chain: "bsc", side: "buy", amount: bnb(10) });
  await until(() => h.quotes().length === 1);
  h.svc.trade({ address: MEME, chain: "bsc", side: "buy", amount: bnb(10), quoteId: h.quotes()[0].id });
  const id = h.trades()[0].id;
  await until(() => h.statuses(id).includes("submitted"));
  // 在飞：新意图被拒（回放 submitted，不产生新 id）
  h.svc.quote({ address: MEME, chain: "bsc", side: "buy", amount: bnb(5) });
  await until(() => h.quotes().length === 2);
  h.svc.trade({ address: MEME, chain: "bsc", side: "buy", amount: bnb(5), quoteId: h.quotes()[1].id });
  assert.deepEqual([...new Set(h.trades().map((e) => e.id))], [id], "锁期间不新建记录");
  assert.equal(h.trades().at(-1)!.status, "submitted", "回放当前记录");
  h.svc.quickTrade({ id: "quick-1", address: MEME, chain: "bsc", side: "buy", amount: bnb(5) });
  assert.deepEqual([...new Set(h.trades().map((e) => e.id))], [id], "quick trade 同样被锁");
  // 回执超时 → unknown（有 hash）→ 对账 receiptEvm 成功 → confirmed
  await until(() => h.statuses(id).includes("unknown"), 1000);
  assert.equal(h.trades().find((e) => e.status === "unknown")!.txHash, HASH);
  await until(() => h.statuses(id).includes("confirmed"), 1000);
  assert.equal(h.store.tradeById(id)!.exec.outRaw, h.wallet.receivedRaw.toString(), "对账也解析到账");
  assert.equal(h.okx.swaps.length, 1, "对账不重发");
  h.svc.close();
  console.log("ok lock + receipt timeout → unknown → reconciled confirmed without resubmit");
}

// ⑥ 重启恢复：submitted 行 → unknown 并对账；validating 行 → failed 放开锁；quick trade 同 id 重放只回放
{
  const seedId = "seed-submitted";
  const h = harness({}, (store) => {
    const base: TradeEvent = { t: "trade", id: seedId, address: MEME, chain: "bsc", side: "buy", usd: 10, pct: null, status: "submitted", txHash: HASH, error: null, detail: null, ts: 1 };
    store.saveTrade(base, "q:seed", { inRaw: "1", decimals: 9, symbol: "MEME" });
    store.saveTrade({ ...base, id: "seed-validating", address: "0xabc0000000000000000000000000000000000002", status: "validating", txHash: null }, "q:seed2");
    store.saveTrade({ ...base, id: "quick-old", address: "0xabc0000000000000000000000000000000000003", status: "confirmed" }, "quick:quick-old");
  });
  await h.svc.start();
  const restored = h.trades();
  assert.equal(restored.find((e) => e.id === seedId)!.status, "unknown");
  assert.equal(restored.find((e) => e.id === "seed-validating")!.status, "failed");
  await until(() => h.statuses(seedId).includes("confirmed"), 1000);
  assert.equal(h.store.tradeById(seedId)!.ev.status, "confirmed");
  const before = h.trades().length;
  h.svc.quickTrade({ id: "quick-old", address: "0xabc0000000000000000000000000000000000003", chain: "bsc", side: "buy", amount: bnb(10) });
  assert.equal(h.trades().length, before + 1);
  assert.equal(h.trades().at(-1)!.id, "quick-old");
  assert.equal(h.trades().at(-1)!.status, "confirmed", "同 id 重放只回放账本里的那条");
  assert.equal(h.okx.swaps.length, 0);
  h.svc.close();
  console.log("ok restart: submitted→unknown→reconciled, validating→failed, quick replay by id");
}

// ⑦ 链上 revert → failed 带 hash；OKX 报流动性不足 → failed 中文原因、未发交易
{
  const h = harness();
  await h.svc.start();
  h.wallet.next = "revert";
  h.svc.quote({ address: MEME, chain: "bsc", side: "buy", amount: bnb(10) });
  await until(() => h.quotes().length === 1);
  h.svc.trade({ address: MEME, chain: "bsc", side: "buy", amount: bnb(10), quoteId: h.quotes()[0].id });
  const id = h.trades()[0].id;
  await until(() => h.statuses(id).includes("failed"));
  const f = h.trades().find((e) => e.id === id && e.status === "failed")!;
  assert.equal(f.txHash, HASH);
  assert.match(f.error ?? "", /revert/);
  h.okx.failSwap = new OkxError("liquidity", "OKX 82000: insufficient liquidity", "82000", 200);
  h.svc.quote({ address: MEME, chain: "bsc", side: "buy", amount: bnb(10) });
  await until(() => h.quotes().length === 2);
  h.svc.trade({ address: MEME, chain: "bsc", side: "buy", amount: bnb(10), quoteId: h.quotes()[1].id });
  const id2 = h.trades().find((e) => e.id !== id)!.id;
  await until(() => h.statuses(id2).includes("failed"));
  assert.equal(h.trades().find((e) => e.id === id2 && e.status === "failed")!.error, "流动性不足");
  assert.equal(h.wallet.sent.length, 1, "OKX 拒绝时没有链上交易");
  h.svc.close();
  console.log("ok failures: on-chain revert keeps hash; OKX liquidity error is readable and sends nothing");
}

// ⑧ 对账三态（2026-09-10 真钱首单：BSC 节点 403 拒 getTransactionReceipt，链上其实已成交）：
//    节点报错 → 记录保持 unknown、detail 写明原因、继续重试，哪怕早过了 30 分钟也不许判 not_mined；节点恢复给回执 → confirmed。
//    另一条老记录节点明确说「没有」→ 过了放弃期才按 not_mined 失败
{
  const OLD = "0xabc0000000000000000000000000000000000009";
  const h = harness({}, (store) => {
    const base: TradeEvent = { t: "trade", id: "old-403", address: MEME, chain: "bsc", side: "buy", usd: 10, pct: null, status: "submitted", txHash: HASH, error: null, detail: null, ts: 1 };
    store.saveTrade(base, "q:a", { inRaw: "1", decimals: 9, symbol: "MEME" });
    store.saveTrade({ ...base, id: "old-missing", address: OLD, txHash: ("0x" + "cd".repeat(32)) as `0x${string}` }, "q:b");
  });
  h.wallet.receipt = "throw";
  await h.svc.start();
  await until(() => h.wallet.receiptCalls >= 4);
  const stuck = h.trades().filter((e) => e.id === "old-403");
  assert.equal(stuck.every((e) => e.status === "unknown"), true, "节点出错期间不许离开 unknown");
  assert.match(stuck.at(-1)!.detail ?? "", /对账读节点失败：HTTP 403/);
  assert.equal(h.trades().filter((e) => e.id === "old-403" && /读节点失败/.test(e.detail ?? "")).length, 1, "相同错误只落一次，不刷屏");
  assert.equal(h.trades().some((e) => e.error === "not_mined"), false, "读不到 ≠ 没上链");
  h.wallet.receipt = "ok";
  await until(() => h.statuses("old-403").includes("confirmed"), 1000);
  assert.equal(h.store.tradeById("old-403")!.exec.outRaw, h.wallet.receivedRaw.toString(), "恢复后照常解析到账");
  assert.equal(h.statuses("old-missing").includes("confirmed"), true, "假钱包对任何 hash 都给成功回执，这条也随之确认");
  h.svc.close();
  // 节点明确说没有：单独一条早已超过放弃期的记录 → not_mined
  const h2 = harness({}, (store) => {
    store.saveTrade({ t: "trade", id: "gone", address: MEME, chain: "bsc", side: "buy", usd: 10, pct: null, status: "submitted", txHash: HASH, error: null, detail: null, ts: 1 }, "q:c");
  });
  h2.wallet.receipt = "null";
  await h2.svc.start();
  await until(() => h2.statuses("gone").includes("failed"), 1000);
  assert.equal(h2.trades().find((e) => e.id === "gone" && e.status === "failed")!.error, "not_mined");
  h2.svc.close();
  console.log("ok reconcile tri-state: node error keeps unknown with reason; node null past give-up → not_mined; recovery confirms");
}

// ⑨ 弹卡开着：焦点币所在链原生币 + 该币余额按 focusEveryMs 轮询（只这一条链），余额变了才推 state/holdings；卡关了轮询停
{
  const h = harness();
  await h.svc.start();
  const n0 = h.wallet.nativeReads;
  const e0 = h.wallet.erc20Reads;
  const states0 = h.events.filter((e) => e.t === "trade_state").length;
  h.svc.focusChanged(MEME, "bsc");
  await sleep(120);
  assert.equal(h.okx.warms, 1, "开卡预热一次到接口端点的连接（不占 OKX 配额）");
  assert.equal(h.wallet.gasPriceCalls, 1, "开卡预拉一次 gasPrice，60s 内不重拉");
  const nativeTicks = h.wallet.nativeReads - n0;
  const erc20Ticks = h.wallet.erc20Reads - e0;
  assert.ok(nativeTicks >= 8 && nativeTicks <= 14, `原生币每拍读一次（只焦点链）：${nativeTicks}`);
  assert.ok(erc20Ticks >= 8 && erc20Ticks <= 14, `代币每拍读一次：${erc20Ticks}`);
  const statesIdle = h.events.filter((e) => e.t === "trade_state").length - states0;
  assert.ok(statesIdle <= 1, `余额没变不推 state（首拍算一次）：${statesIdle}`);
  h.wallet.native.set("bsc", toRaw(0.07, 18));
  await until(() => h.svc.state().balances.bsc.native === 0.07, 500);
  h.svc.focusChanged(null, null);
  const nStop = h.wallet.nativeReads;
  await sleep(60);
  assert.equal(h.wallet.nativeReads, nStop, "卡关了不再轮询");
  h.svc.close();
  console.log("ok focus loop: polls only the focused chain, emits on change, stops on unfocus");
}

// ⑩ 原生币价缓存为空（DexScreener 挂了）：报价照常但估值 / 网络费为 null；买入执行因无法校验限额而拒单（quote 与 quick 都是）；卖出按 pct 不受影响；价回来后买入放行
{
  const h = harness({}, undefined, null);
  await h.svc.start();
  assert.equal(h.svc.state().balances.bsc.price, null);
  assert.equal(h.svc.state().balances.bsc.usd, null, "没价 → 余额 USD 未知");
  h.svc.quote({ address: MEME, chain: "bsc", side: "buy", amount: bnb(10) });
  await until(() => h.quotes().length === 1);
  const q = h.quotes()[0];
  assert.equal(q.ok, true, "报价不依赖原生币价");
  assert.equal(q.amount, bnb(10));
  assert.equal(q.usd, null, "估值未知");
  assert.equal(q.networkFeeUsd, null, "网络费没法折 USD");
  assert.ok(q.outAmount && q.outAmount > 0);
  h.svc.trade({ address: MEME, chain: "bsc", side: "buy", amount: bnb(10), quoteId: q.id });
  let last = h.trades().at(-1)!;
  assert.equal(last.status, "failed");
  assert.match(last.error ?? "", /原生币美元价未知/);
  h.svc.quickTrade({ id: "quick-noprice", address: MEME, chain: "bsc", side: "buy", amount: bnb(10) });
  last = h.trades().at(-1)!;
  assert.equal(last.id, "quick-noprice");
  assert.match(last.error ?? "", /原生币美元价未知/);
  assert.equal(h.okx.swaps.length, 0, "没价不下单");
  // 卖出：pct 计价，估值走引擎现价，与原生币价无关
  h.wallet.memeBalance = toRaw(1_000_000, 9);
  h.svc.quote({ address: MEME, chain: "bsc", side: "sell", pct: 100 });
  await until(() => h.quotes().length === 2);
  const qs = h.quotes()[1];
  assert.equal(qs.ok, true);
  assert.equal(qs.usd, 1000, "卖出估值 = 数量 × 引擎现价");
  h.svc.trade({ address: MEME, chain: "bsc", side: "sell", amount: 0, pct: 100, quoteId: qs.id });
  const sellId = h.trades().at(-1)!.id;
  await until(() => h.statuses(sellId).includes("confirmed"));
  assert.equal(h.okx.swaps.length, 1);
  // 价回来了：同一份买入报价重新点（报价没被消费）→ 放行
  h.prices.value = BNB_USD;
  h.svc.trade({ address: MEME, chain: "bsc", side: "buy", amount: bnb(10), quoteId: q.id });
  const buyId = h.trades().at(-1)!.id;
  assert.equal(h.trades().at(-1)!.usd, 10, "价回来后账本估值按新价");
  await until(() => h.statuses(buyId).includes("confirmed"));
  assert.equal(h.okx.swaps.length, 2);
  h.svc.close();
  console.log("ok no native price: quote ok with null usd/fee, buy refused, sell unaffected, buy allowed once price is back");
}

console.log("trade: ok");
