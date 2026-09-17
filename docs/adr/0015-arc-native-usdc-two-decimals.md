# Arc 的原生币是 USDC：报价 / 下单走 0x3600 ERC-20 口径（6 位、买入先授权），余额 / gas 走 18 位原生口径，估值恒 $1

Arc（Circle 的 USDC 原生 L1，chainId 5042，公共 RPC `rpc.mainnet.arc.io`，浏览器 arc-scan.io）从 2026-09-16 起进交易链矩阵，仍走 OKX 聚合器（chainIndex 5042，实测 quote / swap / approve-transaction 都通，路由 Uniswap V4）。它打破了 0006 / 0011 里「买入付原生币、原生币是 `0xeeee…`、买入不需要 approve」的隐含前提：

- **同一 USDC 余额两套口径。** 链层按 wei 记账——`eth_getBalance` / `msg.value` / gas 计价都是 **18 位**；ERC-20 预编译 `0x3600000000000000000000000000000000000000` 暴露的是 **6 位**（`decimals()` = 6）。两者差 10¹²。
- **OKX 在 Arc 上不认 `0xeeee…` / `0x0000…` 为原生币**（51001），只认 `0x3600…`。于是 arc 的「买入」在 OKX 眼里是 ERC-20 → 代币的普通 swap：`tx.value = 0`，合约 `transferFrom` 从预编译扣款，**买入前要 approve**（spender = `supported/chain` 给的 `dexTokenApproveAddress`）。

据此代码里立两张表并在每处取用写明用途：`types.ts NATIVE_BALANCE_DECIMALS`（余额 / 余额不足比较 / gas 费折算；arc 18）与 `okx.ts NATIVE_SWAP_DECIMALS`（报 OKX 的 amount / toTokenAmount / approveAmount；arc 6）。`ensureAllowance` 的触发条件从「sell」改为「EVM 上 fromToken 不是 `0xeeee…`」，自然覆盖 arc 买入；approve 额度仍 = 本次数量（与卖出口径一致，不给大额度）。USDC 的美元价恒 1、不发请求（`native-price.ts`），限额 / 账本估值天然准确。

## Considered Options

- **直接调 Uniswap V4 Universal Router，绕开 OKX**：要自己做路径寻优 / 报价 / 滑点 / 蜜罐税率检测，等于重写 okx.ts 且失去多 DEX 聚合；OKX 既然支持，没有理由。
- **一张小数表 + arc 特判**：`NATIVE_DECIMALS[chain]` 到处都是，哪一处该 18 哪一处该 6 靠读者记；两张按用途命名的表把「这个 raw 是给谁看的」写进类型名。
- **arc 上 approve 一次给大额度，省掉每次买入多一笔**：与「额度 = 本次数量」的既定口径冲突，且热钱包留着对 OKX 授权合约的无限额度是多余暴露面；每笔多 ~0.5s（Arc 出块 ~0.5s、即时终局）可接受。
- **余额改读 0x3600 `balanceOf`（6 位）以统一口径**：gas 与 `msg.value` 仍是 18 位，统一不了，反而让「余额够不够付 gas」失真；余额坚持 `eth_getBalance`。

## Consequences

- arc 买入 = approve + swap 两笔上链，授权阶段 detail 写明「arc 上 USDC 是 ERC-20 口径，买入先授权…」；approve 失败 = 「余额里有 USDC 但买不了」，走既有 failed 路径。
- 快捷额新增 `USDC: [5, 25, 50, 250]`（就是美元），老设置缺这一组由 `store.ts mergePresets` 补默认。
- `erc20.ts` 探测扩到六链（arc 公共节点 `eth_getTransactionReceipt` 对未知 hash 返回 null，对账可用）；fomo.family 不支持 arc，弹卡 fomo 栏对 arc 币一直是「fomo 不支持该链」。
- 任何新增取用原生币 raw 的代码必须先回答「这是余额口径还是 OKX 口径」；`trade.test.ts ⑪` 用 50 USDC vs 20 USDC 余额钉住了混用即误判的那一格。
