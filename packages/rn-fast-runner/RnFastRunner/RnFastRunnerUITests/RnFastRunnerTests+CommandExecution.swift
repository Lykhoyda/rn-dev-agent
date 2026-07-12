import CryptoKit
import XCTest

extension RnFastRunnerTests {
  // MARK: - Main Thread Dispatch

  private func currentUptimeMs() -> Double {
    ProcessInfo.processInfo.systemUptime * 1000
  }

  private func measureGesture(_ action: () -> Void) -> (gestureStartUptimeMs: Double, gestureEndUptimeMs: Double) {
    let gestureStartUptimeMs = currentUptimeMs()
    action()
    return (gestureStartUptimeMs, currentUptimeMs())
  }

  private func unsupportedResponse(for outcome: RunnerInteractionOutcome) -> Response? {
    switch outcome {
    case .performed:
      return nil
    case .unsupported(let message):
      return Response(
        ok: false,
        error: ErrorPayload(code: "UNSUPPORTED_OPERATION", message: message)
      )
    }
  }

  func execute(command: Command) throws -> Response {
    if Thread.isMainThread {
      return try executeOnMainSafely(command: command)
    }
    var result: Result<Response, Error>?
    let semaphore = DispatchSemaphore(value: 0)
    DispatchQueue.main.async {
      do {
        result = .success(try self.executeOnMainSafely(command: command))
      } catch {
        result = .failure(error)
      }
      semaphore.signal()
    }
    let waitResult = semaphore.wait(timeout: .now() + mainThreadExecutionTimeout)
    if waitResult == .timedOut {
      // The main queue work may still be running; we stop waiting and report timeout.
      throw NSError(
        domain: RunnerErrorDomain.general,
        code: RunnerErrorCode.mainThreadExecutionTimedOut,
        userInfo: [NSLocalizedDescriptionKey: "main thread execution timed out"]
      )
    }
    switch result {
    case .success(let response):
      return response
    case .failure(let error):
      throw error
    case .none:
      throw NSError(
        domain: RunnerErrorDomain.general,
        code: RunnerErrorCode.noResponseFromMainThread,
        userInfo: [NSLocalizedDescriptionKey: "no response from main thread"]
      )
    }
  }

  // MARK: - Command Handling

  private func executeOnMainSafely(command: Command) throws -> Response {
    var hasRetried = false
    while true {
      var response: Response?
      var swiftError: Error?
      let exceptionMessage = RunnerObjCExceptionCatcher.catchException({
        do {
          response = try self.executeOnMain(command: command)
        } catch {
          swiftError = error
        }
      })

      if let exceptionMessage {
        currentApp = nil
        currentBundleId = nil
        if !hasRetried, shouldRetryException(command, message: exceptionMessage) {
          NSLog(
            "RN_FAST_RUNNER_RETRY command=%@ reason=objc_exception",
            command.command.rawValue
          )
          hasRetried = true
          sleepFor(retryCooldown)
          continue
        }
        throw NSError(
          domain: RunnerErrorDomain.exception,
          code: RunnerErrorCode.objcException,
          userInfo: [NSLocalizedDescriptionKey: exceptionMessage]
        )
      }
      if let swiftError {
        throw swiftError
      }
      guard let response else {
        throw NSError(
          domain: RunnerErrorDomain.general,
          code: RunnerErrorCode.commandReturnedNoResponse,
          userInfo: [NSLocalizedDescriptionKey: "command returned no response"]
        )
      }
      if !hasRetried, shouldRetryCommand(command), shouldRetryResponse(response) {
        NSLog(
          "RN_FAST_RUNNER_RETRY command=%@ reason=response_unavailable",
          command.command.rawValue
        )
        hasRetried = true
        currentApp = nil
        currentBundleId = nil
        sleepFor(retryCooldown)
        continue
      }
      return response
    }
  }

  private func executeOnMain(command: Command) throws -> Response {
    var activeApp = currentApp ?? app
    if !isRunnerLifecycleCommand(command.command) {
      let normalizedBundleId = command.appBundleId?
        .trimmingCharacters(in: .whitespacesAndNewlines)
      let requestedBundleId = (normalizedBundleId?.isEmpty == true) ? nil : normalizedBundleId
      if let bundleId = requestedBundleId {
        if currentBundleId != bundleId || currentApp == nil {
          _ = activateTarget(bundleId: bundleId, reason: "bundle_changed")
        }
      } else {
        // Do not reuse stale bundle targets when the caller does not explicitly request one.
        currentApp = nil
        currentBundleId = nil
      }

      activeApp = currentApp ?? app
      if let bundleId = requestedBundleId, targetNeedsActivation(activeApp) {
        activeApp = activateTarget(bundleId: bundleId, reason: "stale_target")
      } else if requestedBundleId == nil, targetNeedsActivation(activeApp) {
        app.activate()
        activeApp = app
      }

      if !activeApp.waitForExistence(timeout: appExistenceTimeout) {
        if let bundleId = requestedBundleId {
          activeApp = activateTarget(bundleId: bundleId, reason: "missing_after_wait")
          guard activeApp.waitForExistence(timeout: appExistenceTimeout) else {
            return Response(ok: false, error: ErrorPayload(message: "app '\(bundleId)' is not available"))
          }
        } else {
          return Response(ok: false, error: ErrorPayload(message: "runner app is not available"))
        }
      }

      if isInteractionCommand(command.command) {
        if let bundleId = requestedBundleId, activeApp.state != .runningForeground {
          activeApp = activateTarget(bundleId: bundleId, reason: "interaction_foreground_guard")
        } else if requestedBundleId == nil, activeApp.state != .runningForeground {
          app.activate()
          activeApp = app
        }
        if !activeApp.waitForExistence(timeout: 2) {
          if let bundleId = requestedBundleId {
            return Response(ok: false, error: ErrorPayload(message: "app '\(bundleId)' is not available"))
          }
          return Response(ok: false, error: ErrorPayload(message: "runner app is not available"))
        }
        applyInteractionStabilizationIfNeeded()
      }
    }

    switch command.command {
    case .shutdown:
      return Response(ok: true, data: DataPayload(message: "shutdown"))
    case .uptime:
      return Response(
        ok: true,
        data: DataPayload(currentUptimeMs: currentUptimeMs())
      )
    case .status:
      return Response(
        ok: false,
        error: ErrorPayload(code: "INVALID_ARGUMENT", message: "status is handled at the transport layer")
      )
    case .tap:
      if let text = command.text {
        if let element = findElement(app: activeApp, text: text) {
          var outcome = RunnerInteractionOutcome.performed
          let timing = measureGesture {
            withTemporaryScrollIdleTimeoutIfSupported(activeApp) {
              outcome = activateElement(app: activeApp, element: element, action: "tap by text")
            }
          }
          if let response = unsupportedResponse(for: outcome) {
            return response
          }
          return Response(
            ok: true,
            data: DataPayload(
              message: "tapped",
              gestureStartUptimeMs: timing.gestureStartUptimeMs,
              gestureEndUptimeMs: timing.gestureEndUptimeMs
            )
          )
        }
        return Response(ok: false, error: ErrorPayload(message: "element not found"))
      }
      if let x = command.x, let y = command.y {
        let touchFrame = resolvedTouchVisualizationFrame(app: activeApp, x: x, y: y)
        let keyboardGuardStartMs = currentUptimeMs()
        let keyboardGuardStatus = applyKeyboardGuard(app: activeApp, tapX: x, tapY: y, enabled: command.guardKeyboard != false)
        let keyboardGuardMs = currentUptimeMs() - keyboardGuardStartMs
        if keyboardGuardStatus == "dismiss_failed" {
          return Response(
            ok: false,
            error: ErrorPayload(code: "KEYBOARD_OCCLUDED", message: "KEYBOARD_OCCLUDED: tap (\(x), \(y)) is under the visible keyboard and this keyboard has no dismiss control, so auto-dismiss failed. Dismiss the keyboard first (device_fill/cdp_interact use the JS path; or tap a non-input area), then retry. keyboardGuard=dismiss_failed")
          )
        }
        var outcome = RunnerInteractionOutcome.performed
        let timing = measureGesture {
          withTemporaryScrollIdleTimeoutIfSupported(activeApp) {
            outcome = tapAt(app: activeApp, x: x, y: y)
          }
        }
        if let response = unsupportedResponse(for: outcome) {
          return response
        }
        return Response(
          ok: true,
          data: DataPayload(
            message: "tapped",
            gestureStartUptimeMs: timing.gestureStartUptimeMs,
            gestureEndUptimeMs: timing.gestureEndUptimeMs,
            x: touchFrame.x,
            y: touchFrame.y,
            referenceWidth: touchFrame.referenceWidth,
            referenceHeight: touchFrame.referenceHeight,
            keyboardGuard: keyboardGuardStatus,
            keyboardGuardMs: keyboardGuardMs
          )
        )
      }
      return Response(ok: false, error: ErrorPayload(message: "tap requires text or x/y"))
    case .mouseClick:
      guard let x = command.x, let y = command.y else {
        return Response(ok: false, error: ErrorPayload(message: "mouseClick requires x and y"))
      }
      let touchFrame = resolvedTouchVisualizationFrame(app: activeApp, x: x, y: y)
      do {
        var clickError: Error?
        let timing = measureGesture {
          do {
            try mouseClickAt(app: activeApp, x: x, y: y, button: command.button ?? "primary")
          } catch {
            clickError = error
          }
        }
        if let clickError {
          throw clickError
        }
        return Response(
          ok: true,
          data: DataPayload(
            message: "clicked",
            gestureStartUptimeMs: timing.gestureStartUptimeMs,
            gestureEndUptimeMs: timing.gestureEndUptimeMs,
            x: touchFrame.x,
            y: touchFrame.y,
            referenceWidth: touchFrame.referenceWidth,
            referenceHeight: touchFrame.referenceHeight
          )
        )
      } catch {
        return Response(ok: false, error: ErrorPayload(message: error.localizedDescription))
      }
    case .tapSeries:
      guard let x = command.x, let y = command.y else {
        return Response(ok: false, error: ErrorPayload(message: "tapSeries requires x and y"))
      }
      let count = max(Int(command.count ?? 1), 1)
      let intervalMs = max(command.intervalMs ?? 0, 0)
      let doubleTap = command.doubleTap ?? false
      let touchFrame = resolvedTouchVisualizationFrame(app: activeApp, x: x, y: y)
      if doubleTap {
        var outcome = RunnerInteractionOutcome.performed
        let timing = measureGesture {
          withTemporaryScrollIdleTimeoutIfSupported(activeApp) {
            runSeries(count: count, pauseMs: intervalMs) { _ in
              if case .performed = outcome {
                outcome = doubleTapAt(app: activeApp, x: x, y: y)
              }
            }
          }
        }
        if let response = unsupportedResponse(for: outcome) {
          return response
        }
        return Response(
          ok: true,
          data: DataPayload(
            message: "tap series",
            gestureStartUptimeMs: timing.gestureStartUptimeMs,
            gestureEndUptimeMs: timing.gestureEndUptimeMs,
            x: touchFrame.x,
            y: touchFrame.y,
            referenceWidth: touchFrame.referenceWidth,
            referenceHeight: touchFrame.referenceHeight
          )
        )
      }
      var outcome = RunnerInteractionOutcome.performed
      let timing = measureGesture {
        withTemporaryScrollIdleTimeoutIfSupported(activeApp) {
          runSeries(count: count, pauseMs: intervalMs) { _ in
            if case .performed = outcome {
              outcome = tapAt(app: activeApp, x: x, y: y)
            }
          }
        }
      }
      if let response = unsupportedResponse(for: outcome) {
        return response
      }
      return Response(
        ok: true,
        data: DataPayload(
          message: "tap series",
          gestureStartUptimeMs: timing.gestureStartUptimeMs,
          gestureEndUptimeMs: timing.gestureEndUptimeMs,
          x: touchFrame.x,
          y: touchFrame.y,
          referenceWidth: touchFrame.referenceWidth,
          referenceHeight: touchFrame.referenceHeight
        )
      )
    case .longPress:
      guard let x = command.x, let y = command.y else {
        return Response(ok: false, error: ErrorPayload(message: "longPress requires x and y"))
      }
      let duration = (command.durationMs ?? 800) / 1000.0
      let touchFrame = resolvedTouchVisualizationFrame(app: activeApp, x: x, y: y)
      let keyboardGuardStartMs = currentUptimeMs()
      let keyboardGuardStatus = applyKeyboardGuard(app: activeApp, tapX: x, tapY: y, enabled: command.guardKeyboard != false)
      let keyboardGuardMs = currentUptimeMs() - keyboardGuardStartMs
      if keyboardGuardStatus == "dismiss_failed" {
        return Response(
          ok: false,
          error: ErrorPayload(code: "KEYBOARD_OCCLUDED", message: "KEYBOARD_OCCLUDED: tap (\(x), \(y)) is under the visible keyboard and this keyboard has no dismiss control, so auto-dismiss failed. Dismiss the keyboard first (device_fill/cdp_interact use the JS path; or tap a non-input area), then retry. keyboardGuard=dismiss_failed")
        )
      }
      var outcome = RunnerInteractionOutcome.performed
      let timing = measureGesture {
        withTemporaryScrollIdleTimeoutIfSupported(activeApp) {
          outcome = longPressAt(app: activeApp, x: x, y: y, duration: duration)
        }
      }
      if let response = unsupportedResponse(for: outcome) {
        return response
      }
      return Response(
        ok: true,
        data: DataPayload(
          message: "long pressed",
          gestureStartUptimeMs: timing.gestureStartUptimeMs,
          gestureEndUptimeMs: timing.gestureEndUptimeMs,
          x: touchFrame.x,
          y: touchFrame.y,
          referenceWidth: touchFrame.referenceWidth,
          referenceHeight: touchFrame.referenceHeight,
          keyboardGuard: keyboardGuardStatus,
          keyboardGuardMs: keyboardGuardMs
        )
      )
    case .drag:
      guard let x = command.x, let y = command.y, let x2 = command.x2, let y2 = command.y2 else {
        return Response(ok: false, error: ErrorPayload(message: "drag requires x, y, x2, and y2"))
      }
      let holdDuration = min(max((command.durationMs ?? 60) / 1000.0, 0.016), 10.0)
      let dragFrame = resolvedDragVisualizationFrame(app: activeApp, x: x, y: y, x2: x2, y2: y2)
      var outcome = RunnerInteractionOutcome.performed
      let timing = measureGesture {
        withTemporaryScrollIdleTimeoutIfSupported(activeApp) {
          outcome = dragAt(app: activeApp, x: x, y: y, x2: x2, y2: y2, holdDuration: holdDuration)
        }
      }
      if let response = unsupportedResponse(for: outcome) {
        return response
      }
      return Response(
        ok: true,
        data: DataPayload(
          message: "dragged",
          gestureStartUptimeMs: timing.gestureStartUptimeMs,
          gestureEndUptimeMs: timing.gestureEndUptimeMs,
          x: dragFrame.x,
          y: dragFrame.y,
          x2: dragFrame.x2,
          y2: dragFrame.y2,
          referenceWidth: dragFrame.referenceWidth,
          referenceHeight: dragFrame.referenceHeight
        )
      )
    case .dragSeries:
      guard let x = command.x, let y = command.y, let x2 = command.x2, let y2 = command.y2 else {
        return Response(ok: false, error: ErrorPayload(message: "dragSeries requires x, y, x2, and y2"))
      }
      let count = max(Int(command.count ?? 1), 1)
      let pauseMs = max(command.pauseMs ?? 0, 0)
      let pattern = command.pattern ?? "one-way"
      if pattern != "one-way" && pattern != "ping-pong" {
        return Response(ok: false, error: ErrorPayload(message: "dragSeries pattern must be one-way or ping-pong"))
      }
      let holdDuration = min(max((command.durationMs ?? 60) / 1000.0, 0.016), 10.0)
      var outcome = RunnerInteractionOutcome.performed
      let timing = measureGesture {
        withTemporaryScrollIdleTimeoutIfSupported(activeApp) {
          runSeries(count: count, pauseMs: pauseMs) { idx in
            guard case .performed = outcome else {
              return
            }
            let reverse = pattern == "ping-pong" && (idx % 2 == 1)
            if reverse {
              outcome = dragAt(app: activeApp, x: x2, y: y2, x2: x, y2: y, holdDuration: holdDuration)
            } else {
              outcome = dragAt(app: activeApp, x: x, y: y, x2: x2, y2: y2, holdDuration: holdDuration)
            }
          }
        }
      }
      if let response = unsupportedResponse(for: outcome) {
        return response
      }
      return Response(
        ok: true,
        data: DataPayload(
          message: "drag series",
          gestureStartUptimeMs: timing.gestureStartUptimeMs,
          gestureEndUptimeMs: timing.gestureEndUptimeMs
        )
      )
    case .remotePress:
      guard let button = tvRemoteButton(from: command.remoteButton) else {
        return Response(ok: false, error: ErrorPayload(message: "remotePress requires remoteButton"))
      }
      let duration = (command.durationMs ?? 0) / 1000.0
      guard pressTvRemote(button, duration: duration) else {
        return Response(
          ok: false,
          error: ErrorPayload(code: "UNSUPPORTED_OPERATION", message: "remotePress is only supported on tvOS")
        )
      }
      return Response(ok: true, data: DataPayload(message: "remote pressed"))
    case .type:
      guard let text = command.text else {
        return Response(ok: false, error: ErrorPayload(message: "type requires text"))
      }
      let delaySeconds = Double(max(command.delayMs ?? 0, 0)) / 1000.0
      // GH #105 iOS-MVP follow-up: every step that touches XCTest's element
      // resolver (textInputAt / focusedTextInput walk `descendants(...).allElementsBoundByIndex`)
      // OR triggers `typeText()` must run under withTemporaryScrollIdleTimeoutIfSupported.
      // Without it, RN's never-quiescing main thread (Reanimated keeps the
      // loop active) causes XCTest's default waitForIdle to throw "main thread
      // execution timed out" — even though the underlying typing succeeded.
      var target: XCUIElement?
      withTemporaryScrollIdleTimeoutIfSupported(activeApp) {
        if let x = command.x, let y = command.y {
          target = textInputAt(app: activeApp, x: x, y: y) ?? focusedTextInput(app: activeApp)
        } else {
          target = focusedTextInput(app: activeApp)
        }
      }
      let resolvedTarget = target
      func typeIntoTarget(_ value: String) {
        if let focused = resolvedTarget {
          focused.typeText(value)
        } else {
          activeApp.typeText(value)
        }
      }
      // Story 10 (#391): never type into a keyboard that isn't up — iOS drops
      // keystrokes sent during keyboard appearance. Best-effort: a simulator
      // with a hardware keyboard attached may never present the software
      // keyboard, so a timeout proceeds instead of failing. The keyboard-guard
      // (#370) dismisses keyboards that occlude taps; this wait REQUIRES one —
      // the two intents stay separate.
      var keyboardWait: (appeared: Bool, waitedMs: Int) = (false, 0)
      withTemporaryScrollIdleTimeoutIfSupported(activeApp) {
        keyboardWait = TypingRecipe.waitForKeyboard(
          now: { ProcessInfo.processInfo.systemUptime },
          sleep: { Thread.sleep(forTimeInterval: $0) },
          keyboardVisible: { activeApp.keyboards.count > 0 }
        )
      }
      if command.clearFirst == true {
        guard let focused = resolvedTarget else {
          let message =
            (command.x != nil && command.y != nil)
            ? "no text input found at the provided coordinates to clear"
            : "no focused text input to clear"
          return Response(ok: false, error: ErrorPayload(message: message))
        }
        withTemporaryScrollIdleTimeoutIfSupported(activeApp) {
          clearTextInput(focused)
        }
      }
      var usedBurst = false
      withTemporaryScrollIdleTimeoutIfSupported(activeApp) {
        if delaySeconds > 0 && text.count > 1 {
          // Explicit per-char pacing (--delay-ms, the corrective-retype
          // contract) wins over the two-burst recipe.
          let chunks = Array(text)
          for (index, character) in chunks.enumerated() {
            typeIntoTarget(String(character))
            if index + 1 < chunks.count {
              Thread.sleep(forTimeInterval: delaySeconds)
            }
          }
        } else if let bursts = TypingRecipe.bursts(for: text) {
          // Story 10 (#391): two-burst send — first character alone, sit out
          // the post-appearance drop window, then stream the remainder.
          typeIntoTarget(bursts.first)
          Thread.sleep(forTimeInterval: TypingRecipe.interBurstDelay)
          typeIntoTarget(bursts.remainder)
          usedBurst = true
        } else {
          typeIntoTarget(text)
        }
      }
      return Response(
        ok: true,
        data: DataPayload(
          message: "typed",
          typingBurst: usedBurst,
          keyboardWaitMs: keyboardWait.waitedMs
        )
      )
    case .interactionFrame:
      let frame = resolvedTouchReferenceFrame(app: activeApp, appFrame: activeApp.frame)
      return Response(
        ok: true,
        data: DataPayload(
          x: frame.minX,
          y: frame.minY,
          referenceWidth: frame.width,
          referenceHeight: frame.height
        )
      )
    case .swipe:
      guard let direction = command.direction else {
        return Response(ok: false, error: ErrorPayload(message: "swipe requires direction"))
      }
      var executedFrame: DragVisualizationFrame?
      let timing = measureGesture {
        withTemporaryScrollIdleTimeoutIfSupported(activeApp) {
          executedFrame = swipe(
            app: activeApp,
            direction: direction
          )
        }
      }
      guard let dragFrame = executedFrame else {
        return Response(ok: false, error: ErrorPayload(message: "swipe is only supported on tvOS"))
      }
      return Response(
        ok: true,
        data: DataPayload(
          message: "swiped",
          gestureStartUptimeMs: timing.gestureStartUptimeMs,
          gestureEndUptimeMs: timing.gestureEndUptimeMs,
          x: dragFrame.x,
          y: dragFrame.y,
          x2: dragFrame.x2,
          y2: dragFrame.y2,
          referenceWidth: dragFrame.referenceWidth,
          referenceHeight: dragFrame.referenceHeight
        )
      )
    case .findText:
      guard let text = command.text else {
        return Response(ok: false, error: ErrorPayload(message: "findText requires text"))
      }
      let found = findElement(app: activeApp, text: text) != nil
      return Response(ok: true, data: DataPayload(found: found))
    case .readText:
      guard let x = command.x, let y = command.y else {
        return Response(ok: false, error: ErrorPayload(message: "readText requires x and y"))
      }
      guard let text = readTextAt(app: activeApp, x: x, y: y) else {
        return Response(ok: false, error: ErrorPayload(message: "readText did not resolve text"))
      }
      return Response(ok: true, data: DataPayload(text: text))
    case .snapshot:
      let options = SnapshotOptions(
        interactiveOnly: command.interactiveOnly ?? false,
        compact: command.compact ?? false,
        depth: command.depth,
        scope: command.scope,
        raw: command.raw ?? false
      )
      if options.raw {
        needsPostSnapshotInteractionDelay = true
        return Response(ok: true, data: snapshotRaw(app: activeApp, options: options))
      }
      needsPostSnapshotInteractionDelay = true
      return Response(ok: true, data: snapshotFast(app: activeApp, options: options))
    case .screenshot:
      let screenshot: XCUIScreenshot
#if os(macOS)
      // macOS keeps the app-targeted capture behavior for window-level screenshots.
      if let bundleId = command.appBundleId, !bundleId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        let targetApp = XCUIApplication(bundleIdentifier: bundleId)
        targetApp.activate()
        activeApp = targetApp
        // Brief wait for the app transition animation to complete
        Thread.sleep(forTimeInterval: 0.5)
      }
      if command.fullscreen == true {
        screenshot = XCUIScreen.main.screenshot()
      } else if let bundleId = command.appBundleId, !bundleId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        screenshot = screenshotRoot(app: activeApp).screenshot()
      } else {
        screenshot = XCUIScreen.main.screenshot()
      }
#else
      screenshot = XCUIScreen.main.screenshot()
#endif
      guard let pngData = runnerPngData(for: screenshot.image) else {
        return Response(ok: false, error: ErrorPayload(message: "Failed to encode screenshot as PNG"))
      }
      let fileName = "screenshot-\(Int(Date().timeIntervalSince1970 * 1000)).png"
      let filePath = (NSTemporaryDirectory() as NSString).appendingPathComponent(fileName)
      do {
        try pngData.write(to: URL(fileURLWithPath: filePath))
      } catch {
        return Response(ok: false, error: ErrorPayload(message: "Failed to write screenshot: \(error.localizedDescription)"))
      }
#if os(macOS)
      return Response(ok: true, data: DataPayload(message: filePath))
#else
      // Return path relative to app container root (tmp/ maps to NSTemporaryDirectory)
      return Response(ok: true, data: DataPayload(message: "tmp/\(fileName)"))
#endif
    case .isScreenStatic:
#if os(macOS)
      return Response(
        ok: false,
        error: ErrorPayload(code: "UNSUPPORTED_OPERATION", message: "isScreenStatic is iOS/tvOS-only"))
#else
      // Settle probe (#385): two full-screen captures ~100ms apart, compared by
      // SHA-256 on-runner so only a boolean crosses the wire (Maestro's
      // ScreenDiffHandler split).
      let first = XCUIScreen.main.screenshot()
      sleepFor(0.1)
      let second = XCUIScreen.main.screenshot()
      guard let firstPng = runnerPngData(for: first.image),
            let secondPng = runnerPngData(for: second.image) else {
        return Response(
          ok: false,
          error: ErrorPayload(message: "Failed to encode screenshots for isScreenStatic"))
      }
      let isStatic = SHA256.hash(data: firstPng) == SHA256.hash(data: secondPng)
      return Response(ok: true, data: DataPayload(message: "isScreenStatic", static: isStatic))
#endif
    case .back, .backInApp:
      if tapInAppBackControl(app: activeApp) {
        let message = command.command == .back ? "back" : "backInApp"
        return Response(ok: true, data: DataPayload(message: message))
      }
      return Response(ok: false, error: ErrorPayload(message: "in-app back control is not available"))
    case .backSystem:
      if performSystemBackAction(app: activeApp) {
        return Response(ok: true, data: DataPayload(message: "backSystem"))
      }
      return Response(ok: false, error: ErrorPayload(message: "system back is not available"))
    case .home:
      pressHomeButton()
      return Response(ok: true, data: DataPayload(message: "home"))
    case .rotate:
      guard let orientation = command.orientation?.trimmingCharacters(in: .whitespacesAndNewlines),
        !orientation.isEmpty
      else {
        return Response(ok: false, error: ErrorPayload(message: "rotate requires orientation"))
      }
      if rotateDevice(to: orientation) {
        return Response(
          ok: true,
          data: DataPayload(message: "rotate", orientation: orientation)
        )
      }
      return Response(
        ok: false,
        error: ErrorPayload(message: "unsupported rotate orientation: \(orientation)")
      )
    case .appSwitcher:
      performAppSwitcherGesture(app: activeApp)
      return Response(ok: true, data: DataPayload(message: "appSwitcher"))
    case .keyboardDismiss:
      let result = dismissKeyboard(app: activeApp)
      if result.wasVisible && !result.dismissed {
        return Response(
          ok: false,
          error: ErrorPayload(
            code: "UNSUPPORTED_OPERATION",
            message: "Unable to dismiss the iOS keyboard without a native dismiss gesture or control"
          )
        )
      }
      return Response(
        ok: true,
        data: DataPayload(
          message: "keyboardDismiss",
          visible: result.visible,
          wasVisible: result.wasVisible,
          dismissed: result.dismissed
        )
      )
    case .alert:
      let action = (command.action ?? "get").lowercased()
      let alert = activeApp.alerts.firstMatch
      if !alert.exists {
        return Response(ok: false, error: ErrorPayload(message: "alert not found"))
      }
      if action == "accept" {
        guard let button = alert.buttons.allElementsBoundByIndex.first else {
          return Response(ok: false, error: ErrorPayload(message: "alert accept button not found"))
        }
        let outcome = activateElement(app: activeApp, element: button, action: "alert accept")
        if let response = unsupportedResponse(for: outcome) {
          return response
        }
        return Response(ok: true, data: DataPayload(message: "accepted"))
      }
      if action == "dismiss" {
        guard let button = alert.buttons.allElementsBoundByIndex.last else {
          return Response(ok: false, error: ErrorPayload(message: "alert dismiss button not found"))
        }
        let outcome = activateElement(app: activeApp, element: button, action: "alert dismiss")
        if let response = unsupportedResponse(for: outcome) {
          return response
        }
        return Response(ok: true, data: DataPayload(message: "dismissed"))
      }
      let buttonLabels = alert.buttons.allElementsBoundByIndex.map { $0.label }
      return Response(ok: true, data: DataPayload(message: alert.label, items: buttonLabels))
    case .pinch:
      guard let scale = command.scale, scale > 0 else {
        return Response(ok: false, error: ErrorPayload(message: "pinch requires scale > 0"))
      }
      var outcome = RunnerInteractionOutcome.performed
      let timing = measureGesture {
        outcome = pinch(app: activeApp, scale: scale, x: command.x, y: command.y)
      }
      if let response = unsupportedResponse(for: outcome) {
        return response
      }
      return Response(
        ok: true,
        data: DataPayload(
          message: "pinched",
          gestureStartUptimeMs: timing.gestureStartUptimeMs,
          gestureEndUptimeMs: timing.gestureEndUptimeMs
        )
      )
    }
  }
}
