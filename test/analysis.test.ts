/**
 * 「首喊后 24h 表现复盘」契约（analysis.ts + Store 的截面 / 社交事件表 + Engine 的决策截面钩子）。
 * 守住：结果只看 [起点, 起点+24h]、没满 24h 只列不比；跨行情源换算口径跳变的采样点不进峰值；观测持续翻倍按实时点连续性判、来源未知为 null；
 * 特征两组任一 n<20 不排序、截面缺字段计 missing、过程特征与原因分组；喊单人先验只用 t0 前已完结的首喊；同地址换链隔离；
 * 截面 INSERT OR IGNORE、社交事件 kind 只升不降；Engine 在 live 首喊后 CUT_SEC 秒写截面（回灌不写），GMGN 喊单 / 推文进 social_event。
 * 运行：node --import tsx test/analysis.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { CUT_SEC, ENTRY_FEATURES, HORIZON_SEC, MIN_GROUP, StrategyError, analyze, renderMarkdown, simulate, topSummary, wilson, type AnalysisInput, type AnalysisToken, type CutSnapshot } from "../src/core/analysis.js";
import { parseCallCard, parseCallCardText, parseCardNumber } from "../src/core/callcard.js";
import { compileStrategy, runStrategy, strategyLine } from "../src/core/strategy.js";
import { Dex } from "../src/core/dex.js";
import { Engine } from "../src/core/engine.js";
import { Store } from "../src/core/store.js";
import type { GmgnFetchParams, Market, OutEvent } from "../src/core/types.js";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const NOW = 1_790_000_000;
const GRP = "g@chatroom";

// ---------- analyze()：纯函数 ----------

function tok(n: number, t0: number, o: Partial<AnalysisToken> = {}): AnalysisToken {
  return {
    address: addr(n), chain: "bsc", symbol: `T${n}`, logo: null, t0,
    first: { sender: "kol", grp: GRP, text: `${addr(n)} 冲`, mc: 100_000, price: 0.001, approx: false },
    nowMc: 100_000, nowPrice: 0.001, nowLiq: 20_000, cut: null, card: null, legacy: { hasTwitter: null, joined: null, isTweet: false, tweetAt: null, followers: null }, createdAt: null, openAt: null,
    series: [], calls: [{ id: n, sender: "kol", grp: GRP, ts: t0, text: null }], fomo: [], social: [],
    ...o,
  };
}
/** 每 20s 一点，mc 按 mult(i) 倍基准 */
const pts = (t0: number, n: number, mult: (i: number) => number, src: "live" | "candle" | null = "live", step = 20) =>
  Array.from({ length: n }, (_, i) => ({ ts: t0 + i * step, mc: 100_000 * mult(i), price: 0.001 * mult(i), liq: 20_000 * mult(i), src }));
const cutOf = (o: Partial<CutSnapshot> = {}): CutSnapshot => ({ v: 1, market: { at: 0, mc: 100_000, liq: 30_000, price: 0.001, holders: 120 }, twitter: null, gmgnCalls: null, fomo: null, top: null, ...o });
const run = (tokens: AnalysisToken[], priors: AnalysisInput["priors"] = [], win = 2) => analyze({ now: NOW, sinceT0: NOW - 72 * 3600, tokens, priors }, { win, hours: 72 });

{
  const t0 = NOW - 2 * 86400;
  // 满 24h 的：24h 内峭 3x、24h 后 10x → peakX24 = 3；没满 24h 的只列不比
  const done = tok(1, t0, { series: [...pts(t0, 100, (i) => (i === 50 ? 3 : 1)), { ts: t0 + HORIZON_SEC + 60, mc: 1_000_000, price: 0.01, src: "live" }] });
  const fresh = tok(2, NOW - 3600, { series: pts(NOW - 3600, 30, () => 5) });
  const r = run([done, fresh]);
  const d = r.tokens.find((x) => x.address === done.address)!;
  const f = r.tokens.find((x) => x.address === fresh.address)!;
  assert.equal(d.status, "ok");
  assert.equal(d.peakX24, 3, "peak only counts samples inside [from, from+24h]");
  assert.equal(d.hit, true);
  assert.equal(d.tRise, t0 + 50 * 20, "rise = first sample ≥1.5×");
  assert.equal(f.status, "incomplete");
  assert.equal(f.peakX24, 5, "in-progress token still shows its peak so far");
  assert.equal(f.hit, null);
  assert.equal(r.cohort.eligible, 1);
  assert.equal(r.cohort.excluded.incomplete, 1);
  console.log("ok analyze: horizon window + incomplete tokens excluded from comparison");
}

{
  const t0 = NOW - 2 * 86400;
  // DexScreener → gmgn 换算口径跳变：price 不动 mc ×30 的点剔除；nowX 同样受供应量一致性约束
  const glitch = tok(3, t0, { series: [...pts(t0, 20, () => 1), { ts: t0 + 20 * 20, mc: 3_000_000, price: 0.001, src: "live" }, ...pts(t0 + 21 * 20, 20, () => 1.2)], nowMc: 3_000_000, nowPrice: 0.001 });
  const r = run([glitch]);
  const g = r.tokens[0]!;
  assert.equal(g.dropped, 1);
  assert.equal(g.samples, 40);
  assert.equal(g.peakX24, 1.2);
  assert.equal(g.nowX, null, "current mc with an inconsistent implied supply is not trusted");
  // 错币报价：供应量一致（price 同步跳）、一步 ≥20× 又在 10min 内回落 → 整段剔除；首点相对基准判；跳上去不回来的是真拉升，保留
  const wrong = tok(5, t0, {
    series: [
      { ts: t0, mc: 50_000_000, price: 0.5, src: "live" }, // 进面板后的第一个采样 = 同名大币的价（500×），下一点回到 1× → 剔
      ...pts(t0 + 20, 30, () => 1),
      ...pts(t0 + 31 * 20, 3, () => 800), // 3 个点 800× 又回落 → 剔
      ...pts(t0 + 34 * 20, 30, () => 1.5),
      ...pts(t0 + 64 * 20, 30, () => 40), // 一步 26.7× 且不回落 → 保留
    ],
  });
  const w = run([wrong]).tokens[0]!;
  assert.equal(w.dropped, 4);
  assert.equal(w.samples, 90);
  assert.equal(w.peakX24, 40);
  // 断采样 5h 后再进面板：真价已到 6×，第一个采样却是错币的 5000× → 下一点反向一步跳 ≥20×，剔除（回不到 1× 也认）
  const gap = tok(6, t0, { series: [...pts(t0, 30, () => 1), { ts: t0 + 5 * 3600, mc: 500_000_000, price: 5, src: "live" }, ...pts(t0 + 5 * 3600 + 20, 30, () => 6)] });
  const gp = run([gap]).tokens[0]!;
  assert.deepEqual([gp.dropped, gp.peakX24], [1, 6]);
  // 只有 3 个点 → 采样不足
  const thin = tok(4, t0, { series: pts(t0, 3, () => 40) });
  assert.equal(run([thin]).tokens[0]!.status, "low_coverage");
  console.log("ok analyze: supply-inconsistent samples and wrong-token spikes dropped; thin coverage excluded");
}

{
  const t0 = NOW - 2 * 86400;
  // 持续翻倍：≥2× 的连续实时点串跨度 ≥180s（相邻 ≤60s）；一个 >60s 的洞把串切开
  const solid = tok(5, t0, { series: pts(t0, 30, (i) => (i >= 5 && i < 20 ? 2.5 : 1)) }); // 15 点 × 20s = 280s
  const holey = tok(6, t0, { series: [...pts(t0, 5, () => 1), ...pts(t0 + 100, 4, () => 2.5), ...pts(t0 + 100 + 4 * 20 + 90, 4, () => 2.5), ...pts(t0 + 400, 5, () => 1)] }); // 两段各 60s，洞 90s
  const unknown = tok(7, t0, { series: pts(t0, 30, () => 2.5, null) });
  const candle = tok(8, t0, { series: pts(t0, 30, () => 2.5, "candle") });
  const r = run([solid, holey, unknown, candle]);
  const by = (n: number) => r.tokens.find((x) => x.address === addr(n))!;
  assert.deepEqual(by(5).sustained, { 60: true, 180: true, 300: false });
  assert.deepEqual(by(6).sustained, { 60: true, 180: false, 300: false }, "a >60s gap splits the run");
  assert.equal(by(7).sustained, null, "legacy samples without src → unknown");
  assert.deepEqual(by(8).sustained, { 60: false, 180: false, 300: false }, "candle-seeded points never count as sustained");
  assert.equal(by(8).peakX24, 2.5, "…but they do count for the raw peak");
  console.log("ok analyze: sustained-doubling semantics");
}

{
  const t0 = NOW - 3 * 86400;
  // 25 个有截面持有人<100 的币全达标 + 25 个 ≥500 的全不达标 + 10 个没截面的（missing）
  const tokens: AnalysisToken[] = [];
  for (let i = 0; i < 25; i++) tokens.push(tok(100 + i, t0 + i, { cut: { chain: "bsc", address: addr(100 + i), kind: "cut", t0: t0 + i, scheduledAt: t0 + i + CUT_SEC, observedAt: t0 + i + CUT_SEC, v: 1, json: cutOf({ market: { at: t0, mc: 100_000, liq: 30_000, price: 0.001, holders: 50 } }) }, series: pts(t0 + i + CUT_SEC, 30, () => 3) }));
  for (let i = 0; i < 25; i++) tokens.push(tok(200 + i, t0 + i, { cut: { chain: "bsc", address: addr(200 + i), kind: "cut", t0: t0 + i, scheduledAt: t0 + i + CUT_SEC, observedAt: t0 + i + CUT_SEC, v: 1, json: cutOf({ market: { at: t0, mc: 100_000, liq: 30_000, price: 0.001, holders: 900 } }) }, series: pts(t0 + i + CUT_SEC, 30, () => 1) }));
  for (let i = 0; i < 10; i++) tokens.push(tok(300 + i, t0 + i, { series: pts(t0 + i, 30, () => 1) }));
  const r = run(tokens);
  const f = r.features.find((x) => x.id === "holders_lt_100")!;
  assert.deepEqual([f.with.n, f.with.hit, f.without.n, f.without.hit, f.missing], [25, 25, 25, 0, 10]);
  assert.equal(f.rankable, true);
  assert.equal(f.lift, null, "without-rate 0 → lift undefined");
  const g = r.features.find((x) => x.id === "holders_ge_500")!;
  assert.equal(g.with.rate, 0);
  assert.equal(g.without.rate, 1);
  assert.equal(g.lift, 0);
  assert.equal(r.features[0]!.id, "holders_lt_100", "rankable features sort ahead; undefined lift treated as +∞ ranks first");
  // 有截面的币 liq 可判定；没截面的 liq missing
  const liq = r.features.find((x) => x.id === "liq_10k_50k")!;
  assert.deepEqual([liq.with.n, liq.missing], [50, 10]);
  // 全部 fomo 类特征在无登录截面下 missing = 60
  assert.equal(r.features.find((x) => x.id === "fomo_buyers")!.missing, 60);
  // 结果起点 = 截面时刻：截面前的采样不进峰值
  const early = tok(400, t0, { cut: { chain: "bsc", address: addr(400), kind: "cut", t0, scheduledAt: t0 + CUT_SEC, observedAt: t0 + CUT_SEC, v: 1, json: cutOf() }, series: [{ ts: t0 + 5, mc: 900_000, price: 0.009, src: "live" }, ...pts(t0 + CUT_SEC, 30, () => 1)] });
  assert.equal(run([early]).tokens[0]!.peakX24, 1, "samples before the cut are not part of the outcome");
  assert.equal(r.cohort.withCut, 50);
  assert.equal(r.strata.length, 1, "one chain with ≥40 eligible tokens gets its own table");
  assert.equal(r.strata[0]!.chain, "bsc");
  console.log("ok analyze: feature table counts, missing, rankability, cut-only features, strata");
}

{
  const t0 = NOW - 2 * 86400;
  // 先验：同一 (grp, sender) 20 个已完结首喊（t0'+24h ≤ t0）里 12 个达标 → 60% ≥ 40%；未完结的 / 本币 / 别群同名的不算
  const priors: AnalysisInput["priors"] = [];
  for (let i = 0; i < 20; i++) priors.push({ address: addr(500 + i), grp: GRP, sender: "kol", t0: t0 - 10 * 86400 + i * 3600, peakX24: i < 12 ? 3 : 1 });
  priors.push({ address: addr(600), grp: GRP, sender: "kol", t0: t0 - 3600, peakX24: 1 }); // 还没完结
  priors.push({ address: addr(9), grp: GRP, sender: "kol", t0, peakX24: 9 }); // 本币
  for (let i = 0; i < 30; i++) priors.push({ address: addr(700 + i), grp: "other@chatroom", sender: "kol", t0: t0 - 10 * 86400 + i, peakX24: 1 }); // 别群同名
  const t = tok(9, t0, { series: pts(t0, 30, () => 1) });
  const r = run([t], priors);
  assert.ok(r.tokens[0]!.features.includes("prior_ge_40"));
  assert.ok(!r.tokens[0]!.features.includes("prior_lt_20"));
  // 少一个就不够 n≥20 → 不可判定
  const r2 = run([t], priors.slice(1));
  assert.equal(r2.features.find((x) => x.id === "prior_ge_40")!.missing, 1);
  console.log("ok analyze: first-caller prior uses only completed earlier calls under the same (group, sender)");
}

{
  const t0 = NOW - 2 * 86400;
  // 截面链 ≠ 当前链 → 隔离；时间线：t0 那条喊单算「之前」，之后的 fomo 买是「过程」；起点前 60min 事件数
  const conflict = tok(10, t0, { chain: "base", cut: { chain: "bsc", address: addr(10), kind: "cut", t0, scheduledAt: t0 + CUT_SEC, observedAt: t0 + CUT_SEC, v: 1, json: cutOf() }, series: pts(t0 + CUT_SEC, 30, () => 5) });
  const timeline = tok(11, t0, {
    series: pts(t0, 200, (i) => (i >= 100 ? 2 : 1)),
    fomo: [{ handle: "whale", kind: "buy", usd: 500, ts: t0 - 600, comment: null }, { handle: "late", kind: "buy", usd: 100, ts: t0 + 3000, comment: null }],
    social: [{ chain: "bsc", address: addr(11), ref: "gm:1", kind: "gmgn_call", ts: t0 + 1500, observedAt: t0 + 1600, actor: "kolx", followers: 5000, kol: true, text: "send it" }],
  });
  const r = run([conflict, timeline]);
  const c = r.tokens.find((x) => x.address === addr(10))!;
  assert.equal(c.status, "chain_conflict");
  assert.equal(c.peakX24, null);
  assert.equal(r.cohort.excluded.chain_conflict, 1);
  const t = r.tokens.find((x) => x.address === addr(11))!;
  assert.equal(t.tRise, t0 + 2000);
  assert.deepEqual(t.events.map((e) => [e.kind, e.phase]), [["fomo_buy", "before"], ["group_call", "before"], ["gmgn_call", "after"], ["fomo_buy", "after"]]);
  assert.deepEqual(t.leading![3600]!, { group_call: 1, official_tweet: 0, community_tweet: 0, gmgn_call: 1, fomo_buy: 1, fomo_sell: 0, fomo_thesis: 0 }, "60min before the rise: the call, the KOL gmgn call, the early fomo buy");
  assert.equal(t.leading![900]!.fomo_buy, 0, "the fomo buy 43min before the rise is outside the 15min window");
  assert.ok(t.features.includes("p_gm_60m"));
  assert.ok(t.features.includes("p_fomo_buy_60m"), "fomo buy at +50min after t0 is a process feature");
  console.log("ok analyze: chain conflict isolation, timeline phases, leading-window counts");
}

// ---------- 模拟交易：策略 = JS（compileStrategy → vm）；同一批币、同一条剔除口径的价格路径 ----------

/** 编译并跑：代码里可以直接用 s / t */
const strat = (code: string) => compileStrategy(code).strategy;
const ENV = { fee: 0.01, stake: 100 };
const runOn = (tokens: AnalysisToken[], code: string, tz?: string) => {
  const input: AnalysisInput = { now: NOW, sinceT0: NOW - 72 * 3600, tokens, priors: [] };
  return simulate(input, analyze(input, { win: 2, hours: 72 }), strat(code), ENV, tz);
};
/** 「2× 清仓 / 0.5 止损 / 6h 到期」——旧版规则开关的等价写法；顺序 = 止损 → 止盈 → 到期 */
const BASIC = `({ step(s) {
  if (s.x <= 0.5) return s.sellAll("止损");
  if (s.x >= 2) return s.sellAll("止盈");
  if (s.held >= 6 * 3600) return s.sellAll("到期");
} })`;

{
  // 入场 = 起点后 ≥20s 的第一个采样（不是基准）；tag 成为退出原因；到期按 held；尾仓 → open / now 按现价估值；费用两边扣
  const t0 = NOW - 2 * 86400;
  // pts 每 20s 一点：第 0 点在起点（首个 DexScreener 报价，不可成交），第 1 点 = 入场价
  // A：入场后第 30 点冲到 2.5× → 止盈（按观测价 2.5 成交，不是门槛 2）
  const A = tok(20, t0, { series: pts(t0, 200, (i) => (i >= 30 ? 2.5 : 1)) });
  // B：入场后跌到 0.4× → 止损；之后再涨 10× 也不算
  const B = tok(21, t0, { series: pts(t0, 200, (i) => (i < 10 ? 1 : i < 20 ? 0.4 : 10)) });
  // C：横盘，held 到 6h 那个采样卖出
  const C = tok(22, t0, { series: pts(t0, 1200, () => 1.3) });
  // D：只采了 5 个点就断了 → low_coverage，不进模拟
  const D = tok(23, t0, { series: pts(t0, 5, () => 0.8) });
  // E：首喊 1h 前、还在采样、没触发 → open，按现价估值
  const E = tok(24, NOW - 3600, { series: pts(NOW - 3600, 180, () => 1.5), nowMc: 150_000, nowPrice: 0.0015 }); // 采样一直到 NOW-20
  // F：口径跳变点（price 不动 mc ×30）不能触发止盈
  const F = tok(25, t0, { series: [...pts(t0, 20, () => 1), { ts: t0 + 400, mc: 3_000_000, price: 0.001, src: "live" }, ...pts(t0 + 420, 1100, () => 1)] });
  // H：起点那一刻 Dex 报 $3.2K、1s 后 gmgn $53K（真库 NINA）：不能按 $3.2K 成交；20 分钟后采样断了，现价口径不一致 → 按最后采样、标 gap
  const H = tok(27, t0, { first: { sender: "kol", grp: GRP, text: null, mc: 3209, price: 3.208e-6, approx: false }, series: [{ ts: t0 + 3, mc: 3209, price: 3.208e-6, src: "live" }, { ts: t0 + 4, mc: 53_327, price: 5.33e-5, src: "live" }, ...pts(t0 + 20, 60, () => 0.55).map((p) => ({ ...p, mc: 55_000, price: 5.5e-5 }))] });
  const all = [A, B, C, D, E, F, H];
  const r = runOn(all, BASIC);
  const by = (n: number) => r.trades.find((x) => x.address === addr(n))!;
  assert.equal(r.n, 6, "D is low_coverage → skipped; the other six trade");
  assert.equal(r.skipped.low_coverage, 1);
  assert.equal(by(20).entryAt, t0 + 20, "entry = first sample ≥ 20s after the start");
  assert.deepEqual([by(20).reason, by(20).lastX, by(20).holdSec, by(20).stake], ["止盈", 2.5, 580, 100]);
  assert.ok(Math.abs(by(20).pnl - 100 * (0.99 * 0.99 * 2.5 - 1)) < 1e-9, "fee taken on both legs");
  assert.deepEqual([by(20).remaining, by(20).unrealized, by(20).fills.map((f) => f.tag)], [0, 0, ["止盈"]]);
  assert.deepEqual([by(21).reason, by(21).lastX], ["止损", 0.4]);
  assert.deepEqual([by(22).reason, by(22).exitAt - by(22).entryAt, by(22).lastX], ["到期", 6 * 3600, 1]);
  assert.deepEqual([by(24).reason, by(24).lastX, by(24).remaining, by(24).gap], ["open", 1, 1, false]);
  assert.ok(Math.abs(by(24).unrealized - 100 * 0.99 * 0.99) < 1e-9, "open position marked at now net of the sell fee");
  assert.deepEqual([by(25).reason, by(25).lastX], ["到期", 1], "supply-glitch point never fills a take-profit");
  assert.equal(by(27).entryMc, 55_000, "stale first quote is not a fill; entry at the ≥20s sample");
  assert.deepEqual([by(27).reason, by(27).markedAtLast, by(27).gap], ["now", true, true]);
  assert.ok(Math.abs(by(27).lastX - 1) < 1e-9, "…so the 16× jump before entry is not profit; tail marked at the last sample");
  assert.deepEqual(Object.fromEntries(Object.entries(r.byReason).map(([k, v]) => [k, v.n])), { 止盈: 1, 止损: 1, 到期: 2, open: 1, now: 1 });
  assert.equal(r.curve.length, 6);
  assert.ok(Math.abs(r.curve[r.curve.length - 1]!.cum - r.pnl) < 1e-9);
  assert.equal(r.best!.address, addr(20));
  assert.equal(r.worst!.address, addr(21));
  // 采样早早断了、窗口已满 → now + gap，按现价（口径一致时）
  const D2 = tok(23, t0, { series: pts(t0, 12, () => 0.8) });
  const d2 = runOn([D2], BASIC).trades[0]!;
  assert.deepEqual([d2.reason, d2.gap, d2.markedAtLast, d2.lastX], ["now", true, false, 1.25]);
  // 「拿满 24h 再卖」：窗末是定死的，windowLeft 在最后一个窗内采样处 ≤ 20
  const C24 = tok(22, t0, { series: pts(t0, 4320, () => 1.2) });
  const c24 = runOn([C24], `({ step(s) { if (s.windowLeft <= 60) s.sellAll("满 24h"); } })`).trades[0]!;
  assert.deepEqual([c24.reason, c24.exitAt], ["满 24h", t0 + HORIZON_SEC - 60], "sells at the first sample with ≤60s left in the window");
  // 起点后 20s 内就断了 → 无法入场；很晚才有采样 → 等到那一个
  const D3 = tok(23, t0, { series: [{ ts: t0 + 2, mc: 80_000, price: 0.0008, src: "live" }, ...pts(t0 + 40_000, 30, () => 1)] });
  assert.equal(runOn([D3], BASIC).trades[0]!.entryAt, t0 + 40_000, "entry waits for the first sample ≥ 20s, however late");
  const D4 = tok(23, t0, { series: pts(t0, 12, () => 0.8, "live", 1) }); // 12 点全在前 12s
  const r4 = runOn([D4], BASIC);
  assert.deepEqual([r4.n, r4.skipped.no_entry], [0, 1]);
  // 回撤止盈：涨到 3× 后回落 30% → 在 ≤70% 峰值的第一个采样成交；peakX / dd 相对入场
  const G = tok(26, t0, { series: pts(t0, 200, (i) => (i < 50 ? 1 + i * 0.04 : 3 - (i - 50) * 0.05)) });
  const g = runOn([G], `({ step(s) { if (s.x <= s.peakX * 0.7 + 1e-9) s.sellAll("回撤"); } })`).trades[0]!;
  assert.equal(g.reason, "回撤");
  assert.ok(Math.abs(g.entryMc - 104_000) < 1e-6, "entry at the i=1 sample (1.04×)");
  assert.ok(Math.abs(g.lastX - 2.1 / 1.04) < 1e-9, `trail fills at the 2.1 sample (≤ 70% of the 3.0 peak), relative to entry (got ${g.lastX})`);
  assert.ok(Math.abs(g.peakX - 3 / 1.04) < 1e-9, "peak relative to entry");
  // entry：按截面特征挑币；过程特征不在 t.features 里（防泄漏）；返回数字 = 这单投入；不返回 = 默认
  const pick = (cond: string) => runOn(all, `({ entry(t) { if (!(${cond})) return 0; }, step(s) { if (s.x >= 2) s.sellAll("tp"); } })`);
  assert.deepEqual([pick(`t.features.has("mc_50k_200k")`).n, pick(`t.features.has("mc_50k_200k")`).declined], [5, 1], "H's analysis base is $3.2K → not in the 50k–200k bucket");
  assert.equal(pick(`t.features.has("mc_50k_200k") && t.features.has("tw_verified")`).n, 0);
  assert.equal(pick(`t.features.has("p_senders_30m")`).n, 0, "process features are not visible at entry");
  assert.ok(ENTRY_FEATURES.every((f) => f.group !== "process") && ENTRY_FEATURES.some((f) => f.id === "mc_50k_200k"));
  const sized = runOn([A, B], `({ entry(t) { return t.symbol === "T20" ? 250 : true; }, step(s) { if (s.x >= 2 || s.x <= 0.5) s.sellAll("x"); } })`);
  assert.deepEqual(sized.trades.map((t) => t.stake).sort(), [100, 250]);
  assert.equal(sized.invested, 350);
  assert.ok(Math.abs(sized.trades.find((t) => t.address === addr(20))!.pnl - 250 * (0.99 * 0.99 * 2.5 - 1)) < 1e-9, "pnl scales with the per-trade stake");
  console.log("ok simulate: delayed entry fill, tags as reasons, held / windowLeft exits, open / now / gap, fees, entry filter + sizing, no process-feature leak");
}

{
  // 分批 + 尾仓：2× 出本（卖 50%）、剩下 50% 按现价估值；已实现 / 未实现拆分；费用每腿各扣；s.state / s.sold / s.events 的语义
  const t0 = NOW - 2 * 86400;
  const MOON = `({ step(s) {
    if (!s.sold(2)) {
      if (s.x <= 0.5) return s.sellAll("止损");
      if (s.x >= 2) return s.sell(0.5, "出本");
    } else if (s.x <= 0.5) return s.sellAll("尾仓止损");
  } })`;
  const M = tok(28, t0, { series: pts(t0, 300, (i) => (i >= 30 ? 2 : 1)), nowMc: 500_000, nowPrice: 0.005 }); // 现价 5×（隐含供应量一致）
  const rm = runOn([M], MOON);
  const m = rm.trades[0]!;
  assert.equal(m.reason, "now");
  assert.deepEqual(m.fills.map((f) => [f.x, f.pct, f.ts - m.entryAt, f.tag]), [[2, 0.5, 580, "出本"]]);
  assert.equal(m.remaining, 0.5);
  assert.equal(m.exitAt, NOW, "moonbag valued now");
  assert.equal(m.lastX, 5);
  const units = (100 * 0.99) / 100_000;
  assert.ok(Math.abs(m.realized - 0.5 * units * 200_000 * 0.99) < 1e-9, "50% sold at 2× net of sell fee");
  assert.ok(Math.abs(m.unrealized - 0.5 * units * 500_000 * 0.99) < 1e-9, "50% held, marked at now × (1 − fee)");
  assert.ok(Math.abs(m.pnl - (m.realized + m.unrealized - 100)) < 1e-9);
  assert.ok(Math.abs(rm.realized - (m.realized - 50)) < 1e-9 && Math.abs(rm.unrealized - (m.unrealized - 50)) < 1e-9, "result splits pnl by the cost basis of the sold / held halves");
  assert.ok(Math.abs(rm.realized + rm.unrealized - rm.pnl) < 1e-9);
  // 现价不可用（口径不一致）→ 按最后采样估值并标注
  const rm2 = runOn([{ ...M, nowMc: 5_000_000, nowPrice: 0.005 }], MOON);
  assert.deepEqual([rm2.trades[0]!.reason, rm2.trades[0]!.markedAtLast, rm2.trades[0]!.lastX], ["now", true, 2]);
  // 出本后尾仓止损：2× 卖 50% 后跌到 0.4× → 第二腿把尾仓卖掉；reason = 最后一腿的 tag
  const M3 = tok(29, t0, { series: pts(t0, 300, (i) => (i < 30 ? 1 : i < 60 ? 2 : 0.4)) });
  const m3 = runOn([M3], MOON).trades[0]!;
  assert.deepEqual([m3.reason, m3.remaining, m3.fills.map((f) => f.tag)], ["尾仓止损", 0, ["出本", "尾仓止损"]]);
  assert.ok(Math.abs(m3.realized - (0.5 * units * 200_000 + 0.5 * units * 40_000) * 0.99) < 1e-9);
  // 阶梯用 s.state 记腿：一根 K 跳过两档 → 两腿同一采样成交，卖满后 step 不再被调（第三腿没机会）；sell 超出剩余按剩余
  const LADDER = `const LEGS = [[1.5, 0.5], [2, 0.5], [3, 0.5]];
  ({ step(s) {
    s.state.i ??= 0;
    while (s.state.i < LEGS.length && s.x >= LEGS[s.state.i][0]) { const [x, pct] = LEGS[s.state.i++]; s.sell(pct, x + "×"); }
    s.state.calls = (s.state.calls ?? 0) + 1;
  } })`;
  const l = runOn([M], LADDER).trades[0]!;
  assert.deepEqual([l.reason, l.remaining, l.fills.map((f) => [f.pct, f.tag])], ["2×", 0, [[0.5, "1.5×"], [0.5, "2×"]]]);
  // 事件按时间推进：别的群 t0+300 喊 → 在 ts ≥ t0+300 的第一个采样才看得到；首喊本身在 calls 里
  const M4 = tok(30, t0, { series: pts(t0, 300, () => 1.2), calls: [{ id: 1, sender: "kol", grp: GRP, ts: t0, text: null }, { id: 2, sender: "b", grp: "other@chatroom", ts: t0 + 300, text: null }] });
  const ev = runOn([M4], `({ step(s) {
    if (s.events.calls.length < 1) throw new Error("first call must be visible from the first step");
    if (s.events.calls.some((c) => c.ts > s.ts)) throw new Error("future event leaked");
    if (s.events.calls.some((c) => c.grp !== s.token.firstGroup)) s.sellAll("第二个群");
  } })`).trades[0]!;
  assert.deepEqual([ev.reason, ev.exitAt - t0], ["第二个群", 300]);
  console.log("ok simulate: scale-out via tags, moonbag marked at now (or last sample), realized/unrealized split, state ladder, events advance with time");
}

{
  // watch 模式：entry 返回 "watch"，step 里看走势再 s.buy()；买前 x 相对首喊价、买后相对买入价；没买 = watched；同一 step 给基准（立刻买）时 buy 是 no-op
  const t0 = NOW - 2 * 86400;
  // W1：先跌到 0.8（i 10–20），第 45 点（900s）回到 1.1，之后第 60 点起 3×
  const W1 = tok(70, t0, { series: pts(t0, 300, (i) => (i < 10 ? 1 : i < 20 ? 0.8 : i < 60 ? 1.1 : 3)) });
  // W2：一路跌到 0.4，永远不满足买入条件
  const W2 = tok(71, t0, { series: pts(t0, 300, (i) => (i < 5 ? 1 : 0.4)) });
  const WATCH = `({
    entry(t) { return "watch"; },
    step(s) {
      if (!s.holding) {
        if (s.sinceCall < 900) return;                       // 先看 15 分钟
        if (s.callX >= 0.95 && s.callX <= 1.5 && s.callMinX >= 0.7) { s.buy(150, "15m 稳"); return; }
        return;                                                // 不满足就继续看（到窗末算 watched）
      }
      if (s.x >= 2.5) return s.sellAll("止盈");
      if (s.windowLeft <= 60) return s.sellAll("到期");
    },
  })`;
  const rw = runOn([W1, W2], WATCH);
  assert.deepEqual([rw.n, rw.watched, rw.declined], [1, 1, 0], "W1 bought, W2 never qualified");
  const w1 = rw.trades[0]!;
  assert.equal(w1.entryAt, t0 + 20 + 900, "buys at the first sample ≥15min after the call price sample");
  assert.ok(Math.abs(w1.entryMc - 110_000) < 1e-6 && Math.abs(w1.entryX - 1.1) < 1e-9 && w1.waitSec === 900 && w1.callMc === 100_000);
  assert.equal(w1.stake, 150);
  assert.deepEqual([w1.reason, w1.lastX], ["止盈", 3 / 1.1], "x is relative to the buy price, not the call price");
  assert.ok(Math.abs(w1.pnl - 150 * (0.99 * 0.99 * (3 / 1.1) - 1)) < 1e-9);
  // 基准（同一个 step、entry 去掉 → 立刻买）：buy() 在已持仓时是 no-op，不会重复开仓
  const base = runOn([W1], `({ step(s) { if (!s.holding) return; if (s.sinceCall >= 900 && s.callX >= 0.95) s.buy(999, "again"); if (s.x >= 2.5) return s.sellAll("止盈"); } })`);
  assert.deepEqual([base.trades[0]!.stake, base.trades[0]!.entryX, base.trades[0]!.waitSec], [100, 1, 0]);
  // 买入前 dd / peakX 相对首喊；买入那一刻重置
  const probe = compileStrategy(`({ entry() { return "watch"; }, step(s) { if (s.sinceCall === 300) console.log("pre", s.x, s.peakX, s.dd.toFixed(2), s.held, s.remaining); if (s.sinceCall === 900 && !s.holding) { s.buy(); console.log("buy", s.x, s.peakX, s.dd, s.held, s.remaining); } if (s.sinceCall === 1200) console.log("post", s.x.toFixed(3), s.held); } })`);
  const inp: AnalysisInput = { now: NOW, sinceT0: NOW - 72 * 3600, tokens: [W1], priors: [] };
  simulate(inp, analyze(inp, { win: 2, hours: 72 }), probe.strategy, ENV);
  assert.deepEqual(probe.logs, ["pre 0.8 1 0.20 300 0", "buy 1 1 0 0 1", `post ${(3 / 1.1).toFixed(3)} 300`], "i=16 → 0.8 with peak 1.0; buy at i=46 (1.1); at i=61 (3.0) x = 3/1.1 and held = 300s");
  console.log("ok simulate: watch-then-buy — call-relative view before buy, buy-relative after, watched count, buy no-op when holding");
}


{
  // 机器人卡片解析：价格 0.{4} 记法、K/M 单位、热议「首call / 16个群」与「3个群 / 16个群」、侦测后倍数单独一行；不是卡片 → null；只认喊单后 ≤120s 的第一张
  assert.deepEqual([parseCardNumber("0.{4}812"), parseCardNumber("81.2 K"), parseCardNumber("1.1 M"), parseCardNumber("350"), parseCardNumber("abc")], [0.0000812, 81_200, 1_100_000, 350, null]);
  const first = parseCallCardText("[链接] 🟡健身教练\n💵战力：0.{5}478\n💰血量：4.8 K\n👤团员：7\n📈伤害：4.6 K\n⚙副本：Bsc\n📅创建：1970/1/1 8:00\n💬热议：首call / 16个群", 1000)!;
  assert.deepEqual([first.mc, first.holders, first.volume, first.chain, first.groups, first.groupsTotal, first.firstCall, first.sinceX], [4_800, 7, 4_600, "bsc", 0, 16, true, null]);
  const late = parseCallCardText("delusional (bull)\n💵战力：0.000291\n💰血量：291.3 K\n👤团员：504\n📈伤害：1.1 M\n⚙副本：robinhood\n📅创建：1970/1/1 8:00\n🔦侦测：9/4 1:21\n🕵哨兵：Franky | 3.6X\n💬热议：3个群 / 16个群", 2000)!;
  assert.deepEqual([late.price, late.mc, late.holders, late.groups, late.firstCall, late.sinceX], [0.000291, 291_300, 504, 3, false, 3.6]);
  assert.equal(parseCallCardText("X\n💰血量：3.2 M\n🔦侦测：8/31 4:16\n🕵哨兵：ㅤ | -28%\n💬热议：7个群 / 16个群", 1)!.sinceX, 0.72, "percent form = 1 + pct");
  assert.equal(parseCallCardText("X\n💰血量：3.2 M\n🕵哨兵：老版\n2.5X\n💬热议：首call / 16个群", 1)!.sinceX, 2.5, "legacy standalone line");
  assert.equal(parseCallCardText("这是啥", 1), null);
  const lines = [{ time: 90, text: "💰血量：1 K\n💬热议：首call / 16个群" }, { time: 105, text: "0x… 冲" }, { time: 108, text: "💰血量：2 K\n👤团员：9\n💬热议：2个群 / 16个群" }, { time: 300, text: "💰血量：3 K\n💬热议：5个群 / 16个群" }];
  assert.deepEqual([parseCallCard(lines, 100)?.mc, parseCallCard(lines, 100)?.groups, parseCallCard(lines, 500)], [2_000, 2, null], "first card after the call within 120s; earlier / later cards ignored");
  console.log("ok callcard: number notation, heat line, sentinel multiple, window");
}

{
  // 策略拿到的「喊单那一刻可知」的富信息：卡片、先验、流动性、首喊文本、官推事实、到目前为止的群数 / 人数；step 里的 liq 随采样走
  const t0 = NOW - 2 * 86400;
  const card = parseCallCardText("💰血量：90 K\n👤团员：120\n📈伤害：300 K\n💬热议：首call / 16个群", t0 + 5);
  const K = tok(50, t0, {
    series: pts(t0, 300, (i) => (i >= 40 ? 2 : 1)).map((p, i) => ({ ...p, liq: i >= 60 ? 2_000 : 30_000 })), // 第 60 点流动性从 30k 掉到 2k（撤池）
    card, legacy: { hasTwitter: true, joined: t0 - 86400 * 400, isTweet: false, tweetAt: null, followers: null },
    calls: [{ id: 1, sender: "kol", grp: GRP, ts: t0, text: "冲" }, { id: 2, sender: "b", grp: "g2@chatroom", ts: t0 + 200, text: null }, { id: 3, sender: "c", grp: "g2@chatroom", ts: t0 + 400, text: null }],
  });
  // 先验：同一 (grp, sender) 之前 3 个已完结首喊，2 个 ≥2×
  const priors = [1, 2, 3].map((i) => ({ address: addr(60 + i), grp: GRP, sender: "kol", t0: t0 - i * 2 * 86400, peakX24: i === 3 ? 1.2 : 3 }));
  const input: AnalysisInput = { now: NOW, sinceT0: NOW - 72 * 3600, tokens: [K], priors };
  const seen: Record<string, unknown> = {};
  const code = `({
    entry(t) {
      if (!t.card || !t.card.firstCall || t.card.holders > 200) return 0;
      if (!t.prior || t.prior.rate < 0.5) return 0;
      console.log(JSON.stringify({ liq: t.liq, prior: t.prior, text: t.text, tw: t.twitter, groups: t.card.groups, has: t.features.has("cc_first_call") }));
      return 150;
    },
    step(s) {
      if (s.held === 20) console.log("g0", s.groups, s.callers);
      if (s.held === 400) console.log("g1", s.groups, s.callers);
      if (s.liq !== null && s.liq < s.token.liq * 0.2) return s.sellAll("撤池");
    },
  })`;
  const c = compileStrategy(code);
  const r = simulate(input, analyze(input, { win: 2, hours: 72 }), c.strategy, ENV);
  assert.equal(r.n, 1);
  assert.deepEqual([r.trades[0]!.stake, r.trades[0]!.reason, r.trades[0]!.exitAt - t0], [150, "撤池", 60 * 20], "liq collapse at sample 60 triggers the exit");
  assert.deepEqual(JSON.parse(c.logs[0]!), { liq: 30_000, prior: { n: 3, hit: 2, rate: 2 / 3 }, text: `${addr(50)} 冲`, tw: { has: true, joined: t0 - 86400 * 400, isTweet: false, tweetAgeSec: null, followers: null }, groups: 0, has: true });
  assert.deepEqual(c.logs.slice(1, 3), ["g0 1 1", "g1 2 3"], "groups / callers count the first call, then grow as other groups call");
  // 没先验 / 没卡片的币：字段为 null，策略要自己判
  const bare = runOn([tok(51, t0, { series: pts(t0, 100, () => 1) })], `({ entry(t) { console.log(t.card, t.prior, t.liq); }, step() {} })`);
  assert.equal(bare.n, 1);
  console.log("ok strategy inputs: card / prior / liq / text / twitter / groups / callers, liq-drop exit");
}
{
  // 研究结论落地（2026-09-15）：t0 可知的代币年龄 / 迁出时刻 / 推特链接是不是一条推文——从 AnalysisToken 推导，不知道就 null；s.token 是 entry 收到的同一对象
  const t0 = NOW - 2 * 86400;
  const N = tok(70, t0, {
    series: pts(t0, 100, () => 1),
    createdAt: t0 - 2 * 3600, openAt: t0 + 600, // 创建 2h、首喊时还在内盘（10 分钟后才迁出）
    legacy: { hasTwitter: true, joined: t0 - 86400 * 800, isTweet: true, tweetAt: t0 - 900, followers: 1234 },
  });
  const O = tok(71, t0, { series: pts(t0, 100, () => 1) }); // 全 null
  const seen: Record<string, unknown>[] = [];
  const code = `let seen = null;
  ({
    entry(t) { seen = t; console.log(JSON.stringify({ age: t.ageSec, open: t.openSec, tw: t.twitter })); },
    step(s) { if (s.held === 20) { const t = s.token; console.log(t === seen && Object.isFrozen(t), t.ageSec, t.twitter.isTweet); if (t.ageSec !== null && t.ageSec < 3 * 3600 && t.twitter.isTweet) s.sellAll("S4c"); } },
  })`;
  const c = compileStrategy(code);
  const input: AnalysisInput = { now: NOW, sinceT0: NOW - 72 * 3600, tokens: [N, O], priors: [] };
  const r = simulate(input, analyze(input, { win: 2, hours: 72 }), c.strategy, ENV);
  seen.push(...c.logs.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>));
  assert.deepEqual(seen, [
    { age: 2 * 3600, open: -600, tw: { has: true, joined: t0 - 86400 * 800, isTweet: true, tweetAgeSec: 900, followers: 1234 } },
    { age: null, open: null, tw: { has: null, joined: null, isTweet: false, tweetAgeSec: null, followers: null } },
  ], "ageSec / openSec / tweetAgeSec are t0-relative; unknown → null; negative openSec = still in the launchpad at t0");
  assert.deepEqual(c.logs.filter((l) => !l.startsWith("{")), ["true 7200 true", "true null false"], "s.token is the frozen object entry() saw, with the same t0 fields");
  assert.deepEqual(r.trades.map((x) => [x.symbol, x.reason]), [["T70", "S4c"], ["T71", "now"]]);
  console.log("ok strategy inputs: ageSec / openSec / twitter.isTweet / tweetAgeSec / followers via s.token");
}
{
  // SimTrade.path：只有盈利交易带；首点 [0, 1]，每个采样一点，抽稀到 ≤150 且保留最后一点（末点倍数 = 最后采样倍数）
  const t0 = NOW - 2 * 86400;
  const W = tok(72, t0, { series: pts(t0, 1000, (i) => 1 + i * 0.001), nowMc: 300_000, nowPrice: 0.003 }); // 慢涨到 ~2×（不触发 2.4× 止盈），1000 点后采样断、尾仓按现价 3× → now，盈利
  const L = tok(73, t0, { series: pts(t0, 100, (i) => (i < 10 ? 1 : 0.4)) }); // 亏
  const S = tok(74, t0, { series: pts(t0, 200, (i) => (i >= 30 ? 2.5 : 1)) }); // 第 30 点止盈：路径 30 个点，不抽稀
  const r = runOn([W, L, S], `({ step(s) { if (s.x >= 2.4 || s.x <= 0.5) s.sellAll("x"); } })`);
  const by = (n: number) => r.trades.find((x) => x.address === addr(n))!;
  assert.ok(by(72).pnl > 0 && by(73).pnl < 0 && by(74).pnl > 0);
  assert.deepEqual(by(73).path, [], "losing trades carry no path");
  const w = by(72).path;
  assert.equal(w.length, 150, "1 + 998 raw points (entry at sample 1, then samples 2…999) thinned to the cap");
  assert.deepEqual(w[0], [0, 1]);
  assert.ok(w.every((p, i) => i === 0 || p[0] > w[i - 1]![0]), "time strictly increasing after thinning");
  const wl = w[w.length - 1]!;
  assert.equal(wl[0], 999 * 20 - 20, "last point = the last sample, not the now-mark");
  assert.ok(Math.abs(wl[1] - (1 + 999 * 0.001) / (1 + 0.001)) < 1e-4, "…its multiple is relative to the entry price (4 decimals)");
  const sp = by(74).path;
  assert.equal(sp.length, 30, "entry sample + samples 2…30 (the fill sample included) = 30 points, no thinning");
  assert.deepEqual([sp[0], sp[sp.length - 1]], [[0, 1], [29 * 20, 2.5]]);
  console.log("ok simulate: path only on winners, [0,1] first, thinned to ≤150 with the last point kept");
}
{
  // 编译 / 运行错误的形状：语法错误带行号；step 里抛错带币名 / 时刻 / 行号；Math.random / eval 禁用；只给函数 = step；console.log 捕获
  const t0 = NOW - 2 * 86400;
  const A = tok(20, t0, { series: pts(t0, 200, (i) => (i >= 30 ? 2.5 : 1)) });
  const err = (fn: () => unknown): StrategyError => {
    try { fn(); } catch (e) { if (e instanceof StrategyError) return e; throw e; }
    throw new Error("expected a StrategyError");
  };
  const se = err(() => compileStrategy("({ step(s) {\n if (s.x > ) {}\n } })"));
  assert.deepEqual([se.phase, strategyLine(se.cause), /第 2 行/.test(se.message)], ["compile", 2, true]);
  assert.equal(err(() => compileStrategy("({ entry: 1, step() {} })")).phase, "compile");
  assert.equal(err(() => compileStrategy("42")).phase, "compile", "must end with an object (or a function)");
  const re = err(() => runOn([A], "({ step(s) {\n\n s.nothing.here; } })"));
  assert.deepEqual([re.phase, re.token, re.ts, strategyLine(re.cause)], ["step", "T20", t0 + 40, 3]);
  assert.equal(err(() => runOn([A], "({ entry(t) { return t.cut.market.mc; }, step() {} })")).phase, "entry", "no cut → t.cut is null → TypeError surfaces as an entry error");
  assert.match(err(() => runOn([A], "({ step(s) { Math.random(); } })")).message, /Math\.random/);
  assert.match(err(() => runOn([A], `({ step(s) { eval("1"); } })`)).message, /Code generation/);
  const fnOnly = compileStrategy(`(s) => { console.log("x", s.x, { a: 1 }); if (s.x >= 2) s.sellAll("2×"); }`);
  const input: AnalysisInput = { now: NOW, sinceT0: NOW - 72 * 3600, tokens: [A], priors: [] };
  const fr = simulate(input, analyze(input, { win: 2, hours: 72 }), fnOnly.strategy, ENV);
  assert.deepEqual([fr.trades[0]!.reason, fnOnly.logs.length, fnOnly.logs[0]], ["2×", 29, 'x 1 {"a":1}'], "a bare function is the step; logs captured with JSON for objects");
  console.log("ok strategy: compile / runtime error shapes with line + token, sandbox limits, function shorthand, log capture");
}

{
  // 按入场日汇总（tz）：三笔分两天（Asia/Shanghai 的 09-13 / 09-14，UTC 则全是 09-13）；每天 best / exBest；整体 exBest = 去掉最好一笔
  // NOW = 2026-09-21T14:13:20Z；入场日用显式 UTC 时刻：09-13 15:00（上海 23:00）与 09-13 17:00（上海 09-14 01:00）
  const dayA = Date.UTC(2026, 8, 13, 15) / 1000, dayB = Date.UTC(2026, 8, 13, 17) / 1000;
  const P = tok(40, dayA, { series: pts(dayA, 300, (i) => (i >= 30 ? 2.5 : 1)) }); // 止盈 → 赚
  const Q = tok(41, dayA + 600, { series: pts(dayA + 600, 300, (i) => (i >= 30 ? 0.4 : 1)) }); // 止损 → 亏
  const R = tok(42, dayB, { series: pts(dayB, 300, (i) => (i >= 30 ? 3 : 1)) }); // 次日（上海）止盈
  const sh = runOn([P, Q, R], BASIC, "Asia/Shanghai");
  assert.deepEqual(sh.days.map((d) => [d.day, d.n, d.wins]), [["2026-09-13", 2, 1], ["2026-09-14", 1, 1]]);
  const d13 = sh.days[0]!;
  assert.equal(d13.best!.address, P.address);
  assert.ok(Math.abs(d13.exBest - (d13.pnl - d13.best!.pnl)) < 1e-9 && d13.exBest < 0, "day minus its best trade is the losing Q");
  assert.ok(Math.abs(d13.realized + d13.unrealized - d13.pnl) < 1e-9 && d13.unrealized === 0, "everything sold → all realized");
  assert.equal(d13.invested, 200);
  assert.ok(Math.abs(sh.days.reduce((s, d) => s + d.pnl, 0) - sh.pnl) < 1e-9, "days sum to the total");
  assert.equal(sh.best!.address, R.address);
  assert.ok(Math.abs(sh.exBest - (sh.pnl - sh.best!.pnl)) < 1e-9);
  assert.deepEqual(runOn([P, Q, R], BASIC, "UTC").days.map((d) => [d.day, d.n]), [["2026-09-13", 3]]);
  assert.deepEqual(runOn([P, Q, R], BASIC, "Not/AZone").days.map((d) => d.day), ["2026-09-13"], "bad tz falls back to UTC");
  console.log("ok simulate: per-day breakdown in the caller's timezone, ex-best per day and overall");
}

{
  // worker 端到端（开发态 tsx 引导）：临时库里一个币，POST 用的 runStrategy 跑通；策略 + 基准 + logs；出错的形状原样带回
  const file = path.join(os.tmpdir(), `fomomo-strategy-${process.pid}.sqlite`);
  const store = new Store(file);
  const a = addr(0xcc);
  const t0 = Math.floor(Date.now() / 1000) - 2 * 86400; // worker 用真实时钟：首喊放在真实的两天前
  store.insertCall(a, { sender: "kol", time: t0, text: "冲", group: GRP, approx: false, price: 0.001, mc: 100_000 });
  store.upsertToken({ address: a, chainHint: null, market: { chain: "bsc", symbol: "CC", price: 0.003, mc: 300_000, liq: 1, source: "gmgn", updatedAt: NOW }, mentions: [], history: [], links: {}, ath: null, createdAt: null, openAt: null, profile: null, official: [], tweets: [], tweetsAt: 0 });
  for (let i = 0; i < 40; i++) { const mc = i >= 30 ? 200_000 : 100_000; store.insertSample(a, { time: t0 + 20 + i * 20, price: mc / 1e8, mc }, mc, 1, "live"); }
  store.db.close();
  const params = { dbPath: file, hours: 72, win: 2, tz: "Asia/Shanghai", fee: 0.01, stake: 100 };
  const ok = await runStrategy({ ...params, code: `({ step(s) { console.log("step", s.x); if (s.x >= 2) s.sellAll("2×"); } })` });
  assert.ok(ok.ok, `worker should succeed: ${JSON.stringify(ok)}`);
  if (ok.ok) {
    assert.deepEqual([ok.result.strategy.n, ok.result.strategy.trades[0]!.reason, ok.result.baseline.n, ok.result.strategy.days[0]!.n], [1, "2×", 1, 1]);
    assert.ok(ok.result.logs.length >= 30 && ok.result.cohort.eligible === 1 && ok.result.elapsed >= 0);
  }
  const bad = await runStrategy({ ...params, code: "({ step(s) { s.a.b; } })" });
  assert.ok(!bad.ok && bad.error.phase === "step" && bad.error.token === "CC" && bad.error.line === 1, JSON.stringify(bad));
  const slow = await runStrategy({ ...params, code: "({ step(s) { while (true) {} } })" }, 1500);
  assert.ok(!slow.ok && slow.error.phase === "timeout", JSON.stringify(slow));
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
  console.log("ok strategy worker: end-to-end run, error passthrough, hard timeout");
}

{
  // Wilson：0/0 → null；20/20 上界 1；对称
  assert.equal(wilson(0, 0), null);
  const [lo, hi] = wilson(20, 20)!;
  assert.ok(lo > 0.8 && hi === 1);
  const [a, b] = wilson(10, 20)!;
  assert.ok(Math.abs(0.5 - a - (b - 0.5)) < 1e-9);
  // 前排摘要：pool 排除、top10 只数钱包、供应量分母
  const page = { rows: [{ address: "p", amount: 500, addrType: 2 }, { address: "b", amount: 100, addrType: 1 }, ...Array.from({ length: 12 }, (_, i) => ({ address: `w${i}`, amount: 10 - i * 0.5, addrType: 0 }))], more: false };
  const s = topSummary(page, 1000, 5);
  assert.deepEqual([s.rows, s.pools, s.at], [14, 1, 5]);
  assert.ok(Math.abs(s.top10SupplyPct! - 7.75) < 1e-9, "Σ top10 wallets (10+9.5+…+5.5 = 77.5) / 1000");
  assert.equal(topSummary(page, null, 5).top10SupplyPct, null);
  console.log("ok analyze: wilson + topSummary");
}

// ---------- Store：截面 / 社交事件 / analysisInput ----------
{
  const store = new Store(":memory:");
  const a = addr(0xaa);
  const t0 = NOW - 2 * 86400;
  const cut = { chain: "bsc", address: a, kind: "cut" as const, t0, scheduledAt: t0 + CUT_SEC, observedAt: t0 + CUT_SEC + 1, v: 1, json: cutOf() };
  assert.equal(store.insertSnapshot(cut), true);
  assert.equal(store.insertSnapshot({ ...cut, json: cutOf({ market: null }) }), false, "the first cut is never overwritten");
  store.insertSocialEvents([{ chain: "bsc", address: a, ref: "tw:1", kind: "community_tweet", ts: t0 - 100, observedAt: t0, actor: "x", followers: 10, kol: false, text: "hi" }]);
  store.insertSocialEvents([{ chain: "bsc", address: a, ref: "tw:1", kind: "official_tweet", ts: t0 - 100, observedAt: t0 + 5, actor: "x", followers: 99, kol: false, text: "changed" }]);
  store.insertSocialEvents([{ chain: "bsc", address: a, ref: "tw:1", kind: "community_tweet", ts: t0 - 100, observedAt: t0 + 9, actor: "x", followers: 1, kol: false, text: "again" }]);
  const ev = store.db.prepare("SELECT kind, observed_at, followers, text FROM social_event WHERE ref='tw:1'").get() as { kind: string; observed_at: number; followers: number; text: string };
  assert.deepEqual(ev, { kind: "official_tweet", observed_at: t0, followers: 10, text: "hi" }, "kind upgrades to official once and never downgrades; first observation kept");

  store.insertCall(a, { sender: "kol", time: t0, text: "[链接] x", group: GRP, approx: false, price: 0.001, mc: 100_000 });
  store.insertCall(a, { sender: "late", time: t0 + 60, text: "跟", group: GRP, approx: false });
  store.saveContext({ address: a, sender: "kol", ts: t0, grp: GRP, lines: [{ time: t0 - 5, sender: "x", text: "？" }, { time: t0 + 4, sender: "bot", text: "AA\n💰血量：100 K\n👤团员：88\n📈伤害：250 K\n💬热议：首call / 16个群" }], call: 1, after: 1, at: t0 + 60 });
  store.insertCall(addr(0xbb), { sender: "kol", time: NOW - 40 * 86400, text: "old", group: GRP, approx: false, price: 1, mc: 10 }); // 窗口外、先验范围内（30d）外
  const aaUser = { name: "AA", screen: "aa", avatar: "", followers: 1, verified: false, joined: t0 - 86400 };
  const linked = { id: "777", url: "https://x.com/aa/status/777", time: t0 - 3600, kind: "tweet", user: aaUser, text: "gm", translation: null, quoted: null };
  const other = { ...linked, id: "778", url: "https://x.com/aa/status/778", time: t0 - 60 };
  store.upsertToken({ address: a, chainHint: null, market: { chain: "bsc", symbol: "AA", price: 0.001, mc: 100_000, liq: 1, source: "gmgn", updatedAt: NOW }, mentions: [], history: [], links: { twitter: "https://x.com/aa/status/777" }, ath: null, createdAt: t0 - 7200, openAt: t0 - 600, profile: aaUser, official: [other, linked], tweets: [], tweetsAt: t0 + 5 });
  // 行情刷新时 createdAt / openAt 为 null：COALESCE 不把列清掉
  store.upsertToken({ address: a, chainHint: null, market: null, mentions: [], history: [], links: null, ath: null, createdAt: null, openAt: null, profile: null, official: [], tweets: [], tweetsAt: 0 });
  store.insertSample(a, { time: t0 + CUT_SEC + 20, price: 0.001, mc: 100_000 }, 100_000, 1, "live");
  store.insertSample(a, { time: t0 + CUT_SEC + 40, price: 0.003, mc: 300_000 }, 300_000, 1, "live");
  const input = store.analysisInput(NOW - 72 * 3600, NOW);
  assert.equal(input.tokens.length, 1, "only first calls inside the window");
  const t = input.tokens[0]!;
  assert.equal(t.first.sender, "kol");
  assert.equal(t.first.text, "[链接] x");
  assert.deepEqual(t.legacy, { hasTwitter: true, joined: t0 - 86400, isTweet: true, tweetAt: t0 - 3600, followers: 1 }, "linked tweet found by status id, not by position");
  assert.deepEqual([t.createdAt, t.openAt], [t0 - 7200, t0 - 600], "created_at / open_at persist; a later null upsert never clears them");
  assert.equal(t.cut?.observedAt, t0 + CUT_SEC + 1);
  assert.deepEqual(t.series.map((p) => [p.mc, p.liq, p.src]), [[100_000, 1, "live"], [300_000, 1, "live"]]);
  assert.deepEqual([t.card?.holders, t.card?.firstCall, t.card?.volume], [88, true, 250_000], "bot card parsed from the first call context");
  assert.equal(t.calls.length, 2);
  assert.equal(t.social.length, 1);
  assert.equal(input.priors.length, 1, "priors: first calls from the last 30 days before the window");
  const r = analyze(input, { win: 2, hours: 72 });
  assert.equal(r.tokens[0]!.status, "low_coverage");
  assert.equal(r.tokens[0]!.peakX24, 3);
  assert.ok(renderMarkdown(r).includes("采样不足"));
  store.db.close();
  console.log("ok store: snapshot write-once, social kind upgrade, analysisInput shapes");
}

// ---------- Engine：live 首喊 → CUT_SEC 秒后写截面；回灌不写；GMGN 喊单 / 推文进 social_event ----------
{
  const clock = NOW;
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: clock * 1000 });
  const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  class FixtureBridge {
    events: OutEvent[] = [];
    paths: string[] = [];
    emit(e: OutEvent) { this.events.push(e); }
    async rpc(): Promise<null> { return null; }
    async gmgnFetch(params: GmgnFetchParams) {
      this.paths.push(params.path);
      const url = new URL(params.path, "https://fixture.invalid");
      const ok = (data: unknown) => ({ status: 200, body: JSON.stringify({ code: 0, data }) });
      if (url.pathname === "/api/v1/mutil_window_token_info") {
        const body = params.body as { addresses: string[] };
        return ok(body.addresses.map((address) => ({ address, symbol: "LIVE", name: "live token", total_supply: "1000000", price: { price: "0.1" }, liquidity: "5000", holder_count: 80 })));
      }
      if (url.pathname === "/mrwapi/v1/multi_token_full_info") return ok([{ address: LIVE, link: { twitter_username: "livetoken" } }]);
      if (url.pathname === "/vas/api/v1/twitter/token/search") return ok([{ tweet_id: "901", tw_type: "tweet", tw_timestamp: (clock - 7200) * 1000, user: { screen_name: "fan1", name: "fan", avatar: "", followers: 321, verified: false }, content: { text: "early shill" }, tweet_metrics: { likes: 1 } }]);
      if (url.pathname === "/api/v1/twitter/user_profile") return ok({ screen_name: "livetoken", name: "Live", description: `ca ${LIVE}`, profile_image_url: "", followers_count: 4321, following_count: 1, is_blue_verified: true, joined_at: (clock - 10 * 86400) * 1000 });
      if (url.pathname.startsWith("/vas/api/v1/token_holders/")) return ok({ list: [{ address: "pool", balance: "400000", addr_type: 2 }, { address: "w1", balance: "100000", addr_type: 0 }, { address: "w2", balance: "50000", addr_type: 0 }], next: null });
      if (url.pathname.includes("/community/messages")) return ok({ messages: [{ ulid: "01ULID", display_content: "gm call", username: "kolz", display_name: "Kol Z", follower_count: 8000, is_kol: true, created_at: new Date((clock - 300) * 1000).toISOString(), like_count: 0, reply_count: 0 }], has_more: false, next_cursor: null });
      if (url.pathname.includes("/token_candles/") || url.pathname.includes("/token_mcap_candles/")) return ok({ list: [] });
      throw new Error(`Unexpected fixture request: ${params.path}`);
    }
  }
  const LIVE = addr(0x11);
  const OLD = addr(0x22);
  Dex.lookup = async () => null;
  Dex.batch = async () => new Map<string, Market>();
  const store = new Store(":memory:");
  const bridge = new FixtureBridge();
  const engine = new Engine(store, bridge as never);
  engine.start();
  try {
    engine.ingest({ t: "msg", time: clock - 6 * 3600, sender: "kol", text: OLD, addrs: [OLD], chainHint: "bsc", backfill: true, group: GRP });
    engine.ingest({ t: "msg", time: clock, sender: "kol", text: LIVE, addrs: [LIVE], chainHint: "bsc", backfill: false, group: GRP });
    // 攒批 500ms → 行情 → 链确认 → 预拉前排 + GMGN 喊单 → 社交
    for (let i = 0; i < 20; i++) { mock.timers.tick(100); await settle(); }
    assert.ok(bridge.paths.some((p) => p.includes("/token_holders/")), "chain confirmation preloads top holders for the cut");
    assert.ok(bridge.paths.some((p) => p.includes("/community/messages")), "…and the GMGN calls first page");
    assert.equal((store.db.prepare("SELECT COUNT(*) n FROM token_snapshot").get() as { n: number }).n, 0, "no cut before CUT_SEC");
    mock.timers.tick(CUT_SEC * 1000 + 50);
    await settle();
    const rows = store.db.prepare("SELECT chain, address, t0, scheduled_at, observed_at, json FROM token_snapshot").all() as Array<{ chain: string; address: string; t0: number; scheduled_at: number; observed_at: number; json: string }>;
    assert.equal(rows.length, 1, "exactly one cut: the live first call (backfill gets none)");
    const row = rows[0]!;
    assert.deepEqual([row.chain, row.address, row.t0, row.scheduled_at], ["bsc", LIVE, clock, clock + CUT_SEC]);
    assert.ok(row.observed_at >= row.scheduled_at);
    const snap = JSON.parse(row.json) as CutSnapshot;
    assert.equal(snap.market?.mc, 100_000, "mc = price × supply from the gmgn fixture");
    assert.equal(snap.market?.holders, 80);
    assert.equal(snap.twitter?.has, true);
    assert.equal(snap.twitter?.followers, 4321);
    assert.equal(snap.twitter?.verified, true);
    assert.equal(snap.twitter?.bioHasCa, true);
    assert.equal(snap.twitter?.communityN, 1);
    assert.equal(snap.twitter?.earliestTweetTs, clock - 7200);
    assert.deepEqual(snap.gmgnCalls && [snap.gmgnCalls.n, snap.gmgnCalls.kolN, snap.gmgnCalls.maxFollowers], [1, 1, 8000]);
    assert.deepEqual(snap.top && [snap.top.rows, snap.top.pools, snap.top.top10SupplyPct], [3, 1, 15], "(100000 + 50000) / 1e6 supply = 15%");
    assert.equal(snap.fomo, null, "not logged in to fomo → null, not zeros");
    const social = store.db.prepare("SELECT ref, kind, actor, kol FROM social_event WHERE address = ? ORDER BY ref").all(LIVE) as Array<{ ref: string; kind: string; actor: string; kol: number }>;
    assert.deepEqual(social, [{ ref: "gm:01ULID", kind: "gmgn_call", actor: "kolz", kol: 1 }, { ref: "tw:901", kind: "community_tweet", actor: "fan1", kol: 0 }]);
    const src = store.db.prepare("SELECT DISTINCT src FROM samples WHERE address = ?").all(LIVE) as Array<{ src: string }>;
    assert.deepEqual(src, [{ src: "live" }], "live market samples are tagged");
    console.log("ok engine: live first call → cut snapshot at +CUT_SEC with market / twitter / gmgn / top; backfill none; social_event copies");
  } finally {
    engine.close();
    mock.timers.reset();
  }
}
