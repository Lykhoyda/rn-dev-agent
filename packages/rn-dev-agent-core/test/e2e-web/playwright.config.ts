import { defineConfig } from '@playwright/test';

// GH #438 — observe-UI e2e. Each spec boots its own in-process fixture server
// on an ephemeral port, so tests are order-independent; workers stay at 1 to
// keep server lifecycles simple and CI output deterministic.
export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  workers: 1,
  reporter: [['list']],
  projects: [{ name: 'chromium', use: { browserName: 'chromium', headless: true } }],
});
