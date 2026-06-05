---
"rn-dev-agent-plugin": patch
---

#202 Phase 3: formalize the three-layer device-control contract (L1 introspection / L2 interaction / L3 flow) in the docs, and add a proactive, informational `FOREIGN_RUNNER_ACTIVE` warning. When `device_snapshot action=open` finds a foreign maestro automation session driving the simulator (UDID-scoped) and rn-dev-agent is not itself running a flow, the open result now carries `meta.foreignRunner` + a heads-up that interleaving `device_*` may trigger a re-foreground (CDP reads are unaffected). Opt out with `RN_IOS_FOREIGN_WARN=0`. The reactive recovery for an actual leak shipped earlier in #188; this is the complementary proactive signal.
