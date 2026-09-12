/**
 * 自检：不依赖真实微信数据。
 * 1) SQLCipher4 + raw key 加密→只读重开→查询，错误 key 被拒（验证读取管线）
 * 2) 加密后文件头不是明文 SQLite（确认真的加密、只读打开不落明文）
 * 3) fzstd 能解 zstd（message_content ct==4 用）
 */
import crypto from "node:crypto";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { decompress as fzstdDecompress } from "fzstd";

function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fomomo-selftest-"));
  const f = path.join(dir, "enc.db");
  const rawKey = crypto.randomBytes(32).toString("hex"); // 32B raw key，同 WeChat enc_key

  // ---- 写入加密库 ----
  const w = new Database(f);
  w.pragma("cipher='sqlcipher'");
  w.pragma("legacy=4");
  w.pragma(`key="x'${rawKey}'"`);
  w.exec("CREATE TABLE Msg_x(local_id, create_time, message_content)");
  w.prepare("INSERT INTO Msg_x VALUES (1, 1700000000, ?)").run("你好 群消息");
  w.close();

  // ---- 测试2：文件确实加密 ----
  const hdr = fs.readFileSync(f).subarray(0, 16).toString("latin1");
  assert.ok(!hdr.startsWith("SQLite format 3"), "文件应为加密态（头 16 字节是 salt）");
  console.log("✓ 测试1: 文件确认已加密（非明文 SQLite 头）");

  // ---- 测试1：正确 key 只读读取 ----
  const r = new Database(f, { readonly: true, fileMustExist: true });
  r.pragma("cipher='sqlcipher'");
  r.pragma("legacy=4");
  r.pragma(`key="x'${rawKey}'"`);
  r.pragma("query_only=ON");
  const row = r.prepare("SELECT message_content m FROM Msg_x WHERE local_id=1").get() as {
    m: string;
  };
  assert.strictEqual(row.m, "你好 群消息");
  r.close();
  console.log("✓ 测试2: SQLCipher4 raw key 只读读取 通过");

  // ---- 错误 key 应失败 ----
  let rejected = false;
  try {
    const b = new Database(f, { readonly: true });
    b.pragma("cipher='sqlcipher'");
    b.pragma("legacy=4");
    b.pragma(`key="x'${crypto.randomBytes(32).toString("hex")}'"`);
    b.prepare("SELECT * FROM Msg_x").get();
    b.close();
  } catch {
    rejected = true;
  }
  assert.ok(rejected, "错误 key 应被拒绝");
  console.log("✓ 测试3: 错误 key 被拒绝 通过");

  // ---- 测试4：fzstd ----
  const frame = Buffer.from(
    "28b52ffd045861000068656c6c6f20776563686174132c136c",
    "hex",
  );
  const out = Buffer.from(fzstdDecompress(new Uint8Array(frame))).toString("utf-8");
  assert.strictEqual(out, "hello wechat");
  console.log("✓ 测试4: fzstd zstd 解压 通过");

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("\n全部自检通过 ✅");
}

run();
