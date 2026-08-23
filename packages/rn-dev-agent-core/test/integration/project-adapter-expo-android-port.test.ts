import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CDPClient } from '../../dist/cdp-client.js';
import { canonicalAuthorityJson } from '../../dist/session/authority-json.js';
import { connectExactSessionTarget } from '../../dist/session/connect-exact-session-target.js';
import { pinExactDevClient } from '../../dist/session/dev-client-authority.js';
import { buildSignedMetroMarker } from '../../dist/session/metro-authority.js';
import { renderProjectAdapter } from '../../dist/session/package-integration.js';
import { readProcessBirth } from '../../dist/session/process-birth.js';
import { createRegisteredConnectHandler } from '../../dist/session/registered-connect.js';
import { openSessionRegistry } from '../../dist/session/registry.js';
import { resolveSourceIdentity } from '../../dist/session/source-identity.js';
import { createAuthorityStateLayout, writeSessionSecret } from '../../dist/session/state-root.js';
import { createSessionHandler } from '../../dist/tools/session.js';

const requireFromTest = createRequire(import.meta.url);
const expoBundlerPropsPath = requireFromTest.resolve('@expo/cli/build/src/run/resolveBundlerProps');
const expoStartBundlerPath = requireFromTest.resolve('@expo/cli/build/src/run/startBundler');
const wsPath = requireFromTest.resolve('ws');
const sessionCli = new URL('../../dist/rn-session.js', import.meta.url).pathname;

function startManagedFixture(
  root: string,
  requestReceipt: string,
): Promise<{ process: ChildProcessWithoutNullStreams; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `const fs=require('node:fs');const http=require('node:http');const {WebSocketServer}=require(${JSON.stringify(wsPath)});let port=0;const server=http.createServer((req,res)=>{fs.appendFileSync(process.env.REQUEST_RECEIPT,JSON.stringify({url:req.url,host:req.headers.host})+'\\n');if(req.url==='/status'){res.writeHead(200).end('packager-status:running');return;}if(req.url&&req.url.startsWith('/json')){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify([{id:'android-target',title:'com.rndevagent.testapp (Pixel 9 Pro)',description:'com.rndevagent.testapp',appId:'com.rndevagent.testapp',vm:'Hermes',type:'node',deviceName:'Pixel 9 Pro',webSocketDebuggerUrl:'ws://127.0.0.1:'+port+'/inspector/debug?device=android-target'}]));return;}res.writeHead(200,{'content-type':'application/expo+json'}).end(JSON.stringify({launchAsset:{url:'http://127.0.0.1:'+port+'/index.bundle'}}));});const wss=new WebSocketServer({server});wss.on('connection',(socket)=>socket.on('message',(raw)=>{const message=JSON.parse(raw.toString());socket.send(JSON.stringify({id:message.id,result:message.method==='Runtime.evaluate'?{result:{type:'boolean',value:true}}:{}}));}));server.listen(0,()=>{port=server.address().port;process.stdout.write(String(port)+'\\n');});process.on('SIGTERM',()=>wss.close(()=>server.close(()=>process.exit(0))));`,
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

function stopFixture(child: ChildProcessWithoutNullStreams): Promise<void> {
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
  'integrated Android adapter carries one allocated port through production launch and bind',
  { skip: process.platform !== 'darwin' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'rn-adapter-android-port-'));
    const appRoot = join(root, 'app');
    const stateHome = join(root, 'state');
    const requestReceipt = join(root, 'requests.jsonl');
    mkdirSync(appRoot);
    const metro = await startManagedFixture(appRoot, requestReceipt);
    const port = metro.port;
    assert.notEqual(port, 8081, 'fixture requires a non-default Metro port');
    let activeClient = new CDPClient(port);
    try {
      const integration = join(appRoot, '.rn-agent', 'integration');
      const bin = join(root, 'bin');
      const adapter = join(integration, 'rn-session-adapter.cjs');
      const launchReceipt = join(root, 'launch.json');
      mkdirSync(integration, { recursive: true });
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        join(appRoot, 'package.json'),
        JSON.stringify({
          private: true,
          name: 'adapter-port-fixture',
          dependencies: { expo: '56.0.0' },
          scripts: { android: 'node .rn-agent/integration/rn-session-adapter.cjs android' },
        }),
      );
      mkdirSync(join(appRoot, 'node_modules', 'expo'), { recursive: true });
      writeFileSync(
        join(appRoot, 'node_modules', 'expo', 'package.json'),
        JSON.stringify({ name: 'expo', version: '56.0.0' }),
      );
      writeFileSync(join(appRoot, 'metro.config.js'), 'module.exports = {};\n');
      execFileSync('git', ['init', '-q'], { cwd: appRoot });
      execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: appRoot });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: appRoot });
      execFileSync('git', ['add', 'package.json', 'metro.config.js'], { cwd: appRoot });
      execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'], {
        cwd: appRoot,
      });
      writeFileSync(adapter, renderProjectAdapter(), { mode: 0o755 });
      writeFileSync(join(integration, 'authority-marker.js'), '', { mode: 0o600 });
      writeFileSync(
        join(integration, 'rn-session-integration.json'),
        JSON.stringify({
          version: 1,
          adapter: '.rn-agent/integration/rn-session-adapter.cjs',
          sessionCli,
          stateDir: stateHome,
          originalScripts: { ios: ['expo', 'run:ios'], android: ['expo', 'run:android'] },
        }),
      );
      writeFileSync(
        join(bin, 'corepack'),
        `#!/usr/bin/env node
const {spawnSync}=require('node:child_process');
const path=require('node:path');
if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['pnpm','run','android']))process.exit(91);
const result=spawnSync(process.execPath,[path.join(process.cwd(),'.rn-agent/integration/rn-session-adapter.cjs'),'android'],{cwd:process.cwd(),env:process.env,stdio:'inherit'});
process.exit(result.status??1);
`,
      );
      chmodSync(join(bin, 'corepack'), 0o755);
      writeFileSync(
        join(bin, 'expo'),
        `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
const port=Number(args[args.indexOf('--port')+1]);
const resolve=require(${JSON.stringify(expoBundlerPropsPath)}).resolveBundlerPropsAsync;
const start=require(${JSON.stringify(expoStartBundlerPath)}).startBundlerAsync;
(async()=>{const resolved=await resolve(process.cwd(),{bundler:true,port});const manager=await start(process.cwd(),{port:resolved.port,headless:!resolved.shouldStartBundler});fs.writeFileSync(process.env.LAUNCH_RECEIPT,JSON.stringify({args,resolved,waitUrl:'http://127.0.0.1:'+resolved.port+'/status',rctPort:process.env.RCT_METRO_PORT,gradlePort:process.env.ORG_GRADLE_PROJECT_reactNativeDevServerPort,proxyUrl:process.env.EXPO_PACKAGER_PROXY_URL}));await manager.stopAsync();})().catch((error)=>{process.stderr.write(String(error.message||error)+'\\n');process.exit(1);});
`,
      );
      chmodSync(join(bin, 'expo'), 0o755);
      writeFileSync(
        join(bin, 'adb'),
        `#!/usr/bin/env node
const a=process.argv.slice(2);if(a[0]==='devices'){process.stdout.write('List of devices attached\\nemulator-5690 device product:sdk model:Pixel_9_Pro device:emu\\n');}else if(a.includes('emu')){process.stdout.write('Pixel_9_Pro\\n');}else if(a.includes('pm')&&a.includes('path')){process.stdout.write('package:/data/app/base.apk\\n');}else if(a.includes('stat')){process.stdout.write('/data/app/base.apk:1:12:1\\n');}else if(a.includes('cat')){process.stdout.write('fixture-apk');}else if(a.includes('ro.product.model')){process.stdout.write('Pixel 9 Pro\\n');}else process.stdout.write('');
`,
      );
      chmodSync(join(bin, 'adb'), 0o755);
      writeFileSync(
        join(bin, 'lsof'),
        `#!/usr/bin/env node
const a=process.argv.slice(2);if(a[0]&&a[0].startsWith('-i:'))process.stdout.write(${JSON.stringify(String(metro.process.pid!))}+'\\n');else if(a.includes('-F'))process.stdout.write(${JSON.stringify(`n${appRoot}\n`)});else process.exit(1);
`,
      );
      chmodSync(join(bin, 'lsof'), 0o755);

      const source = resolveSourceIdentity(appRoot);
      const layout = createAuthorityStateLayout(stateHome);
      const signerCapability = 'adapter-port-signer';
      const birth = readProcessBirth(metro.process.pid!);
      assert.ok(birth);
      const authority = {
        port,
        pid: metro.process.pid!,
        birth: birth.token,
        launcherPid: metro.process.pid!,
        launcherBirth: birth.token,
        instanceId: 'metro-port-parity',
        runtimeEvidencePath: join(root, 'runtime-evidence.jsonl'),
        runtimeEvidenceSocket: join(root, 'runtime-evidence.sock'),
        runtimeEvidenceAuthority: 'reported-v1' as const,
        runtimeEvidenceProtocol: 2 as const,
        servingRoot: appRoot,
        buildGeneration: 1,
      };
      writeFileSync(authority.runtimeEvidencePath, '');
      writeFileSync(authority.runtimeEvidenceSocket, '');
      const sessionId = 'session-port-parity';
      let registry = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
      const session = registry.createSession({
        sessionId,
        sourceKey: source.sourceKey,
        worktreeKey: source.worktreeKey,
        appRootKey: source.appRootKey,
        supervisor: { pid: process.pid, token: readProcessBirth(process.pid)?.token ?? 'fixture' },
        source: { ...source },
        bindings: {
          metroPort: port,
          device: {
            platform: 'android',
            deviceId: 'emulator-5690',
            appId: 'com.rndevagent.testapp',
          },
          metro: {
            mode: 'managed',
            ...authority,
            managementProof: createHmac('sha256', signerCapability)
              .update(canonicalAuthorityJson({ sessionId, ...authority }))
              .digest('hex'),
          },
        },
      });
      registry.updateBindings(session, { state: 'metro_bound', bindings: {} });
      registry.close();
      writeSessionSecret(layout, sessionId, {
        signerCapability,
        observeCapability: 'observe',
        recoveryCapability: 'recovery',
      });

      const result = await run('corepack', ['pnpm', 'run', 'android'], appRoot, {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        LAUNCH_RECEIPT: launchReceipt,
      });
      assert.equal(result.code, 0, result.stderr);

      registry = openSessionRegistry(layout.registry, { ownerStatus: () => 'match' });
      const runtime = {
        status: () => ({ available: true as const, ...registry.getSessionStatus(sessionId)! }),
        requireOperational: () => ({ registry, session }),
      };
      const pinDevClient = async (
        status: ReturnType<typeof runtime.status>,
        _options: { force: boolean },
        commitBundle: Parameters<typeof pinExactDevClient>[1]['commitBundle'],
      ) => {
        const device = status.bindings.device as {
          platform: 'android';
          deviceId: string;
          appId: string;
        };
        const managed = status.bindings.metro as {
          port: number;
          instanceId: string;
          buildGeneration: number;
        };
        return pinExactDevClient(
          {
            sessionId,
            metroInstanceId: managed.instanceId,
            worktreeKey: source.worktreeKey,
            appId: device.appId,
            platform: device.platform,
            buildGeneration: managed.buildGeneration,
            deviceId: device.deviceId,
            metroPort: managed.port,
            runtimeKind: 'expo-dev-client',
            signerCapability,
          },
          {
            openUrl: async () => assert.fail('emulator build has no declared URL'),
            launchExactApp: async () => {},
            launchExactAppWithInitialUrl: async () => assert.fail('Android has no initial URL'),
            acceptIosOpenDialog: async () => {},
            connectExact: (input) =>
              connectExactSessionTarget(input, 5_000, {
                getClient: () => activeClient,
                setClient: (client) => {
                  activeClient = client;
                },
                publishClient: (expected, replacement) => {
                  if (activeClient !== expected) return false;
                  activeClient = replacement;
                  return true;
                },
                createClient: (exactPort) => new CDPClient(exactPort),
                createAttemptClient: (exactPort) => new CDPClient(exactPort),
                execute: async (file, args) => ({
                  stdout:
                    file === 'adb' && args[0] === 'devices'
                      ? 'List of devices attached\nemulator-5690\tdevice\n'
                      : 'Pixel 9 Pro\n',
                }),
              }),
            readMarker: async () => ({
              status: 'signed' as const,
              marker: buildSignedMetroMarker(
                {
                  sessionId,
                  metroInstanceId: managed.instanceId,
                  worktreeKey: source.worktreeKey,
                  appId: device.appId,
                  platform: 'android',
                  buildGeneration: managed.buildGeneration,
                },
                signerCapability,
              ),
            }),
            readManagedManifest: async () => ({
              body: JSON.stringify({
                launchAsset: { url: `http://127.0.0.1:${port}/index.bundle` },
              }),
              contentType: 'application/expo+json',
              status: 200,
            }),
            commitBundle,
          },
        );
      };
      const sessionHandler = createSessionHandler(runtime as never, { pinDevClient } as never);
      const connect = createRegisteredConnectHandler(runtime as never, (input) =>
        sessionHandler(input as never),
      );
      const connected = await connect({});
      assert.equal(connected.isError, undefined, connected.content[0]!.text);

      const launch = JSON.parse(readFileSync(launchReceipt, 'utf8')) as {
        args: string[];
        resolved: { port: number; shouldStartBundler: boolean };
        waitUrl: string;
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
      assert.deepEqual(launch.resolved, { port, shouldStartBundler: false });
      assert.equal(launch.waitUrl, `http://127.0.0.1:${port}/status`);
      assert.equal(launch.rctPort, String(port));
      assert.equal(launch.gradlePort, String(port));
      assert.equal(new URL(launch.proxyUrl).port, String(port));
      const bound = registry.getSessionStatus(sessionId)!;
      assert.equal(bound.state, 'ready');
      assert.equal((bound.bindings.install as { metroPort: number }).metroPort, port);
      assert.equal((bound.bindings.bundle as { metroPort: number }).metroPort, port);
      assert.equal((bound.bindings.bundle as { targetId: string }).targetId, 'android-target');
      const requests = readFileSync(requestReceipt, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { host: string; url: string });
      assert.ok(requests.every((request) => request.host.endsWith(`:${port}`)));
      registry.close();
    } finally {
      await activeClient.disconnect().catch(() => {});
      await stopFixture(metro.process);
      rmSync(root, { force: true, recursive: true });
    }
  },
);
