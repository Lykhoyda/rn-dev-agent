---
command: nav-graph
description: Extract, inspect, and query the app navigation graph — a complete map of all screens and navigators.
argument-hint: "[scan|read|find <screen-name>]"
---

# Navigation Graph

You are mapping the navigation topology of a React Native app. Follow the subcommand below.

## Parsing Arguments

- If `$ARGUMENTS` is empty or `scan` → run **Scan**
- If `$ARGUMENTS` is `read` → run **Read**
- If `$ARGUMENTS` starts with `find` → extract screen name from remaining text, run **Find**
- If `$ARGUMENTS` starts with `navigate` or `goto` → extract screen name, run **Navigate**

## Scan

1. Call `cdp_nav_graph` with `action="scan"`.
2. Display results as a table:
   - Navigator count, screen count, coverage percentage
   - List of navigators with their kind, screen count, and active screen
   - If not first scan: show new routes and removed routes
3. Note the file path where the graph was saved.
4. If coverage < 100%, note which navigators are unvisited and suggest navigating to them to expand the graph.

## Read

1. Call `cdp_nav_graph` with `action="read"`.
2. If no cached graph exists, suggest running `scan` first.
3. Display the full navigator tree in a readable format:
   ```
   root (tab) — 3 screens [active: Home]
     ├── Home (stack) — 4 screens [active: ProductList]
     │     ProductList, ProductDetail, Search, Categories
     ├── Cart (native-stack) — 3 screens
     │     CartList, Checkout, OrderConfirmation
     └── Profile (stack) — 2 screens
           ProfileView, EditProfile
   ```
4. Show metadata: last scanned, scan count, project, router type.
5. If stale (>24h), suggest re-scanning.

## Find

1. Call `cdp_nav_graph` with `action="read"` and `screen="<name>"`.
2. Display the screen's location: which navigator, navigator kind, path from root.
3. Show the screen's properties: path, params, reliability score, visit count.
4. Suggest the navigation approach:
   - If the screen is in a tab navigator: "Navigate to parent tab, then to screen"
   - If in a stack: "Push onto the stack from the parent screen"
   - If path exists: "Deep link available: <path>"

## Navigate

1. Call `cdp_nav_graph` with `action="navigate"` and `screen="<name>"`.
2. If no graph exists, suggest running `scan` first.
3. Display the navigation plan:
   - Number of steps and estimated reliability
   - Each step: action type, target screen, navigator kind
   - Prerequisites (auth, permissions) if detected
   - Deep link alternative if available
4. Ask the user: "Execute this plan?" If yes:
   - For each programmatic step: call `cdp_navigate(screen="<target>")`
   - After each step: verify with `cdp_navigation_state`
   - Report success/failure for each step
5. If a step fails:
   - Try `device_find` + `device_press` as UI fallback
   - If still fails, report and ask user for guidance
