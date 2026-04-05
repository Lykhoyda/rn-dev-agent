import FlyingFox

struct HealthHandler: HTTPHandler {
    func handleRequest(_ request: HTTPRequest) async throws -> HTTPResponse {
        let body = """
        {"ok":true,"runner":"rn-fast-runner","version":"0.1.0"}
        """
        return HTTPResponse(statusCode: .ok, body: Data(body.utf8))
    }
}
