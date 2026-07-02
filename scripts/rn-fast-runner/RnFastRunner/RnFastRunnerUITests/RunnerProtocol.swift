// GH #383: /command wire-protocol version. Must stay in sync with
// scripts/cdp-bridge/src/runners/protocol.ts and RunnerProtocol.kt —
// enforced by cdp-bridge test/unit/gh-383-protocol-sync.test.js.
enum RunnerProtocol {
  static let version = 1
}
