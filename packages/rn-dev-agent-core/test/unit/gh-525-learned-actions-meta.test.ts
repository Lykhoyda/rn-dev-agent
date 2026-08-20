// GH#525 finding 3: the learned-actions table rendered "?" in every M7 column
// (Mutates/Status/Tags/Produces) for flows whose header simply predates M7 —
// reading as a parse failure. Absence must render as "pre-M7" (whole header
// legacy) or "-" (single key omitted), "?" stays reserved for a key that IS
// present but failed to parse, and present metadata renders exactly as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, '..', '..', 'dist', 'learned-actions.js');

function run(args: string[], cwd: string): string {
  try {
    return execFileSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    if (e.status === 3) return e.stdout ?? '';
    throw err;
  }
}

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gh525-la-'));
  const actionsDir = join(dir, '.rn-agent', 'actions');
  mkdirSync(actionsDir, { recursive: true });

  // Legacy header from before M7 — no metadata keys at all.
  writeFileSync(
    join(actionsDir, 'legacy-flow.yaml'),
    `# Verify the active policy card renders after login
appId: com.example.testapp
---
- launchApp
`,
  );

  // Partially annotated post-M7 header — id + status present, rest omitted.
  writeFileSync(
    join(actionsDir, 'partial-flow.yaml'),
    `# id: partial-flow
# intent: Open settings
# status: active
appId: com.example.testapp
---
- launchApp
`,
  );

  // Present-but-unparseable values: mutates is not a boolean, produces is garbage.
  writeFileSync(
    join(actionsDir, 'broken-flow.yaml'),
    `# id: broken-flow
# intent: Flow with unparseable metadata
# mutates: maybe
# produces: {###}
appId: com.example.testapp
---
- launchApp
`,
  );

  // Mixed produces: one valid pair plus a malformed segment. Any malformed
  // segment is a FULL parse failure — a silently partial map would hide the
  // metadata loss behind a healthy-looking cell (review r3798017301).
  writeFileSync(
    join(actionsDir, 'mixed-produces-flow.yaml'),
    `# id: mixed-produces-flow
# intent: Flow whose produces map is partially malformed
# mutates: true
# produces: { loggedIn: true, ### }
appId: com.example.testapp
---
- launchApp
`,
  );

  // Fully valid M7 header — rendering must be unchanged.
  writeFileSync(
    join(actionsDir, 'valid-flow.yaml'),
    `# id: valid-flow
# intent: Login with email and password
# tags: [auth, login]
# mutates: false
# status: active
# produces: { loggedIn: true, attempts: 2 }
appId: com.example.testapp
---
- launchApp
`,
  );

  // An explicitly empty produces map is present-but-valueless, like `tags: []`.
  writeFileSync(
    join(actionsDir, 'empty-produces-flow.yaml'),
    `# id: empty-produces-flow
# intent: Flow declaring an empty produces map
# tags: []
# mutates: false
# produces: {}
appId: com.example.testapp
---
- launchApp
`,
  );

  // GH #790 — key present, value empty. Must not be treated as omitted.
  writeFileSync(
    join(actionsDir, 'empty-mutates-flow.yaml'),
    `# id: empty-mutates-flow
# intent: Flow whose mutates field is present but empty
# tags: [auth]
# mutates:
# status: active
# produces: { loggedIn: true }
appId: com.example.testapp
---
- launchApp
`,
  );

  writeFileSync(
    join(actionsDir, 'empty-produces-value-flow.yaml'),
    `# id: empty-produces-value-flow
# intent: Flow whose produces field is present but empty
# mutates: false
# status: active
# produces:
appId: com.example.testapp
---
- launchApp
`,
  );

  writeFileSync(
    join(actionsDir, 'empty-tags-value-flow.yaml'),
    `# id: empty-tags-value-flow
# intent: Flow whose tags field is present but empty
# tags:
# mutates: false
# status: active
appId: com.example.testapp
---
- launchApp
`,
  );

  writeFileSync(
    join(actionsDir, 'empty-string-fields-flow.yaml'),
    `# id:
# intent:
# tags: [auth]
# mutates: false
# status:
appId: com.example.testapp
---
- launchApp
`,
  );

  return dir;
}

function rowFor(output: string, flow: string): string[] {
  const line = output.split('\n').find((l) => l.startsWith(`| \`${flow}\``));
  assert.ok(line, `expected a table row for ${flow}`);
  return (line as string).split('|').map((c) => c.trim());
}

// Columns: 0='' 1=Flow 2=Purpose 3=AppID 4=Mutates 5=Status 6=Tags 7=Produces 8=Replay
test('#525 pre-M7 header renders pre-M7 markers, never "?"', () => {
  const dir = makeFixture();
  try {
    const out = run(['--section', 'b'], dir);
    const cells = rowFor(out, 'legacy-flow');
    for (const idx of [4, 5, 6, 7]) {
      assert.equal(cells[idx], 'pre-M7', `column ${idx} should say pre-M7, got ${cells[idx]}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#525 partially annotated M7 header renders "-" for omitted keys and values for present ones', () => {
  const dir = makeFixture();
  try {
    const out = run(['--section', 'b'], dir);
    const cells = rowFor(out, 'partial-flow');
    assert.equal(cells[4], '-'); // mutates omitted
    assert.equal(cells[5], 'active'); // status present
    assert.equal(cells[6], '-'); // tags omitted
    assert.equal(cells[7], '-'); // produces omitted
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#525 present-but-unparseable values keep "?" as the parse-failure marker', () => {
  const dir = makeFixture();
  try {
    const out = run(['--section', 'b'], dir);
    const cells = rowFor(out, 'broken-flow');
    assert.equal(cells[4], '?'); // mutates: maybe — not a boolean
    assert.equal(cells[7], '?'); // produces: {###} — unparseable
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#525 an empty produces map renders "-", never the parse-failure marker', () => {
  const dir = makeFixture();
  try {
    const out = run(['--section', 'b'], dir);
    const cells = rowFor(out, 'empty-produces-flow');
    assert.equal(cells[6], '-'); // tags: [] — present, no values
    assert.equal(cells[7], '-', `empty produces must render "-", got ${cells[7]}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#525 a produces map with any malformed segment renders "?", never a partial map', () => {
  const dir = makeFixture();
  try {
    const out = run(['--section', 'b'], dir);
    const cells = rowFor(out, 'mixed-produces-flow');
    assert.equal(cells[7], '?', `produces must be a full parse failure, got ${cells[7]}`);
    assert.equal(cells[4], 'yes'); // other valid keys on the same header still parse
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#525 fully valid M7 metadata renders exactly as before', () => {
  const dir = makeFixture();
  try {
    const out = run(['--section', 'b'], dir);
    const cells = rowFor(out, 'valid-flow');
    assert.equal(cells[4], 'no');
    assert.equal(cells[5], 'active');
    assert.equal(cells[6], 'auth, login');
    assert.equal(cells[7], 'attempts=2, loggedIn=true');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#525 JSON output distinguishes pre-M7 absence from parse failure', () => {
  const dir = makeFixture();
  try {
    const out = run(['--section', 'b', '--json'], dir);
    const parsed = JSON.parse(out) as {
      sections: {
        flows: {
          items: Array<{
            flow: string;
            metaFormat?: string;
            metaInvalid?: string[];
            produces?: Record<string, string | number | boolean> | null;
          }>;
        };
      };
    };
    const byFlow = Object.fromEntries(parsed.sections.flows.items.map((f) => [f.flow, f]));
    assert.equal(byFlow['legacy-flow'].metaFormat, 'pre-m7');
    assert.equal(byFlow['valid-flow'].metaFormat, 'm7');
    assert.deepEqual((byFlow['broken-flow'].metaInvalid ?? []).sort(), ['mutates', 'produces']);
    assert.deepEqual(byFlow['mixed-produces-flow'].metaInvalid ?? [], ['produces']);
    assert.deepEqual(byFlow['empty-produces-flow'].metaInvalid ?? [], []);
    assert.deepEqual(byFlow['empty-produces-flow'].produces, {});
    assert.equal((byFlow['valid-flow'].metaInvalid ?? []).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#790 empty mutates value renders "?" and reports metaInvalid, not omitted', () => {
  const dir = makeFixture();
  try {
    const table = run(['--section', 'b'], dir);
    const cells = rowFor(table, 'empty-mutates-flow');
    assert.equal(cells[4], '?', `empty # mutates: must render "?", got ${cells[4]}`);
    assert.equal(cells[5], 'active');
    assert.equal(cells[6], 'auth');
    assert.equal(cells[7], 'loggedIn=true');

    const jsonOut = run(['--section', 'b', '--json'], dir);
    const parsed = JSON.parse(jsonOut) as {
      sections: {
        flows: {
          items: Array<{ flow: string; metaInvalid?: string[] }>;
        };
      };
    };
    const byFlow = Object.fromEntries(parsed.sections.flows.items.map((f) => [f.flow, f]));
    assert.deepEqual(byFlow['empty-mutates-flow'].metaInvalid ?? [], ['mutates']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#790 empty produces value is invalid; empty tags stays present-but-valueless', () => {
  const dir = makeFixture();
  try {
    const table = run(['--section', 'b'], dir);
    const producesCells = rowFor(table, 'empty-produces-value-flow');
    assert.equal(
      producesCells[7],
      '?',
      `empty # produces: must render "?", got ${producesCells[7]}`,
    );
    assert.equal(producesCells[4], 'no');

    const tagsCells = rowFor(table, 'empty-tags-value-flow');
    assert.equal(tagsCells[6], '-', `empty # tags: must render "-", got ${tagsCells[6]}`);
    assert.equal(tagsCells[4], 'no');

    const jsonOut = run(['--section', 'b', '--json'], dir);
    const parsed = JSON.parse(jsonOut) as {
      sections: {
        flows: {
          items: Array<{ flow: string; metaInvalid?: string[]; tags?: string[] | null }>;
        };
      };
    };
    const byFlow = Object.fromEntries(parsed.sections.flows.items.map((f) => [f.flow, f]));
    assert.deepEqual(byFlow['empty-produces-value-flow'].metaInvalid ?? [], ['produces']);
    assert.deepEqual(byFlow['empty-tags-value-flow'].metaInvalid ?? [], []);
    assert.deepEqual(byFlow['empty-tags-value-flow'].tags, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#790 empty id/intent/status stay present string fields, not metaInvalid', () => {
  const dir = makeFixture();
  try {
    const table = run(['--section', 'b'], dir);
    const cells = rowFor(table, 'empty-string-fields-flow');
    assert.equal(cells[4], 'no');
    assert.equal(cells[5], '-'); // empty status is falsy; no enum parser to mark "?"
    assert.equal(cells[6], 'auth');

    const jsonOut = run(['--section', 'b', '--json'], dir);
    const parsed = JSON.parse(jsonOut) as {
      sections: {
        flows: {
          items: Array<{
            flow: string;
            id?: string | null;
            intent?: string | null;
            status?: string | null;
            metaFormat?: string;
            metaInvalid?: string[];
          }>;
        };
      };
    };
    const byFlow = Object.fromEntries(parsed.sections.flows.items.map((f) => [f.flow, f]));
    const row = byFlow['empty-string-fields-flow'];
    assert.equal(row.metaFormat, 'm7');
    assert.equal(row.id, '');
    assert.equal(row.intent, '');
    assert.equal(row.status, '');
    assert.deepEqual(row.metaInvalid ?? [], []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
