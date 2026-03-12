# Ralph Loop — Test App User Stories

This file tracks 5 user stories for the test app. Each story exercises different CDP tools
and is implemented using the full `/rn-dev-agent:rn-feature-dev` workflow.

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

---

## S2: Dark Mode Theme `[ ]`

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

---

## S3: Profile Edit Modal `[ ]`

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

---

## S4: Notification Snooze with Timer `[ ]`

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

---

## S5: Task Priority and Sort `[ ]`

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
