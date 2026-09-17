import assert from "node:assert/strict";
import { mock } from "node:test";
import { Dex } from "../src/core/dex.js";
import { Erc20, type Erc20Verdict } from "../src/core/erc20.js";
import { ERC20_TTL, Engine } from "../src/core/engine.js";
import { Store } from "../src/core/store.js";
import type { GmgnFetchParams, Market, OutEvent } from "../src/core/types.js";

// Real ingest → market lookup → ERC20 fallback → state/dashboard pipeline; only the network boundaries (gmgn rpc, DexScreener, JSON-RPC probe) are fake.
const clock = 1_780_000_020;
mock.timers.enable({ apis: ["setTimeout", "Date"], now: clock * 1000 });
async function until(check: () => boolean, why: string): Promise<void> {
  for (let turn = 0; turn < 200 && !check(); turn++) {
    await Promise.resolve();
    mock.timers.tick(200);
  }
  assert.ok(check(), why);
}
/** Drain microtasks only (no clock movement) */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const REAL = addr(0xa1);
const JUNK = addr(0xb2);
const FLAKY = addr(0xc3);
const SOL = "so11111111111111111111111111111111111111112"; // ingest lowercases everything it extracts
const HINTED = addr(0x99);
const POPUP = addr(0x77);
const RACE = addr(0xd4);
const STORED = addr(0xe5);
const LATE = addr(0xf6);
const GROUP = "test@chatroom";

class FixtureBridge {
  events: OutEvent[] = [];
  unexpected: string[] = [];
  /** gmgn 认得的地址（小写）→ 带价行情 */
  known = new Set<string>();
  emit(event: OutEvent): void { this.events.push(event); }
  async rpc(): Promise<null> { return null; }
  async gmgnFetch(params: GmgnFetchParams) {
    const url = new URL(params.path, "https://fixture.invalid");
    const body = params.body as { chain: string; addresses: string[] } | undefined;
    const ok = (data: unknown) => ({ status: 200, body: JSON.stringify({ code: 0, data }) });
    if (url.pathname === "/api/v1/mutil_window_token_info") {
      return ok(body!.addresses.filter((a) => this.known.has(a.toLowerCase())).map((address) => ({ address, symbol: "REAL", name: "real token", total_supply: "100", price: { price: "10" }, liquidity: "500", holder_count: 12 })));
    }
    if (url.pathname === "/mrwapi/v1/multi_token_full_info") return ok([]);
    if (url.pathname === "/vas/api/v1/twitter/token/search") return ok([]);
    if (url.pathname.includes("/token_candles/") || url.pathname.includes("/token_mcap_candles/")) return ok({ list: [] });
    // live 首喊的新币链一确认，引擎为复盘决策截面预拉前排 + GMGN 喊单首页（analysis.ts）；这里给空页
    if (url.pathname.startsWith("/vas/api/v1/token_holders/")) return ok({ list: [], next: null });
    if (url.pathname.includes("/community/messages")) return ok({ messages: [], has_more: false, next_cursor: null });
    this.unexpected.push(params.path);
    throw new Error(`Unexpected fixture request: ${params.path}`);
  }
  states() { return this.events.filter((e): e is Extract<OutEvent, { t: "state" }> => e.t === "state"); }
  of<K extends OutEvent["t"]>(t: K) { return this.events.filter((e): e is Extract<OutEvent, { t: K }> => e.t === t); }
  lastState() { return this.states().at(-1)!.tokens.map((v) => v.address); }
}

// DexScreener: never reachable in this fixture (the ERC20 fallback only matters when both sources miss)
Dex.lookup = async () => null;
Dex.batch = async () => new Map<string, Market>();

// ERC20 probe: scripted verdicts; a Promise lets a test hold a probe in flight
const verdicts = new Map<string, Erc20Verdict | Promise<Erc20Verdict>>();
const checks: string[] = [];
let inflight = 0;
let peakInflight = 0;
Erc20.check = async (address) => {
  checks.push(address);
  inflight++;
  peakInflight = Math.max(peakInflight, inflight);
  try {
    const v = verdicts.get(address);
    assert.ok(v !== undefined, `unscripted ERC20 probe for ${address}`);
    return await v;
  } finally {
    inflight--;
  }
};

const store = new Store(":memory:");
const row = (a: string) => store.db.prepare("SELECT erc20_check FROM tokens WHERE address=?").get(a) as { erc20_check: string | null } | undefined;
const count = (sql: string, ...args: unknown[]) => {
  const r = store.db.prepare(sql).get(...args) as { n: number }; // every caller selects `COUNT(*) AS n`
  return r.n;
};
const mention = (address: string, time = clock) => ({ sender: "kol", time, text: address, group: GROUP, approx: false });

const bridge = new FixtureBridge();
const engine = new Engine(store, bridge as never);
const shout = (addrs: string[], chainHint: string | null, backfill = false, time = clock) => engine.ingest({ t: "msg", time, sender: "kol", text: addrs.join(" "), addrs, chainHint, backfill, group: GROUP });

try {
  // ---- 1. metadata success bypasses the probe; definite negative hides from views + state; unknown stays; non-EVM never probed ----
  bridge.known.add(REAL);
  verdicts.set(JUNK, "non-erc20");
  verdicts.set(FLAKY, "unknown");
  shout([REAL, JUNK, FLAKY], "bsc");
  shout([SOL], "sol");
  await until(() => bridge.of("token_hidden").length === 1, "definite non-ERC20 must produce exactly one token_hidden");
  assert.deepEqual(bridge.of("new_token").map((e) => e.address).sort(), [REAL, JUNK, FLAKY, SOL].sort(), "new_token fired before the lookup for every live shout");
  assert.ok(!checks.includes(REAL), "gmgn-resolved token must not be probed");
  assert.ok(!checks.includes(SOL), "non-EVM address must not be probed");
  assert.equal(checks.filter((a) => a === JUNK).length, 1);
  assert.deepEqual(engine.views().map((v) => v.address).sort(), [REAL, FLAKY, SOL].sort(), "dashboard views drop only the confirmed non-token");
  assert.deepEqual([...bridge.lastState()].sort(), [REAL, FLAKY, SOL].sort(), "Swift state drops the same token");
  const hiddenIdx = bridge.events.findIndex((e) => e.t === "token_hidden");
  const stateBefore = bridge.events.slice(0, hiddenIdx).findLast((e) => e.t === "state") as Extract<OutEvent, { t: "state" }>;
  assert.ok(!stateBefore.tokens.some((v) => v.address === JUNK), "token_hidden must follow a state that no longer lists the token");
  assert.equal(bridge.of("token_hidden")[0].address, JUNK);
  assert.equal(engine.views().find((v) => v.address === REAL)?.market?.price, 10);
  assert.equal(JSON.parse(row(JUNK)!.erc20_check!).verdict, "non-erc20", "verdict persisted");
  assert.equal(JSON.parse(row(FLAKY)!.erc20_check!).verdict, "unknown");
  assert.equal(count("SELECT COUNT(*) AS n FROM calls WHERE address=?", JUNK), 1, "hidden token keeps its call record");

  // ---- 2. fresh verdicts are not re-probed; unknown is retried after 60s while the definite one stays cached ----
  const before = checks.length;
  await engine.refreshAll();
  await settle();
  assert.equal(checks.length, before, "fresh verdicts must not be re-probed on the next refresh");
  mock.timers.tick(61_000);
  await engine.refreshAll();
  await until(() => checks.slice(before).includes(FLAKY), "unknown verdict must be re-probed after 60s");
  assert.ok(!checks.slice(before).includes(JUNK), "definite verdict still cached at 61s");

  // ---- 3. another refresh cannot probe a new address while its original Dex lookup is still pending ----
  const marketGate = Promise.withResolvers<null>();
  Dex.lookup = async (a) => a === POPUP ? marketGate.promise : null;
  verdicts.set(POPUP, "non-erc20");
  shout([POPUP], "bsc");
  mock.timers.tick(500);
  await settle();
  await engine.refreshAll();
  await settle();
  assert.ok(!checks.includes(POPUP), "wait for the initial market sources before deciding an address is not a token");
  assert.ok(bridge.lastState().includes(POPUP));
  marketGate.resolve(null);
  await until(() => bridge.of("token_hidden").some((e) => e.address === POPUP), "after market lookup misses, the fallback may hide it");
  Dex.lookup = async () => null;

  // ---- 4. late market wins over an in-flight negative; a later market also un-hides and clears the persisted verdict ----
  const gate = Promise.withResolvers<Erc20Verdict>();
  verdicts.set(RACE, gate.promise);
  shout([RACE], "bsc");
  await until(() => checks.includes(RACE), "unresolved token must be probed after the first lookup");
  engine.apply(RACE, { chain: "bsc", symbol: "RACE", price: 1, source: "dex", updatedAt: clock });
  gate.resolve("non-erc20");
  await settle();
  mock.timers.tick(150);
  assert.ok(bridge.lastState().includes(RACE), "market that arrived during the probe is authoritative");
  assert.equal(row(RACE)!.erc20_check, null, "stale negative must not be persisted");
  assert.ok(!bridge.of("token_hidden").some((e) => e.address === RACE));

  const hiddenBefore = bridge.of("token_hidden").length;
  engine.apply(JUNK, { chain: "bsc", symbol: "JUNK", price: 2, source: "dex", updatedAt: clock });
  mock.timers.tick(150);
  assert.ok(bridge.lastState().includes(JUNK), "market discovery re-displays a hidden token");
  assert.equal(row(JUNK)!.erc20_check, null, "verdict cleared in storage");
  assert.equal(bridge.of("token_hidden").length, hiddenBefore);

  // ---- 4b. a chain hint arriving later: in-flight hint-less probe is discarded, a persisted hint-less negative is invalidated and re-probed under the new hint ----
  const hintGate = Promise.withResolvers<Erc20Verdict>();
  verdicts.set(HINTED, hintGate.promise);
  shout([HINTED], null);
  await until(() => checks.includes(HINTED), "hint-less token probed");
  shout([HINTED], "bsc", false, clock + 1);
  hintGate.resolve("non-erc20");
  await settle();
  mock.timers.tick(150);
  assert.ok(bridge.lastState().includes(HINTED), "verdict computed under the old hint must be discarded");
  assert.equal(row(HINTED)!.erc20_check, null);
  verdicts.set(HINTED, "non-erc20");
  await until(() => checks.filter((a) => a === HINTED).length === 2, "re-probed under the new hint after the market lookup");
  await until(() => bridge.of("token_hidden").some((e) => e.address === HINTED), "negative under the new hint hides the row");
  // a fresh negative stored under no hint + the group's first chain hint → invalidated and shown again until re-checked
  assert.equal(JSON.parse(row(HINTED)!.erc20_check!).verdict, "non-erc20");
  const hiddenState = (engine as unknown as { tokens: Array<{ address: string; chainHint: string | null }> }).tokens.find((t) => t.address === HINTED)!;
  hiddenState.chainHint = null; // as if the earlier mentions had never named a chain
  const hintGate2 = Promise.withResolvers<Erc20Verdict>();
  verdicts.set(HINTED, hintGate2.promise);
  shout([HINTED], "robinhood", false, clock + 2);
  mock.timers.tick(150);
  assert.ok(bridge.lastState().includes(HINTED), "new hint invalidates the earlier negative and shows the row again");
  assert.equal(row(HINTED)!.erc20_check, null, "invalidated verdict cleared in storage");
  await until(() => checks.filter((a) => a === HINTED).length === 3, "re-probed under the newest hint");
  hintGate2.resolve("unknown");
  await settle();
  assert.equal(JSON.parse(row(HINTED)!.erc20_check!).verdict, "unknown");

  // ---- 5. every unresolved tracked token is probed, not just the refresh window; ≤3 in flight; single flight per token ----
  const many = Array.from({ length: 45 }, (_, i) => addr(0x1000 + i));
  const gates = many.map(() => Promise.withResolvers<Erc20Verdict>());
  many.forEach((a, i) => verdicts.set(a, gates[i].promise));
  peakInflight = 0;
  const checksBefore = checks.length;
  shout(many, null, true, clock - 3600); // backfill: no popups
  await until(() => checks.length >= checksBefore + 3, "probes start once the batch lookup finished");
  await engine.refreshAll();
  await settle();
  assert.equal(inflight, 3);
  assert.equal(new Set(checks.slice(checksBefore)).size, checks.length - checksBefore, "no duplicate in-flight probe for the same token");
  gates.forEach((g) => g.resolve("non-erc20"));
  await until(() => many.every((a) => checks.includes(a)), "all 45 unresolved tokens must eventually be probed, beyond the top-40 refresh window");
  assert.equal(peakInflight, 3, "probe concurrency capped at 3");
  await until(() => many.every((a) => !engine.views().some((v) => v.address === a)), "all confirmed non-tokens hidden");
  assert.equal(count("SELECT COUNT(*) AS n FROM tokens WHERE erc20_check IS NOT NULL"), 48, "records retained: 45 backfilled + POPUP + FLAKY + HINTED");
  assert.deepEqual(bridge.unexpected, []);
  console.log("ok live pipeline: bypass on metadata, hide on definite negative, keep unknown, popup guard, late-market race, top-40+ sweep, concurrency 3");
} finally {
  engine.close();
}

// ---- 6. restart: persisted fresh negative stays hidden without a popup or re-probe; expiry re-probes and lets the token recover ----
store.upsertToken({ address: STORED, chainHint: "bsc", market: null, mentions: [mention(STORED)], history: [], links: null, ath: null, createdAt: null, openAt: null, profile: null, official: [], tweets: [], tweetsAt: 0, erc20Check: { verdict: "non-erc20", checkedAt: clock } });
store.insertCall(STORED, mention(STORED));
// Invalid verdict and future-dated negative caches must not suppress rows at startup.
store.db.prepare("UPDATE tokens SET erc20_check=? WHERE address=?").run(JSON.stringify({ verdict: "maybe", checkedAt: clock }), HINTED);
store.db.prepare("UPDATE tokens SET erc20_check=? WHERE address=?").run(JSON.stringify({ verdict: "non-erc20", checkedAt: clock + 100_000 }), FLAKY);
const bridge2 = new FixtureBridge();
const engine2 = new Engine(store, bridge2 as never);
try {
  checks.length = 0;
  verdicts.set(STORED, "non-erc20");
  engine2.start();
  mock.timers.tick(150);
  assert.ok(bridge2.states().length > 0);
  assert.ok(!bridge2.lastState().includes(STORED), "persisted fresh negative is filtered from the restored state");
  assert.ok(bridge2.lastState().includes(FLAKY), "future cache cannot suppress a row");
  assert.ok(bridge2.lastState().includes(HINTED), "invalid persisted verdict cannot suppress a row");
  assert.ok(!bridge2.events.some((e) => e.t === "new_token" || e.t === "token_hidden"), "restart emits no popup or hide event for an already-hidden token");
  await until(() => checks.includes(FLAKY), "restored unresolved tokens are looked up then probed");
  assert.ok(!checks.includes(STORED), "fresh persisted negative must not be re-probed at startup");

  verdicts.set(STORED, "erc20");
  mock.timers.tick(ERC20_TTL * 1000);
  await engine2.refreshAll();
  await until(() => checks.includes(STORED), "expired negative must be re-checked");
  await until(() => engine2.views().some((v) => v.address === STORED) && bridge2.lastState().includes(STORED), "a positive re-check brings the token back in both dashboard and native state");
  assert.equal(JSON.parse(row(STORED)!.erc20_check!).verdict, "erc20");
  console.log("ok restart: hidden restore without flash, invalid column ignored, expiry recheck recovers");

  // ---- 7. a closed engine ignores a late probe completion ----
  const late = Promise.withResolvers<Erc20Verdict>();
  const lateBatch = [LATE, addr(0xf7), addr(0xf8), addr(0xf9), addr(0xfa)];
  for (const a of lateBatch) verdicts.set(a, late.promise);
  engine2.ingest({ t: "msg", time: clock, sender: "kol", text: lateBatch.join(" "), addrs: lateBatch, chainHint: "bsc", backfill: false, group: GROUP });
  await until(() => lateBatch.filter((a) => checks.includes(a)).length === 3, "three probes running, two still queued");
  const startedAtClose = checks.length;
  const eventsAtClose = bridge2.events.length;
  engine2.close();
  late.resolve("non-erc20");
  await settle();
  mock.timers.tick(500);
  assert.equal(row(LATE)!.erc20_check, null, "stopped engine must not persist a late verdict");
  assert.equal(bridge2.events.length, eventsAtClose, "stopped engine emits nothing");
  assert.equal(checks.length, startedAtClose, "stopped engine must not launch queued probes");
  assert.deepEqual(bridge2.unexpected, []);
  console.log("ok closed engine: late completion dropped");
} finally {
  engine2.close();
  mock.timers.reset();
}
