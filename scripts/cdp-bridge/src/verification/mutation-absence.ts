import type { CDPClient } from '../cdp-client.js';
import type { ToolResult } from '../utils.js';
import { attachVerificationWarning } from './envelope.js';

// GH #91 / D688: mutation-absence detector. Catches the IX-2950 verification-
// fidelity failure where an agent reaches a "success-shape" screen
// (OrderConfirmation, AddPolicySuccess, ...) via deep-link or state-injection
// without the user-flow's underlying server mutation actually firing.
//
// Reads from the existing CDP network buffer (no new event handlers). Wires
// into 3 nav-aware tools (cdp_navigate, cdp_navigation_state, proof_step) and
// attaches a `meta.verification_warning` field when:
//   1. The currently-active screen name matches the success-shape regex.
//   2. This is a TRANSITION (different from the previous observation for this
//      device) — never warn on first observation.
//   3. The 5-second rolling window of mutation network calls is empty.
//
// Multi-LLM brainstorm consensus (Codex + Gemini + Claude verified):
// - State lives in a module-level Map keyed by `${metroPort}-${targetId}`,
//   matching the existing NetworkBufferManager pattern (D657/B128). Survives
//   soft-reconnect; resets naturally on force-reconnect (deviceKey changes).
// - Mutation count uses `client.networkBufferManager.filter(...)` so we get
//   per-device scoping for free.
// - Filter status: include pending (`status === undefined`) AND 2xx/3xx so
//   failed mutations (5xx) don't silence the detector — Gemini's catch.
// - Edge-trigger only; first observation primes the signature without warning.

const DEFAULT_WINDOW_MS = 5_000;

// Gemini review (conf 85): pending mutations (status === undefined) are
// captured at requestWillBeSent and only get their final status at
// responseReceived. Counting ALL pending entries as success would silence
// warnings for in-flight requests that are about to 5xx. Mitigation: only
// recently-fired pending entries count as in-flight success (the optimistic-UI
// case where the screen renders ~100-300ms after the POST starts). Older
// pendings are suspect — likely hung or silently failed — and don't count.
const MAX_PENDING_AGE_MS = 2_000;

// Suffix-match against the LAST path segment so both Expo Router
// (/orders/[id]/confirmation) and React Navigation (OrderConfirmation) work.
const SUCCESS_SHAPE_REGEX = /(success|done|added|complete|completed|confirmation)$/i;

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Codex review conf 90: cap regex input length to bound evaluation cost on the
// cdp_navigate / cdp_navigation_state / proof_step hot path. The success-shape
// match only cares about the END of the string, so slicing the tail keeps the
// information that matters. Pair with the per-pattern source cap in config.ts.
const MAX_NAME_LENGTH = 256;

interface DetectorState {
  lastSignature: string | null;
}

const stateByDevice = new Map<string, DetectorState>();

export interface VerificationWarning {
  code: 'MUTATION_ABSENCE';
  screen: string;
  source: string;
  window_ms: number;
  mutations_observed: number;
  last_mutation_age_ms: number | null;
  hint: string;
}

export interface AnnotateContext {
  client: CDPClient;
  /** The currently-active screen name (topmost route or last path segment). */
  screenName: string | null;
  /** Which tool produced this observation (for the warning's `source` field). */
  source: 'cdp_navigate' | 'cdp_navigation_state' | 'proof_step';
  /** Override the default 5_000ms window for tests / future per-project config. */
  windowMs?: number;
  /** Inject a clock for deterministic tests. */
  now?: () => number;
  /** GH #91 acceptance #3: per-project successShapes override; null/undefined → built-in. */
  successShapes?: RegExp | null;
  /** GH #91 acceptance #3: per-project mutationMethods override; null/undefined → built-in. */
  mutationMethods?: Set<string> | null;
}

/**
 * Pure helper: normalize an arbitrary route name string for success-shape
 * matching. For Expo Router path-style strings, take the last non-empty
 * segment. For React Navigation name-style strings, return as-is. Returns
 * lowercase already so the regex stays simple.
 */
export function normalizeRouteName(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const segments = trimmed.split('/').filter(Boolean);
  const candidate = segments.length > 0 ? segments[segments.length - 1] : trimmed;
  // Slice the tail rather than the head — success-shape matching cares about
  // the end of the string, so any input over MAX_NAME_LENGTH still has its
  // signal-bearing suffix preserved.
  const bounded =
    candidate.length > MAX_NAME_LENGTH
      ? candidate.slice(candidate.length - MAX_NAME_LENGTH)
      : candidate;
  return bounded.toLowerCase();
}

export function isSuccessShape(
  rawName: string | null | undefined,
  regex: RegExp = SUCCESS_SHAPE_REGEX,
): boolean {
  const normalized = normalizeRouteName(rawName);
  if (!normalized) return false;
  return regex.test(normalized);
}

/**
 * Pure: check the current device's mutation buffer against the window. Returns
 * the in-window count and (when zero) the age of the most-recent mutation
 * regardless of window — useful diagnostic so callers can tell "I missed by
 * 0.5s" from "I never had a mutation in this session at all".
 */
export function countWindowedMutations(
  client: CDPClient,
  windowMs: number,
  now: number,
  methods: Set<string> = MUTATION_METHODS,
): { inWindow: number; lastMutationAgeMs: number | null } {
  const deviceKey = client.activeDeviceKey;
  const sinceISO = new Date(now - windowMs).toISOString();
  // Filter by the broader "is mutation" predicate first so we can also
  // compute last_mutation_age_ms from the same scan.
  const allMutations = client.networkBufferManager.filter(deviceKey, (entry) => {
    const method = (entry.method ?? '').toUpperCase();
    if (!methods.has(method)) return false;
    // Skip failed mutations (>= 400). For pending entries (status === undefined),
    // only count if recently-fired — older pendings are suspect (likely hung
    // or silently failed) and shouldn't be treated as in-flight success.
    const status = entry.status;
    if (status === undefined) {
      const t = Date.parse(entry.timestamp);
      return Number.isFinite(t) && now - t <= MAX_PENDING_AGE_MS;
    }
    return status >= 200 && status < 400;
  });
  const inWindow = allMutations.filter((e) => e.timestamp >= sinceISO).length;
  if (inWindow > 0) return { inWindow, lastMutationAgeMs: 0 };
  let lastMutationAgeMs: number | null = null;
  if (allMutations.length > 0) {
    const mostRecent = allMutations[allMutations.length - 1];
    const t = Date.parse(mostRecent.timestamp);
    lastMutationAgeMs = Number.isFinite(t) ? Math.max(0, now - t) : null;
  }
  return { inWindow: 0, lastMutationAgeMs };
}

/**
 * Augment a tool result with `meta.verification_warning` if the conditions
 * fire. Returns the result unchanged on first observation (priming) or when
 * the screen isn't a success shape or the window has any qualifying mutation.
 *
 * Never throws; on parse failure returns the original result so a buggy
 * envelope shape can't break tools.
 */
export function annotateMutationAbsence(result: ToolResult, ctx: AnnotateContext): ToolResult {
  if (result.isError) return result;

  const deviceKey = ctx.client.activeDeviceKey;
  // Edge-trigger using ONLY the active screen name. Stack-hash signatures
  // were considered (Codex) but the spec only cares about the topmost route
  // for the success-shape match — keeping signature == name is simpler and
  // dodges param-only-rerender false positives.
  const signature = ctx.screenName ?? '';
  const prev = stateByDevice.get(deviceKey);
  if (!prev) {
    // First observation primes; never warns. (Reduces the "user navigates
    // to OrderConfirmation because they're VIEWING an existing order"
    // false-positive class.)
    stateByDevice.set(deviceKey, { lastSignature: signature });
    return result;
  }
  if (prev.lastSignature === signature) return result;
  prev.lastSignature = signature;

  const successRegex = ctx.successShapes ?? SUCCESS_SHAPE_REGEX;
  if (!isSuccessShape(ctx.screenName, successRegex)) return result;

  const windowMs = ctx.windowMs ?? DEFAULT_WINDOW_MS;
  const now = (ctx.now ?? Date.now)();
  const methods = ctx.mutationMethods ?? MUTATION_METHODS;
  const { inWindow, lastMutationAgeMs } = countWindowedMutations(
    ctx.client,
    windowMs,
    now,
    methods,
  );
  if (inWindow > 0) return result;

  const hint =
    lastMutationAgeMs !== null && lastMutationAgeMs < windowMs * 3
      ? `Most recent mutation was ${lastMutationAgeMs}ms ago — outside the ${windowMs}ms window. If this is an optimistic UI flow, the mutation may have completed before the screen change observation; consider running the verification immediately after navigation.`
      : `Success-shape screen reached without a preceding write request in the last ${windowMs}ms. If the path under verification involves a server-side mutation, the user-flow may not have actually executed (deep-link bypass, state injection, or pre-existing state matching the success shape). Use cdp_network_log to confirm whether the expected mutation actually fired.`;

  const warning: VerificationWarning = {
    code: 'MUTATION_ABSENCE',
    screen: ctx.screenName ?? 'unknown',
    source: ctx.source,
    window_ms: windowMs,
    mutations_observed: 0,
    last_mutation_age_ms: lastMutationAgeMs,
    hint,
  };

  return attachVerificationWarning(result, warning);
}

/** Test seam: clear the per-device state map. Not exported via index.ts. */
export function _resetForTests(): void {
  stateByDevice.clear();
}
