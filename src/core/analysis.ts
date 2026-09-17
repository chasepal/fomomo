/**
 * 「首喊后 24h 表现复盘」：窗口内被喊过的币按峰倍分达标组 / 对照组，比较三类特征（群 / 推特 / 买入人）在两组的出现率，
 * 并给每币一条「拉升前发生了什么」的事件时间线。纯函数：输入全部来自 `Store.analysisInput()`，不碰网络 / 时钟。
 *
 * 口径（2026-09-13 与 astra 两轮讨论后定，见 findings）：
 * - t0 = 全库首喊时刻。决策截面 = 首喊后 `CUT_SEC` 秒引擎写的一次快照（`token_snapshot` kind='cut'，见 `CutSnapshot`）：
 *   有截面的币基准 = 截面行情 mc、结果从截面起算；没截面的（回灌首喊 / 部署前的老数据）基准 = 首喊那条 `calls.mc`（approx 照带）、结果从 t0 起算。
 * - peakX24 = `[from, from + HORIZON_SEC]` 内采样最高 mc ÷ 基准；`from + HORIZON_SEC > now` → 进行中，只列不比。
 * - 特征只用截面里 `at ≤ 截面` 的字段（防止把拉升后的粉丝 / 持有人当「原因」）；t0 之后才知道的（30min 内几人喊）归「过程」组，页面单列。
 * - 统计只报两组各自 n / 达标 / 率 / Wilson95 与缺失数；任一组 n < MIN_GROUP 不排序。这是关联，不是因果。
 */

import type { CallCard } from "./callcard.js";
import type { GmgnHoldersPage } from "./gmgn.js";

/** 首喊后多少秒写决策截面（行情 0.4–0.8s、社交 / 推文 2–10s、fomo 前排 / Thesis ≤15s 到；来不及的字段就是缺失，不补未来值） */
export const CUT_SEC = 30;
export const HORIZON_SEC = 24 * 3600;
export const SNAPSHOT_V = 1;
/** 两组任一 n 低于它就只报计数、不参与排序 */
export const MIN_GROUP = 20;
/** 「拉升起点」= 首次观测 mc ≥ RISE_X × 基准的采样时刻 */
export const RISE_X = 1.5;
/** 前导窗（秒）：拉升起点前这些窗口内各类事件的条数 */
export const LEAD_WINDOWS = [900, 1800, 3600] as const;
/** 「观测持续翻倍」：mc ≥ 2× 基准的连续实时采样点串，相邻点间隔 ≤ 这个数才算连续 */
export const SUSTAIN_GAP_SEC = 60;
export const SUSTAIN_SPANS = [60, 180, 300] as const;
/** 时间线往前看多久的推文 / GMGN 喊单（更早的铺垫只进 `twitter.earliestTweetTs`） */
export const TIMELINE_BACK_SEC = 7 * 24 * 3600;
export const TIMELINE_MAX_EVENTS = 300;

// ---------- 落库形状 ----------

/** `token_snapshot.json`（kind='cut'）：每个来源带自己的观测时刻 `at`，为 null = 截面时还没到 / 不适用 */
export interface CutSnapshot {
  v: number;
  market: { at: number; mc: number | null; liq: number | null; price: number | null; holders: number | null } | null;
  /** at = tweetsAt（社区推文那次搜索的时刻；官推资料 / 官推列表与它同批） */
  twitter: {
    at: number;
    has: boolean;
    followers: number | null;
    joined: number | null;
    verified: boolean | null;
    /** 官推 bio 里含合约地址 */
    bioHasCa: boolean | null;
    /** 已抓到的条数（社区推文服务端上限 100；不是全网总数） */
    officialN: number;
    communityN: number;
    /** 已抓到的最早一条（官推 ∪ 社区）的发推时刻 */
    earliestTweetTs: number | null;
  } | null;
  /** GMGN 喊单首页（≤50 条）里 ts ≤ 截面的那些 */
  gmgnCalls: { at: number; n: number; kolN: number; maxFollowers: number | null } | null;
  /** 未登录 fomo / 该链 fomo 不支持 → null；各子项各自 at ≤ 截面才有 */
  fomo: {
    buyers: number;
    holders: { n: number; at: number } | null;
    frontRank: { ratio: number | null; at: number } | null;
    thesis: { count: number; at: number } | null;
  } | null;
  /** gmgn 前排前 100 行的结构 */
  top: { at: number; rows: number; pools: number; top10SupplyPct: number | null } | null;
}

export interface SnapshotRow {
  chain: string;
  address: string;
  kind: "cut";
  t0: number;
  /** 计划的截面时刻 = t0 + CUT_SEC */
  scheduledAt: number;
  /** 实际写入时刻（定时器晚了就大于 scheduledAt） */
  observedAt: number;
  v: number;
  json: CutSnapshot;
}

export type SocialKind = "official_tweet" | "community_tweet" | "gmgn_call";

/** `social_event` 一行：推文 / GMGN 喊单的 append-only 副本（tokens.official/tweets 是覆盖式的，会丢历史）。ref 带命名空间 `tw:` / `gm:` */
export interface SocialEventRow {
  chain: string;
  address: string;
  ref: string;
  kind: SocialKind;
  ts: number;
  observedAt: number;
  actor: string;
  followers: number | null;
  kol: boolean;
  text: string | null;
}

// ---------- analyze() 输入（Store.analysisInput 拼） ----------

export interface SeriesPoint {
  ts: number;
  mc: number;
  price: number;
  /** 流动性 USD（老行 / 来源没给 = null） */
  liq: number | null;
  /** 'live' 实时行情 / 'candle' 蜡烛回补（priceFromCandles 种子）/ null 老数据不知道 */
  src: "live" | "candle" | null;
}

/** 结果窗口内至少这么多采样点才算覆盖够（20s 一点 ≈ 3 分钟）；不够 → low_coverage，只列不比 */
export const MIN_SAMPLES = 10;
/** 采样点隐含供应量（mc ÷ price）与基准隐含供应量差超过这个倍数 → 行情源换算口径变了（DexScreener ↔ gmgn 供应量不一致），该点剔除不进峰值 */
export const SUPPLY_TOLERANCE = 3;
/**
 * 错币报价：相对上一个保留点（首点相对基准）一步跳 ≥ SPIKE_X 倍，且 ≤ SPIKE_REVERT_SEC 内「跳回来」——回到跳变前 1/3–3×，
 * 或反向再一步跳 ≥ SPIKE_X 倍（采样断了十几小时再进面板时真价可能已不在原位，只能看它是不是一步跳出去又一步跳回来）——整段剔除。
 * 真库 30d 扫描：LUNA / HEMI / KEYCAT / NEKO 四个同名 meme 被按上市大币的价格报了 1–8 个点（最长 200s，都在（重新）进面板后的第一批采样），
 * 供应量一致所以 SUPPLY_TOLERANCE 抓不到；HEMI 一段 1400× 的假报价能让不设止损的尾仓「赚」$69K。跳上去不回来的保留——那是真拉升
 */
export const SPIKE_X = 20;
export const SPIKE_REVERT_SEC = 600;

/** 剔除错币报价段；pts 按 ts 升序 */
function dropSpikes(pts: SeriesPoint[], base: number): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  let i = 0;
  while (i < pts.length) {
    const p = pts[i]!;
    const ref = out.length ? out[out.length - 1]!.mc : base;
    const r = p.mc / ref;
    if (r >= SPIKE_X || r <= 1 / SPIKE_X) {
      const up = r >= SPIKE_X;
      let j = i + 1;
      while (j < pts.length && pts[j]!.ts - p.ts <= SPIKE_REVERT_SEC) {
        const q = pts[j]!;
        const toRef = q.mc / ref;
        const step = q.mc / pts[j - 1]!.mc;
        if ((toRef < SUPPLY_TOLERANCE && toRef > 1 / SUPPLY_TOLERANCE) || (up ? step <= 1 / SPIKE_X : step >= SPIKE_X)) break;
        j++;
      }
      if (j < pts.length && pts[j]!.ts - p.ts <= SPIKE_REVERT_SEC) {
        i = j; // [i, j) 是跳出去又跳回来的段
        continue;
      }
    }
    out.push(p);
    i++;
  }
  return out;
}

export interface AnalysisToken {
  address: string;
  chain: string | null;
  symbol: string | null;
  logo: string | null;
  t0: number;
  /** 首喊那条（同刻多条取 id 最小） */
  first: { sender: string; grp: string; text: string | null; mc: number | null; price: number | null; approx: boolean };
  nowMc: number | null;
  nowPrice: number | null;
  nowLiq: number | null;
  cut: SnapshotRow | null;
  /** 首喊后 ≤120s 群里机器人回的代币卡片（持有人 / 成交量 / 几个群在聊 / 是否首 call）；没有 = null。喊单那一刻可知，不泄漏 */
  card: CallCard | null;
  /**
   * 没截面时也能用的推特事实：官推链接有没有、账号注册日期——两者不随拉升改变，事后拿到也不算泄漏。
   * isTweet = 链接含 /status/（指向一条推文而非账号主页；无链接 = false）；tweetAt = 被链接那条推文的发出时刻（不随拉升变）；
   * followers = 链接账号粉丝（tokens.profile，刷新会覆盖 → 事后值，近似 t0；研究结论 2026-09-15 只把它当粗档位用）
   */
  legacy: { hasTwitter: boolean | null; joined: number | null; isTweet: boolean; tweetAt: number | null; followers: number | null };
  /** 代币创建 / 迁出（开盘）时刻（tokens.created_at / open_at，来自 gmgn full_info）；不知道 = null */
  createdAt: number | null;
  openAt: number | null;
  /** `[from, from + HORIZON_SEC]` 的采样（mc 非空），按 ts 升序 */
  series: SeriesPoint[];
  /** `[t0, t0 + HORIZON_SEC]` 的全部喊单 */
  calls: Array<{ id: number; sender: string; grp: string; ts: number; text: string | null }>;
  /** `[t0 - 24h, t0 + HORIZON_SEC]` 的关注者活动 */
  fomo: Array<{ handle: string; kind: "buy" | "sell" | "thesis"; usd: number | null; ts: number; comment: string | null }>;
  /** `[t0 - TIMELINE_BACK_SEC, t0 + HORIZON_SEC]` 的推文 / GMGN 喊单 */
  social: SocialEventRow[];
}

/** 喊单人先验的原料：更长窗口里每个币的首喊人与原始 24h 峰倍（SQL 直接算，不走截面） */
export interface PriorCall {
  address: string;
  grp: string;
  sender: string;
  t0: number;
  peakX24: number | null;
}

export interface AnalysisInput {
  now: number;
  sinceT0: number;
  tokens: AnalysisToken[];
  priors: PriorCall[];
}

// ---------- analyze() 输出 ----------

export interface GroupStat {
  n: number;
  hit: number;
  rate: number | null;
  ci: [number, number] | null;
}

export type FeatureGroup = "group" | "twitter" | "buyers" | "process";

export interface FeatureStat {
  id: string;
  label: string;
  group: FeatureGroup;
  with: GroupStat;
  without: GroupStat;
  /** 该特征在合格币里不可判定的个数（截面缺字段 / 没截面） */
  missing: number;
  /** with.rate ÷ without.rate；任一为 null 或 without.rate = 0 → null */
  lift: number | null;
  /** 两组 n 都 ≥ MIN_GROUP 才参与排序 */
  rankable: boolean;
}

export type EventKind = "group_call" | "official_tweet" | "community_tweet" | "gmgn_call" | "fomo_buy" | "fomo_sell" | "fomo_thesis";
export const EVENT_KINDS: readonly EventKind[] = ["group_call", "official_tweet", "community_tweet", "gmgn_call", "fomo_buy", "fomo_sell", "fomo_thesis"];

export interface TimelineEvent {
  ts: number;
  kind: EventKind;
  actor: string;
  /** group_call 才有：原始群 id */
  group: string | null;
  text: string | null;
  usd: number | null;
  followers: number | null;
  kol: boolean;
  /** 相对结果起点 from：之前 = 可能是原因；之后 = 过程 */
  phase: "before" | "after";
}

export type TokenStatus = "ok" | "incomplete" | "no_base" | "no_samples" | "low_coverage" | "chain_conflict";

export interface TokenOutcome {
  address: string;
  chain: string | null;
  symbol: string | null;
  logo: string | null;
  t0: number;
  /** 结果起点：有截面 = 截面实际写入时刻，否则 t0 */
  from: number;
  hasCut: boolean;
  base: number | null;
  approx: boolean;
  status: TokenStatus;
  peakX24: number | null;
  peakAt: number | null;
  /** 现市值 ÷ 基准（asOf = 报告时刻，不是 24h 内） */
  nowX: number | null;
  zero: boolean | null;
  /** 观测持续翻倍（按 SUSTAIN_SPANS 各阈值）；采样来源未知（老数据）→ null */
  sustained: Record<number, boolean> | null;
  tRise: number | null;
  hit: boolean | null;
  firstGroup: string;
  firstSender: string;
  /** 首喊人先验：该 (grp, sender) 在 t0 之前已完结的首喊里的 n / 达标数（< MIN_GROUP 的页面不排序，模拟里照给） */
  prior: { n: number; hit: number } | null;
  /** 命中的特征 id（value === true） */
  features: string[];
  /** 拉升起点前各窗口内各类事件条数；没有拉升起点 → null */
  leading: Record<number, Record<EventKind, number>> | null;
  events: TimelineEvent[];
  samples: number;
  /** 被剔除的采样点数：隐含供应量与基准不一致（跨行情源换算口径跳变）+ 错币报价段（一步跳 ≥ SPIKE_X 倍又回落） */
  dropped: number;
}

export interface AnalysisReport {
  asOf: number;
  window: { sinceT0: number; hours: number };
  horizonSec: number;
  cutSec: number;
  win: number;
  cohort: {
    total: number;
    eligible: number;
    hit: number;
    rate: number | null;
    ci: [number, number] | null;
    excluded: Record<Exclude<TokenStatus, "ok">, number>;
    withCut: number;
    byChain: Record<string, GroupStat>;
    byGroup: Record<string, GroupStat>;
  };
  features: FeatureStat[];
  /** 按链分层（合格币 ≥ 2×MIN_GROUP 的链才出） */
  strata: Array<{ chain: string; n: number; features: FeatureStat[] }>;
  tokens: TokenOutcome[];
  caveats: string[];
}

// ---------- 小工具 ----------

/** Wilson 95% 区间 */
export function wilson(hit: number, n: number): [number, number] | null {
  if (n <= 0) return null;
  const z = 1.96;
  const p = hit / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/** 等间隔抽 n 个点（首尾保留） */
export function thin<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(xs[Math.floor((i * (xs.length - 1)) / (n - 1))]!);
  return out;
}

function stat(n: number, hit: number): GroupStat {
  return { n, hit, rate: n ? hit / n : null, ci: wilson(hit, n) };
}

/** gmgn 前排一页 → 截面里的结构摘要。supply = 市值 ÷ 单价（都要有），没有就 top10SupplyPct = null */
export function topSummary(page: GmgnHoldersPage, supply: number | null, at: number): NonNullable<CutSnapshot["top"]> {
  const pools = page.rows.filter((r) => r.addrType === 2).length;
  const wallets = page.rows.filter((r) => r.addrType === 0).sort((a, b) => b.amount - a.amount).slice(0, 10);
  const top10 = wallets.reduce((s, r) => s + r.amount, 0);
  return { at, rows: page.rows.length, pools, top10SupplyPct: supply && supply > 0 && wallets.length ? (top10 / supply) * 100 : null };
}

// ---------- 特征 ----------

interface Ctx {
  t: AnalysisToken;
  o: TokenOutcome;
  cut: CutSnapshot | null;
  /** 首喊人先验：该 (grp, sender) 在 t0 之前已完结的首喊里的达标率 */
  prior: { n: number; hit: number } | null;
  win: number;
}

interface FeatureDef {
  id: string;
  label: string;
  group: FeatureGroup;
  value: (c: Ctx) => boolean | null;
}

const bucket = (v: number | null | undefined, lo: number | null, hi: number | null): boolean | null => (v === null || v === undefined ? null : (lo === null || v >= lo) && (hi === null || v < hi));

const FEATURES: FeatureDef[] = [
  // 群（首喊那条本身 + 喊单人先验）
  { id: "mc_lt_50k", label: "基准市值 < $50k", group: "group", value: (c) => bucket(c.o.base, null, 50_000) },
  { id: "mc_50k_200k", label: "基准市值 $50k–200k", group: "group", value: (c) => bucket(c.o.base, 50_000, 200_000) },
  { id: "mc_200k_1m", label: "基准市值 $200k–1M", group: "group", value: (c) => bucket(c.o.base, 200_000, 1_000_000) },
  { id: "mc_ge_1m", label: "基准市值 ≥ $1M", group: "group", value: (c) => bucket(c.o.base, 1_000_000, null) },
  { id: "liq_lt_10k", label: "截面流动性 < $10k", group: "group", value: (c) => bucket(c.cut?.market?.liq, null, 10_000) },
  { id: "liq_10k_50k", label: "截面流动性 $10k–50k", group: "group", value: (c) => bucket(c.cut?.market?.liq, 10_000, 50_000) },
  { id: "liq_ge_50k", label: "截面流动性 ≥ $50k", group: "group", value: (c) => bucket(c.cut?.market?.liq, 50_000, null) },
  { id: "first_link", label: "首喊消息文本前缀为「[链接]」", group: "group", value: (c) => (c.t.first.text === null ? null : c.t.first.text.startsWith("[链接]")) },
  { id: "prior_ge_40", label: `首喊人先验达标率 ≥ 40%（n ≥ ${MIN_GROUP}）`, group: "group", value: (c) => (c.prior && c.prior.n >= MIN_GROUP ? c.prior.hit / c.prior.n >= 0.4 : null) },
  { id: "prior_lt_20", label: `首喊人先验达标率 < 20%（n ≥ ${MIN_GROUP}）`, group: "group", value: (c) => (c.prior && c.prior.n >= MIN_GROUP ? c.prior.hit / c.prior.n < 0.2 : null) },
  // 群（机器人卡片：喊单后几秒内的持有人 / 成交量 / 几个群在聊）
  { id: "cc_first_call", label: "卡片：机器人监控的群里我们首 call", group: "group", value: (c) => c.t.card?.firstCall ?? null },
  { id: "cc_groups_ge_3", label: "卡片：已有 ≥ 3 个群在聊", group: "group", value: (c) => bucket(c.t.card?.groups, 3, null) },
  { id: "cc_holders_lt_100", label: "卡片：持有人 < 100", group: "group", value: (c) => bucket(c.t.card?.holders, null, 100) },
  { id: "cc_holders_ge_500", label: "卡片：持有人 ≥ 500", group: "group", value: (c) => bucket(c.t.card?.holders, 500, null) },
  { id: "cc_vol_ge_mc", label: "卡片：成交量 ≥ 市值", group: "group", value: (c) => (c.t.card?.volume != null && c.t.card.mc ? c.t.card.volume >= c.t.card.mc : null) },
  { id: "cc_since_ge_2", label: "卡片：机器人侦测后已涨 ≥ 2×（追高）", group: "group", value: (c) => (c.t.card ? (c.t.card.sinceX ?? 1) >= 2 : null) },
  // 推特（截面）
  { id: "tw_has", label: "有官推链接（无截面按事后资料）", group: "twitter", value: (c) => c.cut?.twitter?.has ?? (c.cut ? null : c.t.legacy.hasTwitter) },
  { id: "tw_followers_1k", label: "官推粉丝 ≥ 1k", group: "twitter", value: (c) => bucket(c.cut?.twitter?.followers, 1000, null) },
  { id: "tw_followers_10k", label: "官推粉丝 ≥ 10k", group: "twitter", value: (c) => bucket(c.cut?.twitter?.followers, 10_000, null) },
  {
    id: "tw_young",
    label: "官推账号注册 < 30 天（无截面按事后资料）",
    group: "twitter",
    value: (c) => {
      const joined = c.cut ? c.cut.twitter?.joined ?? null : c.t.legacy.joined;
      return joined ? c.t.t0 - joined < 30 * 86400 : null;
    },
  },
  { id: "tw_verified", label: "官推蓝标", group: "twitter", value: (c) => c.cut?.twitter?.verified ?? null },
  { id: "tw_bio_ca", label: "官推 bio 含合约地址", group: "twitter", value: (c) => c.cut?.twitter?.bioHasCa ?? null },
  { id: "tw_official_any", label: "截面前已抓到官推内容", group: "twitter", value: (c) => (c.cut?.twitter ? c.cut.twitter.officialN > 0 : null) },
  { id: "tw_community_5", label: "截面前已抓到社区推文 ≥ 5", group: "twitter", value: (c) => (c.cut?.twitter ? c.cut.twitter.communityN >= 5 : null) },
  { id: "tw_early_24h", label: "已抓到的最早推文早于首喊 24h+", group: "twitter", value: (c) => (c.cut?.twitter ? (c.cut.twitter.earliestTweetTs === null ? false : c.t.t0 - c.cut.twitter.earliestTweetTs >= 86400) : null) },
  { id: "gm_any", label: "截面前有 GMGN 喊单", group: "twitter", value: (c) => (c.cut?.gmgnCalls ? c.cut.gmgnCalls.n > 0 : null) },
  { id: "gm_kol", label: "截面前有 KOL 的 GMGN 喊单", group: "twitter", value: (c) => (c.cut?.gmgnCalls ? c.cut.gmgnCalls.kolN > 0 : null) },
  // 买入人（截面）
  { id: "holders_lt_100", label: "截面持有人 < 100", group: "buyers", value: (c) => bucket(c.cut?.market?.holders, null, 100) },
  { id: "holders_100_500", label: "截面持有人 100–500", group: "buyers", value: (c) => bucket(c.cut?.market?.holders, 100, 500) },
  { id: "holders_ge_500", label: "截面持有人 ≥ 500", group: "buyers", value: (c) => bucket(c.cut?.market?.holders, 500, null) },
  { id: "fomo_holders", label: "fomo 关注者持有 ≥ 1", group: "buyers", value: (c) => (c.cut?.fomo?.holders ? c.cut.fomo.holders.n >= 1 : null) },
  { id: "fomo_buyers", label: "fomo 关注者买过 ≥ 1", group: "buyers", value: (c) => (c.cut?.fomo ? c.cut.fomo.buyers >= 1 : null) },
  { id: "fomo_thesis", label: "全站 Thesis ≥ 1", group: "buyers", value: (c) => (c.cut?.fomo?.thesis ? c.cut.fomo.thesis.count >= 1 : null) },
  { id: "front_ratio_5", label: "前排比例 ≥ 5%", group: "buyers", value: (c) => (c.cut?.fomo?.frontRank && c.cut.fomo.frontRank.ratio !== null ? c.cut.fomo.frontRank.ratio >= 0.05 : null) },
  { id: "top10_lt_20", label: "前 10 钱包占供应 < 20%", group: "buyers", value: (c) => bucket(c.cut?.top?.top10SupplyPct, null, 20) },
  { id: "top10_ge_50", label: "前 10 钱包占供应 ≥ 50%", group: "buyers", value: (c) => bucket(c.cut?.top?.top10SupplyPct, 50, null) },
  { id: "pools_2", label: "前排列出 ≥ 2 条 pool 地址", group: "buyers", value: (c) => (c.cut?.top ? c.cut.top.pools >= 2 : null) },
  // 过程（t0 之后才知道；页面单列，不当原因）
  { id: "p_senders_30m", label: "首喊后 30min 内 ≥ 2 人喊", group: "process", value: (c) => new Set(c.t.calls.filter((x) => x.ts <= c.t.t0 + 1800).map((x) => `${x.grp}\u0000${x.sender}`)).size >= 2 },
  { id: "p_groups_60m", label: "首喊后 60min 内 ≥ 2 个群喊", group: "process", value: (c) => new Set(c.t.calls.filter((x) => x.ts <= c.t.t0 + 3600).map((x) => x.grp)).size >= 2 },
  { id: "p_gm_60m", label: "首喊后 60min 内出现 GMGN 喊单", group: "process", value: (c) => c.t.social.some((x) => x.kind === "gmgn_call" && x.ts > c.t.t0 && x.ts <= c.t.t0 + 3600) },
  { id: "p_official_60m", label: "首喊后 60min 内官推发推", group: "process", value: (c) => c.t.social.some((x) => x.kind === "official_tweet" && x.ts > c.t.t0 && x.ts <= c.t.t0 + 3600) },
  { id: "p_fomo_buy_60m", label: "首喊后 60min 内 fomo 关注者买入", group: "process", value: (c) => c.t.fomo.some((x) => x.kind === "buy" && x.ts > c.t.t0 && x.ts <= c.t.t0 + 3600) },
];

/** 能当模拟交易入场条件的特征（决策截面时可知；「过程」组是入场之后才知道的，不能当条件） */
export const ENTRY_FEATURES: ReadonlyArray<{ id: string; label: string; group: FeatureGroup }> = FEATURES.filter((f) => f.group !== "process").map(({ id, label, group }) => ({ id, label, group }));

// ---------- 逐币结果 ----------

function sustainedOf(series: SeriesPoint[], base: number): Record<number, boolean> | null {
  if (series.some((p) => p.src === null)) return null;
  let maxSpan = 0;
  let start: number | null = null;
  let prev: number | null = null;
  for (const p of series) {
    if (p.src !== "live") continue;
    const above = p.mc >= 2 * base;
    if (above && start !== null && prev !== null && p.ts - prev <= SUSTAIN_GAP_SEC) maxSpan = Math.max(maxSpan, p.ts - start);
    else start = above ? p.ts : null;
    prev = p.ts;
  }
  return Object.fromEntries(SUSTAIN_SPANS.map((s) => [s, maxSpan >= s]));
}

function eventsOf(t: AnalysisToken, from: number): TimelineEvent[] {
  const lo = t.t0 - TIMELINE_BACK_SEC;
  const hi = t.t0 + HORIZON_SEC;
  const out: TimelineEvent[] = [];
  const phase = (ts: number): TimelineEvent["phase"] => (ts <= from ? "before" : "after");
  for (const c of t.calls) out.push({ ts: c.ts, kind: "group_call", actor: c.sender, group: c.grp, text: c.text, usd: null, followers: null, kol: false, phase: phase(c.ts) });
  for (const f of t.fomo) out.push({ ts: f.ts, kind: f.kind === "buy" ? "fomo_buy" : f.kind === "sell" ? "fomo_sell" : "fomo_thesis", actor: f.handle, group: null, text: f.comment, usd: f.usd, followers: null, kol: false, phase: phase(f.ts) });
  for (const s of t.social) if (s.ts >= lo && s.ts <= hi) out.push({ ts: s.ts, kind: s.kind, actor: s.actor, group: null, text: s.text, usd: null, followers: s.followers, kol: s.kol, phase: phase(s.ts) });
  out.sort((a, b) => a.ts - b.ts);
  // 太多（社区推文 100 条 × 多次刷新）：优先保留结果起点附近的
  if (out.length > TIMELINE_MAX_EVENTS) {
    const near = (e: TimelineEvent) => Math.abs(e.ts - from);
    return [...out].sort((a, b) => near(a) - near(b)).slice(0, TIMELINE_MAX_EVENTS).sort((a, b) => a.ts - b.ts);
  }
  return out;
}

function leadingOf(events: TimelineEvent[], tRise: number): Record<number, Record<EventKind, number>> {
  const out: Record<number, Record<EventKind, number>> = {};
  for (const w of LEAD_WINDOWS) {
    const counts = Object.fromEntries(EVENT_KINDS.map((k) => [k, 0])) as Record<EventKind, number>;
    for (const e of events) if (e.ts >= tRise - w && e.ts <= tRise) counts[e.kind]++;
    out[w] = counts;
  }
  return out;
}

/** 结果窗口：起点 / 基准 / 剔除口径跳变点后的采样。outcomeOf 与 simulate 共用同一条价格路径 */
export interface ResultWindow {
  from: number;
  base: number;
  supplyOk: (mc: number, price: number | null) => boolean;
  inWindow: SeriesPoint[];
  window: SeriesPoint[];
}

export function resultWindow(t: AnalysisToken): ResultWindow | null {
  const cut = t.cut;
  const from = cut ? cut.observedAt : t.t0;
  const base = cut ? cut.json.market?.mc ?? null : t.first.mc;
  const basePrice = cut ? cut.json.market?.price ?? null : t.first.price;
  if (base === null || base <= 0) return null;
  // 同一个币在 DexScreener / gmgn 之间供应量口径不一致时，mc 会在 price 几乎不动的情况下跳一两个数量级；按隐含供应量与基准比对剔除
  const baseSupply = basePrice && basePrice > 0 ? base / basePrice : null;
  const supplyOk = (mc: number, price: number | null): boolean => {
    if (baseSupply === null || !price || price <= 0) return true;
    const r = mc / price / baseSupply;
    return r <= SUPPLY_TOLERANCE && r >= 1 / SUPPLY_TOLERANCE;
  };
  const inWindow = t.series.filter((p) => p.ts >= from && p.ts <= from + HORIZON_SEC);
  // 两道剔除：供应量口径跳变（供应量不一致）→ 错币报价段（供应量一致但价格一步跳 ≥20× 又回落）
  return { from, base, supplyOk, inWindow, window: dropSpikes(inWindow.filter((p) => supplyOk(p.mc, p.price)), base) };
}

function outcomeOf(t: AnalysisToken, now: number, win: number): TokenOutcome {
  const cut = t.cut;
  const rw = resultWindow(t);
  const o: TokenOutcome = {
    address: t.address, chain: t.chain, symbol: t.symbol, logo: t.logo, t0: t.t0, from: rw?.from ?? (cut ? cut.observedAt : t.t0), hasCut: !!cut,
    base: rw?.base ?? null, approx: cut ? false : t.first.approx,
    status: "ok", peakX24: null, peakAt: null, nowX: null, zero: null, sustained: null, tRise: null, hit: null,
    firstGroup: t.first.grp, firstSender: t.first.sender, prior: null, features: [], leading: null, events: eventsOf(t, rw?.from ?? (cut ? cut.observedAt : t.t0)), samples: 0, dropped: 0,
  };
  if (cut && t.chain && cut.chain !== t.chain) o.status = "chain_conflict";
  else if (!rw) o.status = "no_base";
  if (!rw || o.status === "chain_conflict") return o;
  const { from, base: b, window, inWindow, supplyOk } = rw;
  o.samples = window.length;
  o.dropped = inWindow.length - window.length;
  if (from + HORIZON_SEC > now) o.status = "incomplete";
  else if (window.length === 0) o.status = "no_samples";
  else if (window.length < MIN_SAMPLES) o.status = "low_coverage";
  let peak: SeriesPoint | null = null;
  for (const p of window) {
    if (!peak || p.mc > peak.mc) peak = p;
    if (o.tRise === null && p.mc >= RISE_X * b) o.tRise = p.ts;
  }
  if (peak) {
    o.peakX24 = peak.mc / b;
    o.peakAt = peak.ts;
  }
  o.nowX = t.nowMc !== null && supplyOk(t.nowMc, t.nowPrice) ? t.nowMc / b : null;
  o.zero = o.nowX !== null ? o.nowX <= 0.1 || (t.nowLiq !== null && t.nowLiq < 1000) : null;
  o.sustained = window.length ? sustainedOf(window, b) : null;
  if (o.status === "ok") o.hit = (o.peakX24 ?? 0) >= win;
  if (o.tRise !== null) o.leading = leadingOf(o.events, o.tRise);
  return o;
}

// ---------- 模拟交易（独立页）：策略是一段 JS（core/strategy.ts 编译成 Strategy），逐币在决策截面后假想买入，每个采样调一次 step() 假想卖出；没卖完的尾仓到窗口末按现价估值 ----------

/**
 * 入场成交 = 结果起点之后 ≥ 这么多秒的第一个采样价，不是基准 mc：一是反应延迟（看到喊单 → 点买 → 上链），
 * 二是新币首个 DexScreener 报价常滞后于 gmgn 一到两个数量级（真库：首喊 $3.2K，1s 后 gmgn $53K），按它「买入」是假成交
 */
export const SIM_ENTRY_DELAY_SEC = 20;
/** 尾仓还在、最后一个采样离窗口末（或现在）超过这个数 → 采样断了（掉出面板），标 gap */
export const SIM_TIME_SLACK_SEC = 120;
/** 尾仓没卖完时的系统退出原因；策略自己的 tag 不要撞这两个 */
export const SIM_SYSTEM_REASONS = ["now", "open"] as const;
/** SimTrade.path 抽稀上限（点数） */
export const SIM_PATH_POINTS = 150;

/** 策略在入场时能看到的币：只有喊单那一刻可知的信息——没有现价、没有之后的事件、没有过程特征 */
export interface StrategyToken {
  address: string;
  chain: string | null;
  symbol: string | null;
  /** 首喊时刻 */
  t0: number;
  /** 入场成交时刻 / 市值 / 流动性（来源没给 = null） */
  at: number;
  mc: number;
  liq: number | null;
  firstGroup: string;
  firstSender: string;
  /** 首喊那条消息的文本 */
  text: string | null;
  /** 首喊人先验：t0 之前已完结的首喊数 / 达标（≥2×）数 / 达标率；没历史 = null */
  prior: { n: number; hit: number; rate: number } | null;
  /** 群里机器人在首喊后几秒内回的卡片：持有人 / 成交量 / 几个群在聊 / 是否首 call / 侦测后已涨几倍；没有 = null */
  card: CallCard | null;
  /**
   * 首喊 t0 − 代币创建时刻（秒；gmgn full_info）；不知道 = null。研究结论：<3h 的新币归零风险集中（research/2026-09-15-angles/CrossAngle/report.md §5）
   */
  ageSec: number | null;
  /** 首喊 t0 − 迁出 / 开盘时刻（秒）：负数 = 首喊时还在内盘；不知道 / 接口没给（含首次拉取时仍在内盘）= null */
  openSec: number | null;
  /**
   * 官推：has / joined 不随拉升变，事后拿到也不算泄漏；不知道 = null。
   * isTweet = 链接是一条推文（含 /status/）而不是账号主页，无链接 = false；tweetAgeSec = t0 − 被链接推文的发出时刻，没有 = null；
   * followers = 链接账号粉丝（事后资料近似 t0），没有 = null
   */
  twitter: { has: boolean | null; joined: number | null; isTweet: boolean; tweetAgeSec: number | null; followers: number | null };
  /** 喊单那一刻可知、且为 true 的特征 id（ENTRY_FEATURES） */
  features: ReadonlySet<string>;
  /** 决策截面原始字段；回灌首喊 = null */
  cut: CutSnapshot | null;
}

export interface SimFill {
  x: number;
  pct: number;
  ts: number;
  mc: number;
  tag: string;
}

/** 到当前采样为止的事件（含入场前的：那是入场时就知道的） */
export interface StrategyEvents {
  calls: Array<{ ts: number; grp: string; sender: string }>;
  tweets: Array<{ ts: number; kind: "official_tweet" | "community_tweet"; actor: string; followers: number | null; kol: boolean }>;
  gmgn: Array<{ ts: number; actor: string; followers: number | null; kol: boolean }>;
  fomo: Array<{ ts: number; kind: "buy" | "sell" | "thesis"; handle: string; usd: number | null }>;
}

/**
 * step() 每个采样拿到的状态：只到当前采样为止。
 * 两种入场：entry() 返回金额 = 首个可成交采样立刻买；返回 "watch" = 先看着，之后在 step 里按走势调 `s.buy()` 再买（有选择地买）。
 * 没买之前 x / peakX / dd / held 相对首喊价（= 观察起点）；买入那一刻起相对买入价重新起算（卖出规则关心的是自己的成本）。
 * callX / callPeakX / callMinX / sinceCall 始终相对首喊价，给「看 15 分钟再决定」用
 */
export interface StrategyStep {
  /** 入场时 entry(t) 收到的同一个对象（t0 字段：ageSec / openSec / twitter / card…） */
  token: StrategyToken;
  ts: number;
  mc: number;
  /** 当前采样的流动性 USD（来源没给 = null）：撤池 = liq 相对入场骤降 */
  liq: number | null;
  /** mc ÷ 买入价（没买时 ÷ 首喊价） */
  x: number;
  /** 买入后到现在的最高倍数 */
  peakX: number;
  /** 从买入后最高点回撤的比例 0–1 */
  dd: number;
  /** 买入后秒数（没买时 = sinceCall） */
  held: number;
  /** 相对首喊价：当前倍数 / 首喊后最高 / 首喊后最低 / 首喊后秒数 */
  callX: number;
  callPeakX: number;
  callMinX: number;
  sinceCall: number;
  /** 手里有没有仓位（watch 模式买入前 false；卖完后也 false） */
  holding: boolean;
  /** 离 24h 评估窗末还有多少秒（窗末是定死的时刻，不是偷看）：「拿满就卖」写 windowLeft <= 60 */
  windowLeft: number;
  /** 还没卖的原始仓位比例 0–1（没买 = 0） */
  remaining: number;
  fills: readonly SimFill[];
  /** 有没有一笔成交的倍数 ≥ x */
  sold(x: number): boolean;
  /** 逐币私有状态，跨 step 保留（每个币一个空对象起） */
  state: Record<string, unknown>;
  events: StrategyEvents;
  /** 到现在为止喊过这个币的群数 / 人数（含首喊） */
  groups: number;
  callers: number;
  /** watch 模式：按当前采样价买入 usd（默认每单）。每个币只能买一次；已买过 / 已持仓返回 false */
  buy(usd?: number, tag?: string): boolean;
  /** 按当前采样价卖出原始仓位的 pct（0–1；超出剩余按剩余）。tag = 退出原因标签（页面按它分组） */
  sell(pct: number, tag?: string): void;
  sellAll(tag?: string): void;
}

export interface Strategy {
  /**
   * 入场：返回每单 USD 立刻买；0 / null / false = 不买；不返回 / true = 默认每单立刻买；
   * "watch" = 不买、开始观察，之后在 step 里 `s.buy()`——到窗末都没买 = 放弃（计 watched）。没定义 entry = 全部合格币立刻买
   */
  entry?(t: StrategyToken): number | boolean | "watch" | null | undefined | void;
  /** 每个采样一次（首个可成交采样之后开始）；卖完就不再调 */
  step(s: StrategyStep): unknown;
}

export interface SimEnv {
  /** 单边成本（手续费 + 滑点）比例，买卖各扣一次 */
  fee: number;
  /** 默认每单 USD（entry 不返回数字时） */
  stake: number;
}

/** 策略代码抛出的错误：带阶段与出错的币；cause = 用户代码抛的原始错误（栈里有 strategy.js 行号） */
export class StrategyError extends Error {
  constructor(message: string, readonly phase: "compile" | "entry" | "step", readonly token: string | null = null, readonly ts: number | null = null, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "StrategyError";
  }
}

export interface SimTrade {
  address: string;
  chain: string | null;
  symbol: string | null;
  logo: string | null;
  /** 这单投入 USD（entry 可按币定） */
  stake: number;
  /** 买入时刻 / 市值（watch 模式 = s.buy() 那个采样） */
  entryAt: number;
  entryMc: number;
  /** 首喊价（观察起点的采样）与等了多久再买（立刻买 = 0） */
  callMc: number;
  waitSec: number;
  /** 买入价 ÷ 首喊价：追高了多少 */
  entryX: number;
  /** 最后一次卖出 / 估值的时刻与 mc */
  exitAt: number;
  exitMc: number;
  /** exitMc ÷ entryMc（价格倍数，不是收益倍数） */
  lastX: number;
  /** 入场后到退出 / 估值为止见过的最高倍数 */
  peakX: number;
  /** 卖完 = 最后一腿的 tag；没卖完 = now（尾仓到窗口末按现价估值）/ open（还没满 24h、还在采样，按现价估值） */
  reason: string;
  holdSec: number;
  /** 成交记录（按时间） */
  fills: SimFill[];
  /** 退出 / 估值时还没卖的原始仓位比例 */
  remaining: number;
  /** 已卖出部分的净所得 USD（扣卖出费） */
  realized: number;
  /** 剩余仓位按估值价、扣卖出费后的价值 USD */
  unrealized: number;
  /** realized + unrealized − stake */
  pnl: number;
  /** 尾仓估值时现价不可用（币已不在面板 / 供应量口径不一致）→ 按最后采样 */
  markedAtLast: boolean;
  /** 尾仓还在、采样却在窗口末 / 现在之前 >SIM_TIME_SLACK_SEC 就断了（掉出面板前 40）：中间发生了什么不知道 */
  gap: boolean;
  /**
   * 买入后的倍数路径 `[入场后秒数, mc ÷ 买入价]`（倍数取 4 位小数）：首点 [0, 1]，之后每个采样一点，均匀抽稀到 ≤ SIM_PATH_POINTS 点且保留最后一点。
   * 只在 pnl > 0 的交易上给（页面画「盈利币的倍数曲线 + 买卖点」），其余 []；基准那次 simulate 关掉（`path: false`）——都是为响应体积
   */
  path: Array<[number, number]>;
}

/** 按入场日（调用方时区）汇总的一天 */
export interface SimDay {
  /** YYYY-MM-DD */
  day: string;
  n: number;
  /** 还没结算的笔数（now / open） */
  open: number;
  invested: number;
  wins: number;
  realized: number;
  unrealized: number;
  pnl: number;
  /** 当天最好一笔；exBest = pnl − best.pnl：去掉它这天还剩多少——一天的盈亏是不是一个币撑起来的 */
  best: SimTrade | null;
  exBest: number;
}

export interface SimResult {
  env: SimEnv;
  /** 成交的币数（= 交易数） */
  n: number;
  /** 被跳过的币：状态不合格，或结果起点后 ≥ SIM_ENTRY_DELAY_SEC 处没有任何采样可成交（no_entry） */
  skipped: Record<Exclude<TokenStatus, "ok" | "incomplete"> | "no_entry", number>;
  /** entry() 说不买的合格币数 */
  declined: number;
  /** entry() 说观察、但到窗末都没买的合格币数 */
  watched: number;
  invested: number;
  pnl: number;
  realized: number;
  unrealized: number;
  /** pnl ÷ invested */
  ret: number | null;
  wins: number;
  winRate: number | null;
  /** 每单净盈亏的中位数 */
  median: number | null;
  best: SimTrade | null;
  worst: SimTrade | null;
  /** pnl − best.pnl：去掉最好一笔 */
  exBest: number;
  /** 按退出原因（策略 tag + now / open） */
  byReason: Record<string, { n: number; pnl: number }>;
  /** 按入场时间累计净盈亏 */
  curve: Array<{ ts: number; cum: number }>;
  /** 按入场日（tz）升序 */
  days: SimDay[];
  trades: SimTrade[];
}

/** ts → 该时区的 YYYY-MM-DD。tz 非法退回 UTC */
export function dayKeyer(tz: string): (ts: number) => string {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" });
  }
  return (ts) => fmt.format(new Date(ts * 1000));
}

const ENTRY_IDS = new Set(ENTRY_FEATURES.map((f) => f.id));
// vm 里抛的错误不是本上下文的 Error 实例，按形状取
const errText = (e: unknown) => (e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e));

function simulateOne(t: AnalysisToken, o: TokenOutcome, rw: ResultWindow, now: number, strategy: Strategy, env: SimEnv, withPath: boolean): SimTrade | "declined" | "watched" | null {
  const start = rw.window.findIndex((p) => p.ts >= rw.from + SIM_ENTRY_DELAY_SEC);
  if (start === -1) return null;
  // 观察起点 = 首个可成交采样（首喊价）；立刻买模式在这里成交，watch 模式之后按走势再买
  const call = rw.window[start]!;
  const callMc = call.mc;
  const label = t.symbol ?? t.address.slice(0, 10);
  const token: StrategyToken = Object.freeze({
    address: t.address, chain: t.chain, symbol: t.symbol, t0: t.t0, at: call.ts, mc: callMc, liq: call.liq ?? null,
    firstGroup: t.first.grp, firstSender: t.first.sender, text: t.first.text,
    prior: o.prior ? { n: o.prior.n, hit: o.prior.hit, rate: o.prior.hit / o.prior.n } : null,
    card: t.card,
    ageSec: t.createdAt === null ? null : t.t0 - t.createdAt,
    openSec: t.openAt === null ? null : t.t0 - t.openAt,
    twitter: { has: t.legacy.hasTwitter, joined: t.legacy.joined, isTweet: t.legacy.isTweet, tweetAgeSec: t.legacy.tweetAt === null ? null : t.t0 - t.legacy.tweetAt, followers: t.legacy.followers },
    features: new Set(o.features.filter((f) => ENTRY_IDS.has(f))), cut: t.cut?.json ?? null,
  });
  let stake = env.stake;
  let watch = false;
  if (strategy.entry) {
    let r: unknown;
    try {
      r = strategy.entry(token);
    } catch (e) {
      throw new StrategyError(`entry() 出错：${errText(e)}`, "entry", label, call.ts, e);
    }
    if (r === 0 || r === null || r === false) return "declined";
    if (r === "watch") watch = true;
    else if (typeof r === "number") {
      if (!Number.isFinite(r) || r <= 0) return "declined";
      stake = r;
    }
  }
  // 仓位（买入后才有）
  let entry: SeriesPoint | null = null;
  let base = callMc;
  let units = 0;
  let bought = false;
  const sellNet = (q: number, mc: number) => q * units * mc * (1 - env.fee);
  const fills: SimFill[] = [];
  let remaining = 0;
  let realized = 0;
  let peak = callMc;
  let callPeak = callMc, callMin = callMc;
  let lastTag = "";
  let cur: SeriesPoint = call;
  // 买入后每个采样一点 [入场后秒数, 倍数]；只有最终 pnl > 0 才随 SimTrade 返回
  const path: Array<[number, number]> = [];
  const open = (p: SeriesPoint, usd: number) => {
    entry = p;
    base = p.mc;
    units = (usd * (1 - env.fee)) / base;
    stake = usd;
    remaining = 1;
    bought = true;
    peak = p.mc;
    path.push([0, 1]);
    s.holding = true;
    s.remaining = 1;
    s.x = 1; s.peakX = 1; s.dd = 0; s.held = 0;
  };
  // 事件按时间推进，策略只看得到 ts ≤ 当前采样的
  const calls = t.calls, social = t.social, fomo = t.fomo;
  let ci = 0, si = 0, fi = 0;
  const events: StrategyEvents = { calls: [], tweets: [], gmgn: [], fomo: [] };
  const grps = new Set<string>(), senders = new Set<string>();
  const advance = (ts: number) => {
    while (ci < calls.length && calls[ci]!.ts <= ts) {
      const c = calls[ci++]!;
      events.calls.push({ ts: c.ts, grp: c.grp, sender: c.sender });
      grps.add(c.grp);
      senders.add(`${c.grp}\u0000${c.sender}`);
    }
    while (si < social.length && social[si]!.ts <= ts) {
      const e = social[si++]!;
      if (e.kind === "gmgn_call") events.gmgn.push({ ts: e.ts, actor: e.actor, followers: e.followers, kol: e.kol });
      else events.tweets.push({ ts: e.ts, kind: e.kind, actor: e.actor, followers: e.followers, kol: e.kol });
    }
    while (fi < fomo.length && fomo[fi]!.ts <= ts) {
      const a = fomo[fi++]!;
      events.fomo.push({ ts: a.ts, kind: a.kind, handle: a.handle, usd: a.usd });
    }
    s.groups = grps.size;
    s.callers = senders.size;
  };
  const s: StrategyStep = {
    token, ts: call.ts, mc: callMc, liq: call.liq ?? null, x: 1, peakX: 1, dd: 0, held: 0, callX: 1, callPeakX: 1, callMinX: 1, sinceCall: 0, holding: false,
    windowLeft: HORIZON_SEC, remaining: 0, fills, state: {}, events, groups: 0, callers: 0,
    sold: (x) => fills.some((f) => f.x >= x),
    buy: (usd, _tag) => {
      if (bought) return false;
      const amt = usd === undefined ? env.stake : usd;
      if (!Number.isFinite(amt) || amt <= 0) return false;
      open(cur, amt);
      return true;
    },
    sell: (pct, tag = "卖出") => {
      if (!(pct > 0) || remaining <= 1e-9) return;
      const q = Math.min(pct, remaining);
      realized += sellNet(q, cur.mc);
      remaining = remaining - q <= 1e-9 ? 0 : remaining - q;
      lastTag = String(tag);
      fills.push({ x: cur.mc / base, pct: q, ts: cur.ts, mc: cur.mc, tag: lastTag });
      s.remaining = remaining;
      s.holding = remaining > 0;
    },
    sellAll: (tag = "清仓") => s.sell(remaining, tag),
  };
  const windowEnd = rw.from + HORIZON_SEC;
  advance(call.ts);
  if (!watch) open(call, stake);
  // 立刻买：从下一个采样起调 step；watch：同样从下一个采样起（在首喊价上 buy 就等于立刻买）。卖完就停
  for (let i = start + 1; i < rw.window.length && !(bought && remaining <= 0); i++) {
    const p = rw.window[i]!;
    cur = p;
    if (p.mc > callPeak) callPeak = p.mc;
    if (p.mc < callMin) callMin = p.mc;
    advance(p.ts);
    s.ts = p.ts;
    s.mc = p.mc;
    s.liq = p.liq ?? null;
    s.callX = p.mc / callMc;
    s.callPeakX = callPeak / callMc;
    s.callMinX = callMin / callMc;
    s.sinceCall = p.ts - call.ts;
    s.windowLeft = windowEnd - p.ts;
    if (bought) {
      if (p.mc > peak) peak = p.mc;
      s.x = p.mc / base;
      s.peakX = peak / base;
      s.dd = 1 - p.mc / peak;
      s.held = p.ts - entry!.ts;
      path.push([Math.round(s.held), Math.round(s.x * 1e4) / 1e4]);
    } else {
      s.x = s.callX; s.peakX = s.callPeakX; s.dd = 1 - p.mc / callPeak; s.held = s.sinceCall;
    }
    try {
      strategy.step(s);
    } catch (e) {
      throw new StrategyError(`step() 出错：${errText(e)}`, "step", label, p.ts, e);
    }
  }
  if (!bought) return "watched";
  const en = entry!;
  let exit: SeriesPoint = cur;
  let reason = lastTag;
  let unrealized = 0;
  let markedAtLast = false;
  let gap = false;
  if (remaining > 0) {
    // 尾仓：现价可用就按现价估值，否则按最后采样；还没满 24h 的标 open，满了标 now
    const nowOk = t.nowMc !== null && t.nowMc > 0 && rw.supplyOk(t.nowMc, t.nowPrice);
    exit = nowOk ? { ts: now, mc: t.nowMc!, price: t.nowPrice ?? 0, liq: t.nowLiq, src: null } : cur;
    markedAtLast = !nowOk;
    reason = now < windowEnd ? "open" : "now";
    unrealized = sellNet(remaining, exit.mc);
    gap = cur.ts < Math.min(now, windowEnd) - SIM_TIME_SLACK_SEC;
  } else exit = { ts: fills[fills.length - 1]!.ts, mc: fills[fills.length - 1]!.mc, price: 0, liq: null, src: null };
  const pnl = realized + unrealized - stake;
  return {
    address: t.address, chain: t.chain, symbol: t.symbol, logo: t.logo, stake,
    entryAt: en.ts, entryMc: base, callMc, waitSec: en.ts - call.ts, entryX: base / callMc,
    exitAt: exit.ts, exitMc: exit.mc, lastX: exit.mc / base, peakX: peak / base,
    reason, holdSec: exit.ts - en.ts, fills, remaining, realized, unrealized, pnl, markedAtLast, gap,
    path: withPath && pnl > 0 ? thin(path, SIM_PATH_POINTS) : [],
  };
}

/**
 * 在 `analyze()` 的同一批币上跑一个策略。入场 = 结果起点（决策截面 / 无截面时首喊）后 ≥ SIM_ENTRY_DELAY_SEC 的第一个采样价；
 * 之后每个窗口内采样调一次 step()。tz = 按入场日汇总用的时区（IANA；页面传浏览器时区）。策略代码出错抛 StrategyError
 */
export function simulate(input: AnalysisInput, report: AnalysisReport, strategy: Strategy, env: SimEnv, tz = "UTC", opts: { path?: boolean } = {}): SimResult {
  const byAddress = new Map(report.tokens.map((o) => [o.address, o]));
  const skipped: SimResult["skipped"] = { no_base: 0, no_samples: 0, low_coverage: 0, chain_conflict: 0, no_entry: 0 };
  let declined = 0, watched = 0;
  const trades: SimTrade[] = [];
  for (const t of input.tokens) {
    const o = byAddress.get(t.address);
    if (!o) continue;
    if (o.status !== "ok" && o.status !== "incomplete") {
      skipped[o.status]++;
      continue;
    }
    const rw = resultWindow(t);
    if (!rw) continue;
    const tr = simulateOne(t, o, rw, input.now, strategy, env, opts.path ?? true);
    if (tr === null) skipped.no_entry++;
    else if (tr === "declined") declined++;
    else if (tr === "watched") watched++;
    else trades.push(tr);
  }
  trades.sort((a, b) => a.entryAt - b.entryAt);
  const byReason: SimResult["byReason"] = {};
  let cum = 0;
  const curve: SimResult["curve"] = [];
  const dayOf = dayKeyer(tz);
  const days: SimDay[] = [];
  for (const tr of trades) {
    const r = (byReason[tr.reason] ??= { n: 0, pnl: 0 });
    r.n++;
    r.pnl += tr.pnl;
    cum += tr.pnl;
    curve.push({ ts: tr.entryAt, cum });
    const key = dayOf(tr.entryAt);
    let d = days[days.length - 1];
    if (!d || d.day !== key) {
      d = { day: key, n: 0, open: 0, invested: 0, wins: 0, realized: 0, unrealized: 0, pnl: 0, best: null, exBest: 0 };
      days.push(d);
    }
    d.n++;
    if (tr.reason === "now" || tr.reason === "open") d.open++;
    d.invested += tr.stake;
    if (tr.pnl > 0) d.wins++;
    d.realized += tr.realized - tr.stake * (1 - tr.remaining);
    d.unrealized += tr.unrealized - tr.stake * tr.remaining;
    d.pnl += tr.pnl;
    if (!d.best || tr.pnl > d.best.pnl) d.best = tr;
  }
  for (const d of days) d.exBest = d.pnl - (d.best?.pnl ?? 0);
  const pnls = trades.map((x) => x.pnl).sort((a, b) => a - b);
  const invested = trades.reduce((s, x) => s + x.stake, 0);
  const wins = trades.filter((x) => x.pnl > 0).length;
  // 已实现 / 未实现盈亏：卖出部分的所得减其成本（stake × 已卖比例）；尾仓估值减其成本（stake × 剩余比例）。两者之和 = pnl
  const realized = trades.reduce((s, x) => s + x.realized - x.stake * (1 - x.remaining), 0);
  const unrealized = trades.reduce((s, x) => s + x.unrealized - x.stake * x.remaining, 0);
  const best = trades.length ? trades.reduce((a, b) => (b.pnl > a.pnl ? b : a)) : null;
  return {
    env, n: trades.length, skipped, declined, watched, invested, pnl: cum, realized, unrealized, ret: invested ? cum / invested : null, wins, winRate: trades.length ? wins / trades.length : null,
    median: pnls.length ? (pnls.length % 2 ? pnls[(pnls.length - 1) / 2]! : (pnls[pnls.length / 2 - 1]! + pnls[pnls.length / 2]!) / 2) : null,
    best,
    worst: trades.length ? trades.reduce((a, b) => (b.pnl < a.pnl ? b : a)) : null,
    exBest: cum - (best?.pnl ?? 0),
    byReason, curve, days, trades: [...trades].sort((a, b) => b.pnl - a.pnl),
  };
}

// ---------- 汇总 ----------

function featureTable(ctxs: Ctx[]): FeatureStat[] {
  const out: FeatureStat[] = [];
  for (const f of FEATURES) {
    let wn = 0, wh = 0, on = 0, oh = 0, missing = 0;
    for (const c of ctxs) {
      const v = f.value(c);
      if (v === null) missing++;
      else if (v) { wn++; if (c.o.hit) wh++; }
      else { on++; if (c.o.hit) oh++; }
    }
    const w = stat(wn, wh);
    const o = stat(on, oh);
    const rankable = wn >= MIN_GROUP && on >= MIN_GROUP;
    out.push({ id: f.id, label: f.label, group: f.group, with: w, without: o, missing, lift: w.rate !== null && o.rate ? w.rate / o.rate : null, rankable });
  }
  // 可排序的按 lift 降序在前（对照组 0 达标而特征组有达标 = lift 无穷大，排最前）；其余按定义顺序
  const key = (s: FeatureStat) => (!s.rankable ? Number.POSITIVE_INFINITY : s.lift !== null ? -s.lift : (s.with.rate ?? 0) > 0 ? Number.NEGATIVE_INFINITY : 0);
  return out.map((s, i) => ({ s, i })).sort((a, b) => key(a.s) - key(b.s) || a.i - b.i).map((x) => x.s);
}

function groupStats(ctxs: Ctx[], keyOf: (c: Ctx) => string | null): Record<string, GroupStat> {
  const acc = new Map<string, { n: number; hit: number }>();
  for (const c of ctxs) {
    const k = keyOf(c);
    if (k === null) continue;
    const a = acc.get(k) ?? { n: 0, hit: 0 };
    a.n++;
    if (c.o.hit) a.hit++;
    acc.set(k, a);
  }
  return Object.fromEntries([...acc.entries()].sort((a, b) => b[1].n - a[1].n).map(([k, v]) => [k, stat(v.n, v.hit)]));
}

export function analyze(input: AnalysisInput, opts: { win: number; hours: number }): AnalysisReport {
  const { now, tokens, priors } = input;
  const win = opts.win;
  // 先验索引：(grp, sender) → 该人的首喊列表
  const byCaller = new Map<string, PriorCall[]>();
  for (const p of priors) {
    const k = `${p.grp}\u0000${p.sender}`;
    (byCaller.get(k) ?? byCaller.set(k, []).get(k)!).push(p);
  }
  const outcomes = tokens.map((t) => outcomeOf(t, now, win));
  const ctxs: Ctx[] = tokens.map((t, i) => {
    const o = outcomes[i];
    const mine = byCaller.get(`${t.first.grp}\u0000${t.first.sender}`) ?? [];
    let n = 0, hit = 0;
    for (const p of mine) {
      if (p.address === t.address || p.peakX24 === null || p.t0 + HORIZON_SEC > t.t0) continue;
      n++;
      if (p.peakX24 >= win) hit++;
    }
    o.prior = n ? { n, hit } : null;
    return { t, o, cut: t.cut?.json ?? null, prior: o.prior, win };
  });
  for (const c of ctxs) c.o.features = FEATURES.filter((f) => f.value(c) === true).map((f) => f.id);

  const eligible = ctxs.filter((c) => c.o.status === "ok");
  const hit = eligible.filter((c) => c.o.hit).length;
  const excluded: AnalysisReport["cohort"]["excluded"] = { incomplete: 0, no_base: 0, no_samples: 0, low_coverage: 0, chain_conflict: 0 };
  for (const c of ctxs) if (c.o.status !== "ok") excluded[c.o.status]++;

  const byChainN = groupStats(eligible, (c) => c.t.chain);
  const strata = Object.entries(byChainN)
    .filter(([, s]) => s.n >= 2 * MIN_GROUP)
    .map(([chain]) => ({ chain, n: byChainN[chain].n, features: featureTable(eligible.filter((c) => c.t.chain === chain)) }));

  const caveats = [
    "这是关联统计，不是因果：样本只含被监听群喊过的币，「被喊」本身就是最强的共同特征。",
    `结果 = 起点后 ${HORIZON_SEC / 3600}h 内采样峰倍；采样只覆盖面板前 40 + 焦点币，冷门币峰值可能漏采（峰倍偏低）。`,
    `有决策截面（首喊后 ${CUT_SEC}s 快照）的币 ${eligible.filter((c) => c.o.hasCut).length}/${eligible.length}；没截面的币只有基准市值 / 先验 / 过程类特征可判定，其余计入 missing。`,
    `两组任一 n < ${MIN_GROUP} 的特征只报计数不排序；lift 未做多重比较校正。`,
    "sustained（观测持续翻倍）只用带来源标记的实时采样；部署前的老采样来源未知 → null。",
  ];
  if (excluded.incomplete) caveats.push(`${excluded.incomplete} 个币首喊距今不足 ${HORIZON_SEC / 3600}h，标「进行中」，不进对照。`);
  if (excluded.chain_conflict) caveats.push(`${excluded.chain_conflict} 个币截面链与当前链不一致（同地址换链），已隔离。`);

  return {
    asOf: now,
    window: { sinceT0: input.sinceT0, hours: opts.hours },
    horizonSec: HORIZON_SEC,
    cutSec: CUT_SEC,
    win,
    cohort: {
      total: ctxs.length,
      eligible: eligible.length,
      hit,
      rate: eligible.length ? hit / eligible.length : null,
      ci: wilson(hit, eligible.length),
      excluded,
      withCut: eligible.filter((c) => c.o.hasCut).length,
      byChain: byChainN,
      byGroup: groupStats(eligible, (c) => c.t.first.grp),
    },
    features: featureTable(eligible),
    strata,
    tokens: outcomes.sort((a, b) => (b.peakX24 ?? -1) - (a.peakX24 ?? -1) || b.t0 - a.t0),
    caveats,
  };
}

// ---------- Markdown（CLI / 复制给别人讨论） ----------

const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(0)}%`);
const ci = (c: [number, number] | null) => (c ? `[${(c[0] * 100).toFixed(0)}–${(c[1] * 100).toFixed(0)}%]` : "");
const x = (v: number | null) => (v === null ? "—" : `${v.toFixed(2)}x`);
const hm = (s: number) => new Date(s * 1000).toISOString().slice(5, 16).replace("T", " ");
const rel = (s: number, from: number) => {
  const d = Math.round((s - from) / 60);
  return d === 0 ? "0m" : d > 0 ? `+${d}m` : `${d}m`;
};
/** lift 文案：两组任一 n 不足 → 样本不足；对照组 0 达标 → ∞（特征组也 0 → —） */
export function liftText(f: FeatureStat): string {
  if (!f.rankable) return "样本不足";
  if (f.lift !== null) return f.lift.toFixed(2);
  return (f.with.rate ?? 0) > 0 ? "∞" : "—";
}
const KIND_LABEL: Record<EventKind, string> = { group_call: "群喊单", official_tweet: "官推", community_tweet: "社区推", gmgn_call: "GMGN 喊单", fomo_buy: "fomo 买", fomo_sell: "fomo 卖", fomo_thesis: "Thesis" };

export function renderMarkdown(r: AnalysisReport, names: { group: (g: string) => string } = { group: (g) => g }): string {
  const L: string[] = [];
  L.push(`# 首喊后 ${r.horizonSec / 3600}h 表现复盘（首喊在过去 ${r.window.hours}h · 达标 = 峰倍 ≥ ${r.win}x · ${hm(r.asOf)} UTC）`);
  L.push("");
  const c = r.cohort;
  L.push(`合格 ${c.eligible}/${c.total} 币，达标 ${c.hit}（${pct(c.rate)} ${ci(c.ci)}）；有截面 ${c.withCut}；排除：进行中 ${c.excluded.incomplete} / 无基准 ${c.excluded.no_base} / 无采样 ${c.excluded.no_samples} / 采样不足 ${c.excluded.low_coverage} / 链冲突 ${c.excluded.chain_conflict}`);
  L.push("");
  L.push("## 按链 / 按首喊群");
  L.push("| 维度 | n | 达标 | 率 |");
  L.push("|---|---|---|---|");
  for (const [k, s] of Object.entries(c.byChain)) L.push(`| 链 ${k} | ${s.n} | ${s.hit} | ${pct(s.rate)} ${ci(s.ci)} |`);
  for (const [k, s] of Object.entries(c.byGroup)) L.push(`| 群 ${names.group(k)} | ${s.n} | ${s.hit} | ${pct(s.rate)} ${ci(s.ci)} |`);
  L.push("");
  const table = (fs: FeatureStat[]) => {
    L.push("| 特征 | 组 | 有：n / 达标率 | 无：n / 达标率 | lift | 缺失 |");
    L.push("|---|---|---|---|---|---|");
    for (const f of fs) L.push(`| ${f.label} | ${f.group} | ${f.with.n} / ${pct(f.with.rate)} ${ci(f.with.ci)} | ${f.without.n} / ${pct(f.without.rate)} ${ci(f.without.ci)} | ${liftText(f)} | ${f.missing} |`);
  };
  L.push("## 特征对照（全部合格币）");
  table(r.features);
  for (const s of r.strata) {
    L.push("");
    L.push(`## 分层：链 ${s.chain}（n=${s.n}）`);
    table(s.features);
  }
  L.push("");
  L.push("## 逐币");
  for (const t of r.tokens) {
    const tag = t.status === "ok" ? (t.hit ? "达标" : "未达标") : t.status === "incomplete" ? "进行中" : t.status === "low_coverage" ? "采样不足" : t.status;
    L.push(`### ${t.symbol ?? t.address.slice(0, 10)} · ${t.chain ?? "?"} · ${tag} · 峰倍 ${x(t.peakX24)} · 现倍 ${x(t.nowX)}${t.sustained ? ` · 持续翻倍 ${SUSTAIN_SPANS.map((s) => `${s}s:${t.sustained![s] ? "✓" : "✗"}`).join(" ")}` : ""}`);
    L.push(`首喊 ${hm(t.t0)} UTC · ${names.group(t.firstGroup)} / ${t.firstSender} · 基准 ${t.base === null ? "—" : `$${Math.round(t.base).toLocaleString()}`}${t.approx ? "≈" : ""} · ${t.hasCut ? `截面 +${t.from - t.t0}s` : "无截面"} · 采样 ${t.samples}${t.dropped ? `（剔除 ${t.dropped}）` : ""}${t.tRise !== null ? ` · 起点 ${rel(t.tRise, t.from)}` : ""}`);
    if (t.features.length) L.push(`命中：${t.features.join(", ")}`);
    if (t.leading) {
      const w = t.leading[3600];
      L.push(`起点前 60min：${EVENT_KINDS.filter((k) => w[k]).map((k) => `${KIND_LABEL[k]} ${w[k]}`).join("，") || "无事件"}`);
    }
    const before = t.events.filter((e) => e.phase === "before").slice(-8);
    const after = t.events.filter((e) => e.phase === "after").slice(0, 8);
    for (const e of [...before, ...after]) L.push(`- ${rel(e.ts, t.from)} ${KIND_LABEL[e.kind]} ${e.actor}${e.kol ? "(KOL)" : ""}${e.followers ? ` ${e.followers}粉` : ""}${e.usd ? ` $${Math.round(e.usd)}` : ""}${e.text ? `：${e.text.replace(/\s+/g, " ").slice(0, 80)}` : ""}`);
    L.push("");
  }
  L.push("## 注意");
  for (const s of r.caveats) L.push(`- ${s}`);
  return L.join("\n");
}
