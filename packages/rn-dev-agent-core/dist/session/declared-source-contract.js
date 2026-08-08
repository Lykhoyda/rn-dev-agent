export const DECLARED_ROOT_ENV = 'RN_DEV_AGENT_DECLARED_ROOT';
export const DECLARED_MANIFESTS_ENV = 'RN_DEV_AGENT_DECLARED_MANIFESTS';
export function parseDeclaredManifests(value) {
    if (value === undefined)
        return undefined;
    return value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
}
// Keep this public remedy path-free so diagnostic redaction preserves actionable guidance.
export const NON_GIT_DECLARATION_NEXT_ACTION = `Declare the non-Git source explicitly: set ${DECLARED_ROOT_ENV} to the exact existing application root, ` +
    `and set ${DECLARED_MANIFESTS_ENV} to a comma-separated list of required existing manifest files inside that root, ` +
    'then restart the supervisor. Neither value is inferred from the working directory or generated.';
export function missingDeclaredRootMessage() {
    return `NON_GIT_MANIFEST_REQUIRED: ${DECLARED_ROOT_ENV} is not set. ${NON_GIT_DECLARATION_NEXT_ACTION}`;
}
export function missingDeclaredManifestListMessage() {
    return `NON_GIT_MANIFEST_REQUIRED: ${DECLARED_MANIFESTS_ENV} is not set. ${NON_GIT_DECLARATION_NEXT_ACTION}`;
}
export function missingDeclaredManifestMessage(entry) {
    return `NON_GIT_MANIFEST_REQUIRED: declared manifest "${entry}" does not exist. ${NON_GIT_DECLARATION_NEXT_ACTION}`;
}
