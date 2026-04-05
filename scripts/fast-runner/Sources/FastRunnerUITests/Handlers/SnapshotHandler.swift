import Foundation
import FlyingFox
import XCTest

struct SnapshotHandler: HTTPHandler {
    @MainActor
    func handleRequest(_ request: HTTPRequest) async throws -> HTTPResponse {
        let app = XCUIApplication()

        // Attempt snapshot — may throw kAXErrorIllegalArgument on large RN trees
        let snapshotDict: [String: Any]
        do {
            let snapshot = try app.snapshot()
            snapshotDict = snapshot.dictionaryRepresentation
        } catch {
            // Fallback: return error with suggestion
            let errorResponse = """
            {"ok":false,"error":"snapshot failed: \(error.localizedDescription)","hint":"Large React Native tree. Try filtering by element."}
            """
            return HTTPResponse(statusCode: .ok, body: Data(errorResponse.utf8))
        }

        // Convert to JSON
        guard let jsonData = try? JSONSerialization.data(withJSONObject: snapshotDict) else {
            let errorResponse = """
            {"ok":false,"error":"snapshot serialization failed"}
            """
            return HTTPResponse(statusCode: .ok, body: Data(errorResponse.utf8))
        }

        // Wrap in response envelope
        let envelope = "{\"ok\":true,\"tree\":".data(using: .utf8)! + jsonData + "}".data(using: .utf8)!
        return HTTPResponse(statusCode: .ok, body: envelope)
    }
}
