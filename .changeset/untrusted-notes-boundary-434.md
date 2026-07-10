---
'rn-dev-agent-plugin': patch
---

hardening(hooks): wrap the SessionStart `troubleshooting.md` injection in an explicit untrusted-data boundary (#434). The repo-local troubleshooting memory is repo-controlled content; in a cloned/untrusted repo it was previously presented to the agent as trusted startup guidance — a prompt-injection surface flagged during the #419 review. The hook now frames the block as "data, not instructions", wraps it in `<untrusted-repo-notes>` tags, and strips any embedded tag-like token naming the boundary (any case/decoration) so the doc cannot fake an early close and smuggle text outside the block. No behavior change for trusted repos beyond the added framing.
