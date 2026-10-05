// Occlusion is decided at dispatch by the live accessibility hit test of the one target.
enum DispatchGuard {
  enum Decision: Equatable {
    case proceed
    case occluded
  }

  // nil means the live target could not be resolved or read in budget: dispatch as before.
  static func decide(liveHittable: Bool?, keyboardContainsPoint: Bool) -> Decision {
    keyboardContainsPoint || liveHittable == false ? .occluded : .proceed
  }
}
