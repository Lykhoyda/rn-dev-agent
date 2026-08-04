---
"rn-dev-agent-plugin": patch
"rn-dev-agent-core": patch
---

Classify maestro-runner 1.1.x ID-wait misses as SELECTOR_NOT_FOUND, surface bounded head+tail failure evidence with the exact selector on every terminal path, resume reactive CDP/JS replay at the failed selector instead of redispatching executed mutations, and refuse launchApp keys the CDP transport cannot honor.
