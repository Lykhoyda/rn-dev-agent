import XCTest

// GH #395: hittable = enabled ∧ non-empty frame ∧ center-in-viewport. These
// pure-logic tests pin the predicate the snapshot path emits per node.
final class SnapshotPredicatesTests: XCTestCase {
  private let viewport = CGRect(x: 0, y: 0, width: 402, height: 874)

  func testEnabledOnScreenIsHittable() {
    let frame = CGRect(x: 21, y: 790, width: 360, height: 49)
    XCTAssertTrue(computeSnapshotHittable(enabled: true, frame: frame, viewport: viewport))
  }

  func testDisabledIsNotHittable() {
    let frame = CGRect(x: 21, y: 790, width: 360, height: 49)
    XCTAssertFalse(computeSnapshotHittable(enabled: false, frame: frame, viewport: viewport))
  }

  func testEmptyFrameIsNotHittable() {
    XCTAssertFalse(computeSnapshotHittable(enabled: true, frame: .zero, viewport: viewport))
  }

  func testNullFrameIsNotHittable() {
    XCTAssertFalse(computeSnapshotHittable(enabled: true, frame: .null, viewport: viewport))
  }

  // The wizard step-2 pane sits at x=402..804 on a 402pt-wide viewport —
  // off-screen center must stay false (device-verified useful signal).
  func testCenterOutsideViewportIsNotHittable() {
    let frame = CGRect(x: 423, y: 290, width: 60, height: 39)
    XCTAssertFalse(computeSnapshotHittable(enabled: true, frame: frame, viewport: viewport))
  }

  func testInfiniteViewportFallbackIsHittable() {
    let frame = CGRect(x: 21, y: 790, width: 360, height: 49)
    XCTAssertTrue(computeSnapshotHittable(enabled: true, frame: frame, viewport: .infinite))
  }

  // Half-open viewport bounds [min, max): a center exactly on the max edge
  // taps outside the screen, so it is deterministically not hittable.
  func testCenterOnViewportMaxEdgeIsNotHittable() {
    let frame = CGRect(x: 302, y: 791, width: 200, height: 49)
    XCTAssertFalse(computeSnapshotHittable(enabled: true, frame: frame, viewport: viewport))
  }

  func testCenterOnViewportMinEdgeIsHittable() {
    let frame = CGRect(x: -180, y: 790, width: 360, height: 49)
    XCTAssertTrue(computeSnapshotHittable(enabled: true, frame: frame, viewport: viewport))
  }
}

// GH #395: filtering is hittable-independent by signature — these pin the
// de-facto content/type-based rules that always-false hittable produced.
final class SnapshotInclusionTests: XCTestCase {
  private func include(
    type: XCUIElement.ElementType = .other,
    hasContent: Bool = false,
    childCount: Int = 0,
    isScrollableContainer: Bool = false,
    isInteractiveType: Bool = false,
    visible: Bool = true,
    compact: Bool = false,
    interactiveOnly: Bool = false
  ) -> Bool {
    return shouldIncludeSnapshotNode(
      type: type,
      hasContent: hasContent,
      childCount: childCount,
      isScrollableContainer: isScrollableContainer,
      isInteractiveType: isInteractiveType,
      visible: visible,
      compact: compact,
      interactiveOnly: interactiveOnly
    )
  }

  func testDefaultModeIncludesEverything() {
    XCTAssertTrue(include())
    XCTAssertTrue(include(type: .staticText, hasContent: false))
  }

  func testCompactExcludesContentlessSingleChildOther() {
    XCTAssertFalse(include(childCount: 1, compact: true))
    XCTAssertFalse(include(childCount: 0, compact: true))
  }

  func testCompactExcludesContentlessOtherEvenWithManyChildren() {
    XCTAssertFalse(include(childCount: 3, compact: true))
  }

  func testCompactIncludesContentfulNodes() {
    XCTAssertTrue(include(hasContent: true, compact: true))
    XCTAssertTrue(include(type: .staticText, hasContent: true, compact: true))
  }

  func testCompactExcludesContentlessTypedNodes() {
    XCTAssertFalse(include(type: .image, compact: true))
  }

  func testInteractiveOnlyIncludesScrollableContainers() {
    XCTAssertTrue(include(type: .scrollView, isScrollableContainer: true, interactiveOnly: true))
  }

  func testInteractiveOnlyIncludesInteractiveTypes() {
    XCTAssertTrue(include(type: .button, isInteractiveType: true, interactiveOnly: true))
  }

  func testInteractiveOnlyIncludesContentfulNodes() {
    XCTAssertTrue(include(type: .staticText, hasContent: true, interactiveOnly: true))
  }

  func testInteractiveOnlyExcludesContentlessNonInteractive() {
    XCTAssertFalse(include(type: .image, interactiveOnly: true))
    XCTAssertFalse(include(interactiveOnly: true))
  }
}
