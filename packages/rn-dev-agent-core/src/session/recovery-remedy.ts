/** GH #792: one remedy pair for every refusal that can leave a source root unusable. */
// The core ships into every host package, and refusal text carries no absolute paths.
const SESSION_DOCTOR =
  '"${CLAUDE_PLUGIN_ROOT:-${RN_DEV_AGENT_CODEX_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:?set it to the installed rn-dev-agent plugin root, then re-run}}}/rn-dev-agent-core/dist/session-doctor.js"';

export const HEADLESS_SESSION_RECOVERY_COMMAND = `node ${SESSION_DOCTOR} repair`;

export const HEADLESS_SESSION_REPORT_COMMAND = `node ${SESSION_DOCTOR} report`;

export const SESSION_RECOVERY_DOCS = 'docs: session-authority "Recovering a wedged source root"';

export function sessionRecoveryRemedy(lead: string): string {
  return (
    `${lead} Interactive: reconnect the transport with /mcp. Headless: run ` +
    `${HEADLESS_SESSION_RECOVERY_COMMAND} from the app root. Both run the same ` +
    `proven-dead startup cleanup and neither releases a live or unprovable owner. ` +
    `${SESSION_RECOVERY_DOCS}.`
  );
}

export function sessionOwnerInspectionRemedy(lead: string): string {
  return (
    `${lead} ${HEADLESS_SESSION_REPORT_COMMAND} from the app root names the owning app root ` +
    `and session; close that session, then run ${HEADLESS_SESSION_RECOVERY_COMMAND}. ` +
    `A live or unprovable owner is never force-released. ${SESSION_RECOVERY_DOCS}.`
  );
}

export function sessionOtherRootRecoveryRemedy(lead: string): string {
  return (
    `${lead} ${HEADLESS_SESSION_REPORT_COMMAND} names the owning app root and session; run ` +
    `${HEADLESS_SESSION_RECOVERY_COMMAND} from that app root — this one can never release it — ` +
    `or work in a separate worktree. Nothing is force-released either way. ` +
    `${SESSION_RECOVERY_DOCS}.`
  );
}

export function sessionCleanupObligationRemedy(lead: string): string {
  return (
    `${lead} Read the outstanding obligation with ${HEADLESS_SESSION_REPORT_COMMAND} from the ` +
    `app root, clear what it names, then run ${HEADLESS_SESSION_RECOVERY_COMMAND}; interactive ` +
    `clients can reconnect with /mcp instead. Neither releases a live or unprovable owner. ` +
    `${SESSION_RECOVERY_DOCS}.`
  );
}
