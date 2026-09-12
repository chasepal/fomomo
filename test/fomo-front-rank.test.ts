/**
 * 「fomo 前排比例」纯计算合约（`fomo.ts frontRank`）：只排除 pool、分子只算前 50、截断/续页未知不出部分值、缺数据不变 0、分母 0 不可用、
 * 响应串位不可用。运行：node --import tsx test/fomo-front-rank.test.ts
 */
import assert from "node:assert/strict";
import { frontRank } from "../src/core/fomo.js";
import { topHolders, type GmgnHolder, type GmgnHoldersPage } from "../src/core/gmgn.js";

const WANT = { address: "0x39dbed3a2bd333467115de45665cc57f813c4571", networkId: 4663 };
const AT = 1_757_000_000;

const fomoEnv = (amounts: unknown[], over: Record<string, unknown> = {}) => ({
  tokenAddress: WANT.address.toUpperCase().replace("0X", "0x"), // fomo 回的大小写不一定与请求一致，0x 地址按小写比
  networkId: 4663,
  totalHolders: 27575,
  topHolders: amounts.map((humanAmount) => ({ humanAmount, user: { id: "u" } })),
  ...over,
});
const row = (amount: number, addrType = 0): GmgnHolder => ({ address: `0x${amount.toString(16).padStart(40, "0")}`, amount, addrType });
const page = (rows: GmgnHolder[], more: boolean | null = true): GmgnHoldersPage => ({ rows, more });

// 100 行 gmgn：第 1 名是 pool（应被下一个真钱包顶替，且不占 50 个名额），第 30 名燃烧地址（addr_type 1，保留）
const wallets = Array.from({ length: 99 }, (_, i) => row(1000 - i, i === 28 ? 1 : 0));
const gmgn100 = [row(50_000, 2), ...wallets];

{
  // 基线：pool 在第 1 名被顶替；分母 = 第 2..51 名（50 个非 pool，含燃烧行）；pools=1
  const r = frontRank(WANT, fomoEnv(Array.from({ length: 50 }, () => 10)), page(gmgn100), AT);
  const want = wallets.slice(0, 50).reduce((s, w) => s + w.amount, 0);
  assert.equal(r.why, null);
  assert.deepEqual(r.gmgn, { amount: want, n: 50, pools: 1 });
  assert.deepEqual(r.fomo, { amount: 500, n: 50 });
  assert.equal(r.ratio, 500 / want);
  assert.ok(want < 50_000, "pool 的量不能进分母");
}
{
  // 分子只算前 50：第 51 行一个巨量不进
  const r = frontRank(WANT, fomoEnv([...Array.from({ length: 50 }, () => 10), 1e12]), page(gmgn100), AT);
  assert.deepEqual(r.fomo, { amount: 500, n: 50 });
}
{
  // 满页但非 pool 不足 50（51 个 pool）→ 不可用，不给部分值
  const r = frontRank(WANT, fomoEnv([10]), page([...Array.from({ length: 51 }, (_, i) => row(9000 - i, 2)), ...wallets.slice(0, 49)]), AT);
  assert.equal(r.ratio, null);
  assert.ok(r.why, "unavailable must carry a reason");
  assert.equal(r.gmgn, null, "no partial gmgn counts");
  assert.equal(r.fomo, null);
}
{
  // 短页 + 服务端明确没有更多 → 列表取尽，按实际 n 算
  const r = frontRank(WANT, fomoEnv([10, 20]), page([row(100), row(60, 2), row(40)], false), AT);
  assert.deepEqual(r.gmgn, { amount: 140, n: 2, pools: 1 });
  assert.equal(r.ratio, 30 / 140);
}
{
  // 短页 + 还有更多（next 非空）→ 不可用；短页 + 续页信息缺失（more 未知）→ 不可用
  assert.equal(frontRank(WANT, fomoEnv([10]), page([row(100), row(40)], true), AT).ratio, null);
  const unknown = frontRank(WANT, fomoEnv([10]), page([row(100), row(40)], null), AT);
  assert.equal(unknown.ratio, null);
  assert.equal(unknown.gmgn, null, "unknown continuation must not yield a partial n");
}
{
  // 分母 0（取尽且都是 0 余额）→ 不可用；fomo 列表真为空 → 0
  const zero = frontRank(WANT, fomoEnv([10]), page([row(0)], false), AT);
  assert.equal(zero.ratio, null);
  assert.ok(zero.why);
  const empty = frontRank(WANT, fomoEnv([]), page(gmgn100), AT);
  assert.equal(empty.ratio, 0);
  assert.deepEqual(empty.fomo, { amount: 0, n: 0 });
}
{
  // 缺数据不变 0：fomo 某行 humanAmount 为 null / "" / true；fomo 没拿到；gmgn 抛错 → 全部不可用且两侧字段为 null（不拼一半）
  for (const bad of [null, "", true, "abc"]) {
    const r = frontRank(WANT, fomoEnv([10, bad, 30]), page(gmgn100), AT);
    assert.equal(r.ratio, null, `humanAmount=${String(bad)} 不能算 0`);
    assert.equal(r.fomo, null);
  }
  const missing = frontRank(WANT, null, page(gmgn100), AT);
  assert.equal(missing.ratio, null);
  assert.equal(missing.gmgn, null, "fomo failure must not publish the gmgn half");
  const g = frontRank(WANT, fomoEnv([10]), new Error("http 403"), AT);
  assert.equal(g.ratio, null);
  assert.ok(g.why);
  assert.equal(g.gmgn, null);
  assert.equal(g.fomo, null, "gmgn failure must not publish the fomo half");
}
{
  // 响应串位：别的币 / 别的链 → 不可用；数字字串 humanAmount 合法
  assert.equal(frontRank(WANT, fomoEnv([10], { tokenAddress: "0x0000000000000000000000000000000000000001" }), page(gmgn100), AT).ratio, null);
  assert.equal(frontRank(WANT, fomoEnv([10], { networkId: 56 }), page(gmgn100), AT).ratio, null);
  assert.equal(frontRank(WANT, fomoEnv(["12.5"]), page(gmgn100), AT).fomo?.amount, 12.5);
}
{
  // 生产解析器 topHolders：任一行缺 addr_type / balance 为 null → 整体拒绝（不当普通钱包、不当 0）；正常页解析 + more 三态
  const body = (list: unknown[], next: unknown) => JSON.stringify({ code: 0, message: "success", data: { list, next } });
  const bridge = (b: string) => ({ gmgnFetch: async () => ({ status: 200, body: b }) });
  const good = { address: "0xaa", balance: 5, addr_type: 0 };
  await assert.rejects(topHolders(bridge(body([good, { address: "0xbb", balance: 7 }], null)) as never, "bsc", "0x1"));
  await assert.rejects(topHolders(bridge(body([good, { address: "0xbb", balance: null, addr_type: 0 }], null)) as never, "bsc", "0x1"));
  await assert.rejects(topHolders(bridge(body([good, { address: "0xbb", balance: "", addr_type: 2 }], null)) as never, "bsc", "0x1"));
  const p1 = await topHolders(bridge(body([good, { address: "0xcc", balance: "3.5", addr_type: 2 }], "abc")) as never, "bsc", "0x1");
  assert.deepEqual(p1, { rows: [{ address: "0xaa", amount: 5, addrType: 0 }, { address: "0xcc", amount: 3.5, addrType: 2 }], more: true });
  assert.equal((await topHolders(bridge(body([good], null)) as never, "bsc", "0x1")).more, false);
  assert.equal((await topHolders(bridge(JSON.stringify({ code: 0, data: { list: [good] } })) as never, "bsc", "0x1")).more, null);
}

console.log("fomo-front-rank: ok");
