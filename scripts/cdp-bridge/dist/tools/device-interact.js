import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { runAgentDevice, getActiveSession } from '../agent-device-wrapper.js';
import { withSession } from '../utils.js';
import { okResult, failResult } from '../utils.js';
const execFile = promisify(execFileCb);
const ANDROID_UNSAFE_CHARS = /[+@#$%^&*(){}|\\<>~`[\]]/;
const ANDROID_FILL_MAX_SAFE_LEN = 30;
export function createDeviceFindHandler() {
    return withSession((args) => {
        const cliArgs = ['find', args.text];
        if (args.action)
            cliArgs.push(args.action);
        return runAgentDevice(cliArgs);
    });
}
export function createDevicePressHandler() {
    return withSession((args) => {
        const ref = args.ref.startsWith('@') ? args.ref : `@${args.ref}`;
        return runAgentDevice(['press', ref]);
    });
}
async function androidClipboardFill(text) {
    try {
        const escaped = text.replace(/'/g, "'\\''");
        await execFile('adb', ['shell', 'input', 'text', ''], { timeout: 5000 });
        await execFile('adb', ['shell', `am broadcast -a clipper.set -e text '${escaped}'`], { timeout: 5000 }).catch(() => {
            // clipper service not available — fall back to direct input
        });
        // Use ADB broadcast to set clipboard, then paste
        // If clipper isn't available, use base64-encoded input via settings
        const b64 = Buffer.from(text, 'utf8').toString('base64');
        await execFile('adb', [
            'shell', 'settings', 'put', 'system', 'rn_agent_input', b64,
        ], { timeout: 5000 }).catch(() => { });
        // Most reliable Android text input: use adb shell input with escaped text
        // Split into smaller chunks to avoid ANR
        const chunks = [];
        for (let i = 0; i < text.length; i += 10) {
            chunks.push(text.slice(i, i + 10));
        }
        for (const chunk of chunks) {
            const adbEscaped = chunk.replace(/ /g, '%s').replace(/[&|;<>()$`\\!"']/g, (c) => `\\${c}`);
            await execFile('adb', ['shell', 'input', 'text', adbEscaped], { timeout: 10000 });
        }
        return okResult({ filled: true, method: 'adb-chunked-input', length: text.length });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return failResult(`Android text input failed: ${msg}`);
    }
}
function isAndroidSession() {
    const session = getActiveSession();
    return session?.platform === 'android';
}
export function createDeviceFillHandler() {
    return withSession(async (args) => {
        const ref = args.ref.startsWith('@') ? args.ref : `@${args.ref}`;
        const needsWorkaround = isAndroidSession() && (args.text.length > ANDROID_FILL_MAX_SAFE_LEN ||
            ANDROID_UNSAFE_CHARS.test(args.text));
        if (needsWorkaround) {
            // First tap the element to focus it
            const pressResult = await runAgentDevice(['press', ref]);
            if (pressResult.isError)
                return pressResult;
            // Small delay for focus
            await new Promise((r) => setTimeout(r, 300));
            return androidClipboardFill(args.text);
        }
        return runAgentDevice(['fill', ref, args.text]);
    });
}
export function createDeviceSwipeHandler() {
    return withSession((args) => runAgentDevice(['swipe', args.direction]));
}
export function createDeviceBackHandler() {
    return withSession(() => runAgentDevice(['back']));
}
