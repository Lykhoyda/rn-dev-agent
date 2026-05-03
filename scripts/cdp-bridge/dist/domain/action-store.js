// D1206 Tier 2 Sprint D / Phase 129 — ReusableAction load/save.
//
// Combines the YAML header + body (immutable contract) with the sidecar
// JSON (mutable runtime state) into a single ReusableAction in-memory
// composite. Underpins /run-action, self-repair, and auto-emission —
// they all read/write through this single chokepoint so schema
// invariants stay enforced.
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseM7Header, serializeM7Header, } from './reusable-action.js';
import { loadOrInitSidecar, saveSidecar, yamlEditedSinceLastSeen, } from './sidecar-io.js';
/**
 * Resolve the canonical YAML path for an action id under a project root.
 * Mirrors the .rn-agent/actions/ convention (D1207).
 */
export function actionPathFor(projectRoot, actionId) {
    return join(projectRoot, '.rn-agent', 'actions', `${actionId}.yaml`);
}
/**
 * Split a YAML file into (top-section before `---`, header comments
 * sitting above the first non-`#` content, body that follows). The body
 * is what self-repair patches; the header is what M7 metadata lives in.
 *
 * Format assumption (mirrors workspace test-app convention):
 *   appId: com.foo.app
 *   ---
 *   # id: ...
 *   # intent: ...
 *   # status: ...
 *   - launchApp
 *   - tapOn:
 *       id: "fab-create-task"
 *
 * The split returns `{ topSection, headerLines, bodyLines }` so callers
 * can reassemble the YAML preserving the structure.
 *
 * Pure function — exported for unit tests.
 */
export function splitYaml(text) {
    const allLines = text.split('\n');
    let separatorIdx = -1;
    for (let i = 0; i < allLines.length; i++) {
        if (allLines[i].trim() === '---') {
            separatorIdx = i;
            break;
        }
    }
    // No separator → treat the entire text as body, no top section, parse
    // header out of leading `#` lines if present.
    if (separatorIdx === -1) {
        const headerLines = [];
        const bodyLines = [];
        let inBody = false;
        for (const line of allLines) {
            if (!inBody && line.startsWith('#'))
                headerLines.push(line);
            else if (!inBody && line.trim() === '' && headerLines.length > 0) {
                inBody = true; // first blank after header — flip to body
                bodyLines.push(line);
            }
            else {
                inBody = true;
                bodyLines.push(line);
            }
        }
        return { topSection: '', headerLines, bodyLines };
    }
    const topSection = allLines.slice(0, separatorIdx).join('\n');
    const afterSep = allLines.slice(separatorIdx + 1);
    // Header = leading `#` comment block (allowing blank lines within); body
    // = everything from the first non-comment, non-blank line onward.
    const headerLines = [];
    const bodyLines = [];
    let stillHeader = true;
    for (const line of afterSep) {
        if (stillHeader && (line.startsWith('#') || line.trim() === '')) {
            headerLines.push(line);
        }
        else {
            stillHeader = false;
            bodyLines.push(line);
        }
    }
    return { topSection, headerLines, bodyLines };
}
/**
 * Reassemble a YAML file from its parts. Inverse of splitYaml.
 */
export function joinYaml(parts) {
    const out = [];
    if (parts.topSection) {
        out.push(parts.topSection);
        out.push('---');
    }
    for (const h of parts.headerLines)
        out.push(h);
    for (const b of parts.bodyLines)
        out.push(b);
    return out.join('\n');
}
/**
 * Load a ReusableAction from disk by id, under the given project root.
 * Returns null if the YAML doesn't exist OR if M7 metadata is missing
 * (no id/intent — required fields).
 */
export function loadAction(projectRoot, actionId) {
    const filePath = actionPathFor(projectRoot, actionId);
    if (!existsSync(filePath))
        return null;
    const text = readFileSync(filePath, 'utf8');
    const metadata = parseM7Header(text, actionId);
    if (!metadata)
        return null;
    const { bodyLines } = splitYaml(text);
    const state = loadOrInitSidecar(filePath);
    return {
        metadata,
        body: bodyLines.join('\n'),
        filePath,
        state,
    };
}
/**
 * Persist a ReusableAction back to disk. Updates the YAML file, the
 * sidecar JSON, and the lastSeenMtimeMs so subsequent
 * yamlEditedSinceLastSeen() checks don't false-alarm on the agent's own
 * write.
 *
 * Caller is responsible for having computed the new metadata/body —
 * this function does not validate transitions (use the lifecycle helpers
 * from reusable-action.ts).
 */
export function saveAction(action) {
    // Read existing top section so we don't lose the `appId:` line.
    let topSection = '';
    if (existsSync(action.filePath)) {
        const existing = readFileSync(action.filePath, 'utf8');
        topSection = splitYaml(existing).topSection;
    }
    // If the action specifies an appId in metadata but the topSection
    // doesn't have one, inject it. Otherwise preserve whatever the file
    // had.
    if (!topSection && action.metadata.appId) {
        topSection = `appId: ${action.metadata.appId}`;
    }
    const headerLines = serializeM7Header(action.metadata).split('\n');
    const bodyLines = action.body.split('\n');
    const yamlText = joinYaml({ topSection, headerLines, bodyLines });
    writeFileSync(action.filePath, yamlText, 'utf8');
    // After write, mtime changes — refresh state.lastSeenMtimeMs so the
    // next yamlEditedSinceLastSeen() call doesn't think a human edited it.
    const newMtimeMs = statSync(action.filePath).mtimeMs;
    const stateToWrite = { ...action.state, lastSeenMtimeMs: newMtimeMs };
    const { path: sidecarPath } = saveSidecar(action.filePath, stateToWrite);
    // Also reflect in-memory.
    action.state = stateToWrite;
    return { filePath: action.filePath, sidecarPath };
}
/**
 * Convenience: check whether a YAML on disk is newer than the in-memory
 * state's lastSeenMtimeMs. Wraps yamlEditedSinceLastSeen() — repair
 * flows abort early when a human has edited the file since the agent
 * last touched it.
 */
export function actionWasEditedExternally(action) {
    return yamlEditedSinceLastSeen(action.filePath, action.state);
}
/**
 * Update only the M7 metadata of an action without touching the body.
 * Used by lifecycle transitions (status: experimental → active).
 */
export function withMetadata(action, metadata) {
    return { ...action, metadata };
}
/**
 * Update only the body of an action (preserves metadata + filePath +
 * state). Used by self-repair to write a patched body.
 */
export function withBody(action, body) {
    return { ...action, body };
}
