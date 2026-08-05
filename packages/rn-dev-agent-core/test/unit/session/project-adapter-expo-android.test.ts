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

const SERIAL = 'R58M1234ABC';
const DISPLAY_NAME = 'Pixel_8_Pro';

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'rn-project-adapter-expo-android-'));
  const integration = join(root, '.rn-agent', 'integration');
  const bin = join(root, 'bin');
  const adapter = join(integration, 'rn-session-adapter.cjs');
  const sessionCli = join(root, 'rn-session.cjs');
  const calls = join(root, 'session-calls.jsonl');
  const expoRecord = join(root, 'expo.json');
  const adbCount = join(root, 'adb-count');
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
    join(root, 'package.json'),
    JSON.stringify({
      private: true,
      scripts: { android: 'node .rn-agent/integration/rn-session-adapter.cjs android' },
    }),
  );
  writeFileSync(
    join(bin, 'pnpm'),
    `#!/usr/bin/env node
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const script=require(path.join(process.cwd(),'package.json')).scripts[process.argv[2]];
if(script!=='node .rn-agent/integration/rn-session-adapter.cjs android')process.exit(91);
const forwarded=process.argv.slice(3).filter((arg)=>arg!=='--');
const result=spawnSync(process.execPath,[path.join(process.cwd(),'.rn-agent/integration/rn-session-adapter.cjs'),'android',...forwarded],{cwd:process.cwd(),env:process.env,stdio:'inherit'});
if(result.signal)process.exit(128);process.exit(result.status??1);
`,
  );
  chmodSync(join(bin, 'pnpm'), 0o755);
  writeFileSync(
    join(bin, 'adb'),
    `#!/usr/bin/env node
const fs=require('node:fs');
const count=fs.existsSync(process.env.ADB_COUNT)?Number(fs.readFileSync(process.env.ADB_COUNT,'utf8')):0;
fs.writeFileSync(process.env.ADB_COUNT,String(count+1));
const model=process.env.ADAPTER_MODE==='drift'&&count>0?'Pixel_9_Pro':'${DISPLAY_NAME}';
process.stdout.write('List of devices attached\\n${SERIAL} device usb:1-1 product:test model:'+model+' device:test transport_id:1\\n');
`,
  );
  chmodSync(join(bin, 'adb'), 0o755);
  writeFileSync(
    join(bin, 'expo'),
    `#!/usr/bin/env node
const fs=require('node:fs');
fs.writeFileSync(process.env.EXPO_RECORD,JSON.stringify({args:process.argv.slice(2),androidSerial:process.env.ANDROID_SERIAL,metroPort:process.env.RCT_METRO_PORT,gradlePort:process.env.ORG_GRADLE_PROJECT_reactNativeDevServerPort,sessionId:process.env.RN_DEV_AGENT_SESSION_ID}));
if(process.env.ADAPTER_MODE==='failure')process.exit(23);
if(process.env.ADAPTER_MODE==='sigint'){process.kill(process.ppid,'SIGINT');setTimeout(()=>process.exit(0),100);}
`,
  );
  chmodSync(join(bin, 'expo'), 0o755);
  writeFileSync(
    sessionCli,
    `const fs=require('node:fs');
const {pathToFileURL}=require('node:url');
const args=process.argv.slice(2);
fs.appendFileSync(process.env.SESSION_CALLS,JSON.stringify(args)+'\\n');
if(args[0]==='prepare-build'){
  process.stdout.write(JSON.stringify({platform:'android',deviceId:'${SERIAL}',appId:'com.rndevagent.testapp',metroPort:8397,sessionId:'session-android-exact',buildToken:args[2],devClientUrl:'rndatest://expo-development-client/?url=http%3A%2F%2F192.0.2.10%3A8397'}));
}else if(args[0]==='resolve-expo-android-device'){
  import(pathToFileURL(process.env.RESOLVER_MODULE).href).then(({resolveExpoAndroidDevice})=>process.stdout.write(JSON.stringify(resolveExpoAndroidDevice(args[1])))).catch((error)=>{process.stderr.write(String(error.message)+'\\n');process.exit(2);});
}else if(args[0]==='complete-build'){
  fs.writeFileSync(process.env.COMPLETION,JSON.stringify({args,sessionId:process.env.RN_DEV_AGENT_SESSION_ID,deviceId:'${SERIAL}',appId:'com.rndevagent.testapp',metroPort:8397,buildKind:'expo'}));
  process.stdout.write('{"receipt":true}\\n');
}else if(args[0]==='abort-build'){
  fs.appendFileSync(process.env.ABORTS,JSON.stringify({args,sessionId:process.env.RN_DEV_AGENT_SESSION_ID})+'\\n');
  process.stdout.write('{"aborted":true}\\n');
}else process.exit(92);
`,
  );

  const environment = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    SESSION_CALLS: calls,
    EXPO_RECORD: expoRecord,
    ADB_COUNT: adbCount,
    COMPLETION: join(root, 'completion.json'),
    ABORTS: join(root, 'aborts.jsonl'),
    RESOLVER_MODULE: new URL('../../../dist/session/expo-android-device.js', import.meta.url)
      .pathname,
  };
  return { root, calls, expoRecord, environment };
}

function readJsonLines(path: string): unknown[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('literal pnpm android executes the generated adapter with ephemeral Expo name and serial authority', () => {
  const fixture = createFixture();
  try {
    const result = spawnSync('pnpm', ['android'], {
      cwd: fixture.root,
      encoding: 'utf8',
      env: fixture.environment,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(fixture.expoRecord, 'utf8')), {
      args: ['run:android', '--device', DISPLAY_NAME, '--no-bundler'],
      androidSerial: SERIAL,
      metroPort: '8397',
      gradlePort: '8397',
      sessionId: 'session-android-exact',
    });
    const completion = JSON.parse(readFileSync(fixture.environment.COMPLETION, 'utf8')) as Record<
      string,
      unknown
    >;
    assert.deepEqual(completion, {
      args: ['complete-build', 'android', (completion.args as string[])[2]],
      sessionId: 'session-android-exact',
      deviceId: SERIAL,
      appId: 'com.rndevagent.testapp',
      metroPort: 8397,
      buildKind: 'expo',
    });
    const calls = readJsonLines(fixture.calls) as string[][];
    const prepare = calls.find(([command]) => command === 'prepare-build');
    const complete = calls.find(([command]) => command === 'complete-build');
    assert.equal(prepare?.[1], 'android');
    assert.equal(prepare?.[3], 'expo');
    assert.equal(complete?.[1], 'android');
    assert.equal(complete?.[2], prepare?.[2], 'completion must retain the prepared build token');
    assert.deepEqual(
      calls.filter(([command]) => command === 'resolve-expo-android-device'),
      [
        ['resolve-expo-android-device', SERIAL],
        ['resolve-expo-android-device', SERIAL],
      ],
    );
    assert.equal(calls.filter(([command]) => command === 'abort-build').length, 0);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('generated Android adapter aborts failure and SIGINT exactly once with no ambient selection', () => {
  for (const mode of ['failure', 'sigint'] as const) {
    const fixture = createFixture();
    try {
      const result = spawnSync('pnpm', ['android'], {
        cwd: fixture.root,
        encoding: 'utf8',
        env: { ...fixture.environment, ADAPTER_MODE: mode },
      });
      assert.notEqual(result.status, 0, `${mode}: ${result.stderr}`);
      const expo = JSON.parse(readFileSync(fixture.expoRecord, 'utf8')) as { args: string[] };
      assert.deepEqual(expo.args, ['run:android', '--device', DISPLAY_NAME, '--no-bundler']);
      const calls = readJsonLines(fixture.calls) as string[][];
      assert.equal(calls.filter(([command]) => command === 'abort-build').length, 1);
      assert.equal(calls.filter(([command]) => command === 'complete-build').length, 0);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  }
});

test('generated Android adapter refuses mapping drift and foreign device input before Expo', () => {
  for (const variant of ['drift', 'foreign'] as const) {
    const fixture = createFixture();
    try {
      const args =
        variant === 'foreign' ? ['android', '--', '--device', 'ambient-device'] : ['android'];
      const result = spawnSync('pnpm', args, {
        cwd: fixture.root,
        encoding: 'utf8',
        env: { ...fixture.environment, ...(variant === 'drift' ? { ADAPTER_MODE: 'drift' } : {}) },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /EXPO_DEVICE_IDENTITY_MISMATCH/);
      assert.equal(
        existsSync(fixture.expoRecord),
        false,
        'Expo must not run after identity refusal',
      );
      const calls = readJsonLines(fixture.calls) as string[][];
      assert.equal(calls.filter(([command]) => command === 'abort-build').length, 1);
      assert.equal(calls.filter(([command]) => command === 'complete-build').length, 0);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  }
});
