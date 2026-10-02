---
'rn-dev-agent-plugin': patch
'rn-dev-agent-core': patch
---

React-tree walk-up presses now treat nested components that forward one testID and one press handler as a single control even when React threads their ancestry through fiber alternates, instead of refusing them as ambiguous.
