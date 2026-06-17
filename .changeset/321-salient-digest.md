---
"rn-dev-agent-plugin": patch
---

Live-sim speedup (GH #321, quick win #3): `cdp_component_tree(interactiveOnly: true)`
returns a compact **salient digest** of a screen — only actionable nodes
(Pressable/Button/TextInput/Switch/Link and `accessibilityRole` controls) with a
minimal `{ testID, role, text, label, placeholder, disabled }` shape, dropping
props, hook state, and nesting.

This is the perception *payload* (token) lever, complementary to the cached-find
*round-trip* lever: answering "what can I tap here?" on a novel screen now costs
hundreds of tokens instead of the full fiber tree's thousands. Implemented as an
`interactiveOnly` mode in the injected `__RN_AGENT.getTree()` (HELPERS_VERSION
26) — a bounded BFS over every renderer root that collects interactive fibers and
their text. `rn-tester` is updated to prefer it for perceiving novel screens.
