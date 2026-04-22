// M6 / Phase 112 (D669): output generators for cdp_record_test_generate.
//
// Maestro YAML and Detox JS only — Appium intentionally deferred (rejected at
// the handler layer with NOT_IMPLEMENTED). Both generators consume the same
// RecordedEvent[] shape and emit replayable test code.
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
    if (tid)
        return `id: "${tid}"`;
    if (lbl)
        return `id: "${lbl}"`;
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
    lines.push('- launchApp');
    for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        switch (ev.type) {
            case 'tap': {
                const sel = maestroSelector(ev);
                if (sel)
                    lines.push(`- tapOn:\n    ${sel}`);
                else
                    lines.push('# tap: missing testID/label');
                break;
            }
            case 'long_press': {
                const sel = maestroSelector(ev);
                if (sel)
                    lines.push(`- longPressOn:\n    ${sel}`);
                else
                    lines.push('# long_press: missing testID/label');
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
                const dir = ev.direction.charAt(0).toUpperCase() + ev.direction.slice(1);
                lines.push(`- swipe${dir}`);
                break;
            }
            case 'navigate': {
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
    lines.push('  beforeAll(async () => { await device.launchApp(); });');
    lines.push("  it('replays recorded steps', async () => {");
    for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        switch (ev.type) {
            case 'tap': {
                const sel = detoxSelector(ev);
                if (sel)
                    lines.push(`    await ${sel}.tap();`);
                else
                    lines.push('    // tap: missing testID/label');
                break;
            }
            case 'long_press': {
                const sel = detoxSelector(ev);
                if (sel)
                    lines.push(`    await ${sel}.longPress();`);
                else
                    lines.push('    // long_press: missing testID/label');
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
