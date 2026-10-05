import XCTest

final class DispatchGuardTests: XCTestCase {
  func testKeyboardOverPointOccludesWhateverTheHitTestSays() {
    for hittable in [true, false, nil] as [Bool?] {
      XCTAssertEqual(DispatchGuard.decide(liveHittable: hittable, keyboardContainsPoint: true), .occluded)
    }
  }

  func testHitTestDecidesOutsideTheKeyboard() {
    XCTAssertEqual(DispatchGuard.decide(liveHittable: true, keyboardContainsPoint: false), .proceed)
    XCTAssertEqual(DispatchGuard.decide(liveHittable: false, keyboardContainsPoint: false), .occluded)
  }

  func testUnavailableHitTestProceeds() {
    XCTAssertEqual(DispatchGuard.decide(liveHittable: nil, keyboardContainsPoint: false), .proceed)
  }
}
