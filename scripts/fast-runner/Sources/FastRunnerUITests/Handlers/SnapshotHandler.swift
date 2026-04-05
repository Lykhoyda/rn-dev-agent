import Foundation
import FlyingFox
import XCTest

struct SnapshotRequest: Decodable {
    let bundleId: String?
}

struct SnapshotHandler: HTTPHandler {
    @MainActor
    func handleRequest(_ request: HTTPRequest) async throws -> HTTPResponse {
        let bundleId: String
        if let body = try? JSONDecoder().decode(SnapshotRequest.self, from: try await request.bodyData),
           let id = body.bundleId, !id.isEmpty {
            bundleId = id
        } else {
            bundleId = ProcessInfo.processInfo.environment["TARGET_BUNDLE_ID"] ?? ""
        }

        let app: XCUIApplication
        if bundleId.isEmpty {
            app = XCUIApplication()
        } else {
            app = XCUIApplication(bundleIdentifier: bundleId)
        }

        let snapshotDict: Any
        do {
            let snapshot = try app.snapshot()
            snapshotDict = snapshot.dictionaryRepresentation as Any
        } catch {
            let errorDict: [String: Any] = [
                "ok": false,
                "error": "snapshot failed: \(error.localizedDescription)",
                "hint": "Large React Native tree. Try filtering by element."
            ]
            let errorData = try! JSONSerialization.data(withJSONObject: errorDict)
            return HTTPResponse(statusCode: .ok, body: errorData)
        }

        guard let jsonData = try? JSONSerialization.data(withJSONObject: snapshotDict) else {
            let errorData = try! JSONSerialization.data(withJSONObject: ["ok": false, "error": "snapshot serialization failed"])
            return HTTPResponse(statusCode: .ok, body: errorData)
        }

        let envelope = "{\"ok\":true,\"tree\":".data(using: .utf8)! + jsonData + "}".data(using: .utf8)!
        return HTTPResponse(statusCode: .ok, body: envelope)
    }
}
