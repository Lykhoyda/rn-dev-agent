// GH #60 Feature-a / D685: device_record MCP tool wraps scripts/record_proof.sh
// for cross-platform proof video capture. Three actions: start, stop, status.
// Optional gif flag on stop for ffmpeg-based GIF conversion. The handler is a
// thin parser of the script's deterministic stdout — these tests cover the
// stdout-shape contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseStartOutput,
  parseStopOutput,
  parseStatusOutput,
} from "../../dist/tools/device-record.js";

// ── parseStartOutput ────────────────────────────────────────────────────

test("parseStartOutput: extracts pid + output path on success", () => {
  const stdout = "Recording started: platform=ios pid=12345 output=/tmp/proof-ios.mp4\n";
  const parsed = parseStartOutput(stdout);
  assert.deepEqual(parsed, { pid: 12345, output: "/tmp/proof-ios.mp4" });
});

test("parseStartOutput: handles android", () => {
  const stdout = "Recording started: platform=android pid=67890 output=/tmp/proof-android.mp4\n";
  const parsed = parseStartOutput(stdout);
  assert.deepEqual(parsed, { pid: 67890, output: "/tmp/proof-android.mp4" });
});

test("parseStartOutput: handles paths with spaces", () => {
  const stdout = "Recording started: platform=ios pid=42 output=/tmp/my proof file.mp4\n";
  const parsed = parseStartOutput(stdout);
  assert.deepEqual(parsed, { pid: 42, output: "/tmp/my proof file.mp4" });
});

test("parseStartOutput: returns null when no match", () => {
  assert.equal(parseStartOutput(""), null);
  assert.equal(parseStartOutput("Error: No iOS simulator booted"), null);
  assert.equal(parseStartOutput("something unrelated"), null);
});

// ── parseStopOutput ─────────────────────────────────────────────────────

test("parseStopOutput: parses single Saved line", () => {
  const stdout = "Saved: /tmp/proof-ios.mp4 (1234567 bytes)\n";
  const result = parseStopOutput(stdout);
  assert.deepEqual(result, [{ path: "/tmp/proof-ios.mp4", sizeBytes: 1234567 }]);
});

test("parseStopOutput: parses multiple Saved lines (multi-platform)", () => {
  const stdout = [
    "Saved: /tmp/proof-ios.mp4 (1000000 bytes)",
    "Saved: /tmp/proof-android.mp4 (500000 bytes)",
    "/tmp/proof-ios.mp4",
    "/tmp/proof-android.mp4",
    "",
  ].join("\n");
  const result = parseStopOutput(stdout);
  assert.equal(result.length, 2);
  assert.equal(result[0].path, "/tmp/proof-ios.mp4");
  assert.equal(result[0].sizeBytes, 1000000);
  assert.equal(result[1].path, "/tmp/proof-android.mp4");
  assert.equal(result[1].sizeBytes, 500000);
});

test("parseStopOutput: ignores warnings interleaved with Saved lines", () => {
  const stdout = [
    "Warning: Recording process 999 did not stop gracefully, force killing",
    "Saved: /tmp/proof-ios.mp4 (1234 bytes)",
    "Warning: Failed to pull recording from device",
    "",
  ].join("\n");
  const result = parseStopOutput(stdout);
  assert.deepEqual(result, [{ path: "/tmp/proof-ios.mp4", sizeBytes: 1234 }]);
});

test("parseStopOutput: returns empty array when no recordings saved", () => {
  assert.deepEqual(parseStopOutput(""), []);
  assert.deepEqual(parseStopOutput("No active recordings found"), []);
});

test("parseStopOutput: handles paths with spaces in Saved line", () => {
  const stdout = "Saved: /tmp/my proof file.mp4 (999 bytes)\n";
  const result = parseStopOutput(stdout);
  assert.deepEqual(result, [{ path: "/tmp/my proof file.mp4", sizeBytes: 999 }]);
});

// ── parseStatusOutput ───────────────────────────────────────────────────

test("parseStatusOutput: returns empty when no active recordings", () => {
  assert.deepEqual(parseStatusOutput("No active recordings"), []);
  assert.deepEqual(parseStatusOutput("No active recordings\n"), []);
});

test("parseStatusOutput: parses single recording line", () => {
  const stdout = "ios: pid=12345 status=recording output=/tmp/proof.mp4\n";
  const result = parseStatusOutput(stdout);
  assert.deepEqual(result, [
    { platform: "ios", pid: 12345, status: "recording", output: "/tmp/proof.mp4" },
  ]);
});

test("parseStatusOutput: parses multiple platforms simultaneously", () => {
  const stdout = [
    "ios: pid=111 status=recording output=/tmp/ios.mp4",
    "android: pid=222 status=recording output=/tmp/android.mp4",
    "",
  ].join("\n");
  const result = parseStatusOutput(stdout);
  assert.equal(result.length, 2);
  assert.equal(result[0].platform, "ios");
  assert.equal(result[0].pid, 111);
  assert.equal(result[1].platform, "android");
  assert.equal(result[1].pid, 222);
});

test("parseStatusOutput: surfaces dead processes", () => {
  const stdout = "ios: pid=12345 status=dead output=/tmp/proof.mp4\n";
  const result = parseStatusOutput(stdout);
  assert.equal(result[0].status, "dead");
});

test("parseStatusOutput: handles paths with spaces", () => {
  const stdout = "android: pid=42 status=recording output=/tmp/my proof file.mp4\n";
  const result = parseStatusOutput(stdout);
  assert.equal(result[0].output, "/tmp/my proof file.mp4");
});

test("parseStatusOutput: surfaces orphaned pid rows with empty output (Gemini review)", () => {
  // record_proof.sh:220 emits `output=` (empty) when the .path sidecar is
  // missing — orphaned .pid from a crashed prior session. The row must
  // surface so the operator can manually clean up, not be silently dropped.
  const stdout = "ios: pid=99999 status=dead output=\n";
  const result = parseStatusOutput(stdout);
  assert.equal(result.length, 1, "orphaned pid row must NOT be dropped");
  assert.equal(result[0].pid, 99999);
  assert.equal(result[0].status, "dead");
  assert.equal(result[0].output, "");
});

// ── createDeviceRecordHandler — argument validation + script absence ────

test("createDeviceRecordHandler: invalid action returns failResult", async () => {
  // Stub script absence by pointing CLAUDE_PLUGIN_ROOT at a non-existent dir.
  const prev = process.env.CLAUDE_PLUGIN_ROOT;
  process.env.CLAUDE_PLUGIN_ROOT = "/tmp/__rn-dev-agent-test-nonexistent__";
  try {
    const { createDeviceRecordHandler } = await import("../../dist/tools/device-record.js");
    const handler = createDeviceRecordHandler();
    const result = await handler({ action: "invalid" });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /Unknown action/);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = prev;
  }
});

test("createDeviceRecordHandler: status when script missing returns fail (not crash)", async () => {
  const prev = process.env.CLAUDE_PLUGIN_ROOT;
  process.env.CLAUDE_PLUGIN_ROOT = "/tmp/__rn-dev-agent-test-nonexistent__";
  try {
    const { createDeviceRecordHandler } = await import("../../dist/tools/device-record.js");
    const handler = createDeviceRecordHandler();
    const result = await handler({ action: "status" });
    // Script not found → execFile rejects → failResult
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /record_proof\.sh status failed/);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = prev;
  }
});

test("createDeviceRecordHandler: stop when no active recordings returns warn-shape", async () => {
  // Use the real script — the script itself handles "No active recordings"
  // gracefully and exits 0. This proves the wiring works end-to-end without a
  // booted device.
  const prev = process.env.CLAUDE_PLUGIN_ROOT;
  // Clear any leftover pid files from earlier failed runs in this process.
  // (record_proof.sh's start writes /tmp/rn-dev-agent-record-*.pid; if a stale
  // file with a now-dead pid exists, stop will still emit Saved/no-Saved lines
  // depending on the cleanup path. We only assert non-crash + structural shape.)
  delete process.env.CLAUDE_PLUGIN_ROOT;
  try {
    const { createDeviceRecordHandler } = await import("../../dist/tools/device-record.js");
    const handler = createDeviceRecordHandler();
    const result = await handler({ action: "stop" });
    // Either warn (no active) or ok (something was saved) — both are valid
    // depending on stale state. We just assert the response is well-formed.
    assert.ok(typeof result === "object" && result !== null);
    assert.ok("content" in result, "tool result must have content array");
  } finally {
    if (prev !== undefined) process.env.CLAUDE_PLUGIN_ROOT = prev;
  }
});

// ── Multi-platform gifPath clobber guard (Codex + Gemini review) ────────

test("source guard: stop with gifPath + multiple recordings rejects with GIFPATH_AMBIGUOUS", async () => {
  // Codex/Gemini flagged: a single user-supplied gifPath would be reused for
  // every saved recording when both ios+android stop together — second
  // overwrites first. The handler now refuses up-front. We assert the source
  // contains the guard rather than spinning up a real device pair.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(__dirname, "../../dist/tools/device-record.js"), "utf-8");
  assert.match(src, /GIFPATH_AMBIGUOUS/);
  assert.match(src, /gifPath cannot be combined/);
});

// ── Source-grep regression guards ───────────────────────────────────────

test("source guard: device_record tool registered in index.ts", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const indexSrc = readFileSync(join(__dirname, "../../dist/index.js"), "utf-8");
  assert.match(
    indexSrc,
    /['"]device_record['"]/,
    "device_record tool name not found in built index.js",
  );
  assert.match(indexSrc, /createDeviceRecordHandler/, "createDeviceRecordHandler import missing");
});

test("source guard: handler resolves script via getPluginRoot pattern", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(__dirname, "../../dist/tools/device-record.js"), "utf-8");
  assert.match(src, /CLAUDE_PLUGIN_ROOT/);
  assert.match(src, /record_proof\.sh/);
});
