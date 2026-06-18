import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { resolveBundleId, readExpoSlug } from './project-config.js';
import {
  buildMaestroFlow,
  parseAndValidateFlow,
  isValidBundleId,
  MaestroValidationError,
} from './domain/maestro-validator.js';
import { chooseMaestroDispatch } from './tools/maestro-dispatch.js';
import { outputIndicatesFlowFailure } from './domain/maestro-error-parser.js';
import { resolveAppFileForClearState } from './tools/resolve-ios-app-file.js';

const execFile = promisify(execFileCb);

export interface MaestroInvokeOptions {
  platform: 'ios' | 'android';
  appId?: string;
  timeoutMs?: number;
  slug?: string;
}

// Escape a user-supplied string for safe embedding inside a double-quoted YAML scalar.
// Handles backslash, double quote, and control characters that would break the scalar.
// NOTE: this is intended for values that go into `text: "..."` / `id: "..."` contexts —
// not for block scalars or unquoted values.
export function yamlEscape(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

export interface MaestroInvokeResult {
  passed: boolean;
  output: string;
  flowFile: string;
  error?: string;
}

export function getMaestroRunnerPath(): string | null {
  const path = join(homedir(), '.maestro-runner', 'bin', 'maestro-runner');
  return existsSync(path) ? path : null;
}

export async function runMaestroInline(
  yaml: string,
  opts: MaestroInvokeOptions,
): Promise<MaestroInvokeResult> {
  // B59 tiered dispatch (same decision tree as maestro_run / maestro_test_all):
  // maestro-runner when viable, else the Maestro CLI fallback for the
  // iOS-only / adb-missing setup. Previously this path hardcoded
  // getMaestroRunnerPath() and hard-failed where maestro_run would fall back,
  // breaking the device_fill / picker / dialog fallbacks on iOS-only machines.
  const dispatch = chooseMaestroDispatch({ platform: opts.platform });
  if ('error' in dispatch) {
    return { passed: false, output: '', flowFile: '', error: dispatch.error };
  }

  // Phase 134.1 (deepsec CRITICAL #1): the appId came from opts.appId,
  // resolveBundleId() reading native config, or readExpoSlug() reading
  // app.json/app.config.json. All three are project-controlled in the
  // prompt-injection threat model. Validate it against the strict bundle-ID
  // regex BEFORE it ever touches the header; reject malicious slugs entirely
  // rather than escaping into a fallback path. The full Maestro flow is then
  // built via buildMaestroFlow which serializes through the `yaml` lib —
  // no string concatenation, no newline/--- escape possible.
  const rawAppId = opts.appId ?? resolveBundleId(opts.platform) ?? readExpoSlug() ?? '';
  const flowFile = join(tmpdir(), `rn-maestro-invoke-${opts.slug ?? 'flow'}-${Date.now()}.yaml`);

  let content: string;
  let headerAppId: string | undefined;
  try {
    const parsed = parseAndValidateFlow(yaml, { rejectHeader: true });
    const appIdOpts: { appId?: string } = {};
    if (rawAppId && isValidBundleId(rawAppId)) {
      appIdOpts.appId = rawAppId;
      headerAppId = rawAppId;
    } else if (rawAppId) {
      return {
        passed: false,
        output: '',
        flowFile,
        error: `Refusing to run Maestro: invalid bundle ID '${rawAppId.slice(0, 80)}' from project config (Phase 134.1)`,
      };
    }
    content = buildMaestroFlow(appIdOpts, parsed.commands);
  } catch (err) {
    if (err instanceof MaestroValidationError) {
      return {
        passed: false,
        output: '',
        flowFile,
        error: `Refusing to run Maestro: ${err.message} (Phase 134.1)`,
      };
    }
    throw err;
  }

  try {
    writeFileSync(flowFile, content, 'utf-8');
  } catch (err) {
    return {
      passed: false,
      output: '',
      flowFile,
      error: `Failed to write flow file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const timeout = opts.timeoutMs ?? 30_000;

  // GH#201 parity with maestro_run: resolve --app-file so an iOS clearState flow
  // run through this inline path (device_fill/picker/dialog fallbacks) can
  // reinstall the app instead of failing after uninstall.
  const appFileResolution = resolveAppFileForClearState(
    opts.platform,
    content,
    headerAppId,
    undefined,
  );
  if (!appFileResolution.ok) {
    return { passed: false, output: '', flowFile, error: appFileResolution.error };
  }

  try {
    const { stdout, stderr } = await execFile(
      dispatch.binPath,
      dispatch.buildArgs(opts.platform, flowFile, appFileResolution.appFile),
      { timeout, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
    );
    const output = (stdout + '\n' + stderr).trim();
    // Runner exited 0 → authoritative pass. The secondary scan keys on Maestro's
    // own status LINES (GH#249: a bare `FAILED` substring false-flagged passing
    // runs whose app logs contained the token; mirrors maestro_run).
    const passed = !outputIndicatesFlowFailure(output);
    return { passed, output, flowFile };
  } catch (err) {
    // execFile errors carry stdout/stderr from the failed child process. When
    // Maestro exits non-zero because an assertion failed (e.g. "Element not found:
    // 'Foo'"), that is a NORMAL test outcome — not a runner crash — and the
    // details live in the captured stdout. Route those through `passed: false`
    // with `output` populated so callers can distinguish "the test ran and the
    // element wasn't there" (warnable) from "maestro-runner itself crashed"
    // (failure). Only when there's truly no captured output do we surface the
    // raw exec error message.
    const errObj = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    const capturedOutput = ((errObj.stdout ?? '') + '\n' + (errObj.stderr ?? '')).trim();
    if (errObj.killed) {
      // Timeout — always a hard error, caller should treat as runner failure.
      return {
        passed: false,
        output: capturedOutput,
        flowFile,
        error: `Maestro timed out after ${timeout}ms`,
      };
    }
    if (capturedOutput) {
      return { passed: false, output: capturedOutput, flowFile };
    }
    const msg = errObj.message ?? String(err);
    return { passed: false, output: '', flowFile, error: msg.slice(0, 500) };
  }
}
