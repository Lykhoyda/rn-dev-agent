---
'rn-dev-agent-core': patch
---

Story 06 Phase C.2 (#387): the LLM-behavior evals now run on headless Claude Code (`claude -p`) funded by a Claude subscription — locally via the logged-in CLI, in CI via a `CLAUDE_CODE_OAUTH_TOKEN` secret. The `mcp-server-tester` dependency (and its judge-model patch) is retired; fixtures, baseline semantics, and the compare-baseline gate are unchanged.
