/**
 * links.twitter 解析：`x.com/i/web/status/<id>`（X 的系统路由，`i` 不是用户名）必须解析成推文 id、不能当成 @i。
 * 用法：node --import tsx test/twitter-link.test.ts
 */
import assert from "node:assert/strict";
import { parseTwitterLink } from "../src/core/twitter.js";

// 线上实际链接（BSC 股狗 0x9e92…7777）
assert.deepEqual(parseTwitterLink("https://x.com/i/web/status/2096177017691709800"), { statusId: "2096177017691709800" });
assert.deepEqual(parseTwitterLink("https://twitter.com/i/status/2096177017691709800"), { statusId: "2096177017691709800" });
// 普通推文 / 主页
assert.deepEqual(parseTwitterLink("https://x.com/GoogleDog_BSC/status/123?s=20"), { screen: "GoogleDog_BSC", statusId: "123" });
assert.deepEqual(parseTwitterLink("https://x.com/GoogleDog_BSC"), { screen: "GoogleDog_BSC" });
// 社区 / 其它系统路由不是账号也不是推文
assert.equal(parseTwitterLink("https://x.com/i/communities/1900000000000000000"), null);
assert.equal(parseTwitterLink("https://x.com/i/flow/login"), null);
assert.equal(parseTwitterLink("https://x.com/"), null);
console.log("twitter-link ok");
