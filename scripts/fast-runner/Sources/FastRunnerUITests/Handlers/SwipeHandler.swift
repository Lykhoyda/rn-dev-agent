import Foundation
import FlyingFox

struct SwipeRequest: Decodable {
    let x1: Double
    let y1: Double
    let x2: Double
    let y2: Double
    let durationMs: Double?
}

struct SwipeHandler: HTTPHandler {
    @MainActor
    func handleRequest(_ request: HTTPRequest) async throws -> HTTPResponse {
        let body = try JSONDecoder().decode(SwipeRequest.self, from: request.body)
        let duration = (body.durationMs ?? 300) / 1000.0

        let eventRecord = EventRecord()
        eventRecord.addSwipeEvent(
            start: CGPoint(x: body.x1, y: body.y1),
            end: CGPoint(x: body.x2, y: body.y2),
            duration: duration
        )
        try await RunnerDaemonProxy().synthesize(eventRecord: eventRecord)

        let response = """
        {"ok":true}
        """
        return HTTPResponse(statusCode: .ok, body: Data(response.utf8))
    }
}
