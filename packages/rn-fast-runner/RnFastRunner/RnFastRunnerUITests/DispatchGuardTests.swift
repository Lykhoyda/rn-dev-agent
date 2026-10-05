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
  func testResolutionAndReadShareOneDeadline() {
    for (resolutionTime, readTime, expected) in [(0.5, 0.02, nil), (0.2, 0.2, nil), (0.1, 0.02, false)] as [(Double, Double, Bool?)] {
      var time = 0.0
      var reads = 0
      let result = DispatchGuard.hitTest(
        deadline: 0.3,
        now: { time },
        resolve: { time += resolutionTime; return 1 },
        read: { _ in reads += 1; time += readTime; return false }
      )
      XCTAssertEqual(result, expected)
      XCTAssertEqual(reads, resolutionTime >= 0.3 ? 0 : 1)
      XCTAssertEqual(DispatchGuard.decide(liveHittable: result, keyboardContainsPoint: false), expected == false ? .occluded : .proceed)
    }
  }

  func testExpiredDeadlineSkipsResolution() {
    var resolutions = 0
    let result = DispatchGuard.hitTest(
      deadline: 0.3,
      now: { 0.5 },
      resolve: { resolutions += 1; return 1 },
      read: { _ in false }
    )
    XCTAssertNil(result)
    XCTAssertEqual(resolutions, 0)
  }
}
