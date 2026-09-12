import assert from "node:assert/strict";
import { mock } from "node:test";
import { Engine } from "../src/core/engine.js";
import { Store } from "../src/core/store.js";
import type { GmgnFetchParams, OutEvent } from "../src/core/types.js";

const TOKEN = "0x0000000000000000000000000000000000000042";
const OTHER = "0x0000000000000000000000000000000000000043";
const SOL = "AbCdEfGhJKLMNPqRsTuVwXyZ123456789abcdefghijk";
const clock = 1_780_000_020;
mock.timers.enable({ apis: ["setTimeout"] });
async function until(check: () => boolean, why: string): Promise<void> {
  for (let turn = 0; turn < 200 && !check(); turn++) {
    await Promise.resolve();
    mock.timers.tick(200);
  }
  assert.ok(check(), why);
}

class FixtureBridge {
  events: OutEvent[] = [];
  unexpected: string[] = [];
  candleMode: "data" | "empty" | "error" = "data";
  paginated = false;
  candleGate: { started: () => void; wait: Promise<void> } | null = null;
  emit(event: OutEvent): void { this.events.push(event); }
  async rpc(): Promise<null> { return null; }
  async gmgnFetch(params: GmgnFetchParams) {
    const url = new URL(params.path, "https://fixture.invalid");
    const body = params.body as { chain: string; addresses: string[] } | undefined;
    const ok = (data: unknown) => ({ status: 200, body: JSON.stringify({ code: 0, data }) });
    if (url.pathname === "/api/v1/mutil_window_token_info") {
      return ok(body!.addresses.map((address) => ({ address, symbol: body!.chain.toUpperCase(), name: `${body!.chain} holding`, total_supply: "100", price: { price: body!.chain === "base" ? "20" : "10" }, liquidity: "500", holder_count: 12 })));
    }
    if (url.pathname === "/mrwapi/v1/multi_token_full_info") {
      return ok(body!.addresses.map((address) => ({ address, link: { twitter_username: `${body!.chain}_official`, website: `https://${body!.chain}.example/` }, ath_price: "30", ath_market_cap: "3000", ath_ts: clock })));
    }
    if (url.pathname === "/vas/api/v1/twitter/token/search") return ok([]);
    if (url.pathname === "/api/v1/twitter/user_profile") return ok({ screen_name: url.searchParams.get("username"), name: "Official profile", description: "Chain-specific official account", followers_count: 18 });
    if (url.pathname.endsWith("/community/messages")) {
      const chain = url.pathname.split("/")[4];
      const next = url.searchParams.get("cursor") === "next";
      return ok({ chain, has_more: this.paginated && !next, next_cursor: this.paginated && !next ? "next" : null, messages: [{ ulid: `${chain}-call${next ? "-next" : ""}`, username: "reader", content: `${chain} discussion${next ? " page 2" : ""}`, created_at: new Date(clock * 1000).toISOString() }] });
    }
    if (url.pathname.includes("/token_mcap_candles/")) {
      const chain = url.pathname.split("/")[4];
      const gate = this.candleGate;
      this.candleGate = null;
      if (gate) { gate.started(); await gate.wait; }
      if (this.candleMode === "error") return { status: 503, body: "unavailable" };
      if (this.candleMode === "empty") return ok({ list: [] });
      const price = chain === "base" ? 2000 : 1000;
      return ok({ list: [{ time: clock * 1000, open: String(price), high: String(price + 10), low: String(price - 10), close: String(price + 1), volume: "5" }] });
    }
    this.unexpected.push(params.path);
    throw new Error(`Unexpected fixture request: ${params.path}`);
  }
}

const store = new Store(":memory:");
const bridge = new FixtureBridge();
const engine = new Engine(store, bridge as never);
// Replace only the real network transport; focus and all parsing/loading/dispatch logic are production code.
const socket = (engine as unknown as { ws: { watch(target: { chain: string; address: string } | null): void } }).ws;
let watched: { chain: string; address: string } | null = null;
socket.watch = (target) => { watched = target; };
const details = () => bridge.events.filter((event): event is Extract<OutEvent, { t: "token_detail" }> => event.t === "token_detail");
const charts = () => bridge.events.filter((event): event is Extract<OutEvent, { t: "kline" }> => event.t === "kline");
const calls = () => bridge.events.filter((event): event is Extract<OutEvent, { t: "gmgn_calls" }> => event.t === "gmgn_calls");
const readyDetail = (address: string, chain: string) => details().findLast((event) => event.token.address === address && event.token.market?.chain === chain && event.token.profile?.screen === `${chain}_official`);

try {
  engine.focus(TOKEN, "bsc");
  await engine.kline(TOKEN, "1m", clock - 60, clock + 60, true, "bsc");
  await until(() => !!readyDetail(TOKEN, "bsc"), "holding outside monitored tokens must receive enriched detail");
  await until(() => calls().some((event) => event.address === TOKEN && event.chain === "bsc" && event.items[0]?.text === "bsc discussion"), "untracked holding must load GMGN discussion");
  assert.equal(readyDetail(TOKEN, "bsc")!.token.market?.mc, 1000);
  assert.equal(readyDetail(TOKEN, "bsc")!.token.links?.website, "https://bsc.example/");
  assert.equal(readyDetail(TOKEN, "bsc")!.token.ath?.mc, 3000);
  assert.deepEqual(charts().findLast((event) => event.chain === "bsc")?.bars[0]?.slice(0, 5), [clock, 1000, 1010, 990, 1001]);
  assert.deepEqual(watched, { chain: "bsc", address: TOKEN });
  console.log("ok untracked holding: market, candles, official profile and community loaded");

  const gate = Promise.withResolvers<void>();
  const start = Promise.withResolvers<void>();
  bridge.candleGate = { started: start.resolve, wait: gate.promise };
  const oldChart = engine.kline(TOKEN, "5m", clock - 300, clock + 300, true, "bsc");
  await start.promise;
  engine.focus(TOKEN, "base");
  await engine.kline(TOKEN, "1m", clock - 60, clock + 60, true, "base");
  await until(() => !!readyDetail(TOKEN, "base"), "same address on a second chain must load its own detail");
  gate.resolve();
  await oldChart;
  await engine.kline(TOKEN, "1m", clock - 60, clock + 60, true, "base");
  assert.equal(charts().at(-1)?.chain, "base");
  assert.equal(charts().at(-1)?.bars[0]?.[1], 2000, "late BSC response must not contaminate BASE cache");
  assert.equal(details().at(-1)?.token.profile?.screen, "base_official");
  assert.deepEqual(watched, { chain: "base", address: TOKEN });
  console.log("ok same-address chain switch: distinct chart/social data; late old-chain response isolated");

  engine.focus(OTHER, "bsc");
  bridge.candleMode = "error";
  await engine.kline(OTHER, "1m", clock - 60, clock + 60, true, "bsc");
  assert.equal(charts().at(-1)?.address, OTHER);
  assert.match(charts().at(-1)?.error ?? "", /503/, "failed request must produce an error, not leave the chart loading");
  bridge.candleMode = "empty";
  await engine.kline(OTHER, "1m", clock - 60, clock + 60, true, "bsc");
  assert.equal(charts().at(-1)?.error ?? null, null);
  assert.deepEqual(charts().at(-1)?.bars, [], "successful empty result is distinct from a failed load");
  console.log("ok chart failure/empty result: explicit outcomes, failed range not cached as success");

  engine.focus(SOL, "sol");
  await engine.kline(SOL, "1m", clock - 60, clock + 60, true, "sol");
  await until(() => !!readyDetail(SOL, "sol"), "Solana holding identity must retain base58 case through adapters");
  assert.equal(charts().at(-1)?.address, SOL);
  engine.focus(null);
  assert.equal(watched, null);
  assert.deepEqual(engine.views(), [], "opening holding details must not populate the chat monitoring list");
  const storedTokens = store.db.prepare("SELECT COUNT(*) AS n FROM tokens").get();
  const storedSamples = store.db.prepare("SELECT COUNT(*) AS n FROM samples").get();
  assert.deepEqual(storedTokens, { n: 0 });
  assert.deepEqual(storedSamples, { n: 0 });
  assert.deepEqual(bridge.unexpected, []);
  console.log("ok close and isolation: no WS focus, no fake monitored tokens or samples, Solana case retained");

  // 相同地址：群聊监听 BSC，但当前持仓详情在 BASE。分页必须继续当前链，不能回到监听币。
  bridge.paginated = true;
  bridge.candleMode = "data";
  store.upsertToken({ address: OTHER, chainHint: "bsc", market: { chain: "bsc", symbol: "TRACKED", price: 10, mc: 1000, source: "gmgn", updatedAt: clock }, mentions: [], history: [], links: {}, ath: null, profile: null, official: [], tweets: [], tweetsAt: 0 });
  engine.start();
  engine.focus(OTHER, "base");
  await until(() => calls().some((event) => event.address === OTHER && event.chain === "base" && event.hasNext), "BASE holding discussion should expose its next page");
  engine.gmgnCallsMore(OTHER);
  await until(() => calls().some((event) => event.address === OTHER && event.chain === "base" && event.items.some((item) => item.text === "base discussion page 2")), "pagination must resolve focused BASE holding, not tracked BSC token");
  await until(() => !!readyDetail(OTHER, "base"), "focused holding metadata must finish independently of the tracked chain");
  assert.equal(engine.views().find((token) => token.address === OTHER)?.market?.chain, "bsc");
  assert.deepEqual(bridge.unexpected, []);
  console.log("ok tracked/untracked same-address pagination remains on the focused chain");
  console.log("HOLDING DETAIL OK (isolated adapters; no real trades)");
} finally {
  engine.close();
  mock.timers.reset();
  store.db.close();
}
