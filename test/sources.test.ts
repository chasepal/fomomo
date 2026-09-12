import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 飞书登录编排（config init → auth login --no-wait → --device-code）对着一个假 lark-cli 跑：
// 验证 URL 从 stderr 抓出来并交给浏览器、设备码从 stdout JSON 拿到、失败信息透传、取消能杀掉在等的子进程。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fomomo-sources-"));
process.env.FOMOMO_DATA_DIR = path.join(dir, "data");
const state = path.join(dir, "state");
fs.mkdirSync(state);
const fake = path.join(dir, "lark-cli");
fs.writeFileSync(fake, `#!/bin/bash
S="${state}"
echo "$*" >> "$S/log"
wait_for() { for i in $(seq 1 100); do [ -e "$S/$1" ] && return 0; sleep 0.05; done; echo "timeout waiting $1" >&2; exit 1; }
case "$*" in
  "config show") [ -e "$S/app" ] && { echo '{"appId":"cli_x"}'; exit 0; } || { echo "not configured" >&2; exit 1; } ;;
  "auth status --json") [ -e "$S/token" ] && echo '{"identities":{"user":{"status":"ready","userName":"测试员"}}}' || echo '{"identities":{"user":{"status":"not_logged_in"}}}'; exit 0 ;;
  "config init --new") echo "▀▄▀▄ 扫码或打开链接" >&2; echo "  https://open.feishu.cn/app/verify?x=1" >&2; echo "等待…" >&2; wait_for app-confirm; touch "$S/app"; echo "✓ AppCreated cli_x" >&2; exit 0 ;;
  "auth login --scope "*" --no-wait --json") echo '{"verification_url":"https://accounts.feishu.cn/device?user_code=ABCD","device_code":"dev-123","expires_in":600,"hint":"..."}'; exit 0 ;;
  "auth login --device-code dev-123 --json") [ -n "$FAKE_FAIL" ] && { echo '{"event":"authorization_failed","error":"user denied"}'; exit 1; }; wait_for auth-confirm; touch "$S/token"; exit 0 ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
`, { mode: 0o755 });

// 动态导入：config.ts 在模块加载时读 FOMOMO_DATA_DIR，静态 import 会被提升到上面的赋值之前
const { Sources, FEISHU_SCOPES } = await import("../src/core/sources.js");
const opened: string[] = [];
const sources = new Sources(() => {}, {
  larkCli: () => ({ file: fake, argvPrefix: [] }),
  // 「浏览器」：看到 URL 就当用户完成了那一步
  openUrl: (u) => { opened.push(u); fs.writeFileSync(path.join(state, u.includes("/app/") ? "app-confirm" : "auth-confirm"), ""); },
});
const until = async (pred: () => Promise<boolean>, what: string) => {
  for (let i = 0; i < 100; i++) { if (await pred()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error(`timeout: ${what}`);
};
try {
  let st = await sources.status();
  assert.equal(st.feishu.ready, false);
  assert.equal(st.feishu.app, false);
  assert.equal(st.feishu.cli, fake);

  sources.startFeishuLogin();
  sources.startFeishuLogin(); // 进行中再点不重复起
  await until(async () => (await sources.status(true)).feishu.login.step === "done", "login done");
  st = await sources.status(true);
  assert.equal(st.feishu.ready, true);
  assert.equal(st.feishu.user, "测试员");
  assert.deepEqual(opened, ["https://open.feishu.cn/app/verify?x=1", "https://accounts.feishu.cn/device?user_code=ABCD"]);
  const log = fs.readFileSync(path.join(state, "log"), "utf8");
  assert.equal(log.split("\n").filter((l) => l === "config init --new").length, 1);
  assert.ok(log.includes(`auth login --scope ${FEISHU_SCOPES} --no-wait --json`), "requests only the read-only scopes");
  console.log("ok device flow: app created from stderr URL, device code from stdout JSON, single run, read-only scopes");

  // 失败：设备码轮询被拒 → step=error，原因是 lark-cli 给的那句
  fs.rmSync(path.join(state, "token"));
  process.env.FAKE_FAIL = "1";
  sources.startFeishuLogin();
  await until(async () => (await sources.status(true)).feishu.login.step === "error", "login error");
  st = await sources.status(true);
  assert.equal(st.feishu.login.error, "user denied");
  assert.equal(st.feishu.ready, false);
  delete process.env.FAKE_FAIL;
  console.log("ok failure surfaces lark-cli's own message");

  // 取消：等授权的子进程被杀，状态回 idle，之后「浏览器完成」也不会把它变成 done
  fs.rmSync(path.join(state, "auth-confirm"));
  const before = opened.length;
  const quiet = new Sources(() => {}, { larkCli: () => ({ file: fake, argvPrefix: [] }), openUrl: (u) => opened.push(u) });
  quiet.startFeishuLogin();
  await until(async () => (await quiet.status(true)).feishu.login.step === "auth" && opened.length > before, "waiting at device code");
  quiet.cancelFeishuLogin();
  assert.equal((await quiet.status(true)).feishu.login.step, "idle");
  fs.writeFileSync(path.join(state, "auth-confirm"), "");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await quiet.status(true)).feishu.login.step, "idle");
  assert.equal((await quiet.status(true)).feishu.ready, false, "killed poller must not have stored a token");
  quiet.stop();
  console.log("ok cancel kills the poller and stays idle");
} finally {
  sources.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}
