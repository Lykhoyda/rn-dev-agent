import CoreGraphics
import Foundation

// GH #581: pure exact text-input resolution/classification (KeyboardGuard
// pattern — XCUI-free so the unit suite covers it directly).
enum TextInputTarget {
  static let inputTypeNames: Set<String> = [
    "TextField", "SecureTextField", "SearchField", "TextView",
  ]

  struct CandidateAttributes {
    let type: String
    let identifier: String?
    let label: String?
    let frame: CGRect
  }

  enum Resolution: Equatable {
    case unique(Int)
    case ambiguous
    case absent
  }

  static func isInputTypeName(_ type: String?) -> Bool {
    guard let type else { return false }
    return inputTypeNames.contains(type)
  }

  static func framesMatch(_ a: CGRect, _ b: CGRect, tolerance: CGFloat = 3) -> Bool {
    abs(a.midX - b.midX) <= tolerance && abs(a.midY - b.midY) <= tolerance
      && abs(a.width - b.width) <= tolerance && abs(a.height - b.height) <= tolerance
  }

  // Duplicate identifiers are ambiguous across ALL candidates; identifier-less
  // descriptors bind same-generation only, by unique label or frame-equality.
  static func resolve(
    candidates: [CandidateAttributes],
    descriptorType: String,
    descriptorIdentifier: String?,
    descriptorLabel: String?,
    descriptorRect: CGRect,
    sameGeneration: Bool,
    requireIdentifierFrameMatch: Bool = false
  ) -> Resolution {
    if let id = descriptorIdentifier, !id.isEmpty {
      let byId = candidates.enumerated().filter { $0.element.identifier == id }
      if byId.count > 1 { return .ambiguous }
      guard let match = byId.first else { return .absent }
      guard match.element.type == descriptorType else { return .absent }
      if requireIdentifierFrameMatch && !framesMatch(match.element.frame, descriptorRect) {
        return .absent
      }
      return .unique(match.offset)
    }
    guard sameGeneration else { return .absent }
    let typed = candidates.enumerated().filter { $0.element.type == descriptorType }
    if typed.isEmpty { return .absent }
    if let label = descriptorLabel, !label.isEmpty {
      let byLabel = typed.filter { $0.element.label == label }
      if byLabel.count == 1 { return .unique(byLabel[0].offset) }
      return byLabel.count > 1 ? .ambiguous : .absent
    }
    let byFrame = typed.filter { framesMatch($0.element.frame, descriptorRect) }
    if byFrame.count == 1 { return .unique(byFrame[0].offset) }
    return byFrame.isEmpty ? .absent : .ambiguous
  }

  // verifyInput re-establishment against live attributes recorded at type time
  // (post-keyboard frames); duplicate identifiers stay ambiguous here too.
  static func resolveByRecordedAttributes(
    candidates: [CandidateAttributes],
    recorded: CandidateAttributes
  ) -> Resolution {
    if let id = recorded.identifier, !id.isEmpty {
      let byId = candidates.enumerated().filter { $0.element.identifier == id }
      if byId.count > 1 { return .ambiguous }
      guard let match = byId.first else { return .absent }
      return match.element.type == recorded.type ? .unique(match.offset) : .absent
    }
    let matches = candidates.enumerated().filter {
      $0.element.identifier == nil
        && $0.element.type == recorded.type
        && $0.element.label == recorded.label
        && framesMatch($0.element.frame, recorded.frame)
    }
    if matches.count == 1 { return .unique(matches[0].offset) }
    return matches.isEmpty ? .absent : .ambiguous
  }

  enum VerifyVerdict: String {
    case exact
    case mismatch
    case unreadable
    case secureMasked = "secure-masked"
    case targetLost = "target-lost"
    case ambiguous
  }

  // Secret-free read classification. An empty XCUI text field reports its
  // placeholder as `value`, so a placeholder-equal read cannot prove either
  // emptiness or a typed value — both cases classify `ambiguous`; secure
  // fields expose bullets, so any non-empty expectation is `secure-masked`.
  static func classifyValue(
    expected: String,
    rawValue: String?,
    placeholder: String?,
    isSecure: Bool
  ) -> VerifyVerdict {
    guard let rawValue else { return .unreadable }
    let placeholderEqual =
      placeholder != nil && !placeholder!.isEmpty && rawValue == placeholder
    if isSecure {
      if expected.isEmpty {
        if rawValue.isEmpty { return .exact }
        return placeholderEqual ? .ambiguous : .mismatch
      }
      return .secureMasked
    }
    if expected.isEmpty {
      if rawValue.isEmpty { return .exact }
      return placeholderEqual ? .ambiguous : .mismatch
    }
    if rawValue == expected {
      return placeholderEqual ? .ambiguous : .exact
    }
    return .mismatch
  }
}
