import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import bs58 from "bs58";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { parseTransaction, recoverTransactionAddress, type TransactionSerialized } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PUBLIC_RPC } from "../src/core/erc20.js";
import type { EvmTx } from "../src/core/okx.js";
import { BurnerWallet, DEFAULT_RPC, MemoryStore, WALLET_SERVICE, type SolConnection } from "../src/core/wallet.js";

// 全部离线：不建真实 Connection、不发任何 RPC。关注的是会丢钱的边界：覆盖已有钱包、签错链/错 gas、Solana 换 blockhash 后签名仍有效。

// ① MemoryStore：create → load 地址一致；二次 create 拒绝覆盖；只剩一把 → null
{
  const store = new MemoryStore();
  assert.equal(await BurnerWallet.load(store), null);
  const w = await BurnerWallet.create(store);
  assert.match(w.evmAddress, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(new PublicKey(w.solAddress).toBase58(), w.solAddress);
  const again = await BurnerWallet.load(store);
  assert.ok(again !== null);
  assert.equal(again.evmAddress, w.evmAddress);
  assert.equal(again.solAddress, w.solAddress);
  await assert.rejects(BurnerWallet.create(store), /already exists/);
  await store.delete(WALLET_SERVICE, "sol");
  assert.equal(await BurnerWallet.load(store), null, "只剩 evm 一把不算有钱包");
  // 私钥不出现在对外可枚举字段里
  assert.deepEqual(Object.keys(w).sort(), ["evmAddress", "solAddress"]);
  assert.equal(JSON.stringify(w).includes(await store.get(WALLET_SERVICE, "evm") ?? "never"), false);
}

// ② signEvmOffline 确定性：固定私钥 + 固定 tx → 反解字段、1.5×gas、legacy/1559 分流、签名者是我们
{
  const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
  const store = new MemoryStore();
  await store.set(WALLET_SERVICE, "evm", PK);
  await store.set(WALLET_SERVICE, "sol", bs58.encode(Keypair.fromSeed(new Uint8Array(32).fill(7)).secretKey));
  const w = await BurnerWallet.load(store);
  assert.ok(w !== null);
  assert.equal(w.evmAddress, privateKeyToAccount(PK).address);

  const tx1559: EvmTx = { to: "0x1111111111111111111111111111111111111111", data: "0xdeadbeef", value: 12345n, gas: 200_000n, gasPrice: 30_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
  const rawA = await w.signEvmOffline("bsc", tx1559, 7);
  const rawB = await w.signEvmOffline("bsc", tx1559, 7);
  assert.equal(rawA, rawB, "同输入必须同输出");
  const p = parseTransaction(rawA);
  assert.equal(p.type, "eip1559");
  assert.equal(p.chainId, 56);
  assert.equal(p.to?.toLowerCase(), tx1559.to);
  assert.equal(p.value, 12345n);
  assert.equal(p.gas, 300_000n, "gas = 1.5×");
  assert.equal(p.nonce, 7);
  assert.equal(p.data, "0xdeadbeef");
  assert.equal(p.maxFeePerGas, 30_000_000_000n);
  assert.equal(p.maxPriorityFeePerGas, 1_000_000_000n);
  assert.equal(await recoverTransactionAddress({ serializedTransaction: rawA as TransactionSerialized }), w.evmAddress);

  const legacy: EvmTx = { ...tx1559, maxPriorityFeePerGas: null, gas: 21_001n };
  const rawL = await w.signEvmOffline("monad", legacy, 0);
  const pl = parseTransaction(rawL);
  assert.equal(pl.type, "legacy");
  assert.equal(pl.chainId, 143);
  assert.equal(pl.gasPrice, 30_000_000_000n);
  assert.equal(pl.gas, 31_501n, "整数除法向下取整");
  assert.equal(await recoverTransactionAddress({ serializedTransaction: rawL as TransactionSerialized }), w.evmAddress);

  const p4663 = parseTransaction(await w.signEvmOffline("robinhood", tx1559, 1));
  assert.equal(p4663.chainId, 4663);
}

// ③ Solana：本地构造未签名 v0 交易（给自己转 0）→ sendSol 换 blockhash、签名、发送；反序列化已发字节校验签名有效
{
  const kp = Keypair.fromSeed(new Uint8Array(32).fill(9));
  const store = new MemoryStore();
  await store.set(WALLET_SERVICE, "evm", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  await store.set(WALLET_SERVICE, "sol", bs58.encode(kp.secretKey));

  const staleHash = bs58.encode(new Uint8Array(32).fill(1));
  const freshHash = bs58.encode(new Uint8Array(32).fill(2));
  const sent: Uint8Array[] = [];
  const calls: string[] = [];
  const fake: SolConnection = {
    async getBalance() { calls.push("getBalance"); return 5; },
    async getParsedTokenAccountsByOwner() { calls.push("spl"); return { value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: "10", decimals: 6 } } } } } }, { account: { data: { parsed: { info: { tokenAmount: { amount: "32", decimals: 6 } } } } } }] }; },
    async getLatestBlockhash() { calls.push("blockhash"); return { blockhash: freshHash, lastValidBlockHeight: 100 }; },
    async sendRawTransaction(raw, opts) { calls.push("send"); assert.equal(opts.skipPreflight, false); sent.push(raw); return "sig-recorded"; },
    async confirmTransaction(strategy) { calls.push("confirm"); assert.equal(strategy.signature, "sig-recorded"); assert.equal(strategy.blockhash, freshHash); return { value: { err: null } }; },
    async getSignatureStatuses() { return { value: [{ err: null, confirmationStatus: "confirmed" }] }; },
  };
  const w = await BurnerWallet.load(store, undefined, { sol: fake });
  assert.ok(w !== null);
  assert.equal(w.solAddress, kp.publicKey.toBase58());

  const msg = new TransactionMessage({
    payerKey: kp.publicKey,
    recentBlockhash: staleHash,
    instructions: [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 0 })],
  }).compileToV0Message();
  const unsigned = new VersionedTransaction(msg);
  assert.ok(unsigned.signatures[0].every((b) => b === 0), "OKX 给的是未签名交易");

  const { signature } = await w.sendSol(bs58.encode(unsigned.serialize()));
  assert.equal(signature, "sig-recorded");
  assert.deepEqual(calls, ["blockhash", "send", "confirm"], "先取 blockhash 再发再确认");
  assert.equal(sent.length, 1);
  const onWire = VersionedTransaction.deserialize(sent[0]);
  assert.equal(onWire.message.recentBlockhash, freshHash, "过期 blockhash 必须被替换");
  assert.equal(onWire.message.staticAccountKeys[0].toBase58(), kp.publicKey.toBase58());
  assert.ok(!onWire.signatures[0].every((b) => b === 0), "签名非零");
  // VersionedTransaction 没有 verifySignatures（只有 legacy Transaction 有）：直接用 ed25519 校验 signatures[0] 对 message.serialize() 有效
  const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(kp.publicKey.toBytes()).toString("base64url") }, format: "jwk" });
  assert.equal(verify(null, onWire.message.serialize(), pub, onWire.signatures[0]), true, "换 blockhash 后签名必须对新消息有效");

  // 余额走注入的 connection
  assert.equal(await w.nativeBalance("sol"), 5n);
  assert.deepEqual(await w.splBalance(kp.publicKey.toBase58()), { amount: 42n, decimals: 6 }, "多 token account 求和，精度取自账户");

  // 确认失败 → 抛错、带 signature
  const failing: SolConnection = { ...fake, async confirmTransaction() { return { value: { err: { InstructionError: [0, "Custom"] } } }; } };
  const w2 = await BurnerWallet.load(store, undefined, { sol: failing });
  await assert.rejects(w2!.sendSol(bs58.encode(unsigned.serialize())), /sig-recorded.*InstructionError/);

  // 垃圾输入：不是任何一种交易 → 抛，不发
  const before = sent.length;
  await assert.rejects(w.sendSol(bs58.encode(new Uint8Array([1, 2, 3]))));
  assert.equal(sent.length, before);
}

// ④ 默认 RPC 与 erc20.ts 同源（不是复制）；RpcConfig 覆盖不影响 DEFAULT_RPC
{
  for (const c of PUBLIC_RPC) assert.equal(DEFAULT_RPC.evm[c.slug as keyof typeof DEFAULT_RPC.evm], c.url);
  assert.equal(Object.keys(DEFAULT_RPC.evm).length, PUBLIC_RPC.length);
  assert.equal(DEFAULT_RPC.sol, "https://api.mainnet-beta.solana.com");
}

console.log("wallet: ok");
