import { test } from "node:test";
import assert from "node:assert/strict";
import { observeHandler, parsePinnedPort } from "../../dist/tools/observe.js";

test("parsePinnedPort accepts a valid port and rejects junk / NaN / out-of-range", () => {
  assert.equal(parsePinnedPort("51234"), 51234);
  assert.equal(parsePinnedPort(undefined), undefined);
  assert.equal(parsePinnedPort(""), undefined);
  assert.equal(parsePinnedPort("abc"), undefined, "NaN must not become a port");
  assert.equal(parsePinnedPort("0"), undefined);
  assert.equal(parsePinnedPort("70000"), undefined, "out of range");
});

test("observe start returns a 127.0.0.1 url; status running; stop tears down", async () => {
  const start = JSON.parse((await observeHandler({ action: "start" })).content[0].text);
  assert.equal(start.ok, true);
  assert.match(start.data.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const status = JSON.parse((await observeHandler({ action: "status" })).content[0].text);
  assert.equal(status.data.running, true);
  await observeHandler({ action: "stop" });
  const after = JSON.parse((await observeHandler({ action: "status" })).content[0].text);
  assert.equal(after.data.running, false);
});
