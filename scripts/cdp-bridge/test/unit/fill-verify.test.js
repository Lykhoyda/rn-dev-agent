import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyFillVerification,
  resolveJsTestId,
  decideNativeRetype,
} from "../../dist/tools/fill-verify.js";

// ── classifyFillVerification ──────────────────────────────────────────
test("exact match → verified-exact", () => {
  assert.equal(
    classifyFillVerification({ text: "a@b.com", valueAfter: "a@b.com", controlled: true }),
    "verified-exact",
  );
});
test("empty-string clear → verified-exact", () => {
  assert.equal(
    classifyFillVerification({ text: "", valueAfter: "", controlled: true }),
    "verified-exact",
  );
});
test("mask/formatter (≥ half length) → verified-transformed", () => {
  assert.equal(
    classifyFillVerification({ text: "5551234", valueAfter: "(555) 1234", controlled: true }),
    "verified-transformed",
  );
  assert.equal(
    classifyFillVerification({ text: "abcdefgh", valueAfter: "abcdef", controlled: true }),
    "verified-transformed",
  );
});
test("empty value while text non-empty → corrupted", () => {
  assert.equal(
    classifyFillVerification({ text: "a@b.com", valueAfter: "", controlled: true }),
    "corrupted",
  );
});
test("severe truncation (< half) → corrupted", () => {
  assert.equal(
    classifyFillVerification({ text: "hello@example.com", valueAfter: "hel", controlled: true }),
    "corrupted",
  );
});
test("null value → unverifiable", () => {
  assert.equal(
    classifyFillVerification({ text: "x", valueAfter: null, controlled: false }),
    "unverifiable",
  );
});
test("stability rule: short BUT stable across retype → verified-transformed", () => {
  assert.equal(
    classifyFillVerification({
      text: "abcdefgh",
      valueAfter: "ab",
      controlled: true,
      priorValueAfter: "ab",
    }),
    "verified-transformed",
  );
});
test("stability rule does NOT rescue an empty value", () => {
  assert.equal(
    classifyFillVerification({
      text: "abcdefgh",
      valueAfter: "",
      controlled: true,
      priorValueAfter: "",
    }),
    "corrupted",
  );
});
test('non-empty value after a clear (text="") → corrupted', () => {
  assert.equal(
    classifyFillVerification({ text: "", valueAfter: "leftover", controlled: true }),
    "corrupted",
  );
});
test("exactly at 0.5*len boundary (odd length) → corrupted just below, transformed at/above", () => {
  assert.equal(
    classifyFillVerification({ text: "abcde", valueAfter: "ab", controlled: true }),
    "corrupted",
  );
  assert.equal(
    classifyFillVerification({ text: "abcde", valueAfter: "abc", controlled: true }),
    "verified-transformed",
  );
});

// ── resolveJsTestId (cached-metadata aware) ───────────────────────────
test("explicit testID wins", () => {
  assert.equal(resolveJsTestId("@e5", { explicitTestId: "email-input" }), "email-input");
});
test("snapshot @eN ref resolves via cached identifier", () => {
  assert.equal(resolveJsTestId("@e5", { cachedIdentifier: "email-input" }), "email-input");
});
test("snapshot @eN ref with no cached identifier → null (skip JS)", () => {
  assert.equal(resolveJsTestId("@e5", {}), null);
});
test("bare numeric ref → null", () => {
  assert.equal(resolveJsTestId("@42", {}), null);
});
test("non-token semantic ref is treated as a testID", () => {
  assert.equal(resolveJsTestId("@email-input", {}), "email-input");
});
test("empty ref → null", () => {
  assert.equal(resolveJsTestId("@", {}), null);
});

// ── decideNativeRetype ────────────────────────────────────────────────
test("corrupted + attempts left → retype with delay", () => {
  assert.deepEqual(decideNativeRetype("corrupted", 0, 2), { action: "retype", delayMs: 40 });
});
test("corrupted + exhausted → escalate", () => {
  assert.deepEqual(decideNativeRetype("corrupted", 2, 2), { action: "escalate" });
});
test("verified-exact → accept", () => {
  assert.deepEqual(decideNativeRetype("verified-exact", 1, 2), { action: "accept" });
});
test("unverifiable → accept", () => {
  assert.deepEqual(decideNativeRetype("unverifiable", 0, 2), { action: "accept" });
});

import { attemptJsFill } from "../../dist/tools/fill-verify.js";

// Fake CDP client: probe returns script.probe; readInputValue returns the next
// entry from script.reads (array — models the settle-poll over time).
function fakeClient(script) {
  const reads = script.reads.slice();
  return {
    sleep: async () => {},
    evaluate: async (expr) => {
      if (expr.includes("interact(")) return { value: JSON.stringify(script.probe) };
      if (expr.includes("readInputValue(")) {
        const next = reads.length > 1 ? reads.shift() : reads[0];
        return { value: JSON.stringify(next) };
      }
      throw new Error("unexpected expr");
    },
  };
}

test("attemptJsFill: handler fired + exact first read → verified-exact", async () => {
  const r = await attemptJsFill(
    fakeClient({
      probe: { handlerCalled: "onChangeText", controlled: true, valueBefore: "" },
      reads: [{ value: "a@b.com", controlled: true }],
    }),
    "email",
    "a@b.com",
  );
  assert.equal(r.handled, true);
  assert.equal(r.outcome, "verified-exact");
  assert.equal(r.handler, "onChangeText");
});
test("attemptJsFill: debounced field (stale==valueBefore then settles) → verified-exact, not corrupted", async () => {
  const r = await attemptJsFill(
    fakeClient({
      probe: { handlerCalled: "onChangeText", controlled: true, valueBefore: "" },
      reads: [
        { value: "", controlled: true },
        { value: "", controlled: true },
        { value: "hello", controlled: true },
      ],
    }),
    "search",
    "hello",
  );
  assert.equal(r.outcome, "verified-exact");
});
test("attemptJsFill: ~300ms debounce settling on read 4 → verified-exact (widened budget, GH#191 H2)", async () => {
  // Stale empty for 3 reads, flushes on the 4th. The old 3-try window would have
  // misread this as corrupted; the 5-try window catches the late flush.
  const r = await attemptJsFill(
    fakeClient({
      probe: { handlerCalled: "onChangeText", controlled: true, valueBefore: "" },
      reads: [
        { value: "", controlled: true },
        { value: "", controlled: true },
        { value: "", controlled: true },
        { value: "hello", controlled: true },
      ],
    }),
    "search",
    "hello",
  );
  assert.equal(r.outcome, "verified-exact");
});
test("attemptJsFill: no JS handler → handled:false", async () => {
  const r = await attemptJsFill(
    fakeClient({
      probe: { handlerCalled: false, controlled: false, valueBefore: null },
      reads: [],
    }),
    "native",
    "x",
  );
  assert.equal(r.handled, false);
});
test("attemptJsFill: stale v23 helper (no controlled field) → handled:false (degrade)", async () => {
  const r = await attemptJsFill(
    fakeClient({
      probe: { handlerCalled: "onChangeText" },
      reads: [{ value: "x", controlled: true }],
    }),
    "email",
    "x",
  );
  assert.equal(r.handled, false);
});
test("attemptJsFill: probe error → handled:false", async () => {
  const r = await attemptJsFill(
    fakeClient({ probe: { error: "Ambiguous" }, reads: [] }),
    "amb",
    "x",
  );
  assert.equal(r.handled, false);
});
test("attemptJsFill: read unreadable → unverifiable (not corrupted)", async () => {
  const r = await attemptJsFill(
    fakeClient({
      probe: { handlerCalled: "onChangeText", controlled: true, valueBefore: "" },
      reads: [{ __agent_error: "Component not found" }],
    }),
    "email",
    "hello",
  );
  assert.equal(r.handled, true);
  assert.equal(r.outcome, "unverifiable");
});
test("attemptJsFill: evaluate throws → handled:false", async () => {
  const r = await attemptJsFill(
    {
      evaluate: async () => {
        throw new Error("CDP down");
      },
      sleep: async () => {},
    },
    "email",
    "x",
  );
  assert.equal(r.handled, false);
});
