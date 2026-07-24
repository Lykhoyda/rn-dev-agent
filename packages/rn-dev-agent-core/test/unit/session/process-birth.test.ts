import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  probeProcessBirth,
  processBirthMatches,
  readProcessBirth,
} from '../../../dist/session/process-birth.js';

test('macOS process identity uses shipped vmmap launch time and boot session', () => {
  const runForBoot =
    (bootSession, launchTime = '2026-07-23 09:41:08.345 +0200') =>
    (command, args) => {
      if (command === '/bin/ps') {
        assert.deepEqual(args, ['-p', '123', '-o', 'pid=']);
        return '123\n';
      }
      if (command === '/usr/bin/vmmap') {
        assert.deepEqual(args, ['-summary', '123']);
        return ['Process:         node [123]', `Launch Time:     ${launchTime}`].join('\n');
      }
      if (command === '/usr/sbin/sysctl') {
        assert.deepEqual(args, ['-n', 'kern.bootsessionuuid']);
        return `${bootSession}\n`;
      }
      throw new Error(`unexpected command ${command}`);
    };
  const before = readProcessBirth(123, {
    platform: 'darwin',
    run: runForBoot('C9D056AF-6F25-47A3-8A9A-63B86EF8519F'),
  });
  const after = readProcessBirth(123, {
    platform: 'darwin',
    run: runForBoot('D9D056AF-6F25-47A3-8A9A-63B86EF8519F'),
  });
  const timezoneChanged = readProcessBirth(123, {
    platform: 'darwin',
    run: runForBoot('C9D056AF-6F25-47A3-8A9A-63B86EF8519F', '2026-07-23 07:41:08.345 +0000'),
  });

  assert.equal(before?.source, 'darwin-vmmap');
  assert.match(before?.token ?? '', /^[a-f0-9]{64}$/);
  assert.notEqual(before?.token, after?.token);
  assert.equal(before?.token, timezoneChanged?.token);
});

test('macOS process probes distinguish confirmed absence from unreadable identity', () => {
  assert.deepEqual(
    probeProcessBirth(123, {
      platform: 'darwin',
      run: (command) => (command === '/bin/ps' ? '' : assert.fail()),
    }),
    { status: 'absent' },
  );
  assert.deepEqual(
    probeProcessBirth(123, {
      platform: 'darwin',
      run: (command) => (command === '/bin/ps' ? '123\n' : 'unparseable\n'),
    }),
    { status: 'unknown' },
  );
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
  if (!['darwin', 'linux', 'win32'].includes(process.platform)) {
    return;
  }

  const birth = readProcessBirth(process.pid);

  assert.equal(birth?.pid, process.pid);
  assert.match(birth?.token ?? '', /^[a-f0-9]{64}$/);
});
