import { boundConnectConflict } from './dev-client-authority.js';
import { failResult, type ToolResult } from '../utils.js';
import type { WorkerAuthorityStatus } from './runtime.js';

interface RegisteredConnectRuntime {
  status(): WorkerAuthorityStatus;
}

/**
 * Public cdp_connect contract. Keeping this factory separate lets contract
 * tests invoke the exact handler registered in index.ts rather than the dead
 * ambient-discovery compatibility connector.
 */
export function createRegisteredConnectHandler(
  runtime: RegisteredConnectRuntime,
  pinBoundSession: (input: { action: 'pin_dev_client'; force: boolean }) => Promise<ToolResult>,
): (args: Record<string, unknown>) => Promise<ToolResult> {
  return async (args) => {
    const status = runtime.status();
    if (!status.available) {
      return failResult(status.reason, status.code as import('../types.js').ToolErrorCode);
    }
    const conflict = boundConnectConflict(status, args);
    if (conflict) return failResult(conflict.message, conflict.code);
    return pinBoundSession({ action: 'pin_dev_client', force: args.force === true });
  };
}
