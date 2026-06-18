import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(resolve(__dirname, "../../src/index.ts"), "utf8");

test("GH#202 trackedTool composes arbiterWrap inside instrumentTool", () => {
  assert.match(
    indexSrc,
    /import\s*\{[^}]*arbiterWrap[^}]*\}\s*from\s*['"]\.\/lifecycle\/device-arbiter\.js['"]/,
  );
  // arbiterWrap(name, handler) is composed before instrumentTool sees the handler
  assert.match(indexSrc, /instrumentTool\(\s*name\s*,\s*arbiterWrap\(\s*name\s*,/);
});
