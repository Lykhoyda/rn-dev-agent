import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface AndroidExternalRunnerWarning {
  platform: 'android';
  code: 'ANDROID_UIAUTOMATOR_COMPETITOR';
  message: string;
  processLines: string[];
}

export async function detectAndroidExternalRunner(
  execFileImpl: typeof execFile = execFile,
  serialArgs: string[] = [],
): Promise<AndroidExternalRunnerWarning | null> {
  try {
    // Accept either a callback-style execFile (production default) or an
    // async shim (unit tests). promisify on an async function returns a
    // never-resolving Promise (Node DEP0174), so when the caller passes a
    // function that already returns a Promise, use it directly.
    const bin = 'adb';
    const argv = [...serialArgs, 'shell', 'ps', '-A'];
    const opts = { timeout: 2_000, encoding: 'utf8' as const };
    const run =
      execFileImpl === execFile
        ? promisify(execFileImpl)
        : (execFileImpl as unknown as (
            b: string,
            a: string[],
            o: typeof opts,
          ) => Promise<{ stdout: string }>);
    const { stdout } = await run(bin, argv, opts);
    const lines = stdout
      .split('\n')
      .filter((line) => /uiautomator|agent-device|AgentDevice/i.test(line))
      .filter((line) => !/dev\.lykhoyda\.rndevagent\.androidrunner/.test(line));

    if (lines.length === 0) return null;

    return {
      platform: 'android',
      code: 'ANDROID_UIAUTOMATOR_COMPETITOR',
      message:
        'A competing Android UIAutomator or agent-device process is running. Stop it (or opt out of the in-tree runner with RN_ANDROID_RUNNER=0) to avoid focus and input contention.',
      processLines: lines,
    };
  } catch {
    return null;
  }
}

export interface IosExternalRunnerWarning {
  platform: 'ios';
  code: 'IOS_XCUITEST_COMPETITOR';
  message: string;
  processLines: string[];
}

// Validated against live `ps` (2026-06-04): identify the executable/process
// structure, not arbitrary prompt text elsewhere in argv. Long-running coding
// agents commonly carry words such as Maestro/WebDriverAgent and a simulator
// UDID in their prompt; token-scanning their complete command line self-matches.
// XCTRunner remains intentionally too generic.
function executableBasename(command: string): string {
  const executable = command.trimStart().split(/\s+/, 1)[0] ?? '';
  return executable.slice(executable.lastIndexOf('/') + 1);
}

const SHELL_WRAPPERS = /^(?:sh|bash|zsh|dash|ksh|env)$/i;
const MAESTRO_JAVA_ENTRYPOINT_RE = /(?:^|\s)maestro\.cli\.[\w.$]+(?:\s|$)/i;

// `/bin/sh /usr/local/bin/maestro test flow.yaml` — the installed CLI is
// routinely a shell wrapper, so the basename of argv[0] is the shell.
function shellWrappedMaestro(command: string): boolean {
  const tokens = command.trimStart().split(/\s+/);
  if (!SHELL_WRAPPERS.test(executableBasename(tokens[0] ?? ''))) return false;
  return tokens
    .slice(1)
    .some(
      (token) => token.startsWith('/') && /^maestro(?:\.\w+)?$/i.test(executableBasename(token)),
    );
}

export function isIosExternalRunnerProcessLine(line: string): boolean {
  const match = line.match(/^\s*\d+\s+(.+)$/);
  if (!match) return false;
  const command = match[1];
  const executable = executableBasename(command);

  if (/^maestro(?:-driver-iosUITests-Runner)?$/i.test(executable)) return true;
  if (shellWrappedMaestro(command)) return true;
  if (/^WebDriverAgent(?:Runner)?(?:-Runner)?$/i.test(executable)) return true;
  if (/^java$/i.test(executable) && MAESTRO_JAVA_ENTRYPOINT_RE.test(command)) {
    return true;
  }
  if (
    /^xcodebuild$/i.test(executable) &&
    /(?:maestro[^\s]*|WebDriverAgent[^\s]*)\.xctestrun(?:\s|$)/i.test(command)
  ) {
    return true;
  }
  return false;
}

const RN_FAST_RUNNER_RE = /RnFastRunner/i;

const IOS_PS_OPTIONS = { timeout: 2_000, maxBuffer: 1024 * 1024, encoding: 'utf8' as const };

function readIosProcesses(
  execFileImpl: typeof execFile,
): Promise<{ stdout: string; stderr?: string }> {
  const run =
    execFileImpl === execFile
      ? promisify(execFileImpl)
      : (execFileImpl as unknown as (
          b: string,
          a: string[],
          o: typeof IOS_PS_OPTIONS,
        ) => Promise<{ stdout: string; stderr?: string }>);
  // Unlimited column width keeps simulator identities in long executable paths intact.
  return run('ps', ['axww', '-o', 'pid=,command='], IOS_PS_OPTIONS);
}

export type IosStrictRunnerStatus = 'clear' | 'busy' | 'unknown';

export function isIosSimulatorUdid(value: string): boolean {
  return (
    value.length === 36 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

function isIosStrictRunnerProcessLine(line: string): boolean {
  const command = line.replace(/^\s*\d+\s+/, '');
  const executable = executableBasename(command);
  // Legacy shell detection scans argv; strict admission cannot attribute those path mentions.
  if (SHELL_WRAPPERS.test(executable)) return false;
  if (isIosExternalRunnerProcessLine(line)) return true;
  if (/^(?:RnFastRunner[^/]*|XCTRunner|.*UITests-Runner)$/i.test(executable)) return true;
  return (
    /^xcodebuild$/i.test(executable) &&
    /(?:^|\s)(?:test|test-without-building)(?:\s|$)/.test(command)
  );
}

function hasUnresolvedIosPath(command: string): boolean {
  if (command.length > 16_384) return true;
  const components = command.split('/').slice(1);
  const hasMaestroJavaEntrypoint = MAESTRO_JAVA_ENTRYPOINT_RE.test(command);
  // Unescaped path fragments justify unknown, never an executable identity or busy verdict.
  for (const [index, component] of components.entries()) {
    if (
      /^(?:maestro(?:-driver-iosUITests-Runner|\.\w+)?|WebDriverAgent(?:Runner)?(?:-Runner)?|RnFastRunner\S*|XCTRunner|xcodebuild|\S*UITests-?Runner)(?=$|[\s"'])/i.test(
        component,
      ) ||
      (index < components.length - 1 && /(?:UITests-?Runner|XCTRunner)\.app/i.test(component)) ||
      (hasMaestroJavaEntrypoint && /^java(?=$|[\s"'])/i.test(component))
    )
      return true;
  }
  return false;
}

function leadingShellWord(command: string): { word: string; rest: string } | null {
  const match = /^(?:"([^"]*)"|'([^']*)'|(\S+))(?:\s+|$)/.exec(command);
  return match
    ? { word: match[1] ?? match[2] ?? match[3], rest: command.slice(match[0].length) }
    : null;
}

function hasUnresolvedIosShellScript(command: string): boolean {
  const shell = leadingShellWord(command);
  if (!shell || !SHELL_WRAPPERS.test(executableBasename(shell.word))) return false;
  let rest = shell.rest;
  for (let options = 0; options < 16; options++) {
    if (!rest) return false;
    const next = leadingShellWord(rest);
    if (!next) return true;
    const { word } = next;
    if (word === '--') return hasUnresolvedIosPath(next.rest);
    if (executableBasename(shell.word) === 'env' && /^(?:-|\w+=)/.test(word)) return true;
    if (!/^[+-]/.test(word)) return hasUnresolvedIosPath(rest);
    // Command strings and stdin are not script operands; never scan their contents.
    if (/^-[a-zA-Z]*[cs][a-zA-Z]*$/.test(word) || /^--command(?:=|$)/.test(word)) return false;
    rest = next.rest;
    if (/^[+-][oO]$/.test(word)) {
      const option = leadingShellWord(rest);
      if (!option || !/^[a-zA-Z][\w-]*$/.test(option.word)) return true;
      rest = option.rest;
    } else if (
      !/^(?:[+-][aefhiklmnpruvxBCEHPT]+|--(?:noprofile|norc|posix|restricted|verbose|login))$/.test(
        word,
      )
    ) {
      return true;
    }
  }
  return true;
}

function hasUnresolvedIosExecutablePath(line: string): boolean {
  const command = line.replace(/^\s*\d+\s+/, '');
  return hasUnresolvedIosPath(command) || hasUnresolvedIosShellScript(command);
}

export type ProcessIdentityObserver = (pid: number, timeoutMs: number) => Promise<unknown>;

function identityRulesOutDriver(value: unknown, line: string, scanStartedAt: number): boolean {
  if (!value || typeof value !== 'object') return false;
  const observation = value as Record<string, unknown>;
  const match = /^\s*(\d+)\s+(.+)$/.exec(line);
  if (!match || observation.v !== 1 || observation.pid !== Number(match[1])) return false;
  if (!observation.birth || typeof observation.birth !== 'object') return false;
  const { seconds, micros } = observation.birth as Record<string, unknown>;
  if (
    typeof seconds !== 'number' ||
    !Number.isSafeInteger(seconds) ||
    seconds <= 0 ||
    typeof micros !== 'number' ||
    !Number.isInteger(micros) ||
    micros < 0 ||
    micros >= 1_000_000 ||
    seconds * 1_000 + Math.ceil(micros / 1_000) > scanStartedAt
  )
    return false;
  const executable = observation.executable;
  if (
    typeof executable !== 'string' ||
    !executable.startsWith('/') ||
    executable.endsWith('/') ||
    Buffer.byteLength(executable) >= 4096 ||
    // eslint-disable-next-line no-control-regex -- Kernel paths must remain an unambiguous single field.
    /[\x00-\x1f\x7f\ufffd]/.test(executable)
  )
    return false;
  const name = executable.slice(executable.lastIndexOf('/') + 1);
  if (
    SHELL_WRAPPERS.test(name) ||
    /^(?:java|node|nodejs|python[\d.]*|ruby[\d.]*|perl[\d.]*|osascript)$/i.test(name) ||
    /UITests-?Runner$/i.test(name) ||
    hasUnresolvedIosPath(executable)
  )
    return false;
  // Match the observed executable, not a path or driver name embedded in an argument.
  return [executable, name].some(
    (identity) => match[2] === identity || match[2].startsWith(`${identity} `),
  );
}

// Known-pattern observation only: a clear scan is not an external coordination lease.
export async function probeIosExternalRunnerStrict(
  execFileImpl: typeof execFile = execFile,
  udid?: string,
  observeIdentity?: ProcessIdentityObserver,
): Promise<IosStrictRunnerStatus> {
  if (!udid || !isIosSimulatorUdid(udid)) return 'unknown';
  const scanStartedAt = Date.now();
  const deadline = performance.now() + 20_000;
  try {
    const { stdout, stderr } = await readIosProcesses(execFileImpl);
    if (
      typeof stdout !== 'string' ||
      (stderr !== undefined && stderr !== '') ||
      !stdout.endsWith('\n') ||
      Buffer.byteLength(stdout) > IOS_PS_OPTIONS.maxBuffer ||
      // eslint-disable-next-line no-control-regex -- Corrupt process-table bytes must fail closed.
      /[\x00-\x08\x0b-\x1f\x7f\ufffd]/.test(stdout)
    )
      return 'unknown';

    const lines = stdout.slice(0, -1).split('\n');
    const pids = new Set<number>();
    for (const line of lines) {
      const match = /^\s*([1-9]\d*)[ \t]+(\S[^\n]*)$/.exec(line);
      if (!match) return 'unknown';
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pids.has(pid)) return 'unknown';
      pids.add(pid);
    }
    const drivers = lines.filter(isIosStrictRunnerProcessLine);
    if (drivers.length === 0) {
      const unresolved = lines.filter(hasUnresolvedIosExecutablePath);
      if (!unresolved.length) return 'clear';
      if (!observeIdentity || unresolved.length > 16) return 'unknown';
      for (const line of unresolved) {
        const remaining = Math.floor(deadline - performance.now());
        if (remaining <= 0) return 'unknown';
        const pid = Number(/^\s*(\d+)/.exec(line)![1]);
        const observation = await observeIdentity(pid, Math.min(1_000, remaining));
        if (
          performance.now() >= deadline ||
          !identityRulesOutDriver(observation, line, scanStartedAt)
        )
          return 'unknown';
      }
      return 'clear';
    }
    const target = new RegExp(`(?:^|[^a-z0-9-])${udid}(?=$|[^a-z0-9-])`, 'i');
    // Unmatched drivers remain unknown, even if another UUID appears in their arguments.
    return drivers.some((line) => target.test(line)) ? 'busy' : 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function detectIosExternalRunner(
  execFileImpl: typeof execFile = execFile,
  udid?: string,
): Promise<IosExternalRunnerWarning | null> {
  try {
    const { stdout } = await readIosProcesses(execFileImpl);
    const lines = stdout
      .split('\n')
      .filter((line) => isIosExternalRunnerProcessLine(line))
      .filter((line) => !RN_FAST_RUNNER_RE.test(line))
      .filter((line) => (udid ? line.includes(udid) : true))
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length === 0) return null;

    return {
      platform: 'ios',
      code: 'IOS_XCUITEST_COMPETITOR',
      message:
        'A foreign maestro/WebDriverAgent automation session is driving this simulator. ' +
        'Interleaving device_* with it may trigger a re-foreground of your app; CDP reads are unaffected. ' +
        '(If this is your own maestro flow, it is expected.)',
      processLines: lines,
    };
  } catch {
    return null;
  }
}

export interface ForeignRunnerNotice {
  meta: { foreignRunner: { code: string; message: string; processLines: string[] } };
  warning: string;
}

/**
 * GH#202 Phase 3: decide whether to surface a proactive foreign-runner heads-up
 * on an iOS device-session open. Returns null when there's nothing to say:
 *   - we currently hold the arbiter flow lease (the detected maestro driver is
 *     then our OWN L3 run, not a foreign session), OR
 *   - no foreign process was detected.
 * Informational only — the caller never blocks the open on this.
 */
export function foreignRunnerNotice(
  detection: IosExternalRunnerWarning | null,
  flowLeaseHeld: boolean,
): ForeignRunnerNotice | null {
  if (flowLeaseHeld) return null;
  if (!detection) return null;
  return {
    meta: {
      foreignRunner: {
        code: detection.code,
        message: detection.message,
        processLines: detection.processLines,
      },
    },
    warning: `FOREIGN_RUNNER_ACTIVE: ${detection.message}`,
  };
}
