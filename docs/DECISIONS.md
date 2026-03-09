# Architectural Decisions

## 2026-03-09: Initial Implementation

### D1: Use 127.0.0.1 instead of localhost for Metro discovery
Node 18+ defaults to IPv6 for `localhost`, which can fail if Metro only binds IPv4. Using `127.0.0.1` directly avoids DNS resolution ambiguity.

### D2: Filter ring buffers before applying limit
Gemini review identified that applying `getLast(limit)` before filtering discards relevant entries. Now we filter the entire buffer first, then slice to limit.

### D3: Reject all pending CDP promises on WebSocket close
When the WebSocket closes (reload or crash), pending `Runtime.evaluate` calls would hang until their 5s timeout. Now we immediately reject them on close to prevent cascading delays.

### D4: Capture text nodes (tag 6) in fiber tree walker
React Fiber text nodes have `tag === 6` and store their text in `memoizedProps` as a string. Without capturing these, the agent cannot read any screen text. Added early return for text nodes in the `walk()` function.

### D5: Extract accessibilityLabel alongside testID
Many RN apps use `accessibilityLabel` for e2e testing. The fiber tree walker now captures `testID`, `accessibilityLabel`, and `nativeID`.

### D6: Catch expected errors in reload()
`DevSettings.reload()` kills the JS bundle, closing the WebSocket. The `evaluate()` call throws because the WS closes. Wrapping in try/catch prevents aborting the reconnect sequence.

### D7: MCP server uses zod schemas from @modelcontextprotocol/sdk
The SDK v1.12+ uses zod for tool parameter validation. All tool definitions use `z.string()`, `z.number()`, `z.boolean()`, `z.enum()` with `.default()` and `.optional()`.

### D8: Single CDPClient instance, mutable global
The MCP server uses a single `let client` that can be reassigned when the user overrides the Metro port. Previous client is disconnected before replacement.
