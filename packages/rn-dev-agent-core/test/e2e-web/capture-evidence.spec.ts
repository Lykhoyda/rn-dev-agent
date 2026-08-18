// GH #791 evidence capture — runs the three authority states through the real
// server + SPA and saves full-page screenshots. Invoked manually:
//   yarn playwright test --config test/e2e-web/playwright.config.ts capture-evidence
// Kept as a spec so it reuses the exact fixture wiring of the regression suite.
import { test } from '@playwright/test';
import { startFixture, JPEG_1PX, type Fixture } from './fixture-server';
import { MirrorManager } from '../../dist/observability/mirror/manager.js';
import { buildMirrorTargetResolver } from '../../dist/observability/mirror/target.js';
import type { MirrorFrameSink, MirrorSource } from '../../dist/observability/mirror/sources.js';

const OUT = process.env.EVIDENCE_DIR;

test.skip(!OUT, 'evidence capture runs only with EVIDENCE_DIR set');

let fx: Fixture | undefined;
test.afterEach(async () => {
  await fx?.stop();
  fx = undefined;
});

function resolver(binding: { platform?: string; deviceId?: string } | null) {
  return buildMirrorTargetResolver({
    getPlatform: () => 'ios',
    getSessionDeviceId: () => undefined,
    resolveIosUdid: async () => undefined,
    listAndroidSerials: async () => [],
    getRegistryDeviceBinding: () => binding,
  });
}

function streamingSource(): MirrorSource {
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    pipeline: 'idb',
    nominalFps: 10,
    start(sink: MirrorFrameSink) {
      sink.onFrame(JPEG_1PX);
      timer = setInterval(() => sink.onFrame(JPEG_1PX), 100);
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}

test('capture: unbound authority blocked state', async ({ page }) => {
  fx = await startFixture({
    stateRead: async () => ({
      ok: false,
      code: 'APP_INSTALL_IDENTITY_CHANGED',
      error: 'APP_INSTALL_IDENTITY_CHANGED: I authority is not bound',
    }),
    mirror: (recorder) =>
      new MirrorManager({
        resolveTarget: resolver({}),
        createSource: async () => {
          throw new Error('unreachable');
        },
        pushStatus: (s) => recorder.push({ ...s }),
      }),
  });
  await page.goto(fx.url);
  await page.getByTestId('device-blocked').waitFor({ timeout: 10_000 });
  await page.getByTestId('state-live-err').waitFor({ timeout: 10_000 });
  await page
    .getByTestId('header-device')
    .filter({ hasText: 'blocked' })
    .waitFor({ timeout: 10_000 });
  await page.screenshot({
    path: `${OUT}/ui-unbound-blocked.png`,
    fullPage: false,
  });
});

test('capture: frameless pipeline off state', async ({ page }) => {
  fx = await startFixture({
    mirror: (recorder) =>
      new MirrorManager({
        resolveTarget: () => new Promise(() => {}),
        createSource: async () => {
          throw new Error('unreachable');
        },
        pushStatus: (s) => recorder.push({ ...s }),
        firstFrameWatchdogMs: 1000,
      }),
  });
  await page.goto(fx.url);
  await page.getByTestId('header-device').filter({ hasText: 'off' }).waitFor({ timeout: 15_000 });
  await page.screenshot({
    path: `${OUT}/ui-frameless-off.png`,
    fullPage: false,
  });
});

test('capture: bound live mirror state', async ({ page }) => {
  fx = await startFixture({
    mirror: (recorder) =>
      new MirrorManager({
        resolveTarget: resolver({ platform: 'ios', deviceId: 'UD1' }),
        createSource: async () => streamingSource(),
        pushStatus: (s) => recorder.push({ ...s }),
      }),
  });
  await page.goto(fx.url);
  await page.getByTestId('header-device').filter({ hasText: 'live' }).waitFor({ timeout: 15_000 });
  const mirror = page.getByTestId('device-mirror');
  await mirror.waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="device-mirror"]') as HTMLImageElement | null;
    return el !== null && el.naturalWidth > 0;
  });
  await page.screenshot({ path: `${OUT}/ui-bound-live.png`, fullPage: false });
});
