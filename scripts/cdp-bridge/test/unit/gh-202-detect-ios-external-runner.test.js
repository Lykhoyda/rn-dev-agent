import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectIosExternalRunner } from '../../dist/runners/external-runner-detect.js';

const fakePs = (stdout) => async () => ({ stdout });

// Real signatures captured from a live `ps ax -o command=` during a maestro flow (Task 0).
const UDID = 'FC78646A-56D5-4737-9CD0-A360D622F3B3';
const OTHER_UDID = 'AAAAAAAA-1111-2222-3333-BBBBBBBBBBBB';
const MAESTRO_DRIVER = `18225 /Users/x/Library/Developer/CoreSimulator/Devices/${UDID}/data/Containers/Bundle/Application/155F/maestro-driver-iosUITests-Runner.app/maestro-driver-iosUITests-Runner`;
const MAESTRO_XCODEBUILD = `17754 /Applications/Xcode.app/.../xcodebuild test-without-building -xctestrun /tmp/${UDID}/maestro-driver-ios-config.xctestrun -destination id=${UDID}`;
const MAESTRO_MCP_IDLE = '14013 java -classpath /Users/x/.maestro/lib/* maestro.cli.AppKt mcp'; // NB: carries no UDID
const OUR_RUNNER = `99 /Users/x/Library/Developer/CoreSimulator/Devices/${UDID}/.../RnFastRunnerUITests-Runner.app/RnFastRunnerUITests-Runner`;

test('detectIosExternalRunner: flags a foreign maestro driver on the target UDID', async () => {
  const ps = fakePs(`${MAESTRO_DRIVER}\n${MAESTRO_XCODEBUILD}\n800 /usr/bin/login\n`);
  const w = await detectIosExternalRunner(ps, UDID);
  assert.ok(w);
  assert.equal(w.platform, 'ios');
  assert.equal(w.code, 'IOS_XCUITEST_COMPETITOR');
  assert.equal(w.processLines.length, 2);
  assert.match(w.processLines[0], /maestro-driver-iosUITests-Runner/);
});

test('detectIosExternalRunner: UDID-scopes — a maestro flow on a DIFFERENT sim is ignored', async () => {
  const ps = fakePs(MAESTRO_DRIVER + '\n');
  assert.equal(await detectIosExternalRunner(ps, OTHER_UDID), null);
});

test('detectIosExternalRunner: ignores the idle maestro-mcp server (no UDID)', async () => {
  const ps = fakePs(`${MAESTRO_MCP_IDLE}\n800 /usr/bin/login\n`);
  assert.equal(await detectIosExternalRunner(ps, UDID), null);
});

test('detectIosExternalRunner: excludes our own RnFastRunner even on the target UDID', async () => {
  const ps = fakePs(OUR_RUNNER + '\n');
  assert.equal(await detectIosExternalRunner(ps, UDID), null);
});

test('detectIosExternalRunner: null when no automation process present', async () => {
  const ps = fakePs('801 /usr/bin/login\n802 /System/Library/Foo\n');
  assert.equal(await detectIosExternalRunner(ps, UDID), null);
});

test('detectIosExternalRunner: error-safe when ps fails', async () => {
  const ps = async () => { throw new Error('ps blew up'); };
  assert.equal(await detectIosExternalRunner(ps, UDID), null);
});
