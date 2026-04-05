import Foundation
import FlyingFox
import XCTest

struct DismissKeyboardHandler: HTTPHandler {
    @MainActor
    func handleRequest(_ request: HTTPRequest) async throws -> HTTPResponse {
        // Maestro's micro-swipe trick: 3% vertical swipe, 50ms duration
        // Triggers iOS keyboard interactive dismissal
        let app = XCUIApplication()
        let frame = app.frame
        let centerX = frame.midX
        let centerY = frame.midY
        let swipeEndY = centerY - (frame.height * 0.03)

        let eventRecord = EventRecord()
        eventRecord.addSwipeEvent(
            start: CGPoint(x: centerX, y: centerY),
            end: CGPoint(x: centerX, y: swipeEndY),
            duration: 0.05
        )
        try await RunnerDaemonProxy().synthesize(eventRecord: eventRecord)

        let response = """
        {"ok":true}
        """
        return HTTPResponse(statusCode: .ok, body: Data(response.utf8))
    }
}
