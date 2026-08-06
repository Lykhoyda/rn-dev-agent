import Foundation

/// Secret-free exact-readback classification for one XCTest text mutation.
enum TextInputMutation {
  enum Verdict: Equatable {
    case exact
    case mismatch
    case unreadable
  }

  static func classify(
    expected: String,
    before: String?,
    after: String?,
    placeholder: String?,
    secure: Bool
  ) -> Verdict {
    if secure { return .unreadable }
    guard let after else { return .unreadable }
    if expected.isEmpty {
      if after.isEmpty { return .exact }
      if let placeholder, after == placeholder {
        // XCTest renders a cleared field through its placeholder. A transition
        // from another readable value proves clear; an unchanged literal value
        // equal to the placeholder is intentionally inconclusive.
        return before != nil && before != placeholder ? .exact : .unreadable
      }
      return .mismatch
    }
    return after == expected ? .exact : .mismatch
  }
}
