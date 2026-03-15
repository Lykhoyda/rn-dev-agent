import { runAgentDevice } from '../agent-device-wrapper.js';
import { withSession } from '../utils.js';
import type { ToolResult } from '../utils.js';

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

interface PressArgs {
  ref: string;
}

export function createDevicePressHandler(): (args: PressArgs) => Promise<ToolResult> {
  return withSession((args) => {
    const ref = args.ref.startsWith('@') ? args.ref : `@${args.ref}`;
    return runAgentDevice(['press', ref]);
  });
}

interface FillArgs {
  ref: string;
  text: string;
}

export function createDeviceFillHandler(): (args: FillArgs) => Promise<ToolResult> {
  return withSession((args) => {
    const ref = args.ref.startsWith('@') ? args.ref : `@${args.ref}`;
    return runAgentDevice(['fill', ref, args.text]);
  });
}

interface SwipeArgs {
  direction: 'up' | 'down' | 'left' | 'right';
}

export function createDeviceSwipeHandler(): (args: SwipeArgs) => Promise<ToolResult> {
  return withSession((args) => runAgentDevice(['swipe', args.direction]));
}

export function createDeviceBackHandler(): (args: Record<string, never>) => Promise<ToolResult> {
  return withSession(() => runAgentDevice(['back']));
}
