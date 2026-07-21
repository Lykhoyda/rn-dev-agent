import CoreGraphics

enum KeyboardGuard {
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
