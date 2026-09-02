---
'rn-dev-agent-core': patch
'rn-dev-agent-plugin': patch
---

Walk up to the nearest pressable ancestor for React-tree replay taps whose exact target is not a designatable TextInput, keeping input designation first and reporting type-path eligibility refusals as `INTERACTION_NOT_ACTUATED` with the helper's reason, with pointer-event eligibility read on host views only and inherited root-to-leaf.
