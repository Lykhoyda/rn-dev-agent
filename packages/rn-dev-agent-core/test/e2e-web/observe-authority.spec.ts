// GH #791 — behavioral regressions for the Observe authority states.
// Failing path: unbound install/device authority must render an explicit
// blocked device state (never a positive live mirror over a dead pipeline).
// Proven path: a bound session whose mirror emits real frames renders the
// positive live state with nonzero image content.
import { test, expect } from '@playwright/test';
import { startFixture, JPEG_1PX, type Fixture } from './fixture-server';
import { MirrorManager } from '../../dist/observability/mirror/manager.js';
import { buildMirrorTargetResolver } from '../../dist/observability/mirror/target.js';
import type { MirrorFrameSink, MirrorSource } from '../../dist/observability/mirror/sources.js';

// Production resolver wired the way index.ts wires it: the registry device
// binding is the PR #786 fence mapper output; ambient probes must stay fenced.
function productionResolver(
  registryBinding: { platform?: string; deviceId?: string } | null,
): () => ReturnType<ReturnType<typeof buildMirrorTargetResolver>> {
  return buildMirrorTargetResolver({
    getPlatform: () => 'ios',
    getSessionDeviceId: () => undefined,
    resolveIosUdid: async () => {
      throw new Error('ambient iOS probe must stay fenced');
    },
    listAndroidSerials: async () => {
      throw new Error('ambient adb probe must stay fenced');
    },
    getRegistryDeviceBinding: () => registryBinding,
  });
}

let fx: Fixture | undefined;

test.afterEach(async () => {
  await fx?.stop();
  fx = undefined;
});

function streamingSource(fps = 10): MirrorSource {
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    pipeline: 'idb',
    nominalFps: fps,
    start(sink: MirrorFrameSink) {
      sink.onFrame(JPEG_1PX);
      timer = setInterval(() => sink.onFrame(JPEG_1PX), 1000 / fps);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

test('unbound authority renders an explicit blocked device state, never a positive live mirror', async ({
  page,
}) => {
  fx = await startFixture({
    stateRead: async () => ({
      ok: false,
      code: 'APP_INSTALL_IDENTITY_CHANGED',
      error: 'APP_INSTALL_IDENTITY_CHANGED: I authority is not bound',
      // Production authority failures carry the gate's own recovery path.
      meta: {
        nextAction: 'Run rn_session with action "status" and repair the named authority axis.',
      },
    }),
    mirror: (recorder) =>
      new MirrorManager({
        // The real resolver under the authority-present-no-device fence ({}).
        resolveTarget: productionResolver({}),
        createSource: async () => {
          throw new Error('unreachable: target refused');
        },
        pushStatus: (s) => recorder.push({ ...s }),
      }),
  });
  await page.goto(fx.url);

  // Transport liveness stays truthful — the SSE stream itself is up…
  await expect(page.getByTestId('header-conn')).toHaveText(/live/);
  // …but the device axis must be explicitly blocked, both in the header…
  await expect(page.getByTestId('header-device')).toHaveText(/blocked/i);
  // …and in the device pane, with the typed reason and a bounded recovery path.
  const blocked = page.getByTestId('device-blocked');
  await expect(blocked).toBeVisible();
  await expect(blocked).toContainText(/device authority is not bound/i);
  await expect(blocked).toContainText(/rn_session status/);
  // The fence sentinel cannot distinguish an unbound session from a wedged
  // authority store, so the rendered recovery path must not name a step that
  // only clears one of them.
  await expect(blocked).not.toContainText(/bind_device/);
  // The panel already carries code, reason and recovery — repeating them in the
  // status footer buries the one actionable step.
  await expect(page.locator('.mirror-footer')).toHaveCount(0);
  // The blocked state replaces any mirror/screenshot presentation entirely.
  await expect(page.getByTestId('device-mirror')).toHaveCount(0);
  await expect(page.getByTestId('device-screenshot')).toHaveCount(0);

  // The failing live read surfaces its install-authority code and the gate's
  // authoritative recovery path from the envelope meta, verbatim.
  await expect(page.getByTestId('state-live-err')).toContainText('APP_INSTALL_IDENTITY_CHANGED');
  await expect(page.getByTestId('state-live-recovery')).toHaveText(
    'Run rn_session with action "status" and repair the named authority axis.',
  );
});

test('a device-bound mirror stays live while install authority fails only in the state pane', async ({
  page,
}) => {
  // Axis separation on purpose: the mirror is device-screen evidence gated on
  // the device axis; the install axis gates app-state reads. One must never
  // mask or fake the other.
  fx = await startFixture({
    stateRead: async () => ({
      ok: false,
      code: 'APP_INSTALL_IDENTITY_CHANGED',
      error: 'APP_INSTALL_IDENTITY_CHANGED: I authority is not bound',
      meta: {
        nextAction: 'Run rn_session with action "status" and repair the named authority axis.',
      },
    }),
    mirror: (recorder) =>
      new MirrorManager({
        resolveTarget: productionResolver({ platform: 'ios', deviceId: 'UD1' }),
        createSource: async (t) => {
          if (t.deviceId !== 'UD1') throw new Error('unauthorized target reached the source');
          return streamingSource();
        },
        pushStatus: (s) => recorder.push({ ...s }),
      }),
  });
  await page.goto(fx.url);

  // The device axis is genuinely bound and framing — its live state is honest.
  await expect(page.getByTestId('header-device')).toHaveText(/live/i, { timeout: 10_000 });
  const mirror = page.getByTestId('device-mirror');
  await expect(mirror).toBeVisible();
  await expect
    .poll(async () => mirror.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0);
  // The install refusal still surfaces explicitly with its recovery path.
  await expect(page.getByTestId('state-live-err')).toContainText('APP_INSTALL_IDENTITY_CHANGED');
  await expect(page.getByTestId('state-live-recovery')).toContainText(/rn_session/);
});

test('binding the device after a blocked state recovers to live without a reload', async ({
  page,
}) => {
  // Counterfactual from #791: vary ONLY the authority binding; the same page
  // must go blocked → live once the device axis is proven.
  let binding: { platform?: string; deviceId?: string } | null = {};
  fx = await startFixture({
    mirror: (recorder) =>
      new MirrorManager({
        resolveTarget: async () => productionResolver(binding)(),
        createSource: async (t) => {
          if (t.deviceId !== 'UD1') throw new Error('unauthorized target reached the source');
          return streamingSource();
        },
        pushStatus: (s) => recorder.push({ ...s }),
      }),
  });
  await page.goto(fx.url);
  await expect(page.getByTestId('device-blocked')).toBeVisible();
  await expect(page.getByTestId('header-device')).toHaveText(/blocked/i);

  binding = { platform: 'ios', deviceId: 'UD1' };
  // The blocked pane's hidden probe re-attaches within its 15s retry loop.
  await expect(page.getByTestId('header-device')).toHaveText(/live/i, { timeout: 25_000 });
  await expect(page.getByTestId('device-blocked')).toHaveCount(0);
  const mirror = page.getByTestId('device-mirror');
  await expect(mirror).toBeVisible();
  await expect
    .poll(async () => mirror.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0);
});

test('a frameless mirror pipeline becomes an explicit off state, not an indefinite spinner', async ({
  page,
}) => {
  fx = await startFixture({
    mirror: (recorder) =>
      new MirrorManager({
        // The pipeline that produced the #791 evidence: an attach whose
        // resolution never settles, leaving the multipart stream open forever.
        resolveTarget: () => new Promise(() => {}),
        createSource: async () => {
          throw new Error('unreachable');
        },
        pushStatus: (s) => recorder.push({ ...s }),
        firstFrameWatchdogMs: 800,
      }),
  });
  await page.goto(fx.url);

  await expect(page.getByTestId('header-conn')).toHaveText(/live/);
  // Bounded: the watchdog turns the dead pipeline into a visible off state.
  await expect(page.getByTestId('header-device')).toHaveText(/off/i, {
    timeout: 10_000,
  });
  await expect(page.getByTestId('device-mirror')).toHaveCount(0);
  // The failure reason is visible in the pane, not silently swallowed.
  await expect(page.locator('.mirror-footer')).toContainText(/mirror off: no mirror frame/i);
});

// GH #791: with the mirror configured off there is no MirrorManager, so no
// status is ever published and the device pill sat on 'waiting' forever — a
// pending state for an axis that will never resolve, while the pane below it
// had already concluded the endpoint was absent and rendered a screenshot.
test('a mirror configured off reads as an explicit disabled device axis, never pending', async ({
  page,
}) => {
  // No `mirror` override — ObservabilityServer is built without a
  // MirrorManager, exactly as observe.mirror.enabled=false does in production.
  fx = await startFixture({});
  await page.goto(fx.url);

  await expect(page.getByTestId('header-conn')).toHaveText(/live/);
  const pill = page.getByTestId('header-device');
  await expect(pill).toHaveText(/disabled/i);
  await expect(pill).not.toContainText(/waiting/i);
  // The pane must agree with the header rather than presenting the mirror.
  await expect(page.getByTestId('device-mirror')).toHaveCount(0);
});

test('a bound session with real mirror frames presents the positive live device state', async ({
  page,
}) => {
  fx = await startFixture({
    mirror: (recorder) =>
      new MirrorManager({
        // The real resolver with a proven registry device binding.
        resolveTarget: productionResolver({ platform: 'ios', deviceId: 'UD1' }),
        createSource: async (t) => {
          if (t.deviceId !== 'UD1') throw new Error('unauthorized target reached the source');
          return streamingSource();
        },
        pushStatus: (s) => recorder.push({ ...s }),
      }),
  });
  await page.goto(fx.url);

  await expect(page.getByTestId('header-conn')).toHaveText(/live/);
  await expect(page.getByTestId('header-device')).toHaveText(/live/i, {
    timeout: 10_000,
  });
  const mirror = page.getByTestId('device-mirror');
  await expect(mirror).toBeVisible();
  // Real nonzero frame content — the proven-bound evidence bar from #791.
  await expect
    .poll(async () => mirror.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0);
  await expect(page.getByTestId('device-blocked')).toHaveCount(0);
  // Live reads succeed on the bound path (canned live route from the fixture).
  await expect(page.getByTestId('state-live-payload')).toContainText('LiveHome');
  await expect(page.getByTestId('state-live-err')).toHaveCount(0);
});
