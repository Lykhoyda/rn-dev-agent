---
command: send-feedback
description: Send feedback or report a bug for the rn-dev-agent plugin. Collects sanitized environment context and creates a GitHub issue. No sensitive data (paths, secrets, PII) is transmitted.
argument-hint: [description or context from conversation]
allowed-tools: Bash, Read, Grep, mcp__*cdp__cdp_status, mcp__*cdp__cdp_error_log, AskUserQuestion
---

# Send Feedback — Sanitized Bug Report / Feature Request

Guide the user through submitting feedback for the rn-dev-agent plugin.
All data is sanitized before submission — no home paths, secrets, PII, or
IP addresses leave the local machine.

## Step 0: Check for pre-written context

If `$ARGUMENTS` is provided, use it as the starting description. Scan the
argument text for clues about type (bug/feature/question), steps to reproduce,
workarounds, related issues, and suggested fixes. Pre-fill as much as
possible so the user only confirms rather than re-typing.

## Step 1: Gather feedback details

Ask: "What would you like to report?"
- **Bug report** — something broken or unexpected
- **Feature request** — something missing or could be improved
- **Question** — need help understanding something

Then collect the following (skip what was already provided via $ARGUMENTS):

1. **Description** (1-3 sentences) — what happened or what's needed
2. **Steps to reproduce** (for bugs) — numbered list of steps. Ask: "How can I reproduce this?"
3. **Known workaround** (optional) — "Did you find a workaround or fix?"
4. **Related issues** (optional) — "Any related GitHub issues? (e.g., #22, #23)"
5. **Suggested fix** (optional, for bugs) — "Do you know what should change?"

## Step 2: Collect environment context (automated)

Run the collection script to gather sanitized environment data:

```bash
rn-collect-feedback
```

This collects (all redacted):
- Plugin version, cdp-bridge version, tool count
- OS, Node.js, npm versions
- Simulator/emulator status, Metro status
- agent-device and maestro-runner versions
- Last 20 telemetry events (tool name, result, latency — no params or paths)

Also call `cdp_status` to get current CDP connection state (if available).

Call `cdp_error_log` to check for recent JS errors (if connected).

## Step 3: Present sanitized data for review

**CRITICAL**: Before submitting, show the user EXACTLY what will be sent.

Present the data in a clear format:

```
## Data that will be included in the GitHub issue:

**Type:** Bug report
**Description:** <user's description>

**Environment:**
- Plugin: 0.11.0, CDP Bridge: 0.7.0
- OS: Darwin 25.3.0, Node: v22.x
- iOS Simulators: 1 booted
- Metro: running on 8081
- agent-device: 0.5.0
- maestro-runner: 1.2.0

**Recent tool activity (last 5):**
- cdp_status → PASS (120ms)
- cdp_component_tree → PASS (340ms)
- device_press → FAIL (timeout)

**Current CDP state:**
- Connected: yes
- Errors: 0
```

Ask: **"Does this look correct? Should I remove anything before submitting?"**

Wait for confirmation. If the user wants to remove something, remove it.

## Step 4: Create the GitHub issue

Use `gh` CLI to create the issue:

```bash
gh issue create \
  --repo Lykhoyda/rn-dev-agent \
  --title "<type>: <short description>" \
  --label "<bug|enhancement|question>" \
  --body "$(cat <<'BODY'
## Description

<user's description>

## Environment

| Field | Value |
|-------|-------|
| Plugin version | <version> |
| CDP Bridge | <version> |
| OS | <os> |
| Node.js | <node> |
| Metro | <status> |
| iOS Simulators | <count> |
| Android Emulators | <count> |
| agent-device | <version> |
| maestro-runner | <version> |

## Recent Tool Activity

<table of last 5 tool calls with result and latency>

## CDP State at Time of Report

<status summary or "not connected">

## CDP Bridge Log (last 30 lines)

<if cdp_bridge_log_tail present in collected data, format as code block. Omit section if no log file exists.>

## Steps to Reproduce

<numbered steps from user, or "Not provided">

## Workaround

<workaround from user, or omit section if not provided>

## Suggested Fix

<user's suggested fix, or omit section if not provided>

## Related Issues

<#N, #M links, or omit section if not provided>

---
*Submitted via `/rn-dev-agent:send-feedback` — data sanitized automatically*
BODY
)"
```

## Step 5: Confirm submission

Report the issue URL to the user.

If `gh` is not installed or not authenticated:
1. Tell the user to install: `brew install gh && gh auth login`
2. As fallback, write the issue body to `/tmp/rn-dev-agent-feedback.md` so
   the user can paste it manually into GitHub.

## Privacy Guarantees

The following data is NEVER included:
- Absolute file paths (replaced with `~` or relative)
- API keys, tokens, secrets (pattern-matched and redacted)
- Email addresses, phone numbers, SSNs (PII patterns redacted)
- IP addresses (except localhost)
- Company names and bundle IDs (com.company.app → [BUNDLE_REDACTED])
- App name and slug from app.json ([APP_NAME_REDACTED])
- Tool call parameters (only tool name + result + latency)
- Store state values
- Component tree contents
- Network request/response bodies
- Console log contents
- Error stack traces (error field excluded from telemetry)

The following IS included (safe):
- Plugin and tool versions
- OS type and version (not hostname)
- Node.js version
- Simulator/emulator count (not names or UDIDs)
- Metro running status
- Tool call names, pass/fail results, and latency
- CDP connection status (connected/disconnected)
- Error count (not error contents)
