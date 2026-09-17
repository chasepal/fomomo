# 模拟交易的策略语言是 JavaScript，跑在 sidecar 的 worker 线程 + `node:vm` 里

「模拟交易」页此前是一排开关（分批腿 / 止盈 / 止损 / 回撤 / 时限）加一个写死的优先级。每想表达一条新规则——出本后止损抬到成本价、第二个群也喊了就卖一半、30 分钟没到 1.5× 就走、基准市值小的多下一倍——都要加一个开关和一段引擎代码。用户点名要「自定义语言」。决定：

1. **语言 = JS，不自造语法。** 策略是一段代码，以一个对象结尾：`({ entry(t) { … }, step(s) { … } })`（或只给一个函数当 `step`）。`entry(t)` 决定买不买、买多少（返回美元数；0 / null / false 不买；不返回 = 默认每单）；`step(s)` 每个 20s 采样调一次，用 `s.sell(pct, tag)` / `s.sellAll(tag)` 卖。`core/strategy.ts` 的 `compileStrategy()` 在 `vm.createContext` 的干净上下文里求值：没有 `require` / `process`，`codeGeneration.strings = false`（`eval` / `new Function` 关掉），`Math.random` 替换成抛错（策略必须确定），`console.log` 收前 200 行带回页面。**这不是安全沙箱**，防的是手滑不是攻击；页面写明只跑自己写的策略。
2. **值得花力气的是暴露给策略的状态模型，不是语法。** `s` 上：`x` / `mc` / `liq` / `peakX` / `dd` / `held` / `windowLeft` / `remaining` / `fills` / `sold(x)` / `state`（逐币私有）/ `groups` / `callers` / `events`（到当前采样为止的群喊单 / 推文 / GMGN 喊单 / fomo 活动）/ `token`。`t` 上：入场市值 / 流动性、首喊群 / 人 / 文本、`card`（群里机器人在首喊后几秒回的卡片：持有人 / 成交量 / 几个群在聊 / 是否首 call / 侦测后倍数——近 12 天 2/3 的喊单有，是决策截面之外唯一有历史深度的「喊单那一刻」结构化信息，`core/callcard.ts` 解析）、`prior`（首喊人先验 n / hit / rate）、`twitter`（有无链接 / 注册时刻）、喊单那一刻为真的特征 id（`Set`，含卡片特征 `cc_*`）、截面原始字段。第一版只给了价格路径 + 市值分档，用户指出「很多数据没用上」——补上后网格里流动性 ÷ 市值 ≥ 10% 成了最稳的入场过滤（薄池子那档整体亏），卡片的「已有 ≥2 群在聊 / 成交量 ≥ 市值」当加仓信号有效，而流动性骤降当撤池信号反而有害（AMM 里 liq 随价格走，等于又装回了止损）。**防泄漏靠 API 形状**：没有之后的采样、没有现价、没有「过程」组特征（`ENTRY_FEATURES` 过滤）、事件按 `ts ≤ 当前采样` 推进；`windowLeft` 给出的是定死的窗末时刻，不是偷看。
3. **整个模拟跑在 worker 线程里，超时 `terminate()`。** `vm` 的 `timeout` 只管定义那一次 `runInContext`，之后 host 每步回调进 `step()` 时的死循环它管不住；一个人写的策略卡住 15s，监控主线程不能陪着卡。worker（`core/sim-worker.ts`）自己开 `Store` 连接读 `analysisInput`（SQLite WAL 多读者没问题，也省得把几十 MB 采样 clone 过去）→ `analyze` → 编译 → 跑策略 + 基准（同一个 `step`、`entry` 换成全买）→ postMessage。策略出错带回 `{ phase, token, ts, line }`，页面把光标放到那一行。开发态 tsx 的 loader 钩子不传给 worker，用一段 eval 引导在 worker 里 `tsx/esm/api` `register()` 再 import；打包时 esbuild 把 worker 单独打成 `sim-worker.mjs` 与 `cli.mjs` 并排。
4. **语言越自由越容易过拟合，所以页面加时间切分。** 「验证段 = 最后 N 天」按基准日历切（策略某天一笔不买也不影响切法），调参段 / 验证段各自的 n / 净 / 收益率 / 去掉每天最好一笔 / 盈利天数并排；调参段赚、验证段不赚就标「先别信」。真库 7d：默认模板「2× 出本 · 尾仓至今」调参段 +$7,908、验证段 −$300；「挑币 + 加仓」调参段 +$15,434、验证段 +$2,866 但去掉每天最好一笔后两段都是负的。

## Considered Options

- **自造 DSL（Pine Script 式）**：parser、报错、文档、每个新信号都是改语言；做到能用要重新实现变量 / 条件 / 循环，等于一个残缺的 JS。一个人用的本地工具不值。
- **JSON / YAML 规则表**（`when x>=2 then sell 50%`）：条件一复杂就得往里塞表达式语言，「第二个群喊了」这类事件条件表达不了；开关 UI 就是它的退化版，已经证明天花板太低。
- **Lua / 别的嵌入语言**：多一个运行时，用户不比 JS 更熟。
- **在 dashboard 浏览器端跑策略**：要把整批采样发到前端（30d 是几十 MB），且离测试 / 离数据都远。策略在 sidecar 跑，页面只是编辑器。
- **主线程 `vm` + `timeout`**：`timeout` 覆盖不到后续回调；监控会被卡。worker 多一个打包入口，值。
- **保留开关 UI 作为「简单模式」**：两条执行路径两套语义要同步；改成模板按钮——每个模板是一段完整可跑的代码，点了就替换编辑器内容（替换前的代码存一份可「撤回」），模板就是文档。

## Consequences

- `simulate(input, report, strategy, env, tz)` 取代 `SimRules`；退出原因是策略自己的 tag（系统只保留 `now` / `open` 两个：尾仓没卖完，按现价估值），`SimTrade.stake` 逐笔（`entry` 可按币定仓位），`SimResult.declined` = `entry` 说不买的数。`GET /api/simulate?…` 改为 `POST /api/simulate { code, hours, win, tz, fee, stake }`。
- 页面：编辑器（`localStorage` 记住代码，⌘↵ 运行，Tab 缩进）+ 模板 + 字段说明 + `console.log` 面板 + 错误定位；结果区新增「调参段 vs 验证段」。特征 chip 一开始也放在这页（点击插入 `t.features.has("…")`），用户嫌多去掉了，`/api/simulate` 也不再回 features。
- **「达到 24h 战况峰值卖出收益的 70%」不是可行目标**（用户提出，数据否定）：峰值卖出 = 事后完美预知，30d 真库 1,133 笔含费峰值 $349k，其中 68% 在 5% 的币里；入场→峰值路上中位回撤 40%（p75 58%），所以任何追踪止损在 3/4 的 5× 币上会被中途甩下；就算每个币事后挑最优回撤参数，追踪止损这一族也只拿到峰值的 26%。可行的口径是「对所买的币的峰值 capture」（模板 D 34%）或绝对收益 + 验证段。另：战况页 30d 的峰值卖出显示 1.4e47——`store.report()` 的 `MAX(samples.mc)` 没套供应量 / 错币剔除，那个数本身不可信（ADR 0013 待议项）。
- 测试改为用 `compileStrategy` 编译代码字符串跑同一批夹具：旧规则开关的每个场景都有等价策略写法且数字不变；另测编译 / 运行错误形状、沙箱限制、worker 端到端与硬超时。
- **有选择地买（2026-09-15 加）**：用户要求「筛选和猜测，不是每个币都买」。数据说喊单那一刻的特征分不出赢家，前 15–30 分钟的走法才分得出（赢家 71% 前 15 分钟没低于 0.95×），所以入场必须能延后：`entry` 返回 `"watch"` 只观察，`step` 里 `s.buy(usd)` 按当前采样价买入（每币一次）；买前 `x / peakX / dd / held` 相对首喊价，买入那一刻重置为相对买入价；`callX / callPeakX / callMinX / sinceCall` 始终相对首喊价。`SimTrade` 多了 `callMc / waitSec / entryX`，`SimResult.watched` = 观察到窗末没买的数。真库 30d：15 分钟稳（0.95–1.5×、没低于 0.9×）再买，668 → 126 笔，尾仓归零 138 → 5，但去掉每段最好一笔都是负的——筛选避开了必死的币，避不开「一个大牛撑全局」的本质；12 天数据下没找到中位每单为正的选法。
- **t0 字段按研究结论增补（2026-09-15 加）**：12 天 1,048 币的联合模型（`research/2026-09-15-angles/CrossAngle/report.md` §5、`relations.md` §5、`social.md` §11；gitignored）说：归零由「代币创建 <3h × 已迁出 × mc≥34k」决定，拿不住由「新币 × 推特链接是别人的推文（`links.twitter` 含 `/status/`）」决定，账号注册 ≥2 年只在新币层有效。这些都是喊单那一刻可知、之前引擎却没暴露的事实，所以：gmgn `multi_token_full_info` 的 `creation_timestamp / open_timestamp(∥ migrated_timestamp)` 落到 `tokens.created_at / open_at`（`TokenState.createdAt / openAt`，拿到一次不覆盖；老币用研究快照一次性回填）；`t.ageSec = t0 − createdAt`、`t.openSec = t0 − openAt`（负数 = 首喊时还在内盘；接口首次拉取时仍在内盘则永远 null——`fullInfo` 只在链定下时拉一次）；`t.twitter` 多了 `isTweet`（链接含 `/status/`）、`tweetAgeSec`（t0 − 被链接推文的发出时刻，`tokens.official` 里按 status id 对上的那条）、`followers`（`tokens.profile`，刷新会覆盖 → 事后近似值，只当粗档位用）。`step` 里同一对象是 `s.token`（不加别名）。页面要画「盈利币的倍数曲线 + 买卖点」，`SimTrade.path` 给 `[入场后秒, 倍数]`（首点 `[0, 1]`，均匀抽稀到 ≤150 点、保留最后一点、倍数 4 位小数），只在策略那次 `simulate` 的 `pnl > 0` 交易上带（基准传 `{ path: false }`，亏损交易给 `[]`；都是为响应体积——30d 真库策略 296 笔带路径约 0.5 MB）。防泄漏原则不变：以上全部是 t0 可知信息，`ENTRY_FEATURES` 不动。
- 局限：`vm` 不是安全边界；策略只能在 20s 采样粒度上决策；每个币只能买一次（没有加仓 / 分批买）。
