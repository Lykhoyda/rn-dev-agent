import XCTest
import CoreGraphics

final class KeyboardGuardTests: XCTestCase {
  func testProtocolV2FreshGeometryFieldsDecode() throws {
    let json = #"{"command":"tap","x":10,"y":20,"targetBounds":{"x":1,"y":2,"width":3,"height":4},"snapshotGeneration":7,"keyboardStateAtSnapshot":true}"#
    let command = try JSONDecoder().decode(Command.self, from: Data(json.utf8))
    XCTAssertEqual(command.targetBounds?.width, 3)
    XCTAssertEqual(command.snapshotGeneration, 7)
    XCTAssertEqual(command.keyboardStateAtSnapshot, true)
  }

  func testTargetGeometryMustBeOnScreen() {
    let app = CGRect(x: 0, y: 0, width: 402, height: 874)
    XCTAssertTrue(
      KeyboardGuard.isProvenOnScreen(
        appFrame: app,
        targetRect: CGRect(x: 20, y: 550, width: 200, height: 44)
      )
    )
    XCTAssertFalse(
      KeyboardGuard.isProvenOnScreen(
        appFrame: app,
        targetRect: CGRect(x: 20, y: 918, width: 200, height: 44)
      )
    )
  }

  func testRectIntersectionUsesFreshGeometry() {
    let kb = CGRect(x: 0, y: 500, width: 400, height: 350)
    XCTAssertTrue(
      KeyboardGuard.shouldDismiss(
        keyboardFrame: kb,
        targetRect: CGRect(x: 40, y: 480, width: 120, height: 40),
        minHeight: 120
      )
    )
    XCTAssertFalse(
      KeyboardGuard.shouldDismiss(
        keyboardFrame: kb,
        targetRect: CGRect(x: 40, y: 430, width: 120, height: 40),
        minHeight: 120
      )
    )
  }

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
  func testCommandDecodesGuardKeyboardFalse() throws {
    let json = #"{"command":"tap","x":1,"y":2,"guardKeyboard":false}"#.data(using: .utf8)!
    let cmd = try JSONDecoder().decode(Command.self, from: json)
    XCTAssertEqual(cmd.guardKeyboard, false)
  }
}
