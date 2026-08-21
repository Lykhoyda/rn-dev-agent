---
"rn-dev-agent-core": minor
"rn-dev-agent-plugin": minor
---

Pin session replay to maestro-runner 1.1.24 in the pin-cache only. Setup/doctor converge and verify that exact version; learned actions carry `enginePin: maestro-runner@1.1.24`; incompatible selectors and pin drift are terminal with no Maestro CLI fallback.
