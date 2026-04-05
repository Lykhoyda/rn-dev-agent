import Foundation
import FlyingFox
import XCTest

struct DismissKeyboardHandler: HTTPHandler {
    @MainActor
    func handleRequest(_ request: HTTPRequest) async throws -> HTTPResponse {
        // Use screen size — works regardless of which app is foreground
        let screenSize = XCUIScreen.main.screenshot().image.size

        // Maestro's micro-swipe trick: swipe DOWN ~3% from center
        // iOS dismisses keyboard on downward scroll gesture
        let centerX = screenSize.width / 2
        let centerY = screenSize.height / 2
        let swipeEndY = centerY + (screenSize.height * 0.03)

        let eventRecord = EventRecord()
        eventRecord.addSwipeEvent(
            start: CGPoint(x: centerX, y: centerY),
            end: CGPoint(x: centerX, y: swipeEndY),
            duration: 0.05
        )
        try await RunnerDaemonProxy().synthesize(eventRecord: eventRecord)

        return HTTPResponse(statusCode: .ok, body: Data("{\"ok\":true}".utf8))
    }
}
