// M6 / Phase 112 (D669): output generators for cdp_record_test_generate.
//
// Maestro YAML and Detox JS only — Appium intentionally deferred (rejected at
// the handler layer with NOT_IMPLEMENTED). Both generators consume the same
// RecordedEvent[] shape and emit replayable test code.
import { stringify as yamlStringify } from 'yaml';
/**
 * CDP-013: serialise a user-controlled string as a single-line YAML scalar.
 * Quoting / escaping rules are delegated to the `yaml` package, which picks
 * the safest form (plain, single-quote, double-quote, block) automatically
 * and emits one line per scalar. Without this, recorded labels containing
 * `"`, `:`, `#`, `\n`, or leading `-` corrupted the generated flow file.
 */
function maestroScalar(value) {
    // yamlStringify always appends a trailing newline; strip it so we can
    // place the scalar inline after `id: ` / `text: `.
    const safe = stripNewlines(value);
    return yamlStringify(safe).replace(/\n+$/, '');
}
function metaPairs(opts) {
    const out = [];
    if (opts.id)
        out.push(['id', stripNewlines(opts.id)]);
    if (opts.intent)
        out.push(['intent', stripNewlines(opts.intent)]);
    if (opts.tags && opts.tags.length) {
        const cleaned = opts.tags.map((t) => stripNewlines(t)).filter(Boolean);
        if (cleaned.length)
            out.push(['tags', `[${cleaned.join(', ')}]`]);
    }
    if (typeof opts.mutates === 'boolean')
        out.push(['mutates', String(opts.mutates)]);
    if (opts.status)
        out.push(['status', stripNewlines(opts.status)]);
    if (opts.produces && Object.keys(opts.produces).length > 0) {
        // Phase 134.1 (deepsec CRITICAL #6): keys MUST also pass through
        // stripNewlines, or a crafted key like `user.id\n- runScript: ...`
        // escapes the `# produces:` comment and becomes an active Maestro
        // directive when the saved action is later replayed. The previous
        // version sanitized values but not keys.
        const pairs = Object.keys(opts.produces)
            .sort()
            .map((k) => {
            const v = opts.produces[k];
            const formatted = typeof v === 'string' ? stripNewlines(v) : String(v);
            return `${stripNewlines(k)}: ${formatted}`;
        });
        out.push(['produces', `{ ${pairs.join(', ')} }`]);
    }
    return out;
}
// B137: window (ms) after a tap in which a subsequent `navigate` event is
// considered to be caused by the tap. 1000ms handles human-pace UI transitions
// plus async navigator resolution without false-positives spanning unrelated
// user pauses.
const TAP_TO_NAV_WINDOW_MS = 1000;
// B137: look forward from a tap for the next navigate event. If it lies within
// the correlation window AND no other tap/swipe/submit event precedes it, the
// tap is treated as the navigation trigger. Returns the navigate event index
// so the caller can (a) emit a `# navigated:` comment and (b) mark the event
// as consumed so the navigate branch doesn't double-emit.
export function lookaheadNavigate(events, fromIndex, windowMs = TAP_TO_NAV_WINDOW_MS) {
    const source = events[fromIndex];
    if (!source || (source.type !== 'tap' && source.type !== 'long_press'))
        return null;
    for (let j = fromIndex + 1; j < events.length; j++) {
        const ev = events[j];
        if (ev.type === 'navigate') {
            if (ev.t - source.t <= windowMs)
                return { event: ev, index: j };
            return null;
        }
        if (ev.type === 'tap' || ev.type === 'long_press' || ev.type === 'swipe' || ev.type === 'submit') {
            return null;
        }
    }
    return null;
}
// Strip CR/LF from any user-controlled string before interpolating into a
// single-line comment or scalar position. Without this an annotation like
// `"reached checkout\nstep:bad"` escapes the comment in both Maestro YAML
// (`# NOTE: ...` then a stray top-level mapping) and Detox JS (`// NOTE: ...`
// then an uncommented identifier). Reported by Gemini + Codex review of M6.
function stripNewlines(s) {
    if (s == null)
        return '';
    return String(s).replace(/[\r\n]+/g, ' ');
}
// --- Selector helpers ---
export function maestroSelector(ev) {
    const tid = ev.testID;
    const lbl = ev.label;
    // CDP-013: route user-controlled values through maestroScalar() so
    // quotes / colons / newlines / leading hyphens cannot escape the YAML
    // scalar position. Label-only events emit `text:` (Maestro's correct
    // selector for visible-text matching) instead of the previously-misused
    // `id:` form, which would not match label-only Maestro selectors at all.
    if (tid)
        return `id: ${maestroScalar(tid)}`;
    if (lbl)
        return `text: ${maestroScalar(lbl)}`;
    return null;
}
export function detoxSelector(ev) {
    const tid = ev.testID;
    const lbl = ev.label;
    if (tid)
        return `element(by.id(${JSON.stringify(tid)}))`;
    if (lbl)
        return `element(by.label(${JSON.stringify(lbl)}))`;
    return null;
}
// Lookahead helper: after a navigate event we want to assert the new screen
// rendered. The first selectable event after the navigate (stopping at the
// next navigate boundary) is our best signal of "screen has loaded".
export function nextSelector(events, fromIndex, selectorFn) {
    for (let j = fromIndex + 1; j < events.length; j++) {
        const ev = events[j];
        if (ev.type === 'navigate')
            return null;
        const sel = selectorFn(ev);
        if (sel)
            return sel;
    }
    return null;
}
// --- Maestro YAML ---
export function generateMaestro(events, opts = {}) {
    const lines = [];
    if (opts.bundleId) {
        lines.push(`appId: ${stripNewlines(opts.bundleId)}`);
        lines.push('---');
    }
    lines.push(`# ${stripNewlines(opts.testName ?? 'Recorded flow')}`);
    for (const [k, v] of metaPairs(opts)) {
        lines.push(`# ${k}: ${v}`);
    }
    if (opts.startRoute) {
        lines.push(`# startRoute: ${stripNewlines(opts.startRoute)}`);
        lines.push('# NOTE: replay requires the app to be on this route before `- launchApp` finishes. If your app does not default to it, insert a navigation step here (e.g. deep link or tab tap).');
    }
    lines.push('- launchApp');
    // B137: navigate events reached via tap lookahead are emitted inline with the
    // tap; skip them here to avoid double-emission.
    const consumedNavIndices = new Set();
    for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        switch (ev.type) {
            case 'tap': {
                const sel = maestroSelector(ev);
                if (sel)
                    lines.push(`- tapOn:\n    ${sel}`);
                else
                    lines.push('# tap: missing testID/label');
                const hit = lookaheadNavigate(events, i);
                if (hit) {
                    lines.push(`# navigated: ${stripNewlines(hit.event.from ?? '?')} -> ${stripNewlines(hit.event.to)}`);
                    const next = nextSelector(events, hit.index, maestroSelector);
                    if (next)
                        lines.push(`- assertVisible:\n    ${next}`);
                    consumedNavIndices.add(hit.index);
                }
                break;
            }
            case 'long_press': {
                const sel = maestroSelector(ev);
                if (sel)
                    lines.push(`- longPressOn:\n    ${sel}`);
                else
                    lines.push('# long_press: missing testID/label');
                const hit = lookaheadNavigate(events, i);
                if (hit) {
                    lines.push(`# navigated: ${stripNewlines(hit.event.from ?? '?')} -> ${stripNewlines(hit.event.to)}`);
                    const next = nextSelector(events, hit.index, maestroSelector);
                    if (next)
                        lines.push(`- assertVisible:\n    ${next}`);
                    consumedNavIndices.add(hit.index);
                }
                break;
            }
            case 'type': {
                const sel = maestroSelector(ev);
                if (sel) {
                    lines.push(`- tapOn:\n    ${sel}`);
                    lines.push(`- inputText: ${JSON.stringify(ev.value)}`);
                }
                else {
                    lines.push(`# type: missing testID/label, value=${JSON.stringify(ev.value)}`);
                }
                break;
            }
            case 'submit':
                lines.push('- pressKey: Enter');
                break;
            case 'swipe': {
                // Phase 134.1 (deepsec CRITICAL #7): saved recordings are loaded
                // from JSON without runtime schema validation, so `ev.direction`
                // can be any string — including `Up\n- runScript: ...` which
                // would otherwise emit `- swipeUp\n- runScript: ...` into the
                // generated YAML. Constrain to the 4 enum values; anything else
                // falls back to 'Up'.
                const allowed = { up: 'Up', down: 'Down', left: 'Left', right: 'Right' };
                const raw = typeof ev.direction === 'string' ? ev.direction.toLowerCase() : '';
                const dir = allowed[raw] ?? 'Up';
                lines.push(`- swipe${dir}`);
                break;
            }
            case 'navigate': {
                if (consumedNavIndices.has(i))
                    break;
                const next = nextSelector(events, i, maestroSelector);
                lines.push(`# navigated: ${stripNewlines(ev.from ?? '?')} -> ${stripNewlines(ev.to)}`);
                if (next)
                    lines.push(`- assertVisible:\n    ${next}`);
                break;
            }
            case 'annotation':
                lines.push(`# NOTE: ${stripNewlines(ev.note)}`);
                break;
        }
    }
    return lines.join('\n') + '\n';
}
// --- Detox JS ---
export function generateDetox(events, opts = {}) {
    const lines = [];
    const name = stripNewlines(opts.testName ?? 'Recorded flow');
    lines.push(`describe(${JSON.stringify(name)}, () => {`);
    for (const [k, v] of metaPairs(opts)) {
        lines.push(`  // ${k}: ${v}`);
    }
    if (opts.startRoute) {
        lines.push(`  // startRoute: ${stripNewlines(opts.startRoute)} — ensure app is on this route before running`);
    }
    lines.push('  beforeAll(async () => { await device.launchApp(); });');
    lines.push("  it('replays recorded steps', async () => {");
    const consumedNavIndices = new Set();
    for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        switch (ev.type) {
            case 'tap': {
                const sel = detoxSelector(ev);
                if (sel)
                    lines.push(`    await ${sel}.tap();`);
                else
                    lines.push('    // tap: missing testID/label');
                const hit = lookaheadNavigate(events, i);
                if (hit) {
                    lines.push(`    // navigated: ${stripNewlines(hit.event.from ?? '?')} -> ${stripNewlines(hit.event.to)}`);
                    const next = nextSelector(events, hit.index, detoxSelector);
                    if (next)
                        lines.push(`    await expect(${next}).toBeVisible();`);
                    consumedNavIndices.add(hit.index);
                }
                break;
            }
            case 'long_press': {
                const sel = detoxSelector(ev);
                if (sel)
                    lines.push(`    await ${sel}.longPress();`);
                else
                    lines.push('    // long_press: missing testID/label');
                const hit = lookaheadNavigate(events, i);
                if (hit) {
                    lines.push(`    // navigated: ${stripNewlines(hit.event.from ?? '?')} -> ${stripNewlines(hit.event.to)}`);
                    const next = nextSelector(events, hit.index, detoxSelector);
                    if (next)
                        lines.push(`    await expect(${next}).toBeVisible();`);
                    consumedNavIndices.add(hit.index);
                }
                break;
            }
            case 'type': {
                const sel = detoxSelector(ev);
                if (sel)
                    lines.push(`    await ${sel}.typeText(${JSON.stringify(ev.value)});`);
                else
                    lines.push(`    // type: missing testID/label, value=${JSON.stringify(ev.value)}`);
                break;
            }
            case 'submit': {
                const sel = detoxSelector(ev);
                if (sel)
                    lines.push(`    await ${sel}.tapReturnKey();`);
                else
                    lines.push('    // submit: missing testID/label — replay manually');
                break;
            }
            case 'swipe': {
                const sel = detoxSelector(ev);
                // Detox's .swipe(direction) uses the same finger-direction semantic
                // as our recorder, so we pass the direction verbatim.
                if (sel)
                    lines.push(`    await ${sel}.swipe(${JSON.stringify(ev.direction)});`);
                else
                    lines.push(`    await element(by.type('RCTScrollView')).swipe(${JSON.stringify(ev.direction)});`);
                break;
            }
            case 'navigate': {
                if (consumedNavIndices.has(i))
                    break;
                const next = nextSelector(events, i, detoxSelector);
                lines.push(`    // navigated: ${stripNewlines(ev.from ?? '?')} -> ${stripNewlines(ev.to)}`);
                if (next)
                    lines.push(`    await expect(${next}).toBeVisible();`);
                break;
            }
            case 'annotation':
                lines.push(`    // NOTE: ${stripNewlines(ev.note)}`);
                break;
        }
    }
    lines.push('  });');
    lines.push('});');
    return lines.join('\n') + '\n';
}
