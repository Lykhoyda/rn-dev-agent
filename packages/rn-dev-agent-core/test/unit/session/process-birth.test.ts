import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  probeProcessBirth,
  processBirthMatches,
  readProcessBirth,
} from '../../../dist/session/process-birth.js';

test('macOS process identity uses full kernel start time and boot session', () => {
  const runForBoot = (bootSession, startMicroseconds = '345678') => ({
    run: (command, args) => {
      if (command === '/bin/ps') {
        assert.deepEqual(args, ['-p', '123', '-o', 'pid=']);
        return '123\n';
      }
      if (command === '/usr/sbin/sysctl') {
        assert.deepEqual(args, ['-n', 'kern.bootsessionuuid']);
        return `${bootSession}\n`;
      }
      throw new Error(`unexpected command ${command}`);
    },
    runWithDescriptor: (command, args) => {
      if (command === '/usr/bin/codesign') {
        assert.equal(args[0], '--verify');
        assert.equal(args[1], '--strict');
        assert.match(args[2], /darwin-process-birth$/);
        return '';
      }
      assert.match(command, /darwin-process-birth$/);
      assert.deepEqual(args, ['123']);
      return `123:1784792468:${startMicroseconds}\n`;
    },
  });
  const before = readProcessBirth(123, {
    platform: 'darwin',
    ...runForBoot('C9D056AF-6F25-47A3-8A9A-63B86EF8519F'),
  });
  const after = readProcessBirth(123, {
    platform: 'darwin',
    ...runForBoot('D9D056AF-6F25-47A3-8A9A-63B86EF8519F'),
  });
  const sameMillisecond = readProcessBirth(123, {
    platform: 'darwin',
    ...runForBoot('C9D056AF-6F25-47A3-8A9A-63B86EF8519F', '345679'),
  });

  assert.equal(before?.source, 'darwin-libproc');
  assert.match(before?.token ?? '', /^[a-f0-9]{64}$/);
  assert.notEqual(before?.token, after?.token);
  assert.notEqual(before?.token, sameMillisecond?.token);
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

test('macOS process identity refuses a replaced helper manifest', () => {
  let helperExecuted = false;
  const birth = probeProcessBirth(123, {
    platform: 'darwin',
    readBinary: (path) =>
      path.endsWith('.json')
        ? Buffer.from('{}')
        : readFileSync(new URL('../../../dist/native/darwin-process-birth', import.meta.url)),
    run: (command) => {
      if (command === '/bin/ps') return '123\n';
      if (command.endsWith('/native/darwin-process-birth')) helperExecuted = true;
      return '';
    },
  });

  assert.deepEqual(birth, { status: 'unknown' });
  assert.equal(helperExecuted, false);
});

test('macOS process identity executes the verified descriptor, not the helper path', () => {
  const helperBytes = readFileSync(
    new URL('../../../dist/native/darwin-process-birth', import.meta.url),
  );
  const metadata = {
    dev: 1,
    ino: 2,
    mode: 0o100500,
    size: helperBytes.length,
    uid: 501,
    isFile: () => true,
  };
  const commands: string[] = [];
  const birth = readProcessBirth(123, {
    platform: 'darwin',
    helperPath: () => '/trusted/darwin-process-birth',
    canonicalize: (path) => path,
    lstat: () => metadata,
    open: () => 17,
    fstat: () => metadata,
    close: () => {},
    stage: () => ({
      path: '/trusted/staged/darwin-process-birth',
      cleanup: () => {},
    }),
    uid: 501,
    readDescriptor: () => helperBytes,
    readBinary: () =>
      Buffer.from(
        JSON.stringify({
          sourceSha256: '54b3387a83580c5a782f3aedfb1984b62ed84faeadeca295fb90e533d9ecc137',
          recipeSha256: 'ff4a62e1c242f6123eb7232eae6e823ee808d18d9e138814dbe19f516cae2313',
          stableBinarySha256: 'cb08e04b81369c8f1acb5d52508841f72317c30b15bcf966f2963f54e0033ff1',
          binarySha256: '08a196d403db4245ff162d8d7585aa4c2c6e784029a4a6fab8ac69b14951d9dc',
        }),
      ),
    run: (command) => (command === '/bin/ps' ? '123\n' : 'C9D056AF-6F25-47A3-8A9A-63B86EF8519F\n'),
    runWithDescriptor: (command) => {
      commands.push(command);
      return command === '/usr/bin/codesign' ? '' : '123:1784792468:345678\n';
    },
  });

  assert.equal(birth?.source, 'darwin-libproc');
  assert.deepEqual(commands, ['/usr/bin/codesign', '/trusted/staged/darwin-process-birth']);
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

test('Darwin process helper ships executable in core and both host runtimes', () => {
  const helperUrls = [
    new URL('../../../dist/native/darwin-process-birth', import.meta.url),
    new URL(
      '../../../../claude-plugin/rn-dev-agent-core/dist/native/darwin-process-birth',
      import.meta.url,
    ),
    new URL(
      '../../../../codex-plugin/rn-dev-agent-core/dist/native/darwin-process-birth',
      import.meta.url,
    ),
  ];
  const helpers = helperUrls.map((url) => readFileSync(url));
  const manifests = helperUrls.map((url) =>
    JSON.parse(readFileSync(`${fileURLToPath(url)}.json`, 'utf8')),
  );

  assert.deepEqual(helpers[1], helpers[0]);
  assert.deepEqual(helpers[2], helpers[0]);
  assert.deepEqual(manifests[1], manifests[0]);
  assert.deepEqual(manifests[2], manifests[0]);
  assert.equal(manifests[0].binarySha256, createHash('sha256').update(helpers[0]).digest('hex'));
  assert.match(manifests[0].sourceSha256, /^[a-f0-9]{64}$/);
  assert.match(manifests[0].recipeSha256, /^[a-f0-9]{64}$/);
  assert.match(manifests[0].stableBinarySha256, /^[a-f0-9]{64}$/);
  if (process.platform !== 'win32') {
    for (const url of helperUrls) {
      assert.notEqual(statSync(url).mode & 0o111, 0);
    }
  }
});
