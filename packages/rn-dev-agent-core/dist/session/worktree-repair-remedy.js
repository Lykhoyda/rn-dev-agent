const WORKTREE_REPAIR_ENTRY = '"${CLAUDE_PLUGIN_ROOT:-${RN_DEV_AGENT_CODEX_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:?set it to the installed rn-dev-agent plugin root, then re-run}}}/rn-dev-agent-core/dist/worktree-inheritance.js"';
export const HEADLESS_WORKTREE_REPAIR_COMMAND = `node ${WORKTREE_REPAIR_ENTRY} repair --app-root "$PWD"`;
export const LEGACY_ROOT_REPAIR_REQUIRED = 'RN_AGENT_LEGACY_ROOT_REPAIR_REQUIRED';
export function legacyRootRepairRemedy(lead) {
    return `${LEGACY_ROOT_REPAIR_REQUIRED}: ${lead} Run ${HEADLESS_WORKTREE_REPAIR_COMMAND}.`;
}
