# S5: Task Priority and Sort — E2E Proof

**Date:** 2026-03-13
**Device:** iPhone 17 Pro (iOS 26.3, Simulator)
**Method:** CDP interactions + simctl screenshots

## Flow

| Step | Screenshot | Action | Verification |
|------|-----------|--------|--------------|
| 1 | 01-initial-priorities.jpg | Navigate to Tasks tab | 3 tasks with priority chips: High (red), Low (green), Med (amber). Sort: Default |
| 2 | 02-priority-cycled.jpg | Dispatch cyclePriority('1') | Task 1 priority changed from High → Low. Unsynced dot appeared |
| 3 | 03-sorted-by-priority.jpg | Dispatch toggleSort | Sort: Priority active (purple). Order: Med → Low → Low |
| 4 | 04-new-task-sorted.jpg | Add task + cycle to High | New High task sorted to top. Order: High → Med → Low → Low |
| 5 | 05-sort-default-restored.jpg | Dispatch toggleSort | Sort: Default restored. Tasks in insertion order |

## Key State Snapshots

- After step 1: `tasks.sort = "default"`, items: [{id:1, priority:"high"}, {id:2, priority:"low"}, {id:3, priority:"medium"}]
- After step 2: `tasks.items[0].priority = "low"`, `tasks.items[0].synced = false`
- After step 3: `tasks.sort = "priority"`, visual order: Med (id:3) → Low (id:1) → Low (id:2)
- After step 4: New task id:4 priority:"high" sorted to top. Order: High → Med → Low → Low
- After step 5: `tasks.sort = "default"`, insertion order restored

## Files

- `01-initial-priorities.jpg` — Tasks screen with priority chips in default sort order
- `02-priority-cycled.jpg` — After cycling task 1 from High to Low
- `03-sorted-by-priority.jpg` — Sort: Priority active, tasks reordered by weight
- `04-new-task-sorted.jpg` — New High-priority task added and sorted to top
- `05-sort-default-restored.jpg` — Sort toggled back to Default
