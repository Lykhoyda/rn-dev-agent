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
      XCTAssertEqual(result.hittable, expected)
      XCTAssertEqual(reads, resolutionTime >= 0.3 ? 0 : 1)
      XCTAssertEqual(DispatchGuard.decide(liveHittable: result.hittable, keyboardContainsPoint: false), expected == false ? .occluded : .proceed)
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
    XCTAssertNil(result.hittable)
    XCTAssertEqual(resolutions, 0)
  }

  func testMovedTargetRefusesWithoutReadingHittabilityOrDispatching() {
    for frameMatches in [false, true] {
      var reads = 0
      var taps = 0
      let check = DispatchGuard.hitTest(
        deadline: 0.3,
        now: { 0.1 },
        resolve: { 1 },
        matchesFrame: { _ in frameMatches },
        read: { _ in reads += 1; return true }
      )
      let decision = DispatchGuard.decide(
        liveHittable: check.hittable,
        keyboardContainsPoint: false,
        targetMoved: check == .moved
      )
      if decision == .proceed { taps += 1 }
      XCTAssertEqual(decision, frameMatches ? .proceed : .moved)
      XCTAssertEqual(taps, frameMatches ? 1 : 0)
      XCTAssertEqual(reads, frameMatches ? 1 : 0)
    }
  }

  func testUnavailableFrameChecksStillProceed() {
    for mode in ["no-match", "ambiguous", "thrown", "over-budget", "generation"] {
      var time = 0.1
      let check = DispatchGuard.hitTest(
        deadline: 0.3,
        now: { time },
        resolve: { mode == "no-match" || mode == "ambiguous" || mode == "generation" ? nil : 1 },
        matchesFrame: { _ in
          if mode == "over-budget" { time = 0.4; return false }
          return nil
        },
        read: { _ in true }
      )
      XCTAssertEqual(check, .unavailable)
      XCTAssertEqual(DispatchGuard.decide(liveHittable: check.hittable, keyboardContainsPoint: false, targetMoved: check == .moved), .proceed)
    }
  }

  func testFillFrameCheckLeavesHittabilityForTheFocusPointCheck() {
    var time = 0.0
    var reads = 0
    let frameOnly = DispatchGuard.hitTest(
      deadline: 0.3,
      now: { time },
      resolve: { time += 0.05; return 1 },
      matchesFrame: { _ in true },
      checkHittability: false,
      read: { _ in reads += 1; time += 0.2; return false }
    )
    XCTAssertEqual(frameOnly, .unavailable)
    XCTAssertEqual(reads, 0)
    time += 0.06
    let focusPoint = DispatchGuard.hitTest(
      deadline: 0.3,
      now: { time },
      resolve: { 1 },
      read: { _ in reads += 1; time += 0.1; return false }
    )
    XCTAssertEqual(reads, 1)
    XCTAssertEqual(DispatchGuard.decide(liveHittable: focusPoint.hittable, keyboardContainsPoint: false), .occluded)
    let moved = DispatchGuard.hitTest(
      deadline: 0.3, now: { 0.1 }, resolve: { 1 },
      matchesFrame: { _ in false }, checkHittability: false,
      read: { _ in XCTFail("frame-only check must not read hittability"); return true }
    )
    XCTAssertEqual(moved, .moved)
  }

  func testMovedMessageCarriesBothFramesTheDeltaAndTheTolerance() {
    let message = DispatchGuard.movedMessage(
      retained: CGRect(x: 16, y: 742.5, width: 370, height: 48),
      live: CGRect(x: 16, y: 744, width: 370, height: 48)
    )
    XCTAssertTrue(message.hasPrefix("TARGET_MOVED_BEFORE_DISPATCH: "), message)
    XCTAssertTrue(message.contains("retained 16.0,742.5,370.0,48.0"), message)
    XCTAssertTrue(message.contains("live 16.0,744.0,370.0,48.0"), message)
    XCTAssertTrue(message.contains("delta 0.0,1.5,0.0,0.0"), message)
    XCTAssertTrue(message.contains("tolerance 1.0"), message)
    XCTAssertTrue(message.contains("no tap or typing was performed"), message)
  }
}
