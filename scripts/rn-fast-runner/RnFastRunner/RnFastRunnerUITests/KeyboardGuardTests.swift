import XCTest
import CoreGraphics

final class KeyboardGuardTests: XCTestCase {
  let kb = CGRect(x: 0, y: 500, width: 390, height: 336) // docked, tall
  func testOccludedWhenPointInsideKeyboard() {
    XCTAssertTrue(KeyboardGuard.shouldDismiss(keyboardFrame: kb, tapPoint: CGPoint(x: 200, y: 700), minHeight: 120))
  }
  func testNotOccludedAboveKeyboard() {
    XCTAssertFalse(KeyboardGuard.shouldDismiss(keyboardFrame: kb, tapPoint: CGPoint(x: 200, y: 480), minHeight: 120))
  }
  func testAccessoryBarTooShortNotOccluded() {
    let bar = CGRect(x: 0, y: 800, width: 390, height: 44)
    XCTAssertFalse(KeyboardGuard.shouldDismiss(keyboardFrame: bar, tapPoint: CGPoint(x: 200, y: 820), minHeight: 120))
  }
  func testEmptyFrameNeverOccludes() {
    XCTAssertFalse(KeyboardGuard.shouldDismiss(keyboardFrame: .zero, tapPoint: CGPoint(x: 1, y: 9999), minHeight: 120))
  }
  func testFloatingKeyboardUsesXContainment() {
    let floating = CGRect(x: 40, y: 500, width: 300, height: 300)
    XCTAssertFalse(KeyboardGuard.shouldDismiss(keyboardFrame: floating, tapPoint: CGPoint(x: 10, y: 600), minHeight: 120))
  }
}
