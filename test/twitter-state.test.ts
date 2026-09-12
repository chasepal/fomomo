import assert from "node:assert/strict";
import { mock } from "node:test";
import { Engine } from "../src/core/engine.js";
import type { GmgnFetchParams, GmgnFetchResult, OutEvent, TokenState } from "../src/core/types.js";

// Real refresh pipeline and outbound snapshots; only the HTTP/persistence boundaries are fake.
const token: TokenState = {
  address: "0xdiagnosis", chainHint: "bsc", market: { chain: "bsc", source: "gmgn", updatedAt: 0 },
  mentions: [], history: [], links: { twitter: "https://x.com/example" }, ath: null,
  profile: null, official: [], tweets: [], tweetsAt: 0,
};
const events: OutEvent[] = [];
let respond: (p: GmgnFetchParams) => Promise<GmgnFetchResult>;
const bridge = { emit: (e: OutEvent) => events.push(e), gmgnFetch: (p: GmgnFetchParams) => respond(p) };
const engine = new Engine({ upsertToken() {} } as never, bridge as never);
const internal = engine as unknown as { tokens: TokenState[]; refreshTweets(t: TokenState): Promise<void>; refreshOfficial(t: TokenState): Promise<void> };
internal.tokens = [token];
const state = () => engine.views()[0].twitterRequest;
const ok = (data: unknown): GmgnFetchResult => ({ status: 200, body: JSON.stringify({ code: 0, data }) });

mock.timers.enable({ apis: ["setTimeout"] });
try {
  let gate = Promise.withResolvers<GmgnFetchResult>();
  respond = () => gate.promise;
  const pending = internal.refreshTweets(token);
  // Let the original reproduction reach its terminal response before asserting the new contract.
  gate.resolve({ status: 429, body: "" });
  await pending;
  assert.equal(state()?.status, "error", "completed HTTP 429 must not remain an implicit loading state");
  assert.match(state().error!, /429/);
  assert.equal(engine.views()[0].profile, null);
  mock.timers.tick(150);
  const emitted = events.filter((e) => e.t === "state").at(-1);
  assert.equal(emitted?.t === "state" && emitted.tokens[0].twitterRequest.status, "error");

  gate = Promise.withResolvers<GmgnFetchResult>();
  respond = () => gate.promise;
  const retry = internal.refreshTweets(token);
  assert.equal(state().status, "loading", "a new attempt must replace the previous error");
  respond = async () => ok({ screen_name: "example", name: "Example", followers_count: 42 });
  gate.resolve(ok([]));
  await retry;
  assert.equal(state().status, "ready");
  assert.equal(state().error, null);
  assert.equal(engine.views()[0].profile?.screen, "example");

  respond = async () => { throw new Error("rpc timeout"); };
  await internal.refreshOfficial(token);
  assert.equal(state().status, "error");
  assert.match(state().error!, /timeout|超时/);
  assert.equal(engine.views()[0].profile?.screen, "example", "refresh failure must retain cached content");

  token.profile = null;
  respond = async () => ok(null);
  await internal.refreshOfficial(token);
  assert.equal(state().status, "empty", "a successful empty response is not loading or an invented account");
  assert.equal(engine.views()[0].profile, null);

  token.links = { twitter: "https://x.com/i/communities/1900000000000000000" };
  await internal.refreshOfficial(token);
  assert.equal(state().status, "unsupported");
  token.links = {};
  await internal.refreshOfficial(token);
  assert.equal(state().status, "no_link");

  token.links = { twitter: "https://x.com/example/status/123" };
  token.official = [{
    id: "123", url: token.links.twitter!, time: 1, kind: "tweet",
    user: { name: "Example", screen: "example", avatar: "", followers: 42, verified: false },
    text: "Cached original", translation: "缓存译文", quoted: null,
  }];
  respond = async ({ path }) => path.includes("link_preview")
    ? { status: 429, body: "" }
    : ok({ screen_name: "example", name: "Example" });
  await internal.refreshOfficial(token);
  assert.equal(state().status, "error", "cached tweet must not hide preview rate limiting");
  assert.match(state().error!, /HTTP 429/);
  assert.equal(engine.views()[0].official[0]?.text, "Cached original");
  console.log("twitter-state ok: HTTP 429, outbound error, retry recovery, timeout with cache, empty, unsupported, no link, cached preview failure");
} finally {
  engine.close();
  mock.timers.reset();
}
