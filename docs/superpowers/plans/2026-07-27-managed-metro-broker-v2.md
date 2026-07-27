# Managed Metro Broker-v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make strict proof eligible only when the per-launch broker independently enforces and attests a closed-world managed-Metro runtime.

**Architecture:** On Darwin, the broker verifies the platform `sandbox-exec` binary, derives a deterministic Seatbelt profile from the exact runtime manifest, and proves the profile denies unmanifested file access, process creation, and unallocated network listeners before launching Metro. The broker signs the profile identity and enforcement result; strict source identity accepts only that broker-v2 attestation and continues to refuse unsupported or failed enforcement.

**Tech Stack:** TypeScript, Node.js 22+, macOS Seatbelt, Node test runner, Yarn 4, generated Claude/Codex host runtimes.

## Global Constraints

- Preserve every existing PR 621 review-fix commit and add changes only on top.
- Never weaken or bypass `STRICT_PROOF_UNVERIFIED_METRO_POLICY`.
- Keep non-Darwin and failed-enforcement runtimes ineligible for strict proof.
- Do not introduce an always-on broker daemon.
- Do not merge PR 621.

---

### Task 1: Host-enforcement plan and probe contract

**Files:**
- Create: `packages/rn-dev-agent-core/src/session/managed-metro-enforcement.ts`
- Test: `packages/rn-dev-agent-core/test/unit/session/managed-metro-enforcement.test.ts`

**Interfaces:**
- Produces: `prepareManagedMetroEnforcement(input, dependencies)` returning a signed-input-ready Darwin plan or an unsupported result.
- Produces: `verifyManagedMetroEnforcementReceipt(receipt, manifest)` for strict-proof verification.

- [x] Write failing tests for deterministic profile generation, unsupported-host refusal, invalid platform-binary refusal, and a successful Darwin deny/allow probe.
- [x] Run the focused test and confirm it fails because the enforcement module does not exist.
- [x] Implement the minimal planner, platform binary verification, profile generation, and probe contract.
- [x] Run the focused test and confirm it passes.

### Task 2: Broker launch and attestation

**Files:**
- Modify: `packages/rn-dev-agent-core/src/session/managed-metro.ts`
- Modify: `packages/rn-dev-agent-core/test/unit/session/managed-metro.test.ts`

**Interfaces:**
- Consumes: the enforcement plan from Task 1.
- Produces: a managed binding whose `runtimeEvidenceAuthority` is `broker-v2` only after the broker publishes a valid enforced policy.

- [x] Write failing tests that preserve `reported-v1` for unsupported enforcement and require broker-v2 for the successful attested launch.
- [x] Run the focused test and confirm the new expectations fail against the current unconditional broker-v2 label.
- [x] Launch Metro through the exact Seatbelt plan, broker-validate runtime inputs, and authenticate the enforcement receipt in the management proof.
- [x] Run the focused tests and confirm they pass.

### Task 3: Strict refusal and successful accepted path

**Files:**
- Modify: `packages/rn-dev-agent-core/src/session/source-identity.ts`
- Modify: `packages/rn-dev-agent-core/test/unit/session/source-identity.test.ts`

**Interfaces:**
- Consumes: the broker-v2 enforcement receipt and journal.
- Produces: strict source identity only for a matching enforced receipt.

- [x] Add a regression for the exact reproduced refusal when enforcement is unsupported.
- [x] Add a regression for a complete broker-attested enforced path.
- [x] Run both tests and confirm the attested path fails before implementation.
- [x] Validate the attestation fields and bind them into the strict digest.
- [x] Run both tests and confirm refusal remains red-safe while the attested path passes.

### Task 4: Workflow, documentation, and packaged runtimes

**Files:**
- Modify: `packages/shared-agent-knowledge/commands/proof-capture.md`
- Modify: `packages/shared-agent-knowledge/skills/rn-feature-development/SKILL.md`
- Modify: `packages/codex-plugin/src/AGENTS-MD-TEMPLATE.md`
- Modify: `apps/docs-site/src/content/docs/session-authority.mdx`
- Modify: `apps/docs-site/src/content/docs/commands/proof-capture.mdx`
- Reuse: `.changeset/fenced-parallel-sessions.md`
- Regenerate: core `dist/` and both host runtimes.

**Interfaces:**
- Consumes: strict authority from Task 3.
- Produces: a strict workflow that attempts proof only through the authority gate and reports the same refusal when enforcement is absent.

- [x] Replace the unconditional command-level refusal with authority-gated proof startup.
- [x] Update docs to describe Darwin broker-v2 eligibility and fail-closed unsupported hosts.
- [x] Confirm the existing one-sentence issue changeset covers the shippable authority change.
- [x] Run host-runtime generation and package-sync checks.

### Task 5: Verification and guarded delivery

**Files:**
- Verify all task files and generated outputs.

- [x] Run focused broker, source-identity, proof, and package-integration tests.
- [ ] Run formatting, lint, package sync, dist freshness, TypeScript-only, full tests, and docs build.
- [ ] Commit the implementation on top of `04cd2d0981f699fb27218d11b8047f16aad0185f`.
- [ ] Run the complete no-mistakes workflow with the captain’s original intent and process every gate synchronously.
- [ ] Stop at `checks-passed`, report the new exact PR head, and leave PR 621 unmerged.
