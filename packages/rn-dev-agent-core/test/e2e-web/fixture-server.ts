// GH #438 — fixture harness for the observe-UI Playwright specs.
// Boots the REAL ObservabilityServer (no device, no CDP) with a seeded
// Recorder and a canned E2eServerDeps stub on an ephemeral port — the same
// DI seams the unit tests use (observability-server.test.js,
// e2e-server-routes.test.js).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObservabilityServer } from '../../dist/observability/server.js';
import { Recorder } from '../../dist/observability/recorder.js';

export const CSRF_TOKEN = 'e2e-fixture-token';

// Minimal decodable 1x1 JPEG so the device hero <img> gets naturalWidth > 0.
const JPEG_1PX = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

export interface Fixture {
  url: string;
  recorder: Recorder;
  stop: () => Promise<void>;
}

export async function startFixture(): Promise<Fixture> {
  const recorder = new Recorder(100);

  const shotPath = join(mkdtempSync(join(tmpdir(), 'observe-e2e-')), 'screen.jpg');
  writeFileSync(shotPath, JPEG_1PX);

  recorder.record({
    tool: 'cdp_navigate',
    params: { screen: 'Home' },
    status: 'PASS',
    latencyMs: 12,
  });
  recorder.record({ tool: 'device_press', params: { ref: '@e3' }, status: 'PASS', latencyMs: 340 });
  recorder.record({
    tool: 'cdp_store_state',
    params: {},
    status: 'PASS',
    latencyMs: 25,
    result: { ok: true, data: { cart: { items: 2 } } },
  });
  recorder.record({
    tool: 'maestro_run',
    params: { flow: 'checkout.yaml' },
    status: 'FAIL',
    latencyMs: 4100,
    error: { message: 'flow failed at step 3' },
  });
  recorder.record({
    tool: 'device_screenshot',
    params: {},
    status: 'PASS',
    latencyMs: 90,
    result: { ok: true, data: { message: shotPath } },
  });

  const e2eStub = {
    token: CSRF_TOKEN,
    triggerRun: async () => ({
      ok: true,
      data: {
        runId: 'run-live',
        verdict: 'green',
        totals: { total: 1, passed: 1, failed: 0, skipped: 0 },
        results: [{ testId: 'flow-a', passed: true, durationMs: 1200, classification: 'pass' }],
        newlyFailing: [],
      },
    }),
    listRuns: async () => [
      {
        runId: 'run-1',
        finishedAt: '2026-07-11T10:00:05.000Z',
        verdict: 'red',
        totals: { total: 2, passed: 1, failed: 1, skipped: 0 },
      },
    ],
    loadRun: async (id: string) =>
      id === 'run-1'
        ? {
            runId: 'run-1',
            startedAt: '2026-07-11T10:00:00.000Z',
            finishedAt: '2026-07-11T10:00:05.000Z',
            durationMs: 5000,
            platform: 'ios',
            verdict: 'red',
            totals: { total: 2, passed: 1, failed: 1, skipped: 0 },
            results: [
              { testId: 'login-flow', passed: true, durationMs: 800, classification: 'pass' },
              {
                testId: 'checkout-flow',
                passed: false,
                durationMs: 3200,
                classification: 'assertion-failed',
                errorExcerpt: 'expected cart badge "2", saw "0"',
              },
            ],
          }
        : null,
    listActions: async () => [
      {
        id: 'login',
        intent: 'Log into the app with credentials',
        status: 'active',
        params: ['USERNAME', 'PASSWORD'],
        mutates: true,
      },
    ],
    runAction: async (actionId: string, params?: Record<string, string>) => {
      const missing = ['USERNAME', 'PASSWORD'].filter((p) => !params?.[p]);
      if (actionId === 'login' && missing.length > 0) {
        return { ok: false, missingParams: missing };
      }
      return { ok: true, output: `ran ${actionId} as ${params?.USERNAME ?? '?'}` };
    },
  };

  const server = new ObservabilityServer(recorder, e2eStub);
  const { url } = await server.start(0);
  return { url, recorder, stop: () => server.stop() };
}
