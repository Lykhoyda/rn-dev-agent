# E2E Params Source — lockable/runnable parameterized e2e tests (Plan 3)

**Goal:** Let parameterized actions become locked e2e tests by supplying values from a local, gitignored `.rn-agent/e2e.config.json`, with secret-value redaction. Removes v1's blanket `PARAMS_UNSUPPORTED` refusal.

**Built on:** the Plan-1 engine (`lock-e2e-test.ts`, `run-e2e-suite.ts`).

## Config shape (`.rn-agent/e2e.config.json`, gitignored)

```json
{
  "defaults": { "params": { "EMAIL": "test@example.com" } },
  "tests": { "login-create-task": { "params": { "TITLE": "Ship demo", "DESC": "e2e", "PRIORITY": "high", "TAG": "feature" } } },
  "secretParams": ["PASSWORD", "TOKEN", "PIN", "OTP"]
}
```
Resolution for a test = `defaults.params` merged with `tests[id].params` (test wins). A required param (from the action's `# params`) is satisfied only if it resolves to a non-empty string.

## Global constraints
- Node>=22, TS strict, ESM `.js` imports, `import type`, single-quote, no unnecessary comments.
- Tests at `test/unit/*.test.js` (top-level), `node:test`, import from `../../dist/*.js`. Build via `npm run build`; `dist/` tracked.
- Secret param VALUES must never appear in: lock `failureDetail`, suite `errorExcerpt`/output, run records, or SSE — redact to `***`.

## Task 1 — `domain/e2e-config.ts` (pure, TDD)

**Produces:**
```
interface E2eConfig { defaults?: { params?: Record<string,string> }; tests?: Record<string,{ params?: Record<string,string> }>; secretParams?: string[] }
loadE2eConfig(projectRoot): E2eConfig            // .rn-agent/e2e.config.json; {} on missing/corrupt
resolveParams(config, testId, required: string[]): { ok:true; params:Record<string,string> } | { ok:false; missing:string[] }
secretValuesFor(config, params: Record<string,string>): string[]   // values of params whose NAME is in secretParams (non-empty)
redactSecrets(text: string, secretValues: string[]): string        // replace each secret value occurrence with '***'
```
Tests: missing/corrupt→`{}`; defaults+test merge with test-override; missing detection (absent + empty-string both → missing); `secretValuesFor` picks only secret-named non-empty values; `redactSecrets` replaces all occurrences, leaves non-secrets, no-op on empty list.

- [ ] failing test `test/unit/e2e-config.test.js` → build+run fail → implement → pass → commit.

## Task 2 — lock accepts param tests when config covers them

`tools/lock-e2e-test.ts`: add `deps.loadConfig?` (default `loadE2eConfig`). Replace the blanket `PARAMS_UNSUPPORTED` branch:
- param-free → unchanged.
- param-needing → `resolveParams(config, actionId, metadata.params)`:
  - `!ok` → `failResult('missing param values for '+missing.join(', ')+' — add them to .rn-agent/e2e.config.json (tests.'+actionId+'.params or defaults.params)', 'MISSING_PARAMS')`.
  - `ok` → strict `maestroRun({ flowPath, platform, params })`; on fail → `STRICT_RUN_FAILED` with `redactSecrets(output, secretValuesFor(config, params))`; on pass → freeze (unchanged).
- Add `MISSING_PARAMS` to `ToolErrorCode` (types.ts).

Tests (extend `lock-e2e-test.test.js`): param test + config-with-values → frozen (inject `loadConfig`); param test + missing value → `MISSING_PARAMS` listing the missing name, no maestro call; a secret value present in maestro fail output → redacted (`***`) in the returned meta.

- [ ] failing test → fail → implement → pass → commit.

## Task 3 — suite runs param tests from config (else skip)

`tools/run-e2e-suite.ts`: add `deps.loadConfig?` (default `loadE2eConfig`). Replace the `locked.params?.length → skippedResult` branch:
- `resolveParams(config, id, locked.params)`: `!ok` → `skippedResult(id, intent, 'missing param values: '+missing.join(', '))`; `ok` → `maestroRun({ flowPath, platform, params })`, then `classifyFlowResult` on `redactSecrets(output, secretValuesFor(config, params))`.

Tests (extend `run-e2e-suite-core.test.js`): param locked test + config values → runs (assert maestroRun received the params) + classified normally; + missing value → skipped with the reason; secret value redacted in a failing param test's `errorExcerpt`.

- [ ] failing test → fail → implement → pass → commit.

## Task 4 — wiring: gitignore + test-app config + changeset

- `.gitignore`: add `.rn-agent/e2e.config.json` (may hold secrets). Optionally a committed `.rn-agent/e2e.config.example.json`.
- Create `rn-dev-agent-workspace/test-app/.rn-agent/e2e.config.json` with `login-create-task` params (TITLE/DESC/PRIORITY/TAG; no secrets here).
- Changeset (`rn-dev-agent-cdp`, minor).
- Full `npm test` + lint + format:check green; commit.

## Verification
- Unit tests cover config resolution, redaction, lock-with-config, suite-with-config (the real logic).
- Live: blocked on this iOS 26.5 sim (#317 WDA a11y) — proven on iOS 18 in the follow-up step (`/lock-e2e login-create-task` then the Regression Run button).

## Known limits
- Config is local/gitignored (personal e2e values). Secret redaction is value-substring based; param names in `secretParams` are global.
