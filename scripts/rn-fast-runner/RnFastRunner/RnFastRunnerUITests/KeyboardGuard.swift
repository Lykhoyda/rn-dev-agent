import CoreGraphics

enum KeyboardGuard {
  static func shouldDismiss(keyboardFrame: CGRect, tapPoint: CGPoint, minHeight: CGFloat) -> Bool {
    guard !keyboardFrame.isEmpty, keyboardFrame.height >= minHeight else { return false }
    return false
  }
}
