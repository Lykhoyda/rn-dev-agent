// M6 / Phase 112 (D669): cdp_record_test_* tool family.
//
// Seven tools that wrap the Object.freeze interceptor in test-recorder-helpers
// and produce replayable test code via test-recorder-generators. State is
// module-level (storedEvents) — MCP is single-client-per-process so we don't
// need per-session isolation.

import type { CDPClient } from '../cdp-client.js';
import { okResult, failResult, withConnection } from '../utils.js';
import type { ToolResult } from '../utils.js';
import { findProjectRoot } from '../nav-graph/storage.js';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEV_CHECK_JS,
  START_RECORDING_JS,
  STOP_RECORDING_JS,
  buildAnnotationJs,
} from '../cdp/test-recorder-helpers.js';
import {
  generateMaestro,
  generateDetox,
  type GenerateOpts,
} from './test-recorder-generators.js';

export type RecordedEvent =
  | { type: 'tap';        testID?: string | null; label?: string | null; route?: string | null; t: number }
  | { type: 'long_press'; testID?: string | null; label?: string | null; route?: string | null; t: number }
  | { type: 'type';       testID?: string | null; label?: string | null; value: string;          route?: string | null; t: number }
  | { type: 'submit';     testID?: string | null; label?: string | null; route?: string | null; t: number }
  | { type: 'swipe';      direction: 'up' | 'down' | 'left' | 'right'; testID?: string | null; route?: string | null; t: number }
  | { type: 'navigate';   from?: string | null; to: string; route?: string | null; t: number }
  | { type: 'annotation'; note: string; route?: string | null; t: number };

// --- Module state ---
// Shared across the 7 tool handlers — reset on start, written on stop, read by
// generate / save. Test-only setters exposed at the bottom of this file for
// hermetic integration tests.

let storedEvents: RecordedEvent[] | null = null;
let recordingTruncated = false;

// --- Pure helpers (easy to unit-test) ---

// Collapse consecutive duplicates: same-testID type bursts keep the latest
// value; identical-testID taps within 100ms collapse to one. Mirrors
// metro-mcp's deduplicateEvents but with explicit type guards.
export function deduplicateEvents(events: RecordedEvent[]): RecordedEvent[] {
  const out: RecordedEvent[] = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type === 'type') {
      const next = events[i + 1];
      if (
        next?.type === 'type' &&
        (next as { testID?: string | null }).testID === (ev as { testID?: string | null }).testID
      ) {
        continue;
      }
    }
    if (ev.type === 'tap') {
      const last = out[out.length - 1];
      if (
        last?.type === 'tap' &&
        (last as { testID?: string | null }).testID === (ev as { testID?: string | null }).testID &&
        ev.t - last.t < 100
      ) {
        continue;
      }
    }
    out.push(ev);
  }
  return out;
}

export function sanitizeFilename(name: string): string {
  return name.replace(/\.json$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function getRecordingsDir(rootResolver: () => string | null = findProjectRoot): string | null {
  const root = rootResolver();
  if (!root) return null;
  return join(root, '.rn-agent', 'recordings');
}

export function typeCounts(events: RecordedEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const ev of events) counts[ev.type] = (counts[ev.type] ?? 0) + 1;
  return counts;
}

// --- Handler factories ---

interface EvalResult {
  value?: unknown;
  error?: string;
}

async function probeDev(client: CDPClient): Promise<boolean> {
  const r = (await client.evaluate(DEV_CHECK_JS)) as EvalResult;
  return r.value === true;
}

const DEV_REQUIRED_MSG =
  'Recording requires __DEV__=true — release builds pre-freeze props at bundle time and cannot be intercepted';

export function createRecordTestStartHandler(getClient: () => CDPClient): (args: Record<string, never>) => Promise<ToolResult> {
  return withConnection(getClient, async (_args: Record<string, never>, client) => {
    if (!(await probeDev(client))) {
      return failResult(DEV_REQUIRED_MSG, 'DEV_MODE_REQUIRED');
    }
    const result = (await client.evaluate(START_RECORDING_JS)) as EvalResult;
    if (result.error) {
      return failResult(`Failed to start recording: ${result.error}`, 'EVAL_FAILED');
    }
    if (typeof result.value !== 'string') {
      return failResult('Unexpected response from START_RECORDING_JS — expected JSON string', 'BAD_RESPONSE');
    }
    let parsed: { ok?: boolean; error?: string; alreadyRunning?: boolean; activeRoute?: string | null };
    try {
      parsed = JSON.parse(result.value);
    } catch {
      return failResult(`Invalid JSON from start: ${String(result.value).slice(0, 200)}`, 'BAD_RESPONSE');
    }
    if (!parsed.ok) {
      return failResult(parsed.error ?? 'start failed', 'START_FAILED');
    }
    storedEvents = null;
    recordingTruncated = false;
    return okResult({
      started: true,
      alreadyRunning: !!parsed.alreadyRunning,
      activeRoute: parsed.activeRoute ?? null,
    });
  });
}

export function createRecordTestStopHandler(getClient: () => CDPClient): (args: Record<string, never>) => Promise<ToolResult> {
  return withConnection(getClient, async (_args: Record<string, never>, client) => {
    const result = (await client.evaluate(STOP_RECORDING_JS)) as EvalResult;
    if (result.error) {
      return failResult(`Failed to stop recording: ${result.error}`, 'EVAL_FAILED');
    }
    if (typeof result.value !== 'string') {
      return failResult('Unexpected response from STOP_RECORDING_JS — expected JSON string', 'BAD_RESPONSE');
    }
    let parsed: { ok?: boolean; events?: RecordedEvent[]; truncated?: boolean };
    try {
      parsed = JSON.parse(result.value);
    } catch {
      return failResult(`Invalid JSON from stop: ${String(result.value).slice(0, 200)}`, 'BAD_RESPONSE');
    }
    const raw = Array.isArray(parsed.events) ? parsed.events : [];
    storedEvents = deduplicateEvents(raw);
    recordingTruncated = !!parsed.truncated;
    return okResult({
      stopped: true,
      eventCount: storedEvents.length,
      truncated: recordingTruncated,
      typeCounts: typeCounts(storedEvents),
    });
  });
}

interface GenerateArgs extends GenerateOpts {
  format: 'maestro' | 'detox' | 'appium';
}

export function createRecordTestGenerateHandler(): (args: GenerateArgs) => Promise<ToolResult> {
  return async (args) => {
    if (!storedEvents || storedEvents.length === 0) {
      return failResult(
        'No recorded events — call cdp_record_test_start, interact, then cdp_record_test_stop first',
        'NO_EVENTS',
      );
    }
    if (args.format === 'appium') {
      return failResult(
        'Appium generator not implemented in M6 — file a GitHub issue if needed',
        'NOT_IMPLEMENTED',
      );
    }
    const opts: GenerateOpts = { testName: args.testName, bundleId: args.bundleId };
    const text =
      args.format === 'maestro'
        ? generateMaestro(storedEvents, opts)
        : generateDetox(storedEvents, opts);
    return okResult({ format: args.format, eventCount: storedEvents.length, text });
  };
}

export function createRecordTestAnnotateHandler(getClient: () => CDPClient): (args: { note: string }) => Promise<ToolResult> {
  return withConnection(getClient, async (args: { note: string }, client) => {
    if (!(await probeDev(client))) {
      return failResult(DEV_REQUIRED_MSG, 'DEV_MODE_REQUIRED');
    }
    const result = (await client.evaluate(buildAnnotationJs(args.note))) as EvalResult;
    if (result.error) {
      return failResult(`Failed to annotate: ${result.error}`, 'EVAL_FAILED');
    }
    if (typeof result.value !== 'string') {
      return failResult('Unexpected response from annotate — expected JSON string', 'BAD_RESPONSE');
    }
    let parsed: { ok?: boolean; error?: string };
    try {
      parsed = JSON.parse(result.value);
    } catch {
      return failResult(`Invalid JSON from annotate: ${String(result.value).slice(0, 200)}`, 'BAD_RESPONSE');
    }
    if (!parsed.ok) {
      return failResult(parsed.error ?? 'Annotation failed', 'NOT_RECORDING');
    }
    return okResult({ annotated: true });
  });
}

export function createRecordTestSaveHandler(): (args: { filename: string }) => Promise<ToolResult> {
  return async (args) => {
    if (!storedEvents) {
      return failResult('No events to save — stop a recording first', 'NO_EVENTS');
    }
    const dir = getRecordingsDir();
    if (!dir) {
      return failResult(
        'Could not resolve project root (no package.json ancestor). Set RN_PROJECT_ROOT env var.',
        'NO_PROJECT_ROOT',
      );
    }
    await mkdir(dir, { recursive: true });
    const safe = sanitizeFilename(args.filename);
    if (!safe) {
      return failResult('Filename is empty after sanitization', 'BAD_FILENAME');
    }
    const filePath = join(dir, `${safe}.json`);
    const payload = { savedAt: new Date().toISOString(), events: storedEvents };
    await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
    return okResult({
      saved: true,
      path: filePath,
      eventCount: storedEvents.length,
      truncated: recordingTruncated,
    });
  };
}

export function createRecordTestLoadHandler(): (args: { filename: string }) => Promise<ToolResult> {
  return async (args) => {
    const dir = getRecordingsDir();
    if (!dir) {
      return failResult('Could not resolve project root', 'NO_PROJECT_ROOT');
    }
    const safe = sanitizeFilename(args.filename);
    if (!safe) {
      return failResult('Filename is empty after sanitization', 'BAD_FILENAME');
    }
    const filePath = join(dir, `${safe}.json`);
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return failResult(`Could not load ${filePath}: ${msg}`, 'LOAD_FAILED');
    }
    let parsed: { savedAt?: string; events?: RecordedEvent[] };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return failResult(`Recording file is not valid JSON: ${filePath}`, 'BAD_RECORDING');
    }
    storedEvents = Array.isArray(parsed.events) ? parsed.events : [];
    recordingTruncated = false;
    return okResult({
      loaded: true,
      path: filePath,
      savedAt: parsed.savedAt ?? null,
      eventCount: storedEvents.length,
      typeCounts: typeCounts(storedEvents),
    });
  };
}

export function createRecordTestListHandler(): (args: Record<string, never>) => Promise<ToolResult> {
  return async () => {
    const dir = getRecordingsDir();
    if (!dir) {
      return failResult('Could not resolve project root', 'NO_PROJECT_ROOT');
    }
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return okResult({ dir, files: [] });
    }
    const recordings = files
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
    return okResult({ dir, files: recordings });
  };
}

// --- Test-only DI hooks (named with leading underscore by convention) ---

export function _setStoredEvents(events: RecordedEvent[] | null, truncated = false): void {
  storedEvents = events;
  recordingTruncated = truncated;
}

export function _getStoredEvents(): RecordedEvent[] | null {
  return storedEvents;
}

export function _resetState(): void {
  storedEvents = null;
  recordingTruncated = false;
}
