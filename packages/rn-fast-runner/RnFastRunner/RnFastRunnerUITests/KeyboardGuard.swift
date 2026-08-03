import CoreGraphics

enum KeyboardTargetValidation: Equatable {
  case ordinary
  case keyboardTarget
  case stale
}

enum KeyboardGuard {
  static let canonicalKeyboardTypes: Set<String> = ["Key", "Keyboard"]

  static func validateKeyboardDescriptor(
    command: Command,
    retained: RetainedSnapshotTarget?,
    currentGeneration: Int,
    appFrame: CGRect
  ) -> KeyboardTargetValidation {
    let claimedType = command.snapshotElementType
    let claimedKeyboardTarget = claimedType.map(canonicalKeyboardTypes.contains) == true
    let retainedKeyboardTarget = retained.map { canonicalKeyboardTypes.contains($0.type) } == true
    guard claimedKeyboardTarget || retainedKeyboardTarget else {
      return .ordinary
    }
    guard let claimedType,
          canonicalKeyboardTypes.contains(claimedType),
          let retained,
          command.snapshotGeneration == currentGeneration,
          command.snapshotGeneration == retained.generation,
          command.snapshotNodeIndex == retained.index,
          command.keyboardStateAtSnapshot == true,
          claimedType == retained.type,
          command.snapshotLabel == retained.label,
          command.snapshotIdentifier == retained.identifier,
          let bounds = command.targetBounds
    else { return .stale }
    let claimedRect = CGRect(x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height)
    let retainedRect = CGRect(
      x: retained.rect.x,
      y: retained.rect.y,
      width: retained.rect.width,
      height: retained.rect.height
    )
    guard approximatelyEqual(claimedRect, retainedRect),
          isProvenOnScreen(appFrame: appFrame, targetRect: claimedRect)
    else { return .stale }
    return .keyboardTarget
  }

  static func canActivateKeyboardTarget(
    expectedFrame: CGRect,
    liveFrame: CGRect,
    keyboardFrame: CGRect?,
    point: CGPoint
  ) -> Bool {
    guard let keyboardFrame else { return false }
    return approximatelyEqual(liveFrame, expectedFrame)
      && keyboardFrame.contains(point)
      && liveFrame.contains(point)
  }

  static func matchesLiveKeyboardTarget(
    retained: RetainedSnapshotTarget,
    candidateType: String,
    candidateLabel: String?,
    candidateIdentifier: String?,
    candidateFrame: CGRect,
    exists: Bool,
    hittable: Bool
  ) -> Bool {
    let retainedFrame = CGRect(
      x: retained.rect.x,
      y: retained.rect.y,
      width: retained.rect.width,
      height: retained.rect.height
    )
    return exists
      && hittable
      && candidateType == retained.type
      && candidateLabel == retained.label
      && candidateIdentifier == retained.identifier
      && approximatelyEqual(candidateFrame, retainedFrame)
  }

  static func isSafeDismissControl(
    type: String,
    label: String?,
    identifier: String?,
    insideKeyboard: Bool
  ) -> Bool {
    guard insideKeyboard, type == "Button" else { return false }
    let names = Set([label, identifier].compactMap { $0 })
    return names.contains("Hide keyboard") || names.contains("Dismiss keyboard")
  }

  static func approximatelyEqual(_ lhs: CGRect, _ rhs: CGRect, tolerance: CGFloat = 1.0) -> Bool {
    abs(lhs.minX - rhs.minX) <= tolerance
      && abs(lhs.minY - rhs.minY) <= tolerance
      && abs(lhs.width - rhs.width) <= tolerance
      && abs(lhs.height - rhs.height) <= tolerance
  }
  static func isProvenOnScreen(appFrame: CGRect, targetRect: CGRect) -> Bool {
    guard !appFrame.isEmpty, !targetRect.isEmpty else { return false }
    let center = CGPoint(x: targetRect.midX, y: targetRect.midY)
    return appFrame.intersects(targetRect) && appFrame.contains(center)
  }

  static func shouldDismiss(keyboardFrame: CGRect, targetRect: CGRect, minHeight: CGFloat) -> Bool {
    guard !keyboardFrame.isEmpty,
          keyboardFrame.height >= minHeight,
          !targetRect.isEmpty
    else { return false }
    return keyboardFrame.intersects(targetRect)
  }

  // Protocol-v1 compatibility only. Protocol v2 guarded presses use fresh
  // target rectangles and never treat this point test as deciding evidence.
  static func shouldDismiss(keyboardFrame: CGRect, tapPoint: CGPoint, minHeight: CGFloat) -> Bool {
    guard !keyboardFrame.isEmpty, keyboardFrame.height >= minHeight else { return false }
    return keyboardFrame.contains(tapPoint)
  }
}
