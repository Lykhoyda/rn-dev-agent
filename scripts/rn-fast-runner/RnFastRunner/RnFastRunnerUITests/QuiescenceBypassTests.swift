import XCTest

final class QuiescenceBypassTests: XCTestCase {
  // MARK: - Probe decision (pure)

  func testDecideProbePrefersClassicWhenBothExist() {
    XCTAssertEqual(RNQuiescenceDecideProbe(true, true), .classic)
  }

  func testDecideProbeFallsBackToPreEvent() {
    XCTAssertEqual(RNQuiescenceDecideProbe(false, true), .preEvent)
  }

  func testDecideProbeUnavailableWhenNeitherExists() {
    XCTAssertEqual(RNQuiescenceDecideProbe(false, false), .unavailable)
  }

  // MARK: - Env parse (pure)

  func testParseBypassDefaultsOnWhenAbsent() {
    XCTAssertTrue(RNQuiescenceParseBypass(nil))
  }

  func testParseBypassStaysOnForOtherValues() {
    XCTAssertTrue(RNQuiescenceParseBypass("1"))
    XCTAssertTrue(RNQuiescenceParseBypass("true"))
    XCTAssertTrue(RNQuiescenceParseBypass("unexpected"))
  }

  func testParseBypassOptOut() {
    XCTAssertFalse(RNQuiescenceParseBypass("0"))
    XCTAssertFalse(RNQuiescenceParseBypass("false"))
    XCTAssertFalse(RNQuiescenceParseBypass(" FALSE "))
  }

  // MARK: - Live probe (drift detector)

  func testProbeResolvedAtBundleLoad() {
    // +load ran when this test bundle loaded. On every Xcode/iOS we support,
    // one of the two private selectors must resolve — if this fails, Apple
    // renamed the API and the bypass silently degraded (spec: degrade loudly).
    XCTAssertNotEqual(RNQuiescenceGetProbeResult(), .unavailable)
  }
}
