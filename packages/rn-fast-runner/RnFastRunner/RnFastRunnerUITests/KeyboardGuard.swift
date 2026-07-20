import CoreGraphics

enum KeyboardGuard {
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
