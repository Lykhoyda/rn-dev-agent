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
    read: (T) -> Bool?
  ) -> TargetCheck {
    guard now() < deadline, let target = resolve(), now() < deadline,
          let sameFrame = matchesFrame(target), now() <= deadline else { return .unavailable }
    if !sameFrame { return .moved }
    let result = read(target)
    guard now() <= deadline, let result else { return .unavailable }
    return .hittable(result)
  }

  enum Decision: Equatable {
    case proceed
    case occluded
    case moved
  }

  // nil means the live target could not be resolved or read in budget: dispatch as before.
  static func decide(liveHittable: Bool?, keyboardContainsPoint: Bool, targetMoved: Bool = false) -> Decision {
    if targetMoved { return .moved }
    return keyboardContainsPoint || liveHittable == false ? .occluded : .proceed
  }
}
