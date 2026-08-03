import XCTest
import CoreGraphics

final class KeyboardGuardTests: XCTestCase {
  func testProtocolV2FreshGeometryFieldsDecode() throws {
    let json = #"{"command":"tap","x":10,"y":20,"targetBounds":{"x":1,"y":2,"width":3,"height":4},"snapshotGeneration":7,"snapshotNodeIndex":12,"snapshotElementType":"Key","snapshotLabel":"Q","snapshotIdentifier":"key-q","keyboardStateAtSnapshot":true}"#
    let command = try JSONDecoder().decode(Command.self, from: Data(json.utf8))
    XCTAssertEqual(command.targetBounds?.width, 3)
    XCTAssertEqual(command.snapshotGeneration, 7)
    XCTAssertEqual(command.snapshotNodeIndex, 12)
    XCTAssertEqual(command.snapshotElementType, "Key")
    XCTAssertEqual(command.snapshotLabel, "Q")
    XCTAssertEqual(command.snapshotIdentifier, "key-q")
    XCTAssertEqual(command.keyboardStateAtSnapshot, true)
  }

  private func keyboardCommand(
    type: String = "Key",
    generation: Int = 7,
    index: Int = 12,
    label: String = "Q",
    x: Int = 1
  ) throws -> Command {
    let json = #"{"command":"tap","x":2,"y":4,"targetBounds":{"x":\#(x),"y":2,"width":3,"height":4},"snapshotGeneration":\#(generation),"snapshotNodeIndex":\#(index),"snapshotElementType":"\#(type)","snapshotLabel":"\#(label)","keyboardStateAtSnapshot":true}"#
    return try JSONDecoder().decode(Command.self, from: Data(json.utf8))
  }

  private var retainedKey: RetainedSnapshotTarget {
    RetainedSnapshotTarget(
      generation: 7,
      index: 12,
      type: "Key",
      label: "Q",
      identifier: nil,
      rect: SnapshotRect(x: 1, y: 2, width: 3, height: 4)
    )
  }

  func testExactCanonicalRunnerOwnedKeyQualifies() throws {
    XCTAssertEqual(
      KeyboardGuard.validateKeyboardDescriptor(
        command: try keyboardCommand(),
        retained: retainedKey,
        currentGeneration: 7,
        appFrame: CGRect(x: 0, y: 0, width: 402, height: 874)
      ),
      .keyboardTarget
    )
  }

  func testForgedStaleAndRelayoutKeyboardDescriptorsRefuse() throws {
    let frame = CGRect(x: 0, y: 0, width: 402, height: 874)
    for command in [
      try keyboardCommand(generation: 6),
      try keyboardCommand(index: 13),
      try keyboardCommand(label: "W"),
      try keyboardCommand(x: 9)
    ] {
      XCTAssertEqual(
        KeyboardGuard.validateKeyboardDescriptor(
          command: command,
          retained: retainedKey,
          currentGeneration: 7,
          appFrame: frame
        ),
        .stale
      )
    }
    let forgedRetained = RetainedSnapshotTarget(
      generation: 7,
      index: 12,
      type: "Button",
      label: "Q",
      identifier: nil,
      rect: retainedKey.rect
    )
    XCTAssertEqual(
      KeyboardGuard.validateKeyboardDescriptor(
        command: try keyboardCommand(),
        retained: forgedRetained,
        currentGeneration: 7,
        appFrame: frame
      ),
      .stale
    )
  }

  func testCanonicalRetainedTargetsCannotBeDowngraded() throws {
    let frame = CGRect(x: 0, y: 0, width: 402, height: 874)
    for type in ["key", "KEY", "Button", "Other"] {
      XCTAssertEqual(
        KeyboardGuard.validateKeyboardDescriptor(
          command: try keyboardCommand(type: type),
          retained: retainedKey,
          currentGeneration: 7,
          appFrame: frame
        ),
        .stale
      )
    }
  }

  func testOrdinaryRetainedTargetsRemainOrdinary() throws {
    let retainedButton = RetainedSnapshotTarget(
      generation: 7,
      index: 12,
      type: "Button",
      label: "Q",
      identifier: nil,
      rect: retainedKey.rect
    )
    XCTAssertEqual(
      KeyboardGuard.validateKeyboardDescriptor(
        command: try keyboardCommand(type: "Button"),
        retained: retainedButton,
        currentGeneration: 7,
        appFrame: CGRect(x: 0, y: 0, width: 402, height: 874)
      ),
      .ordinary
    )
  }

  func testFinalActivationRejectsRelayoutAndKeyboardAbsence() {
    let expected = CGRect(x: 1, y: 2, width: 30, height: 40)
    let keyboard = CGRect(x: 0, y: 0, width: 100, height: 100)
    let point = CGPoint(x: 15, y: 20)
    XCTAssertTrue(KeyboardGuard.canActivateKeyboardTarget(
      expectedFrame: expected, liveFrame: expected, keyboardFrame: keyboard, point: point
    ))
    XCTAssertFalse(KeyboardGuard.canActivateKeyboardTarget(
      expectedFrame: expected,
      liveFrame: expected.offsetBy(dx: 4, dy: 0),
      keyboardFrame: keyboard,
      point: point
    ))
    XCTAssertFalse(KeyboardGuard.canActivateKeyboardTarget(
      expectedFrame: expected, liveFrame: expected, keyboardFrame: nil, point: point
    ))
  }

  func testSafeDismissControlsExcludeDoneKeysAndExternalToolbars() {
    XCTAssertTrue(KeyboardGuard.isSafeDismissControl(
      type: "Button", label: "Hide keyboard", identifier: nil, insideKeyboard: true
    ))
    XCTAssertFalse(KeyboardGuard.isSafeDismissControl(
      type: "Key", label: "Done", identifier: nil, insideKeyboard: true
    ))
    XCTAssertFalse(KeyboardGuard.isSafeDismissControl(
      type: "Button", label: "Done", identifier: nil, insideKeyboard: true
    ))
    XCTAssertFalse(KeyboardGuard.isSafeDismissControl(
      type: "Button", label: "Dismiss keyboard", identifier: nil, insideKeyboard: false
    ))
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
