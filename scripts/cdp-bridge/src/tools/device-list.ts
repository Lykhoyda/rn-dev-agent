import { runAgentDevice } from '../agent-device-wrapper.js';
import type { ToolResult } from '../utils.js';

export function createDeviceListHandler(): (args: Record<string, never>) => Promise<ToolResult> {
  return async () => runAgentDevice(['devices'], { skipSession: true });
}

export function createDeviceScreenshotHandler(): (args: { path?: string; format?: string }) => Promise<ToolResult> {
  return async (args) => {
    const cliArgs = ['screenshot'];

    // Resolve output path first — ensures all dispatch tiers (fast-runner,
    // daemon, CLI) receive a concrete path instead of --format flags that
    // the daemon would misinterpret as a positional file path (GH #26).
    let outputPath = args.path;
    if (!outputPath && args.format) {
      const ext = args.format === 'jpeg' ? 'jpg' : args.format;
      outputPath = `/tmp/rn-screenshot-${Date.now()}.${ext}`;
    }

    if (outputPath) {
      cliArgs.push(outputPath);
      if (args.format) {
        cliArgs.push('--format', args.format);
      } else if (outputPath.endsWith('.jpg') || outputPath.endsWith('.jpeg')) {
        cliArgs.push('--format', 'jpeg');
      } else if (outputPath.endsWith('.png')) {
        cliArgs.push('--format', 'png');
      }
    }

    return runAgentDevice(cliArgs);
  };
}
