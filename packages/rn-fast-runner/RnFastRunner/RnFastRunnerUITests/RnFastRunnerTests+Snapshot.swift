import XCTest

extension RnFastRunnerTests {
  private static let collapsedTabCandidateTypes: Set<XCUIElement.ElementType> = [
    .button,
    .link,
    .menuItem,
    .other,
    .staticText
  ]
  private static let scrollContainerTypes: Set<XCUIElement.ElementType> = [
    .collectionView,
    .scrollView,
    .table
  ]

  private struct SnapshotTraversalContext {
    let queryRoot: XCUIElement
    let rootSnapshot: XCUIElementSnapshot
    let viewport: CGRect
    let maxDepth: Int
  }

  private struct SnapshotEvaluation {
    let label: String
    let identifier: String
    let valueText: String?
    let hittable: Bool
    let focused: Bool
    let visible: Bool
  }

  // MARK: - Snapshot Entry

  func elementTypeName(_ type: XCUIElement.ElementType) -> String {
    switch type {
    case .application: return "Application"
    case .window: return "Window"
    case .button: return "Button"
    case .cell: return "Cell"
    case .staticText: return "StaticText"
    case .textField: return "TextField"
    case .textView: return "TextView"
    case .secureTextField: return "SecureTextField"
    case .switch: return "Switch"
    case .slider: return "Slider"
    case .link: return "Link"
    case .image: return "Image"
    case .navigationBar: return "NavigationBar"
    case .tabBar: return "TabBar"
    case .collectionView: return "CollectionView"
    case .table: return "Table"
    case .scrollView: return "ScrollView"
    case .searchField: return "SearchField"
    case .segmentedControl: return "SegmentedControl"
    case .stepper: return "Stepper"
    case .picker: return "Picker"
    case .checkBox: return "CheckBox"
    case .menuItem: return "MenuItem"
    case .other: return "Other"
    default:
      switch type.rawValue {
      case 19:
        return "Keyboard"
      case 20:
        return "Key"
      case 24:
        return "SearchField"
      default:
        return "Element(\(type.rawValue))"
      }
    }
  }

  func snapshotFast(app: XCUIApplication, options: SnapshotOptions) -> DataPayload {
    if let blocking = blockingSystemAlertSnapshot() {
      return blocking
    }

    guard let context = makeSnapshotTraversalContext(app: app, options: options) else {
      return DataPayload(
        nodes: [],
        truncated: false,
        keyboardVisible: isKeyboardVisible(app: app),
        snapshotGeneration: currentSnapshotGeneration
      )
    }

    var cachedDescendantElements: [XCUIElement]?
    func collapsedTabDescendants() -> [XCUIElement] {
      if let cachedDescendantElements {
        return cachedDescendantElements
      }
      let fetched = safeSnapshotElementsQuery {
        context.queryRoot.descendants(matching: .any).allElementsBoundByIndex
      }
      cachedDescendantElements = fetched
      return fetched
    }

    var nodes: [SnapshotNode] = []
    var truncated = false
    let rootEvaluation = evaluateSnapshot(context.rootSnapshot, in: context)
    nodes.append(
      makeSnapshotNode(
        snapshot: context.rootSnapshot,
        evaluation: rootEvaluation,
        depth: 0,
        index: 0,
        parentIndex: nil
      )
    )
    if context.maxDepth > 0 {
      let didTruncateFallback = appendCollapsedTabFallbackNodes(
        to: &nodes,
        containerSnapshot: context.rootSnapshot,
        resolveElements: collapsedTabDescendants,
        depth: 1,
        parentIndex: 0,
        nodeLimit: fastSnapshotLimit,
        viewport: context.viewport
      )
      truncated = truncated || didTruncateFallback
    }

    var seen = Set<String>()
    var stack: [(XCUIElementSnapshot, Int, Int, Int?)] = context.rootSnapshot.children.map {
      ($0, 1, 1, 0)
    }

    while let (snapshot, depth, visibleDepth, parentIndex) = stack.popLast() {
      if nodes.count >= fastSnapshotLimit {
        truncated = true
        break
      }
      if let limit = options.depth, depth > limit { continue }

      let evaluation = evaluateSnapshot(snapshot, in: context)
      let include = shouldInclude(
        snapshot: snapshot,
        label: evaluation.label,
        identifier: evaluation.identifier,
        valueText: evaluation.valueText,
        options: options,
        visible: evaluation.visible
      )

      let key = "\(snapshot.elementType)-\(evaluation.label)-\(evaluation.identifier)-\(snapshot.frame.origin.x)-\(snapshot.frame.origin.y)"
      let isDuplicate = seen.contains(key)
      if !isDuplicate {
        seen.insert(key)
      }

      let currentIndex = include && !isDuplicate ? nodes.count : parentIndex
      if depth < context.maxDepth {
        let nextVisibleDepth = include && !isDuplicate ? visibleDepth + 1 : visibleDepth
        for child in snapshot.children.reversed() {
          stack.append((child, depth + 1, nextVisibleDepth, currentIndex))
        }
      }

      if !include || isDuplicate { continue }

      let index = nodes.count
      nodes.append(
        makeSnapshotNode(
          snapshot: snapshot,
          evaluation: evaluation,
          depth: min(context.maxDepth, visibleDepth),
          index: index,
          parentIndex: parentIndex
        )
      )
      if visibleDepth < context.maxDepth {
        let didTruncateFallback = appendCollapsedTabFallbackNodes(
          to: &nodes,
          containerSnapshot: snapshot,
          resolveElements: collapsedTabDescendants,
          depth: visibleDepth + 1,
          parentIndex: index,
          nodeLimit: fastSnapshotLimit,
          viewport: context.viewport
        )
        truncated = truncated || didTruncateFallback
      }

    }

    return DataPayload(
      nodes: nodes,
      truncated: truncated,
      keyboardVisible: isKeyboardVisible(app: app),
      snapshotGeneration: currentSnapshotGeneration
    )
  }

  func snapshotRaw(app: XCUIApplication, options: SnapshotOptions) -> DataPayload {
    if let blocking = blockingSystemAlertSnapshot() {
      return blocking
    }

    guard let context = makeSnapshotTraversalContext(app: app, options: options) else {
      return DataPayload(
        nodes: [],
        truncated: false,
        keyboardVisible: isKeyboardVisible(app: app),
        snapshotGeneration: currentSnapshotGeneration
      )
    }

    var nodes: [SnapshotNode] = []
    var truncated = false

    func walk(_ snapshot: XCUIElementSnapshot, depth: Int, parentIndex: Int?) {
      if nodes.count >= maxSnapshotElements {
        truncated = true
        return
      }
      if let limit = options.depth, depth > limit { return }

      let evaluation = evaluateSnapshot(snapshot, in: context)
      let include = shouldInclude(
        snapshot: snapshot,
        label: evaluation.label,
        identifier: evaluation.identifier,
        valueText: evaluation.valueText,
        options: options,
        visible: evaluation.visible
      )
      let currentIndex = include ? nodes.count : parentIndex
      if include {
        nodes.append(
          makeSnapshotNode(
            snapshot: snapshot,
            evaluation: evaluation,
            depth: depth,
            index: nodes.count,
            parentIndex: parentIndex
          )
        )
      }

      let children = snapshot.children
      for child in children {
        walk(child, depth: depth + 1, parentIndex: currentIndex)
        if truncated { return }
      }
    }

    walk(context.rootSnapshot, depth: 0, parentIndex: nil)
    return DataPayload(
      nodes: nodes,
      truncated: truncated,
      keyboardVisible: isKeyboardVisible(app: app),
      snapshotGeneration: currentSnapshotGeneration
    )
  }

  private struct PresenceDescriptor: Equatable {
    enum Value: Equatable {
      case absent
      case text(String)
      case number(String, String)
    }

    let type: XCUIElement.ElementType
    let identifier: String
    let label: String
    let value: Value
    let frame: CGRect
    let enabled: Bool

    init?(_ snapshot: XCUIElementSnapshot) {
      type = snapshot.elementType
      identifier = snapshot.identifier
      label = snapshot.label
      frame = snapshot.frame
      enabled = snapshot.isEnabled
      if let original = snapshot.value {
        if let text = original as? String {
          value = .text(text)
        } else if let number = original as? NSNumber, number.doubleValue.isFinite {
          value = .number(String(cString: number.objCType), number.stringValue)
        } else {
          return nil
        }
      } else {
        value = .absent
      }
    }
  }

  func platformPresenceFailure() -> Response {
    Response(ok: false, error: ErrorPayload(
      code: "PLATFORM_PRESENCE_FAILED", message: "native platform presence capture failed"
    ))
  }

  private func presenceUptimeMs() -> Double {
    ProcessInfo.processInfo.systemUptime * 1000
  }

  private func presenceRead<T>(deadline: Double? = nil, _ read: () throws -> T) -> T? {
    if let deadline, presenceUptimeMs() >= deadline { return nil }
    var result: T?
    let exception = RunnerObjCExceptionCatcher.catchException({
      result = try? read()
    })
    guard exception == nil else { return nil }
    if let deadline, presenceUptimeMs() >= deadline { return nil }
    return result
  }

  private func presenceAppIsEligible(_ app: XCUIApplication, deadline: Double) -> Bool? {
    guard let state = presenceRead(deadline: deadline, { app.state }) else { return nil }
    guard state == .runningForeground else { return false }
    #if !os(macOS)
      guard let alerts = presenceRead(deadline: deadline, { self.springboard.alerts.count }),
            let sheets = presenceRead(deadline: deadline, { self.springboard.sheets.count }) else { return nil }
      return alerts == 0 && sheets == 0
    #else
      return true
    #endif
  }

  private func presenceLabelSource(_ snapshot: XCUIElementSnapshot) -> PlatformPresenceObservation.LabelSource {
    if !snapshot.label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .direct }
    if snapshotValueText(snapshot) != nil { return .value }
    return aggregatedLabel(for: snapshot) == nil ? .none : .descendant
  }

  func snapshotPlatformPresence(app: XCUIApplication, appId: String) -> DataPayload {
    let started = presenceUptimeMs()
    let deadline = started + 5_000
    let captureId = UUID().uuidString
    let generation = currentSnapshotGeneration
    var nodes: [SnapshotNode] = []
    var descriptors: [PresenceDescriptor?] = []
    var truncated = false
    var complete = false

    let enumerated = presenceRead { () -> Bool in
      guard self.presenceAppIsEligible(app, deadline: deadline) == true,
            let root = self.presenceRead(deadline: deadline, { try app.snapshot() }) else { return false }
      let windowFrame = root.children.first {
        $0.elementType == .window && !$0.frame.isNull && !$0.frame.isEmpty
      }?.frame
      let appFrame = root.frame
      let viewport = windowFrame ?? (appFrame.isNull || appFrame.isEmpty ? .infinite : appFrame)
      let context = SnapshotTraversalContext(
        queryRoot: app, rootSnapshot: root, viewport: viewport, maxDepth: Int.max
      )
      var stack: [(XCUIElementSnapshot, Int, Int?)] = [(root, 0, nil)]
      while let (snapshot, depth, parentIndex) = stack.popLast() {
        guard nodes.count < self.maxSnapshotElements else {
          truncated = true
          break
        }
        let descriptor = PresenceDescriptor(snapshot)
        var node = self.makeSnapshotNode(
          snapshot: snapshot, evaluation: self.evaluateSnapshot(snapshot, in: context),
          depth: depth, index: nodes.count, parentIndex: parentIndex
        )
        node.presence = PlatformPresenceObservation(
          captureId: captureId, generation: generation, nodeIndex: node.index,
          status: .unknown, labelSource: self.presenceLabelSource(snapshot)
        )
        nodes.append(node)
        descriptors.append(descriptor)
        for child in snapshot.children.reversed() {
          stack.append((child, depth + 1, node.index))
        }
      }
      return !truncated
    }
    if let enumerated {
      complete = enumerated
    } else {
      nodes.removeAll()
      descriptors.removeAll()
    }

    // A capped tree cannot establish descriptor uniqueness in the whole raw snapshot.
    if complete {
      for index in nodes.indices {
        if presenceUptimeMs() >= deadline { break }
        guard nodes[index].depth > 0,
              nodes[index].presence?.labelSource != .descendant,
              let descriptor = descriptors[index],
              descriptor.type != .application, descriptor.type != .window,
              descriptors.filter({ $0 == descriptor }).count == 1 else { continue }
        let observation = presenceRead(deadline: deadline) {
          self.observePresence(descriptor, app: app, deadline: deadline)
        }
        if let observed = observation ?? nil {
          nodes[index].presence?.status = .observed
          nodes[index].presence?.observedUptimeMs = observed
        }
      }
      complete = presenceAppIsEligible(app, deadline: deadline) == true
        && presenceEnumerationIsUnchanged(app: app, nodes: nodes, descriptors: descriptors, deadline: deadline)
    }
    let ended = presenceUptimeMs()
    complete = complete && ended < deadline
    if !complete {
      for index in nodes.indices {
        nodes[index].presence?.status = .unknown
        nodes[index].presence?.observedUptimeMs = nil
      }
    }
    return makePlatformPresencePayload(
      nodes: nodes, truncated: truncated,
      capture: PlatformPresenceCapture(
        version: 1, source: "xcui-live", captureId: captureId, appId: appId,
        generation: generation, startedUptimeMs: started, endedUptimeMs: ended,
        enumeration: "raw-unfiltered", complete: complete
      )
    )
  }

  private func presenceEnumerationIsUnchanged(
    app: XCUIApplication, nodes: [SnapshotNode], descriptors: [PresenceDescriptor?], deadline: Double
  ) -> Bool {
    guard nodes.count == descriptors.count else { return false }
    return presenceRead(deadline: deadline) {
      let root = try app.snapshot()
      var stack: [(XCUIElementSnapshot, Int, Int?)] = [(root, 0, nil)]
      var index = 0
      while let (snapshot, depth, parentIndex) = stack.popLast() {
        guard self.presenceUptimeMs() < deadline,
              index < self.maxSnapshotElements, index < nodes.count,
              let descriptor = PresenceDescriptor(snapshot),
              descriptors[index] == descriptor,
              nodes[index].depth == depth, nodes[index].parentIndex == parentIndex else { return false }
        for child in snapshot.children.reversed() {
          stack.append((child, depth + 1, index))
        }
        index += 1
      }
      return index == nodes.count
    } == true
  }

  private func uniquePresenceElement(
    _ descriptor: PresenceDescriptor, app: XCUIApplication, deadline: Double
  ) -> XCUIElement? {
    guard let root = presenceRead(deadline: deadline, { try app.snapshot() }),
          let elements = presenceRead(deadline: deadline, {
            // The predicate only narrows exact attributes; frame and value are checked on snapshots.
            app.descendants(matching: descriptor.type)
              .matching(NSPredicate(format: "identifier == %@ AND label == %@", descriptor.identifier, descriptor.label))
              .allElementsBoundByAccessibilityElement
          }) else { return nil }
    var match: XCUIElement? = PresenceDescriptor(root) == descriptor ? app : nil
    for element in elements {
      guard let snapshot = presenceRead(deadline: deadline, { try element.snapshot() }) else { return nil }
      if PresenceDescriptor(snapshot) == descriptor {
        guard match == nil else { return nil }
        match = element
      }
    }
    return presenceUptimeMs() < deadline ? match : nil
  }

  private func observePresence(
    _ descriptor: PresenceDescriptor, app: XCUIApplication, deadline: Double
  ) -> Double? {
    guard let element = uniquePresenceElement(descriptor, app: app, deadline: deadline),
          let before = presenceRead(deadline: deadline, { try element.snapshot() }),
          PresenceDescriptor(before) == descriptor,
          presenceRead(deadline: deadline, { element.isHittable }) == true else { return nil }
    let observed = presenceUptimeMs()
    guard let after = presenceRead(deadline: deadline, { try element.snapshot() }),
          PresenceDescriptor(after) == descriptor,
          uniquePresenceElement(descriptor, app: app, deadline: deadline) != nil,
          let retained = presenceRead(deadline: deadline, { try element.snapshot() }),
          PresenceDescriptor(retained) == descriptor else { return nil }
    return observed
  }

  func retainSnapshotTargets(_ nodes: [SnapshotNode]) {
    retainedSnapshotTargets = Dictionary(uniqueKeysWithValues: nodes.map { node in
      (
        node.index,
        RetainedSnapshotTarget(
          generation: currentSnapshotGeneration,
          index: node.index,
          type: node.type,
          label: node.label,
          identifier: node.identifier,
          rect: node.rect
        )
      )
    })
  }

  func snapshotRect(from frame: CGRect) -> SnapshotRect {
    return SnapshotRect(
      x: Double(frame.origin.x),
      y: Double(frame.origin.y),
      width: Double(frame.size.width),
      height: Double(frame.size.height)
    )
  }

  // MARK: - Snapshot Filtering

  private func shouldInclude(
    snapshot: XCUIElementSnapshot,
    label: String,
    identifier: String,
    valueText: String?,
    options: SnapshotOptions,
    visible: Bool
  ) -> Bool {
    let type = snapshot.elementType
    return shouldIncludeSnapshotNode(
      type: type,
      hasContent: !label.isEmpty || !identifier.isEmpty || (valueText != nil),
      isScrollableContainer: isScrollableContainer(snapshot, visible: visible),
      isInteractiveType: interactiveTypes.contains(type),
      visible: visible,
      compact: options.compact,
      interactiveOnly: options.interactiveOnly
    )
  }

  private func makeSnapshotTraversalContext(
    app: XCUIApplication,
    options: SnapshotOptions
  ) -> SnapshotTraversalContext? {
    let viewport = snapshotViewport(app: app)
    let queryRoot = options.scope.flatMap { findScopeElement(app: app, scope: $0) } ?? app

    let rootSnapshot: XCUIElementSnapshot
    do {
      rootSnapshot = try queryRoot.snapshot()
    } catch {
      return nil
    }

    return SnapshotTraversalContext(
      queryRoot: queryRoot,
      rootSnapshot: rootSnapshot,
      viewport: viewport,
      maxDepth: options.depth ?? Int.max
    )
  }

  private func evaluateSnapshot(
    _ snapshot: XCUIElementSnapshot,
    in context: SnapshotTraversalContext
  ) -> SnapshotEvaluation {
    let label = aggregatedLabel(for: snapshot) ?? snapshot.label.trimmingCharacters(in: .whitespacesAndNewlines)
    let identifier = snapshot.identifier.trimmingCharacters(in: .whitespacesAndNewlines)
    let valueText = snapshotValueText(snapshot)
    return SnapshotEvaluation(
      label: label,
      identifier: identifier,
      valueText: valueText,
      hittable: computeSnapshotHittable(
        enabled: snapshot.isEnabled,
        frame: snapshot.frame,
        viewport: context.viewport
      ),
      focused: snapshotHasFocus(snapshot),
      visible: isVisibleInViewport(snapshot.frame, context.viewport)
    )
  }

  private func makeSnapshotNode(
    snapshot: XCUIElementSnapshot,
    evaluation: SnapshotEvaluation,
    depth: Int,
    index: Int,
    parentIndex: Int?
  ) -> SnapshotNode {
    return SnapshotNode(
      index: index,
      type: elementTypeName(snapshot.elementType),
      label: evaluation.label.isEmpty ? nil : evaluation.label,
      identifier: evaluation.identifier.isEmpty ? nil : evaluation.identifier,
      value: evaluation.valueText,
      rect: snapshotRect(from: snapshot.frame),
      enabled: snapshot.isEnabled,
      focused: evaluation.focused ? true : nil,
      hittable: evaluation.hittable,
      depth: depth,
      parentIndex: parentIndex,
      hiddenContentAbove: nil,
      hiddenContentBelow: nil
    )
  }

  private func snapshotValueText(_ snapshot: XCUIElementSnapshot) -> String? {
    guard let value = snapshot.value else { return nil }
    let text = String(describing: value).trimmingCharacters(in: .whitespacesAndNewlines)
    return text.isEmpty ? nil : text
  }

  private func snapshotViewport(app: XCUIApplication) -> CGRect {
    let windows = app.windows.allElementsBoundByIndex
    if let window = windows.first(where: { $0.exists && !$0.frame.isNull && !$0.frame.isEmpty }) {
      return window.frame
    }
    let appFrame = app.frame
    if !appFrame.isNull && !appFrame.isEmpty {
      return appFrame
    }
    return .infinite
  }

  func aggregatedLabel(for snapshot: XCUIElementSnapshot, depth: Int = 0) -> String? {
    if depth > 4 { return nil }
    let text = snapshot.label.trimmingCharacters(in: .whitespacesAndNewlines)
    if !text.isEmpty { return text }
    if let valueText = snapshotValueText(snapshot) { return valueText }
    for child in snapshot.children {
      if let childLabel = aggregatedLabel(for: child, depth: depth + 1) {
        return childLabel
      }
    }
    return nil
  }

  private func isVisibleInViewport(_ rect: CGRect, _ viewport: CGRect) -> Bool {
    if rect.isNull || rect.isEmpty { return false }
    return rect.intersects(viewport)
  }

  private func appendCollapsedTabFallbackNodes(
    to nodes: inout [SnapshotNode],
    containerSnapshot: XCUIElementSnapshot,
    resolveElements: () -> [XCUIElement],
    depth: Int,
    parentIndex: Int,
    nodeLimit: Int,
    viewport: CGRect
  ) -> Bool {
    let fallbackNodes = collapsedTabFallbackNodes(
      for: containerSnapshot,
      resolveElements: resolveElements,
      startingIndex: nodes.count,
      depth: depth,
      parentIndex: parentIndex,
      viewport: viewport
    )
    if fallbackNodes.isEmpty { return false }
    let remaining = max(0, nodeLimit - nodes.count)
    if remaining == 0 { return true }
    nodes.append(contentsOf: fallbackNodes.prefix(remaining))
    return fallbackNodes.count > remaining
  }

  private func collapsedTabFallbackNodes(
    for containerSnapshot: XCUIElementSnapshot,
    resolveElements: () -> [XCUIElement],
    startingIndex: Int,
    depth: Int,
    parentIndex: Int,
    viewport: CGRect
  ) -> [SnapshotNode] {
    if !containerSnapshot.children.isEmpty { return [] }
    guard shouldExpandCollapsedTabContainer(containerSnapshot) else { return [] }
    let containerFrame = containerSnapshot.frame
    if containerFrame.isNull || containerFrame.isEmpty { return [] }

    // Collapsed tab containers should be rare, so a full descendant scan is acceptable once per
    // snapshot as a fallback for XCTest omitting the tab children from the snapshot tree.
    let elements = resolveElements()
    let candidates = elements.compactMap { element in
      collapsedTabCandidateNode(
        element: element,
        containerSnapshot: containerSnapshot,
        containerFrame: containerFrame,
        viewport: viewport
      )
    }
    .sorted { left, right in
      if left.rect.x != right.rect.x {
        return left.rect.x < right.rect.x
      }
      return left.rect.y < right.rect.y
    }

    if candidates.count < 2 { return [] }
    let rowMidpoints = candidates.map { $0.rect.y + ($0.rect.height / 2) }
    let rowSpread = (rowMidpoints.max() ?? 0) - (rowMidpoints.min() ?? 0)
    // Allow modest vertical jitter and short two-row wraps while still rejecting unrelated controls.
    if rowSpread > max(24.0, Double(containerFrame.height) * 0.6) { return [] }

    var seen = Set<String>()
    let uniqueCandidates = candidates.filter { node in
      let key = "\(node.type)-\(node.label ?? "")-\(node.identifier ?? "")-\(node.value ?? "")-\(node.rect.x)-\(node.rect.y)-\(node.rect.width)-\(node.rect.height)"
      if seen.contains(key) { return false }
      seen.insert(key)
      return true
    }
    if uniqueCandidates.count < 2 { return [] }

    return uniqueCandidates.enumerated().map { offset, node in
      SnapshotNode(
        index: startingIndex + offset,
        type: node.type,
        label: node.label,
        identifier: node.identifier,
        value: node.value,
        rect: node.rect,
        enabled: node.enabled,
        focused: node.focused,
        hittable: node.hittable,
        depth: depth,
        parentIndex: parentIndex,
        hiddenContentAbove: nil,
        hiddenContentBelow: nil
      )
    }
  }

  private func collapsedTabCandidateNode(
    element: XCUIElement,
    containerSnapshot: XCUIElementSnapshot,
    containerFrame: CGRect,
    viewport: CGRect
  ) -> SnapshotNode? {
    var node: SnapshotNode?
    let exceptionMessage = RunnerObjCExceptionCatcher.catchException({
      if !element.exists { return }
      let elementType = element.elementType
      if !Self.collapsedTabCandidateTypes.contains(elementType) { return }
      let frame = element.frame
      if frame.isNull || frame.isEmpty { return }
      if frame.equalTo(containerFrame) { return }
      let area = max(CGFloat(1), frame.width * frame.height)
      let containerArea = max(CGFloat(1), containerFrame.width * containerFrame.height)
      if area >= containerArea * 0.9 { return }
      let center = CGPoint(x: frame.midX, y: frame.midY)
      if !containerFrame.contains(center) { return }

      let label = element.label.trimmingCharacters(in: .whitespacesAndNewlines)
      let identifier = element.identifier.trimmingCharacters(in: .whitespacesAndNewlines)
      let valueText = snapshotValueText(element)
      let hasContent = !label.isEmpty || !identifier.isEmpty || valueText != nil
      if !hasContent { return }
      if sameSemanticElement(
        containerSnapshot: containerSnapshot,
        elementType: elementType,
        label: label,
        identifier: identifier
      ) {
        return
      }

      node = SnapshotNode(
        index: 0,
        type: elementTypeName(elementType),
        label: label.isEmpty ? nil : label,
        identifier: identifier.isEmpty ? nil : identifier,
        value: valueText,
        rect: snapshotRect(from: frame),
        enabled: element.isEnabled,
        focused: elementHasFocus(element) ? true : nil,
        hittable: computeSnapshotHittable(
          enabled: element.isEnabled,
          frame: frame,
          viewport: viewport
        ),
        depth: 0,
        parentIndex: nil,
        hiddenContentAbove: nil,
        hiddenContentBelow: nil
      )
    })
    if let exceptionMessage {
      NSLog(
        "RN_FAST_RUNNER_SNAPSHOT_TAB_FALLBACK_IGNORED_EXCEPTION=%@",
        exceptionMessage
      )
      return nil
    }
    return node
  }

  private func snapshotHasFocus(_ snapshot: XCUIElementSnapshot) -> Bool {
    var focused = false
    _ = RunnerObjCExceptionCatcher.catchException({
      // `as?` not `as!` — a force-cast failure is a fatal Swift trap that the
      // Obj-C exception catcher cannot intercept.
      if let obj = snapshot as? NSObject, let value = obj.value(forKey: "hasFocus") as? Bool {
        focused = value
      }
    })
    return focused
  }

  private func shouldExpandCollapsedTabContainer(_ snapshot: XCUIElementSnapshot) -> Bool {
    let frame = snapshot.frame
    if frame.isNull || frame.isEmpty { return false }
    if frame.width < max(CGFloat(160), frame.height * 1.75) { return false }
    switch snapshot.elementType {
    case .tabBar, .segmentedControl, .slider:
      return true
    default:
      return false
    }
  }

  private func snapshotValueText(_ element: XCUIElement) -> String? {
    let text = String(describing: element.value ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return text.isEmpty ? nil : text
  }

  private func sameSemanticElement(
    containerSnapshot: XCUIElementSnapshot,
    elementType: XCUIElement.ElementType,
    label: String,
    identifier: String
  ) -> Bool {
    if containerSnapshot.elementType != elementType { return false }
    let containerLabel = containerSnapshot.label.trimmingCharacters(in: .whitespacesAndNewlines)
    let containerIdentifier = containerSnapshot.identifier
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return containerLabel == label && containerIdentifier == identifier
  }

  private func safeSnapshotElementsQuery(_ fetch: () -> [XCUIElement]) -> [XCUIElement] {
    var elements: [XCUIElement] = []
    let exceptionMessage = RunnerObjCExceptionCatcher.catchException({
      elements = fetch()
    })
    if let exceptionMessage {
      NSLog(
        "RN_FAST_RUNNER_SNAPSHOT_QUERY_IGNORED_EXCEPTION=%@",
        exceptionMessage
      )
      return []
    }
    return elements
  }

  private func isScrollableContainer(_ snapshot: XCUIElementSnapshot, visible: Bool) -> Bool {
    if !visible { return false }
    if !Self.scrollContainerTypes.contains(snapshot.elementType) { return false }
    return !snapshot.children.isEmpty
  }
}

func makePlatformPresencePayload(
  nodes: [SnapshotNode], truncated: Bool, capture: PlatformPresenceCapture
) -> DataPayload {
  let keyboardVisible: Bool? = capture.complete ? nodes.contains { node in
    node.type == "Keyboard" && !CGRect(
      x: node.rect.x, y: node.rect.y, width: node.rect.width, height: node.rect.height
    ).isEmpty
  } : nil
  return DataPayload(
    nodes: nodes, truncated: truncated, keyboardVisible: keyboardVisible,
    snapshotGeneration: capture.generation, presenceCapture: capture
  )
}
