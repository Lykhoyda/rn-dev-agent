---
command: proof-capture
description: Capture PR-ready proof artifacts for a feature, with an attested fail-closed controller in strict mode.
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

With `--strict`, call `proof_capture` with `action: "contract"` and execute the
returned controller protocol exactly. The controller accepts only an
independently attested `broker-v2` managed Metro runtime and remains fail-closed
with `STRICT_PROOF_UNVERIFIED_METRO_POLICY` when host enforcement, the broker
receipt, or runtime evidence is unavailable or invalid. Do not record before
the controller permits it, substitute interactive artifacts, or report
merge-ready evidence without its finalized accepted receipt.

Otherwise, load the **capturing-proof** domain skill and execute its Protocol
(Steps 1–9) inline in this parent task. The skill owns the interactive rehearsal
gate, named Maestro-inexpressibility carve-out, validation checklist, PROOF.md,
and PR-BODY.md generation; do not duplicate or improvise that protocol here.

## Interactive workflow

Interactive mode is delegated to the capturing-proof skill as described above.
