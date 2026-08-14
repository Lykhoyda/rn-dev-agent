import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { createStatusHandler } from '../../dist/tools/status.js';
import { MetroNotFoundError, anyMetroRunning } from '../../dist/cdp/discovery.js';
import {
  _setHasSessionForTest,
  _resetHasSessionForTest,
  _setFetchCandidatesForTest,
  _resetFetchCandidatesForTest,
} from '../../dist/tools/dev-client-picker.js';

// GH #629: cdp_status on a dead Metro must answer within the discovery budget.
// The 120s hang came from the dev-client-picker probes around discovery — each
// one dispatches a runner auto-spawn with a 30s readiness wait. When no Metro
// is up at all, a picker dismissal cannot help, so cdp_status must skip the
// probes and surface discover()'s truthful not-found failure fast.

const savedDiscoveryPorts = process.env.RN_CDP_DISCOVERY_PORTS;

function envelope(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text);
}

async function reservedClosedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function startFakeMetro(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('packager-status:running');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
    server.on('error', reject);
  });
}

beforeEach(() => {
  delete process.env.RN_CDP_DISCOVERY_PORTS;
});

afterEach(() => {
  if (savedDiscoveryPorts === undefined) delete process.env.RN_CDP_DISCOVERY_PORTS;
  else process.env.RN_CDP_DISCOVERY_PORTS = savedDiscoveryPorts;
  _resetHasSessionForTest();
  _resetFetchCandidatesForTest();
});

test('anyMetroRunning is false (fast) when every candidate port is closed', async () => {
  const closed = await reservedClosedPort();
  process.env.RN_CDP_DISCOVERY_PORTS = '';
  const t0 = Date.now();
  assert.equal(await anyMetroRunning(closed), false);
  // Closed localhost ports refuse in milliseconds; the whole scan must stay
  // far below the 1.5s per-port budget, never minutes.
  assert.ok(Date.now() - t0 < 5000, `scan took ${Date.now() - t0}ms`);
});

test('anyMetroRunning is true against a live Metro /status endpoint', async () => {
  const { server, port } = await startFakeMetro();
  try {
    process.env.RN_CDP_DISCOVERY_PORTS = '';
    assert.equal(await anyMetroRunning(port), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('anyMetroRunning aborts a stalling server at the per-port budget (bounded, false)', async () => {
  // Accepts the TCP connection but never answers — the exact shape that would
  // hang an unbounded probe. The AbortController must cut it at the timeout.
  const stallers: Array<import('node:http').ServerResponse> = [];
  const server = createServer((_req, res) => {
    stallers.push(res); // hold the response open forever
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    server.on('error', reject);
  });
  try {
    process.env.RN_CDP_DISCOVERY_PORTS = '';
    const t0 = Date.now();
    assert.equal(await anyMetroRunning(port, 300), false);
    const elapsed = Date.now() - t0;
    // The caller-supplied 300ms budget must govern the abort — an
    // implementation ignoring it (e.g. hard-coding 1500ms) fails the ceiling.
    assert.ok(elapsed >= 250, `probe aborted before its budget: ${elapsed}ms`);
    assert.ok(elapsed < 1400, `stalled probe must abort at the 300ms budget, took ${elapsed}ms`);
  } finally {
    for (const res of stallers) res.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a stalling candidate port cannot blind a healthy sibling (per-port budgets)', async () => {
  const staller = createServer(() => {
    /* accept and never respond */
  });
  const stallPort = await new Promise<number>((resolve, reject) => {
    staller.listen(0, '127.0.0.1', () => resolve((staller.address() as AddressInfo).port));
    staller.on('error', reject);
  });
  const { server, port: livePort } = await startFakeMetro();
  try {
    // Candidate set: one stalling port (via the discovery-ports override) plus
    // the live hint port. Ports are probed in parallel with per-port budgets,
    // so the staller must neither hide the healthy Metro nor extend the scan.
    process.env.RN_CDP_DISCOVERY_PORTS = String(stallPort);
    assert.equal(await anyMetroRunning(livePort, 300), true);
  } finally {
    staller.closeAllConnections?.();
    await new Promise((resolve) => staller.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a Metro that responds slowly but within budget is still discovered', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/status') {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('packager-status:running');
      }, 500);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    server.on('error', reject);
  });
  try {
    process.env.RN_CDP_DISCOVERY_PORTS = '';
    // 500ms response vs the production 1500ms per-port budget: must be found.
    assert.equal(await anyMetroRunning(port), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('dead-Metro cdp_status skips picker probes and returns the truthful not-found fast', async () => {
  const closed = await reservedClosedPort();
  process.env.RN_CDP_DISCOVERY_PORTS = '';
  _setHasSessionForTest(true);
  let pickerProbes = 0;
  _setFetchCandidatesForTest(async () => {
    pickerProbes += 1;
    return { ok: false as const, reason: 'fetch-failed' as const };
  });

  // Route the mock through the REAL discovery path so the assertion covers the
  // genuine dead-Metro scan, not a preconstructed error.
  const { discover } = await import('../../dist/cdp/discovery.js');
  const client = createMockClient({
    _isConnected: false,
    _metroPort: closed,
    autoConnect: async () => {
      await discover(closed);
    },
  });

  const t0 = Date.now();
  const result = await createStatusHandler(
    () => client,
    () => {},
    () => client,
  )({});
  const elapsed = Date.now() - t0;
  const body = envelope(result);

  assert.equal(body.ok, false, result.content[0]!.text);
  // The truthful not-found result must be preserved verbatim.
  assert.equal(
    body.error,
    `Metro not found on ports ${closed}. Is the dev server running? Try: npx expo start or npx react-native start`,
  );
  assert.equal(pickerProbes, 0, 'no picker probe (and so no runner auto-spawn) may run');
  assert.ok(elapsed < 5000, `cdp_status took ${elapsed}ms on a dead Metro`);
});

test('live-Metro cdp_status still runs the picker probes on connect failure', async () => {
  const { server, port } = await startFakeMetro();
  try {
    process.env.RN_CDP_DISCOVERY_PORTS = '';
    _setHasSessionForTest(true);
    const events: string[] = [];
    _setFetchCandidatesForTest(async () => {
      events.push('picker-probe');
      return { ok: false as const, reason: 'fetch-failed' as const };
    });

    const client = createMockClient({
      _isConnected: false,
      _metroPort: port,
      autoConnect: async () => {
        events.push('auto-connect');
        throw new Error('target connect failed (fixture)');
      },
    });

    const result = await createStatusHandler(
      () => client,
      () => {},
      () => client,
    )({});
    const body = envelope(result);

    assert.equal(body.ok, false);
    assert.match(body.error, /target connect failed \(fixture\)/);
    // The GH #136 pre-connect probe must still run while a Metro is up.
    assert.ok(
      events.indexOf('picker-probe') !== -1 &&
        events.indexOf('picker-probe') < events.indexOf('auto-connect'),
      `pre-connect picker probing must be preserved while a Metro is up: ${events.join(',')}`,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('discover() throws the typed MetroNotFoundError carrying the probed ports', async () => {
  const closed = await reservedClosedPort();
  process.env.RN_CDP_DISCOVERY_PORTS = '';
  const { discover } = await import('../../dist/cdp/discovery.js');
  await assert.rejects(discover(closed), (err: unknown) => {
    assert.ok(err instanceof MetroNotFoundError);
    assert.deepEqual(err.ports, [closed]);
    assert.match(err.message, /Metro not found on ports /);
    return true;
  });
});
