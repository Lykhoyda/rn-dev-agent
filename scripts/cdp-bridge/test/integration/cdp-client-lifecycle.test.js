import { before, after, test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeCDP } from '../helpers/fake-cdp-server.js';
import { CDPClient } from '../../dist/cdp-client.js';

const tmpDir = mkdtempSync(join(tmpdir(), 'cdp-test-'));
process.env.TMPDIR = tmpDir;

async function poll(fn, timeoutMs = 12000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

describe('CDPClient lifecycle', () => {
  let server;

  before(async () => {
    server = await startFakeCDP();
  });

  after(async () => {
    await server.close();
  });

  test('autoConnect discovers target and connects', async () => {
    const client = new CDPClient(server.port);
    try {
      await client.autoConnect(server.port);
      assert.equal(client.isConnected, true);
    } finally {
      await client.disconnect();
    }
  });

  test('evaluate sends message and receives response', async () => {
    const client = new CDPClient(server.port);
    try {
      await client.autoConnect(server.port);

      server.setResponse('Runtime.evaluate', (_params) => ({
        result: { type: 'number', value: 42 },
      }));

      const result = await client.evaluate('1+1');
      assert.equal(result.value, 42);
    } finally {
      server.removeResponse('Runtime.evaluate');
      await client.disconnect();
    }
  });

  test('disconnect sets isConnected to false', async () => {
    const client = new CDPClient(server.port);
    await client.autoConnect(server.port);
    assert.equal(client.isConnected, true);
    await client.disconnect();
    assert.equal(client.isConnected, false);
  });

  test('reconnect after server drops connection', async () => {
    const client = new CDPClient(server.port);
    try {
      await client.autoConnect(server.port);
      assert.equal(client.isConnected, true);

      server.disconnectAll();

      const reconnected = await poll(() => client.isConnected, 15000, 300);
      assert.equal(reconnected, true, 'Client should reconnect after server drops connection');
    } finally {
      await client.disconnect();
    }
  });

  test('falls back to hook mode when Network.enable fires no events (B1)', async () => {
    const client = new CDPClient(server.port);
    try {
      await client.autoConnect(server.port);
      // The probe fires a fetch via evaluate, but fake server doesn't emit
      // Network.requestWillBeSent, so the probe times out and falls back to hooks
      const ok = await poll(() => client.helpersInjected, 15000, 300);
      assert.ok(ok, 'Helpers should be injected');
      assert.equal(client.networkMode, 'hook',
        'Network mode should be "hook" — probe got no CDP events from fake server');
    } finally {
      await client.disconnect();
    }
  });

  test('autoConnect fails when no Hermes targets are available', async () => {
    const { createServer } = await import('node:http');
    const srv = createServer((req, res) => {
      if (req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('packager-status:running');
        return;
      }
      if (req.url === '/json/list') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise((resolve, reject) => {
      srv.listen(0, '127.0.0.1', () => resolve(undefined));
      srv.once('error', reject);
    });

    const { port: emptyPort } = srv.address();
    const client = new CDPClient(emptyPort);
    try {
      await assert.rejects(
        () => client.autoConnect(emptyPort),
        (err) => {
          assert.ok(err instanceof Error);
          assert.ok(
            err.message.includes('No Hermes') || err.message.includes('Metro not found'),
            `Unexpected error: ${err.message}`,
          );
          return true;
        },
      );
    } finally {
      await new Promise(resolve => srv.close(resolve));
    }
  });
});
