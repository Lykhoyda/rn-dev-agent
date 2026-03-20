import { runAgentDevice } from '../agent-device-wrapper.js';
import type { ToolResult } from '../utils.js';

export function createDeviceListHandler(): (args: Record<string, never>) => Promise<ToolResult> {
  return async () => runAgentDevice(['devices'], { skipSession: true });
}

export function createDeviceScreenshotHandler(): (args: { path?: string }) => Promise<ToolResult> {
  return async (args) => {
    const cliArgs = ['screenshot'];
    if (args.path) cliArgs.push(args.path);
    return runAgentDevice(cliArgs);
  };
}
