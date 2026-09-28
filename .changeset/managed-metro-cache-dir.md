---
'rn-dev-agent-plugin': patch
'rn-dev-agent-core': patch
---

Managed Metro now points `CACHE_DIR` at its private cache root, so apps whose Metro config loads Storybook (which creates `node_modules/.cache/storybook` on require) reach `managed-sandbox-v1` instead of failing config load with EPERM and falling back to `reported-v1`.
