---
command: proof-capture
description: Capture PR-ready proof artifacts for a feature, with an attested fail-closed controller in strict mode.
argument-hint: [--strict] <feature-slug> [description of flow to execute]
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, mcp__*cdp__*
---

Capture PR proof artifacts for: $ARGUMENTS

If `$ARGUMENTS` contains `--strict`, call `proof_capture(action="contract")`
and execute the returned controller protocol exactly. The controller accepts
only an independently attested `broker-v2` managed Metro runtime and remains
fail-closed with `STRICT_PROOF_UNVERIFIED_METRO_POLICY` when host enforcement,
the broker receipt, or runtime evidence is unavailable or invalid. Do not
record before the controller permits it, substitute interactive artifacts, or
report merge-ready evidence without its finalized accepted receipt.

Otherwise, load the **capturing-proof** skill and execute its Protocol (Steps
1–9) inline in this parent session. Use the first argument as
`<feature-slug>` (ask the user if missing) and the remaining arguments as the
flow description. The skill owns the interactive rehearsal gate, named
Maestro-inexpressibility carve-out, validation checklist, PROOF.md, and
PR-BODY.md generation; do not duplicate or improvise that protocol here.

## Interactive workflow

Interactive mode is delegated to the capturing-proof skill as described above.
