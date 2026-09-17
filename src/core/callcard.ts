/**
 * 群里机器人（阿宅5号机）在有人发 CA 后几秒内回的代币卡片，是喊单那一刻**非泄漏**的结构化信息，覆盖近 12 天 59% 的喊单，
 * 比决策截面（09-14 才开始积累）多两个数量级的历史：
 *
 *   💵战力：0.{4}812   价格（`0.{4}812` = 0.0000812）
 *   💰血量：81.2 K     市值
 *   👤团员：350        持有人
 *   📈伤害：922.3 K    成交量
 *   ⚙副本：robinhood   链
 *   📅创建：1970/1/1   创建时间（常为占位）
 *   🔦侦测：9/4 1:21   机器人第一次探测到的时刻（有 = 别处更早） · 🕵哨兵：<人> | 3.6X（当时相对侦测价的倍数）
 *   💬热议：3个群 / 16个群   几个群在聊 / 机器人监控的群总数；「首call / 16个群」= 我们是第一个
 *
 * 卡片文本随机器人版本变，解析只认字段名 + 数字，认不出的字段留 null；整段都认不出 → null
 */
export interface CallCard {
  /** 卡片消息时刻 */
  at: number;
  price: number | null;
  mc: number | null;
  holders: number | null;
  volume: number | null;
  chain: string | null;
  /** 热议：已有几个群在聊（「首call」= 0）；解析不出 = null */
  groups: number | null;
  groupsTotal: number | null;
  /** 我们是机器人监控的群里第一个喊的 */
  firstCall: boolean | null;
  /** 侦测行里的「已 x 倍」：机器人探测到之后到现在的倍数（有侦测行才有） */
  sinceX: number | null;
}

const CARD_RE = /血量|团员|热议/;

/** `0.{4}812` → 0.0000812；`81.2 K` → 81200；`1.1 M`；`350` */
export function parseCardNumber(raw: string): number | null {
  const s = raw.trim().replace(/,/g, "");
  const z = /^0\.\{(\d+)\}(\d+)$/.exec(s);
  if (z) return Number(`0.${"0".repeat(Number(z[1]))}${z[2]}`);
  const m = /^(-?\d+(?:\.\d+)?)\s*([KMB])?$/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] ?? "").toUpperCase() as "K" | "M" | "B"] ?? 1;
  return Number.isFinite(n) ? n * mult : null;
}

const field = (text: string, name: string): string | null => {
  const m = new RegExp(`${name}[：:]\\s*([^\\n|]+)`).exec(text);
  return m ? m[1]!.trim() : null;
};

/** 从一条消息文本解析卡片；不是卡片 → null */
export function parseCallCardText(text: string, at: number): CallCard | null {
  if (!CARD_RE.test(text)) return null;
  const heat = field(text, "热议");
  let groups: number | null = null, groupsTotal: number | null = null, firstCall: boolean | null = null;
  if (heat) {
    const m = /^(首call|(\d+)\s*个群)\s*(?:\/\s*(\d+)\s*个群)?/.exec(heat);
    if (m) {
      firstCall = m[1] === "首call";
      groups = firstCall ? 0 : Number(m[2]);
      groupsTotal = m[3] ? Number(m[3]) : null;
    }
  }
  // 哨兵行：`🕵哨兵：<人> | 3.0X` 或 `| -28%`（侦测后的涨跌）；老版本单独一行 `3.6X`。field() 在 `|` 处截断，这里取整行
  const sentinelLine = /哨兵[：:]([^\n]*)/.exec(text)?.[1] ?? null;
  let sinceX: number | null = null;
  const sm = sentinelLine ? /\|\s*(-?\d+(?:\.\d+)?)\s*(X|x|%)\s*$/.exec(sentinelLine) : null;
  if (sm) sinceX = sm[2] === "%" ? 1 + Number(sm[1]) / 100 : Number(sm[1]);
  else if (sentinelLine !== null || field(text, "侦测") !== null) {
    const alone = /^\s*(\d+(?:\.\d+)?)\s*[xX]\s*$/m.exec(text);
    if (alone) sinceX = Number(alone[1]);
  }
  const num = (name: string) => {
    const v = field(text, name);
    return v ? parseCardNumber(v) : null;
  };
  const chain = field(text, "副本");
  return {
    at,
    price: num("战力"),
    mc: num("血量"),
    holders: num("团员"),
    volume: num("伤害"),
    chain: chain ? chain.toLowerCase() : null,
    groups, groupsTotal, firstCall,
    sinceX,
  };
}

/** 喊单上下文里、喊单后 ≤ windowSec 内的第一张卡片 */
export function parseCallCard(lines: ReadonlyArray<{ time: number; text: string }>, callTs: number, windowSec = 120): CallCard | null {
  for (const l of lines) {
    if (l.time < callTs || l.time > callTs + windowSec) continue;
    const c = parseCallCardText(l.text, l.time);
    if (c) return c;
  }
  return null;
}
