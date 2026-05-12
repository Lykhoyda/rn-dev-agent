/**
 * Phase 134.1: Central Maestro flow validator (deepsec scan 2026-05-12).
 *
 * Every Maestro-emitting code path constructs flows via `buildMaestroFlow`;
 * every Maestro-executing path ingests YAML through `parseAndValidateFlow`.
 * Both enforce:
 *   - `appId` against a strict reverse-DNS regex (no newlines, no shell metachars)
 *   - All scalar values free of CR/LF, YAML document separators, unicode line breaks
 *   - Command keys against an allowlist
 *   - Denied commands (`runScript`, `evalScript`, `startRecording`,
 *     `stopRecording`) rejected by default — the primary RCE vectors in the
 *     prompt-injection threat model
 *
 * Closes 7 CRITICAL deepsec findings (RCE via raw YAML interpolation).
 * See workspace `docs/ROADMAP.md` Phase 134.1 + proposed D1212 for the
 * default-deny rationale.
 */
import yaml from 'yaml';

// ── Errors ──────────────────────────────────────────────────────────

export class MaestroValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaestroValidationError';
  }
}

// ── Bundle ID validation ────────────────────────────────────────────
// Reverse-DNS notation: each segment starts with a letter, then
// letters/digits/underscore. At least two segments. Matches both Android
// package IDs and iOS bundle identifiers in practice.

// Each segment starts with a letter and then [A-Za-z0-9_-]. Apple's
// CFBundleIdentifier docs allow hyphens; Expo apps commonly use them
// (e.g. `com.my-app.testapp`). Multi-LLM review caught the original
// hyphen-less regex as breaking real bundle IDs.
const BUNDLE_ID_RE = /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z][A-Za-z0-9_-]*)+$/;
const BUNDLE_ID_MAX_LEN = 256;

export function isValidBundleId(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  if (s.length === 0 || s.length >= BUNDLE_ID_MAX_LEN) return false;
  return BUNDLE_ID_RE.test(s);
}

export function assertValidBundleId(s: unknown, context: string): asserts s is string {
  if (!isValidBundleId(s)) {
    const preview = JSON.stringify(s).slice(0, 80);
    throw new MaestroValidationError(`Invalid bundle ID for ${context}: ${preview}`);
  }
}

// ── Scalar safety ───────────────────────────────────────────────────
// Rejects characters that would let a string escape its YAML scalar context
// (newlines, document separators, unicode line breaks, control characters).

const UNSAFE_SCALAR_RE = /[\u0000-\u0008\u000A-\u001F\u0085\u2028\u2029]/;
const SCALAR_MAX_LEN = 4096;

export function isSafeMaestroScalar(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  if (s.length > SCALAR_MAX_LEN) return false;
  if (UNSAFE_SCALAR_RE.test(s)) return false;
  // NOTE: we don't reject `---` as a substring. The actual document-separator
  // attack requires a newline-anchored `---`, already caught by the CR/LF
  // check above. `yaml.stringify` quotes any scalar containing tricky chars,
  // so mid-scalar `---` (e.g. "section --- title") is harmless when emitted
  // through buildMaestroFlow. Multi-LLM review caught this as a false positive.
  return true;
}

// ── Command allowlist ───────────────────────────────────────────────

const ALLOWED_COMMANDS = new Set<string>([
  'launchApp',
  'tapOn',
  'doubleTapOn',
  'longPressOn',
  'assertVisible',
  'assertNotVisible',
  'inputText',
  'eraseText',
  'scroll',
  'scrollUntilVisible',
  'swipe',
  // Multi-LLM review caught these: test-recorder-generators emits the
  // shorthand `- swipeUp` / `- swipeDown` / `- swipeLeft` / `- swipeRight`
  // top-level commands. Without these in the allowlist, every recorded
  // action containing a swipe would be refused at replay time. The
  // deepsec attack vector (newline-injected direction) is already
  // mitigated by isSafeMaestroScalar catching the embedded newline.
  'swipeUp',
  'swipeDown',
  'swipeLeft',
  'swipeRight',
  'back',
  'pressKey',
  'openLink',
  'waitForAnimationToEnd',
  'extendedWaitUntil',
  'hideKeyboard',
  'takeScreenshot',
  'clearState',
  'addMedia',
  'copyTextFrom',
  'pasteText',
  'travel',
  'setLocation',
  'setAirplaneMode',
  'killApp',
  'stopApp',
  'tap',
]);

const DENIED_COMMANDS = new Set<string>([
  'runScript',
  'evalScript',
  'startRecording',
  'stopRecording',
]);

// ── Builder ─────────────────────────────────────────────────────────

export interface MaestroFlowOptions {
  appId?: string;
}

export type MaestroCommand = Record<string, unknown>;

export function buildMaestroFlow(opts: MaestroFlowOptions, commands: unknown[]): string {
  if (opts.appId !== undefined) {
    assertValidBundleId(opts.appId, 'appId header');
  }
  for (const cmd of commands) {
    validateCommand(cmd);
  }
  const headerYaml = opts.appId ? yaml.stringify({ appId: opts.appId }) : '';
  const bodyYaml = yaml.stringify(commands);
  return `${headerYaml}---\n${bodyYaml}`;
}

function validateCommand(cmd: unknown): void {
  if (cmd === null || cmd === undefined) {
    throw new MaestroValidationError('Command is null/undefined');
  }
  if (typeof cmd === 'string') {
    if (!isSafeMaestroScalar(cmd)) {
      throw new MaestroValidationError(`Unsafe shorthand command: ${JSON.stringify(cmd).slice(0, 80)}`);
    }
    if (DENIED_COMMANDS.has(cmd)) {
      throw new MaestroValidationError(`Command not allowed (denied by default): ${cmd}`);
    }
    if (!ALLOWED_COMMANDS.has(cmd)) {
      throw new MaestroValidationError(`Command not in allowlist: ${cmd}`);
    }
    return;
  }
  if (typeof cmd !== 'object') {
    throw new MaestroValidationError(`Command is not an object or string: ${typeof cmd}`);
  }
  const keys = Object.keys(cmd as Record<string, unknown>);
  if (keys.length !== 1) {
    throw new MaestroValidationError(
      `Command must have exactly one root key, got ${keys.length}: ${keys.join(', ')}`,
    );
  }
  const key = keys[0];
  if (DENIED_COMMANDS.has(key)) {
    throw new MaestroValidationError(`Command not allowed (denied by default): ${key}`);
  }
  if (!ALLOWED_COMMANDS.has(key)) {
    throw new MaestroValidationError(`Command not in allowlist: ${key}`);
  }
  validateValue((cmd as Record<string, unknown>)[key]);
}

function validateValue(v: unknown): void {
  if (v === null || v === undefined) return;
  if (typeof v === 'boolean' || typeof v === 'number') return;
  if (typeof v === 'string') {
    if (!isSafeMaestroScalar(v)) {
      throw new MaestroValidationError(`Unsafe scalar value: ${JSON.stringify(v).slice(0, 80)}`);
    }
    return;
  }
  if (Array.isArray(v)) {
    for (const item of v) validateValue(item);
    return;
  }
  if (typeof v === 'object') {
    for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
      if (!isSafeMaestroScalar(key)) {
        throw new MaestroValidationError(`Unsafe scalar key: ${JSON.stringify(key).slice(0, 80)}`);
      }
      validateValue(value);
    }
    return;
  }
  throw new MaestroValidationError(`Unsupported value type: ${typeof v}`);
}

// ── Parser ──────────────────────────────────────────────────────────

export interface ParsedFlow {
  appId?: string;
  commands: unknown[];
  /** Canonical re-serialization through `buildMaestroFlow` — safe to write to disk. */
  raw: string;
}

export interface ParseAndValidateOptions {
  /** Reject flows that include an `appId` header. Default `false`. */
  rejectHeader?: boolean;
}

export function parseAndValidateFlow(yamlText: string, opts: ParseAndValidateOptions = {}): ParsedFlow {
  let docs;
  try {
    docs = yaml.parseAllDocuments(yamlText, { strict: true });
  } catch (err) {
    throw new MaestroValidationError(`YAML parse error: ${(err as Error).message}`);
  }
  if (docs.length === 0) {
    throw new MaestroValidationError('Empty Maestro flow');
  }

  let appId: string | undefined;
  let body: unknown;
  if (docs.length === 1) {
    body = docs[0].toJS();
  } else {
    const header = docs[0].toJS() ?? {};
    if (header && typeof header === 'object' && 'appId' in header) {
      if (opts.rejectHeader) {
        throw new MaestroValidationError('Header (appId) not allowed in this context');
      }
      const rawAppId = (header as Record<string, unknown>).appId;
      assertValidBundleId(rawAppId, 'parsed flow header');
      appId = rawAppId;
    }
    body = docs[docs.length - 1].toJS();
  }

  if (body === null || body === undefined) {
    body = [];
  }
  if (!Array.isArray(body)) {
    throw new MaestroValidationError(`Flow body must be an array, got ${typeof body}`);
  }
  for (const cmd of body) {
    validateCommand(cmd);
  }

  const raw = buildMaestroFlow(appId !== undefined ? { appId } : {}, body);
  return { appId, commands: body, raw };
}
