---
'rn-dev-agent-core': patch
'rn-dev-agent-plugin': patch
---

fix(rn-fast-runner): honest `hittable` in iOS snapshots (#395). `hittable` now means "enabled and its center is on-screen" (plausibly tappable, half-open viewport bounds). The old occlusion heuristic counted trailing transparent full-screen containers (gesture-handler roots, portal hosts) as occluders and marked every node `hittable=false` on real RN screens — poisoning `device_find` candidate ranking, `device_batch`'s dead-control annotation, and starving the hittable-first screen-rect union (PR #517) into its all-nodes fallback. Real modal occlusion was never representable anyway: RN modals get their own UIWindow, so occluded content is absent from the XCUI tree entirely. Snapshot filtering (compact/interactiveOnly) is now explicitly hittable-independent, so snapshot sizes are unchanged. The refusal half of the original #395 report ("no longer hittable" errors on modal screens) was a stale-ref message fixed by #396. No wire-shape change; new plugin releases pick this up via their per-version runner artifact. Dev checkouts: delete `packages/rn-fast-runner/build/DerivedData` to rebuild.
