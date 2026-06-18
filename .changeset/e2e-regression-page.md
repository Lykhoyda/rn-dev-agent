---
"rn-dev-agent-cdp": minor
---

feat(e2e): observe Regression page + CSRF-guarded control endpoint — a top-level Live|Regression toggle with a Run button, live progress, verdict badge, per-test table, and run history, backed by `POST /api/e2e/run` + `GET /api/e2e/runs[/:id]` (host + Sec-Fetch + CSRF + method/content-type guarded; one flow lease).
