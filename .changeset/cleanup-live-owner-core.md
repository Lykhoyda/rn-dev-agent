---
"qaren": patch
---

`qaren cleanup` now refuses to stop a run's core unless that run's own qaren process is proven gone, so a second cleanup no longer ends a live run with CORE_RESULT_MISSING.
