import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  probeProcessBirth,
  processBirthMatches,
  readProcessBirth,
} from '../../../dist/session/process-birth.js';

test('macOS second-resolution process identity fails conservative', () => {
  const run = (command) => {
    if (command === 'ps') return 'Wed Jul 23 09:41:08 2026\n';
    if (command === 'sysctl') return '{ sec = 1784790000, usec = 0 } Wed Jul 23 09:00:00 2026\n';
    throw new Error(`unexpected command ${command}`);
  };

  assert.equal(readProcessBirth(123, { platform: 'darwin', run }), null);
});

test('a reused PID after reboot cannot match the prior birth token', () => {
  const runForBoot = (bootSeconds) => (command) => {
    if (command === 'ps') return 'Wed Jul 23 09:41:08 2026\n';
    if (command === 'sysctl') {
      return `{ sec = ${bootSeconds}, usec = 0 } Wed Jul 23 09:00:00 2026\n`;
    }
    throw new Error(`unexpected command ${command}`);
  };
  const before = readProcessBirth(123, {
    platform: 'darwin',
    run: runForBoot(1784790000),
  });
  const after = readProcessBirth(123, {
    platform: 'darwin',
    run: runForBoot(1784793600),
  });

  assert.equal(before, null);
  assert.equal(after, null);
});

test('Linux process identity handles process names containing spaces', () => {
  const birth = readProcessBirth(456, {
    platform: 'linux',
    read: (path) => {
      if (path === '/proc/sys/kernel/random/boot_id') return 'boot-123\n';
      if (path === '/proc/456/stat') {
        const fields = ['S', ...Array.from({ length: 18 }, (_, index) => String(index)), '987654'];
        return `456 (worker with spaces) ${fields.join(' ')}\n`;
      }
      throw new Error(`unexpected path ${path}`);
    },
  });

  assert.equal(birth?.source, 'linux-proc');
  assert.match(birth?.token ?? '', /^[a-f0-9]{64}$/);
});

test('unreadable process birth fails conservative', () => {
  const birth = readProcessBirth(789, {
    platform: 'darwin',
    run: () => {
      throw new Error('permission denied');
    },
  });

  assert.equal(birth, null);
  assert.equal(
    processBirthMatches(
      { pid: 789, token: 'recorded' },
      {
        platform: 'darwin',
        run: () => {
          throw new Error('permission denied');
        },
      },
    ),
    false,
  );
});

test('process birth probes distinguish confirmed absence from unreadable identity', () => {
  const missing = new Error('missing');
  (missing as NodeJS.ErrnoException).code = 'ENOENT';
  const read = (path) => {
    if (path.endsWith('boot_id')) return 'boot-123';
    throw missing;
  };
  assert.deepEqual(probeProcessBirth(789, { platform: 'linux', read }), {
    status: 'absent',
  });
  assert.deepEqual(
    probeProcessBirth(789, {
      platform: 'linux',
      read: (path) => {
        if (path.endsWith('boot_id')) return 'boot-123';
        throw new Error('permission denied');
      },
    }),
    { status: 'unknown' },
  );
});

test('current process has a portable birth identity on supported hosts', () => {
  if (process.platform !== 'linux' && process.platform !== 'win32') {
    return;
  }

  const birth = readProcessBirth(process.pid);

  assert.equal(birth?.pid, process.pid);
  assert.match(birth?.token ?? '', /^[a-f0-9]{64}$/);
});
