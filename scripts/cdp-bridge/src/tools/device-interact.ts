import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { runAgentDevice, getActiveSession } from '../agent-device-wrapper.js';
import { withSession } from '../utils.js';
import type { ToolResult } from '../utils.js';
import { okResult, failResult } from '../utils.js';

const execFile = promisify(execFileCb);

const ANDROID_UNSAFE_CHARS = /[+@#$%^&*(){}|\\<>~`[\]]/;
const ANDROID_FILL_MAX_SAFE_LEN = 30;

// --- Find ---

interface FindArgs {
  text: string;
  action?: string;
}

export function createDeviceFindHandler(): (args: FindArgs) => Promise<ToolResult> {
  return withSession((args) => {
    const cliArgs = ['find', args.text];
    if (args.action) cliArgs.push(args.action);
    return runAgentDevice(cliArgs);
  });
}

// --- Press (enhanced with doubleTap, count, holdMs) ---

interface PressArgs {
  ref: string;
  doubleTap?: boolean;
  count?: number;
  holdMs?: number;
}

export function createDevicePressHandler(): (args: PressArgs) => Promise<ToolResult> {
  return withSession((args) => {
    const ref = args.ref.startsWith('@') ? args.ref : `@${args.ref}`;
    const cliArgs = ['press', ref];
    if (args.doubleTap) cliArgs.push('--double-tap');
    if (args.count && args.count > 1) cliArgs.push('--count', String(args.count));
    if (args.holdMs && args.holdMs > 0) cliArgs.push('--hold-ms', String(args.holdMs));
    return runAgentDevice(cliArgs);
  });
}

// --- Long Press ---

interface LongPressArgs {
  ref?: string;
  x?: number;
  y?: number;
  durationMs?: number;
}

export function createDeviceLongPressHandler(): (args: LongPressArgs) => Promise<ToolResult> {
  return withSession((args) => {
    if (args.ref) {
      const ref = args.ref.startsWith('@') ? args.ref : `@${args.ref}`;
      const cliArgs = ['press', ref, '--hold-ms', String(args.durationMs ?? 1000)];
      return runAgentDevice(cliArgs);
    }
    if (args.x != null && args.y != null) {
      const cliArgs = ['longpress', String(args.x), String(args.y)];
      if (args.durationMs) cliArgs.push(String(args.durationMs));
      return runAgentDevice(cliArgs);
    }
    return Promise.resolve(failResult('Provide either ref or x+y coordinates'));
  });
}

// --- Fill (with Android workaround) ---

interface FillArgs {
  ref: string;
  text: string;
}

async function androidClipboardFill(text: string): Promise<ToolResult> {
  try {
    const chunks = [];
    for (let i = 0; i < text.length; i += 10) {
      chunks.push(text.slice(i, i + 10));
    }
    for (const chunk of chunks) {
      const adbEscaped = chunk.replace(/ /g, '%s').replace(/[&|;<>()$`\\!"']/g, (c) => `\\${c}`);
      await execFile('adb', ['shell', 'input', 'text', adbEscaped], { timeout: 10000 });
    }
    return okResult({ filled: true, method: 'adb-chunked-input', length: text.length });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return failResult(`Android text input failed: ${msg}`);
  }
}

function isAndroidSession(): boolean {
  const session = getActiveSession();
  return session?.platform === 'android';
}

export function createDeviceFillHandler(): (args: FillArgs) => Promise<ToolResult> {
  return withSession(async (args) => {
    const ref = args.ref.startsWith('@') ? args.ref : `@${args.ref}`;
    const needsWorkaround = isAndroidSession() && (
      args.text.length > ANDROID_FILL_MAX_SAFE_LEN ||
      ANDROID_UNSAFE_CHARS.test(args.text)
    );

    if (needsWorkaround) {
      const pressResult = await runAgentDevice(['press', ref]);
      if (pressResult.isError) return pressResult;
      await new Promise((r) => setTimeout(r, 300));
      return androidClipboardFill(args.text);
    }

    return runAgentDevice(['fill', ref, args.text]);
  });
}

// --- Swipe (coordinate-based with direction shortcut) ---

interface SwipeArgs {
  direction?: 'up' | 'down' | 'left' | 'right';
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  durationMs?: number;
  count?: number;
  pattern?: 'one-way' | 'ping-pong';
}

export function createDeviceSwipeHandler(): (args: SwipeArgs) => Promise<ToolResult> {
  return withSession((args) => {
    if (args.x1 != null && args.y1 != null && args.x2 != null && args.y2 != null) {
      const cliArgs = ['swipe', String(args.x1), String(args.y1), String(args.x2), String(args.y2)];
      if (args.durationMs) cliArgs.push(String(args.durationMs));
      if (args.count && args.count > 1) cliArgs.push('--count', String(args.count));
      if (args.pattern) cliArgs.push('--pattern', args.pattern);
      return runAgentDevice(cliArgs);
    }
    if (args.direction) {
      return runAgentDevice(['scroll', args.direction]);
    }
    return Promise.resolve(failResult('Provide either direction or x1,y1,x2,y2 coordinates'));
  });
}

// --- Scroll ---

interface ScrollArgs {
  direction: 'up' | 'down' | 'left' | 'right';
  amount?: number;
}

export function createDeviceScrollHandler(): (args: ScrollArgs) => Promise<ToolResult> {
  return withSession((args) => {
    const cliArgs = ['scroll', args.direction];
    if (args.amount != null) cliArgs.push(String(args.amount));
    return runAgentDevice(cliArgs);
  });
}

// --- Scroll Into View ---

interface ScrollIntoViewArgs {
  text?: string;
  ref?: string;
}

export function createDeviceScrollIntoViewHandler(): (args: ScrollIntoViewArgs) => Promise<ToolResult> {
  return withSession((args) => {
    if (args.ref) {
      const ref = args.ref.startsWith('@') ? args.ref : `@${args.ref}`;
      return runAgentDevice(['scrollintoview', ref]);
    }
    if (args.text) {
      return runAgentDevice(['scrollintoview', args.text]);
    }
    return Promise.resolve(failResult('Provide either text or ref to scroll into view'));
  });
}

// --- Pinch ---

interface PinchArgs {
  scale: number;
  x?: number;
  y?: number;
}

export function createDevicePinchHandler(): (args: PinchArgs) => Promise<ToolResult> {
  return withSession((args) => {
    const cliArgs = ['pinch', String(args.scale)];
    if (args.x != null && args.y != null) {
      cliArgs.push(String(args.x), String(args.y));
    }
    return runAgentDevice(cliArgs);
  });
}

// --- Back ---

export function createDeviceBackHandler(): (args: Record<string, never>) => Promise<ToolResult> {
  return withSession(() => runAgentDevice(['back']));
}
