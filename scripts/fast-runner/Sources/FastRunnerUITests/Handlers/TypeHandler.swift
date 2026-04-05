import Foundation
import FlyingFox

struct TypeRequest: Decodable {
    let text: String
}

struct TypeHandler: HTTPHandler {
    @MainActor
    func handleRequest(_ request: HTTPRequest) async throws -> HTTPResponse {
        let body = try JSONDecoder().decode(TypeRequest.self, from: try await request.bodyData)
        let text = body.text

        guard !text.isEmpty else {
            return HTTPResponse(statusCode: .badRequest, body: Data("{\"ok\":false,\"error\":\"empty text\"}".utf8))
        }

        let proxy = try RunnerDaemonProxy()

        // First character slow (autocorrect safety) — Maestro's proven pattern
        let firstChar = String(text.prefix(1))
        let firstRecord = EventRecord()
        var firstPath = PointerEventPath.pathForTextInput()
        firstPath.type(text: firstChar, typingSpeed: 1)
        firstRecord.add(firstPath)
        try await proxy.synthesize(eventRecord: firstRecord)

        // Remaining text fast
        if text.count > 1 {
            try await Task.sleep(nanoseconds: 500_000_000) // 500ms stabilization
            let remaining = String(text.dropFirst())
            let fastRecord = EventRecord()
            var fastPath = PointerEventPath.pathForTextInput()
            fastPath.type(text: remaining, typingSpeed: 30)
            fastRecord.add(fastPath)
            try await proxy.synthesize(eventRecord: fastRecord)
        }

        let response = """
        {"ok":true,"typed":\(text.count)}
        """
        return HTTPResponse(statusCode: .ok, body: Data(response.utf8))
    }
}
