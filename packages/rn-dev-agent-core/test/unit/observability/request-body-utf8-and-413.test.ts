import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { ObservabilityServer, type E2eServerDeps } from '../../../dist/observability/server.js';
import { recorder } from '../../../dist/observability/recorder.js';

const EMOJI = '\u{1F600}'; // U+1F600 = F0 9F 98 80

function e2eDeps(): { deps: E2eServerDeps; calls: { run: number; action: number } } {
  const calls = { run: 0, action: 0 };
  return {
    calls,
    deps: {
      token: 'tok1',
      triggerRun: async (pattern) => {
        calls.run += 1;
        return { ok: true, data: { pattern } };
      },
      listRuns: async () => [],
      loadRun: async () => null,
      listActions: async () => [],
      runAction: async (actionId, params) => {
        calls.action += 1;
        return { ok: true, actionId, params };
      },
    },
  };
}

interface SocketTarget {
  host: string;
  port: number;
}

function socketTarget(url: string): SocketTarget {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port) };
}

function rawPost(
  target: SocketTarget,
  firstSegment: Buffer,
  secondSegment: Buffer,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const sock = net.connect(target.port, target.host);
    sock.setNoDelay(true);
    const chunks: Buffer[] = [];
    let settled = false;
    const done = (v: Buffer | null) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    sock.on('connect', () => {
      sock.write(firstSegment);
      setTimeout(() => {
        sock.write(secondSegment);
        sock.end();
      }, 50);
    });
    sock.on('data', (c) => chunks.push(c));
    sock.on('close', () => done(chunks.length ? Buffer.concat(chunks) : null));
    sock.on('error', () => done(chunks.length ? Buffer.concat(chunks) : null));
    setTimeout(() => done(chunks.length ? Buffer.concat(chunks) : null), 5_000);
  });
}

function rawTwoRequests(
  target: SocketTarget,
  firstSegment: Buffer,
  secondSegment: Buffer,
  secondRawRequest: Buffer,
): Promise<[Buffer | null, Buffer | null]> {
  return new Promise((resolve) => {
    const sock = net.connect(target.port, target.host);
    sock.setNoDelay(true);
    const chunks: Buffer[] = [];
    let firstDone = false;
    let settled = false;
    const done = (v: [Buffer | null, Buffer | null]) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const all = (): Buffer => Buffer.concat(chunks);
    const responses = (): [Buffer, Buffer] | [Buffer] => {
      const buf = all();
      const marker = buf.indexOf('\r\nHTTP/1.1');
      if (marker < 0) return [buf];
      return [buf.subarray(0, marker), buf.subarray(marker + 2)];
    };
    sock.on('connect', () => {
      sock.write(firstSegment);
      setTimeout(() => sock.write(secondSegment), 50);
    });
    let responsesComplete = false;
    sock.on('data', (c) => {
      chunks.push(c);
      const text = all().toString('utf8');
      if (!firstDone && text.endsWith('\r\n0\r\n\r\n')) {
        firstDone = true;
        sock.write(secondRawRequest);
      } else if (firstDone && text.endsWith('\r\n0\r\n\r\n')) {
        if (!responsesComplete) {
          responsesComplete = true;
          sock.end();
        }
      }
    });
    sock.on('close', () => {
      const parts = responses();
      done(parts.length === 2 ? [parts[0], parts[1]] : [parts[0], null]);
    });
    sock.on('error', () => {
      const parts = responses();
      done(parts.length === 2 ? [parts[0], parts[1]] : [chunks.length ? parts[0] : null, null]);
    });
    setTimeout(() => {
      const parts = responses();
      done(parts.length === 2 ? [parts[0], parts[1]] : [chunks.length ? parts[0] : null, null]);
    }, 5_000);
  });
}

function rawStalledPost(target: SocketTarget, request: Buffer): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const sock = net.connect(target.port, target.host);
    const chunks: Buffer[] = [];
    let settled = false;
    const done = (value: Buffer | null) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(value);
    };
    sock.on('connect', () => sock.write(request));
    sock.on('data', (chunk) => {
      chunks.push(chunk);
      const response = Buffer.concat(chunks);
      if (response.includes('\r\n0\r\n\r\n')) done(response);
    });
    sock.on('close', () => done(chunks.length ? Buffer.concat(chunks) : null));
    sock.on('error', () => done(chunks.length ? Buffer.concat(chunks) : null));
    setTimeout(() => done(chunks.length ? Buffer.concat(chunks) : null), 1_000);
  });
}

function parseResponse(buf: Buffer | null): { statusLine: string; json: unknown } {
  if (!buf) return { statusLine: '<no response: socket reset>', json: null };
  const text = buf.toString('utf8');
  const [head, ...rest] = text.split('\r\n\r\n');
  const statusLine = head.split('\r\n')[0];
  let bodyStr = rest.join('\r\n\r\n');
  if (/transfer-encoding:\s*chunked/i.test(head)) {
    let out = Buffer.alloc(0);
    let raw = Buffer.from(bodyStr, 'utf8');
    for (;;) {
      const nl = raw.indexOf('\r\n');
      if (nl < 0) break;
      const size = parseInt(raw.subarray(0, nl).toString().split(';')[0], 16);
      if (!Number.isFinite(size) || size === 0) break;
      out = Buffer.concat([out, raw.subarray(nl + 2, nl + 2 + size)]);
      raw = raw.subarray(nl + 2 + size + 2);
    }
    bodyStr = out.toString('utf8');
  }
  try {
    return { statusLine, json: JSON.parse(bodyStr) };
  } catch {
    return { statusLine, json: null };
  }
}

async function withServer(
  deps: E2eServerDeps,
  fn: (url: string, target: SocketTarget) => Promise<void>,
): Promise<void> {
  const server = new ObservabilityServer(recorder, deps);
  const { url } = await server.start();
  try {
    await fn(url, socketTarget(url));
  } finally {
    await server.stop();
  }
}

test('split emoji survives on POST /api/e2e/actions/run (GH #818)', async () => {
  const { deps, calls } = e2eDeps();
  await withServer(deps, async (_url, target) => {
    // Body: {"actionId":"a1","params":{"q":"😀"}} with the emoji's four
    // UTF-8 bytes split across two TCP segments after byte two.
    const prefix = Buffer.from(`{"actionId":"a1","params":{"q":"`, 'utf8');
    const suffix = Buffer.from(`"}}`, 'utf8');
    const body = Buffer.concat([prefix, Buffer.from(EMOJI, 'utf8'), suffix]);
    assert.equal(body.length, prefix.length + 4 + suffix.length);

    const res = parseResponse(
      await rawPost(
        target,
        Buffer.concat([
          Buffer.from(
            `POST /api/e2e/actions/run HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\n` +
              `Content-Type: application/json\r\nx-csrf-token: tok1\r\n` +
              `Content-Length: ${body.length}\r\n\r\n`,
            'utf8',
          ),
          prefix,
          Buffer.from([0xf0, 0x9f]),
        ]),
        Buffer.concat([Buffer.from([0x98, 0x80]), suffix]),
      ),
    );
    assert.match(res.statusLine, /200/);
    assert.deepEqual(res.json, { ok: true, actionId: 'a1', params: { q: EMOJI } });
    assert.equal(calls.action, 1);
  });
});

test('split emoji survives on POST /api/e2e/run (GH #818)', async () => {
  const { deps, calls } = e2eDeps();
  await withServer(deps, async (_url, target) => {
    const prefix = Buffer.from(`{"pattern":"`, 'utf8');
    const suffix = Buffer.from(`"}`, 'utf8');
    const body = Buffer.concat([prefix, Buffer.from(EMOJI, 'utf8'), suffix]);

    const res = parseResponse(
      await rawPost(
        target,
        Buffer.concat([
          Buffer.from(
            `POST /api/e2e/run HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\n` +
              `Content-Type: application/json\r\nx-csrf-token: tok1\r\n` +
              `Content-Length: ${body.length}\r\n\r\n`,
            'utf8',
          ),
          prefix,
          Buffer.from([0xf0, 0x9f]),
        ]),
        Buffer.concat([Buffer.from([0x98, 0x80]), suffix]),
      ),
    );
    assert.match(res.statusLine, /200/);
    assert.deepEqual(res.json, { ok: true, data: { pattern: EMOJI } });
    assert.equal(calls.run, 1);
  });
});

test('65537-byte body to POST /api/e2e/actions/run returns JSON 413 without running the action', async () => {
  const { deps, calls } = e2eDeps();
  await withServer(deps, async (_url, target) => {
    const prefix = Buffer.from(`{"actionId":"a1","pad":"`, 'utf8');
    const suffix = Buffer.from(`"}`, 'utf8');
    const pad = Buffer.alloc(65_537 - prefix.length - suffix.length, 0x61);
    const body = Buffer.concat([prefix, pad, suffix]);
    assert.equal(body.length, 65_537); // exactly one byte over the 64 KiB limit

    const res = parseResponse(
      await rawPost(
        target,
        Buffer.from(
          `POST /api/e2e/actions/run HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\n` +
            `Content-Type: application/json\r\nx-csrf-token: tok1\r\n` +
            `Content-Length: ${body.length}\r\n\r\n`,
          'utf8',
        ),
        body,
      ),
    );
    assert.match(res.statusLine, /413/);
    assert.deepEqual(res.json, { error: 'body too large' });
    assert.equal(calls.action, 0, 'run handler must not be invoked for oversized bodies');
  });
});

test('65537-byte body to POST /api/e2e/run returns JSON 413 without triggering a run', async () => {
  const { deps, calls } = e2eDeps();
  await withServer(deps, async (url, target) => {
    const prefix = Buffer.from(`{"pattern":"`, 'utf8');
    const suffix = Buffer.from(`"}`, 'utf8');
    const pad = Buffer.alloc(65_537 - prefix.length - suffix.length, 0x61);
    const body = Buffer.concat([prefix, pad, suffix]);
    assert.equal(body.length, 65_537);

    const res = parseResponse(
      await rawPost(
        target,
        Buffer.from(
          `POST /api/e2e/run HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\n` +
            `Content-Type: application/json\r\nx-csrf-token: tok1\r\n` +
            `Content-Length: ${body.length}\r\n\r\n`,
          'utf8',
        ),
        body,
      ),
    );
    assert.match(res.statusLine, /413/);
    assert.deepEqual(res.json, { error: 'body too large' });
    assert.equal(calls.run, 0, 'run handler must not be invoked for oversized bodies');

    // The SAME connection stays usable for a subsequent request (keep-alive).
    const [, followUp] = await rawTwoRequests(
      target,
      Buffer.from(
        `POST /api/e2e/run HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\n` +
          `Content-Type: application/json\r\nx-csrf-token: tok1\r\n` +
          `Content-Length: ${body.length}\r\n\r\n`,
        'utf8',
      ),
      body,
      Buffer.from(
        `POST /api/e2e/run HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\n` +
          `Content-Type: application/json\r\nx-csrf-token: tok1\r\n` +
          `Content-Length: 18\r\n\r\n{"pattern":"next"}`,
        'utf8',
      ),
    );
    const followUpParsed = parseResponse(followUp);
    assert.match(
      followUpParsed.statusLine,
      /200/,
      'follow-up request on the same socket must succeed',
    );
    assert.deepEqual(followUpParsed.json, { ok: true, data: { pattern: 'next' } });
  });
});

test('over-limit POST returns JSON 413 before a stalled request ends', async () => {
  const { deps, calls } = e2eDeps();
  await withServer(deps, async (_url, target) => {
    const body = Buffer.alloc(65_537, 0x61);
    const response = await rawStalledPost(
      target,
      Buffer.concat([
        Buffer.from(
          `POST /api/e2e/run HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\n` +
            `Content-Type: application/json\r\nx-csrf-token: tok1\r\n` +
            `Content-Length: ${body.length + 1}\r\n\r\n`,
          'utf8',
        ),
        body,
      ]),
    );

    const parsed = parseResponse(response);
    assert.match(parsed.statusLine, /413/);
    assert.deepEqual(parsed.json, { error: 'body too large' });
    assert.equal(calls.run, 0);
  });
});

test('ASCII bodies still work end-to-end after the GH #818 change', async () => {
  const { deps, calls } = e2eDeps();
  await withServer(deps, async (url) => {
    const r = await fetch(`${url}/api/e2e/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': 'tok1' },
      body: '{"pattern":"smoke"}',
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, data: { pattern: 'smoke' } });
    assert.equal(calls.run, 1);
  });
});

test('oversized-but-valid requests keep CSRF and malformed-JSON behavior unchanged', async () => {
  const { deps } = e2eDeps();
  await withServer(deps, async (url) => {
    const csrf = await fetch(`${url}/api/e2e/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(csrf.status, 403);

    const bad = await fetch(`${url}/api/e2e/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': 'tok1' },
      body: '{not json',
    });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'invalid json body' });
  });
});
