import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, rmSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createAuthorityGate } from '../../../dist/session/authority-gate.js';
import { openAuthorityStore } from '../../../dist/session/authority-store.js';
import { createSessionHandler } from '../../../dist/tools/session.js';
import { createPassiveStatusHandler } from '../../../dist/tools/status.js';
import { okResult } from '../../../dist/utils.js';

// A long-lived registry connection whose WAL frames are lost while the wal-index still
// references them reads zero-filled pages: SQLite reports SQLITE_CORRUPT on its next read.
function unreadableRegistry(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rn-store-unreadable-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'registry.sqlite3');
  const store = openAuthorityStore(path);
  const other = new DatabaseSync(path);
  t.after(() => {
    other.close();
    try {
      store.close();
    } catch {}
  });
  store.database.exec('CREATE TABLE sessions(id INTEGER PRIMARY KEY, pad BLOB)');
  store.database.exec('CREATE TABLE beat(v INTEGER)');
  store.database.exec('INSERT INTO beat VALUES (0)');
  for (let i = 0; i < 20; i++) {
    store.database.prepare('INSERT INTO sessions(pad) VALUES (randomblob(3000))').run();
  }
  other.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  store.database.exec('UPDATE sessions SET pad = randomblob(3000)');
  const size = statSync(`${path}-wal`).size;
  const fd = openSync(`${path}-wal`, 'r+');
  writeSync(fd, Buffer.alloc(size), 0, size, 0);
  closeSync(fd);
  other.exec('UPDATE beat SET v = v + 1');
  const read = () => store.database.prepare('SELECT sum(length(pad)) AS bytes FROM sessions').get();
  const runtime = {
    requireAvailable: () => {
      read();
      return { registry: {}, session: { sessionId: 'session-a', claimEpoch: 1 } };
    },
    status: () => {
      read();
      throw new Error('unreachable: the registry read above must fail');
    },
    refreshRecoveryHandles: () => false,
    inspectRecoveryRequirement: () => undefined,
  };
  return { read, runtime };
}

function envelopeOf(result) {
  return JSON.parse(result.content[0].text);
}

test('a registry read SQLite reports as corrupt is AUTHORITY_STORE_UNAVAILABLE', (t) => {
  const { read } = unreadableRegistry(t);
  assert.throws(read, (error) => {
    assert.equal(error.code, 'AUTHORITY_STORE_UNAVAILABLE');
    assert.match(error.message, /^AUTHORITY_STORE_UNAVAILABLE: .*database disk image is malformed/);
    assert.equal(error.cause?.errcode, 11);
    return true;
  });
});

test('rn_session status answers a typed refusal when the registry is unreadable', async (t) => {
  const { runtime } = unreadableRegistry(t);
  const gate = createAuthorityGate(runtime, {});
  const status = gate.wrap('rn_session', createSessionHandler(runtime));

  const result = await status({ action: 'status' });

  assert.equal(result.isError, true);
  const envelope = envelopeOf(result);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'AUTHORITY_STORE_UNAVAILABLE');
  assert.match(envelope.error, /database disk image is malformed/);
});

test('authoritative tools refuse typed, without dispatch, when the registry is unreadable', async (t) => {
  const { runtime } = unreadableRegistry(t);
  const gate = createAuthorityGate(runtime, {});
  let dispatched = false;
  const interact = gate.wrap('cdp_interact', async () => {
    dispatched = true;
    return okResult({ pressed: true });
  });

  const result = await interact({});

  assert.equal(dispatched, false);
  const envelope = envelopeOf(result);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'AUTHORITY_STORE_UNAVAILABLE');
});

test('cdp_status answers a typed refusal when the registry is unreadable', async (t) => {
  const { runtime } = unreadableRegistry(t);
  const gate = createAuthorityGate(runtime, {});
  const client = { connectedTarget: null, metroPort: 8081, isConnected: false };
  const status = gate.wrap(
    'cdp_status',
    createPassiveStatusHandler(() => client, runtime),
  );

  const result = await status({});

  const envelope = envelopeOf(result);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'AUTHORITY_STORE_UNAVAILABLE');
});
