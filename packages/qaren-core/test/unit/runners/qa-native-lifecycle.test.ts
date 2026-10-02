import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const native = new URL(
  '../../../../rn-fast-runner/RnFastRunner/RnFastRunnerUITests/',
  import.meta.url,
);
const read = (name: string) =>
  readFileSync(new URL(`RnFastRunnerTests+${name}.swift`, native), 'utf8');
function section(source: string, start: string, end: string) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing production section ${start}`);
  return source.slice(from, to);
}

test('native no-activation agreement is independent of presence V2 and covers Android dispatch', () => {
  assert.match(read('Transport'), /"QA_READ_ONLY_V1"/);
  assert.match(read('Transport'), /"PLATFORM_PRESENCE_V2"/);
  assert.match(
    read('CommandExecution'),
    /if command\.qaReadOnly != true, let bundleId = command\.appBundleId/,
  );
  const android = new URL(
    '../../../../rn-android-runner/app/src/androidTest/java/dev/lykhoyda/rndevagent/androidrunner/',
    import.meta.url,
  );
  const dispatcher = readFileSync(new URL('CommandDispatcher.kt', android), 'utf8');
  const gate = section(
    dispatcher,
    '        if (cmd.optBoolean("qaReadOnly", false))',
    '        // GH #581: the recorded type target',
  );
  const qaBranch = gate.slice(0, gate.indexOf('} else if'));
  assert.match(qaBranch, /"snapshot", "verifyInput", "isWindowUpdating"/);
  assert.match(qaBranch, /appPackage == null \|\| !isPackageForeground\(appPackage\)/);
  assert.match(qaBranch, /return error\("ACTION_CONTEXT_CHANGED"/);
  assert.doesNotMatch(qaBranch, /foreground\(|startActivity\(/);
  assert.match(gate.slice(gate.indexOf('} else if')), /foreground\(appPackage\)/);
  assert.match(readFileSync(new URL('CommandServer.kt', android), 'utf8'), /"QA_READ_ONLY_V1"/);
});

test('actual Swift preparation and retry loop cannot activate, retarget or recover QA reads', (t) => {
  const available = spawnSync('swift', ['--version'], { encoding: 'utf8' });
  if (available.error && 'code' in available.error && available.error.code === 'ENOENT')
    return t.skip('Swift toolchain unavailable');
  assert.equal(available.status, 0, available.stderr);
  const source = read('CommandExecution');
  const helpers = source.includes('  private func qaReadOnlyRefusal(')
    ? section(source, '  private func qaReadOnlyRefusal(', '  private func executeOnMainSafely(')
    : '';
  const safe = section(
    source,
    '  private func executeOnMainSafely(',
    '  private func executeOnMain(command:',
  );
  const prepare = section(
    source,
    '  private func executeOnMain(command:',
    '    // GH #581: the recorded type target',
  );
  const result = spawnSync('swift', ['-'], {
    encoding: 'utf8',
    timeout: 90_000,
    input: `
import Foundation
${section(read('Models'), 'enum CommandType:', 'struct Response:')}
${section(read('Models'), 'struct SnapshotRect:', 'struct SnapshotNode:')}
struct ErrorPayload { var code: String? = nil; let message: String; var mutation: String? = nil }
struct DataPayload { var nodes: [Int]? = nil }
struct Response { let ok: Bool; var data: DataPayload? = nil; var error: ErrorPayload? = nil }
enum RunnerErrorDomain { static let exception = "exception"; static let general = "general" }
enum RunnerErrorCode { static let objcException = 1; static let commandReturnedNoResponse = 2 }
var activations = 0
var existenceWaits = 0
class XCUIApplication {
  enum State { case runningForeground, runningBackground, notRunning }
  var state: State = .runningForeground
  var exists = true
  init(bundleIdentifier: String = "qa.app") {}
  func activate() { activations += 1; state = .runningForeground; exists = true }
  func waitForExistence(timeout: Double) -> Bool { existenceWaits += 1; return exists }
}
enum RunnerObjCExceptionCatcher {
  static var failNext = false
  static func catchException(_ body: () -> Void) -> String? {
    if failNext { failNext = false; return "kAXErrorServerNotFound" }
    body(); return nil
  }
}
class Harness {
  let app = XCUIApplication()
  var currentApp: XCUIApplication? = XCUIApplication()
  var currentBundleId: String? = "qa.app"
  var currentSnapshotGeneration = 0
  var needsPostSnapshotInteractionDelay = false
  let mainThreadExecutionTimeout = 30.0
  let appExistenceTimeout = 1.0
  let retryCooldown = 0.0
  var sleeps = 0
  var reads = 0
  var refuseRead = false
  var throwRead = false
  func sleepFor(_ seconds: Double) { sleeps += 1 }
  func shouldRetryException(_ command: Command, message: String) -> Bool { true }
  func shouldRetryCommand(_ command: Command) -> Bool { true }
  func shouldRetryResponse(_ response: Response) -> Bool { !response.ok }
  func isRunnerLifecycleCommand(_ command: CommandType) -> Bool { false }
  func isInteractionCommand(_ command: CommandType) -> Bool { command == .tap }
  func applyInteractionStabilizationIfNeeded() {}
  func targetNeedsActivation(_ target: XCUIApplication) -> Bool { target.state != .runningForeground }
  func activateTarget(bundleId: String, reason: String) -> XCUIApplication {
    let target = XCUIApplication(bundleIdentifier: bundleId); target.activate()
    currentApp = target; currentBundleId = bundleId; return target
  }
  func platformPresenceFailure() -> Response { Response(ok: false) }
  func snapshotPlatformPresence(app: XCUIApplication, appId: String, presenceBudgetMs: Int) -> DataPayload { DataPayload() }
  func retainSnapshotTargets(_ nodes: [Int]) {}
${helpers}
${safe}
${prepare}
    reads += 1
    if throwRead { throw NSError(domain: "read", code: 1) }
    return Response(ok: !refuseRead, error: refuseRead ? ErrorPayload(message: "app is not available") : nil)
  }
  func run(_ command: Command) throws -> Response { try executeOnMainSafely(command: command) }
}
let decoder = JSONDecoder()
func command(_ verb: String, qa: Bool = true, bundle: String = "qa.app") throws -> Command {
  try decoder.decode(Command.self, from: Data("{\\"command\\":\\"\\(verb)\\",\\"appBundleId\\":\\"\\(bundle)\\",\\"qaReadOnly\\":\\(qa)}".utf8))
}
for verb in ["snapshot", "verifyInput", "isScreenStatic"] {
  for state in ["missing", "background", "changed", "gone"] {
    let h = Harness()
    let original = h.currentApp
    if state == "missing" { h.currentApp = nil }
    if state == "background" { h.currentApp!.state = .runningBackground }
    if state == "changed" { h.currentBundleId = "other.app" }
    if state == "gone" { h.currentApp!.exists = false }
    let before = activations
    let result = try h.run(command(verb))
    precondition(!result.ok && result.error?.code == "ACTION_CONTEXT_CHANGED", "QA read admitted \\(verb) \\(state)")
    precondition(activations == before && h.sleeps == 0 && h.reads == 0)
    if state != "missing" { precondition(h.currentApp === original) }
  }
  for failure in ["exception", "swift", "response"] {
    let h = Harness(); let original = h.currentApp
    RunnerObjCExceptionCatcher.failNext = failure == "exception"
    h.throwRead = failure == "swift"; h.refuseRead = failure == "response"
    let result = try h.run(command(verb))
    precondition(!result.ok && result.error?.code == "ACTION_CONTEXT_CHANGED")
    precondition(h.currentApp === original && h.currentBundleId == "qa.app" && h.sleeps == 0 && h.reads <= 1)
  }
  let h = Harness()
  let admitted = try h.run(command(verb))
  precondition(admitted.ok)
  precondition(h.reads == 1)
}
let wrong = Harness()
let rejected = try wrong.run(command("tap"))
precondition(!rejected.ok)
let legacy = Harness(); legacy.currentApp = nil
let before = activations
let legacyResult = try legacy.run(command("snapshot", qa: false))
precondition(legacyResult.ok)
precondition(activations == before + 1)
existenceWaits = 0
let present = Harness()
let presentTap = try present.run(command("tap", qa: false))
precondition(presentTap.ok && existenceWaits == 0, "a present app must not pay an existence wait")
let gone = Harness(); gone.currentApp!.exists = false; gone.app.exists = false
_ = try gone.run(command("tap", qa: false))
precondition(existenceWaits > 0, "a missing app must still be waited for")
`,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
});
