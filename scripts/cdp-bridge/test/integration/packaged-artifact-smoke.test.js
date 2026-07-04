// GH #432: validate the artifact users actually run. Copies the COMMITTED
// dist/ + package.json + package-lock.json to a temp dir — exactly the files
// ensure-cdp-deps.sh:24-25 copies — installs production-only with
// --ignore-scripts (lockfile-pinned, matching user machines), then drives
// dist/supervisor.js over stdio: MCP handshake, tools/list vs the committed
// golden, observe start + SPA fetch, clean SIGTERM. CI runs the
// dist-freshness gate first, so the "fresh" dist this exercises is provably
// identical to the committed one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSupervisor } from '../helpers/supervisor-harness.js';

const pexecFile = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE = resolve(__dirname, '../..');
const GOLDEN = JSON.parse(
  await readFile(resolve(__dirname, '../fixtures/tool-registry.json'), 'utf8'),
);

// ensure-cdp-deps.sh:26 verbatim (+ --no-audit --no-fund: output hygiene only).
const INSTALL_ARGS = ['install', '--production', '--ignore-scripts', '--no-audit', '--no-fund'];

test(
  'GH#432 packaged-artifact smoke: the user install path serves the full tool surface',
  // Budget: two 180s install attempts + boot/handshake must fit, or a
  // hung-then-retried install is killed by the test timeout and masks the
  // SMOKE_INSTALL diagnostic.
  { timeout: 450_000 },
  async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'rn-agent-packaged-'));
    let s = null;
    try {
      await cp(resolve(BRIDGE, 'dist'), join(tmp, 'dist'), { recursive: true });
      await cp(resolve(BRIDGE, 'package.json'), join(tmp, 'package.json'));
      // Conditional, mirroring ensure-cdp-deps.sh:25 — the lock ships today,
      // but the smoke must not hard-fail if it is ever removed.
      await cp(resolve(BRIDGE, 'package-lock.json'), join(tmp, 'package-lock.json')).catch(
        () => {},
      );

      try {
        await pexecFile('npm', INSTALL_ARGS, { cwd: tmp, timeout: 180_000 });
      } catch (first) {
        // One retry: registry flake must not read as a product regression.
        await pexecFile('npm', INSTALL_ARGS, { cwd: tmp, timeout: 180_000 }).catch((second) => {
          throw new Error(`SMOKE_INSTALL: production install failed twice: ${second.message}`, {
            cause: first,
          });
        });
      }

      const port = 17000 + Math.floor(Math.random() * 4000);
      s = startSupervisor({
        supervisorPath: join(tmp, 'dist/supervisor.js'),
        cwd: tmp,
        env: { RN_AGENT_OBSERVE_PORT: String(port) },
        // Cold worker boot right after a cold install on a loaded 2-core CI
        // runner — double gh-264's 15s interactive budget.
        lineTimeoutMs: 30_000,
      });

      const initId = s.send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'packaged-smoke', version: '0.0.0' },
      });
      const init = JSON.parse(await s.nextLine());
      assert.equal(init.id, initId, 'SMOKE_HANDSHAKE: initialize must be answered first');
      assert.ok(
        init.result?.serverInfo?.name,
        `SMOKE_HANDSHAKE: no serverInfo in ${JSON.stringify(init)}`,
      );
      s.notify('notifications/initialized');

      s.send('tools/list');
      const list = JSON.parse(await s.nextLine());
      const actual = (list.result?.tools ?? []).map((t) => t.name).sort();
      const missing = GOLDEN.filter((n) => !actual.includes(n));
      const unexpected = actual.filter((n) => !GOLDEN.includes(n));
      assert.equal(
        actual.length,
        GOLDEN.length,
        `SMOKE_REGISTRY: served ${actual.length} tools vs ${GOLDEN.length} in the golden — a duplicated name passes the set checks below`,
      );
      assert.deepEqual(
        { missing, unexpected },
        { missing: [], unexpected: [] },
        'SMOKE_REGISTRY: tool surface drifted from test/fixtures/tool-registry.json.\n' +
          `  missing (in golden, not served): ${JSON.stringify(missing)}\n` +
          `  unexpected (served, not in golden): ${JSON.stringify(unexpected)}\n` +
          '  Intentional change? node scripts/update-tool-registry.mjs, review the diff, commit.',
      );

      s.send('tools/call', { name: 'observe', arguments: { action: 'start' } });
      const call = JSON.parse(await s.nextLine());
      const envelope = JSON.parse(call.result?.content?.[0]?.text ?? '{}');
      assert.equal(
        envelope.ok,
        true,
        `SMOKE_OBSERVE: observe start failed: ${JSON.stringify(call)}`,
      );
      const res = await fetch(envelope.data.url);
      const body = await res.text();
      assert.equal(res.status, 200, 'SMOKE_OBSERVE: observe server must serve GET /');
      assert.ok(
        body.includes('__E2E_CSRF__'),
        'SMOKE_OBSERVE: expected the real SPA bundle (CSRF marker), not the "SPA bundle not built" branch — is dist/observability/web-dist/ in the packaged tree?',
      );

      s.child.kill('SIGTERM');
      const code = await new Promise((r) => s.child.on('exit', r));
      assert.equal(code, 0, 'SMOKE_SHUTDOWN: supervisor must exit 0 on SIGTERM');
      s = null;
    } finally {
      if (s) s.child.kill('SIGKILL');
      await rm(tmp, { recursive: true, force: true });
    }
  },
);
