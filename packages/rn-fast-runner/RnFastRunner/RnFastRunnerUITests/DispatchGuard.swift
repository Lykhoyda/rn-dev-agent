import CoreGraphics
import Foundation

// Occlusion is decided at dispatch by the live accessibility hit test of the one target.
enum DispatchGuard {
  enum TargetCheck: Equatable {
    case unavailable
    case moved
    case hittable(Bool)

    var hittable: Bool? {
      if case .hittable(let value) = self { return value }
      return nil
    }
  }

  static func hitTest<T>(
    deadline: Double,
    now: () -> Double,
    resolve: () -> T?,
    matchesFrame: (T) -> Bool? = { _ in true },
    checkHittability: Bool = true,
    read: (T) -> Bool?
  ) -> TargetCheck {
    guard now() < deadline, let target = resolve(), now() < deadline,
          let sameFrame = matchesFrame(target), now() <= deadline else { return .unavailable }
    if !sameFrame { return .moved }
    if !checkHittability { return .unavailable }
    let result = read(target)
    guard now() <= deadline, let result else { return .unavailable }
    return .hittable(result)
  }

  enum Decision: Equatable {
    case proceed
    case occluded
    case moved
  }

  // Proven frame movement refuses even when hittability is unavailable.
  static func decide(liveHittable: Bool?, keyboardContainsPoint: Bool, targetMoved: Bool = false) -> Decision {
    if targetMoved { return .moved }
    return keyboardContainsPoint || liveHittable == false ? .occluded : .proceed
  }

  // Geometry only (x,y,w,h in points), so the refusal shows how far the target moved.
  static func movedMessage(retained: CGRect, live: CGRect, tolerance: CGFloat = 1.0) -> String {
    func components(_ values: [CGFloat]) -> String {
      values.map { String(format: "%.1f", Double($0)) }.joined(separator: ",")
    }
    let delta = [
      live.minX - retained.minX, live.minY - retained.minY,
      live.width - retained.width, live.height - retained.height,
    ]
    return "TARGET_MOVED_BEFORE_DISPATCH: target moved before dispatch "
      + "(retained \(components([retained.minX, retained.minY, retained.width, retained.height])); "
      + "live \(components([live.minX, live.minY, live.width, live.height])); "
      + "delta \(components(delta)); tolerance \(components([tolerance]))); "
      + "no tap or typing was performed. Refresh the snapshot and retry."
  }
}
