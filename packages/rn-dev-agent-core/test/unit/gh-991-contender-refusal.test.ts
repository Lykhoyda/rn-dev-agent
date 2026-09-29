// GH #991: a same-root contender names the live owner without leaking its command line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeProcessHost, formatContenderRefusal } from '../../dist/lifecycle/lockfile.js';

const conflict = {
  status: 'conflict',
  lockPath: '/tmp/rn-dev-agent-cdp-501-deadbeef.lock',
  pid: 4242,
  projectRoot: '/fake/project',
  startedAt: 0,
  ageMs: 6 * 60_000,
  ppid: 4241,
};

test('the refusal names the owner pid, host label, tty and age', () => {
  const message = formatContenderRefusal(conflict, { name: 'claude', tty: 'ttys003' });
  assert.match(message, /pid 4242, host claude on ttys003, started 6m ago/);
  assert.match(message, /takes over automatically once that session exits/);
  assert.doesNotMatch(message, /deadbeef|fake\/project/, 'no lock path or project path');
});

test('an unresolvable or unsafe host is omitted rather than guessed', () => {
  assert.match(formatContenderRefusal(conflict, null), /\(pid 4242, started 6m ago\)/);
  assert.match(
    formatContenderRefusal(conflict, { name: 'node --token=secret', tty: 'ttys003' }),
    /\(pid 4242, started 6m ago\)/,
  );
});

test('the host label is an executable basename with a validated tty', () => {
  const ps = (out) => () => out;
  assert.deepEqual(describeProcessHost(7, ps('ttys003 /Users/me/.local/bin/claude\n')), {
    name: 'claude',
    tty: 'ttys003',
  });
  assert.deepEqual(
    describeProcessHost(7, ps('?? /Users/me/Library/Application Support/Claude/claude')),
    { name: 'claude', tty: null },
  );
  assert.deepEqual(describeProcessHost(7, ps('pts/4 node')), { name: 'node', tty: 'pts/4' });
  assert.equal(describeProcessHost(7, ps('ttys003 /bin/evil\u001b[31m')), null);
  assert.equal(describeProcessHost(7, ps('')), null);
  assert.equal(
    describeProcessHost(7, () => {
      throw new Error('ps denied');
    }),
    null,
  );
  assert.equal(describeProcessHost(undefined), null);
  assert.equal(describeProcessHost(1), null, 'init/launchd is never reported as a host');
});
