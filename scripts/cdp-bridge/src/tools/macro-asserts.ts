// D1206 Tier 2 Sprint B — Macro-Asserts.
//
// State-assertive primitives that wrap CDP introspection (Redux/Zustand
// store state, navigation state) and device snapshot (testID / visible-
// text presence) with assertion semantics. Returns failResult on
// assertion miss with the actual value, expected operator, and
// remediation hint.
//
// Why these matter: Maestro asserts pixels. These assert internal app
// state — the differentiated capability the plugin owns over Maestro
// Cloud / KaneAI / BrowserStack (D1206). Used both directly by the LLM
// during interactive walks and (eventually) embedded in Maestro flows
// via runScript: shell-out to the future CLI surface.

import type { CDPClient } from '../cdp-client.js';
import { okResult, failResult, withConnection, withSession } from '../utils.js';
import type { ToolResult } from '../utils.js';
import { runAgentDevice } from '../agent-device-wrapper.js';
import { findRefByTestID } from './device-batch.js';

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers — testable in isolation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deep-equal sufficient for assertion use cases (primitives, arrays, plain
 * objects). Doesn't handle Date/RegExp/Map/Set/circular — store state we
 * read via cdp is JSON-serialized, so those can't appear.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const oa = a as Record<string, unknown>;
  const ob = b as Record<string, unknown>;
  const ka = Object.keys(oa);
  const kb = Object.keys(ob);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!deepEqual(oa[k], ob[k])) return false;
  return true;
}

export interface ReduxAssertions {
  equals?: unknown;
  exists?: boolean;
  notExists?: boolean;
  length?: number;
  contains?: unknown;
  gt?: number;
  lt?: number;
  gte?: number;
  lte?: number;
}

export interface AssertionFailure {
  op: keyof ReduxAssertions;
  expected: unknown;
  actual: unknown;
}

export function evaluateReduxAssertions(
  actual: unknown,
  assertions: ReduxAssertions,
): { matched: true } | { matched: false; failure: AssertionFailure } {
  // exists is the implicit default if nothing else is asserted.
  const ops = Object.keys(assertions).filter((k) => assertions[k as keyof ReduxAssertions] !== undefined);
  if (ops.length === 0) {
    if (actual === undefined || actual === null) {
      return { matched: false, failure: { op: 'exists', expected: true, actual } };
    }
    return { matched: true };
  }
  for (const op of ops as Array<keyof ReduxAssertions>) {
    const expected = assertions[op];
    let pass = false;
    switch (op) {
      case 'equals':
        pass = deepEqual(actual, expected);
        break;
      case 'exists':
        pass = expected ? actual !== undefined && actual !== null : actual === undefined || actual === null;
        break;
      case 'notExists':
        pass = expected ? actual === undefined || actual === null : actual !== undefined && actual !== null;
        break;
      case 'length':
        pass = (Array.isArray(actual) || typeof actual === 'string') && (actual as { length: number }).length === expected;
        break;
      case 'contains':
        pass = Array.isArray(actual) && actual.some((x) => deepEqual(x, expected));
        break;
      case 'gt':
        pass = typeof actual === 'number' && actual > (expected as number);
        break;
      case 'lt':
        pass = typeof actual === 'number' && actual < (expected as number);
        break;
      case 'gte':
        pass = typeof actual === 'number' && actual >= (expected as number);
        break;
      case 'lte':
        pass = typeof actual === 'number' && actual <= (expected as number);
        break;
    }
    if (!pass) return { matched: false, failure: { op, expected, actual } };
  }
  return { matched: true };
}

export interface RouteAssertions {
  name?: string;
  paramsEquals?: unknown;
  inStack?: string;
}

export interface RouteFailure {
  field: 'name' | 'params' | 'inStack';
  expected: unknown;
  actual: unknown;
}

export function evaluateRouteAssertions(
  navState: { routeName?: string; params?: unknown; routes?: Array<{ name?: string }> },
  assertions: RouteAssertions,
): { matched: true } | { matched: false; failure: RouteFailure } {
  if (assertions.name !== undefined) {
    if (navState.routeName !== assertions.name) {
      return { matched: false, failure: { field: 'name', expected: assertions.name, actual: navState.routeName } };
    }
  }
  if (assertions.paramsEquals !== undefined) {
    if (!deepEqual(navState.params, assertions.paramsEquals)) {
      return { matched: false, failure: { field: 'params', expected: assertions.paramsEquals, actual: navState.params } };
    }
  }
  if (assertions.inStack !== undefined) {
    const stack = (navState.routes ?? []).map((r) => r?.name).filter((n): n is string => typeof n === 'string');
    if (!stack.includes(assertions.inStack)) {
      return { matched: false, failure: { field: 'inStack', expected: assertions.inStack, actual: stack } };
    }
  }
  return { matched: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Polling helper
// ─────────────────────────────────────────────────────────────────────────────

async function pollUntil<T>(
  fn: () => Promise<{ matched: boolean; result: T }>,
  timeoutMs: number,
  intervalMs: number = 200,
): Promise<{ matched: boolean; result: T }> {
  const start = Date.now();
  while (true) {
    const out = await fn();
    if (out.matched) return out;
    if (timeoutMs <= 0 || Date.now() - start >= timeoutMs) return out;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// expect_redux
// ─────────────────────────────────────────────────────────────────────────────

export interface ExpectReduxArgs {
  path: string;
  storeType?: string;
  equals?: unknown;
  exists?: boolean;
  notExists?: boolean;
  length?: number;
  contains?: unknown;
  gt?: number;
  lt?: number;
  gte?: number;
  lte?: number;
  timeoutMs?: number;
}

export function createExpectReduxHandler(getClient: () => CDPClient) {
  return withConnection(getClient, async (args: ExpectReduxArgs, client) => {
    if (!args.path || typeof args.path !== 'string') {
      return failResult('expect_redux requires a path (e.g. "cart.items")');
    }
    const assertions: ReduxAssertions = {
      equals: args.equals,
      exists: args.exists,
      notExists: args.notExists,
      length: args.length,
      contains: args.contains,
      gt: args.gt,
      lt: args.lt,
      gte: args.gte,
      lte: args.lte,
    };
    const pathArg = JSON.stringify(args.path);
    const typeArg = args.storeType ? JSON.stringify(args.storeType) : 'undefined';
    const expression = client.bridgeWithFallback(`getStoreState(${pathArg}, ${typeArg})`);

    const probe = async (): Promise<{ matched: boolean; result: { actual: unknown; eval: ReturnType<typeof evaluateReduxAssertions> } }> => {
      const result = await client.evaluate(expression);
      if (result.error || typeof result.value !== 'string') {
        return { matched: false, result: { actual: undefined, eval: { matched: false, failure: { op: 'exists', expected: true, actual: undefined } } } };
      }
      let actual: unknown = undefined;
      try {
        actual = JSON.parse(result.value);
        if (actual !== null && typeof actual === 'object' && '__agent_truncated' in (actual as Record<string, unknown>)) {
          // Truncated — assertions on full payload aren't safe; treat as fail with hint.
          return { matched: false, result: { actual: '<truncated>', eval: { matched: false, failure: { op: 'exists', expected: 'untruncated value', actual: '<truncated>' } } } };
        }
      } catch {
        actual = result.value;
      }
      const ev = evaluateReduxAssertions(actual, assertions);
      return { matched: ev.matched, result: { actual, eval: ev } };
    };

    const polled = await pollUntil(probe, args.timeoutMs ?? 0);
    const { actual, eval: ev } = polled.result;

    if (ev.matched) {
      return okResult({ matched: true, path: args.path, actual });
    }
    return failResult(
      `expect_redux assertion failed at ${args.path}: ${ev.failure.op}`,
      {
        code: 'ASSERTION_FAILED',
        path: args.path,
        actual,
        expected: ev.failure.expected,
        op: ev.failure.op,
        hint: 'If state is async (post-mutation), pass timeoutMs (e.g. 1000) to retry. If the path is wrong, call cdp_store_state without operators to inspect the shape.',
      },
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// expect_route
// ─────────────────────────────────────────────────────────────────────────────

export interface ExpectRouteArgs {
  name?: string;
  paramsEquals?: unknown;
  inStack?: string;
  timeoutMs?: number;
}

export function createExpectRouteHandler(getClient: () => CDPClient) {
  return withConnection(getClient, async (args: ExpectRouteArgs, client) => {
    if (args.name === undefined && args.paramsEquals === undefined && args.inStack === undefined) {
      return failResult('expect_route requires at least one of: name, paramsEquals, inStack');
    }

    const probe = async (): Promise<{ matched: boolean; result: { navState: unknown; eval: ReturnType<typeof evaluateRouteAssertions> } }> => {
      const result = await client.evaluate(client.helperExpr('getNavState()'));
      if (result.error || typeof result.value !== 'string') {
        return { matched: false, result: { navState: { error: result.error ?? 'no nav state' }, eval: { matched: false, failure: { field: 'name', expected: args.name, actual: undefined } } } };
      }
      let parsed: { routeName?: string; params?: unknown; routes?: Array<{ name?: string }> };
      try {
        parsed = JSON.parse(result.value);
      } catch {
        return { matched: false, result: { navState: { error: 'malformed nav state' }, eval: { matched: false, failure: { field: 'name', expected: args.name, actual: undefined } } } };
      }
      const ev = evaluateRouteAssertions(parsed, args);
      return { matched: ev.matched, result: { navState: parsed, eval: ev } };
    };

    const polled = await pollUntil(probe, args.timeoutMs ?? 0);
    const { navState, eval: ev } = polled.result;

    if (ev.matched) {
      return okResult({ matched: true, navState });
    }
    return failResult(
      `expect_route assertion failed: ${ev.failure.field}`,
      {
        code: 'ASSERTION_FAILED',
        field: ev.failure.field,
        actual: ev.failure.actual,
        expected: ev.failure.expected,
        navState,
        hint: 'Call cdp_navigation_state directly to inspect the full route tree. If a navigation animation is in flight, pass timeoutMs (e.g. 1000) to retry.',
      },
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// expect_visible_by_testid
// ─────────────────────────────────────────────────────────────────────────────

export interface ExpectVisibleByTestIDArgs {
  testID: string;
  exists?: boolean;       // default true
  timeoutMs?: number;
}

export function createExpectVisibleByTestIDHandler() {
  return withSession(async (args: ExpectVisibleByTestIDArgs): Promise<ToolResult> => {
    if (!args.testID || typeof args.testID !== 'string') {
      return failResult('expect_visible_by_testid requires testID');
    }
    const expectVisible = args.exists !== false; // default true

    const probe = async (): Promise<{ matched: boolean; result: { ref: string | null } }> => {
      const result = await runAgentDevice(['snapshot', '-i']);
      const envelope = result.content?.[0]?.text ?? '';
      const ref = findRefByTestID(envelope, args.testID);
      const visible = ref !== null;
      return { matched: visible === expectVisible, result: { ref } };
    };

    const polled = await pollUntil(probe, args.timeoutMs ?? 0);
    const { ref } = polled.result;
    const visible = ref !== null;

    if (polled.matched) {
      return okResult({ matched: true, testID: args.testID, visible, ref: ref ?? null });
    }
    return failResult(
      `expect_visible_by_testid: testID "${args.testID}" was ${visible ? 'visible' : 'NOT visible'}; expected ${expectVisible ? 'visible' : 'NOT visible'}`,
      {
        code: 'ASSERTION_FAILED',
        testID: args.testID,
        actualVisible: visible,
        expectedVisible: expectVisible,
        ref,
        hint: visible
          ? 'Element IS on screen but you expected it absent. Possible: stale modal, overlay not yet dismissed.'
          : 'Element is NOT on screen. Possible: animation in flight, mounted later, scrolled out of view. Pass timeoutMs (e.g. 2000) to retry, or call device_snapshot to see what IS rendered.',
      },
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// expect_text
// ─────────────────────────────────────────────────────────────────────────────

export interface ExpectTextArgs {
  text: string;
  exact?: boolean;        // default false (substring)
  exists?: boolean;       // default true
  timeoutMs?: number;
}

export function findRefsByText(snapshotEnvelope: string, text: string, exact: boolean): string[] {
  try {
    const env = JSON.parse(snapshotEnvelope) as { ok?: boolean; data?: { nodes?: Array<{ ref?: string; label?: string }> } };
    if (!env.ok) return [];
    const nodes = env.data?.nodes ?? [];
    const matches = nodes.filter((n) => {
      if (typeof n.label !== 'string') return false;
      if (exact) return n.label === text;
      return n.label.includes(text);
    });
    return matches.map((n) => n.ref).filter((r): r is string => typeof r === 'string');
  } catch {
    return [];
  }
}

export function createExpectTextHandler() {
  return withSession(async (args: ExpectTextArgs): Promise<ToolResult> => {
    if (!args.text || typeof args.text !== 'string') {
      return failResult('expect_text requires text');
    }
    const expectVisible = args.exists !== false;
    const exact = args.exact === true;

    const probe = async (): Promise<{ matched: boolean; result: { refs: string[] } }> => {
      const result = await runAgentDevice(['snapshot', '-i']);
      const envelope = result.content?.[0]?.text ?? '';
      const refs = findRefsByText(envelope, args.text, exact);
      const visible = refs.length > 0;
      return { matched: visible === expectVisible, result: { refs } };
    };

    const polled = await pollUntil(probe, args.timeoutMs ?? 0);
    const { refs } = polled.result;
    const visible = refs.length > 0;

    if (polled.matched) {
      return okResult({ matched: true, text: args.text, exact, visible, refs });
    }
    return failResult(
      `expect_text: text "${args.text}" was ${visible ? 'visible' : 'NOT visible'}; expected ${expectVisible ? 'visible' : 'NOT visible'}`,
      {
        code: 'ASSERTION_FAILED',
        text: args.text,
        exact,
        actualVisible: visible,
        expectedVisible: expectVisible,
        refs,
        hint: visible
          ? 'Text IS on screen but you expected it absent.'
          : 'Text is NOT on screen. Try exact=false for substring match, or device_snapshot to see what labels are rendered.',
      },
    );
  });
}
