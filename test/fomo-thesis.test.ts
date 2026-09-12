/**
 * 弹卡「fomo Thesis」列契约（模拟 REST）：`GET /feed/token/thesis`（全站用户、threshold=0 = 全部金额）→ `fomo_thesis` 事件。
 * 守住：弹卡 focus 就拉首页且**只推焦点币**；「加载更多」用最后一条 id 当 lastId 翻页、追加、直到服务端 hasNextPage=false；
 * 首页重拉合并不丢已翻到的页；响应形状不对 → `schema`（不当成空列表）；非 2xx → `fetch_failed` 且保留旧条目；
 * 运行：node --import tsx test/fomo-thesis.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { FomoService } from "../src/core/fomo.js";
import { Store } from "../src/core/store.js";
import type { FomoThesisEvent, OutEvent } from "../src/core/types.js";

const TOKEN = "0xb7896f3c8f18b2308e4dde6b3e95034702477777"; // 刀哥@bsc（真机 count=175 的那张）
const OTHER = "0x2222222222222222222222222222222222222222";
const THIRD = "0x3333333333333333333333333333333333333333";
const FOURTH = "0x4444444444444444444444444444444444444444";

const item = (i: number, handle: string) => ({
  type: "thesis",
  id: `t${i}`,
  createdAt: new Date(1_788_762_812_000 - i * 60_000).toISOString(),
  displayName: handle,
  userHandle: handle,
  profilePictureLink: null,
  verified: false,
  numReplies: 0,
  comment: { id: `t${i}`, comment: `thesis ${i}`, numLikes: i, parentId: null },
  authorTrade: i % 2 ? { humanTokenAmount: 10, usdValue: 100 + i, percentageUnrealizedPnl: -5 } : null,
  isDev: false,
});
// 服务端：75 条（全站 3 个 handle），每页 50，lastId 翻页；mode 切成 schema / 500 用来验失败路径
const state = { calls: [] as string[], mode: "ok" as "ok" | "schema" | "fail" };
const api = http.createServer((req, res) => {
  const ok = (o: unknown) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, message: "ok", responseObject: o, statusCode: 200 }));
  };
  const u = req.url ?? "";
  if (u.startsWith("/feed/token/thesis")) {
    state.calls.push(u);
    const q = new URL(u, "http://x").searchParams;
    assert.equal(q.get("networkId"), "56");
    // 服务端语义：threshold 缺省 = 只回 >$1K 的；threshold=0 才是全部。小额 thesis（usd < 1000）只在 threshold=0 时出现
    const minSize = q.get("threshold") === null ? 1000 : Number(q.get("threshold"));
    if (state.mode === "schema") return ok({ theses: [] });
    if (state.mode === "fail") {
      res.writeHead(500);
      return res.end("{}");
    }
    const all = Array.from({ length: 75 }, (_, i) => item(i, ["Rowdy", "8channa8", "MKSIIXBT"][i % 3]!)).filter((x) => (x.authorTrade?.usdValue ?? 0) >= minSize || minSize === 0);
    const lastId = q.get("lastId");
    const start = lastId ? all.findIndex((x) => x.id === lastId) + 1 : 0;
    const page = all.slice(start, start + 50);
    return ok({ items: page, hasNextPage: start + 50 < all.length, count: 175 });
  }
  if (u.includes("/followingIds")) return ok({ followingIds: [] });
  if (u.includes("/followingPaginate")) return ok({ users: [] });
  if (u.includes("/feed/tradingActivity")) return ok({ items: [], hasNextPage: false });
  if (u.includes("/hodlers/friends")) return ok({ tokens: [] });
  if (u.startsWith("/hodlers/top")) return ok([]);
  res.writeHead(404);
  res.end("{}");
});

const fakeJwt = () => `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.y`;
class FakeBridge {
  events: OutEvent[] = [];
  loggedIn = true;
  emit(e: OutEvent) {
    this.events.push(e);
  }
  async rpc(method: string): Promise<unknown> {
    if (method === "fomo.token") return { token: this.loggedIn ? fakeJwt() : null };
    if (method === "fomo.me") return this.loggedIn ? { userId: "u1", handle: "sim", following: 0 } : null;
    throw new Error(`unexpected rpc ${method}`);
  }
}
const until = async (pred: () => boolean, what: string, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};
const pass = (n: string, extra = "") => console.log(`ok ${n}${extra ? ` — ${extra}` : ""}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fomo-thesis-"));
const store = new Store(path.join(tmp, "t.sqlite"));
let svc: FomoService | undefined;
try {
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", () => r()));
  const apiBase = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  const bridge = new FakeBridge();
  let focused: string | null = null;
  svc = new FomoService(store, bridge as never, {
    tracked: () => [TOKEN, OTHER, THIRD, FOURTH].map((address) => ({ address, chain: "bsc" })),
    focused: () => (focused ? { address: focused, chain: "bsc" } : null),
    symbolOf: () => "刀哥",
    gmgnTopHolders: async () => ({ rows: [], more: false }),
    apiBase,
    wsUrl: "wss://127.0.0.1:1/ws",
  });
  svc.start();
  const thesisEvents = () => bridge.events.filter((e): e is FomoThesisEvent => e.t === "fomo_thesis");
  const lastThesis = () => thesisEvents()[thesisEvents().length - 1];

  // 1. 弹卡 focus → 首页：50 条、全站 3 个 handle、hasNext、count 原样
  await until(() => !!bridge.events.find((e) => e.t === "fomo_state" && e.loggedIn), "login");
  focused = TOKEN;
  svc.focusChanged(TOKEN);
  await until(() => lastThesis()?.error === null && !lastThesis()!.loading && lastThesis()!.items.length > 0, "first page after focus");
  let ev = lastThesis()!;
  assert.equal(ev.items.length, 50);
  assert.equal(ev.hasNext, true);
  assert.equal(ev.count, 175);
  assert.deepEqual([...new Set(ev.items.map((x) => x.handle))].sort(), ["8channa8", "MKSIIXBT", "Rowdy"]);
  assert.equal(ev.items[0]!.id, "t0", "newest first");
  assert.equal(ev.items[1]!.position?.usd, 101, "authorTrade usdValue kept when amount > 0");
  assert.equal(ev.items[0]!.position, null, "no authorTrade → no position (small / no-position thesis must still arrive = all sizes)");
  assert.equal(state.calls.length, 1);
  pass("first page on focus", `${ev.items.length} items, count=${ev.count}, hasNext=${ev.hasNext}`);

  // 2. 加载更多：lastId = 最后一条 id；追加到 75 条，服务端 hasNextPage=false → hasNext=false；再点不发请求
  svc.thesisMore(TOKEN);
  await until(() => lastThesis()!.items.length === 75 && !lastThesis()!.loading, "second page appended");
  ev = lastThesis()!;
  assert.match(state.calls[1]!, /lastId=t49/);
  assert.equal(ev.hasNext, false);
  svc.thesisMore(TOKEN);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(state.calls.length, 2, "no more pages when server said hasNextPage=false");
  pass("load more via lastId until server exhausts", `${ev.items.length} items after ${state.calls.length} requests`);

  // 3. 只推焦点币：换到别的卡后旧卡的响应不推给 Swift；新卡自己拉
  const before = thesisEvents().length;
  focused = OTHER;
  svc.focusChanged(OTHER);
  await until(() => lastThesis()?.address === OTHER && !lastThesis()!.loading && lastThesis()!.items.length > 0, "other card page");
  assert.ok(thesisEvents().slice(before).every((e) => e.address === OTHER), "events after switching are for the focused card only");
  pass("only focused card is pushed");

  // 4. 响应形状不对 → schema 错误（不伪装成空列表）；非 2xx → fetch_failed。用还没有缓存的两张卡，走同一条 focus 路径
  state.mode = "schema";
  focused = THIRD;
  svc.focusChanged(THIRD);
  await until(() => lastThesis()?.address === THIRD && lastThesis()!.error === "schema", "schema error");
  assert.equal(lastThesis()!.items.length, 0);
  state.mode = "fail";
  focused = FOURTH;
  svc.focusChanged(FOURTH);
  await until(() => lastThesis()?.address === FOURTH && lastThesis()!.error === "fetch_failed", "fetch_failed");
  pass("schema mismatch / 5xx → explicit errors, not empty lists");

  console.log("\nFOMO THESIS OK（模拟合约测试）");
} finally {
  svc?.close();
  api.close();
  store.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
