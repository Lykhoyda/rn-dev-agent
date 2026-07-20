//
//  RnFastRunnerTests.swift
//  RnFastRunnerUITests
//
//  Created by Michał Pierzchała on 30/01/2026.
//

import XCTest
import Network
#if canImport(UIKit)
import UIKit
typealias RunnerImage = UIImage
#elseif canImport(AppKit)
import AppKit
typealias RunnerImage = NSImage
#endif

class RnFastRunnerTests: XCTestCase {
  enum RunnerErrorDomain {
    static let general = "RnFastRunner"
    static let exception = "RnFastRunner.NSException"
  }

  enum RunnerErrorCode {
    static let noResponseFromMainThread = 1
    static let commandReturnedNoResponse = 2
    static let mainThreadExecutionTimedOut = 3
    static let objcException = 1
  }

  static let springboardBundleId = "com.apple.springboard"
  var listener: NWListener?
  let commandJournal = CommandJournal()
  var doneExpectation: XCTestExpectation?
  let app = XCUIApplication()
  lazy var springboard = XCUIApplication(bundleIdentifier: Self.springboardBundleId)
  var currentApp: XCUIApplication?
  var currentBundleId: String?
  private let wedgeLock = NSLock()
  private var runnerWedged = false
#if RN_FAST_RUNNER_TEST_FAULTS
  var testFaultConsumed = false
#endif
  let maxRequestBytes = 2 * 1024 * 1024
  let maxSnapshotElements = 600
  let fastSnapshotLimit = 300
  let mainThreadExecutionTimeout: TimeInterval = 30
  let appExistenceTimeout: TimeInterval = 30
  let retryCooldown: TimeInterval = 0.2
  let postSnapshotInteractionDelay: TimeInterval = 0.2
  let firstInteractionAfterActivateDelay: TimeInterval = 0.25
  let scrollInteractionIdleTimeoutDefault: TimeInterval = 1.0
  var needsPostSnapshotInteractionDelay = false
  var currentSnapshotGeneration = 0
  var needsFirstInteractionDelay = false
  let interactiveTypes: Set<XCUIElement.ElementType> = [
    .button,
    .cell,
    .checkBox,
    .collectionView,
    .link,
    .menuItem,
    .picker,
    .searchField,
    .segmentedControl,
    .slider,
    .stepper,
    .switch,
    .tabBar,
    .textField,
    .secureTextField,
    .textView
  ]
  // Keep blocker actions narrow to avoid false positives from generic hittable containers.
  let actionableTypes: Set<XCUIElement.ElementType> = [
    .button,
    .cell,
    .link,
    .menuItem,
    .checkBox,
    .switch
  ]

  func markRunnerWedged() {
    wedgeLock.lock()
    runnerWedged = true
    wedgeLock.unlock()
  }

  func isRunnerWedged() -> Bool {
    wedgeLock.lock()
    defer { wedgeLock.unlock() }
    return runnerWedged
  }

  // MARK: - XCTest Entry

  override func setUp() {
    continueAfterFailure = true
  }

  @MainActor
  func testCommand() throws {
    doneExpectation = expectation(description: "rn-fast-runner command handled")
    app.launch()
    currentApp = app
    let queue = DispatchQueue(label: "rn-fast-runner.runner")
    let desiredPort = RunnerEnv.resolvePort()
    NSLog("RN_FAST_RUNNER_DESIRED_PORT=%d", desiredPort)
    let quiescence = QuiescenceStatus.current()
    if quiescence == .active {
      let variant = RNQuiescenceGetProbeResult() == .preEvent ? "preEvent" : "classic"
      NSLog("%@=%@", quiescence.startupMarker, variant)
    } else {
      NSLog("%@", quiescence.startupMarker)
    }
    listener = try makeRunnerListener(desiredPort: desiredPort)
    listener?.stateUpdateHandler = { [weak self] state in
      switch state {
      case .ready:
        NSLog("RN_FAST_RUNNER_LISTENER_READY")
        if let listenerPort = self?.listener?.port {
          NSLog("RN_FAST_RUNNER_PORT=%d", listenerPort.rawValue)
        } else {
          NSLog("RN_FAST_RUNNER_PORT_NOT_SET")
        }
      case .failed(let error):
        NSLog("RN_FAST_RUNNER_LISTENER_FAILED=%@", String(describing: error))
        self?.doneExpectation?.fulfill()
      default:
        break
      }
    }
    listener?.newConnectionHandler = { [weak self] conn in
      conn.start(queue: queue)
      self?.handle(connection: conn)
    }
    listener?.start(queue: queue)

    guard let expectation = doneExpectation else {
      XCTFail("runner expectation was not initialized")
      return
    }
    NSLog("RN_FAST_RUNNER_WAITING")
    let result = XCTWaiter.wait(for: [expectation], timeout: 24 * 60 * 60)
    NSLog("RN_FAST_RUNNER_WAIT_RESULT=%@", String(describing: result))
    if result != .completed {
      XCTFail("runner wait ended with \(result)")
    }
  }

  private func makeRunnerListener(desiredPort: UInt16) throws -> NWListener {
    if desiredPort > 0, let port = NWEndpoint.Port(rawValue: desiredPort) {
      #if os(macOS)
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: port)
        return try NWListener(using: parameters)
      #else
        return try NWListener(using: .tcp, on: port)
      #endif
    }
    return try NWListener(using: .tcp)
  }
}
