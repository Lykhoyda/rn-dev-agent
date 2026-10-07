import CoreGraphics
import XCTest

// GH #395: `hittable` means "enabled and its center is on-screen" (plausibly
// tappable), not "verified front-most". Front-most is unrepresentable from
// XCUIElementSnapshot data: RN modals get their own UIWindow (content under
// them is absent from the tree entirely) and same-window full-screen containers
// carry no opacity signal, so the old later-node occlusion loop only ever
// matched transparent wrappers and marked every node non-hittable.
// Viewport bounds are half-open [min, max): a center tap on the max edge lands
// outside the screen, and the explicit check keeps the policy Xcode-independent.
func computeSnapshotHittable(enabled: Bool, frame: CGRect, viewport: CGRect) -> Bool {
  guard enabled else { return false }
  if frame.isNull || frame.isEmpty { return false }
  let center = CGPoint(x: frame.midX, y: frame.midY)
  return center.x >= viewport.minX && center.x < viewport.maxX
    && center.y >= viewport.minY && center.y < viewport.maxY
}

// Snapshot inclusion is content/type-based, independent of the tappability hint.
func shouldIncludeSnapshotNode(
  type: XCUIElement.ElementType,
  hasContent: Bool,
  isScrollableContainer: Bool,
  isInteractiveType: Bool,
  visible: Bool,
  compact: Bool,
  interactiveOnly: Bool
) -> Bool {
  if interactiveOnly {
    if isScrollableContainer { return true }
    #if os(macOS)
      if !visible && type != .application { return false }
    #endif
    if isInteractiveType { return true }
    // The window frame anchors visible-screen geometry, so it is kept even without content.
    if type == .window { return true }
    return hasContent
  }
  if compact { return hasContent }
  return true
}

struct SnapshotDedupeKey: Hashable {
  let type: XCUIElement.ElementType.RawValue
  let label: String
  let identifier: String
  let value: String?
  let x: CGFloat
  let y: CGFloat
  // Size keeps nested same-origin containers apart, so neither loses its clip.
  let width: CGFloat
  let height: CGFloat
}

func snapshotDedupeKey(
  type: XCUIElement.ElementType,
  label: String,
  identifier: String,
  value: String?,
  frame: CGRect
) -> SnapshotDedupeKey {
  SnapshotDedupeKey(
    type: type.rawValue,
    label: label,
    identifier: identifier,
    value: value,
    x: frame.origin.x,
    y: frame.origin.y,
    width: frame.size.width,
    height: frame.size.height
  )
}
