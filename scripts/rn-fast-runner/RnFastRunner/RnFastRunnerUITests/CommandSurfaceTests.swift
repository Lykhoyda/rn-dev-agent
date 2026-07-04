import XCTest

// GH #418: the compiled CommandType enum IS the iOS command surface. These
// pure-logic tests pin the bridge-required verbs and the alias trap (B235).
final class CommandSurfaceTests: XCTestCase {
  func testAllCasesCoverBridgeRequiredVerbs() {
    let advertised = Set(CommandType.allCases.map(\.rawValue))
    let required: Set<String> = [
      "tap", "type", "drag", "longPress", "pinch",
      "snapshot", "screenshot", "back", "keyboardDismiss",
    ]
    XCTAssertTrue(
      required.isSubset(of: advertised),
      "CommandType missing: \(required.subtracting(advertised))"
    )
  }

  func testAndroidKeyboardVerbIsNotAnIOSCase() {
    XCTAssertNil(CommandType(rawValue: "dismissKeyboard"))
    XCTAssertNil(CommandType(rawValue: "definitelyBogusVerb"))
  }

  // Story 04 (#385): the settle probe verb backs the SCREEN_STATIC capability
  // and must stay a lifecycle command (no activation preamble — it is a pure
  // screen read that always follows an already-activated mutating verb).
  // Deliberately NOT in the required set above: REQUIRED_IOS_COMMANDS mirrors
  // the bridge gate, and gating on this verb would force cold rebuilds of
  // every pre-settle artifact instead of the designed snapshot-poll degrade.
  func testSettleProbeVerbIsLifecycle() {
    let verb = CommandType(rawValue: "isScreenStatic")
    XCTAssertNotNil(verb)
    XCTAssertTrue(RnFastRunnerTests().isRunnerLifecycleCommand(verb!))
  }
}
