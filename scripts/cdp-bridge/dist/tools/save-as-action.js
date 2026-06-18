// D1206 Tier 2 Sprint D-2 / Phase 130 — L2→L3 auto-emission.
//
// After a successful interactive walk (cdp_record_test_start →
// interactions → cdp_record_test_stop), this tool turns the in-memory
// event buffer into a first-class L3 reusable action: emits Maestro YAML
// with full M7 metadata header at <project>/.rn-agent/actions/<id>.yaml
// AND initialises the sidecar runtime state. Closes the L2 → L3 loop
// from D1206 (interactive walk produces the durable artifact).
//
// Why a dedicated tool vs. a side-effect of cdp_record_test_stop: stop
// doesn't know the agent's intent / tags / mutates classification.
// Those come from the agent's understanding of the user's goal, not the
// recorder. Keeping emission explicit means the agent has to make the
// classification decision (which is the right place for it).
import { existsSync } from 'node:fs';
import { okResult, failResult } from '../utils.js';
import { getStoredEvents, getRecordingStartRoute } from './test-recorder.js';
import { generateMaestro } from './test-recorder-generators.js';
import { freshRuntimeState } from '../domain/reusable-action.js';
import { actionPathFor } from '../domain/action-store.js';
import { sidecarPathFor } from '../domain/sidecar-io.js';
import { atomicWriter } from '../domain/atomic-writer.js';
export function createSaveAsActionHandler() {
    return async (args) => {
        if (!args.id || typeof args.id !== 'string') {
            return failResult('cdp_record_test_save_as_action requires id (lower-case kebab-case slug)', 'BAD_FILENAME');
        }
        if (!args.intent || typeof args.intent !== 'string') {
            return failResult('cdp_record_test_save_as_action requires intent (one-line goal)', 'BAD_FILENAME');
        }
        // Light validation on id shape — refuse path traversal and
        // weird shells in the filename. Lower-case kebab-case + digits.
        if (!/^[a-z0-9][a-z0-9-]*$/.test(args.id)) {
            return failResult(`cdp_record_test_save_as_action: id "${args.id}" must be lower-case kebab-case (a-z, 0-9, hyphen). Slashes, dots, uppercase, and underscores are rejected to prevent path traversal and to keep filenames stable across OSes.`, 'BAD_FILENAME');
        }
        const events = getStoredEvents();
        if (!events || events.length === 0) {
            return failResult('No recorded events to save — call cdp_record_test_start, interact, then cdp_record_test_stop before save_as_action', 'NO_EVENTS');
        }
        const projectRoot = args.projectRoot ?? process.cwd();
        const filePath = actionPathFor(projectRoot, args.id);
        // Phase 130 (post-review): capture pre-existence ONCE before any
        // write — `existsSync(filePath)` after `writeFileSync` is always
        // true and inverted the `created`/`overwritten` flags in the
        // success payload (multi-LLM review caught this).
        const preexisted = existsSync(filePath);
        if (preexisted && !args.overwrite) {
            return failResult(`cdp_record_test_save_as_action: action "${args.id}" already exists at ${filePath}. Pass overwrite=true to replace, or pick a different id.`, 'BAD_FILENAME', {
                actionId: args.id,
                filePath,
                hint: 'Existing actions should be repaired (cdp_repair_action) or extended in place, not silently overwritten.',
            });
        }
        const status = args.status ?? 'experimental';
        const startRoute = getRecordingStartRoute() ?? undefined;
        // generateMaestro emits the appId top section + M7 header + body
        // when bundleId + M7 fields are supplied. Mirrors what hand-authored
        // .rn-agent/actions/*.yaml files look like.
        const yamlText = generateMaestro(events, {
            testName: args.testName ?? args.intent,
            bundleId: args.bundleId,
            startRoute,
            id: args.id,
            intent: args.intent,
            tags: args.tags,
            mutates: args.mutates,
            status,
            produces: args.produces,
        });
        // Issue #101: sidecar-first atomic pair-write. The atomicWriter
        // owns `lastSeenMtimeMs` correctness (overrides whatever we seed in
        // `freshRuntimeState`) so even partial-write failures can't leave
        // the next yamlEditedSinceLastSeen() check returning a false-
        // positive "human edited" alarm.
        const sidecarPath = sidecarPathFor(filePath);
        const initialState = freshRuntimeState(() => new Date(), 0);
        atomicWriter.pairWrite(filePath, yamlText, sidecarPath, initialState);
        return okResult({
            // Phase 130 (post-review): use captured pre-existence, not the
            // post-write existsSync (always true) and not args.overwrite
            // (an authorization, not a state).
            created: !preexisted,
            overwritten: preexisted,
            actionId: args.id,
            filePath,
            sidecarPath,
            eventCount: events.length,
            metadata: {
                id: args.id,
                intent: args.intent,
                tags: args.tags,
                mutates: args.mutates,
                status,
                appId: args.bundleId,
                produces: args.produces,
            },
            hint: `Action emitted as experimental. Run /run-action ${args.id} to validate; on first clean replay it auto-promotes to active.`,
        });
    };
}
