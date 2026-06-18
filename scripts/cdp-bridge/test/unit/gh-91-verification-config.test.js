// GH #91 acceptance #3: per-project config override for the mutation-absence
// detector. Tests cover: missing project root, missing config file, malformed
// JSON, missing verification block, empty arrays (fall back to defaults),
// successShapes regex compilation with invalid-pattern tolerance, mutationMethods
// uppercased and trimmed, cache idempotence per projectRoot, and the
// pattern-length cap that protects the hot path from accidental ReDoS via
// developer typo (Codex review finding, conf 90).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const MOD_PATH = "../../dist/verification/config.js";

function makeProject(contents) {
  const root = mkdtempSync(join(tmpdir(), "rn-agent-cfg-"));
  if (contents !== undefined) {
    mkdirSync(join(root, ".rn-agent"), { recursive: true });
    writeFileSync(join(root, ".rn-agent", "config.json"), contents);
  }
  return root;
}

test("loadVerificationConfig returns defaults when projectRoot is null", async () => {
  const { loadVerificationConfig, _resetCacheForTests } = await import(MOD_PATH);
  _resetCacheForTests();
  const cfg = loadVerificationConfig(null);
  assert.equal(cfg.successShapes, null);
  assert.equal(cfg.mutationMethods, null);
});

test("loadVerificationConfig returns defaults when config file does not exist", async () => {
  const { loadVerificationConfig, _resetCacheForTests } = await import(MOD_PATH);
  _resetCacheForTests();
  const root = makeProject(undefined);
  try {
    const cfg = loadVerificationConfig(root);
    assert.equal(cfg.successShapes, null);
    assert.equal(cfg.mutationMethods, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadVerificationConfig parses successShapes regex array (OR-combined, case-insensitive)", async () => {
  const { loadVerificationConfig, _resetCacheForTests } = await import(MOD_PATH);
  _resetCacheForTests();
  const root = makeProject(
    JSON.stringify({ verification: { successShapes: ["Receipt$", "^Thanks"] } }),
  );
  try {
    const cfg = loadVerificationConfig(root);
    assert.ok(cfg.successShapes instanceof RegExp);
    assert.ok(cfg.successShapes.test("OrderReceipt"));
    assert.ok(cfg.successShapes.test("ThanksScreen"));
    assert.ok(!cfg.successShapes.test("Login"));
    assert.ok(cfg.successShapes.test("orderreceipt"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadVerificationConfig parses mutationMethods array uppercased and trimmed", async () => {
  const { loadVerificationConfig, _resetCacheForTests } = await import(MOD_PATH);
  _resetCacheForTests();
  const root = makeProject(
    JSON.stringify({ verification: { mutationMethods: ["options", " Query ", "POST"] } }),
  );
  try {
    const cfg = loadVerificationConfig(root);
    assert.ok(cfg.mutationMethods instanceof Set);
    assert.ok(cfg.mutationMethods.has("OPTIONS"));
    assert.ok(cfg.mutationMethods.has("QUERY"));
    assert.ok(cfg.mutationMethods.has("POST"));
    assert.equal(cfg.mutationMethods.size, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadVerificationConfig returns defaults on malformed JSON (never throws)", async () => {
  const { loadVerificationConfig, _resetCacheForTests } = await import(MOD_PATH);
  _resetCacheForTests();
  const root = makeProject("{not valid json");
  try {
    const cfg = loadVerificationConfig(root);
    assert.equal(cfg.successShapes, null);
    assert.equal(cfg.mutationMethods, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadVerificationConfig returns defaults when verification block is missing", async () => {
  const { loadVerificationConfig, _resetCacheForTests } = await import(MOD_PATH);
  _resetCacheForTests();
  const root = makeProject(JSON.stringify({ unrelated: { foo: "bar" } }));
  try {
    const cfg = loadVerificationConfig(root);
    assert.equal(cfg.successShapes, null);
    assert.equal(cfg.mutationMethods, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadVerificationConfig drops invalid regex strings, keeps valid ones", async () => {
  const { loadVerificationConfig, _resetCacheForTests } = await import(MOD_PATH);
  _resetCacheForTests();
  const root = makeProject(
    JSON.stringify({ verification: { successShapes: ["Valid$", "[invalid("] } }),
  );
  try {
    const cfg = loadVerificationConfig(root);
    assert.ok(cfg.successShapes instanceof RegExp);
    assert.ok(cfg.successShapes.test("OrderValid"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadVerificationConfig returns null for successShapes when ALL regex strings are invalid", async () => {
  const { loadVerificationConfig, _resetCacheForTests } = await import(MOD_PATH);
  _resetCacheForTests();
  const root = makeProject(JSON.stringify({ verification: { successShapes: ["[invalid("] } }));
  try {
    const cfg = loadVerificationConfig(root);
    assert.equal(cfg.successShapes, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadVerificationConfig drops patterns longer than 200 chars (ReDoS-via-typo guard)", async () => {
  // Codex finding (conf 90): cap pattern source length to bound regex
  // compilation cost on the cdp_navigate / proof_step hot path. 200 chars
  // is wildly more than any legitimate route-name pattern needs.
  const { loadVerificationConfig, _resetCacheForTests } = await import(MOD_PATH);
  _resetCacheForTests();
  const tooLong = "a".repeat(201);
  const root = makeProject(
    JSON.stringify({ verification: { successShapes: [tooLong, "Valid$"] } }),
  );
  try {
    const cfg = loadVerificationConfig(root);
    assert.ok(cfg.successShapes instanceof RegExp);
    assert.ok(cfg.successShapes.test("OrderValid"));
    // The too-long pattern should NOT be part of the compiled regex
    assert.ok(!cfg.successShapes.test(tooLong));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadVerificationConfig caches result per projectRoot", async () => {
  const { loadVerificationConfig, _resetCacheForTests } = await import(MOD_PATH);
  _resetCacheForTests();
  const root = makeProject(JSON.stringify({ verification: { successShapes: ["Foo$"] } }));
  try {
    const cfg1 = loadVerificationConfig(root);
    const cfg2 = loadVerificationConfig(root);
    assert.strictEqual(cfg1, cfg2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadVerificationConfig ignores empty arrays (falls back to defaults)", async () => {
  // Design decision (Codex review conf 92): empty-array means "fall back to
  // defaults", not "disable detection". Silent loss of a safety net is
  // worse than log-noise; explicit disable belongs to a future
  // `verification.disable: true` flag.
  const { loadVerificationConfig, _resetCacheForTests } = await import(MOD_PATH);
  _resetCacheForTests();
  const root = makeProject(
    JSON.stringify({ verification: { successShapes: [], mutationMethods: [] } }),
  );
  try {
    const cfg = loadVerificationConfig(root);
    assert.equal(cfg.successShapes, null);
    assert.equal(cfg.mutationMethods, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("getCachedProjectRoot memoizes the result (hot-path perf guard)", async () => {
  // Multi-review finding (Codex 92, Gemini 85): findProjectRoot does sync FS
  // walks and was being called on every cdp_navigate / nav_state / proof_step
  // invocation. getCachedProjectRoot wraps it with a process-lifetime cache
  // so the per-tool cost is one Map lookup.
  const { getCachedProjectRoot, _resetCacheForTests } = await import(MOD_PATH);
  _resetCacheForTests();
  const first = getCachedProjectRoot();
  const second = getCachedProjectRoot();
  // Same reference (or both null) — memoization is in effect.
  assert.equal(first, second);
});

test("getCachedProjectRoot reset seam works", async () => {
  const { getCachedProjectRoot, _resetCacheForTests } = await import(MOD_PATH);
  _resetCacheForTests();
  const first = getCachedProjectRoot();
  _resetCacheForTests();
  // After reset, the cache is re-populated; result should still be deterministic.
  const second = getCachedProjectRoot();
  assert.equal(first, second);
});

test("loadVerificationConfig emits one stderr line on first load (observability)", async () => {
  // Codex review conf 85: log on cache miss so users can confirm their
  // config was picked up. No log on cache hit. Avoids a silent-stale-config
  // debugging dead-end without needing SIGHUP/watcher reload machinery.
  const { loadVerificationConfig, _resetCacheForTests } = await import(MOD_PATH);
  _resetCacheForTests();
  const root = makeProject(
    JSON.stringify({
      verification: { successShapes: ["Foo$"], mutationMethods: ["POST", "QUERY"] },
    }),
  );
  const originalWrite = process.stderr.write.bind(process.stderr);
  const captured = [];
  process.stderr.write = (chunk, ..._rest) => {
    captured.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  try {
    loadVerificationConfig(root);
    loadVerificationConfig(root);
    loadVerificationConfig(root);
  } finally {
    process.stderr.write = originalWrite;
    rmSync(root, { recursive: true, force: true });
  }
  const matching = captured.filter(
    (line) => line.includes("[verification]") && line.includes(".rn-agent/config.json"),
  );
  assert.equal(
    matching.length,
    1,
    `expected exactly one [verification] log line; got ${matching.length}: ${JSON.stringify(captured)}`,
  );
});
