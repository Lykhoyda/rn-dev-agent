# Duplicate Save positional selection on the workspace test-app

Runs from a fresh install of the dedicated workspace test-app, starting at onboarding and entering through the normal Home QA acceptance control. No deep link, navigation dispatch, or state shortcut is part of this plan.

Frozen selection prompt: `Tap "Save" at the bottom`. Before any model call, the intended winner is the lower button, `qa-choice-b`, whose exclusive visible result is `Choice B saved`; the upper `qa-choice-a` instead displays `Choice A saved`. Both buttons must remain simultaneously visible, enabled, accessible native buttons with the exact label `Save`. Their neutral IDs do not describe position or declare a winner. The screen initially shows neither result.

Unit tests establish rendering and independent outcomes, not device geometry or Jev acceptance. Live acceptance remains unproven until same-screen pre-press evidence establishes both eligible Save candidates and their positions, the selection ledger records `resolvedBy: "jev"` for the frozen prompt and the lower target, and the following literal result assertion passes. A literal-only selection, one-candidate capture, wrong result, or missing simultaneous evidence is not acceptance.

## QA

### Choose the lower Save through the normal entry route

1. Tap "onboarding-skip"
2. Tap "onboarding-done"
3. Wait for "Welcome" to appear
4. Tap "home-qa-acceptance-btn"
5. Wait for "qa-acceptance-start-screen" to appear
6. Tap "qa-acceptance-duplicate-save"
7. Wait for "qa-duplicate-save-screen" to appear
✓ "No selection yet"
8. Tap "Save" at the bottom
✓ "Choice B saved"
