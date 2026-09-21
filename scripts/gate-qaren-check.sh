#!/usr/bin/env bash
# gate:qaren-check — device-bound, not run in hosted CI.
# Builds qaren-core and the qaren CLI, uninstalls the app from the booted
# simulator so the plan starts from a fresh install, runs `qaren check` against
# the app at QAREN_TEST_APP with the literal plan fixture, and asserts exit 0
# with a PASS ledger.
#
#   QAREN_TEST_APP   app root to check (required; the workspace test-app)
#   QAREN_PLAN_FILE  plan to walk (default: packages/qaren-core/test/fixtures/plans/literal.md)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${QAREN_TEST_APP:?set QAREN_TEST_APP to the app root to check (e.g. the workspace test-app)}"
PLAN="${QAREN_PLAN_FILE:-$ROOT/packages/qaren-core/test/fixtures/plans/literal.md}"
CONFIG="$APP/.qaren/config.yaml"

[ -f "$CONFIG" ] || { echo "gate:qaren-check: $CONFIG is missing (needs at least appId)"; exit 1; }
[ -f "$PLAN" ] || { echo "gate:qaren-check: plan $PLAN is missing"; exit 1; }

(cd "$ROOT" && corepack yarn build:core)
cargo build --manifest-path "$ROOT/packages/qaren-cli/Cargo.toml" --locked
QAREN="$ROOT/packages/qaren-cli/target/debug/qaren"
export QAREN_RUNTIME="$ROOT/packages/qaren-core/dist"

app_id="$(sed -nE "s/^[[:space:]]*appId:[[:space:]]*['\"]?([^'\"[:space:]#]+)['\"]?.*$/\1/p" "$CONFIG" | head -1)"
[ -n "$app_id" ] || { echo "gate:qaren-check: cannot read appId from $CONFIG"; exit 1; }
booted="$(xcrun simctl list devices booted -j | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s).devices;const u=Object.entries(d).filter(([r])=>r.includes("SimRuntime.iOS")).flatMap(([,l])=>l).filter(x=>x.state==="Booted").map(x=>x.udid);process.stdout.write(u.join("\n"))})')"
if [ "$(printf '%s\n' "$booted" | grep -c .)" != "1" ]; then
  echo "gate:qaren-check: exactly one booted iOS simulator is required; found: ${booted:-none}"
  exit 1
fi
# A fresh install is the plan's precondition: uninstall only when installed, and require it to succeed.
if xcrun simctl get_app_container "$booted" "$app_id" app >/dev/null 2>&1; then
  xcrun simctl uninstall "$booted" "$app_id" || { echo "gate:qaren-check: could not uninstall $app_id from $booted"; exit 1; }
fi

# `corepack yarn run` exports COREPACK_* to this script; a pnpm launched with them
# fails the app's packageManager check, so qaren gets the caller's plain environment.
set +e
receipt="$(cd "$APP" && env -u COREPACK_ROOT -u COREPACK_ENABLE_DOWNLOAD_PROMPT -u COREPACK_ENABLE_AUTO_PIN "$QAREN" check --plan-file "$PLAN" --json)"
status=$?
set -e
printf '%s\n' "$receipt"
if [ "$status" != "0" ]; then
  echo "gate:qaren-check: qaren check exited $status"
  exit 1
fi
printf '%s' "$receipt" | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const r = JSON.parse(s);
  const ok = r.result === "pass" && r.ledger && r.ledger.verdict === "PASS";
  console.log(`gate:qaren-check: result=${r.result} verdict=${r.ledger && r.ledger.verdict} steps=${r.ledger && r.ledger.steps} report=${r.artifacts && r.artifacts.report}`);
  process.exit(ok ? 0 : 1);
});'
