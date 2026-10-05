// Occlusion is decided at dispatch by the live accessibility hit test of the one target.
enum DispatchGuard {
  static func hitTest<T>(
    deadline: Double,
    now: () -> Double,
    resolve: () -> T?,
    read: (T) -> Bool?
  ) -> Bool? {
    guard now() < deadline, let target = resolve(), now() < deadline else { return nil }
    let result = read(target)
    return now() <= deadline ? result : nil
  }

  enum Decision: Equatable {
    case proceed
    case occluded
  }

  // nil means the live target could not be resolved or read in budget: dispatch as before.
  static func decide(liveHittable: Bool?, keyboardContainsPoint: Bool) -> Decision {
    keyboardContainsPoint || liveHittable == false ? .occluded : .proceed
  }
}
