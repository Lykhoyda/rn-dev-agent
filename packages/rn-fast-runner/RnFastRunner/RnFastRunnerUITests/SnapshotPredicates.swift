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

// GH #395: snapshot filtering deliberately ignores `hittable`. Under the old
// always-false computation these rules were de-facto content/type-based;
// keeping them that way pins snapshot sizes while `hittable` gains its new
// meaning. The signature having no hittable parameter is the contract.
func shouldIncludeSnapshotNode(
  type: XCUIElement.ElementType,
  hasContent: Bool,
  childCount: Int,
  isScrollableContainer: Bool,
  isInteractiveType: Bool,
  visible: Bool,
  compact: Bool,
  interactiveOnly: Bool
) -> Bool {
  if compact && type == .other && !hasContent && childCount <= 1 {
    return false
  }
  if interactiveOnly {
    if isScrollableContainer { return true }
    #if os(macOS)
      if !visible && type != .application { return false }
    #endif
    if isInteractiveType { return true }
    return hasContent
  }
  if compact { return hasContent }
  return true
}
