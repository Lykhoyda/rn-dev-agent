import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const runSrc = readFileSync(resolve(__dirname, "../../src/tools/maestro-run.ts"), "utf8");
const indexSrc = readFileSync(resolve(__dirname, "../../src/index.ts"), "utf8");

test("GH#201 maestro-run auto-resolves appFile for iOS clearState flows", () => {
  // The clearState→appFile resolution was extracted into the shared
  // resolveAppFileForClearState helper (so maestro_test_all + runMaestroInline
  // reuse it too); maestro-run delegates to it and threads the result into buildArgs.
  assert.match(runSrc, /resolveAppFileForClearState\(/);
  assert.match(runSrc, /dispatch\.buildArgs\(platform, flowFile, appFileResolution\.appFile\)/);
});

test("GH#201 maestro_run exposes an appFile param", () => {
  assert.match(indexSrc, /appFile:\s*z\.string\(\)\.optional\(\)/);
});
