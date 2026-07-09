import XCTest
import Network

extension RnFastRunnerTests {
  // MARK: - Connection Lifecycle

  func handle(connection: NWConnection) {
    receiveRequest(connection: connection, buffer: Data())
  }

  // MARK: - Request Parsing

  private func receiveRequest(connection: NWConnection, buffer: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 1024 * 1024) { [weak self] data, _, _, _ in
      guard let self = self, let data = data else {
        connection.cancel()
        return
      }
      if buffer.count + data.count > self.maxRequestBytes {
        let response = self.jsonResponse(
          status: 413,
          response: Response(ok: false, error: ErrorPayload(message: "request too large"))
        )
        self.sendResponse(response, over: connection) { [weak self] in
          self?.finish()
        }
        return
      }
      let combined = buffer + data
      // GET /health carries no body / Content-Length, so parseRequest (which
      // requires one) would loop forever and the liveness probe would always
      // time out to "stale". Answer it directly with 200 {ok:true}.
      if self.isHealthRequest(combined) {
        let response = self.jsonResponse(
          status: 200,
          response: Response(
            ok: true,
            protocolVersion: RunnerProtocol.version,
            runnerVersion: RunnerEnv.pluginVersion(),
            capabilities: QuiescenceStatus.current().capabilities + ["SCREEN_STATIC"],
            commands: CommandType.allCases.map(\.rawValue)
          )
        )
        self.sendResponse(response, over: connection)
        return
      }
      switch self.parseRequest(data: combined) {
      case .body(let body):
        let result = self.handleRequestBody(body)
        self.sendResponse(result.data, over: connection) { [weak self] in
          if result.shouldFinish {
            self?.finish()
          }
        }
      case .invalid:
        let response = self.jsonResponse(
          status: 400,
          response: Response(ok: false, error: ErrorPayload(message: "invalid Content-Length"))
        )
        self.sendResponse(response, over: connection)
      case .incomplete:
        self.receiveRequest(connection: connection, buffer: combined)
      }
    }
  }

  private func sendResponse(
    _ response: Data,
    over connection: NWConnection,
    afterSend: @escaping () -> Void = {}
  ) {
    connection.send(content: response, isComplete: true, completion: .contentProcessed { error in
      if let error {
        NSLog("RN_FAST_RUNNER_SEND_FAILED=%@", String(describing: error))
      }
      connection.cancel()
      afterSend()
    })
  }

  private func isHealthRequest(_ data: Data) -> Bool {
    guard data.range(of: Data("\r\n\r\n".utf8)) != nil else { return false }
    let head = String(decoding: data.prefix(200), as: UTF8.self)
    let firstLine = head.split(separator: "\r\n", maxSplits: 1).first.map(String.init) ?? head
    return firstLine.hasPrefix("GET /health")
  }

  enum ParseOutcome {
    case incomplete
    case invalid
    case body(Data)
  }

  private func parseRequest(data: Data) -> ParseOutcome {
    guard let headerEnd = data.range(of: Data("\r\n\r\n".utf8)) else {
      return .incomplete
    }
    let headerData = data.subdata(in: 0..<headerEnd.lowerBound)
    let bodyStart = headerEnd.upperBound
    let headers = String(decoding: headerData, as: UTF8.self)
    // The header section is complete here, so a missing/negative/oversized
    // Content-Length can never become valid — answer 400 instead of buffering
    // forever (and never do range arithmetic on an unchecked length: negative
    // made an invalid subdata range, huge trapped on integer overflow).
    guard let contentLength = extractContentLength(headers: headers),
          contentLength >= 0, contentLength <= maxRequestBytes
    else {
      return .invalid
    }
    if data.count < bodyStart + contentLength {
      return .incomplete
    }
    return .body(data.subdata(in: bodyStart..<(bodyStart + contentLength)))
  }

  private func extractContentLength(headers: String) -> Int? {
    for line in headers.split(separator: "\r\n") {
      let parts = line.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
      if parts.count == 2 && parts[0].lowercased() == "content-length" {
        return Int(parts[1])
      }
    }
    return nil
  }

  private func handleRequestBody(_ body: Data) -> (data: Data, shouldFinish: Bool) {
    guard let json = String(data: body, encoding: .utf8) else {
      return (
        jsonResponse(status: 400, response: Response(ok: false, error: ErrorPayload(message: "invalid json"))),
        false
      )
    }
    guard let data = json.data(using: .utf8) else {
      return (
        jsonResponse(status: 400, response: Response(ok: false, error: ErrorPayload(message: "invalid json"))),
        false
      )
    }

    struct CommandTypeProbe: Decodable { let command: String }
    if let probe = try? JSONDecoder().decode(CommandTypeProbe.self, from: data),
       CommandType(rawValue: probe.command) == nil {
      // GH #418: a verb this artifact doesn't know is a typed refusal, not a
      // dataCorrupted decode error (B235). Mirrors the Android runner's shape.
      return (
        jsonResponse(status: 200, response: Response(
          ok: false,
          error: ErrorPayload(
            code: "UNSUPPORTED_COMMAND",
            message: "Unsupported iOS runner command: \(probe.command) — the runner artifact predates it; re-open the device session (device_snapshot action=open) to rebuild."
          )
        )),
        false
      )
    }

    do {
      let command = try JSONDecoder().decode(Command.self, from: data)
      let response = try execute(command: command)
      return (jsonResponse(status: 200, response: response), command.command == .shutdown)
    } catch {
      return (
        jsonResponse(status: 500, response: Response(ok: false, error: ErrorPayload(message: "\(error)"))),
        false
      )
    }
  }

  // MARK: - Response Encoding

  private func jsonResponse(status: Int, response: Response) -> Data {
    let encoder = JSONEncoder()
    let body = (try? encoder.encode(response)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    return httpResponse(status: status, body: body)
  }

  private func httpResponse(status: Int, body: String) -> Data {
    let headers = [
      "HTTP/1.1 \(status) OK",
      "Content-Type: application/json",
      "Content-Length: \(body.utf8.count)",
      "Connection: close",
      "",
      body
    ].joined(separator: "\r\n")
    return Data(headers.utf8)
  }

  private func finish() {
    listener?.cancel()
    listener = nil
    doneExpectation?.fulfill()
  }
}
