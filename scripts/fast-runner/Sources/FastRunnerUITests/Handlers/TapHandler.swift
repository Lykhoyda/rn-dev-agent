import Foundation
import FlyingFox

struct TapRequest: Decodable {
    let x: Double
    let y: Double
    let duration: Double?
}

struct TapHandler: HTTPHandler {
    @MainActor
    func handleRequest(_ request: HTTPRequest) async throws -> HTTPResponse {
        let body = try JSONDecoder().decode(TapRequest.self, from: try await request.bodyData)
        let start = CFAbsoluteTimeGetCurrent()

        let eventRecord = EventRecord()
        eventRecord.addPointerTouchEvent(
            at: CGPoint(x: body.x, y: body.y),
            touchUpAfter: body.duration
        )
        try await try RunnerDaemonProxy().synthesize(eventRecord: eventRecord)

        let elapsed = (CFAbsoluteTimeGetCurrent() - start) * 1000
        let response = """
        {"ok":true,"x":\(body.x),"y":\(body.y),"latency_ms":\(Int(elapsed))}
        """
        return HTTPResponse(statusCode: .ok, body: Data(response.utf8))
    }
}
