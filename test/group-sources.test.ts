import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { Store } from "../src/core/store.js";
import { DEFAULT_SETTINGS, type Mention } from "../src/core/types.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fomomo-group-sources-"));
const file = path.join(dir, "store.sqlite");
const address = "0x0000000000000000000000000000000000000042";
const wx = "10000000001@chatroom";
const feishu = "feishu:oc_source_test";
const legacy = new Database(file);
legacy.exec(`
  CREATE TABLE calls(id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL, sender TEXT NOT NULL,
    ts REAL NOT NULL, text TEXT, grp TEXT, price REAL, mc REAL, approx INTEGER NOT NULL DEFAULT 0,
    UNIQUE(address, sender, ts));
  CREATE INDEX calls_sender ON calls(sender);
  CREATE TABLE call_context(address TEXT NOT NULL, sender TEXT NOT NULL, ts REAL NOT NULL, grp TEXT NOT NULL,
    lines TEXT NOT NULL, call INTEGER NOT NULL, after INTEGER NOT NULL, at REAL NOT NULL,
    PRIMARY KEY(address, sender, ts));
  CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
legacy.prepare("INSERT INTO calls(address,sender,ts,text,price,mc) VALUES(?,?,?,?,?,?)").run(address, "同名用户", 100.125, "旧喊单", 1, 100);
legacy.prepare("INSERT INTO call_context VALUES(?,?,?,?,?,?,?,?)").run(address, "同名用户", 100.125, wx, JSON.stringify([{ time: 100.125, sender: "同名用户", text: "微信原文" }]), 0, 0, 101);
legacy.prepare("INSERT INTO settings VALUES('settings',?)").run(JSON.stringify({ groups: [wx], sinceHours: 3, panel: { width: 400, height: 600, backgroundOpacity: 0.8 } }));
legacy.close();
let store = new Store(file);
try {
  assert.deepEqual(store.getSettings().groups, [wx]);
  const mention: Mention = { sender: "同名用户", time: 100.125, text: "飞书原文", group: feishu, approx: false, price: 2, mc: 200 };
  store.insertCall(address, mention);
  store.insertCall(address, mention);
  store.updateCallPrice(address, { ...mention, price: 3, mc: 300 });
  const calls = store.db.prepare("SELECT grp, price, mc FROM calls ORDER BY id").all();
  assert.deepEqual(calls, [{ grp: wx, price: 1, mc: 100 }, { grp: feishu, price: 3, mc: 300 }]);
  store.saveContext({ address, sender: mention.sender, ts: mention.time, grp: feishu, lines: [{ time: mention.time, sender: mention.sender, text: mention.text }], call: 0, after: 0, at: 101 });
  assert.deepEqual(store.loadContexts().map((c) => [c.grp, c.lines[0].text]), [[wx, "微信原文"], [feishu, "飞书原文"]]);
  console.log("ok legacy migration retains history; cross-source same-name/same-time calls and context remain distinct");

  store.setSettings({ ...store.getSettings(), groups: [], feishuGroups: ["oc_source_test"] });
  store.db.close();
  store = new Store(file);
  // 旧库没有 trade 段：重启后按默认补齐；已删的 sinceHours 不再冒出来，其余原样
  assert.deepEqual(store.getSettings(), { groups: [], feishuGroups: ["oc_source_test"], panel: { width: 400, height: 600, backgroundOpacity: 0.8 }, trade: DEFAULT_SETTINGS.trade });
  assert.equal(store.loadContexts().length, 2);
  assert.deepEqual(store.db.prepare("SELECT grp, price, mc FROM calls ORDER BY id").all(), calls);
  const settings = store.getSettings();
  settings.feishuGroups.length = 0;
  assert.deepEqual(store.getSettings().feishuGroups, ["oc_source_test"]);
  store.setSettings({ ...store.getSettings(), feishuGroups: [] });
  assert.deepEqual(store.getSettings().groups, []);
  assert.deepEqual(store.getSettings().feishuGroups, []);
  console.log("ok independent selections persist through restart; disabling the final group stays disabled");
} finally {
  store.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
