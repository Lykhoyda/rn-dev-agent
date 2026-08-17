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
          items: Array<{ flow: string; metaFormat?: string; metaInvalid?: string[] }>;
        };
      };
    };
    const byFlow = Object.fromEntries(parsed.sections.flows.items.map((f) => [f.flow, f]));
    assert.equal(byFlow['legacy-flow'].metaFormat, 'pre-m7');
    assert.equal(byFlow['valid-flow'].metaFormat, 'm7');
    assert.deepEqual((byFlow['broken-flow'].metaInvalid ?? []).sort(), ['mutates', 'produces']);
    assert.equal((byFlow['valid-flow'].metaInvalid ?? []).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
