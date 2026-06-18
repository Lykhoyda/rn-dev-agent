import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(resolve(__dirname, "../../src/index.ts"), "utf8");

// PR #272 review (Codex P2): both handlers accept `params` (GH #116 — forwarded
// as -e KEY=VALUE on first attempt AND post-repair retry), but the MCP zod
// registrations omitted the field. zod strips unknown keys by default, so a
// caller's params were SILENTLY DROPPED at the tool-call layer and a
// parameterised action failed with unset placeholders. These tests pin the
// schema exposure so the registration can't regress behind the handlers again.

/** Slice the trackedTool('<name>', ...) registration block out of index.ts. */
function registrationBlock(toolName) {
  const normalized = indexSrc.replace(/'/g, '"');
  const start = normalized.indexOf(`"${toolName}",`);
  assert.notEqual(start, -1, `registration for ${toolName} not found`);
  const rest = normalized.slice(start);
  const next = rest.indexOf("trackedTool(", 1);
  return next === -1 ? rest : rest.slice(0, next);
}

test("PR#272 maestro_run registration exposes params as a string record", () => {
  assert.match(
    registrationBlock("maestro_run"),
    /params:\s*z[\s\S]{0,30}\.record\(z\.string\(\),\s*z\.string\(\)\)[\s\S]{0,30}\.optional\(\)/,
  );
});

test("PR#272 cdp_run_action registration exposes params as a string record", () => {
  assert.match(
    registrationBlock("cdp_run_action"),
    /params:\s*z[\s\S]{0,30}\.record\(z\.string\(\),\s*z\.string\(\)\)[\s\S]{0,30}\.optional\(\)/,
  );
});
