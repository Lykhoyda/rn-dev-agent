import XCTest

final class TextInputMutationTests: XCTestCase {
  func testExactNonEmptyReadback() {
    XCTAssertEqual(
      TextInputMutation.classify(
        expected: "requested",
        before: "",
        after: "requested",
        placeholder: "Hint",
        secure: false
      ),
      .exact
    )
  }

  func testPlaceholderBearingClearIsExactWhenChangeProvesClear() {
    XCTAssertEqual(
      TextInputMutation.classify(
        expected: "",
        before: "old",
        after: "Hint",
        placeholder: "Hint",
        secure: false
      ),
      .exact
    )
  }

  func testLiteralPlaceholderValueCannotFalseSucceedAsClear() {
    XCTAssertEqual(
      TextInputMutation.classify(
        expected: "",
        before: "Hint",
        after: "Hint",
        placeholder: "Hint",
        secure: false
      ),
      .unreadable
    )
  }

  func testMismatchAndSecureReadbackRefuse() {
    XCTAssertEqual(
      TextInputMutation.classify(
        expected: "requested",
        before: "",
        after: "transformed",
        placeholder: nil,
        secure: false
      ),
      .mismatch
    )
    XCTAssertEqual(
      TextInputMutation.classify(
        expected: "requested",
        before: "",
        after: "••••",
        placeholder: nil,
        secure: true
      ),
      .unreadable
    )
  }
}
