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

With `--strict`, execute the strict controller workflow below.

Otherwise, load the **capturing-proof** domain skill and execute its Protocol
(Steps 1–9) inline in this parent task. The skill owns the interactive rehearsal
gate, named Maestro-inexpressibility carve-out, validation checklist, PROOF.md,
and PR-BODY.md generation; do not duplicate or improvise that protocol here.

## Strict controller workflow

Call `proof_capture(action="contract")` first and retain the returned schema
and digest as the receipt contract. The transition protocol is:

```text
begin_rehearsal -> finish_rehearsal -> arm -> start_recording
  -> storyboard operations and proof_step assertions
  -> stop_recording -> validate -> finalize
```

Before `begin_rehearsal`, resolve and pass the complete immutable context:

- clean absolute Git project root and candidate root
- unique lowercase kebab-case run id
- fresh absolute receipt, video, contact-sheet, and screenshot paths beneath
  `docs/proof/<run-id>/`
- issue identity, exact pull-request head SHA, proof class, acceptance mappings,
  fixture identity, and writer provider
- one learned action with its id, runtime revision, and exact action-file SHA-256
- at least three ordered storyboard steps whose source SHA equals clean `HEAD`
- for every step, canonical operation arguments and hash, exact
  `proof_step` arguments and hash, `verifyTestID`, screenshot path, and a
  bounded `assertionWaitMs`

When the driven app is outside this plugin repository, `candidateRoot` is
mandatory and must identify the exact candidate checkout. Any candidate SHA,
packaged runtime, runner manifest, live MCP process, project root, Metro
session, port, device, or build-output mismatch is a hard stop.

Execute the transitions exactly:

1. Call `begin_rehearsal` with the immutable context.
2. Call only `cdp_run_action(autoRepair=false, forceReload=false,
   proofReplay=true)` during rehearsal, then call `finish_rehearsal`.
3. Restore the declared start state, run its exact `proof_step`, call `arm`,
   and repeat that assertion.
4. Call `start_recording`; never call `device_record` directly.
5. Execute each storyboard operation once in order and immediately follow it
   with its declared `proof_step`. Do not add undeclared tools.
6. Call `stop_recording`, then `validate`.
7. Give the mechanically accepted receipt and contact sheet to a
   vision-capable reviewer whose provider differs from the writer. The review
   must bind `writerProvider`, `evidenceSha256`, `resultHash`, and the exact
   boolean verdicts required by the receipt schema.
8. Call `finalize(evidenceReview=...)` and report only values from the accepted
   finalized receipt.

The controller accepts only an independently attested `broker-v2` managed
Metro runtime and fails with `STRICT_PROOF_UNVERIFIED_METRO_POLICY` when host
enforcement, the broker receipt, or runtime evidence is unavailable or invalid.
Do not record before the controller permits it, substitute screenshots for the
required video, repair or reload during rehearsal or recording, reuse rejected
artifacts, or report merge-ready evidence without a finalized accepted receipt.

When stage is uncertain, call `status`. On rejection, print the stable reason
code exactly, call `discard`, restore the clean start state, and begin a fresh
session with fresh destinations. Strict output contains only the accepted
receipt path, screenshot paths, local video path and SHA-256, contact-sheet
path, action and storyboard hashes, or the exact invalidation reason.

## Interactive workflow

Interactive mode is delegated to the capturing-proof skill as described above.
