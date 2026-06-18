import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findProjectRoot } from "../nav-graph/storage.js";
// GH #91 acceptance criterion #3: per-project override for the mutation-absence
// detector. Reads `.rn-agent/config.json` once per project root and caches
// the result for the lifetime of the cdp-bridge process. Defaults are
// preserved (null fields) when:
//   - projectRoot is null (no rooted project found)
//   - the config file is missing
//   - JSON parsing fails
//   - the `verification` block is missing or not an object
//   - arrays are empty (see "empty-array semantics" below)
//   - every regex string is invalid
//
// Opting-in is the only way to change behavior — drop-in safe for apps that
// don't add the config file.
//
// **Empty-array semantics** (Codex review conf 92): an empty array
// (`successShapes: []` or `mutationMethods: []`) falls back to the built-in
// defaults rather than disabling the detector. Silent loss of a safety net
// (interpreting empty-array as "disable") is the worse failure mode — users
// who really want to disable detection should use a future explicit
// `verification.disable: true` flag.
//
// **ReDoS-via-typo guard** (Codex review conf 90): patterns longer than
// MAX_PATTERN_LENGTH are dropped before compilation. Combined with the
// matched-input cap in `isSuccessShape` (256 chars), this bounds regex
// evaluation cost on the cdp_navigate / cdp_navigation_state / proof_step
// hot path. We assume project-owned config (developer commits it to the
// repo) — the threat model is dev typo, not adversarial input — so heavier
// machinery (re2, worker thread, timeouts) is over-engineered for this dev
// tool.
//
// **No hot reload**: changes to `.rn-agent/config.json` require restarting
// the cdp-bridge process. A stderr log line on first load per project root
// lets users self-verify that their config was picked up; without it,
// silent staleness would be a debugging dead-end.
const MAX_PATTERN_LENGTH = 200;
// Multi-review (Gemini + Codex, both ≥85 conf, verified): `findProjectRoot`
// in nav-graph/storage.ts has no internal cache and does up to 20 sync
// `isRnProject` walk-up checks (each a readFileSync + JSON.parse of
// package.json) plus an optional sibling scan. Calling it on every
// cdp_navigate / cdp_navigation_state / proof_step invocation would stall
// the MCP event loop and undo the per-root config cache below. Memoize
// here so the lifetime of the bridge process pays for one lookup.
let _cachedProjectRoot;
export function getCachedProjectRoot() {
    if (_cachedProjectRoot === undefined) {
        _cachedProjectRoot = findProjectRoot();
    }
    return _cachedProjectRoot;
}
const DEFAULTS = { successShapes: null, mutationMethods: null };
const cache = new Map();
function compileShapes(raw) {
    if (!Array.isArray(raw) || raw.length === 0)
        return null;
    const valid = [];
    for (const entry of raw) {
        if (typeof entry !== "string" || entry.length === 0)
            continue;
        if (entry.length > MAX_PATTERN_LENGTH)
            continue;
        try {
            // eslint-disable-next-line no-new
            new RegExp(entry);
            valid.push(entry);
        }
        catch {
            continue;
        }
    }
    if (valid.length === 0)
        return null;
    try {
        return new RegExp(valid.map((s) => `(?:${s})`).join("|"), "i");
    }
    catch (e) {
        // Gemini multi-review conf 88: a single pattern with named groups or
        // backrefs can validate standalone but break the OR-combined compile
        // (duplicate group names, shifted backref numbering). Without this
        // log, the user's config would silently fall back to defaults with no
        // signal — a debugging dead-end. One line of stderr fixes that.
        process.stderr.write(`[verification] combined successShapes regex compile failed (${e.message}); ` +
            `using built-in default. Check for named groups or backrefs in your patterns.\n`);
        return null;
    }
}
function parseMethods(raw) {
    if (!Array.isArray(raw) || raw.length === 0)
        return null;
    const out = new Set();
    for (const entry of raw) {
        if (typeof entry !== "string")
            continue;
        const trimmed = entry.trim().toUpperCase();
        if (trimmed.length > 0)
            out.add(trimmed);
    }
    return out.size > 0 ? out : null;
}
export function loadVerificationConfig(projectRoot) {
    if (!projectRoot)
        return DEFAULTS;
    const cached = cache.get(projectRoot);
    if (cached)
        return cached;
    const path = join(projectRoot, ".rn-agent", "config.json");
    if (!existsSync(path)) {
        cache.set(projectRoot, DEFAULTS);
        return DEFAULTS;
    }
    let raw;
    try {
        raw = JSON.parse(readFileSync(path, "utf-8"));
    }
    catch {
        cache.set(projectRoot, DEFAULTS);
        return DEFAULTS;
    }
    const verification = raw?.verification;
    if (!verification || typeof verification !== "object") {
        cache.set(projectRoot, DEFAULTS);
        return DEFAULTS;
    }
    const v = verification;
    const cfg = {
        successShapes: compileShapes(v.successShapes),
        mutationMethods: parseMethods(v.mutationMethods),
    };
    cache.set(projectRoot, cfg);
    const patternsCount = cfg.successShapes ? 1 : 0;
    const methodsCount = cfg.mutationMethods?.size ?? 0;
    process.stderr.write(`[verification] loaded config from ${path} (patterns: ${patternsCount}, methods: ${methodsCount})\n`);
    return cfg;
}
/** Test seam: clear the per-root cache so tests can re-read fixtures. Not exported via index.ts. */
export function _resetCacheForTests() {
    cache.clear();
    _cachedProjectRoot = undefined;
}
