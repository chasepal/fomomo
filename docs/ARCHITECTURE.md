# fomomo 架构与设计说明

面向维护者。使用方法见仓库根 [README.md](../README.md)；术语表见 [CONTEXT.md](../CONTEXT.md)；「为什么这么做」的决策记录见 [adr/](./adr/)。

## 1. 总体结构

```
┌ sidecar（TypeScript，Node 22）────────────────────┐        ┌ Swift（SwiftUI + AppKit）──────────┐
│ wechat/watch   微信分片轮询 → 抽地址              │ stdout │ Sidecar.swift  子进程管理 / 重启   │
│ feishu/watch   lark-cli 并发轮次 → 抽地址         │ ─────▶ │ Feed           纯展示状态          │
│ core/engine    喊单入库、行情编排、喊单价基准、    │ state  │ Views          悬浮窗 / 弹卡渲染    │
│                K 线采样、自喊单涨跌、快照          │kline…  │                                    │
│ core/trade     一键买卖（OKX 路由 + 本地签名）     │        │ GmgnBridge     WKWebView 常驻 gmgn │
│ core/fomo      fomo.family 信号（关注者 / Thesis）│◀ stdin │ FomoBridge     WKWebView 常驻 fomo │
│ core/store     sqlite：tokens / calls / samples … │rpc_result└────────────────────────────────────┘
│ core/server    dashboard HTTP（127.0.0.1:48765）  │
└──────────────────────────────────────────────────┘
```

- **全部业务逻辑在 sidecar，Swift 只展示**：dashboard / 统计 / 设置都在 TS 侧，逻辑放一处；Swift 缩成「浮窗 + 浏览器代理 + 渲染」。
- **唯一例外是页面内请求**：gmgn 私有 API 必须在 gmgn.ai 页面上下文里发（进程外 = Cloudflare 403），fomo.family 的登录态由页面里的 Privy SDK 持有。sidecar 通过 `rpc` 事件让 Swift 在常驻 WKWebView 里代发，Swift 不解析 body，端点 / 字段全由 TS 决定。
- **协议**：`src/core/types.ts` 是唯一定义。sidecar → Swift：`ready` / `state`（全量快照，150ms 合并）/ `new_token` / `kline` / `kline_bar` / `context` / `token_detail` / `settings` / `fomo_state` / `trade_state` / `trade_quote` / `trade` / `trade_holdings` / `fomo_thesis` / `gmgn_calls` / `rpc`；Swift → sidecar：`rpc_result` / `focus` / `kline` / `context` / `front_rank_visible` / `trade_quote` / `trade` / `trade_quick` / `wallet_init` / `…_more`。Swift 解码忽略未知键。

## 2. 目录

```
app/Sources/Fomomo/
  main.swift / AppDelegate.swift   accessory 应用入口；SIGTERM/SIGINT → 正常退出，收掉 sidecar
  OverlayPanel.swift               主面板（贴左缘、上下拖、拖边改尺寸 → 经 dashboard PUT /api/settings 存回）+ 右侧弹卡子窗口 + dashboard 窗口入口
  Theme.swift                      配色 FM.* + 毛玻璃背景
  Model.swift                      Token / Market / Mention / Tweet / Fomo* / Trade*（Decodable，与 TokenView 一一对应）+ Feed（@Observable 展示状态）+ Fmt
  Sidecar.swift                    Process + 3 Pipe：stdout 按行 → Feed；rpc → GmgnBridge / FomoBridge → stdin；退避重启；按 .node-version 找 node
  GmgnBridge.swift / FomoBridge.swift   WKWebView 常驻 gmgn.ai / fomo.family；页面内 fetch；Cloudflare 挑战 / 需要登录时亮窗
  Views.swift                      PanelView（头 / 搜索 / 代币列表 / 持仓区 / 页脚）、TokenRowView、PopupCard（四列）、TradeCard、DepositSheet
  CandleChart.swift                市值蜡烛（NSView 自绘）+ 喊单标记 + 持仓买卖均价线
  DashboardWindow.swift            dashboard 的原生窗口壳（透明标题栏 WKWebView）
src/
  cli.ts                           run（完整 sidecar）/ okx-check / wallet-init / wallet-show / trade-config
  core/types.ts                    协议 + 模型 + Settings / DEFAULT_SETTINGS
  core/engine.ts                   Engine：ingest / 行情编排 / 蜡烛定价 / 社交链接 + 推文 / 采样 / toView / 快照推送 / focus + kline / 复盘决策截面
  core/store.ts                    sqlite：tokens / calls / samples / call_context / settings / fomo_activity / trade / token_snapshot / social_event；overview() / report() / senderStats() / analysisInput()
  core/analysis.ts                 复盘 + 模拟交易（纯函数）：analyze() 达标组 vs 对照组特征对照 + 逐币时间线；renderMarkdown()；simulate() 按 Strategy 逐采样跑；CutSnapshot / SocialEventRow 落库形状
  core/strategy.ts                 策略语言 = JS：compileStrategy() 在 node:vm 干净上下文求值；runStrategy() 起 worker 跑并 15s 超时 terminate
  core/sim-worker.ts               模拟 worker 入口：自己开 Store 读 analysisInput → analyze → 策略 + 基准 → postMessage；打包成 sim-worker.mjs 与 cli.mjs 并排
  core/callcard.ts                 群里机器人（阿宅5号机）回的代币卡片解析：喊单那一刻的持有人 / 成交量 / 几个群在聊 / 是否首 call / 侦测后倍数（近 12 天 2/3 喊单有，比决策截面多两个数量级的历史）
  core/watchers.ts                 每个微信群一个 WechatWatcher，sync(groups) 热加 / 停；运行中新加的群 lastN=100 回灌
  core/messages.ts                 微信 / 飞书共用的 GroupMsg / ContextRow / MonitorEvent
  core/server.ts                   dashboard HTTP：/ 静态页，/api/overview|tokens|groups|settings|stats|sender|report|analysis|simulate(POST)|trade|sources
  core/sources.ts                  群来源就绪判定（微信密钥可开库 / 飞书 CLI + 凭据 + 登录）与引导动作（开终端提密钥、lark-cli 设备码登录）
  core/dex.ts / gmgn.ts / gmgnws.ts    DexScreener（Node 直连）/ gmgn 字段映射（经 rpc）/ gmgn 成交流 WebSocket
  core/twitter.ts / translate.ts   x.com 链接解析 + syndication 兜底 / 推文中文译文
  core/fomo.ts                     FomoService：登录态轮询（rpc）→ 关注列表 / 回灌 / WS trading_activity / 持有人 / 前排 / Thesis
  core/trade.ts / okx.ts / wallet.ts / native-price.ts / setup.ts   一键买卖（见 §5）
  core/erc20.ts                    无行情 EVM 地址的链上 ERC-20 探测（过滤非代币地址）
  core/proxy.ts                    系统代理探测 + CONNECT 隧道 Agent + requestJson；sidecar 所有 Node 出站从这走
  core/rpc.ts                      Bridge：stdout emit / stdin 指令
  wechat/                          keys 载入、SQLCipher 只读打开、分片长连接监听、地址抽取
  feishu/                          lark-cli 子进程只读 API、并发轮次监听、正文 / 链接展开
  dashboard/index.html             dashboard 单页（原生 JS）
test/                              模拟合约测试（假 Swift / 假 REST / 内存 sqlite），`pnpm test`
scripts/setup-keys.sh              一次性提取微信密钥（.app 里在 Resources/scripts/，由群组页引导卡拉终端跑）
scripts/build-app.sh               打包 dist/Fomomo.app（见 §9）
```

## 3. 微信读取

| 环节 | 谁来做 | 原因 |
|---|---|---|
| 提取数据库密钥 | Python `wcdb-key-tool`（一次性，需 sudo + lldb） | 微信 4.1+ 的密钥要用 LLDB 断点抓 passphrase，Node 干不了；工具零网络、已审计 |
| 读取 + 查询 | 纯 TS | SQLCipher 引擎（`better-sqlite3-multiple-ciphers`）按需解密直接读原库，zstd 用 `fzstd` |

- 原库**只读打开，绝不写入**；不全量解密或导出，SQLite 只在内存里按需解密。应用自己的库只存喊单原话 + 少量语境，不存全量群聊。
- 密钥在 `~/Library/Application Support/fomomo/secrets/all_keys.json`（600；数据目录 = `config.ts` 的 `DATA_DIR`，`FOMOMO_DATA_DIR` 可覆盖）。只有退登 / 换号（passphrase 变）或新增消息分片（新 salt）才需重提。
- **副本模式**：LLDB 抓 passphrase 需要去掉 Hardened Runtime（ad-hoc 重签名），而 ad-hoc 签名会让微信丢失录屏 / 截图权限（TCC 绑定代码签名）。所以 `setup:keys` 默认复制一份到 `~/WeChat-extract.app` 只签副本，提完删除；`/Applications` 原版始终是腾讯签名。`--in-place` 才重签原版（不推荐）。
- **数据库结构（微信 4.x）**：
  - `session/session.db` → `SessionTable(username, unread_count, summary, last_timestamp, …)`；群 = `username` 含 `@chatroom`。
  - `contact/contact.db` → `contact(username, nick_name, remark)`；显示名 = `remark || nick_name || username`。
  - `message/message_N.db` → 表 `Msg_<md5(username)>`：`md5(username)` 决定表名、不决定在哪个文件 → 遍历所有分片找表。字段 `local_id, local_type, create_time, real_sender_id, message_content, WCDB_CT_message_content`；`WCDB_CT_message_content == 4` → zstd；`local_type` 低 32 位 = 基础类型（1 文本 / 3 图片 / 49 链接·文件 / 10000 系统…）；发送者 `real_sender_id` 查同库 `Name2Id`，回退正文前缀 `wxid:\n`。
- **监听**（`wechat/watch.ts`）：分片打开一次复用、`(create_time, local_id)` 双键游标同秒不漏不重、每 ~1 分钟重枚举分片；地址抽取覆盖文本 + 链接 / 引用消息 XML（`wechat/extract.ts`），机器人行情卡（含「战力：」「血量：」）不算喊单。
- 表名 / 字段名来自 wechat-cli 源码与 wcdb-key-tool；版本有出入改 `wechat/reader.ts` 的 SQL 即可。图片 / 文件消息只抽链接与引用里的地址，不做富解析。

## 4. 飞书监听

- 经官方 `lark-cli` 用户身份只读群历史，不要求机器人入群；可读范围受当前账号权限约束。凭据由 CLI 管理，应用不发消息、不改授权。
- 每轮同时读取全部选中群（最多 8 路 lark-cli 进程），整轮完成后立即下一轮，没有固定间隔或排队；单群异常按群退避，限流整体暂停后继续。分页读完才推进检查点，保留重叠窗口 + 消息 ID 去重。重启时已选群回灌最近 6 小时（时间窗）；运行中新勾选的群把预热拿到的最近 100 条当回灌发出（floor 压到这批最早那条，startedAt = 勾选时刻所以都标 backfill），再从当下起监听。
- 每群先预热最近 100 条可读消息（最后消息预览 + 内存语境）；每群内存正文上限 100 条，取消监听释放，普通聊天不落库。CA 命中才把前 4 条 + 命中条 + 后 3 条存 `call_context`，后文随消息到达补齐。
- 文本 / 富文本链接 / 卡片正文复用地址抽取；图片不做 OCR。

## 5. 行情与引擎

- **新币首查** DexScreener 与 gmgn 并行（有 chainHint 直查，没有的按 `robinhood → bsc` 猜），500ms 攒批；之后 20s 一轮刷前 40 个。
- **喊单价基准**（跟单收益视角，不是市场 1h）：live 喊单（≤180s）取首次拉到的现价；回灌喊单取 gmgn 分钟蜡烛在喊单分钟的 open（±30min 一簇一请求），蜡烛没覆盖时用 gmgn 历史价桶近似并标 `≈`。
- **K 线**：市值蜡烛 `token_mcap_candles`，分辨率由弹卡按钮决定（1s…1d）；gmgn 成交流 WebSocket 只订当前焦点币，实时推最后一根。
- **无行情 EVM 地址过滤**（`erc20.ts`）：Dex / gmgn 首轮都空时，用公共 RPC 检查 ERC-20 必选接口（`balanceOf` / `totalSupply` / `allowance`），六条链均明确否定才从面板隐藏（记录仍在库里）；RPC 失败视为 unknown 不隐藏；肯定 / 否定缓存 10 分钟、unknown 60 秒；行情一到即恢复。
- **出网**：本机可能有 DNS 投毒 / 系统代理，Node 的 `fetch` / `ws` 不看系统代理，所以所有出站统一经 `proxy.ts`（env → `scutil --proxy`，CONNECT 隧道 Agent，30s 缓存）；没代理就直连。
- **fomo.family 信号**：常驻 WKWebView 持有登录态，sidecar 经 rpc 取 access token → 关注列表 / 24h 回灌 / WS trading_activity / 持有人轮询 / 前排比例 / Thesis 列。只读，不参与交易。

## 6. 一键买卖

- **报价**：买入按原生币数量计价（ETH / BNB / SOL / MON / USDC，快捷额按原生币分组），只在输入数量 / 点快捷额时问 OKX `/quote` 一次，无周期刷新、不依赖任何价格；卖出只按持仓百分比。美元估值只做显示与 USD 限额校验（`native-price.ts`：DexScreener 每 60s 拉一次原生币价缓存，USDC 恒 1 不拉，拉不到显示「—」，报价下单照常，买入执行会因无法校验限额而拒单）。
- **执行**：`/swap` 现取路由 + 未签名交易（autoSlippage ≤15%、价格影响保护 50%）→ 本地 eth_call 模拟 → burner 签名 → 公共 RPC 广播 → 等回执；EVM 上 fromToken 是 ERC-20 时先按需 approve（额度 = 本次数量）：所有卖出，以及 Arc 的买入——Arc 的 gas 币 USDC 在 OKX 只认 `0x3600…` 预编译（6 位），余额 / gas 是 18 位，两张小数表 `NATIVE_BALANCE_DECIMALS` / `NATIVE_SWAP_DECIMALS`（决策见 `adr/0015`）。
- **账本**：sqlite `trade` 表；`validating → submitting → submitted → confirmed | failed`，等回执超时 → `unknown` 由对账循环改终态，**绝不自动重发**；同地址有未落定记录时拒新意图；quoteId 消费一次。
- **限额**：单笔 / 滚动 24h 买入合计（USD），dashboard「交易」页改；卖出不计。
- **持仓**：七链原生币余额 + 账本里 confirmed 过的币（∪ 焦点币）的链上余额，60s 一轮 + 成交后 0/2/4s 补读 + 弹卡开着时焦点链 1s 一次；只跟我们自己买过的币。
- **边界**：OKX 请求统一发到 `okx.ts` 的 `OKX_API_BASE`，客户端不持有 OKX 凭据。本机唯一机密是 burner 私钥（macOS Keychain，service `fomomo.wallet`）；Keychain 只做落盘加密，任何以该用户身份运行的进程都读得到——只放准备买 meme 的小钱。

## 7. dashboard

sidecar 起的本地 HTTP（`127.0.0.1:48765`，仅本机），`src/dashboard/index.html` 单页，每次请求现读（改样式刷新即见）。

- 总览 / 群组（微信 + 飞书各自勾选草稿，「保存」一次 PUT 两个来源的改动；新加的群先回灌最近 100 条）/ 喊单人（胜率、归零率、中位峰倍）/ 代币 / 交易（钱包、余额、限额、快捷额、RPC 覆盖、持仓、最近交易）/ 24h 战况 / 复盘 / 模拟交易 / 设置（面板宽高、背景不透明度，改动即时生效）。
- **群来源引导**：群组页每个来源未就绪时在列表位置显示引导卡（两者都未就绪则并排两张），2s 轮询 `GET /api/sources`。微信卡列前置条件（微信目录 / 读微信数据的权限 / 命令行工具 / 密钥）并用 `open -a Terminal <数据目录>/setup-keys.command` 拉终端跑 `setup-keys.sh`（不走 Apple Events，免自动化授权）；飞书卡一键 `lark-cli config init --new`（stderr 里的验证 URL 直接开浏览器）→ `auth login --scope <只读三项> --no-wait --json` → `--device-code` 阻塞到授权完成。sidecar 在 dashboard 起来后推 `sources` 事件（含 `firstRun` = 没弹过且一个群都没选，发完落库）；Swift 在 `firstRun` 或 `configured=false` 时自动打开群组页，一进程只弹一次。
- **24h 战况**：窗口内（6h / 12h / 24h / 3d）每条喊单的结构与收益——累计盈亏曲线、现倍分布、按群叠色的喊单节奏、按链 / 群 / 喊单人的条数与等权盈亏、逐条明细、错过的金狗。数据只有 `GET /api/report?hours=`（`calls` × `tokens` × `samples`）一份原料，聚合全在页面里。
- **复盘**（`core/analysis.ts`，决策见 `adr/0013`）：首喊在过去 N 小时（24h / 3d / 7d / 30d）的币，按**首喊后 24h 峰倍 ≥ win**（2 / 3 / 5）分达标组 / 对照组，比较三类特征（群 / 推特 / 买入人）在两组的出现率（各自 n / 达标率 / Wilson95 / 缺失；任一组 n < 20 只报计数），外加「过程」组（首喊之后才发生的，单列不当原因）；逐币点开是事件时间线（群喊单 / 官推 / 社区推 / GMGN 喊单 / fomo 买卖 / Thesis），以拉升起点（首次观测 ≥1.5×）分「之前 / 之后」。
  - **决策截面**：引擎在 live 首喊后 30s 把内存里的行情（mc / liq / 持有人）、官推资料（粉丝 / 注册 / 蓝标 / bio 含 CA）、已抓官推 / 社区推条数、GMGN 喊单（链确认时预拉首页）、fomo 关注者信号（买入人 / 持有 / 前排比例 / Thesis，各带观测时刻）、gmgn 前排结构（链确认时预拉：pool 行数 / 前 10 钱包占供应）写一次 `token_snapshot`（`(chain, address, kind)` 键，INSERT OR IGNORE）。回灌首喊没有截面。
  - **社交事件副本** `social_event`：`tokens.official/tweets` 是覆盖式的，每次变了就把这批推文 + GMGN 喊单 append 进来（`ref` = `tw:<id>` / `gm:<ulid>`，同一推文社区 → 官方只升级 kind），时间线与「首喊后 60min 内官推发推」等过程特征从它来；群喊单 / fomo 活动仍查 `calls` / `fomo_activity`。
  - **数据质量护栏**：`samples.src`（live / candle，老行 NULL）区分实时点与蜡烛回补点；两道剔除——隐含供应量（mc ÷ price）与基准差 >3× 的点（跨行情源口径跳变），以及错币报价段（相对上一保留点一步跳 ≥20× 且 10min 内跳回来：回到原位或反向再跳 ≥20×；真库 30d 里 LUNA / HEMI / KEYCAT / NEKO 四个同名 meme 被按上市大币的价报了 1–8 个点）；窗口内实时点 < 10 → 采样不足；截面链 ≠ 当前链 → 隔离。
  - 入口只在页面：`GET /api/analysis?hours=&win=` 一次返回 `{ report, groups, markdown }`，「复制 Markdown」按钮把服务端渲染好的 markdown（群 id 已换显示名）写进剪贴板，便于贴给人 / 模型讨论。
- **模拟交易**（独立页；决策见 `adr/0014`）：策略是一段 JS——`({ entry(t) {…}, step(s) {…} })`——`POST /api/simulate { code, hours, win, tz, fee, stake }`。`core/strategy.ts` 的 `compileStrategy()` 在 `node:vm` 干净上下文里求值（无 require / process，字符串求值关掉，`Math.random` 禁用，`console.log` 收前 200 行）；`runStrategy()` 起 worker 线程（`core/sim-worker.ts`，自己开 Store 读 `analysisInput` → `analyze` → `simulate` 策略 + 基准）并 15s 超时 `terminate()`。`analysis.ts` `simulate(input, report, strategy, env, tz)`：币在**结果起点后 ≥20s 的第一个采样价**假想买入（反应延迟 + 新币首个 DexScreener 报价常滞后 gmgn 一两个数量级），`entry(t)` 返回金额 = 首个可成交采样立刻买，返回 `"watch"` = 先观察、之后在 `step` 里按走势 `s.buy()` 再买（有选择地买；到窗末没买计 `watched`）；它只看得到喊单那一刻可知的信息——入场市值 / 流动性、首喊群 / 人 / 文本、`t.card`（机器人卡片：持有人 / 成交量 / 几个群在聊 / 首 call / 侦测后倍数，`core/callcard.ts` 从 `call_context` 解析）、`t.prior`（首喊人先验 n / hit / rate）、`t.twitter`（有无链接 / 注册时刻 / `isTweet` 链接是不是一条推文 / `tweetAgeSec` 被链接推文距首喊多久 / `followers`）、`t.ageSec` / `t.openSec`（首喊距代币创建 / 迁出多久，来自 `tokens.created_at / open_at`，gmgn `full_info` 写入；2026-09-15 研究结论：归零由「创建 <3h × 已迁出 × mc≥34k」决定、拿不住由「新币 × 推特链接是别人的推文」决定）、`ENTRY_FEATURES` 里为真的特征 id（含卡片特征 `cc_*`）、截面原始字段——返回美元数定仓位；之后每个窗内采样调一次 `step(s)`，`s` 上有 `x / mc / liq / peakX / dd / held`（买入后相对买入价，买前相对首喊价）、`callX / callPeakX / callMinX / sinceCall`（始终相对首喊价）、`holding / buy() / windowLeft / remaining / fills / sold(x) / state / groups / callers / events`（到当前采样为止的群喊单 / 推文 / GMGN 喊单 / fomo 活动）、`s.token`（= `entry(t)` 收到的同一对象），`s.sell(pct, tag)` / `s.sellAll(tag)` 按当前采样价卖原始仓位的 pct。退出原因 = 策略 tag；没卖完的尾仓到窗末按现价估值（`now`；不满 24h 是 `open`；现价不可用按最后采样并标注；采样中途断了标 `gap`）。买卖每腿各扣一次 `fee`；盈亏拆已实现 / 未实现；结果带 `exBest`（去掉最好一笔）、`days[]`（按入场日、页面时区）、逐笔 `path`（盈利交易的 `[入场后秒, 倍数]` 路径，抽稀到 ≤150 点，页面画倍数曲线 + 买卖点；亏损交易为 `[]`）；基准 = 同一个 `step`、`entry` 换成全买。页面：编辑器（localStorage 记住，⌘↵ 运行）+ 模板按钮（每个是完整可跑的策略，替换前的代码可「撤回」）+ 字段说明 + console 面板 + 出错定位到行（特征 chip 曾在此页，用户嫌多，去掉；特征 id 看复盘页）；结果区有「调参段 vs 验证段」（最后 N 天按基准日历切）、退出原因、按日表、逐笔。与复盘分页的原因：复盘是读一遍的诊断，模拟是反复调参。不下真单、不进账本。

## 8. 构建与验证

```bash
pnpm typecheck && pnpm test && pnpm selftest       # TS：合约测试全部模拟，不碰真实微信库 / 网络
cd app && swift build && ./build.sh smoke && .build/debug/smoke   # Swift；build.sh 是沙盒环境的直编脚本
node test/fake-swift.mjs <node> /tmp/t.sqlite      # 假 Swift：起 cli run，打印每帧摘要（不开 GUI 验引擎，需真微信库）
```

环境变量（都有默认）：`FOMOMO_GROUP`、`FOMOMO_SINCE`（回灌起点，默认 6h）、`FOMOMO_NODE`、`FOMOMO_ROOT`、`FOMOMO_DATA_DIR`（数据目录）、`FOMOMO_DEBUG=1`（底栏「＋」模拟喊单）、`FOMOMO_LARK_CLI`、`FOMOMO_DEX_BASE`（调试：指到不可达地址模拟 DexScreener 挂）、`FOMOMO_DASHBOARD_PORT`（开发 / 验证时换端口，与已安装的 .app 并存）。

`.node-version` 钉 22.22.0：native addon（`better-sqlite3-multiple-ciphers`、`wreq-js`）的 ABI 绑在这个大版本，开发模式 Swift 按它找 node，打包时按它下载随包的 node；换 node 大版本要 `pnpm rebuild` 或同步改 `.node-version`。

## 9. 打包与发布

`scripts/build-app.sh`（本地 `pnpm build:app`；CI 见 `.github/workflows/release.yml`，tag `v*` 触发，`macos-26`）产出 `dist/Fomomo.app`：

```
Contents/MacOS/Fomomo                   swift build -c release
Contents/Resources/sidecar/cli.mjs      esbuild 把 src/cli.ts 打成单文件 ESM（native 包 external）
Contents/Resources/sidecar/dashboard/   index.html
Contents/Resources/sidecar/node_modules 只有 better-sqlite3-multiple-ciphers、wreq-js（+ 平台 binding）及其依赖，npm 装
Contents/Resources/node/bin/node        nodejs.org 官方 arm64 二进制（SHASUMS256 校验），版本 = .node-version
Contents/Resources/bin/lark-cli         @larksuite/cli 的 Go 二进制（其 postinstall 按包内 checksums 校验）
Contents/Resources/scripts/setup-keys.sh
```

- **代码目录与数据目录分离**：`config.ts` 用 `import.meta.url` 定位代码目录（开发 = `src/`，打包 = `Resources/sidecar/`，esbuild 把它内联进 cli.mjs 所以同一层），`dashboard/index.html`、`../scripts/setup-keys.sh` 按它相对定位；可写数据一律在 `DATA_DIR`。Resources 是签名封住的只读区。
- **签名**：Resources 下每个 Mach-O（node、lark-cli、两个 `.node`）单独签，node 侧 entitlement 只有 `com.apple.security.cs.allow-jit`（V8 在 Apple Silicon 走 MAP_JIT）；主程序无例外。有 Developer ID 时开 hardened runtime + 时间戳，可公证；ad-hoc 时不开 hardened runtime——library validation 要求 node 与其 dlopen 的 addon 同一 Team ID，ad-hoc 没有 Team ID 会让 addon 加载失败，而 ad-hoc 本来也无法公证。
- **TCC**：完全磁盘访问记在 Fomomo.app 上，子进程 node 归属 responsible process 一并生效；开发模式下记在启动它的终端上。
- 被否的路线：Node SEA / pkg / Bun compile——见 `docs/adr/0012-bundle-node-runtime-in-app.md`。
