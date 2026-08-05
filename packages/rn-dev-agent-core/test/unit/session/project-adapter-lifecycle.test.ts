import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { renderProjectAdapter } from '../../../dist/session/package-integration.js';

function fixture(mode: 'exact' | 'drift' | 'disagree') {
  const root = mkdtempSync(join(tmpdir(), 'rn-project-adapter-lifecycle-'));
  const integration = join(root, '.rn-agent', 'integration');
  const bin = join(root, 'bin');
  const adapter = join(integration, 'rn-session-adapter.cjs');
  const sessionCli = join(root, 'rn-session.cjs');
  const calls = join(root, 'calls.jsonl');
  const expoRecord = join(root, 'expo.json');
  const resolveCount = join(root, 'resolve-count');
  mkdirSync(integration, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(adapter, renderProjectAdapter(), { mode: 0o755 });
  writeFileSync(
    join(integration, 'rn-session-integration.json'),
    JSON.stringify({
      version: 1,
      adapter: '.rn-agent/integration/rn-session-adapter.cjs',
      sessionCli,
      originalScripts: { ios: ['expo', 'run:ios'], android: ['expo', 'run:android'] },
    }),
  );
  writeFileSync(
    join(bin, 'expo'),
    `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.EXPO_RECORD,JSON.stringify({args:process.argv.slice(2),androidSerial:process.env.ANDROID_SERIAL}));
`,
  );
  chmodSync(join(bin, 'expo'), 0o755);
  writeFileSync(
    sessionCli,
    `const fs=require('node:fs');
const args=process.argv.slice(2);
fs.appendFileSync(process.env.CALLS,JSON.stringify(args)+'\\n');
if(args[0]==='prepare-build'){
  process.stdout.write(JSON.stringify({platform:'android',deviceId:'emulator-5660',appId:'dev.example',metroPort:8342,sessionId:'session-android',buildToken:args[2]}));
}else if(args[0]==='resolve-expo-android-device'){
  const count=fs.existsSync(process.env.RESOLVE_COUNT)?Number(fs.readFileSync(process.env.RESOLVE_COUNT,'utf8')):0;
  fs.writeFileSync(process.env.RESOLVE_COUNT,String(count+1));
  const mode=process.env.RESOLVER_MODE;
  process.stdout.write(JSON.stringify({deviceId:mode==='disagree'?'emulator-5770':'emulator-5660',displayName:mode==='drift'&&count>0?'renamed_avd':'exact_avd'}));
}else if(args[0]==='park-dev-client'){
  if(!fs.existsSync(process.env.EXPO_RECORD)) process.exit(8);
  process.stdout.write('{"parked":true}\\n');
}else if(args[0]==='ensure-metro'){
  process.stdout.write('{"metroBound":true}\\n');
}else if(args[0]==='complete-build'){
  process.stdout.write('{"receipt":true}\\n');
}else if(args[0]==='abort-build'){
  process.stdout.write('{"aborted":true}\\n');
}else process.exit(9);
`,
  );

  const result = spawnSync(process.execPath, [adapter, 'android', '--rn-agent-fresh-picker'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CALLS: calls,
      EXPO_RECORD: expoRecord,
      RESOLVE_COUNT: resolveCount,
      RESOLVER_MODE: mode,
    },
  });
  return { root, result, calls, expoRecord, adapter, bin, resolveCount };
}

test('Android adapter translates only at the Expo boundary, re-verifies, then parks before receipt', () => {
  const run = fixture('exact');
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(run.expoRecord, 'utf8')), {
      args: ['run:android', '--device', 'exact_avd', '--no-bundler'],
      androidSerial: 'emulator-5660',
    });
    const restarted = spawnSync(process.execPath, [run.adapter, 'restart-metro'], {
      cwd: run.root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${run.bin}:${process.env.PATH}`,
        CALLS: run.calls,
        EXPO_RECORD: run.expoRecord,
        RESOLVE_COUNT: run.resolveCount,
        RESOLVER_MODE: 'exact',
      },
    });
    assert.equal(restarted.status, 0, restarted.stderr);
    const calls = readFileSync(run.calls, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(calls.filter((args) => args[0] === 'resolve-expo-android-device').length, 2);
    assert.ok(calls.findIndex((args) => args[0] === 'park-dev-client') > 0);
    assert.ok(
      calls.findIndex((args) => args[0] === 'complete-build') >
        calls.findIndex((args) => args[0] === 'park-dev-client'),
    );
    assert.match(run.result.stdout, /relaunched without a product URL/);
    assert.equal(calls.at(-1)?.[0], 'ensure-metro');
  } finally {
    rmSync(run.root, { force: true, recursive: true });
  }
});

test('Android adapter refuses serial/name drift before Expo can mutate the device', () => {
  for (const mode of ['drift', 'disagree'] as const) {
    const run = fixture(mode);
    try {
      assert.notEqual(run.result.status, 0);
      assert.match(run.result.stderr, /EXPO_DEVICE_IDENTITY_MISMATCH/);
      assert.equal(existsSync(run.expoRecord), false);
      const calls = readFileSync(run.calls, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]);
      assert.ok(calls.some((args) => args[0] === 'abort-build'));
      assert.equal(
        calls.some((args) => args[0] === 'park-dev-client'),
        false,
      );
    } finally {
      rmSync(run.root, { force: true, recursive: true });
    }
  }
});
