import { runAgentDevice } from '../agent-device-wrapper.js';
import type { ToolResult } from '../utils.js';

export function createDeviceListHandler(): (args: Record<string, never>) => Promise<ToolResult> {
  return async () => runAgentDevice(['devices'], { skipSession: true });
}

export function createDeviceScreenshotHandler(): (args: { path?: string; format?: string }) => Promise<ToolResult> {
  return async (args) => {
    const cliArgs = ['screenshot'];
    if (args.path) cliArgs.push(args.path);
    if (args.format) {
      cliArgs.push('--format', args.format);
    } else if (args.path) {
      if (args.path.endsWith('.jpg') || args.path.endsWith('.jpeg')) {
        cliArgs.push('--format', 'jpeg');
      } else if (args.path.endsWith('.png')) {
        cliArgs.push('--format', 'png');
      }
    }
    return runAgentDevice(cliArgs);
  };
}
