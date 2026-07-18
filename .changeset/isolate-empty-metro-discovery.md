---
"rn-dev-agent-plugin": patch
"rn-dev-agent-core": patch
---

Isolate the empty-Metro lifecycle integration tests from live default-port Hermes targets (#577): CDP discovery's default port list (8081/8082/19000/19006 + `RN_METRO_PORT`) is now resolved lazily per call, and a new `RN_CDP_DISCOVERY_PORTS` override replaces it entirely — so the integration suite owns its whole discovery surface and stays deterministic while a real React Native app is running on the host. Production discovery is unchanged when the variable is unset.
