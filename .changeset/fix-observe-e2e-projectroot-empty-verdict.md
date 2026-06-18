---
"rn-dev-agent-cdp": patch
---

Fix the observe Regression tab showing an empty actions list and "Run E2E Suite" always reporting PASS. The observe e2e surface now resolves the project root of the *connected* app by its bundleId (`findProjectRoot({ bundleId })`), so a stray sibling React Native repo can no longer hijack the heuristic filesystem scan and point the actions list / locked-test discovery at the wrong project. A suite that discovers zero locked tests now reports a distinct `empty` verdict ("NO TESTS") instead of a false-green pass.
