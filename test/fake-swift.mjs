// 模拟 Swift 端：起 `cli run`，对 gmgn rpc 一律回"不可用"（只验证 DexScreener/落盘/快照路径），打印每帧摘要。
// 用法：node test/fake-swift.mjs <node路径> <sqlite路径>
import { spawn } from "node:child_process";
import readline from "node:readline";
const node = process.argv[2];
const db = process.argv[3];
const p = spawn(node, ["--import", "tsx", "src/cli.ts", "run", "--group", "10000000001@chatroom", "--since", "2h", "--db", db], { cwd: process.cwd() });
const rl = readline.createInterface({ input: p.stdout });
let states = 0;
rl.on("line", (l) => {
  const e = JSON.parse(l);
  if (e.t === "rpc") {
    p.stdin.write(JSON.stringify({ t: "rpc_result", id: e.id, ok: false, error: "fake: gmgn unavailable" }) + "\n");
    return;
  }
  if (e.t === "state") {
    states++;
    const t = e.tokens;
    const resolved = t.filter((x) => x.market?.symbol).length;
    const withChange = t.filter((x) => x.change !== null).length;
    console.log(`state#${states} tokens=${t.length} resolved=${resolved} withChange=${withChange} live=${t.filter((x) => x.live).length}`);
    if (states === 6) {
      const s = t.find((x) => x.market?.symbol) ?? t[0];
      console.log("sample view:", JSON.stringify({ ...s, mentions: s.mentions.slice(0, 2), spark: s.spark.length }, null, 0).slice(0, 700));
    }
    return;
  }
  console.log("event", JSON.stringify(e).slice(0, 160));
});
p.stderr.on("data", (d) => process.stderr.write(String(d).split("\n").filter((x) => !x.startsWith("[msg]")).join("\n")));
setTimeout(() => { p.kill("SIGTERM"); }, 25000);
p.on("exit", (c) => { console.log("exit", c); process.exit(0); });
