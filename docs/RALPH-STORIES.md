# Ralph Loop — Test App User Stories

This file tracks 10 user stories for the test app. Each story exercises different CDP tools
and is implemented using the full `/rn-dev-agent:rn-feature-dev` workflow.

**Purpose:** The stories are vehicles for exercising plugin tools (CDP, agents, skills,
commands) in different scenarios. The real output is plugin improvements, not app features.

## State Tracking

Ralph reads this file each iteration to determine what to work on next.
Mark stories as they progress: `[ ]` → `[IN PROGRESS]` → `[DONE]`

---

## S1: Feed Search with Debounce `[DONE]`

**As a user**, I want to search/filter feed posts by typing in a search bar, so I can
quickly find content I'm looking for.

**Requirements:**
- Add a `TextInput` search bar at the top of `FeedScreen`
- Debounce input (300ms) before filtering
- Filter posts by title AND body (case-insensitive)
- Show "No results" empty state when filter matches nothing
- Add a clear button (✕) that appears when search has text
- Maintain search text across re-renders (local state)
- NativeWind styling consistent with existing screens
- testIDs: `feed-search-input`, `feed-search-clear`, `feed-no-results`

**CDP tools exercised:** `cdp_component_tree` (search input + filtered list), `cdp_network_log` (feed fetch), `cdp_store_state` (feed items)

**Acceptance criteria for verification:**
- Type "First" → only "First Post" visible in list
- Type "zzz" → "No results" empty state shown
- Clear button resets to full list
- Component tree shows `feed-search-input` with correct value prop
- Store state shows all 3 feed items (filtering is client-side, not in store)

**Plugin learnings:**
- CDP component_tree, network_log, store_state all worked as expected
- E2E verified with maestro-runner (35.2s, 17 steps)
- No plugin issues surfaced — baseline established

---

## S2: Dark Mode Theme `[DONE]`

**As a user**, I want to toggle between light and dark mode in Settings, and have my
preference persist across app restarts.

**Requirements:**
- Add a dark mode toggle to `SettingsScreen` (Pressable, not Switch)
- Use existing `settings.theme` from `settingsSlice` (already has `toggleTheme`)
- `settings` slice is already in redux-persist whitelist — theme persists automatically
- Create a `useThemeColors()` hook that returns `{ bg, text, card, border, muted }` based on theme
- Apply theme to: `HomeScreen`, `FeedScreen`, `TasksScreen`, `ProfileScreen`, `SettingsScreen`
- Dark mode colors: bg=`bg-gray-900`, text=`text-white`, card=`bg-gray-800`, muted=`text-gray-400`
- Light mode colors: keep current (bg=`bg-white`, text=`text-gray-900`, etc.)
- NativeWind dynamic classes via template literals
- testIDs: `settings-theme-toggle`, `settings-theme-label` (shows "Light"/"Dark")

**CDP tools exercised:** `cdp_store_state` (settings.theme persisted), `cdp_evaluate` (toggle and check), `cdp_component_tree` (className changes)

**Acceptance criteria for verification:**
- Toggle changes theme in store from "light" to "dark"
- All 5 screens show dark backgrounds after toggle
- Theme persists after full reload (redux-persist)
- Component tree shows updated className props with dark mode classes

**Plugin learnings:**
- NativeWind v4 requires `jsxImportSource: "nativewind"` in babel config (D227)
- className props visible in component tree but not rendering was a non-obvious failure mode
- E2E verified with maestro-runner (30.2s, 28 steps)
- Maestro `back` command is Android-only — iOS needs header button tap (D229)

---

## S3: Profile Edit Modal `[DONE]`

**As a user**, I want to tap "Edit Profile" and get a modal where I can change my name
and email, with validation and a save action.

**Requirements:**
- Add "Edit Profile" button on `ProfileScreen`
- Create `ProfileEditModal` screen (presented as modal via RootStack)
- Two TextInputs: name and email
- Validation: name min 2 chars, email must contain `@`
- Show inline error text below invalid fields (red text)
- "Save" button dispatches `updateProfile({ name, email })` to userSlice
- "Cancel" button dismisses modal with no changes
- Fire-and-forget POST to `/api/user/profile` on save
- Add MSW handler for POST `/api/user/profile`
- NativeWind styling, all interactive elements have testIDs
- testIDs: `profile-edit-btn`, `edit-name-input`, `edit-email-input`, `edit-name-error`, `edit-email-error`, `edit-save-btn`, `edit-cancel-btn`

**CDP tools exercised:** `cdp_navigation_state` (modal presentation), `cdp_network_log` (POST profile), `cdp_store_state` (user slice update), `cdp_component_tree` (validation errors)

**Acceptance criteria for verification:**
- Tap edit → modal opens (navigation state shows modal route)
- Enter empty name → error text visible under name field
- Enter valid name + email → save → modal dismisses, profile shows new name
- Store state reflects updated user
- Network log shows POST to /api/user/profile

**Plugin learnings — critical findings:**
- **B58 (FIXED):** CDP connected to wrong JS context in Bridgeless multi-target mode. `cdp_status` showed `__DEV__: false`, preventing all introspection. Root cause: highest-page-ID heuristic. Fix: smart target selection probes `__DEV__` on each candidate (D248)
- **B59 (OPEN):** maestro-runner v1.0.9 requires `adb` in PATH even for iOS-only testing — upstream regression
- **B56 (WORKAROUND):** Deep links trigger native Expo Go confirmation dialog. Workaround: use `cdp_evaluate` with `__NAV_REF__` for navigation
- **Phase 5.5 gap:** No detection/recovery for wrong-context scenario. Fix: health check now gates on `app.dev === true` (D250)
- **Status tool gap:** Wrong context produced no warning. Fix: `cdp_status` returns `warnResult` when `dev: false` (D249)
- **Skill gap:** rn-debugging had no troubleshooting for wrong-context. Fix: added 2 rows (D251)

---

## S4: Notification Snooze with Timer `[DONE]`

**As a user**, I want to snooze a notification for a set duration, hiding it temporarily
and showing it again when the timer expires.

**Requirements:**
- Add "Snooze" button to `NotificationDetailScreen`
- Snooze options: 1 min, 5 min, 15 min (shown as chip row)
- Add `snoozedUntil: number | null` field to `NotificationItem` in notificationsSlice
- Add `snoozeNotification(id, durationMs)` reducer
- Add `unsnoozeNotification(id)` reducer
- Snoozed notifications hidden from main list (filtered by `selectVisibleNotifications` selector)
- Show snooze badge count on NotificationsTab: "2 + 1 snoozed"
- When timer expires (setTimeout in a useEffect), auto-unsnooze
- Console.log when snoozing/unsnoozing for debugging
- testIDs: `notif-snooze-btn`, `notif-snooze-1m`, `notif-snooze-5m`, `notif-snooze-15m`, `notif-snoozed-badge`

**CDP tools exercised:** `cdp_store_state` (snoozedUntil field), `cdp_console_log` (snooze/unsnooze logs), `cdp_component_tree` (filtered list, badge), `cdp_evaluate` (fast-forward timer)

**Acceptance criteria for verification:**
- Snooze a notification → it disappears from list
- Store shows `snoozedUntil` timestamp on snoozed item
- Console log shows "[Notifications] snoozed notification X for Y ms"
- Badge shows snoozed count
- After timer expires (or evaluate to fast-forward), notification reappears

**Plugin tools focus:** First test of `cdp_console_log` for app-level logging, `cdp_evaluate` for timer manipulation, and first run of the self-evaluator report.

**Plugin learnings — critical findings:**
- **B60 (OPEN):** `pkill -f "cdp-bridge"` killed MCP server mid-session. All CDP tools became permanently unavailable — no auto-restart. Had to fall back to raw WebSocket scripts for verification (D258)
- **B61 (OPEN):** `cdp_reload` cannot switch CDP targets. If connected to wrong context, only killing and restarting Expo Go forces re-discovery (D259)
- **CDP wrong target recurrence:** Same B58 pattern from S3 — Bridgeless multi-target selection still fragile when Expo Go restarts
- **Verification fallback:** Raw WebSocket CDP scripts (using `ws` module) proved effective as MCP tool fallback. All store checks passed: snoozedUntil field, snooze/unsnooze dispatch, visible count filtering
- **Review findings:** 7 issues found (createSelector impurity, stale closure, testID stability, __DEV__ guards, non-null assertion). All 7 fixed
- **First self-evaluator report:** Written to `docs/reports/2026-03-13-notification-snooze.md`

---

## S5: Task Priority and Sort `[DONE]`

**As a user**, I want to assign priority levels to tasks and sort my task list by priority,
so important tasks are always visible first.

**Requirements:**
- Add `priority: 'low' | 'medium' | 'high'` field to `TaskItem`
- Default priority: `'medium'` for new tasks, update seed data with mixed priorities
- Add priority chip next to each task title (colored: high=red, medium=yellow, low=gray)
- Tap priority chip to cycle: low → medium → high → low
- Add sort toggle button: "Sort: Priority" / "Sort: Default"
- When sort=priority: high first, then medium, then low (within same priority, keep insertion order)
- Add `sort: 'default' | 'priority'` to TasksState
- Add `selectSortedFilteredTasks` memoized selector (applies filter THEN sort)
- Update existing `selectFilteredTasks` references to use the new selector
- testIDs: `task-priority-${index}`, `task-sort-btn`, `task-sort-label`

**CDP tools exercised:** `cdp_store_state` (priority field, sort state), `cdp_component_tree` (priority chips, sort button), `cdp_interact` (cycle priority)

**Acceptance criteria for verification:**
- New task gets priority "medium" by default
- Tap priority chip cycles through values
- Sort toggle reorders list (high tasks first)
- Store state shows correct priority values
- Component tree shows priority chip classNames changing with priority level

**Plugin tools focus:** First real test of `cdp_interact` for cycling state via repeated presses, and verifying component tree className changes.

**Plugin learnings:**
- CDP MCP tools not available in all sessions — raw WebSocket fallback via `ws` module remains essential
- NativeWind v4 line-through in dynamic template literals silently fails extraction — must be static literal (D278)
- Index-based testIDs break under sort reordering — item.id-based is mandatory for sortable lists (D275)
- Selector composition avoids filter logic duplication and improves memoization (D276)
- First story to use Phase 8 E2E Proof — 5 screenshots captured via CDP + simctl
- Review found 5 issues (all fixed): NativeWind static literal, selector composition, memoization, __DEV__ guard

---

## S6: Offline Banner with Network Detection `[DONE]`

**As a user**, I want to see a persistent banner when I lose network connectivity, and have it dismiss automatically when the connection is restored.

**Requirements:**
- Add a `useNetworkStatus()` hook using `@react-native-community/netinfo` (or mock via `cdp_evaluate`)
- Show a red "No Connection" banner at the top of all screens when offline
- Banner slides in/out with `LayoutAnimation` or `Animated`
- Tapping the banner triggers a manual retry (re-fetch current screen's data)
- When connection restores, banner slides out and a green "Back Online" toast shows for 2s
- Add `isOffline: boolean` to settingsSlice (or a new networkSlice)
- Prevent API calls while offline — show inline "Offline" message instead of spinner
- testIDs: `offline-banner`, `offline-retry-btn`, `online-toast`

**CDP tools exercised:** `cdp_evaluate` (simulate offline by toggling global flag), `cdp_error_log` (failed fetch errors), `cdp_console_log` (network state changes), `cdp_component_tree` (banner visibility)

**Acceptance criteria for verification:**
- Simulate offline via `cdp_evaluate` → banner appears on current screen
- Tap retry → console shows retry attempt
- Simulate online → banner dismisses, green toast appears
- Error log captures failed fetch attempts during offline
- Component tree confirms banner testID present/absent

**Plugin tools focus:** First real test of `cdp_error_log` for app errors, `cdp_evaluate` for environment manipulation (not just state reads), and animation/layout verification.

**Plugin learnings:**
- SafeAreaProvider crashes in Expo Go — must use hardcoded status bar height fallback (D283)
- `cdp_component_tree` returns cyclic structure errors for some components — screenshot-based verification is reliable fallback
- `useRef` pattern essential for avoiding stale closures in `useCallback` with Redux selectors (D284)
- Android LayoutAnimation requires explicit `UIManager.setLayoutAnimationEnabledExperimental(true)` (D286)
- Immediate check on mount prevents 2s blind spot in polling hooks (D285)
- Gemini+Codex review caught 4 actionable issues; 3 fixed (immediate poll, stable testIDs, Android LayoutAnimation), 1 deferred (hardcoded height — known Expo Go limitation)

---

## S7: Swipe-to-Delete with Undo `[DONE]`

**As a user**, I want to swipe a task left to delete it, with a brief undo window before permanent removal.

**Requirements:**
- Add swipe-to-delete gesture on task items (react-native-gesture-handler `Swipeable` or manual `PanResponder`)
- Swipe reveals red "Delete" background
- On full swipe: task removed from list, undo toast appears for 3s at bottom
- "Undo" button in toast restores the task to its original position
- After 3s with no undo: dispatch `deleteTask(id)` permanently
- Add `deleteTask` and `restoreTask` reducers to tasksSlice
- Deleted task held in `pendingDelete: TaskItem | null` state during undo window
- testIDs: `task-swipe-${id}`, `delete-undo-toast`, `delete-undo-btn`

**CDP tools exercised:** `cdp_store_state` (pendingDelete field, items count), `cdp_evaluate` (fast-forward undo timer), `device_swipe` (gesture interaction), `cdp_component_tree` (toast visibility)

**Acceptance criteria for verification:**
- Swipe task left → task disappears, undo toast visible
- Store shows `pendingDelete` populated with removed task
- Tap undo → task restored to list, pendingDelete null
- Wait 3s (or fast-forward) → pendingDelete cleared, task permanently gone
- Items count decremented by 1 after permanent delete

**Plugin tools focus:** First test of `device_swipe` for gesture-based interactions, timer manipulation for undo window, and verifying transient UI state (toast).

**Plugin learnings (S7):**
- PanResponder creates stale closures when used in `useRef` — `keyExtractor` mitigates but a ref wrapper for callbacks is more robust (B67)
- `removeTask` button inside SwipeableTaskRow initially bypassed `softDelete` — code review caught this critical bug
- Duplicate task IDs possible when soft-delete + add + restore — Codex identified edge case, fixed by including pendingDelete in maxId

---

## S8: Pull-to-Refresh with Loading States `[DONE]`

**As a user**, I want to pull down on the feed to refresh content, with clear loading indicators and error handling.

**Requirements:**
- Add `RefreshControl` to FeedScreen's FlatList
- On pull: dispatch async thunk to re-fetch feed from `/api/feed`
- Show spinner during fetch, "Updated just now" timestamp after success
- If fetch fails: show inline error banner with "Retry" button (not an alert)
- Add `lastFetched: number | null` and `refreshError: string | null` to feedSlice
- Stale data indicator: if `lastFetched` > 5 min ago, show subtle "Stale data" label
- MSW handler: add `?fail=true` query param to simulate errors
- testIDs: `feed-refresh-indicator`, `feed-last-fetched`, `feed-refresh-error`, `feed-retry-btn`

**CDP tools exercised:** `cdp_network_log` (refresh requests, error responses), `cdp_store_state` (lastFetched, refreshError), `cdp_evaluate` (trigger refresh programmatically, simulate stale), `cdp_dev_settings` (reload to test initial state)

**Acceptance criteria for verification:**
- Pull to refresh → network log shows GET /api/feed
- Store shows updated `lastFetched` timestamp
- Simulate error → error banner with retry button visible
- Tap retry → new network request fired
- Manipulate lastFetched via evaluate → stale indicator appears

**Plugin tools focus:** Test `cdp_network_log` for request/response correlation, `cdp_dev_settings` reload for state reset, and error recovery UI patterns.

**Plugin learnings (S8):**
- FlatList is hidden when `error` is truthy — pull-to-refresh cannot work if list isn't mounted. Fixed with `(!error || refreshing)` guard
- `isRefresh` parameter needed to prevent full-screen loading overlay during pull-to-refresh
- `formatRelativeTime` display goes stale without a re-render trigger (B68)

---

## S9: Nested Navigation with Deep Links `[DONE]`

**As a user**, I want to navigate to a task detail screen from the tasks list, with deep link support so I can share task URLs.

**Requirements:**
- Create `TaskDetailScreen` showing full task info (title, priority, done status, created date)
- Add to tasks stack: `TasksList → TaskDetail`
- Deep link config: `myapp://tasks/:id` opens task detail directly
- Edit priority and done status from detail screen (dispatches to store, reflects on list)
- Back navigation returns to list with updated state
- Handle invalid task ID gracefully (show "Task not found" screen)
- Expo Router linking config or React Navigation deep link setup
- testIDs: `task-detail-title`, `task-detail-priority`, `task-detail-done-toggle`, `task-not-found`

**CDP tools exercised:** `cdp_navigation_state` (nested stack depth, params), `cdp_evaluate` (trigger deep link navigation), `cdp_store_state` (verify edits reflect), `cdp_component_tree` (detail screen content)

**Acceptance criteria for verification:**
- Tap task → navigates to detail, navigation state shows nested route with params
- Edit priority on detail → back → list shows updated priority
- Deep link to valid task → detail screen opens directly
- Deep link to invalid ID → "Task not found" shown
- Navigation stack depth correct at each step

**Plugin tools focus:** First deep test of `cdp_navigation_state` with nested stacks and route params, deep link triggering via `cdp_evaluate`, and cross-screen state consistency.

**Plugin learnings (S9):**
- `PRIORITY_STYLES` needed extraction to shared `constants/taskStyles.ts` — 3 consumers justified the abstraction
- TaskDetail follows identical pattern to NotificationDetail — no new patterns needed
- Deep link `tasks/:id` registered in nested linking config, same structure as `notification/:id`

---

## S10: Real-time Badge Counts with Background Sync `[DONE]`

**As a user**, I want to see badge counts on tabs that update based on unread/pending items, with periodic background sync.

**Requirements:**
- Add badge count to Notifications tab (unread count)
- Add badge count to Tasks tab (high-priority undone count)
- Badges update in real-time as user interacts (mark read, complete task, change priority)
- Background sync: poll `/api/notifications` every 30s (configurable) for new items
- New items from sync increment badge with brief bounce animation
- Add `lastSyncedAt` to notificationsSlice, `syncInterval` to settingsSlice
- Ability to pause sync from Settings (toggle)
- testIDs: `tab-badge-notifications`, `tab-badge-tasks`, `settings-sync-toggle`, `settings-sync-interval`

**CDP tools exercised:** `cdp_store_state` (badge counts, sync state), `cdp_evaluate` (trigger sync, manipulate interval), `cdp_network_log` (periodic sync requests), `cdp_console_log` (sync lifecycle logs), `cdp_component_tree` (badge elements)

**Acceptance criteria for verification:**
- Mark notification read → badge count decrements
- Complete high-priority task → tasks badge decrements
- Wait for sync interval → network log shows periodic GET
- Toggle sync off → no more periodic requests
- Evaluate to trigger sync → new items appear, badge increments

**Plugin tools focus:** Comprehensive multi-tool verification — all CDP tools used in a single story. Tests periodic behavior, cross-tab state, and real-time UI updates.

**Plugin learnings (S10):**
- `tabBarBadge` only accepts `number | string` — `Animated.Value` scale animations cannot be attached to it. Removed dead code after Codex+Gemini caught it
- `SyncContext` needed to share `syncNow()` from global hook to SettingsScreen — React Context is the right-sized abstraction
- `useBackgroundSync` must guard `setIsSyncing` with a `mountedRef` to prevent updates after unmount
