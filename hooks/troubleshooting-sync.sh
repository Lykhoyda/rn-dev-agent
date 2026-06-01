#!/usr/bin/env bash
# troubleshooting-sync.sh — Stop hook (gated). When the session buffer has new
# failure records, instruct the agent (via decision:block) to merge them into
# .rn-agent/local/troubleshooting.md. Fires at most once per session. Fail-open.
set -uo pipefail

input="$(cat)"
repo="$(echo "$input" | jq -r '.cwd // empty' 2>/dev/null)"; [ -z "$repo" ] && repo="$PWD"
session="$(echo "$input" | jq -r '.session_id // "nosession"' 2>/dev/null)"
active="$(echo "$input" | jq -r '.stop_hook_active // false' 2>/dev/null)"

# Loop guard: never re-enter when we are already inside a stop-hook continuation.
[ "$active" = "true" ] && exit 0

local_dir="$repo/.rn-agent/local"
buf="$local_dir/session-buffer.jsonl"
cursor="$local_dir/.buffer-cursor"
sentinel="$local_dir/.synced-$session"

# Nothing to do without a buffer with content.
[ -s "$buf" ] || exit 0
# Already synthesized this session.
[ -f "$sentinel" ] && exit 0

total="$(wc -l < "$buf" 2>/dev/null | tr -d ' ')"
seen=0; [ -f "$cursor" ] && seen="$(cat "$cursor" 2>/dev/null | tr -d ' ')"
[ -z "$total" ] && total=0; [ -z "$seen" ] && seen=0
new=$(( total - seen ))
[ "$new" -le 0 ] && exit 0

# Mark this session as handled BEFORE emitting, so a flurry of stops doesn't double-fire.
: > "$sentinel" 2>/dev/null || true

reason="rn-dev-agent: ${new} new tool-failure record(s) were captured this session. Before finishing, update this repo's troubleshooting memory:
1. Read ${buf} (the new entries) and ${local_dir}/troubleshooting.md (create from the two-section template if missing).
2. Merge new failure→resolution gotchas into the '## Troubleshooting' section (newest first; dedup against existing). If you discovered repo config facts (Metro dir, store exposure, testID conventions, auth/deeplink, build quirks), update '## Configuration & How-To'.
3. Keep the whole doc under ~2000 tokens — prune stale/least-recently-seen entries.
4. Write ${cursor} containing the number ${total} (so these entries are not re-processed).
Then stop."

jq -nc --arg reason "$reason" '{decision:"block", reason:$reason}'
exit 0
