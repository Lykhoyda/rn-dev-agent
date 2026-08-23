import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { renderProjectAdapter } from '../../dist/session/package-integration.js';

const requireFromTest = createRequire(import.meta.url);
const expoBundlerPropsPath = requireFromTest.resolve('@expo/cli/build/src/run/resolveBundlerProps');
const expoPortPath = requireFromTest.resolve('@expo/cli/build/src/utils/port');

function startMetro(
  root: string,
  requestReceipt: string,
): Promise<{ process: ChildProcessWithoutNullStreams; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `const fs=require('node:fs');const net=require('node:net');const server=net.createServer((socket)=>{socket.once('data',(data)=>{fs.appendFileSync(process.env.REQUEST_RECEIPT,JSON.stringify({request:String(data)})+'\\n');socket.end('HTTP/1.1 200 OK\\r\\nContent-Length: 23\\r\\n\\r\\npackager-status:running');});});server.listen(0,()=>process.stdout.write(String(server.address().port)+'\\n'));process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`,
      ],
      { cwd: root, env: { ...process.env, REQUEST_RECEIPT: requestReceipt } },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf('\n');
      if (newline >= 0) resolve({ process: child, port: Number(stdout.slice(0, newline)) });
    });
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Metro fixture exited ${code}: ${stderr}`)));
  });
}

function stopMetro(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
  });
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

test(
  'integrated Android adapter sends one allocated port through launch, wait, and bind',
  { skip: process.platform === 'win32' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'rn-adapter-android-port-'));
    const requestReceipt = join(root, 'requests.jsonl');
    const metro = await startMetro(root, requestReceipt);
    const port = metro.port;
    assert.notEqual(port, 8081, 'fixture requires a non-default Metro port');
    try {
      const integration = join(root, '.rn-agent', 'integration');
      const bin = join(root, 'bin');
      const adapter = join(integration, 'rn-session-adapter.cjs');
      const sessionCli = join(root, 'rn-session.cjs');
      const launchReceipt = join(root, 'launch.json');
      const bindReceipt = join(root, 'bind.json');
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
        join(bin, 'corepack'),
        `#!/usr/bin/env node
const {spawnSync}=require('node:child_process');
const path=require('node:path');
if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['pnpm','run','android']))process.exit(91);
const result=spawnSync(process.execPath,[path.join(process.cwd(),'.rn-agent/integration/rn-session-adapter.cjs'),'android'],{cwd:process.cwd(),env:process.env,stdio:'inherit'});
if(result.signal)process.exit(128);process.exit(result.status??1);
`,
      );
      chmodSync(join(bin, 'corepack'), 0o755);
      writeFileSync(
        join(bin, 'expo'),
        `#!/usr/bin/env node
const fs=require('node:fs');
const http=require('node:http');
const args=process.argv.slice(2);
const port=Number(args[args.indexOf('--port')+1]);
const waitUrl='http://127.0.0.1:'+port+'/status';
require(${JSON.stringify(expoBundlerPropsPath)}).resolveBundlerPropsAsync(process.cwd(),{bundler:true,port}).then((resolved)=>{
  if(resolved.port!==port)process.exit(94);
  return (resolved.shouldStartBundler?require(${JSON.stringify(expoPortPath)}).ensurePortAvailabilityAsync(process.cwd(),resolved):Promise.resolve(false)).then((available)=>{
  if(resolved.shouldStartBundler&&!available)resolved.shouldStartBundler=false;
  if(resolved.shouldStartBundler)process.exit(96);
  const request=http.get(waitUrl,(response)=>{let body='';response.on('data',(chunk)=>body+=chunk);response.on('end',()=>{fs.writeFileSync(process.env.LAUNCH_RECEIPT,JSON.stringify({args,waitUrl,body,resolved,rctPort:process.env.RCT_METRO_PORT,gradlePort:process.env.ORG_GRADLE_PROJECT_reactNativeDevServerPort,proxyUrl:process.env.EXPO_PACKAGER_PROXY_URL,sessionId:process.env.RN_DEV_AGENT_SESSION_ID}));process.exit(response.statusCode===200?0:93);});});
  request.on('error',(error)=>{process.stderr.write(error.message+'\\n');process.exit(92);});
  request.setTimeout(3000,()=>request.destroy(new Error('wait timed out')));
  });
}).catch((error)=>{process.stderr.write(String(error.message||error)+'\\n');process.exit(95);});
`,
      );
      chmodSync(join(bin, 'expo'), 0o755);
      writeFileSync(
        sessionCli,
        `const fs=require('node:fs');
const args=process.argv.slice(2);
const port=Number(process.env.ALLOCATED_PORT);
if(args[0]==='prepare-build')process.stdout.write(JSON.stringify({platform:'android',deviceId:'emulator-5690',appId:'com.rndevagent.testapp',metroPort:port,sessionId:'session-port-parity',buildToken:args[2]}));
else if(args[0]==='resolve-expo-android-device')process.stdout.write(JSON.stringify({deviceId:args[1],displayName:'Pixel_9_Pro'}));
else if(args[0]==='complete-build'){const launch=JSON.parse(fs.readFileSync(process.env.LAUNCH_RECEIPT,'utf8'));const launcherPort=Number(launch.args[launch.args.indexOf('--port')+1]);if(launcherPort!==port||launch.rctPort!==String(port)||launch.gradlePort!==String(port)||new URL(launch.proxyUrl).port!==String(port)){process.stderr.write('SESSION_BUILD_IDENTITY_CONFLICT: adapter port parity failed\\n');process.exit(2);}fs.writeFileSync(process.env.BIND_RECEIPT,JSON.stringify({bound:true,metroPort:port,launcherPort,waitUrl:launch.waitUrl}));process.stdout.write('{"receipt":true}\\n');}
else if(args[0]==='abort-build')process.stdout.write('{"aborted":true}\\n');
else process.exit(94);
`,
      );

      const result = await run('corepack', ['pnpm', 'run', 'android'], root, {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        ALLOCATED_PORT: String(port),
        LAUNCH_RECEIPT: launchReceipt,
        BIND_RECEIPT: bindReceipt,
      });
      assert.equal(result.code, 0, result.stderr);

      const launch = JSON.parse(readFileSync(launchReceipt, 'utf8')) as {
        args: string[];
        waitUrl: string;
        body: string;
        resolved: { port: number; shouldStartBundler: boolean };
        rctPort: string;
        gradlePort: string;
        proxyUrl: string;
      };
      assert.deepEqual(launch.args, [
        'run:android',
        '--device',
        'Pixel_9_Pro',
        '--port',
        String(port),
      ]);
      assert.equal(launch.waitUrl, `http://127.0.0.1:${port}/status`);
      assert.equal(launch.body, 'packager-status:running');
      assert.deepEqual(launch.resolved, { port, shouldStartBundler: false });
      assert.equal(launch.rctPort, String(port));
      assert.equal(launch.gradlePort, String(port));
      assert.equal(new URL(launch.proxyUrl).port, String(port));
      const requests = readFileSync(requestReceipt, 'utf8')
        .trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as { request: string }).request);
      assert.ok(requests.length >= 1);
      assert.ok(requests.every((request) => request.includes(`Host: 127.0.0.1:${port}`)));
      assert.ok(requests.some((request) => request.startsWith('GET /status ')));
      assert.deepEqual(JSON.parse(readFileSync(bindReceipt, 'utf8')), {
        bound: true,
        metroPort: port,
        launcherPort: port,
        waitUrl: `http://127.0.0.1:${port}/status`,
      });
    } finally {
      await stopMetro(metro.process);
      rmSync(root, { force: true, recursive: true });
    }
  },
);
