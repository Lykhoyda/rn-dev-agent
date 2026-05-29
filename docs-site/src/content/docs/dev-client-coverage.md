---
title: Dev Client picker + tutorial modal — Coverage Status
description: What dev-client-picker.ts currently handles, what it doesn't, and which gaps are tracked for future work.
---

# Dev Client picker + tutorial modal — Coverage Status

> **Last updated:** 2026-05-28 by PR #<PR_NUM> (filled in at PR-open time)

The standalone harness suites at `test-app/harness/suites/dev-client-picker.mjs` and `test-app/harness/suites/expo-tutorial-modal.mjs` (workspace repo) reproduce the Expo Dev Client server-picker and first-launch-tutorial states and exercise the handling code paths in `scripts/cdp-bridge/src/tools/dev-client-picker.ts`. This page enumerates what currently works, what's known-broken, what got fixed in this PR, and what's deferred to future PRs.

## What works (verified by harness)

_Populated as the verify pass runs (DC-Task 8)._

## What's broken (verified by harness)

_Populated as the verify pass runs (DC-Task 8). Each entry: brief description + the suite that exposed it + file:line reference in `dev-client-picker.ts`._

## Fixed in this PR

_Bugs from "broken" addressed inline. Each: brief description + commit SHA + LOC delta._

## Deferred (>50 LOC or new code path)

_Bugs that exceed the in-scope budget. Each: brief description + follow-up issue link._
