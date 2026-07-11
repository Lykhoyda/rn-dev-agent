// GH #438 — observe-UI e2e specs. Real ObservabilityServer + seeded Recorder
// + stub E2eServerDeps (see fixture-server.ts); the browser loads the
// committed single-file SPA bundle exactly as production serves it.
import { test, expect, type Page } from '@playwright/test';
import { startFixture, type Fixture } from './fixture-server';

let fx: Fixture;

test.beforeEach(async ({ page }) => {
  fx = await startFixture();
  await page.goto(fx.url);
});

test.afterEach(async () => {
  await fx.stop();
});

async function openTab(page: Page, tab: string): Promise<void> {
  await page.getByTestId(`state-tab-${tab}`).click();
}

test('timeline renders seeded events with header stats and live SSE pill', async ({ page }) => {
  await expect(page.getByTestId('timeline-row')).toHaveCount(5);
  await expect(page.getByTestId('timeline-row').filter({ hasText: 'cdp_navigate' })).toBeVisible();
  await expect(page.getByTestId('timeline-row').filter({ hasText: 'maestro_run' })).toContainText(
    '✗',
  );
  await expect(page.getByTestId('header-conn')).toHaveText(/live/);
  await expect(page.getByTestId('header-calls')).toContainText('5');
  await expect(page.getByTestId('header-errors')).toContainText('1');
});

test('family chip toggles filter the timeline', async ({ page }) => {
  await page.getByTestId('filter-family-navigation').click();
  await expect(page.getByTestId('timeline-row')).toHaveCount(4);
  await expect(page.getByTestId('timeline-row').filter({ hasText: 'cdp_navigate' })).toHaveCount(0);
  await page.getByTestId('filter-family-navigation').click();
  await expect(page.getByTestId('timeline-row')).toHaveCount(5);
});

test('errors-only chip shows only failed calls', async ({ page }) => {
  await page.getByTestId('filter-errors').click();
  await expect(page.getByTestId('timeline-row')).toHaveCount(1);
  await expect(page.getByTestId('timeline-row')).toContainText('maestro_run');
});

test('search filters by tool name', async ({ page }) => {
  await page.getByTestId('filter-search').fill('store');
  await expect(page.getByTestId('timeline-row')).toHaveCount(1);
  await expect(page.getByTestId('timeline-row')).toContainText('cdp_store_state');
});

test('clicking a row opens the event detail with args', async ({ page }) => {
  await page.getByTestId('timeline-row').filter({ hasText: 'cdp_navigate' }).click();
  await expect(page.getByTestId('timeline-detail')).toBeVisible();
  await expect(page.getByTestId('timeline-detail')).toContainText('screen');
  await expect(page.getByTestId('timeline-detail')).toContainText('Home');
});

test('device pane shows the hero screenshot from the seeded capture', async ({ page }) => {
  const img = page.getByTestId('device-screenshot');
  await expect(img).toBeVisible();
  const width = await img.evaluate((el) => (el as HTMLImageElement).naturalWidth);
  expect(width).toBeGreaterThan(0);
});

test('SSE live update appends a new timeline row without reload', async ({ page }) => {
  await expect(page.getByTestId('timeline-row')).toHaveCount(5);
  fx.recorder.record({ tool: 'cdp_reload', params: {}, status: 'PASS', latencyMs: 60 });
  await expect(page.getByTestId('timeline-row')).toHaveCount(6);
  await expect(page.getByTestId('timeline-row').filter({ hasText: 'cdp_reload' })).toBeVisible();
});

test('regression tab lists run history and drills into a run detail', async ({ page }) => {
  await openTab(page, 'e2e');
  const item = page.getByTestId('e2e-history-item');
  await expect(item).toHaveCount(1);
  await expect(item).toContainText('run-1');
  await expect(item).toContainText('FAIL');
  await page.getByTestId('e2e-history-toggle').click();
  const body = page.getByTestId('e2e-history-body');
  await expect(body).toBeVisible();
  await expect(body).toContainText('checkout-flow');
  await expect(body).toContainText('expected cart badge "2", saw "0"');
});

test('Run E2E Suite round-trips through the CSRF-guarded endpoint', async ({ page }) => {
  await openTab(page, 'e2e');
  await page.getByTestId('e2e-run').click();
  await expect(page.getByTestId('e2e-verdict')).toHaveText('PASS');

  const noTokenStatus = await page.evaluate(async () => {
    const r = await fetch('/api/e2e/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    return r.status;
  });
  expect(noTokenStatus).toBe(403);
});

test('actions panel enforces params then runs the action', async ({ page }) => {
  await openTab(page, 'actions');
  const item = page.getByTestId('action-item');
  await expect(item).toContainText('login');
  await expect(item).toContainText('Log into the app');

  await page.getByTestId('action-run').click();
  await expect(page.getByTestId('action-result')).toContainText('missing: USERNAME, PASSWORD');

  await page.getByTestId('action-param-USERNAME').fill('jo');
  await page.getByTestId('action-param-PASSWORD').fill('hunter2');
  await page.getByTestId('action-run').click();
  await expect(page.getByTestId('action-result')).toContainText('✓ output');
  await expect(page.getByTestId('action-output')).toContainText('ran login as jo');
});
