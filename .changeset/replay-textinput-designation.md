---
'rn-dev-agent-core': patch
'rn-dev-agent-plugin': patch
---

Allow React-tree replay taps to designate an exact editable TextInput for only the adjacent inputText step without dispatching press or focus callbacks, and resolve a stock TextInput whose composite and host fibers share one onChangeText as a single typeText target instead of refusing it as ambiguous.
