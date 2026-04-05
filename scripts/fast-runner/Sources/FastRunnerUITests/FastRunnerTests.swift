import XCTest
import FlyingFox

final class FastRunnerTests: XCTestCase {

    override func setUp() {
        continueAfterFailure = true
    }

    @MainActor
    func testRunServer() async throws {
        let port = resolvePort()
        let server = HTTPServer(address: .loopback(port: port))

        // Routes
        await server.appendRoute("GET /health", to: HealthHandler())
        await server.appendRoute("POST /tap", to: TapHandler())
        await server.appendRoute("POST /swipe", to: SwipeHandler())
        await server.appendRoute("POST /type", to: TypeHandler())
        await server.appendRoute("POST /snapshot", to: SnapshotHandler())
        await server.appendRoute("POST /screenshot", to: ScreenshotHandler())
        await server.appendRoute("POST /dismissKeyboard", to: DismissKeyboardHandler())

        // Signal ready (port 0 not supported — use fixed port)
        print("FASTXCT_READY {\"port\":\(port)}")
        fflush(stdout)

        try await server.start()
    }

    private func resolvePort() -> UInt16 {
        if let envPort = ProcessInfo.processInfo.environment["FAST_RUNNER_PORT"],
           let p = UInt16(envPort) {
            return p
        }
        return 22088 // Default — one above Maestro's 22087
    }
}
