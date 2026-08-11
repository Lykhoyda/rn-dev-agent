//
//  SnapshotForegroundRegressionTest.swift
//  RnFastRunnerUITests
//
//  Pins B155: when the runner's UI is foreground (the default state when
//  XCTest starts), a snapshot of a different app's bundleId must still
//  return that app's UI tree — because the snapshot dispatcher activates
//  the target before reading.
//
//  This is the regression that motivated the entire rn-device project.
//

import XCTest

final class SnapshotForegroundRegressionTest: RnFastRunnerTests {
  private static let testAppBundleId = "com.rndevagent.testapp"
  private static let runnerSplashText = "rn-dev-agent fast runner"
  private static let expectedTestAppMarkers: [String] = [
    "home-welcome",
    "home-search-btn",
    "tab-home",
    "tab-tasks"
  ]

  override func setUp() {
    super.setUp()
    continueAfterFailure = true
  }

  override func testCommand() throws {
    // Suppress the inherited long-running listener test. The regression
    // test below uses the dispatcher directly without spinning up a server.
  }

  @MainActor
  func testForegroundSnapshotReturnsTestAppTree() throws {
    // Step 1: Bring the runner foreground (this is the B155 trigger condition).
    app.launch()
    currentApp = app
    currentBundleId = nil
    XCTAssertEqual(
      app.state,
      .runningForeground,
      "runner app should be foreground after launch"
    )

    // Sanity-check that the runner's splash UI is actually visible — if this
    // fails the regression test is meaningless because we cannot prove the
    // dispatcher had to activate a different target.
    let runnerSplash = app.staticTexts[Self.runnerSplashText]
    XCTAssertTrue(
      runnerSplash.waitForExistence(timeout: 5),
      "runner splash UI (\"\(Self.runnerSplashText)\") should be visible before the snapshot call"
    )

    // Step 2: Verify the test-app is installed on this simulator. The test
    // depends on com.rndevagent.testapp being pre-installed — without it the
    // dispatcher will time out waiting for app existence.
    let testApp = XCUIApplication(bundleIdentifier: Self.testAppBundleId)
    testApp.activate()
    XCTAssertTrue(
      testApp.waitForExistence(timeout: 10),
      "test-app \(Self.testAppBundleId) must be installed and launchable for this regression to be meaningful"
    )
    // Put runner foreground AGAIN so the dispatcher starts from the broken state.
    app.activate()
    XCTAssertTrue(
      app.waitForExistence(timeout: 5),
      "runner must be foreground before the snapshot dispatch (B155 setup)"
    )
    currentApp = app
    currentBundleId = nil

    // Step 3: Dispatch a snapshot command targeting the test-app's bundleId.
    // The dispatcher's pre-snapshot activation logic must switch focus to
    // the test-app before reading the accessibility tree.
    let command = Command(
      command: .snapshot,
      commandId: nil,
      appBundleId: Self.testAppBundleId,
      text: nil,
      delayMs: nil,
      clearFirst: nil,
      action: nil,
      x: nil,
      y: nil,
      button: nil,
      remoteButton: nil,
      count: nil,
      intervalMs: nil,
      doubleTap: nil,
      pauseMs: nil,
      pattern: nil,
      x2: nil,
      y2: nil,
      durationMs: nil,
      direction: nil,
      orientation: nil,
      scale: nil,
      interactiveOnly: nil,
      compact: true,
      depth: nil,
      scope: nil,
      raw: nil,
      fullscreen: nil
    )

    let response = try execute(command: command)

    // Step 4: Assert the response is successful and contains test-app markers.
    XCTAssertTrue(
      response.ok,
      "snapshot dispatch should succeed, got error=\(String(describing: response.error?.message))"
    )
    guard let nodes = response.data?.nodes, !nodes.isEmpty else {
      XCTFail("snapshot response had no nodes; data=\(String(describing: response.data))")
      return
    }

    let nodeBlob: String = nodes.map { node in
      [
        node.identifier ?? "",
        node.label ?? "",
        node.value ?? ""
      ].joined(separator: "|")
    }.joined(separator: "\n")

    // Step 5: The response must NOT contain the runner's splash text — if it
    // does, the dispatcher read the runner's UI instead of the test-app's
    // (the original B155 bug).
    XCTAssertFalse(
      nodeBlob.contains(Self.runnerSplashText),
      "B155 regression: snapshot returned the runner's UI (\"\(Self.runnerSplashText)\") instead of the test-app's tree.\nnodes:\n\(nodeBlob.prefix(2000))"
    )

    // Step 6: The response MUST contain at least one test-app marker — proves
    // the dispatcher activated and read the correct target.
    let foundMarkers = Self.expectedTestAppMarkers.filter { nodeBlob.contains($0) }
    XCTAssertFalse(
      foundMarkers.isEmpty,
      """
      B155 regression: snapshot did not return any test-app markers \
      (\(Self.expectedTestAppMarkers.joined(separator: ", "))). \
      The dispatcher likely failed to activate \(Self.testAppBundleId). \
      Got \(nodes.count) nodes; first 2000 chars:
      \(nodeBlob.prefix(2000))
      """
    )
    NSLog(
      "B155_REGRESSION_OK markers_found=%@ node_count=%d",
      foundMarkers.joined(separator: ","),
      nodes.count
    )
  }
}
