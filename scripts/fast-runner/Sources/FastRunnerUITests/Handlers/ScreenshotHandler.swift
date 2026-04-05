import Foundation
import FlyingFox
import XCTest

struct ScreenshotHandler: HTTPHandler {
    @MainActor
    func handleRequest(_ request: HTTPRequest) async throws -> HTTPResponse {
        let screenshot = XCUIScreen.main.screenshot()
        let pngData = screenshot.pngRepresentation

        return HTTPResponse(
            statusCode: .ok,
            headers: [.contentType: "image/png"],
            body: pngData
        )
    }
}
