---
"rn-dev-agent-plugin": patch
---

Make the iOS B155 snapshot regression test wait for the runner to actually reach the foreground before dispatching the snapshot, so a failed or delayed re-activation fails the test instead of letting it pass vacuously.
