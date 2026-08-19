/** GH #792: one remedy pair for every refusal that can leave a source root unusable. */
// The core ships into every host package, and refusal text carries no absolute paths.
const SESSION_DOCTOR = '"${CLAUDE_PLUGIN_ROOT:-$CODEX_PLUGIN_ROOT}/rn-dev-agent-core/dist/session-doctor.js"';
export const HEADLESS_SESSION_RECOVERY_COMMAND = `node ${SESSION_DOCTOR} repair`;
export const HEADLESS_SESSION_REPORT_COMMAND = `node ${SESSION_DOCTOR} report`;
export const SESSION_RECOVERY_DOCS = 'docs: session-authority "Recovering a wedged source root"';
export function sessionRecoveryRemedy(lead) {
    return (`${lead} Interactive: reconnect the transport with /mcp. Headless: run ` +
        `${HEADLESS_SESSION_RECOVERY_COMMAND} from the app root. Both run the same ` +
        `proven-dead startup cleanup and neither releases a live or unprovable owner. ` +
        `${SESSION_RECOVERY_DOCS}.`);
}
export function sessionOwnerInspectionRemedy(lead) {
    return (`${lead} Identify the recorded holder with ${HEADLESS_SESSION_REPORT_COMMAND} from the ` +
        `app root, close that process, then run ${HEADLESS_SESSION_RECOVERY_COMMAND}. ` +
        `A live or unprovable owner is never force-released. ${SESSION_RECOVERY_DOCS}.`);
}
