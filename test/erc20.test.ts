/**
 * ERC20 三态探测契约（本地假 RPC，无外网）：EOA 六链全否定才是 non-erc20、全 0 的合法字也是 erc20、NFT（没 allowance）挡在门外、
 * 任何一条链拿不到（HTTP/限流/泛 -32000/信封不对/chainId 不符）都只能是 unknown、hint 先探但不权威、不支持的 hint 直接 unknown 不发请求、
 * decimals/name/symbol 从不查询。运行：node --import tsx test/erc20.test.ts
 */
import assert from "node:assert/strict";
import http from "node:http";
import { Erc20 } from "../src/core/erc20.js";

const TOKEN = "0x37b79b4b0b53dba9a261a347b1ef3741fa1d3e54";
const CHAIN_IDS: Record<string, number> = { eth: 1, bsc: 56, base: 8453, monad: 143, robinhood: 4663, arc: 5042 };
const SEL_BALANCE_OF = "0x70a08231";
const SEL_TOTAL_SUPPLY = "0x18160ddd";
const SEL_ALLOWANCE = "0xdd62ed3e";
const word = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
const CODE = "0x6080604052";

interface Seen {
  chain: string;
  body: { jsonrpc: string; id: unknown; method: string; params: unknown[] };
}
type Reply = { status?: number; body: unknown };
const seen: Seen[] = [];
/** 每个请求按 (chain, method, selector) 决定响应；测试逐段替换。返回 undefined = 用 ok(...) 的默认 */
let respond: (s: Seen, ctx: { selector: string | null; ok: (result: unknown) => Reply; err: (code: number, message: string) => Reply }) => Reply;

const server = http.createServer((req, res) => {
  let buf = "";
  req.on("data", (c) => (buf += c));
  req.on("end", () => {
    const s: Seen = { chain: (req.url ?? "").split("/").pop() ?? "", body: JSON.parse(buf) };
    seen.push(s);
    const ok = (result: unknown): Reply => ({ body: { jsonrpc: "2.0", id: s.body.id, result } });
    const err = (code: number, message: string): Reply => ({ body: { jsonrpc: "2.0", id: s.body.id, error: { code, message } } });
    const r = respond(s, { selector: selector(s), ok, err });
    res.writeHead(r.status ?? 200, { "Content-Type": "application/json" });
    res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
  });
});
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
const addr = server.address();
if (addr === null || typeof addr === "string") throw new Error("listen failed");
const rpcBase = `http://127.0.0.1:${addr.port}`;

/** eth_call 第一个参数 `{to, data}`；不是这形状就直接失败（这本身就是被测线上形状） */
function evmCall(s: Seen): { to: string; data: string } {
  const p = s.body.params[0];
  if (p === null || typeof p !== "object" || !("to" in p) || !("data" in p) || typeof p.to !== "string" || typeof p.data !== "string") throw new Error(`eth_call params[0] malformed: ${JSON.stringify(p)}`);
  return { to: p.to, data: p.data };
}
const selector = (s: Seen) => (s.body.method === "eth_call" ? evmCall(s).data.slice(0, 10) : null);
const check = (hint: string | null = null) => Erc20.check(TOKEN, hint, rpcBase);
/** 「标准 ERC20，全 0」：chainId 正确、有代码、三问都回一个合法字；不认识的 selector 一律 revert（decimals/name/symbol 不存在也无妨） */
const erc20Chain: typeof respond = (s, { selector, ok, err }) => {
  if (s.body.method === "eth_chainId") return ok("0x" + CHAIN_IDS[s.chain].toString(16));
  if (s.body.method === "eth_getCode") return ok(CODE);
  if (selector === SEL_BALANCE_OF || selector === SEL_TOTAL_SUPPLY || selector === SEL_ALLOWANCE) return ok(word(0n));
  return err(3, "execution reverted");
};
/** EOA：chainId 正确、代码 `0x`；居然还来 eth_call 就是 bug */
const eoaChain: typeof respond = (s, { ok }) => {
  if (s.body.method === "eth_chainId") return ok("0x" + CHAIN_IDS[s.chain].toString(16));
  if (s.body.method === "eth_getCode") return ok("0x");
  throw new Error(`unexpected ${s.body.method} against an EOA`);
};
/** 把某几条链换成别的响应，其余走 base */
const mix = (base: typeof respond, per: Record<string, typeof respond>): typeof respond => (s, ctx) => (per[s.chain] ?? base)(s, ctx);
const chainsProbed = () => [...new Set(seen.map((s) => s.chain))];

try {
  // ---- EOA：六链全否定 → non-erc20；getCode 先行，EOA 不发 eth_call；hint 先探 ----
  respond = eoaChain;
  assert.equal(await check("bsc"), "non-erc20");
  assert.deepEqual(chainsProbed(), ["bsc", "eth", "base", "monad", "robinhood", "arc"], "hint first, then every other supported chain");
  assert.equal(seen.filter((s) => s.body.method === "eth_getCode").length, 6);
  assert.equal(seen.filter((s) => s.body.method === "eth_call").length, 0, "EOA skips eth_call");

  // ---- 合法的全 0 ERC20（刚部署的空币）：hint 命中即停，不再问其它链 ----
  seen.length = 0;
  respond = erc20Chain;
  assert.equal(await check("base"), "erc20");
  assert.deepEqual(chainsProbed(), ["base"], "positive on the hinted chain stops the scan");
  const calls = seen.filter((s) => s.body.method === "eth_call");
  assert.deepEqual(calls.map(selector).sort(), [SEL_TOTAL_SUPPLY, SEL_BALANCE_OF, SEL_ALLOWANCE].sort(), "exactly balanceOf/totalSupply/allowance, no decimals/name/symbol");
  for (const c of calls) {
    assert.equal(evmCall(c).to, TOKEN);
    assert.equal(c.body.params[1], "latest");
  }
  const balanceOf = calls.find((c) => selector(c) === SEL_BALANCE_OF)!;
  const owner = evmCall(balanceOf).data.slice(10);
  assert.equal(owner.length, 64, "owner padded to 32 bytes");
  assert.notEqual(BigInt("0x" + owner), 0n, "dummy owner is nonzero (tokens may revert on address(0))");
  const allowance = calls.find((c) => selector(c) === SEL_ALLOWANCE)!;
  assert.equal(evmCall(allowance).data.length, 10 + 128, "allowance(owner, spender)");
  assert.equal(evmCall(allowance).data.slice(10, 74), owner, "same owner in allowance");
  assert.notEqual(BigInt("0x" + evmCall(allowance).data.slice(74)), 0n, "dummy spender is nonzero");

  // ---- 无 hint：扫全部，靠后的链才是 ERC20 → erc20（命中即停，排在后面的 arc 不再问） ----
  seen.length = 0;
  respond = mix(eoaChain, { robinhood: erc20Chain });
  assert.equal(await check(null), "erc20");
  assert.deepEqual(chainsProbed(), ["eth", "bsc", "base", "monad", "robinhood"]);

  // ---- hint 不权威：hint 链是 EOA，别的链是 ERC20 → erc20 ----
  seen.length = 0;
  respond = mix(eoaChain, { eth: erc20Chain });
  assert.equal(await check("bsc"), "erc20", "hint is a priority, not the authority");
  assert.deepEqual(chainsProbed(), ["bsc", "eth"], "stops at the first positive");

  // ---- NFT：balanceOf/totalSupply 都有，allowance revert → 该链确定否定；五链皆然 → non-erc20 ----
  const nftChain = (allowanceReply: "code3" | "message" | "empty" | "short"): typeof respond => (s, ctx) => {
    if (ctx.selector !== SEL_ALLOWANCE) return erc20Chain(s, ctx);
    if (allowanceReply === "code3") return ctx.err(3, "execution reverted");
    if (allowanceReply === "message") return ctx.err(-32000, "execution reverted");
    if (allowanceReply === "empty") return ctx.ok("0x");
    return ctx.ok("0x0001");
  };
  respond = nftChain("code3");
  assert.equal(await check("eth"), "non-erc20", "ERC721 with balanceOf+totalSupply but no allowance");
  respond = nftChain("message");
  assert.equal(await check("eth"), "non-erc20", "-32000 with an explicit revert message is a revert");
  respond = nftChain("empty");
  assert.equal(await check("eth"), "non-erc20", "`0x` from a contract is a definite interface mismatch");
  respond = nftChain("short");
  assert.equal(await check("eth"), "non-erc20", "valid hex of the wrong ABI length is a definite interface mismatch");

  // ---- 合约但一切都 revert（普通合约 / 代理钱包）→ non-erc20 ----
  respond = (s, { ok, err }) => {
    if (s.body.method === "eth_chainId") return ok("0x" + CHAIN_IDS[s.chain].toString(16));
    if (s.body.method === "eth_getCode") return ok(CODE);
    return err(3, "execution reverted");
  };
  assert.equal(await check("monad"), "non-erc20");

  // ---- 局部故障只能是 unknown：五链 EOA + 一链拿不到 ----
  const down: Record<string, typeof respond> = {
    "HTTP 502": () => ({ status: 502, body: { jsonrpc: "2.0", id: 1, result: "0x" } }),
    "HTTP 429": () => ({ status: 429, body: "rate limited" }),
    "200 non-JSON": () => ({ body: "<html>challenge</html>" }),
    "rate limit -32005": (s, { err }) => err(-32005, "rate limit exceeded"),
    "generic -32000": (s, { err }) => err(-32000, "header not found"),
    "internal -32603": (s, { err }) => err(-32603, "internal error"),
    "id mismatch": (s) => ({ body: { jsonrpc: "2.0", id: 999, result: "0x" } }),
    "missing jsonrpc": (s) => ({ body: { id: s.body.id, result: "0x" } }),
    "result and error": (s) => ({ body: { jsonrpc: "2.0", id: s.body.id, result: "0x", error: { code: 3, message: "x" } } }),
    "no result no error": (s) => ({ body: { jsonrpc: "2.0", id: s.body.id } }),
    "non-string getCode": (s, { ok }) => (s.body.method === "eth_getCode" ? ok(12) : ok("0x1")),
    "non-hex getCode": (s, { ok }) => (s.body.method === "eth_getCode" ? ok("zz") : ok("0x1")),
    "odd-length getCode": (s, { ok }) => (s.body.method === "eth_getCode" ? ok("0x123") : ok("0x1")),
  };
  for (const [name, bad] of Object.entries(down)) {
    respond = mix(eoaChain, { eth: bad });
    assert.equal(await check("bsc"), "unknown", `eth ${name} => unknown, never non-erc20`);
  }

  // ---- 合约上三问之一拿不到（其余合法）→ unknown，不是 erc20 也不是 non-erc20 ----
  respond = mix(eoaChain, {
    base: (s, ctx) => (ctx.selector === SEL_ALLOWANCE ? ctx.err(-32005, "rate limit exceeded") : erc20Chain(s, ctx)),
  });
  assert.equal(await check("base"), "unknown", "allowance unavailable: neither confirmed nor refuted");
  respond = mix(eoaChain, {
    base: (s, ctx) => (ctx.selector === SEL_TOTAL_SUPPLY ? ctx.ok(42) : erc20Chain(s, ctx)),
  });
  assert.equal(await check("base"), "unknown", "non-hex eth_call result is an envelope problem, not a mismatch");
  for (const error of [
    { code: -32000, message: "revert data unavailable: upstream timeout" },
    { code: 3 },
    { message: "execution reverted" },
  ]) {
    respond = mix(eoaChain, {
      base: (s, ctx) => ctx.selector === SEL_ALLOWANCE
        ? { body: { jsonrpc: "2.0", id: s.body.id, error } }
        : erc20Chain(s, ctx),
    });
    assert.equal(await check("base"), "unknown", "infrastructure wording or malformed error must not hide a token");
  }
  // 拿不到 + 确定否定同时出现：否定优先（这条链已经证明不是 ERC20）
  respond = mix(eoaChain, {
    base: (s, ctx) => (ctx.selector === SEL_TOTAL_SUPPLY ? ctx.err(-32005, "rate limit") : ctx.selector === SEL_ALLOWANCE ? ctx.err(3, "execution reverted") : erc20Chain(s, ctx)),
  });
  assert.equal(await check("base"), "non-erc20", "a definite revert on the chain outweighs an unavailable sibling call");

  // ---- chainId 不符（错路由的节点）：该链的否定不可信 → unknown ----
  respond = mix(eoaChain, { eth: (s, ctx) => (s.body.method === "eth_chainId" ? ctx.ok("0x38") : eoaChain(s, ctx)) });
  assert.equal(await check("bsc"), "unknown", "misrouted RPC cannot contribute a negative");
  respond = mix(eoaChain, { eth: (s, ctx) => (s.body.method === "eth_chainId" ? ctx.ok("1") : eoaChain(s, ctx)) });
  assert.equal(await check("bsc"), "unknown", "non-hex chainId is unavailable");
  seen.length = 0;
  respond = mix(eoaChain, { eth: (s, ctx) => (s.body.method === "eth_chainId" ? ctx.ok("0x38") : erc20Chain(s, ctx)) });
  assert.equal(await check("eth"), "unknown", "mismatched chainId never yields a positive either");
  assert.equal(seen.filter((s) => s.chain === "eth" && s.body.method === "eth_call").length, 0, "no eth_call once chainId is rejected");

  // ---- 不支持的 hint / 非 EVM 地址：unknown 且不发任何请求 ----
  seen.length = 0;
  respond = eoaChain;
  assert.equal(await check("sol"), "unknown", "non-EVM hint");
  assert.equal(await check("arbitrum"), "unknown", "unconfigured EVM chain: do not pretend it was checked");
  assert.equal(await Erc20.check("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", null, rpcBase), "unknown", "base58 mint");
  assert.equal(await Erc20.check("0x1234", "eth", rpcBase), "unknown", "short hex");
  assert.equal(seen.length, 0, "no RPC traffic for unsupported inputs");

  console.log("erc20: ok");
} finally {
  server.close();
}
