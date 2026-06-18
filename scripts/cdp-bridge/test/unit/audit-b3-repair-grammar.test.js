// Audit batch B3 — repair-engine testID grammar must agree with the
// maestro-error-parser, so a selector the parser extracts from a failure is
// also found in the action body (otherwise auto-repair silently no-ops).
import { test } from "node:test";
import assert from "node:assert/strict";

import { extractIdSelectors, replaceIdSelector } from "../../dist/domain/repair-engine.js";
import { parseMaestroFailure } from "../../dist/domain/maestro-error-parser.js";

// The two extractors must agree on the same testID grammar. For each id, the
// parser pulls it out of a failure line and extractIdSelectors must find the
// matching `id:` line in the body.
const TRICKY_IDS = [
  "user's-task", // single quote inside a double-quoted value
  'say-"hi"', // double quote inside a single-quoted value
  "plain-kebab", // ordinary
  "btn.with.dots", // regex-special chars
];

for (const id of TRICKY_IDS) {
  test(`grammar agreement: parser + extractIdSelectors both recover "${id}"`, () => {
    // Quote both the body line and the failure message with whichever quote
    // does not appear in the id (matched-quote grammar, like Maestro itself).
    const q = id.includes('"') ? "'" : '"';
    const body = `- tapOn:\n    id: ${q}${id}${q}`;
    const failure = parseMaestroFailure(`Element with id ${q}${id}${q} not found`);
    assert.equal(failure.kind, "SELECTOR_NOT_FOUND", `parser classifies "${id}"`);
    assert.equal(failure.selector, id, `parser extracts "${id}"`);
    assert.ok(
      extractIdSelectors(body).includes(failure.selector),
      `extractIdSelectors must contain the parser's selector "${id}" — else attemptRepair short-circuits`,
    );
  });
}

test("extractIdSelectors recovers a double-quoted id containing a single quote", () => {
  assert.deepEqual(extractIdSelectors(`    id: "user's-task"`), ["user's-task"]);
});

test("extractIdSelectors strips a trailing comment after a quoted id", () => {
  assert.deepEqual(extractIdSelectors(`    id: "foo-bar"  # human note`), ["foo-bar"]);
});

test("replaceIdSelector patches a quoted id with an embedded opposite quote", () => {
  const { body, replacements } = replaceIdSelector(
    `- tapOn:\n    id: "user's-task"`,
    "user's-task",
    "user-task",
  );
  assert.equal(replacements, 1);
  assert.match(body, /id: "user-task"/);
});

test("replaceIdSelector preserves a trailing comment", () => {
  const { body, replacements } = replaceIdSelector(`    id: "old"  # keep me`, "old", "new");
  assert.equal(replacements, 1);
  assert.match(body, /id: "new"\s+# keep me/);
});

// Regression guard for the original bug class: the bare comment + quoted forms
// must still behave as the pre-existing tests expect.
test("extractIdSelectors keeps bare-form comment stripping", () => {
  assert.deepEqual(extractIdSelectors("- tapOn:\n    id: foo-bar  # c"), ["foo-bar"]);
});
