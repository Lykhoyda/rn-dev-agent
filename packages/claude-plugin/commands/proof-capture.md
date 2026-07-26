---
command: proof-capture
description: Capture interactive PR-ready proof artifacts for a feature. Strict machine proof is fail-closed until closed-world Metro runtime enforcement is available.
argument-hint: [--strict] <feature-slug> [description of flow to execute]
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, mcp__*cdp__*
---

Capture PR proof artifacts for: $ARGUMENTS

If `$ARGUMENTS` contains `--strict`, stop with
`STRICT_PROOF_UNVERIFIED_METRO_POLICY`: the shipped managed Metro launcher does
not yet provide the closed-world runtime enforcement required to issue an
accepted receipt. Do not start recording, substitute interactive artifacts, or
report merge-ready evidence.

Otherwise, load the **capturing-proof** skill and execute its Protocol (Steps
1–9) inline in this parent session. Use the first argument as
`<feature-slug>` (ask the user if missing) and the remaining arguments as the
flow description. The skill owns the interactive rehearsal gate, named
Maestro-inexpressibility carve-out, validation checklist, PROOF.md, and
PR-BODY.md generation; do not duplicate or improvise that protocol here.

## Interactive workflow

Interactive mode is delegated to the capturing-proof skill as described above.
