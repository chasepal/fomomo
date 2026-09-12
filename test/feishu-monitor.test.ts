import assert from "node:assert/strict";
import { mock } from "node:test";
import type { FeishuTransport, ListMessagesQuery, MessagePage, RawChat, RawMessage } from "../src/feishu/client.js";
import { LarkError } from "../src/feishu/client.js";
import type { GroupMsg, MonitorEvent } from "../src/core/messages.js";
import { FeishuMonitor } from "../src/feishu/watch.js";
import { extractFromMessage } from "../src/feishu/content.js";
import { Engine } from "../src/core/engine.js";
import { Store } from "../src/core/store.js";

// 真实的并发轮次 / 去重 / watermark / 取消逻辑，只有 lark-cli 传输层是假的。
// 关注的是会丢消息或重复喊单的边界：重叠窗口去重、分页中途失败不推进、新加群只回灌最近 100 条、取消后迟到页不 emit、轮次屏障、限流全局暂停。

const ADDR = "0x1111111111111111111111111111111111111111";
function msg(id: string, ms: number, text = `买 ${ADDR}`): RawMessage {
  return { message_id: id, msg_type: "text", create_time: String(ms), deleted: false, sender: { id: "ou_a", name: "甲" }, body: { content: JSON.stringify({ text }) } };
}
const page = (items: RawMessage[], pageToken = ""): MessagePage => ({ items, hasMore: Boolean(pageToken), pageToken });

// 卡片 2.0 的正文在 body 内，不能把第一个 header 对象误当语言包装层。
const card = { ...msg("card", Date.now()), msg_type: "interactive", body: { content: JSON.stringify({ header: { title: { tag: "plain_text", content: "新币" } }, body: { elements: [{ tag: "markdown", content: `CA ${ADDR}` }] } }) } };
assert.deepEqual(extractFromMessage(card).addrs, [ADDR]);
const richLink = { ...msg("post", Date.now()), msg_type: "post", body: { content: JSON.stringify({ zh_cn: { title: "链接", content: [[{ tag: "a", text: "查看", href: `https://gmgn.ai/eth/token/${ADDR}` }]] } }) } };
assert.deepEqual(extractFromMessage(richLink).addrs, [ADDR]);
assert.deepEqual(extractFromMessage({ ...card, msg_type: "image" }).addrs, [], "图片不能把结构字段当作可读正文");

class FakeTransport implements FeishuTransport {
  calls: ListMessagesQuery[] = [];
  /** 每次 listMessages 依次弹一个脚本；脚本可以是同步页、异常，或一个门（测试手动放行）；没脚本就挂住，避免空转 */
  script: Array<(q: ListMessagesQuery) => Promise<MessagePage> | MessagePage> = [];
  bootstrap: RawMessage[] = [];
  private readonly aborters = new Set<() => void>();
  async listMessages(q: ListMessagesQuery, signal?: AbortSignal): Promise<MessagePage> {
    if (q.order === "desc" && q.startTime === 0) return page(this.bootstrap);
    this.calls.push(q);
    const next = this.script.shift();
    // 真客户端在 abort/stop 时会杀子进程让请求 reject；假的也得这样，否则挂住的门会让 stop() 等死
    const { promise: aborted, reject } = Promise.withResolvers<MessagePage>();
    const abort = () => reject(new LarkError("请求已取消", "aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    this.aborters.add(abort);
    try {
      return await Promise.race([next ? next(q) : new Promise<MessagePage>(() => undefined), aborted]);
    } finally {
      signal?.removeEventListener("abort", abort);
      this.aborters.delete(abort);
    }
  }
  async listChats(): Promise<RawChat[]> {
    return [{ chat_id: "oc_a", name: "A群", chat_mode: "group" }];
  }
  async stop(): Promise<void> {
    for (const a of this.aborters) a();
  }
}

const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
};

async function scenario(run: (t: FakeTransport, mon: FeishuMonitor, got: GroupMsg[], events: MonitorEvent[]) => Promise<void>, sinceTs = Math.floor(Date.now() / 1000) - 3600) {
  const t = new FakeTransport();
  const got: GroupMsg[] = [];
  const events: MonitorEvent[] = [];
  const mon = new FeishuMonitor(sinceTs, (m) => got.push(m), (e) => events.push(e), t);
  try {
    await run(t, mon, got, events);
  } finally {
    await mon.stop();
  }
}

// 1. 重叠窗口：第二轮重新看到第一轮的消息不得再次喊单；下一轮的 start 必须回退 120s 而不是从 end 起
await scenario(async (t, mon, got) => {
  const now = Date.now();
  const a = msg("om_a", now - 5_000), b = msg("om_b", now - 4_000), c = msg("om_c", now - 1_000);
  const gate = Promise.withResolvers<MessagePage>();
  t.script.push(() => page([a, b]), () => page([a, b, c]), () => gate.promise);
  mon.sync(["oc_a"], true);
  await settle();
  assert.deepEqual(got.map((m) => m.text.includes(ADDR) && m.group), ["feishu:oc_a", "feishu:oc_a", "feishu:oc_a"]);
  assert.deepEqual(got.map((m) => m.time), [a, b, c].map((m) => Number(m.create_time) / 1000), "毫秒精度不能丢");
  assert.equal(got.length, 3, "a、b 在第二轮的重叠窗口里再次出现，不能重复 emit");
  assert.ok(t.calls.length >= 2);
  const [q1, q2] = t.calls;
  assert.ok(q1.endTime! - 120 <= q2.startTime! && q2.startTime! <= q1.endTime!, `第二轮 start 应落在第一轮 end 往前 120s 内：${q1.endTime} -> ${q2.startTime}`);
});

// 2. 分页中途失败：已 emit 的不重复，watermark 不推进，退避后重取能拿到失败页里的新消息
await scenario(async (t, mon, got, events) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  try {
    const now = Date.now();
    const d = msg("om_d", now - 3_000), e = msg("om_e", now - 2_000);
    const gate = Promise.withResolvers<MessagePage>();
    t.script.push(
      () => page([d], "tok1"),
      () => {
        throw new LarkError("飞书接口错误：boom", "api");
      },
      () => page([d, e]),
      () => gate.promise,
    );
    mon.sync(["oc_a"], true);
    await settle();
    assert.deepEqual(got.map((m) => m.sender), ["甲"], "第一页已 emit 的 d 只有一次");
    assert.equal(t.calls.length, 2, "失败后必须退避，不能立刻空转重试");
    assert.ok(events.some((ev) => ev.t === "error" && /boom/.test(ev.message)), "错误要上报一次");
    const groups = await mon.listGroups();
    assert.equal(groups[0].state, "error");
    mock.timers.tick(2_500);
    await settle();
    assert.equal(t.calls.length >= 3, true, "退避到期后重试");
    assert.equal(t.calls[2].pageToken, undefined, "重试从头开始（用 watermark，不是过期 page_token）");
    assert.equal(t.calls[2].startTime, t.calls[0].startTime, "失败轮不得推进 watermark");
    assert.deepEqual(got.map((m) => m.time), [d, e].map((m) => Number(m.create_time) / 1000));
    assert.equal(got[1].time, Number(e.create_time) / 1000, "失败页里的 e 在重试时补到，且 d 不重复");
    assert.equal((await mon.listGroups())[0].state, "monitoring");
  } finally {
    mock.timers.reset();
  }
});

// 3. 运行中新加的群：不在预热批（最近 100 条）里的选中前消息，即使落在查询窗口里也不发；选中后的照发且不标 backfill
await scenario(async (t, mon, got) => {
  const gateA = Promise.withResolvers<MessagePage>();
  t.script.push(() => gateA.promise);
  mon.sync(["oc_a"], true);
  await settle();
  const selectedAt = Date.now();
  const old = msg("om_old", selectedAt - 500), fresh = msg("om_new", selectedAt + 200);
  const gateB = Promise.withResolvers<MessagePage>();
  const next = (q: ListMessagesQuery) => page(q.chatId === "oc_b" ? [old, fresh] : []);
  t.script.push(next, next, () => gateB.promise);
  mon.sync(["oc_a", "oc_b"]);
  gateA.resolve(page([]));
  await settle(12);
  const fromB = got.filter((m) => m.group === "feishu:oc_b");
  assert.equal(fromB.length, 1, "选中前 0.5s 的旧消息不得当作喊单");
  assert.equal(fromB[0].backfill, false);
});

// 4. 取消后迟到的页：请求在飞时把群取消，响应回来不能 emit；stop 后也一样
await scenario(async (t, mon, got) => {
  const gate = Promise.withResolvers<MessagePage>();
  t.script.push(() => gate.promise);
  mon.sync(["oc_a"], true);
  await settle();
  assert.equal(t.calls.length, 1);
  mon.sync([]);
  gate.resolve(page([msg("om_late", Date.now() - 1000)]));
  await settle();
  assert.equal(got.length, 0, "取消后的迟到结果不得 emit");
  assert.equal((await mon.listGroups()).find((g) => g.username === "feishu:oc_a")?.watched, false);
});

// 并发轮次：到期的群同时在飞；一轮全部结束才开下一轮（轮次屏障），先完成的群不会单独空转
await scenario(async (t, mon) => {
  const r1 = [Promise.withResolvers<MessagePage>(), Promise.withResolvers<MessagePage>()];
  const r2 = [Promise.withResolvers<MessagePage>(), Promise.withResolvers<MessagePage>()];
  t.script.push(() => r1[0].promise, () => r1[1].promise, () => r2[0].promise, () => r2[1].promise);
  mon.sync(["oc_a", "oc_b"], true);
  await settle();
  assert.deepEqual(t.calls.map((q) => q.chatId).sort(), ["oc_a", "oc_b"], "两群必须同时在飞，而不是一个群等另一个");
  r1[0].resolve(page([]));
  await settle();
  assert.equal(t.calls.length, 2, "一个群完成、另一个还在飞时不得开下一轮");
  r1[1].resolve(page([]));
  await settle(12);
  assert.equal(t.calls.length, 4, "整轮结束后立刻下一轮");
  assert.deepEqual(t.calls.slice(2).map((q) => q.chatId).sort(), ["oc_a", "oc_b"], "下一轮仍是两群一起");
});

// 限流配额是全局的：一个群撞限流 → 整体暂停一次，不把该群翻成错误、不逐群刷错误事件；暂停到期后所有群一起恢复
await scenario(async (t, mon, _got, events) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  try {
    const limited = (q: ListMessagesQuery) => {
      if (q.chatId === "oc_a") throw new LarkError("飞书接口限流：99991400", "rate-limit");
      return page([]);
    };
    const gate = Promise.withResolvers<MessagePage>();
    t.script.push(limited, limited, () => gate.promise, () => gate.promise);
    mon.sync(["oc_a", "oc_b"], true);
    await settle(12);
    assert.equal(t.calls.length, 2, "限流后整体暂停，不能立刻重试");
    assert.equal(events.filter((ev) => ev.t === "error").length, 1, "只报一次限流暂停");
    assert.match((events.find((ev) => ev.t === "error") as { message: string }).message, /限流/);
    const groups = await mon.listGroups();
    const a = groups.find((g) => g.username === "feishu:oc_a")!;
    assert.equal(a.state, "starting", "限流不是该群的错误");
    assert.equal(a.error, undefined);
    assert.equal(groups.find((g) => g.username === "feishu:oc_b")?.state, "monitoring", "同轮成功的群照常");
    mock.timers.tick(15_500);
    await settle(12);
    assert.equal(t.calls.length, 4, "暂停到期后两群一起恢复");
    assert.deepEqual(t.calls.slice(2).map((q) => q.chatId).sort(), ["oc_a", "oc_b"]);
  } finally {
    mock.timers.reset();
  }
});

// 5. 首批回灌：sinceTs 之后、启动之前的消息标 backfill，启动后的不标
await scenario(async (t, mon, got) => {
  const now = Date.now();
  const gate = Promise.withResolvers<MessagePage>();
  const older = msg("om_bf", now - 60_000);
  t.script.push(() => page([older]), () => gate.promise);
  mon.sync(["oc_a"], true);
  await settle();
  assert.equal(got.length, 1);
  assert.equal(got[0].backfill, true);
});

// 6. readAround：ts 之前（含）before 条 + 之后 after 条，升序；去掉系统/撤回；同参数并发合并成一次请求序列
await scenario(async (t, mon) => {
  const ts = 1_700_000_000.5;
  const tsMs = ts * 1000;
  const pre = [msg("p1", tsMs, "锚点"), msg("p2", tsMs - 1000, "前一条"), { ...msg("p3", tsMs - 1500, "系统"), msg_type: "system" }, msg("p4", tsMs - 2000, "前两条")];
  const post = [msg("q1", tsMs + 500, "后一条"), { ...msg("q2", tsMs + 800, "撤回"), deleted: true }, msg("q3", tsMs + 900, "后两条")];
  t.script.push(() => page(pre), () => page(post), () => page(pre), () => page(post));
  const [rows, again] = await Promise.all([mon.readAround("feishu:oc_a", ts, 3, 2), mon.readAround("oc_a", ts, 3, 2)]);
  assert.equal(t.calls.length, 2, "相同参数并发合并");
  assert.deepEqual(rows.map((r) => r.text), ["前两条", "前一条", "锚点", "后一条", "后两条"]);
  assert.ok(rows.every((r, i) => i === 0 || rows[i - 1].createTime <= r.createTime));
  assert.equal(rows[2].createTime, ts);
  assert.equal(again, rows);
});

// 用户视角过滤会产生空页但仍有下一页；不能按空页/固定页数提前推进检查点。
await scenario(async (t, mon, got) => {
  const expected = msg("after-invisible-pages", Date.now() - 1000);
  for (let i = 0; i < 201; i++) t.script.push(() => page([], `page-${i}`));
  t.script.push(() => page([expected]));
  mon.sync(["oc_a"], true);
  await settle();
  assert.deepEqual(got.map((m) => m.time), [Number(expected.create_time) / 1000]);
});

// 新勾选的群：预热拿到的最近 100 条既做预览，其中的 CA 也当回灌喊单发出（backfill=true，不弹卡、不取现价）
await scenario(async (t, mon, got) => {
  const old = msg("old-preview", (Math.floor(Date.now() / 1000) - 86400) * 1000 + 125, `旧消息 ${ADDR}`);
  t.script.push(() => page([old]));
  t.bootstrap = [old];
  mon.sync(["oc_a"]);
  await settle();
  const groups = await mon.listGroups();
  assert.equal(groups[0].summary, `旧消息 ${ADDR}`);
  assert.equal(groups[0].lastTimestamp, Number(old.create_time) / 1000);
  assert.deepEqual(got.map((m) => [m.time, m.backfill]), [[Number(old.create_time) / 1000, true]], "预热批里的旧 CA 只发一次、标 backfill（查询窗口再看到它不得重复）");
  assert.equal((await mon.readAround("feishu:oc_a", groups[0].lastTimestamp, 100, 0))[0].text, `旧消息 ${ADDR}`);
});

// Cache eviction is per group, chronological, and never persists ordinary conversations.
await scenario(async (t, mon, got, events) => {
  const clock = Date.now();
  const old = Array.from({ length: 100 }, (_, i) => msg(`ordinary-${i}`, clock - 200_000 + i * 1000, `ordinary-${i}`));
  const next = Array.from({ length: 25 }, (_, i) => msg(`new-${i}`, clock + 1000 + i * 1000, `new-${i}`));
  t.bootstrap = [...old].reverse();
  const gate = Promise.withResolvers<MessagePage>();
  t.script.push(() => gate.promise);
  mon.sync(["oc_a", "oc_b"]);
  await settle();
  const first = await mon.readAround("feishu:oc_a", Number(old[99].create_time) / 1000, 200, 0);
  assert.deepEqual(first.map((r) => r.text), old.map((m) => JSON.parse(m.body!.content!).text));
  gate.resolve(page([...old.slice(-10), ...next]));
  await settle();
  const latest = await mon.readAround("feishu:oc_a", Number(next[24].create_time) / 1000, 200, 0);
  assert.deepEqual(latest.map((r) => r.text), [...old.slice(25), ...next].map((m) => JSON.parse(m.body!.content!).text));
  const other = await mon.readAround("feishu:oc_b", Number(old[99].create_time) / 1000, 200, 0);
  assert.equal(other.length, 100);
  assert.equal(other.at(-1)?.text, "ordinary-99");
  assert.deepEqual(got, []);
  assert.equal(events.filter((e) => e.t === "context").length, 0);
});

// Capture CA context before opening any card; append only three following readable messages.
{
  const store = new Store(":memory:");
  const engine = new Engine(store, { emit() {} } as never);
  const t = new FakeTransport();
  const calls: GroupMsg[] = [];
  const mon = new FeishuMonitor(Date.now() / 1000, (m) => calls.push(m), (e) => {
    if (e.t === "context") engine.ingestContext(e);
  }, t);
  try {
    const clock = Date.now();
    const old = Array.from({ length: 100 }, (_, i) => msg(`ordinary-${i}`, clock - 200_000 + i * 1000, `ordinary-${i}`));
    t.bootstrap = [...old].reverse();
    const hit = msg("hit", clock + 1000);
    const gate = Promise.withResolvers<MessagePage>();
    t.script.push(() => gate.promise);
    mon.sync(["oc_a"]);
    await settle();
    assert.deepEqual(store.loadContexts(), []);
    const follow = Promise.withResolvers<MessagePage>();
    t.script.push(() => follow.promise);
    gate.resolve(page([hit]));
    await settle();
    assert.equal(calls.length, 1);
    const initial = store.loadContexts()[0];
    assert.deepEqual(initial.lines.map((r) => r.text), [...old.slice(-4).map((m) => JSON.parse(m.body!.content!).text), `买 ${ADDR}`]);
    assert.equal(initial.call, 4);
    const drain = Promise.withResolvers<MessagePage>();
    t.script.push(() => drain.promise);
    follow.resolve(page([hit, msg("reply1", clock + 2000, "reply1"), { ...msg("system", clock + 2500), msg_type: "system" }, msg("reply2", clock + 3000, "reply2")]));
    await settle();
    assert.equal(store.loadContexts()[0].after, 2);
    drain.resolve(page([msg("reply3", clock + 4000, "reply3"), ...Array.from({ length: 120 }, (_, i) => msg(`noise-${i}`, clock + 5000 + i * 1000, `noise-${i}`))]));
    await settle();
    const saved = store.loadContexts();
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0].lines.map((r) => r.text), [...initial.lines.map((r) => r.text), "reply1", "reply2", "reply3"]);
    assert.equal(saved[0].after, 3);
    const recent = await mon.readAround("feishu:oc_a", (clock + 124000) / 1000, 200, 0);
    assert.deepEqual(recent.map((r) => r.text), Array.from({ length: 100 }, (_, i) => `noise-${i + 20}`));
    mon.sync([]);
    assert.deepEqual(store.loadContexts(), saved, "evicting the call and removing the group must retain only its saved small window");
    engine.ingestContext({ t: "context", msg: calls[0], rows: initial.lines.map((r) => ({ createTime: r.time, sender: r.sender, text: r.text })), call: initial.call });
    assert.deepEqual(store.loadContexts()[0].lines, saved[0].lines, "a late partial read cannot erase the captured following messages");
  } finally {
    await mon.stop();
    engine.close();
    store.db.close();
  }
}

console.log("feishu-monitor: ok");
