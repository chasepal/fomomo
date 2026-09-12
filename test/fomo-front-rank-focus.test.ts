/**
 * 「fomo 前排」焦点契约（模拟 REST / gmgn）：弹卡一打开（Engine.focus → FomoService.focusChanged）就要拉一次前排快照，
 * 而不是等 15s 的 pollHolders tick——用户连点几张卡（每张 <5s）时前排永远「—」（2026-09-06 真机：focus 02:06:11，首份快照 02:06:29）。
 * 同时守住：换焦点不重复在飞、非焦点币不刷、失败快照 why 照常。
 * 主面板显示行契约（`front_rank_visible` → visibleChanged）：无弹卡也出快照、并发 1 串行、新鲜/未知/无链跳过、折叠不拉、失败不刷屏。
 * 运行：node --import tsx test/fomo-front-rank-focus.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { FomoService } from "../src/core/fomo.js";
import type { GmgnHoldersPage } from "../src/core/gmgn.js";
import { Store } from "../src/core/store.js";
import type { OutEvent } from "../src/core/types.js";

const TOKEN = "0xe4169a60231bb6b13087563baeb5be66faef9471"; // LOKIZ@robinhood（真机复现的那张卡）
const OTHER = "0x2222222222222222222222222222222222222222";
const THIRD = "0x3333333333333333333333333333333333333333";
const FOURTH = "0x4444444444444444444444444444444444444444";
const FIFTH = "0x6666666666666666666666666666666666666666";
const NOCHAIN = "0x5555555555555555555555555555555555555555";
const NET = 4663;

const state = { topCalls: 0, gmgnCalls: 0, friendsCalls: 0 };
const api = http.createServer((req, res) => {
  const ok = (o: unknown) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, message: "ok", responseObject: o, statusCode: 200 }));
  };
  const u = req.url ?? "";
  if (u.startsWith("/hodlers/top")) {
    state.topCalls++;
    const want = JSON.parse(decodeURIComponent(u.split("tokens=")[1]!)) as Array<{ address: string; networkId: number }>;
    // 46 行（LOKIZ 真机就是不满 50 的）
    return ok([{ networkId: want[0]!.networkId, tokenAddress: want[0]!.address, totalHolders: 46, topHolders: Array.from({ length: 46 }, (_, i) => ({ humanAmount: 1000 - i, user: { id: `u${i}` } })) }]);
  }
  if (u.includes("/followingIds")) return ok({ followingIds: [] });
  if (u.includes("/followingPaginate")) return ok({ users: [] });
  if (u.includes("/feed/tradingActivity")) return ok({ items: [], hasNextPage: false });
  if (u.includes("/hodlers/friends")) { state.friendsCalls++; return ok({ tokens: [] }); }
  res.writeHead(404);
  res.end("{}");
});

const fakeJwt = () => `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.y`;
class FakeBridge {
  events: OutEvent[] = [];
  emit(e: OutEvent) {
    this.events.push(e);
  }
  async rpc(method: string): Promise<unknown> {
    if (method === "fomo.token") return { token: fakeJwt() };
    if (method === "fomo.me") return { userId: "u1", handle: "sim", following: 0 };
    throw new Error(`unexpected rpc ${method}`);
  }
}
const until = async (pred: () => boolean, what: string, ms = 8000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};
const pass = (n: string, extra = "") => console.log(`ok ${n}${extra ? ` — ${extra}` : ""}`);
const gmgnPage = (): GmgnHoldersPage => ({ rows: Array.from({ length: 100 }, (_, i) => ({ address: `0x${(i + 1).toString(16).padStart(40, "0")}`, amount: 2000 - i, addrType: i === 0 ? 2 : 0 })), more: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fomo-front-focus-"));
const store = new Store(path.join(tmp, "t.sqlite"));
let svc: FomoService | undefined;
try {
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", () => r()));
  const apiBase = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  const bridge = new FakeBridge();
  let focused: string | null = null;
  let gmgnFail = false;
  let gmgnHook: () => Promise<GmgnHoldersPage> = async () => gmgnPage();
  svc = new FomoService(store, bridge as never, {
    tracked: () => [{ address: TOKEN, chain: "robinhood" }, { address: OTHER, chain: "robinhood" }, { address: THIRD, chain: "robinhood" }, { address: FOURTH, chain: "robinhood" }, { address: FIFTH, chain: "robinhood" }, { address: NOCHAIN, chain: undefined }],
    focused: () => (focused ? { address: focused, chain: focused === NOCHAIN ? null : "robinhood" } : null),
    symbolOf: () => "LOKIZ",
    gmgnTopHolders: async () => {
      state.gmgnCalls++;
      if (gmgnFail) throw new Error("gmgn down");
      return gmgnHook();
    },
    apiBase,
    wsUrl: "wss://127.0.0.1:1/ws",
  });
  svc.start();
  const last = <T extends OutEvent["t"]>(t: T) => [...bridge.events].reverse().find((e) => e.t === t) as Extract<OutEvent, { t: T }> | undefined;
  await until(() => !!last("fomo_state")?.loggedIn, "login");
  // 等登录流程跑完到首个 pollHolders tick（startHolders 立即 poll → POST /hodlers/friends）；loggedIn 事件在 loadFollowing / backfill 之前就发了，不能拿它当"tick 已跑"
  await until(() => state.friendsCalls >= 1, "first holders tick");
  assert.equal(state.topCalls, 0, "no front rank without focus");
  assert.equal(svc.view(TOKEN, "robinhood")?.frontRank, null, "no snapshot before focus");

  // 1. 弹卡打开 → 不等 15s tick，前排快照 2s 内落地（真机 tick 间隔 15s，这里 2s 是宽松上限；等的是条件不是时长）
  focused = TOKEN;
  svc.focusChanged(TOKEN);
  await until(() => svc!.view(TOKEN, "robinhood")?.frontRank !== null, "front rank snapshot right after focus (not waiting for 15s tick)", 2000);
  const fr = svc.view(TOKEN, "robinhood")!.frontRank!;
  assert.equal(fr.why, null);
  const fomoSum = Array.from({ length: 46 }, (_, i) => 1000 - i).reduce((a, b) => a + b, 0);
  const gmgnSum = Array.from({ length: 50 }, (_, i) => 2000 - (i + 1)).reduce((a, b) => a + b, 0); // 跳过第 1 名 pool
  assert.equal(fr.fomo?.n, 46);
  assert.equal(fr.gmgn?.n, 50);
  assert.equal(fr.gmgn?.pools, 1);
  assert.ok(Math.abs(fr.ratio! - fomoSum / gmgnSum) < 1e-12, `ratio ${fr.ratio} want ${fomoSum / gmgnSum}`);
  assert.equal(state.topCalls, 1);
  assert.equal(state.gmgnCalls, 1);
  pass("fetch on focus", `ratio=${(fr.ratio! * 100).toFixed(1)}% ·${fr.fomo!.n} after ${state.topCalls} fomo + ${state.gmgnCalls} gmgn call`);

  // 2. 同一张卡重复 focus（Swift 重发 / 链迟到再通知）→ 单飞 + 已有快照，不多打
  svc.focusChanged(TOKEN);
  svc.focusChanged(TOKEN);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(state.topCalls, 1, "re-focus on same card must not refetch");
  pass("re-focus same card: no extra request");

  // 3. 换到另一张卡 → 立刻拉那张卡；gmgn 失败 → 整份不可用 + why，不拼旧的一半
  gmgnFail = true;
  focused = OTHER;
  svc.focusChanged(OTHER);
  await until(() => svc!.view(OTHER, "robinhood")?.frontRank !== null, "second card snapshot right after focus", 2000);
  const fr2 = svc.view(OTHER, "robinhood")!.frontRank!;
  assert.equal(fr2.ratio, null);
  assert.equal(fr2.fomo, null);
  assert.ok(fr2.why, "failed source must leave a why");
  assert.equal(state.topCalls, 2);
  pass("switch card: immediate fetch, gmgn failure → unavailable", fr2.why!);

  // 4. 关卡（focus null）→ 不再拉
  focused = null;
  svc.focusChanged(null);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(state.topCalls, 2);
  pass("close card: no fetch");

  // 5. 主面板显示行（front_rank_visible，无弹卡）→ 无需 focus 也出快照；串行：第一行 gmgn 没回来前不发第二行；不在列表 / 无链的地址忽略
  gmgnFail = false;
  const gate = Promise.withResolvers<void>();
  let gmgnStarted = 0;
  gmgnHook = async () => {
    gmgnStarted++;
    if (gmgnStarted === 1) await gate.promise; // 第一行卡住
    return gmgnPage();
  };
  svc.visibleChanged([THIRD, "0x9999999999999999999999999999999999999999", NOCHAIN, TOKEN, OTHER, FOURTH]);
  await until(() => gmgnStarted === 1, "first visible row starts");
  await until(() => state.topCalls === 3, "first visible row's fomo call");
  assert.equal(svc.view(THIRD, "robinhood")?.frontRank, null, "nothing lands while the first row is pending");
  assert.equal(gmgnStarted, 1, "second row must wait for the first (serial queue)");
  gate.resolve();
  await until(() => svc!.view(THIRD, "robinhood")?.frontRank?.ratio != null && svc!.view(FOURTH, "robinhood")?.frontRank?.ratio != null, "visible rows get snapshots without focus", 3000);
  assert.equal(state.topCalls, 4, "TOKEN (fresh) and OTHER (recent failed snapshot) skipped; unknown / chainless ignored; THIRD + FOURTH fetched");
  assert.equal(svc.view(OTHER, "robinhood")?.frontRank?.ratio, null, "recent failed snapshot is kept, not hammered");
  pass("visible rows: serial fetch, fresh/failed/unknown/chainless skipped", `${state.topCalls} fomo calls`);

  // 6. 同一集合重发（Swift 300ms 去抖 / 重连回放）→ 全部新鲜，不多打
  svc.visibleChanged([THIRD, TOKEN, OTHER, FOURTH]);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(state.topCalls, 4, "replaying a fresh set must not refetch");
  pass("replay same set: no extra request");

  // 7. 折叠（[]）→ 队列空转，不拉；之后 gmgn 失败的行留 why，且 45s 内不重试（不刷屏）
  svc.visibleChanged([]);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(state.topCalls, 4);
  pass("collapsed: no fetch");
  gmgnFail = true;
  svc.visibleChanged([FIFTH]);
  await until(() => svc!.view(FIFTH, "robinhood")?.frontRank !== null, "failed visible row still gets a why snapshot", 2000);
  assert.equal(svc.view(FIFTH, "robinhood")!.frontRank!.ratio, null);
  assert.ok(svc.view(FIFTH, "robinhood")!.frontRank!.why);
  svc.visibleChanged([FIFTH]);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(state.topCalls, 5, "failed snapshot is not retried before FRONT_REFRESH_SEC");
  pass("visible row failure: unavailable + no hammering");
  console.log("\nFOMO FRONT RANK FOCUS OK（模拟合约测试）");
} finally {
  svc?.close();
  api.close();
  store.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
