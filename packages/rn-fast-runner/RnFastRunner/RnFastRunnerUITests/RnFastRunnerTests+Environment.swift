import Foundation

// MARK: - Environment

enum RunnerEnv {
  static func resolvePort() -> UInt16 {
    if let env = ProcessInfo.processInfo.environment["RN_FAST_RUNNER_PORT"], let port = UInt16(env) {
      return port
    }
    for arg in CommandLine.arguments {
      if arg.hasPrefix("RN_FAST_RUNNER_PORT=") {
        let value = arg.replacingOccurrences(of: "RN_FAST_RUNNER_PORT=", with: "")
        if let port = UInt16(value) { return port }
      }
    }
    return 0
  }

  static func pluginVersion() -> String? {
    if let env = ProcessInfo.processInfo.environment["RN_PLUGIN_VERSION"], !env.isEmpty {
      return env
    }
    for arg in CommandLine.arguments where arg.hasPrefix("RN_PLUGIN_VERSION=") {
      let value = String(arg.dropFirst("RN_PLUGIN_VERSION=".count))
      if !value.isEmpty { return value }
    }
    return nil
  }

  static func isTruthy(_ name: String) -> Bool {
    guard let raw = ProcessInfo.processInfo.environment[name] else {
      return false
    }
    switch raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
    case "1", "true", "yes", "on":
      return true
    default:
      return false
    }
  }
}
