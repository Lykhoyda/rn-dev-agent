---
command: proof-capture
description: Capture interactive PR-ready proof artifacts for a feature. Strict machine proof is fail-closed until closed-world Metro runtime enforcement is available.
argument-hint: [--strict] <feature-slug> [description of flow to execute]
---

Treat the text after `$rn-dev-agent:proof-capture` as a conceptual request.
Parse an optional leading `--strict`, one required lowercase kebab-case feature
slug, and the remaining text as one free-form flow description. Reject unknown
flags; ask for a missing slug. Preserve the description as data and pass only
typed fields to MCP tools—never construct proof arguments through a shell.

Require `proof_capture` and all declared storyboard tools in the active task. If
they are absent or their advertised schema has no required `action`, stop and
use read-only discovery/schema diagnosis. Raw Maestro is not equivalent proof.

With `--strict`, stop with `STRICT_PROOF_UNVERIFIED_METRO_POLICY`: the shipped
managed Metro launcher does not yet provide the closed-world runtime enforcement
required to issue an accepted receipt. Do not start recording, substitute
interactive artifacts, or report merge-ready evidence.

Otherwise, load the **capturing-proof** domain skill and execute its Protocol
(Steps 1–9) inline in this parent task. The skill owns the interactive rehearsal
gate, named Maestro-inexpressibility carve-out, validation checklist, PROOF.md,
and PR-BODY.md generation; do not duplicate or improvise that protocol here.

## Interactive workflow

Interactive mode is delegated to the capturing-proof skill as described above.
