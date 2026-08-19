---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

A recorded owner pid that the OS has recycled into a process this user cannot inspect now counts as proven dead instead of unprovable, so startup cleanup releases the stale ownership rather than wedging the source root forever; a proven-live owner and a genuinely unreadable identity still refuse with no force-steal, abandoned blocked contenders that never held a claim are discarded at startup, every affected refusal names a concrete remedy for interactive and headless clients, and the packaged `session-doctor` command reports and repairs a wedged root from a `claude -p` session that cannot run `/mcp`.
