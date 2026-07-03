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
}
